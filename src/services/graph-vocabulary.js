'use strict';

// Single source of truth for the edge-type vocabulary. `extractors/base.js`
// (emit-time contract, EDGE_TYPES) and `graph-expansion-policy.js`
// (traversal-time policy) each used to define their own set with no shared
// source, so the two could silently drift — extractors emit IMPORTS, which
// isn't traversable. This module is dependency-free by design: both consumers
// require() it, nothing here requires anything, so no cycle is possible.

// EMITTABLE_EDGE_TYPES: every edge_type a structural writer (an extractor via
// extractors/base.js#validateEdge, or ingest.js's DEPENDS_ON pushes) is
// allowed to write. This is the CLOSED set extractors/base.js validates
// against — a novel type here is an edge no extractor may emit. It is NOT the
// same direction as TRAVERSAL_EDGE_TYPES: IMPORTS and INSTANTIATES are
// deliberately emittable but never traversed (the drift test asserts the
// correct direction).
const EMITTABLE_EDGE_TYPES = Object.freeze(new Set([
  'IMPORTS', 'CALLS', 'DEFINED_IN', 'EXTENDS', 'IMPLEMENTS',
  'COUPLED_WITH', 'READS_TABLE', 'WRITES_TABLE',
  // DEPENDS_ON is ast-extractor.js's existing emission, recognized here
  // instead of bypassing validation.
  'HEURISTIC_CALLS', 'DECORATED_BY', 'EMBEDS', 'METACLASS',
  'PARTIAL_OF', 'REFERENCES', 'INSTANTIATES', 'DEPENDS_ON',
  // RE_EXPORTS: typescript.js's `export {x} from './y'` facts, resolved
  // FILE-to-FILE by ingest.js#resolveReExportEdges — same "dedicated
  // post-write resolver, not extractors/base.js#addEdge directly" shape as
  // DECORATED_BY/METACLASS/PARTIAL_OF above.
  'RE_EXPORTS',
  // ingest.js#resolveImportFacts's symbol-grain hit (`from pkg.mod import
  // Symbol` resolved down to the Symbol's own CLASS/METHOD node) used to
  // share IMPORTS with the module-level edge (FILE/DEPENDENCY target), so a
  // benchmark or traversal reading IMPORTS as "file imports module" got the
  // symbol's own name instead of the module's — a false positive against any
  // (file, module) truth. IMPORTS_SYMBOL is that same fact at symbol grain;
  // IMPORTS now means only "this file imports this module/file".
  'IMPORTS_SYMBOL',
]));

// TRAVERSAL_EDGE_TYPES: the edge types `retrieveSubgraph` follows by
// default (graph-retriever.js, graph-communities.js). Order is preserved
// (not just membership) because graph-retriever.js interpolates this list
// into a recursive-CTE `IN (...)` clause.
const TRAVERSAL_EDGE_TYPES = Object.freeze([
  'CALLS', 'DEPENDS_ON',
  'READS_TABLE', 'WRITES_TABLE', 'USES_CONFIG',
  'DEFINED_IN', 'EXTENDS', 'IMPLEMENTS', 'OVERRIDES',
  'COUPLED_WITH', 'BELONGS_TO',
  'CONTAINS', 'MAPS_TO', 'TESTS',
  'REFERENCES',
  // DECORATED_BY edges (tier 2/3 only — ingest.js#resolveDecoratedByEdges)
  // are structural fact, not a guess, so they traverse by default, same as
  // EXTENDS/IMPLEMENTS.
  'DECORATED_BY',
  // EMBEDS is the same-file structural retarget of Go's anonymous-field
  // embedding (go.js's discriminator) — same-file evidence, so
  // it traverses by default for parity with EXTENDS/COUPLED_WITH; not adding
  // it here would silently drop Go struct embedding from default retrieval
  // traversal.
  'EMBEDS',
]);

// NON_EXTRACTOR_EDGE_TYPES: the TRAVERSAL_EDGE_TYPES members no extractor
// emits (not in EMITTABLE_EDGE_TYPES) because a post-write resolver writes
// them instead. Named here so the drift test can assert TRAVERSAL is fully
// accounted for without falsely claiming these are extractor output.
// Every entry has a writer, and an entry that loses its writer belongs out of
// TRAVERSAL, not in this list: USES_CONFIG — ingest.js#resolveConfigValueRefs,
// template-graph.js; OVERRIDES — ingest.js override-resolution pass; BELONGS_TO
// — dependency-graph.js; CONTAINS — ingest.js FILE/directory containment,
// semantic-typing.js, sql-file-graph.js; MAPS_TO — ingest.js entity-table
// mapping, endpoint-graph.js; TESTS — semantic-typing.js.
//
// Six further types (AUTH_PROTECTED_BY, HAS_PROC, LOADS_CHILD_ROUTES, PRODUCES,
// CONSUMES, IMPORTS_API) were removed: they had no writer in this tree, and
// their stated writers were files that were never extracted into it — yet every
// one was still interpolated into the recursive-CTE `IN (...)` on every
// retrieval.
const NON_EXTRACTOR_EDGE_TYPES = Object.freeze(new Set([
  'USES_CONFIG', 'OVERRIDES', 'BELONGS_TO',
  'CONTAINS', 'MAPS_TO', 'TESTS',
]));

// HEURISTIC_EDGE_TYPES: CALLS-split edge types deliberately excluded from
// default traversal — graph-tool-service.js's include_heuristic flag is the
// only opt-in path.
const HEURISTIC_EDGE_TYPES = Object.freeze(new Set(['HEURISTIC_CALLS']));

module.exports = {
  EMITTABLE_EDGE_TYPES,
  TRAVERSAL_EDGE_TYPES,
  NON_EXTRACTOR_EDGE_TYPES,
  HEURISTIC_EDGE_TYPES,
};
