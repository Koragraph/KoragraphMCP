#!/usr/bin/env python3
"""Dump a Graphify graph.json's EDGES into the same {imports, inheritance, calls} shape the
edge referees emit as truth, so `edge-compare-generic.py` grades Graphify exactly like it grades
any other system.

Graphify's own relation vocabulary (read off real graph.json files built by
`graphify update <checkout> --no-cluster` for this benchmark's Go/Java/Python/JS corpora, not
assumed): `imports_from`, `imports`, `depends_on` (build-file / manifest dependency, e.g. a
pom.xml <dependency> -- NOT a code-level import, excluded here), `contains`, `method`,
`references`, `calls`, `indirect_call`, `extends`, `implements`, `inherits`, `embeds` (Go's
embedding-as-inheritance analogue, matching edge-referee-goast's own truth definition),
`case_of`, `re_exports`, `uses`, `cites`, `rationale_for`.

NODE NAMING -- reusing ast-layer-compare.py's own convention, not inventing a new one
--------------------------------------------------------------------------------------
Graphify labels a callable `name()` (or `.name()` for a class member) and a type bare -- this is
`load_graphify`'s own documented reading of their label convention (ast-layer-compare.py:194-204,
261-350). The SAME `label.lstrip('.').rstrip('()')` strip is applied here, so a name recovered
for the edge planes is spelled identically to the declaration planes already scored against this
graph.json via `ast-layer-compare.py --graphify`.

IMPORT TARGETS ARE OFTEN SYNTHETIC, UNRESOLVED NODES
------------------------------------------------------
An import of a package outside the repo (or, for Java, a class Graphify did not itself index)
has NO real node in `nodes` -- the edge's `target` id is a synthesized string with a
language-specific prefix (`go_pkg_`, `pkg_`, `ref_`, ...) that encodes the imported path with
separators folded to `_`. This is read off real output, not guessed: `go_pkg_crypto_subtle` for
Go's `crypto/subtle`, bare lowercased class names (`jsonarray`, `arraylist`) for Java's `imports`
relation, `ref_vitepress` for a JS default import. Recovered by stripping the first matching
prefix and turning the remaining `_`-joined path back into a `/`-joined one, which is
lossy (a real underscore in an identifier cannot be told apart from a folded separator) but is
resolved by the SAME variant-overlap matching (`module_variants`, copied verbatim from
edge-compare.py) already used to score every other system's imports plane on this benchmark, so
an imperfect reconstruction still matches on a shared spelling exactly as generously as the
existing scorer treats Koragraph's and GitNexus's own import-name conventions.

Usage:
  edge-dump-graphify.py --graph <repo>/graphify-out/graph.json --out <edges.json>
"""
import argparse
import json
import os
import re
import sys

INHERITANCE_RELATIONS = {"extends", "implements", "inherits", "embeds"}
CALL_RELATIONS = {"calls", "indirect_call"}
IMPORT_RELATIONS = {"imports", "imports_from"}

_PREFIX_RE = re.compile(r"^(go_pkg_|py_pkg_|pkg_|ref_|npm_pkg_|js_pkg_|node_pkg_)")


def label_name(label):
    if not isinstance(label, str):
        return None
    return label.lstrip(".").rstrip("()") or None


def unresolved_name(node_id):
    stripped = _PREFIX_RE.sub("", node_id)
    return stripped.replace("_", "/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--graph", required=True, help="graphify-out/graph.json")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    d = json.load(open(a.graph))
    nodes = {n["id"]: n for n in d.get("nodes", [])}
    links = d.get("links", d.get("edges", []))

    out = {"imports": [], "inheritance": [], "calls": []}

    for l in links:
        rel = l.get("relation") or l.get("type")
        src_id, tgt_id = l.get("source"), l.get("target")
        src_node = nodes.get(src_id)
        if not src_node:
            continue
        src_file = src_node.get("source_file")
        if not src_file:
            continue

        if rel in IMPORT_RELATIONS:
            tgt_node = nodes.get(tgt_id)
            name = (label_name(tgt_node.get("label")) if tgt_node
                    else unresolved_name(tgt_id))
            if name:
                out["imports"].append({"file": src_file, "name": name})
        elif rel in INHERITANCE_RELATIONS:
            child = label_name(src_node.get("label"))
            tgt_node = nodes.get(tgt_id)
            base = label_name(tgt_node.get("label")) if tgt_node else unresolved_name(tgt_id)
            if child and base:
                out["inheritance"].append({"file": src_file, "child": child, "base": base})
        elif rel in CALL_RELATIONS:
            caller = label_name(src_node.get("label"))
            tgt_node = nodes.get(tgt_id)
            callee = label_name(tgt_node.get("label")) if tgt_node else unresolved_name(tgt_id)
            if caller and callee:
                out["calls"].append({"file": src_file, "caller": caller, "callee": callee})

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[graphify-edge-dump:{os.path.basename(os.path.dirname(os.path.dirname(a.graph)))}] "
        f"{len(out['imports'])} imports, {len(out['inheritance'])} inheritance, "
        f"{len(out['calls'])} calls -> {a.out}\n")


if __name__ == "__main__":
    main()
