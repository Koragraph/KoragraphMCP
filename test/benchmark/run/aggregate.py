#!/usr/bin/env python3
"""Aggregate h2h/summary.tsv into per-(language,plane) means per system + a win/loss view.
Usage: aggregate.py <summary.tsv> [--md]  ; --md prints GitHub-markdown tables for the report."""
import sys, csv
from collections import defaultdict

SYS = ["koragraph", "codegraph", "gitnexus", "graphify"]
PLANES = ["decls_pooled", "imports", "inheritance", "calls_intra_repo"]

def load(path):
    rows = list(csv.DictReader(open(path), delimiter="\t"))
    # (lang,plane) -> sys -> list of (R,P)
    agg = defaultdict(lambda: defaultdict(list))
    for r in rows:
        lang, plane = r.get("lang"), r.get("plane")
        if plane not in PLANES:
            continue
        for s in SYS:
            R, P = r.get(f"{s}_R", ""), r.get(f"{s}_P", "")
            if R not in ("", None):
                try:
                    agg[(lang, plane)][s].append((float(R), float(P) if P not in ("", None) else None))
                except ValueError:
                    pass
    return agg

def mean(vals, idx):
    xs = [v[idx] for v in vals if v[idx] is not None]
    return round(sum(xs) / len(xs), 1) if xs else None

def main():
    path = sys.argv[1]
    md = "--md" in sys.argv
    agg = load(path)
    langs = sorted({l for (l, p) in agg})
    wins = defaultdict(lambda: {"win": 0, "tie": 0, "loss": 0, "na": 0})
    lines = []
    for lang in langs:
        lines.append(f"\n### {lang}")
        lines.append("| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |")
        lines.append("|---|---|---|---|---|---|")
        for plane in PLANES:
            cell = agg.get((lang, plane))
            if not cell:
                continue
            def fmt(s):
                v = cell.get(s)
                if not v: return "—"
                r, p = mean(v, 0), mean(v, 1)
                return f"{r}/{p}" if p is not None else f"{r}"
            kr = mean(cell.get("koragraph", []), 0)
            comp_r = [mean(cell.get(s, []), 0) for s in ("codegraph","gitnexus","graphify") if cell.get(s)]
            comp_r = [x for x in comp_r if x is not None]
            verdict = "—"
            if kr is not None and comp_r:
                best = max(comp_r)
                if kr > best + 0.5: verdict, key = "**WIN**", "win"
                elif kr < best - 0.5: verdict, key = f"trails (best {best})", "loss"
                else: verdict, key = "tie", "tie"
                wins[lang][key] += 1
            elif kr is not None:
                verdict, key = "(no competitor)", "na"; wins[lang]["na"] += 1
            lines.append(f"| {plane} | {fmt('koragraph')} | {fmt('codegraph')} | {fmt('gitnexus')} | {fmt('graphify')} | {verdict} |")
    # summary
    print("## Win/loss summary (recall, koragraph vs best competitor per language×plane)\n")
    print("| language | wins | ties | trails | uncontested |")
    print("|---|---|---|---|---|")
    tot = {"win":0,"tie":0,"loss":0,"na":0}
    for lang in langs:
        w = wins[lang]
        for k in tot: tot[k]+=w[k]
        print(f"| {lang} | {w['win']} | {w['tie']} | {w['loss']} | {w['na']} |")
    print(f"| **TOTAL** | **{tot['win']}** | **{tot['tie']}** | **{tot['loss']}** | **{tot['na']}** |")
    if md:
        print("\n".join(lines))

if __name__ == "__main__":
    main()
