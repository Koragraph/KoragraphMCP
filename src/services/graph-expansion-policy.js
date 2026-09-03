'use strict';

// Every edge_type and node_type string in this file is interpolated unquoted
// into SQL — graph-retriever.js builds the recursive CTE's `IN (...)` clause
// straight from TRAVERSAL_EDGE_TYPES. Any new entry must satisfy
// `^[A-Za-z_]\w*$`: no spaces, no punctuation, no quotes.
const REPO_RESOLVE_THRESHOLD = parseFloat(process.env.REPO_RESOLVE_THRESHOLD || '0.35');
const REPO_RESOLVE_FALLBACK = parseFloat(process.env.REPO_RESOLVE_FALLBACK || '0.80');
const REPO_RESOLVE_MAX = parseInt(process.env.REPO_RESOLVE_MAX || '3', 10);

const CROSS_REPO_INTENTS = new Set(['trace', 'impact', 'architecture', 'compare']);

// Sourced from graph-vocabulary.js (the single source shared with
// extractors/base.js#EDGE_TYPES) so traversal policy and the emit-time
// contract cannot silently drift apart again.
const { TRAVERSAL_EDGE_TYPES } = require('./graph-vocabulary');

const FANOUT_EDGE_TYPES = new Set([
  'CALLS', 'DEPENDS_ON', 'REFERENCES', 'MAPS_TO',
]);

// A CALLS edge whose resolution lands at tier >=8 is written as
// HEURISTIC_CALLS, not CALLS (resolution/tiers.js#edgeWriteTier) — a distinct
// edge_type so traversal can structurally exclude guesses. It is deliberately
// NOT in TRAVERSAL_EDGE_TYPES; this set exists so callers that explicitly opt
// in (graph-tool-service.js's include_heuristic flag) know exactly which
// type(s) that means, in one place.
const { HEURISTIC_EDGE_TYPES } = require('./graph-vocabulary');

const ENDPOINT_ONTOLOGY_TYPES = new Set(['ENDPOINT']);

const SERVICE_ONTOLOGY_TYPES = new Set([
  'NODE_SERVICE', 'NODE_CONTROLLER', 'SERVICE', 'CONTROLLER',
  'REACT_SERVICE', 'HANDLER', 'REPOSITORY',
]);

const DB_ONTOLOGY_TYPES = new Set(['DB_TABLE', 'STORED_PROC', 'DATABASE', 'ENTITY']);

const PULL_THROUGH_RULES = [
  { fromTypes: SERVICE_ONTOLOGY_TYPES, edgeTypes: ['READS_TABLE', 'WRITES_TABLE'], toTypes: DB_ONTOLOGY_TYPES },
  { fromTypes: ENDPOINT_ONTOLOGY_TYPES, edgeTypes: ['CALLS', 'DEPENDS_ON', 'REFERENCES'], toTypes: SERVICE_ONTOLOGY_TYPES },
  { fromTypes: SERVICE_ONTOLOGY_TYPES, edgeTypes: ['CALLS', 'DEPENDS_ON'], toTypes: SERVICE_ONTOLOGY_TYPES },
];

const HOP_LIMIT_BY_INTENT = Object.freeze({
  lookup: 1,
  trace: 2,
  impact: 2,
  architecture: 2,
  compare: 2,
  default: 2,
});

// Read once here and exported: graph-retriever.js used to parse the same variable a second
// time, so a typo in either default silently gave the cap and the rejection report that
// explains it two different values.
const ENDPOINT_CAP = parseInt(process.env.SUBGRAPH_ENDPOINT_CAP || '8', 10);

function resolveExpansionHopLimit(intent, explicitLimit) {
  if (explicitLimit != null) {
    const parsed = Number.parseInt(explicitLimit, 10);
    if (Number.isFinite(parsed)) return Math.max(parsed, 0);
  }
  return HOP_LIMIT_BY_INTENT[intent] ?? HOP_LIMIT_BY_INTENT.default;
}

function selectReposForQuery(allScored, { intent, edgeConnectedRepoIds = [] } = {}) {
  const scored = allScored || [];
  if (!scored.length) {
    return { selectedRepoIds: [], omitted: [], edgePromoted: [] };
  }

  const top = scored[0];
  if (!top || top.score < REPO_RESOLVE_THRESHOLD) {
    return {
      selectedRepoIds: [],
      omitted: scored.map((r) => ({
        repo_id: r.repoId,
        name: r.name,
        score: r.score,
        omit_reason: 'below_threshold',
      })),
      edgePromoted: [],
    };
  }

  const selected = new Set([top.repoId]);
  for (let i = 1; i < scored.length && selected.size < REPO_RESOLVE_MAX; i++) {
    if (scored[i].score >= top.score * REPO_RESOLVE_FALLBACK) {
      selected.add(scored[i].repoId);
    }
  }

  const edgePromoted = [];
  if (CROSS_REPO_INTENTS.has(intent)) {
    for (const repoId of edgeConnectedRepoIds) {
      if (!selected.has(repoId) && scored.some((r) => r.repoId === repoId)) {
        selected.add(repoId);
        edgePromoted.push(repoId);
      }
    }
  }

  const selectedRepoIds = [...selected];
  const omitted = scored
    .filter((r) => !selected.has(r.repoId))
    .map((r) => ({
      repo_id: r.repoId,
      name: r.name,
      score: r.score,
      omit_reason: r.score < REPO_RESOLVE_THRESHOLD ? 'below_threshold' : 'below_fallback_ratio',
    }));

  return { selectedRepoIds, omitted, edgePromoted };
}

function planRepoFanout({
  allScored,
  seeds,
  intent,
  crossRepoTargets = [],
  semanticSelectedRepoIds = [],
}) {
  if (!allScored?.length || allScored.length <= 1) {
    return { fanoutRepoIds: [], fanoutReason: 'single_repo', promotedRepos: [] };
  }

  const searched = new Set(semanticSelectedRepoIds);
  const promoted = [];

  if (CROSS_REPO_INTENTS.has(intent) && crossRepoTargets.length) {
    for (const target of crossRepoTargets) {
      const repoId = target.repository_id ?? target.repoId;
      if (repoId != null && !searched.has(repoId)) {
        promoted.push({
          repo_id: repoId,
          repo_name: target.repo_name ?? target.name,
          node_id: target.id,
          edge_type: target.edge_type || 'cross_repo_reference',
          promote_reason: 'exact_api_or_reference_edge',
        });
        searched.add(repoId);
      }
    }
  }

  const fanoutRepoIds = [...new Set(promoted.map((p) => p.repo_id))];
  return {
    fanoutRepoIds,
    fanoutReason: promoted.length ? 'edge_connected_repo' : 'semantic_only',
    promotedRepos: promoted,
  };
}

// Per-source-node fan-out cap, applied per edge type.
//
// SUBGRAPH_MAX_NODES defaults to 25, but a single FILE node's CONTAINS fan-out measures p95 52
// nodes/file (max 2000) — one seed's containment edges can dwarf the whole subgraph budget before
// the unranked SQL pull even reaches JS-side ranking and truncation. CONTAINS was capped from the
// start for that reason.
//
// USES_CONFIG needs the same treatment: `configByKeyLower` matches ALL config nodes sharing a key,
// so one `_("Content")` reference emits one edge per locale catalogue. A single such node can fill
// the entire expansion budget with translation duplicates of one string BEFORE ranking ever runs,
// crowding out the CALLS/EXTENDS structure the graph arms exist to traverse.
//
// The multi-locale reachability itself is intended, so this caps the fan-out rather than removing
// it. Ordering is preserved, so the first N survive.
const FANOUT_CAPPED_EDGE_TYPES = Object.freeze(['CONTAINS', 'USES_CONFIG']);

function capFileFanout(edges, limit, cappedTypes = FANOUT_CAPPED_EDGE_TYPES) {
  if (!Array.isArray(edges) || !Number.isFinite(limit) || limit <= 0) return edges;
  const seenPerSource = new Map();
  const kept = [];
  for (const edge of edges) {
    if (!cappedTypes.includes(edge.edge_type)) {
      kept.push(edge);
      continue;
    }
    // Keyed by (source, type) so a node with both CONTAINS and USES_CONFIG gets a budget for
    // each rather than one shared allowance decided by whichever came first.
    const key = `${edge.from_node_id}\u0000${edge.edge_type}`;
    const count = seenPerSource.get(key) || 0;
    if (count < limit) {
      kept.push(edge);
      seenPerSource.set(key, count + 1);
    }
  }
  return kept;
}

function matchesPullThroughRule(fromType, edgeType, toType) {
  for (const rule of PULL_THROUGH_RULES) {
    if (!rule.fromTypes.has(fromType)) continue;
    if (!rule.edgeTypes.includes(edgeType)) continue;
    if (rule.toTypes.has(toType)) return true;
  }
  return false;
}

function shouldPullThroughEdge(fromNode, toNode, edgeType) {
  return matchesPullThroughRule(fromNode.node_type, edgeType, toNode.node_type);
}

function computeExpansionTruncation({
  rawNodeCount = 0,
  afterDedupCount = 0,
  maxNodes = 0,
  endpointCapDropped = 0,
  generationFiltered = 0,
  typeFiltered = 0,
}) {
  const limitDropped = maxNodes > 0 && rawNodeCount > maxNodes
    ? rawNodeCount - Math.min(rawNodeCount, maxNodes)
    : 0;

  return {
    raw_node_count: rawNodeCount,
    retained_node_count: afterDedupCount,
    truncated_by_node_limit: limitDropped,
    truncated_by_endpoint_cap: endpointCapDropped,
    truncated_by_generation_filter: generationFiltered,
    truncated_by_type_filter: typeFiltered,
    total_truncated: limitDropped + endpointCapDropped + generationFiltered + typeFiltered,
  };
}

function buildExpansionRejectionReport({
  rawNodes = [],
  retainedNodes = [],
  maxNodes,
  endpointCap = ENDPOINT_CAP,
}) {
  const retainedKeys = new Set(retainedNodes.map((n) => `${n.name}||${n.file_path || ''}`));
  const rejected = [];
  let endpointCount = 0;
  let endpointCapDropped = 0;

  for (const n of rawNodes) {
    if (ENDPOINT_ONTOLOGY_TYPES.has(n.node_type)) {
      if (endpointCount >= endpointCap) {
        endpointCapDropped += 1;
        rejected.push({
          node_id: n.id,
          name: n.name,
          node_type: n.node_type,
          reject_reason: 'endpoint_cap',
        });
        continue;
      }
      endpointCount += 1;
    }

    const key = `${n.name}||${n.file_path || ''}`;
    if (!retainedKeys.has(key)) {
      rejected.push({
        node_id: n.id,
        name: n.name,
        node_type: n.node_type,
        reject_reason: retainedKeys.size >= maxNodes ? 'node_limit' : 'deduplicated',
      });
    }
  }

  return {
    rejected_candidates: rejected,
    truncation: computeExpansionTruncation({
      rawNodeCount: rawNodes.length,
      afterDedupCount: retainedNodes.length,
      maxNodes,
      endpointCapDropped,
    }),
  };
}

function buildRetrievalTraceExtras({
  rejectedCandidates = [],
  truncation = null,
  edgePromotedRepos = [],
  fanoutPromotedRepos = [],
}) {
  return {
    rejected_candidates: rejectedCandidates,
    truncation,
    edge_promoted_repos: edgePromotedRepos,
    fanout_promoted_repos: fanoutPromotedRepos,
  };
}

module.exports = {
  ENDPOINT_CAP,
  REPO_RESOLVE_THRESHOLD,
  REPO_RESOLVE_FALLBACK,
  REPO_RESOLVE_MAX,
  TRAVERSAL_EDGE_TYPES,
  FANOUT_EDGE_TYPES,
  HEURISTIC_EDGE_TYPES,
  ENDPOINT_ONTOLOGY_TYPES,
  SERVICE_ONTOLOGY_TYPES,
  DB_ONTOLOGY_TYPES,
  PULL_THROUGH_RULES,
  CROSS_REPO_INTENTS,
  resolveExpansionHopLimit,
  selectReposForQuery,
  planRepoFanout,
  shouldPullThroughEdge,
  capFileFanout,
  FANOUT_CAPPED_EDGE_TYPES,
  computeExpansionTruncation,
  buildExpansionRejectionReport,
  buildRetrievalTraceExtras,
};
