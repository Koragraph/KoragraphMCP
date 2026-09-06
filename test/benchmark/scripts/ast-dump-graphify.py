#!/usr/bin/env python3
"""Dump a Graphify graph.json's DECLARATIONS into the node shape score-decls.py
consumes, so Graphify is scored declaration-for-declaration like the others.

Graphify marks a class node with `_callable_class:true` and a callable
(function/method) with `_callable:true`; the label is `name()` / `.name()` for
callables and bare for a type, stripped the same way edge-dump-graphify.py does
its `label_name`. Graphify models no field/constant/instance-attribute node, so
those planes are simply empty for it (reported, not hidden). Nodes with no
`source_location` are external type references (Any, TypedDict, ...), not local
declarations, and are excluded.

  ast-dump-graphify.py --graph <repo>/graphify-out/graph.json --out <nodes.json>
"""
import argparse
import json
import os
import sys


def label_name(label):
    if not isinstance(label, str):
        return None
    return label.lstrip(".").rstrip("()") or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--graph", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    d = json.load(open(a.graph))

    out_nodes = []
    for n in d.get("nodes", []):
        if n.get("file_type") != "code" or n.get("_origin") != "ast":
            continue
        loc = n.get("source_location")
        # a real declaration has a concrete source line; nodes with no location
        # (or the L1 placeholder with no callable flag) are external references.
        if not loc or loc in ("", "L1"):
            continue
        f = n.get("source_file")
        if not f:
            continue
        label = n.get("label") or ""
        if n.get("_callable_class"):
            ntype = "CLASS"
        elif n.get("_callable"):
            ntype = "METHOD"
        else:
            # Flag-less languages (Go, ...) mark callables only by the label's
            # trailing "()" (same convention edge-dump-graphify uses); a bare
            # label with a real source line is a type declaration.
            ntype = "METHOD" if label.rstrip().endswith(")") else "CLASS"
        name = label_name(label)
        if not name:
            continue
        try:
            line = int(str(loc).lstrip("L")) if loc and str(loc).lstrip("L").isdigit() else None
        except ValueError:
            line = None
        out_nodes.append({"file": f, "name": name, "node_type": ntype,
                          "kind": ntype.lower(), "line": line})

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump({"system": "graphify", "nodes": out_nodes}, open(a.out, "w"))
    sys.stderr.write(
        f"[graphify-dump] {len(out_nodes)} declaration nodes "
        f"({sum(1 for n in out_nodes if n['node_type'] == 'METHOD')} methods, "
        f"{sum(1 for n in out_nodes if n['node_type'] == 'CLASS')} types, 0 fields, "
        f"0 constants) -> {a.out}\n")


if __name__ == "__main__":
    main()
