'use strict';

// Single source of tier truth.
//
// This file is the ONE place resolution strings map to a numeric tier, a calibrated
// confidence, and a label — a same-file-verified call (0.95) and an alphabetical guess
// (0.25) must not collapse to the same label. schema.sql declares a plain
// `resolution_tier INTEGER`; there is no second copy of this map to keep in step.

// Per-tier confidence (1.00 -> 0.08), plus two zero-token post-resolution tiers:
// 10 = inheritance re-resolve (0.78), 11 = embedding disambiguation (0.82).
const TIER_CONFIDENCE = Object.freeze({
  1: 1.00,
  2: 0.95,
  3: 0.88,
  4: 0.72,
  5: 0.90,
  6: 0.85,
  7: 0.70,
  8: 0.25,
  9: 0.08,
  10: 0.78,
  11: 0.82,
});

// Live-emitted vocabulary mapped to the canonical tier, plus forward entries for
// resolution strings no writer emits yet — widen this map in the same commit that starts
// emitting one.
const RESOLUTION_TO_TIER = Object.freeze({
  // — canonical CALLS map —
  lsp: 2,
  same_file: 2,
  import: 3,
  resolved_fqn: 3,
  module_stem: 5,
  resolved_exact: 5,
  global_label: 7,
  // A global-label hit disambiguated among >1 raw candidates (non-test preference or
  // directory-distance tiebreak, symbol-index.js#disambiguateGlobalLabel) is a heuristic
  // pick, not proof — same band as the other >1-candidate fallbacks (global-label unique
  // -> 7 / tie-broken -> 8).
  global_label_tiebreak: 8,
  resolved_case_insensitive: 8,
  resolved_stem: 8,
  legacy_unretiered: 8,
  resolved_simple_name: 8,
  // An exact-name inheritance base resolved among the same-named parts of one partial type —
  // an exact match, but tie-broken across the parts, so it sits with the other >1-candidate picks.
  resolved_partial_type: 8,
  no_candidate: 9,
  // — forward entries: not emitted by any writer yet, so their first commit only has to
  // add the writer, not also widen this map. —
  this_receiver: 1,
  // runtime-trace/merge.js: a caller->callee CALLS edge that a test run actually EXECUTED, captured
  // by sys.setprofile. This is the strongest evidence a call edge can have — it is not a resolution
  // guess at all, it happened — so tier 1 (confidence 1.00), above every static resolution below it.
  runtime_observed: 1,
  receiver_import: 6,
  receiver_type_import: 3,
  receiver_type_global: 4,
  inheritance: 10,
  embedding: 11,
  // The structural null-writers below each get their own honest, named resolution string
  // instead of writing no `properties.resolution` at all. Tier picked to match the
  // writer's actual evidence quality, not copied from a similarly-named existing entry.
  //
  // resolveCrossRepoEdges (ingest.js): first-name-wins across OTHER branches of the same
  // project — no uniqueness check at all. Weakest of the named strings.
  cross_repo: 8,
  // writeMethodPropertyEdges (ingest.js, the entity/config pass): bare-name lookup of an
  // LLM-populated repos_called/tables_*/config_deps reference against the whole branch —
  // same evidence band as global_label.
  method_properties_lookup: 7,
  // writeSqlReferenceEdges: a parsed SQL/JPQL table/entity reference matched against a
  // known ENTITY/DB_TABLE name — a real parse, not a name guess, same band as
  // module_stem/resolved_exact.
  sql_reference: 5,
  // writeConfigValueRefEdges: an extracted config/env-var key matched
  // exactly against a CONFIG_VALUE node's name in the same branch.
  config_value_ref: 5,
  // config-infra-graph.js#resolveConfigInfraGraph: a docker-compose `depends_on`
  // (or an environment host reference) matched by name to another SERVICE node
  // in the same branch. Both service names are parsed straight out of the compose
  // file — a real structural fact, same band as config_value_ref/sql_reference
  // (tier 5), not import-proof same-file evidence.
  compose_depends_on: 5,
  // resolveCallExpressionEdges: a regex-derived call-expression callee name
  // that resolved to exactly one METHOD candidate (branch-wide or
  // class-qualified) — decent but not import-proven evidence.
  call_expression_unique: 5,
  // ...same source, but the callee name resolved to more than one candidate
  // even after class-context narrowing — a guess among plausible targets.
  call_expression_ambiguous: 8,
  // ...same source again, with MORE candidates than the traversable bound allows but still
  // inside the recoverable ceiling. Previously these produced NO edge at all, so a common
  // method name implemented across several classes lost its entire call structure silently.
  // Same heuristic band as ambiguous: recorded, and excluded from traversal.
  call_expression_high_fanout: 8,
  // A dotted call whose receiver named no type we know, resolved to the ONE declaration in the
  // branch with that member name. Tier 8 (AMBIGUOUS), the same band as the multi-candidate case
  // it differs from only in how many ways there were to be wrong. Recorded, not traversed.
  call_expression_bare_name: 8,
  // resolveHttpClientEdges: an HTTP client call site's verb/path (LLM-hinted or
  // text-scanned) matched against a known ENDPOINT node's "VERB /path" or path-only name.
  // Single-tier, not split by verb-vs-path-only match, since neither is
  // import/uniqueness-proven.
  http_client_match: 7,
  // resolveOverrideEdges: an EXTENDS-established child/parent CLASS pair
  // both define a METHOD with the identical name — a structural fact, not a
  // guess, same band as same_file/lsp.
  override_match: 2,
  // resolveEntityTableEdges: an ENTITY's real DB table name read directly
  // from a language-specific decorator/property (@Table, __tablename__, ...)
  // or the documented snake_case-plural fallback — deterministic, same band
  // as same_file/lsp.
  entity_table_mapping: 2,
  // git-coupling-analyzer.js#analyzeCoupling: COUPLED_WITH between two files that co-changed
  // in >=threshold real commits. The *measurement* (cochange_count) is exact — it's git
  // history, not a guess — but the *semantic implication* that co-change means code coupling
  // is inferred, same evidentiary band as
  // global_label/method_properties_lookup/http_client_match.
  git_cochange: 7,
  // post-resolution.js#linkCrossFileConstructs — a C# CLASS node whose
  // `properties.constructs` includes 'partial' shares its name with another such node in a
  // DIFFERENT file on the same branch. Same evidentiary band as
  // module_stem/resolved_exact/sql_reference/config_value_ref (tier 5, 0.90): a real
  // structural fact (identical name + the `partial` modifier, both parsed, not guessed),
  // just not as strong as same_file/lsp (tier 2) since it crosses files with no import
  // statement proving the link.
  partial_of: 5,
  // ingest.js#resolveImportFacts — an import fact whose module spec is not relative-shaped
  // (so it was never a candidate for a same-repo file) and didn't resolve via the
  // dotted-FQN-suffix or module-stem tiers either. We know FOR CERTAIN the file imports it
  // (the fact came straight off a real import statement) — we just don't control its
  // internals — so this is real import evidence, same band as 'import'/'resolved_fqn'
  // (tier 3), not a name-matching guess.
  dependency_external: 3,
  // ingest.js#resolveImportFacts: a RELATIVE import spec ('.compat', '..core.util') resolved
  // against the importing file's own package to a FILE node that exists in this branch. Same
  // evidence band as 'import'/'dependency_external' (tier 3) and, if anything, better supported:
  // the import statement is real AND the target file was verified present before the edge was
  // written. An unresolvable spec emits nothing.
  relative_module: 3,
  // ingest.js#resolveAndWriteEdges: an EXTENDS/IMPLEMENTS whose base type is not declared in
  // this branch, bound to a DEPENDENCY node minted for the external type. Emitted only when an
  // import in the same file binds the name, or the name is a language builtin base type --
  // the same evidence class as external_symbol (tier 3), never a name guess.
  external_base_type: 3,
  // ingest.js#resolveAndWriteEdges' last rung — a type/annotation name (`@Entity`,
  // `implements Serializable`) that no node in the branch defines, bound to the DEPENDENCY
  // node for the module the file's own import statement names. Same evidence as
  // dependency_external (tier 3): the import statement is real and parsed, we simply do not
  // own the symbol's internals. Refused outright when no import supports the name.
  external_symbol: 3,
  // template-graph.js#resolveTemplateEdges: a parsed `{% extends %}` /
  // `th:replace` / `th:href` directive whose target matched a real template or
  // ENDPOINT node by path. The directive is read straight out of the markup —
  // same evidence class as an import statement (tier 3), not a name guess.
  template_include: 3,
  // ...and a source string literal that exactly equals a template's logical
  // view name (`return "owners/findOwners";`). A real literal matched against a
  // real file path, but nothing in the language proves the string is a view —
  // same band as sql_reference/config_value_ref (tier 5).
  template_view_name: 5,
  // dependency-graph.js#resolveDeclaredDependencyEdges: an imported package
  // matched to the manifest entry that declares it, by the ecosystem's own
  // naming rule (npm specifier, PEP 503 name, Maven groupId prefix, Go module
  // prefix) and refused when two declared packages could both claim it. Two
  // parsed facts joined on a documented convention — same band as
  // sql_reference/config_value_ref (tier 5), not import-proof (tier 3), since
  // the convention is a convention and not a statement in the source.
  declared_dependency: 5,
  // rationale-graph.js#resolveRationaleNodes: a docstring or NOTE/HACK/WHY
  // comment bound to the declaration it sits on. Position in the file is the
  // evidence and it is exact — the language defines where a docstring goes —
  // so this is the same band as same_file/override_match (tier 2), not a name
  // guess. Rationale the parser cannot attribute gets a node and no edge.
  rationale_for: 2,
  // endpoint-graph.js#resolveEndpointHandlerEdges: an ENDPOINT matched to the
  // METHOD whose own route annotation declares that verb and path. Both sides
  // are parsed facts and the annotation IS the binding the framework uses at
  // runtime — same band as entity_table_mapping/override_match (tier 2). A
  // route two methods both claim is refused.
  endpoint_handler: 2,
  // endpoint-graph.js#resolveEndpointHandlerEdges, second strategy. Used only
  // where the first one cannot fire: frameworks that carry the route annotation
  // on a generated interface rather than the implementing class (the impl methods hold only
  // @Override/@PreAuthorize, so none bind by annotation). The handler name is read from the
  // ENDPOINT's own raw_evidence and matched to a METHOD in the SAME file. The
  // file scope and the name are exact, but the evidence string is LLM-written
  // rather than parsed, so this sits a band below endpoint_handler — INFERRED,
  // not EXTRACTED. A name that matches two methods in the file is refused.
  endpoint_handler_evidence: 4,
  // plane-join.js#resolveSemanticPlaneJoins: the SAME symbol minted twice —
  // once by the structural/AST plane (CLASS/METHOD) and once by the LLM plane
  // as a role (SERVICE/REPOSITORY/ANGULAR_SERVICE/...). Because callers bind to the
  // structural node while the role node owns the semantic edges, each such pair is a break
  // in the graph. The join predicate is exact equality on
  // (repository_branch_id, file_id, name) — same band as same_file (tier 2) —
  // and any name matching more than one node on either side is refused.
  plane_join: 2,
});

// tier -> label ("tier>=8 or unresolved-external -> AMBIGUOUS; 1,2,5,6 -> EXTRACTED; else
// INFERRED"), EXCEPT tiers 10/11 are numerically >=8 but are NOT ambiguous — they are the
// post-resolution upgrade tiers and belong in INFERRED. So the ladder here is an explicit
// per-tier set, not a `tier >= 8` shortcut.
const EXTRACTED_TIERS = new Set([1, 2, 5, 6]);
const INFERRED_TIERS = new Set([3, 4, 7, 10, 11]);
const AMBIGUOUS_TIERS = new Set([8, 9]);

// LLM-plane edges keep their existing labels untouched — the ladder governs structural
// edges only. This file has no opinion on LLM-plane writers; callers that own LLM-plane
// edges must not route through here.
function labelForTier(tier, isUnresolvedExternal = false) {
  if (isUnresolvedExternal) return 'AMBIGUOUS';
  if (AMBIGUOUS_TIERS.has(tier)) return 'AMBIGUOUS';
  if (EXTRACTED_TIERS.has(tier)) return 'EXTRACTED';
  if (INFERRED_TIERS.has(tier)) return 'INFERRED';
  throw new Error(`labelForTier: tier ${tier} has no label mapping — add it to tiers.js's EXTRACTED/INFERRED/AMBIGUOUS sets deliberately, do not guess`);
}

// Tier honesty: a resolution string with no entry here is refused, not defaulted. Silent
// drift on an unmapped string is exactly how the binary split this file replaces collapsed
// eleven qualities into one.
function tierForResolution(resolution) {
  const tier = RESOLUTION_TO_TIER[resolution];
  if (tier === undefined) {
    throw new Error(`tierForResolution: unmapped resolution "${resolution}" — add it to RESOLUTION_TO_TIER (and, if it applies to CALLS, migration 185's CASE arms) before emitting it`);
  }
  return tier;
}

// Thin delegate: resolution string -> { tier, confidence, label }. resolve.js re-exports
// this unchanged so existing callers of
// require('./resolution/resolve').deriveConfidenceTier keep working; read `.label` for the
// confidence_tier column, or `.tier`/`.confidence` for resolution_tier/confidence.
function deriveConfidenceTier(resolution, opts = {}) {
  const tier = tierForResolution(resolution);
  const confidence = TIER_CONFIDENCE[tier];
  const label = labelForTier(tier, opts.isUnresolvedExternal);
  return { tier, confidence, label };
}

// A CALLS edge whose tier lands in AMBIGUOUS_TIERS (8/9) is heuristic-grade — traversal
// must be able to structurally exclude it, which is what the separate HEURISTIC_CALLS
// edge_type is for. Non-CALLS edge types (DEFINED_IN/EXTENDS/IMPLEMENTS/IMPORTS/...) keep
// their own type at every tier — the split is CALLS-only — and only ever record
// tier/confidence, never retype.
function isHeuristicTier(tier) {
  return AMBIGUOUS_TIERS.has(tier);
}

// Single call every ingest.js edge writer routes through to get the tier
// triple AND the edge_type it must actually persist under. Centralising this
// (rather than re-deriving `isHeuristicTier(tier) && edgeType === 'CALLS'` at
// every one of the dozen write sites) is what keeps the CALLS-only split
// provably consistent: there is one function to reason about, not thirteen call sites.
function edgeWriteTier(resolution, edgeType, opts = {}) {
  const { tier, confidence, label } = deriveConfidenceTier(resolution, opts);
  const writeEdgeType = (edgeType === 'CALLS' && isHeuristicTier(tier)) ? 'HEURISTIC_CALLS' : edgeType;
  return { tier, confidence, label, edgeType: writeEdgeType };
}

module.exports = {
  TIER_CONFIDENCE,
  RESOLUTION_TO_TIER,
  AMBIGUOUS_TIERS,
  EXTRACTED_TIERS,
  INFERRED_TIERS,
  labelForTier,
  tierForResolution,
  deriveConfidenceTier,
  isHeuristicTier,
  edgeWriteTier,
};
