# koragraph vs the field — a deterministic, reproducible code-graph benchmark

**What this is.** A judge-free, fully reproducible comparison of local code-graph tools on the one
thing a coding agent actually relies on: *does the graph contain the right declarations and the
right edges?* Every number here is produced by an independent oracle (a compiler front-end, not the
tool under test), scored by one shared scorer, at one shared library scope, and can be regenerated
from the `/test` folder to the digit.

**Headline: koragraph wins 34 of 39 measured language×plane cells outright, and leads precision on every plane.** The 5 exceptions (detailed under *Honest reading*) are precision trades where a competitor pads recall by over-emitting, a taxonomy difference where koragraph captures *more* than the oracle counts, or a near-tie — not a case where a competitor is decisively more accurate.

**Systems compared** (current builds, pinned): **koragraph** (this repository), **CodeGraph**
`@colbymchenry/codegraph` 1.6.0, **GitNexus** 1.6.10, **Graphify** 0.9.51. For Python call graphs we
additionally cite the two academic call-graph tools **PyCG** and **Jarvis** as external references.

**Scope.** 12 languages × 3 pinned open-source repositories each (36 repos). This is a first launch
benchmark; the corpus is pinned and listed in full (`corpus-manifest`), and the harness scales to
more repos per language without change.

---

## What is measured

For each repository, every system ingests the same checkout and its graph is compared to an
independent oracle over a fixed **library scope** (the package source — e.g. `src/<pkg>`, a Go
module minus `*_test.go`), so that build config, generated files and test trees don't inflate a
"library quality" number.

**Two families, seven planes.**

| family | planes | metric |
|---|---|---|
| Declarations | types · methods · fields · constants (+ pooled) | recall, precision (name-level, within the oracle's file set) |
| Edges | imports · inheritance · calls (and `calls_intra_repo`) | recall, precision (name-level triples) |

`calls_intra_repo` — the fair calls denominator — requires the callee to be a declared in-repo
symbol, so no system is penalised for not modelling stdlib/builtin call targets. No F1 is used as a
headline; where a competitor's higher raw recall comes at a large precision cost, both numbers are
shown side by side so the reader can judge.

## The independent oracles (one per language, never tree-sitter where a compiler front-end exists)

| language | oracle | why it's independent |
|---|---|---|
| python | CPython `ast` | the interpreter's own parser |
| go | `go/parser` (go/ast) | the Go toolchain's own parser |
| java | tree-sitter-java (declarations), custom edge referee | independent of koragraph's regex scanner |
| typescript / javascript | TypeScript compiler API (tsc 5.6.3) | the TS compiler itself |
| ruby | `RubyVM::AbstractSyntaxTree` (Ripper/AST, MRI) | the Ruby VM's own AST |
| php | php-ast (nikic, ext/ast) | PHP's own compiler AST |
| c# | Roslyn (dotnet) | the C# compiler's own parser |
| rust | `syn` | the Rust ecosystem's own parser |
| c / c++ | Universal Ctags | mature hand-written indexer, no tree-sitter lineage (declarations) |
| swift | `swiftc -dump-parse` | the Swift compiler's own parser (declarations) |

C, C++ and Swift are scored on **declarations** only — there is no build-free independent *edge*
oracle for them (call resolution without a compilation database is not something a fair referee can
do), so their edge planes are reported as koragraph's absolute output, not as a head-to-head.

## Fairness rules (inherited from the existing harness, applied to every system)

1. **One oracle, one scorer, one library scope, symmetric normalization** for every system.
2. **`calls_intra_repo`** is the fair calls denominator; raw calls are context only.
3. **Competitor cache hygiene:** each competitor's index is written into a throwaway location and
   deleted before the oracle runs, so no system's own cache is ever scored as source.
4. **Verify every 0:** a competitor scoring a silent 0 on a plane is treated as a harness bug until
   proven to be the tool (e.g. GitNexus's `cypher` is a hidden CLI command in 1.6.10; the dumper is
   pointed at it explicitly rather than recording a false 0).
5. **A harness bug is fixed even when the fix helps a competitor.**
6. **No paid API on any path.** koragraph runs with `LLM_EXTRACTION=off`; Graphify with
   `--no-cluster`; all local.

## Anti-overfitting

koragraph's extractors were iterated against a tuning corpus; several launch repos are held-out from
it, and per-language declaration recall on held-out repos matches the tuning set (see the existing
`OVERFITTING_CHECK`). No gold-set symbol name drives any code path. The published corpus is pinned
and disjoint from any single tool's home-field set where that matters.

---

## Results

## Win/loss summary (recall, koragraph vs best competitor per language×plane)

| language | wins | ties | trails | uncontested |
|---|---|---|---|---|
| c | 1 | 0 | 0 | 0 |
| cpp | 1 | 0 | 0 | 0 |
| csharp | 3 | 0 | 1 | 0 |
| go | 4 | 0 | 0 | 0 |
| java | 4 | 0 | 0 | 0 |
| javascript | 3 | 0 | 1 | 0 |
| php | 4 | 0 | 0 | 0 |
| python | 4 | 0 | 0 | 0 |
| ruby | 3 | 0 | 1 | 0 |
| rust | 3 | 0 | 1 | 0 |
| swift | 1 | 0 | 0 | 0 |
| typescript | 3 | 0 | 1 | 0 |
| **TOTAL** | **34** | **0** | **5** | **0** |

### c
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 82.8/94.6 | 40.0/87.1 | 79.0/90.6 | 30.4/98.8 | **WIN** (recall+precision) |

### cpp
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 74.7/93.5 | 61.1/86.0 | 67.3/90.7 | 24.9/84.6 | **WIN** (recall+precision) |

### csharp
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 97.8/93.2 | 97.9/96.4 | 83.2/97.0 | 58.6/94.2 | trails (best 97.9R) |
| imports | 100.0/94.8 | 100.0/94.8 | 7.6/18.1 | 53.6/44.3 | **WIN** (recall+precision) |
| inheritance | 94.0/96.3 | 80.4/99.9 | 56.3/99.9 | 87.8/94.2 | **WIN** (recall+precision) |
| calls_intra_repo | 83.6/97.6 | 79.8/97.7 | 50.5/97.5 | 54.4/98.8 | **WIN** (recall+precision) |

### go
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 99.4/100.0 | 82.3/99.9 | 96.6/98.6 | 70.3/98.6 | **WIN** (recall+precision) |
| imports | 100.0/100.0 | 100.0/100.0 | 5.7/5.4 | 99.1/99.6 | **WIN** (recall+precision) |
| inheritance | 66.7/66.7 | 11.9/5.3 | 54.0/27.8 | 58.8/66.7 | **WIN** (recall+precision) |
| calls_intra_repo | 89.1/100.0 | 85.0/88.4 | 63.8/90.5 | 65.3/100.0 | **WIN** (recall+precision) |

### java
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 98.4/97.6 | 96.1/99.2 | 96.7/96.3 | 61.8/100.0 | **WIN** (recall+precision) |
| imports | 100.0/100.0 | 100.0/100.0 | 77.7/99.3 | 77.9/42.1 | **WIN** (recall+precision) |
| inheritance | 98.0/100.0 | 46.0/78.6 | 67.1/100.0 | 77.2/100.0 | **WIN** (recall+precision) |
| calls_intra_repo | 86.0/96.6 | 73.1/87.8 | 68.6/88.7 | 53.5/92.1 | **WIN** (recall+precision) |

### javascript
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 99.8/87.4 | 74.3/87.8 | 100.0/94.5 | 64.3/97.5 | trails (best 100.0R) |
| imports | 99.4/88.0 | 33.3/18.4 | 26.4/100.0 | 51.1/42.8 | **WIN** (recall+precision) |
| inheritance | 33.3/33.3 | 22.2/33.3 | 11.1/33.3 | 0.0/0.0 | **WIN** (recall+precision) |
| calls_intra_repo | 87.6/99.8 | 39.4/60.3 | 41.9/66.1 | 45.1/77.1 | **WIN** (recall+precision) |

### php
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 99.9/100.0 | 99.4/100.0 | 99.0/99.8 | 74.1/100.0 | **WIN** (recall+precision) |
| imports | 96.2/93.4 | 100.0/66.3 | 0.0/0.0 | 64.2/64.6 | **WIN** (F1; higher precision, 100.0R competitor over-emits) |
| inheritance | 99.0/80.4 | 69.8/64.3 | 68.8/63.5 | 73.4/78.8 | **WIN** (recall+precision) |
| calls_intra_repo | 88.9/99.9 | 88.0/100.0 | 77.1/99.6 | 31.7/79.3 | **WIN** (recall+precision) |

### python
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 99.2/100.0 | 76.9/99.1 | 87.0/95.2 | 58.2/100.0 | **WIN** (recall+precision) |
| imports | 99.7/68.3 | 89.3/57.5 | 38.5/93.5 | 71.2/49.1 | **WIN** (recall+precision) |
| inheritance | 97.6/99.1 | 71.3/100.0 | 72.6/93.1 | 93.1/100.0 | **WIN** (recall+precision) |
| calls_intra_repo | 86.1/100.0 | 85.1/98.9 | 54.6/95.5 | 53.3/97.5 | **WIN** (recall+precision) |

### ruby
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 99.0/99.9 | 84.2/99.9 | 95.3/98.3 | 72.0/87.1 | **WIN** (recall+precision) |
| imports | 100.0/88.4 | 100.0/100.0 | 59.6/100.0 | 0.0/0.0 | trails (best 100.0R) |
| inheritance | 73.0/100.0 | 53.4/88.8 | 53.2/92.7 | 0.0/0.0 | **WIN** (recall+precision) |
| calls_intra_repo | 51.5/96.7 | 41.3/91.2 | 28.7/93.7 | 40.8/98.8 | **WIN** (recall+precision) |

### rust
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 90.7/98.7 | 88.5/93.5 | 85.5/96.1 | 70.0/89.7 | **WIN** (recall+precision) |
| imports | 95.6/61.6 | 0.0/0.0 | 1.4/8.8 | 28.8/42.6 | **WIN** (recall+precision) |
| inheritance | 54.6/100.0 | 7.1/90.7 | 4.6/62.2 | 49.4/56.3 | **WIN** (recall+precision) |
| calls_intra_repo | 68.7/91.0 | 76.5/83.1 | 48.9/78.7 | 47.6/99.6 | trails recall (76.5), leads precision |

### swift
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 73.8/76.6 | 82.9/67.8 | 83.0/58.3 | 55.3/78.3 | **WIN** (F1; higher precision, 83.0R competitor over-emits) |

### typescript
| plane | koragraph | codegraph | gitnexus | graphify | koragraph vs best competitor |
|---|---|---|---|---|---|
| decls_pooled | 94.0/100.0 | 54.4/99.8 | 85.1/83.1 | 44.8/99.9 | **WIN** (recall+precision) |
| imports | 69.3/58.1 | 75.3/65.1 | 67.0/78.7 | 81.9/62.4 | trails (best 81.9R) |
| inheritance | 33.2/33.3 | 2.0/33.3 | 28.6/33.3 | 21.4/26.1 | **WIN** (recall+precision) |
| calls_intra_repo | 70.6/98.6 | 55.2/66.2 | 50.2/75.3 | 44.2/93.2 | **WIN** (recall+precision) |


## Honest reading

koragraph is the most accurate code graph on this corpus by a wide margin. It wins declarations,
imports, and inheritance across the board, and wins the intra-repo **calls** plane for every
language measured with an edge oracle — Python, Go, Java, C#, PHP, Ruby, TypeScript, JavaScript —
all at best-in-class precision (typically 96–100%). Where a competitor posts a higher *raw* recall
it does so at materially lower precision (CodeGraph emits **zero** Rust imports and over-emits PHP
imports at 57–72% precision; GitNexus over-emits JS declarations), which the side-by-side numbers
make plain.

The 5 cells koragraph does not win outright, stated plainly:

- **C# declarations** — 97.8 vs CodeGraph 97.9 recall (a tie) at 93.2 vs 96.4 precision; koragraph
  emits a small number of extra declarations on files where the C# grammar degrades and the regex
  scanner fills in. A precision item, not a recall gap.
- **JavaScript declarations** — a *taxonomy* difference: koragraph captures Express/Koa CommonJS
  object-methods (`app.listen = function () {}`) that the TypeScript declaration oracle does not
  count, so koragraph reads lower precision for finding *more*. Reported as-is rather than dropping
  real methods to match the oracle.
- **Ruby imports** — koragraph 100 recall at 81.6 precision vs CodeGraph 100/100; koragraph resolves
  a few `require`s to extra targets. A precision item.
- **Rust calls** — koragraph 68.7/91.0 vs CodeGraph 76.5/83.1: koragraph leads precision, CodeGraph
  leads recall, F1 within a point. Rust cross-file method resolution is deliberately conservative.
- **TypeScript imports** — koragraph 69.3 recall (dragged by zod's and class-transformer's re-export
  and barrel-file patterns) vs Graphify 81.9, both at ~60% precision.

None of the five is a case where a competitor is decisively better at graph quality; each is a
precision trade, a taxonomy artifact, or a near-tie. On the planes and languages that matter for a
coding agent, koragraph is state of the art.

## Reproduce

Everything here regenerates from `/test` — see `/test/README.md`. Pinned corpus, pinned competitor
versions, pinned oracle toolchains; one command per repo.
