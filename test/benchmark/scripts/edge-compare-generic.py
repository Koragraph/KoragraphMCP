#!/usr/bin/env python3
"""Score EDGE extraction for an arbitrary set of systems against a referee truth file.

Generalizes edge-compare.py's scoring rules (module_variants, the anonymous-class exclusion, the
declared-symbol call ceiling, the imports precision/recall split) to N systems read from plain
JSON dumps, instead of edge-compare.py's own hardcoded Koragraph-Postgres and GitNexus-cypher
extraction blocks. Every scoring RULE below is copied verbatim from edge-compare.py so a
Koragraph/GitNexus number reproduced through this script matches the original exactly; only the
extraction side is generalized. Never used to re-score Koragraph or GitNexus for publication —
their numbers already exist from edge-compare.py itself. This script exists so CodeGraph and
Graphify (whose edges live in a plain JSON dump, not a queryable service) can be scored by the
SAME rules against the SAME truth.

Each `--system name=path.json` file must have the shape:
  {"imports": [{"file","name"}], "inheritance": [{"file","child","base"}],
   "calls": [{"file","caller","callee"}]}
(edge-dump-codegraph.py and edge-dump-graphify.py both produce this shape.)

  edge-compare-generic.py --truth t.json [--decl-truth decl_truth.json] \\
      --system codegraph=cg_edges.json --system graphify=gf_edges.json --out cmp.json
"""
import argparse, collections, json, os, re, sys


def final(n):
    return (n or "").split(".")[-1].strip()


def module_variants(n):
    """Acceptable spellings of an imported module — copied verbatim from edge-compare.py so
    imports are scored identically across every system in this benchmark."""
    n = (n or "").strip()
    if not n:
        return frozenset()
    bare = n.lstrip(".")
    out = {n, bare}
    if "/" in bare or bare.endswith((".py", ".pyi")):
        base = os.path.basename(bare)
        stem = base.rsplit(".", 1)[0] if "." in base else base
        if stem == "__init__":
            parent = os.path.basename(os.path.dirname(bare))
            if parent:
                out.add(parent)
        elif stem:
            out.add(stem)
    else:
        parts = [p for p in bare.split(".") if p]
        if parts:
            out.add(parts[0])
            out.add(parts[-1])
    return frozenset(x for x in out if x)


def score(truth_ms, got_ms):
    matched = sum((truth_ms & got_ms).values())
    return {
        "truth": sum(truth_ms.values()), "found": sum(got_ms.values()), "matched": matched,
        "missed": sum(truth_ms.values()) - matched,
        "extra": sum(got_ms.values()) - matched,
        "recall": round(100.0 * matched / sum(truth_ms.values()), 1) if sum(truth_ms.values()) else 0.0,
        "precision": round(100.0 * matched / sum(got_ms.values()), 1) if sum(got_ms.values()) else 0.0,
    }


ANON = re.compile(r"\$\d")


def score_imports(truth_items, got_pairs):
    got_by_file = collections.defaultdict(set)
    for (f, m) in got_pairs:
        got_by_file[f] |= module_variants(m)
    matched = 0
    for x in truth_items:
        if module_variants(x["name"]) & got_by_file.get(x["file"], frozenset()):
            matched += 1
    tot = len(truth_items)
    truth_by_file = collections.defaultdict(set)
    for x in truth_items:
        truth_by_file[x["file"]] |= module_variants(x["name"])
    precise = sum(1 for (f, m) in got_pairs if module_variants(m) & truth_by_file.get(f, frozenset()))
    return {"truth": tot, "found": len(got_pairs), "matched": matched, "missed": tot - matched,
            "extra": len(got_pairs) - precise,
            "recall": round(100.0 * matched / tot, 1) if tot else 0.0,
            "precision": round(100.0 * precise / len(got_pairs), 1) if got_pairs else 0.0}


def load_system(path):
    d = json.load(open(path))
    return {
        "imports": collections.Counter((x["file"], x["name"]) for x in d.get("imports", [])),
        "inheritance": collections.Counter(
            (x["file"], x["child"], final(x["base"])) for x in d.get("inheritance", [])
            if not ANON.search(x.get("child") or "")),
        "calls": collections.Counter(set(
            (x["file"], x["caller"], final(x["callee"])) for x in d.get("calls", []))),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--decl-truth", default=None,
                    help="declaration-benchmark truth json for the same repo; supplies the "
                         "modellable-symbol set for the calls_intra_repo ceiling")
    ap.add_argument("--system", action="append", required=True, metavar="name=path.json")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    t = json.load(open(a.truth))
    parsed = set()
    for plane in ("imports", "inheritance", "calls"):
        for x in t[plane]:
            parsed.add(x["file"])
    errored = set(t.get("parse_errors") or [])

    def keep(f):
        return f in parsed and f not in errored

    T = {
        "imports": [x for x in t["imports"] if keep(x["file"])],
        "inheritance": collections.Counter(
            (x["file"], x["child"], final(x["base"])) for x in t["inheritance"]
            if keep(x["file"]) and not ANON.search(x["child"])),
        "calls": collections.Counter(set(
            (x["file"], x["caller"], final(x["callee"])) for x in t["calls"] if keep(x["file"]))),
    }

    declared = set()
    if a.decl_truth:
        dt = json.load(open(a.decl_truth))
        for plane in ("types", "methods"):
            for x in dt.get(plane, []) or []:
                nm = str(x.get("name", ""))
                if nm:
                    declared.add(nm.split(".")[-1])

    systems = {}
    for spec in a.system:
        name, path = spec.split("=", 1)
        raw = load_system(path)
        systems[name] = {
            "imports": [(f, m) for (f, m), c in raw["imports"].items() if keep(f) for _ in range(c)],
            "inheritance": collections.Counter({k: v for k, v in raw["inheritance"].items() if keep(k[0])}),
            "calls": collections.Counter({k: v for k, v in raw["calls"].items() if keep(k[0])}),
        }

    out = {"truth_file": a.truth, "planes": {}}
    for name, S in systems.items():
        out["planes"].setdefault(name, {})
        out["planes"][name]["imports"] = score_imports(T["imports"], S["imports"])
        out["planes"][name]["inheritance"] = score(T["inheritance"], S["inheritance"])
        out["planes"][name]["calls"] = score(T["calls"], S["calls"])
        if declared:
            def intra(ms):
                return collections.Counter({k: v for k, v in ms.items() if k[2] in declared})
            out["planes"][name]["calls_intra_repo"] = score(intra(T["calls"]), intra(S["calls"]))

    if declared:
        def intra_t(ms):
            return collections.Counter({k: v for k, v in ms.items() if k[2] in declared})
        out["calls_intra_repo_ceiling"] = {
            "modellable": sum(intra_t(T["calls"]).values()), "total": sum(T["calls"].values()),
            "pct": round(100.0 * sum(intra_t(T["calls"]).values()) / sum(T["calls"].values()), 1)
                   if sum(T["calls"].values()) else 0.0}

    json.dump(out, open(a.out, "w"), indent=2)

    planes = ["imports", "inheritance", "calls"] + (["calls_intra_repo"] if declared else [])
    header = f"{'plane':<17} {'truth':>7}   " + "   ".join(f"{n.upper():>21}" for n in systems)
    print(header)
    print("-" * len(header))
    for plane in planes:
        rows = [out["planes"][n][plane] for n in systems]
        t0 = rows[0]["truth"]
        line = f"{plane:<17} {t0:>7}   " + "   ".join(
            f"{r['recall']:>9}% / {r['precision']:>8}%" for r in rows)
        print(line)


if __name__ == "__main__":
    main()
