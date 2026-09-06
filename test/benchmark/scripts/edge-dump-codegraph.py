#!/usr/bin/env python3
"""Dump a CodeGraph index's EDGES into the same {imports, inheritance, calls} shape the
edge referees (edge-referee-cpython.py, edge-referee-java.py, edge-referee-goast,
edge-referee-tsc.js) emit as truth, so one generalized scorer (edge-compare-generic.py) grades
CodeGraph exactly like it grades any other system.

SCHEMA (from `.codegraph/codegraph.db`, read directly -- see ast-dump-codegraph.py's header for
why SQLite and not a CLI command):
  nodes(id, kind, name, qualified_name, file_path, ...)
  edges(source, target, kind, metadata, line, ...)   -- source/target are node ids

PLANES
------
  imports      (file, name)         edges.kind == 'imports'. `name` prefers the edge's own
                                    metadata.refName (the exact string as written in the source,
                                    e.g. "github.com/spf13/pflag") over the target node's `name`,
                                    because CodeGraph mints one `import` NODE per import
                                    STATEMENT and that node's `name` is already the raw path --
                                    but a handful of edges (low-confidence "fuzzy" resolution)
                                    point at a non-import node instead, and metadata.refName is
                                    reliable in both cases.
  inheritance  (file, child, base)  edges.kind in ('extends', 'implements'). child/base are the
                                    source/target nodes' own `name` (bare identifier, matching
                                    every referee's convention of keeping only the final
                                    component).
  calls        (file, caller, callee)  edges.kind == 'calls'. caller/callee are the source/target
                                    nodes' `name`. `file` is the CALLER's file (matching every
                                    referee: `caller`'s enclosing file, not the callee's).

Usage:
  edge-dump-codegraph.py --repo <indexed checkout> --out <edges.json>
"""
import argparse
import json
import os
import sqlite3
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    db_path = os.path.join(a.repo, ".codegraph", "codegraph.db")
    if not os.path.exists(db_path):
        raise SystemExit(f"FATAL: no CodeGraph index at {db_path}. Run `codegraph init --force {a.repo}` first.")

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    nodes = {}
    import_nodes = []
    cur.execute("SELECT id, name, file_path, kind FROM nodes")
    for nid, name, file_path, kind in cur.fetchall():
        nodes[nid] = (name, file_path)
        # CodeGraph mints an import NODE per import statement and only mints an
        # import EDGE when the module resolves to an in-repo symbol, so every
        # stdlib/external import (os, typing, hashlib) lives as a node with no
        # edge. Harvesting only edges scored those as misses and understated
        # CodeGraph's import recall by ~26-35 points (adversarial audit,
        # 2026-08-28). This is the direct analogue of ast-dump-codegraph reading
        # declaration nodes. Fixed per the rule that a harness bug is fixed even
        # when the fix helps a competitor.
        if kind == "import" and name and file_path:
            import_nodes.append({"file": file_path, "name": name})

    def node_name(nid):
        return nodes.get(nid, (None, None))[0]

    def node_file(nid):
        return nodes.get(nid, (None, None))[1]

    out = {"imports": [], "inheritance": [], "calls": []}

    # 'instantiates' folds into calls: koragraph (and the CPython referee) count
    # Foo() as a call with callee Foo, so CodeGraph's separate instantiation edge
    # must join the calls plane or its calls recall is understated (~15% of
    # intra-repo calls are class-name callees). Fixed per the standing rule that
    # a harness bug is fixed even when the fix helps a competitor.
    cur.execute("SELECT source, target, kind, metadata, line FROM edges "
                "WHERE kind IN ('imports','extends','implements','calls','instantiates')")
    for source, target, kind, metadata_raw, line in cur.fetchall():
        src_file = node_file(source)
        if not src_file:
            continue
        if kind == "imports":
            ref_name = None
            if metadata_raw:
                try:
                    ref_name = json.loads(metadata_raw).get("refName")
                except (ValueError, TypeError):
                    ref_name = None
            name = ref_name or node_name(target)
            if name:
                out["imports"].append({"file": src_file, "name": name})
        elif kind in ("extends", "implements"):
            child, base = node_name(source), node_name(target)
            if child and base:
                out["inheritance"].append({"file": src_file, "child": child, "base": base})
        elif kind in ("calls", "instantiates"):
            caller, callee = node_name(source), node_name(target)
            if caller and callee:
                out["calls"].append({"file": src_file, "caller": caller, "callee": callee})

    # Merge the import nodes with the resolved import edges, deduped by (file,
    # name) so a resolved import counted both ways doesn't inflate the precision
    # denominator.
    seen = {(x["file"], x["name"]) for x in out["imports"]}
    for x in import_nodes:
        if (x["file"], x["name"]) not in seen:
            out["imports"].append(x)
            seen.add((x["file"], x["name"]))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"))
    sys.stderr.write(
        f"[codegraph-edge-dump:{os.path.basename(a.repo.rstrip('/'))}] "
        f"{len(out['imports'])} imports, {len(out['inheritance'])} inheritance, "
        f"{len(out['calls'])} calls -> {a.out}\n")


if __name__ == "__main__":
    main()
