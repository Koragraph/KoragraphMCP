#!/usr/bin/env python3
"""Dump a CodeGraph (@colbymchenry/codegraph) index into the SAME node JSON shape
`ast-dump-gitnexus.py` emits for GitNexus, so `ast-layer-compare.py --kora <this>` scores
CodeGraph with the IDENTICAL matcher, plane definitions and truth file — zero edits to the
comparer, exactly the precedent `ast-dump-gitnexus.py`'s own header describes.

WHY SQLITE DIRECTLY, NOT `codegraph query`/`explore`
------------------------------------------------------
`codegraph query <term>` is a SEARCH (it needs a term and a --limit) and `explore` returns
prose, not a symbol table — neither is a full-repository dump. `codegraph init`/`index` writes
a real SQLite database at `<repo>/.codegraph/codegraph.db` with a `nodes` table carrying
`kind, name, file_path, start_line, end_line` for every symbol CodeGraph extracted, and an
`edges` table for the graph. Reading it directly is exact and needs no output-format guessing.

TAXONOMY MAP -- CodeGraph `kind` -> Koragraph node_type
---------------------------------------------------------
Same discipline as GitNexus's LABEL_MAP: every kind that plausibly denotes a declaration is
mapped, generously, so a miss is a real miss and not a taxonomy artifact. Observed kinds (from
indexing this benchmark's own Go, Java, Python, JS, TS, C#, Kotlin, PHP and C++ corpora):
class, struct, interface, type_alias, enum, trait, function, method, constructor, constant,
variable, field, property.

NOT declarations -- CodeGraph's own container/derived/framework layer, excluded exactly as
GitNexus's File/Folder/Community/Process/Section are excluded on the other side:
  file    -- the file itself
  import  -- CodeGraph mints a NODE per import statement (not just an edge); it is a reference,
             not something the file declares
  route   -- framework-detected HTTP route (Gin etc.); a derived annotation, not a declaration

Usage:
  ast-dump-codegraph.py --repo <indexed checkout> --out <nodes.json> [--labels]
"""
import argparse
import json
import os
import sqlite3
import sys

KIND_MAP = {
    "class": "CLASS", "struct": "CLASS", "type_alias": "CLASS", "enum": "CLASS", "trait": "CLASS",
    "interface": "INTERFACE",
    "function": "METHOD", "method": "METHOD", "constructor": "METHOD",
    "field": "FIELD", "property": "FIELD",
    # CodeGraph has no instance-attribute node kind; its only variable-like kind
    # is `variable`, which holds module-level constants (__version__, ssl, ...).
    # Mapping it to FIELD double-penalised CodeGraph — 0% on the constants plane
    # (no `constant` kind) AND ~0% on fields (its variables aren't self.x attrs).
    # CONSTANT is the accurate bin (adversarial audit, 2026-08-28).
    "variable": "CONSTANT",
    # An enum member (`RED` in `enum Color { RED, GREEN }`) is a named constant in every
    # referee's own taxonomy (javac, Roslyn, go/parser, CPython ast all report it as such) --
    # mapping it anywhere else would make a correct CodeGraph extraction score as a miss.
    "constant": "CONSTANT", "enum_member": "CONSTANT",
}

# Not declarations, same discipline as GitNexus's CONTAINER_LABELS on the other side.
#   file       -- the file itself
#   import     -- CodeGraph mints a NODE per import statement, not just an edge
#   route      -- framework-detected HTTP route (Gin etc.), a derived annotation
#   namespace  -- a container/organizational node, never emitted as a declaration by any
#                 referee here (ast-layer-compare.py excludes Graphify's own namespace/
#                 package/module nodes from the SAME plane for the SAME reason)
#   component  -- a framework-detection artifact (seen once, in zod); not a referee-modelled kind
CONTAINER_KINDS = {"file", "import", "route", "namespace", "component"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="indexed checkout (must already have .codegraph/codegraph.db)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--labels", action="store_true", help="print the kind census and exit")
    a = ap.parse_args()

    db_path = os.path.join(a.repo, ".codegraph", "codegraph.db")
    if not os.path.exists(db_path):
        raise SystemExit(f"FATAL: no CodeGraph index at {db_path}. Run `codegraph init --force {a.repo}` first.")

    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("SELECT kind, count(*) FROM nodes GROUP BY kind ORDER BY count(*) DESC")
    counts = {k: c for k, c in cur.fetchall()}
    if a.labels:
        print(json.dumps(counts, indent=2))
        return

    unmapped = sorted(set(counts) - set(KIND_MAP) - CONTAINER_KINDS)

    cur.execute("SELECT kind, name, file_path, start_line, end_line, qualified_name FROM nodes")
    nodes = []
    for kind, name, file_path, start_line, end_line, qname in cur.fetchall():
        ntype = KIND_MAP.get(kind)
        if not ntype:
            continue
        if not name or not file_path:
            continue
        nodes.append({
            "file": file_path, "name": name, "line": start_line, "end_line": end_line,
            "node_type": ntype, "kind": kind, "qualified_name": qname,
            # CALLS telemetry is scored separately (edge-dump-codegraph.py); this dump scores
            # the DECLARATION planes only. Read as "not measured here", not "zero calls found".
            "calls": 0, "calls_with_receiver": 0,
        })

    out = {
        "system": "codegraph",
        "repo": os.path.basename(a.repo.rstrip("/")),
        "nodes": nodes,
        "label_census": counts,
        "unmapped_labels": {l: counts[l] for l in unmapped},
        "container_labels_excluded": {l: counts[l] for l in CONTAINER_KINDS if l in counts},
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[codegraph-dump:{out['repo']}] {len(nodes)} declaration nodes "
        f"({sum(1 for n in nodes if n['node_type']=='METHOD')} methods, "
        f"{sum(1 for n in nodes if n['node_type'] in ('CLASS','INTERFACE'))} types, "
        f"{sum(1 for n in nodes if n['node_type']=='FIELD')} fields, "
        f"{sum(1 for n in nodes if n['node_type']=='CONSTANT')} constants) -> {a.out}\n")
    if unmapped:
        sys.stderr.write(f"[codegraph-dump:{out['repo']}] UNMAPPED kinds (not counted): "
                         f"{ {l: counts[l] for l in unmapped} }\n")


if __name__ == "__main__":
    main()
