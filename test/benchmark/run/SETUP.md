# Toolchain & competitor setup (pinned, all local, no API)

## Competitors
```bash
# CodeGraph 1.6.0 (npm, native binary)
npm i @colbymchenry/codegraph@1.6.0
# GitNexus 1.6.10 (npm)  — CLI: node node_modules/gitnexus/dist/cli/index.js
npm i gitnexus@1.6.10
# Graphify 0.9.51 (pip, in a venv)
python3 -m venv .venv-graphify && .venv-graphify/bin/pip install graphifyy==0.9.51
```
Point the runners at them via CODEGRAPH_BIN / a `gitnexus` wrapper (exec node .../dist/cli/index.js) /
the graphify venv. Set CODEGRAPH_TELEMETRY=0 and PYTHONHASHSEED=0.

## Oracle toolchains
- Python: system `python3` (CPython ast). Go: Go toolchain (referees build on first run).
- C/C++: Universal Ctags 6.x (`brew install universal-ctags`). Swift: `swiftc` (Xcode).
- TypeScript/JS: `cd scripts/tsc-referee && npm i` (typescript 5.6.3).
- Ruby: Ruby 3.4 (Ripper/AST). PHP: PHP 8 + ext-ast (`pecl install ast`). C#: .NET 10 (build csharp-referee).
- Rust: `cargo build --release` in scripts/rust-referee (syn).

## koragraph
Ingest each repo with `LLM_EXTRACTION=off` into an isolated `KORAGRAPH_DB`. No network, no API.
