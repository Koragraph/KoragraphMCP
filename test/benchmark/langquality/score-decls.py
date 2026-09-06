#!/usr/bin/env python3
"""Declaration precision/recall for N systems against an ast-referee truth file.

Replaces the deleted ast-layer-compare.py. Pools declaration names into a
multiset (final dotted component), restricted to the files the referee parsed,
and scores each system identically — the same multiset method goldset.mjs and
benchmark-java.js use, so koragraph and every competitor are judged alike.

  python3 score-decls.py --truth decl-truth.json \
      --system koragraph=kora-decls.json [--system codegraph=cg-decls.json ...] \
      --out cmp.json

Truth is an ast-referee JSON ({types,methods,fields,constants}); each system is
{"decls":[{"name","kind","file"}]}. Headline is the pooled score; per-kind is
diagnostic.
"""
import argparse
import collections
import json


def final(n):
    return (n or "").split(".")[-1].strip()


TRUTH_PLANES = ["types", "methods", "fields", "constants"]

# system node_type -> truth plane
KIND_MAP = {
    "CLASS": "types", "INTERFACE": "types", "ENUM": "types", "RECORD": "types",
    "STRUCT": "types", "TRAIT": "types", "PROTOCOL": "types", "TYPE": "types",
    "ANNOTATION": "types",
    "METHOD": "methods", "FUNCTION": "methods",
    "FIELD": "fields",
    "CONSTANT": "constants",
}


def score(truth_ms, got_ms):
    matched = sum((truth_ms & got_ms).values())
    tot = sum(truth_ms.values())
    got = sum(got_ms.values())
    return {
        "truth": tot, "found": got, "matched": matched,
        "missed": tot - matched, "extra": got - matched,
        "recall": round(100.0 * matched / tot, 1) if tot else 0.0,
        "precision": round(100.0 * matched / got, 1) if got else 0.0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--system", action="append", required=True, metavar="name=path.json")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    t = json.load(open(a.truth))
    files = set()
    truth_by_plane = {}
    for plane in TRUTH_PLANES:
        items = t.get(plane, []) or []
        truth_by_plane[plane] = collections.Counter(final(x["name"]) for x in items)
        for x in items:
            files.add(x["file"])
    truth_pooled = sum(truth_by_plane.values(), collections.Counter())

    out = {"truth_file": a.truth, "files": len(files), "systems": {}}
    for spec in a.system:
        name, path = spec.split("=", 1)
        d = json.load(open(path))
        # koragraph dump uses "decls"; the ast-dump-* competitor dumps use "nodes".
        items = d.get("decls") or d.get("nodes") or []
        by_plane = collections.defaultdict(collections.Counter)
        pooled = collections.Counter()
        for x in items:
            if x["file"] not in files:
                continue
            # koragraph carries node_type in "kind"; competitor dumps carry an
            # uppercase "node_type" plus a lowercase "kind" — prefer node_type.
            plane = KIND_MAP.get((x.get("node_type") or x.get("kind") or "").upper())
            nm = final(x["name"])
            pooled[nm] += 1
            if plane:
                by_plane[plane][nm] += 1
        rec = {"pooled": score(truth_pooled, pooled)}
        for plane in TRUTH_PLANES:
            rec[plane] = score(truth_by_plane[plane], by_plane.get(plane, collections.Counter()))
        out["systems"][name] = rec

    json.dump(out, open(a.out, "w"), indent=2)

    hdr = f"{'system':<14}" + "".join(f"{p[:5]:>16}" for p in ["pooled", *TRUTH_PLANES])
    print(hdr)
    print("-" * len(hdr))
    for name, rec in out["systems"].items():
        row = f"{name:<14}"
        for p in ["pooled", *TRUTH_PLANES]:
            r = rec[p]
            row += f"{r['recall']:>6}%/{r['precision']:>5}% "
        print(row)


if __name__ == "__main__":
    main()
