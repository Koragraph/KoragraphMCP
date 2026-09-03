# Contributing to koragraph

## Dev setup

```bash
npm install
node bin/koragraph.js <command>      # exercise the CLI from the checkout
node bin/koragraph.js doctor         # end-to-end install check
```

Node `>=22` is required. There is nothing else to stand up: the graph store creates itself on
first open, and there is no LLM, embedding server, or external service in the loop.

## Code standards

- **Layering:** Controller → Service → (Facade/Client → External API | Repository → Database).
- No comments unless the WHY is non-obvious (a hidden constraint, a gotcha, a workaround).
- No docstrings or multi-line comment blocks.
- No speculative abstraction beyond the task.
- Reuse existing patterns; do not introduce a second way to do something that already exists.
- Never break a measured number without re-measuring and recording the new one.

## Adding a language extractor

Grammar-backed languages live in `src/services/extractors/**`, one module per language, built on
`src/services/extractors/base.js`. Use an existing module (`bash.js`, `go.js`, `ruby.js`) as the
template.

A module exports:

- `CONFIG` — a `LanguageConfig` (from `base.js`) describing the grammar's node types for
  declarations, calls, imports, and inheritance.
- `extract(tree, content, filePath)` — returns `{ nodes, edges }` for an already-parsed tree.
- `extractFile(filePath, content)` — parses and calls `extract`.
- `ready()` — reports whether the grammar loaded.

`base.js` provides node/edge validation, same-file duplicate merging, id construction, and grammar
loading (`loadGrammar`). Emit declaration nodes and structural edges; the confidence-tiered
resolver in `src/services/resolution/**` binds cross-file references afterward.

Wire the extension → grammar mapping so ingest routes the file to your module, and verify against a
real file. A grammar can load successfully yet fail to parse at runtime, so check an actual parse,
not just that the grammar loaded — and prove a new guard fails on broken input before trusting it.
