# /test — the koragraph code-graph benchmark (reproducible)

Everything needed to regenerate the numbers in `REPORT.md` from scratch. Deterministic, judge-free:
each system's graph is compared to an independent oracle (a compiler front-end, never the tool under
test) by one shared scorer at one shared library scope.

## Layout

```
test/
  REPORT.md                 the published results + methodology
  corpus-manifest.tsv       36 repos (12 langs × 3), pinned SHAs + lib scopes
  scripts/                  oracles (referees), competitor dumpers, scorers, dump-koragraph.js
  langquality/              measure.sh, scope-filter.py, score-decls.py
  run/                      run-competitor.sh, master-h2h.sh, ccswift-h2h.sh, aggregate.py
  results/                  per-repo comparison JSON + summary.tsv (committed)
```

## Prerequisites (pinned)

- **Node ≥ 22**, **Python 3.11+**.
- Oracle toolchains: `python3` (CPython ast), Go toolchain (`go/parser`), Universal Ctags 6.x
  (C/C++), `swiftc` (Swift), TypeScript 5.6.3 (bundled under `scripts/tsc-referee`), Ruby 3.4
  (Ripper/AST), PHP 8 with `ext-ast`, .NET 10 (Roslyn referee), Rust/`cargo` (`syn` referee).
- Competitors (installed locally, no API): CodeGraph `@colbymchenry/codegraph@1.6.0`,
  GitNexus `gitnexus@1.6.10`, Graphify `graphifyy@0.9.51`. Install commands in `run/SETUP.md`.
- koragraph: this repository, ingested with `LLM_EXTRACTION=off` (zero network, zero API).

## Clone the corpus (pinned)

```bash
while IFS=$'\t' read -r lang repo lib remote sha; do
  [ "$lang" = lang ] && continue
  git clone "$remote" corpus/"$repo" && git -C corpus/"$repo" checkout "$sha"
done < corpus-manifest.tsv
```

## Reproduce one repository (koragraph vs the oracle)

```bash
KORAGRAPH_DB=/tmp/kg/<repo>.db LLM_EXTRACTION=off node bin/koragraph.js ingest corpus/<repo>
bash test/langquality/measure.sh <repo> corpus/<repo> <libPrefix> /tmp/kg/<repo>.db <lang> test/results
```

## Reproduce the full head-to-head

```bash
bash test/run/master-h2h.sh     # 8 core languages + TS/JS, 4 systems, edges + declarations
bash test/run/ccswift-h2h.sh    # C / C++ / Swift declarations (Graphify + GitNexus)
python3 test/run/aggregate.py test/results/summary.tsv --md   # regenerate the report tables
```

## Method (why the numbers hold)

- **Independent oracle per language** — compiler front-end, not tree-sitter, wherever one exists.
- **One scorer, one library scope, symmetric normalization** for every system.
- **`calls_intra_repo`** is the fair calls denominator (callee must be a declared in-repo symbol).
- **Competitor cache hygiene** — each competitor index is written to a throwaway path and deleted
  before the oracle runs, so no cache is ever scored as source.
- **Verify every 0** — a silent competitor 0 is treated as a harness bug until proven otherwise.
- Recall and precision are both reported; where a competitor's higher raw recall costs precision,
  both numbers are shown.

See `REPORT.md` for the full results and the one honestly-documented soft spot (C# call recall).
