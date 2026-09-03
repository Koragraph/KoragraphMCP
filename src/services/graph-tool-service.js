'use strict';

const pool = require('../db/pool');
const { retrieveSubgraph } = require('./graph-retriever');
const { HEURISTIC_EDGE_TYPES } = require('./graph-expansion-policy');
const { personalizedPageRank } = require('./graph-ppr');

function cited(nodes, edges, extra = {}) {
  return {
    nodes,
    edges,
    meta: { node_count: nodes.length, edge_count: edges.length, ...extra },
  };
}

async function orgBranchIds(orgId, requestedBranchIds = null, projectId = null) {
  const params = [orgId];
  let sql = `
    SELECT rb.id
    FROM repository_branches rb
    JOIN repositories r ON r.id = rb.repository_id
    JOIN projects p ON p.id = r.project_id
    WHERE p.org_id = $1 AND rb.is_tracked = true
  `;
  if (requestedBranchIds && requestedBranchIds.length > 0) {
    params.push(requestedBranchIds);
    sql += ` AND rb.id IN (SELECT value FROM json_each($${params.length}))`;
  }
  // The scope has to be applied where the branch set is chosen, because that is the only thing
  // retrieval is given — otherwise a scoped query silently answers from every project.
  if (projectId != null) {
    params.push(projectId);
    sql += ` AND p.id = $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => r.id);
}

// `if (project_id)` treated 0 as "unscoped" — an id the schema can hold. Absent is the only thing
// that means unscoped.
function parseProjectId(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw serviceError(400, 'Invalid project_id');
  return parsed;
}

// A bare identifier is an identity question, not a ranking question. searchGraphForOrg's pool is
// built by ranked retrieval, so a name that loses the contest for its own pool would be reported
// as absent — the retrieval channels answer relevance, and nothing else answers identity. Only
// whole-string identifier matches are injected here, so a prose query is untouched.
//
// The leading SIGIL matters too, and was missing. A JS private field is `#lookup`, and the name the
// extractor stores carries the `#` — so an identity question about one never qualified for the
// exact lookup and fell back to the ranked pool, which is exactly where a short name loses to its
// own prefix family. Measured on a two-repo graph (express + got): 50 of 1,100 declaration names
// failed this test and 44 of them were `#`-prefixed methods, so `neighbours` answered
// `No symbol named "#lookup"` for three of twenty probes while all three were in the graph —
// #lookup behind #lookupAndCallback, #query behind #queryFamilies, #deleteExpiredCacheEntry behind
// #deleteExpiredCacheEntries.
//
// `@`/`@@` are Ruby's instance and class variables, included on the same reasoning; this graph had
// no Ruby in it, so that half is by construction rather than by measurement. Widening is safe in
// one direction only: exactIds are UNION-merged ahead of the ranked pool and the sort is stable, so
// this can add an identity answer and can never remove or reorder a relevance one. A prose query
// still fails the whole-string test and is untouched.
const IDENTIFIER_QUERY = /^(?:#|@{1,2})?[A-Za-z_$][A-Za-z0-9_$]*$/;
const EXACT_NAME_CAP = 100;

async function exactNameNodeIds(_pool, branchIds, name) {
  const { rows } = await _pool.query(
    `SELECT n.id
     FROM nodes n
     WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
       AND n.approval_status != 'ARCHIVED'
       AND lower(n.name) = lower($2)
     ORDER BY n.id ASC
     LIMIT $3`,
    [branchIds, name, EXACT_NAME_CAP],
  );
  return rows.map((r) => r.id);
}

// The ICP store holds exactly one project, and requiring an explicit scope there asks the caller
// for a number it has no way to learn from any tool on this surface. One project is not an
// ambiguity; two or more is, and still refuses.
async function soleProjectIdForOrg(orgId, deps = {}) {
  const _pool = deps.pool || pool;
  const { rows } = await _pool.query(
    `SELECT id FROM projects WHERE org_id = $1 AND is_archived = 0 ORDER BY id ASC LIMIT 2`,
    [orgId],
  );
  return rows.length === 1 ? rows[0].id : null;
}

// The only project identifier an agent ever sees is the NAME overview prints — never the integer
// id. So the scope argument has to accept that name. A project name is the scope directly; a
// repository name (the common case: "express", "ledgersvc") resolves to the project that holds it.
async function projectIdByName(orgId, name, deps = {}) {
  const _pool = deps.pool || pool;
  const key = String(name || '').trim();
  if (!key) return null;
  const { rows } = await _pool.query(
    `SELECT p.id AS id FROM projects p
       WHERE p.org_id = $1 AND p.is_archived = 0 AND p.name = $2
     UNION
     SELECT r.project_id AS id FROM repositories r
       JOIN projects p2 ON p2.id = r.project_id
       WHERE p2.org_id = $1 AND r.name = $2
     LIMIT 2`,
    [orgId, key],
  );
  return rows.length ? rows[0].id : null;
}

// True per-repo scope: the tracked branch ids of a repository named `name`. project scope groups
// every repo in a workspace; this narrows to one, which is what "search only in the auth repo"
// needs. Returns [] when the name is not a repository (the caller then tries project resolution).
async function branchIdsByRepoName(orgId, name, deps = {}) {
  const _pool = deps.pool || pool;
  const key = String(name || '').trim();
  if (!key) return [];
  const { rows } = await _pool.query(
    `SELECT rb.id AS id FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id
       JOIN projects p ON p.id = r.project_id
      WHERE p.org_id = $1 AND r.name = $2 AND rb.is_tracked = true`,
    [orgId, key],
  );
  return rows.map((r) => r.id);
}

// branchIds is the delivery-side half of the project scope: the retriever is already given the
// scoped branch set, but a scope that only constrains the retriever is a scope that any future
// caller can walk around. Omitted means unscoped, which is every other caller here.
async function fetchNodes(nodeIds, orgId, branchIds = null) {
  if (!nodeIds || nodeIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT n.id, n.name, n.node_type, n.confidence_tier, n.confidence,
            n.summary, n.canonical_key, n.properties,
            n.start_line, n.end_line,
            f.path AS file_path,
            f.summary AS file_summary,
            f.summary_source AS file_summary_status
     FROM nodes n
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     JOIN projects p ON p.id = r.project_id
     LEFT JOIN files f ON f.id = n.file_id
     WHERE n.id IN (SELECT value FROM json_each($1)) AND p.org_id = $2 AND n.approval_status != 'ARCHIVED'
       AND ($3 IS NULL OR n.repository_branch_id IN (SELECT value FROM json_each($3)))`,
    [nodeIds, orgId, branchIds && branchIds.length ? branchIds : null],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    node_type: r.node_type,
    confidence_tier: r.confidence_tier,
    confidence: parseFloat(r.confidence),
    summary: r.summary || null,
    canonical_key: r.canonical_key || null,
    properties: r.properties || {},
    start_line: r.start_line ?? null,
    end_line: r.end_line ?? null,
    file: r.file_path ? { path: r.file_path } : null,
    file_summary: r.file_summary || null,
    file_summary_status: r.file_summary_status || null,
  }));
}

async function fetchEdgesBetween(nodeIds, excludeEdgeTypes = []) {
  if (!nodeIds || nodeIds.length < 2) return [];
  const { rows } = await pool.query(
    `SELECT id, from_node_id, to_node_id, edge_type, is_cross_repo
     FROM edges
     WHERE from_node_id IN (SELECT value FROM json_each($1)) AND to_node_id IN (SELECT value FROM json_each($1))
       AND ($2 IS NULL OR edge_type NOT IN (SELECT value FROM json_each($2)))`,
    [nodeIds, excludeEdgeTypes.length ? excludeEdgeTypes : null],
  );
  return rows.map((r) => ({
    id: r.id,
    from_node_id: r.from_node_id,
    to_node_id: r.to_node_id,
    edge_type: r.edge_type,
    is_cross_repo: r.is_cross_repo,
  }));
}

function serviceError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const DEFAULT_FILE_NODES_LIMIT = 100;
const MAX_FILE_NODES_LIMIT = 500;

const DEFAULT_DEAD_CODE_LIMIT = 50;
const MAX_DEAD_CODE_LIMIT = 500;

// CGC's find_most_complex_functions
// (code_finder.py:1378-1390) defaults limit to 10.
const DEFAULT_COMPLEXITY_LIMIT = 10;
const MAX_COMPLEXITY_LIMIT = 500;

// CGC's find_dead_code has an
// exclude_decorated_with argument but ships no default set (CLI-interactive
// tool). Ours is org-facing, so a bare `route`/`app.`/`@Test`/`@Scheduled`
// intersection is excluded by default — a caller-supplied list replaces
// (does not merge with) this default, mirroring CGC's own arg semantics.
const DEFAULT_DEAD_CODE_DECORATOR_EXCLUSIONS = Object.freeze(['route', 'app.', '@Test', '@Scheduled']);

// Callers historically passed a bare node id (number). Keep that working while
// letting new callers pass { node_id, edge_types, include_imports, include_heuristic }.
function normalizeNodeArgs(args) {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return {
      nodeId: args.node_id,
      edgeTypes: Array.isArray(args.edge_types) && args.edge_types.length ? args.edge_types : null,
      includeImports: args.include_imports === true,
      // HEURISTIC_CALLS is
      // excluded by default — a caller must opt in explicitly to see
      // guess-grade edges mixed into callers/callees.
      includeHeuristic: args.include_heuristic === true,
    };
  }
  return { nodeId: args, edgeTypes: null, includeImports: false, includeHeuristic: false };
}

async function searchGraphForOrg(orgId, args, deps = {}) {
  const t0 = Date.now();
  const { query, project_id, branch_ids, limit = 30 } = args;
  const _retrieveSubgraph = deps.retrieveSubgraph || retrieveSubgraph;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw serviceError(400, '"query" is required and must be a non-empty string');
  }

  const projectId = parseProjectId(project_id);
  const resolvedBranchIds = await orgBranchIds(orgId, branch_ids, projectId);
  if (resolvedBranchIds.length === 0) {
    throw serviceError(404, projectId != null
      ? `No tracked branches found for project ${projectId}`
      : 'No tracked branches found for this org (run an ingest first)');
  }

  const trimmed = query.trim();
  const result = await _retrieveSubgraph(trimmed, resolvedBranchIds, [], {});
  const raw = result.nodes || [];
  const exactIds = IDENTIFIER_QUERY.test(trimmed)
    ? await exactNameNodeIds(deps.pool || pool, resolvedBranchIds, trimmed)
    : [];
  const cap = Math.min(limit, 100);
  const limitedIds = [...new Set([...exactIds, ...raw.map((n) => n.id)])].slice(0, cap);
  const nodes = await fetchNodes(limitedIds, orgId, resolvedBranchIds);
  // fetchNodes returns rows in the store's order, so the exact matches have to be lifted back to
  // the front here. Array#sort is stable, which is what keeps a prose query — one with no exact
  // matches at all — byte-identical to before.
  if (exactIds.length) {
    const isExact = new Set(exactIds);
    nodes.sort((a, b) => (isExact.has(b.id) ? 1 : 0) - (isExact.has(a.id) ? 1 : 0));
  }
  const edges = (result.edges || [])
    .filter((e) => limitedIds.includes(e.from_node_id) && limitedIds.includes(e.to_node_id))
    .map((e) => ({
      from_node_id: e.from_node_id,
      to_node_id: e.to_node_id,
      edge_type: e.edge_type,
      is_cross_repo: e.is_cross_repo,
    }));

  const degraded = degradedChannels(result);
  return cited(nodes, edges, {
    latency_ms: Date.now() - t0,
    branch_ids: resolvedBranchIds,
    seed_count: result.seedCount,
    ...(degraded.length ? { degraded_channels: degraded } : {}),
  });
}

// A retrieval channel that timed out returns FEWER results, not an error, so an answer shrinks
// silently under load and the caller cannot tell a partial answer from a complete one. Measured on
// a frozen 40,438-node graph: query "resolveTimeoutMs" returns 30 nodes normally and 27 with the
// lexical deadline tripped; "normaliseErrorText" returns 30 and 0.
function degradedChannels(result) {
  return (result?.retrieval_trace?.channel_stats || [])
    .filter((s) => s.reason === 'timeout')
    .map((s) => ({ channel: s.channel, reason: s.reason }));
}

async function getCallersForOrg(orgId, args, deps = {}) {
  const t0 = Date.now();
  const _pool = deps.pool || pool;
  const { nodeId: rawNodeId, edgeTypes, includeHeuristic } = normalizeNodeArgs(args);
  const id = parseInt(rawNodeId, 10);
  if (!Number.isFinite(id)) throw serviceError(400, 'Invalid node id');

  const { rows: [targetNode] } = await _pool.query(
    `SELECT n.id FROM nodes n
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     JOIN projects p ON p.id = r.project_id
     WHERE n.id = $1 AND p.org_id = $2 AND n.approval_status != 'ARCHIVED'`,
    [id, orgId],
  );
  if (!targetNode) throw serviceError(404, 'Node not found');

  const { rows: edgeRows } = await _pool.query(
    `SELECT e.id, e.from_node_id, e.to_node_id, e.edge_type, e.is_cross_repo,
            e.resolution_tier, e.confidence, e.confidence_tier, e.properties
     FROM edges e
     JOIN nodes caller ON caller.id = e.from_node_id
     JOIN repository_branches rb ON rb.id = caller.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     JOIN projects p ON p.id = r.project_id
     WHERE e.to_node_id = $1 AND p.org_id = $2`,
    [id, orgId],
  );

  let filteredEdgeRows = edgeTypes
    ? edgeRows.filter((e) => edgeTypes.includes(e.edge_type))
    : edgeRows;
  // no SQL filter existed for this —
  // HEURISTIC_CALLS is excluded by default, same as the graph-communities.js
  // and blast-radius.js wiring landed in the same slice.
  if (!includeHeuristic) {
    filteredEdgeRows = filteredEdgeRows.filter((e) => !HEURISTIC_EDGE_TYPES.has(e.edge_type));
  }

  const callerIds = filteredEdgeRows.map((e) => e.from_node_id);
  const edgeTypeByNodeId = new Map(filteredEdgeRows.map((e) => [e.from_node_id, e.edge_type]));
  const rawNodes = await fetchNodes([id, ...callerIds], orgId);
  const nodes = rawNodes.map((n) => ({
    ...n,
    edge_type: n.id === id ? null : (edgeTypeByNodeId.get(n.id) || null),
  }));
  // call_line/resolution_tier/confidence were
  // extracted, tiered, and persisted (Tracks 0-1) but never surfaced past the SQL
  // row here — the caller-facing edge dropped every field the tier work exists to
  // expose. call_line lives in properties (not a column); resolution_tier/confidence
  // are real columns already selected above.
  const edges = filteredEdgeRows.map((e) => ({
    from_node_id: e.from_node_id,
    to_node_id: e.to_node_id,
    edge_type: e.edge_type,
    is_cross_repo: e.is_cross_repo,
    call_line: e.properties?.call_line ?? null,
    resolution_tier: e.resolution_tier ?? null,
    confidence: e.confidence != null ? parseFloat(e.confidence) : null,
    confidence_tier: e.confidence_tier ?? null,
    // A call `koragraph trace` actually saw execute. This is the one field that says an edge is not
    // a static guess but a fact — an agent can trust it over any resolution_tier. Absent (not false)
    // on an untraced edge, so the answer never claims a repo was traced when it was not.
    ...(e.properties?.runtime_observed === true ? { runtime_observed: true } : {}),
  }));

  return cited(nodes, edges, { latency_ms: Date.now() - t0, target_node_id: id });
}

async function getCalleesForOrg(orgId, args, deps = {}) {
  const t0 = Date.now();
  const _pool = deps.pool || pool;
  const { nodeId: rawNodeId, edgeTypes, includeImports, includeHeuristic } = normalizeNodeArgs(args);
  const id = parseInt(rawNodeId, 10);
  if (!Number.isFinite(id)) throw serviceError(400, 'Invalid node id');

  const { rows: [targetNode] } = await _pool.query(
    `SELECT n.id FROM nodes n
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     JOIN projects p ON p.id = r.project_id
     WHERE n.id = $1 AND p.org_id = $2 AND n.approval_status != 'ARCHIVED'`,
    [id, orgId],
  );
  if (!targetNode) throw serviceError(404, 'Node not found');

  const { rows: edgeRows } = await _pool.query(
    `SELECT e.id, e.from_node_id, e.to_node_id, e.edge_type, e.is_cross_repo, callee.node_type AS callee_node_type,
            e.resolution_tier, e.confidence, e.confidence_tier, e.properties
     FROM edges e
     JOIN nodes callee ON callee.id = e.to_node_id
     JOIN repository_branches rb ON rb.id = callee.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     JOIN projects p ON p.id = r.project_id
     WHERE e.from_node_id = $1 AND p.org_id = $2`,
    [id, orgId],
  );

  let filteredEdgeRows = includeImports
    ? edgeRows
    : edgeRows.filter((e) => e.callee_node_type !== 'IMPORT');
  if (edgeTypes) {
    filteredEdgeRows = filteredEdgeRows.filter((e) => edgeTypes.includes(e.edge_type));
  }
  // default-on HEURISTIC_CALLS exclusion.
  if (!includeHeuristic) {
    filteredEdgeRows = filteredEdgeRows.filter((e) => !HEURISTIC_EDGE_TYPES.has(e.edge_type));
  }

  const calleeIds = filteredEdgeRows.map((e) => e.to_node_id);
  const edgeTypeByNodeId = new Map(filteredEdgeRows.map((e) => [e.to_node_id, e.edge_type]));
  const rawNodes = await fetchNodes([id, ...calleeIds], orgId);
  const nodes = rawNodes.map((n) => ({
    ...n,
    edge_type: n.id === id ? null : (edgeTypeByNodeId.get(n.id) || null),
  }));
  // Mirrors getCallersForOrg above  — same fields, same reasoning.
  const edges = filteredEdgeRows.map((e) => ({
    from_node_id: e.from_node_id,
    to_node_id: e.to_node_id,
    edge_type: e.edge_type,
    is_cross_repo: e.is_cross_repo,
    call_line: e.properties?.call_line ?? null,
    resolution_tier: e.resolution_tier ?? null,
    confidence: e.confidence != null ? parseFloat(e.confidence) : null,
    confidence_tier: e.confidence_tier ?? null,
    // A call `koragraph trace` actually saw execute. This is the one field that says an edge is not
    // a static guess but a fact — an agent can trust it over any resolution_tier. Absent (not false)
    // on an untraced edge, so the answer never claims a repo was traced when it was not.
    ...(e.properties?.runtime_observed === true ? { runtime_observed: true } : {}),
  }));

  return cited(nodes, edges, { latency_ms: Date.now() - t0, target_node_id: id });
}

async function getFileNodesForOrg(orgId, args, deps = {}) {
  const t0 = Date.now();
  const _pool = deps.pool || pool;
  const { path: filePath, branch_id, node_types } = args;

  if (!filePath) throw serviceError(400, '"path" is required');

  const requestedLimit = parseInt(args.limit, 10);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_FILE_NODES_LIMIT, MAX_FILE_NODES_LIMIT),
  );
  const nodeTypes = Array.isArray(node_types) && node_types.length > 0 ? node_types : null;

  const params = [filePath, orgId];
  let sql = `
    SELECT n.id, n.name, n.node_type, n.confidence_tier, n.confidence,
           n.summary, n.canonical_key, n.properties, n.start_line, n.end_line,
           f.path AS file_path, f.summary AS file_summary, f.summary_source AS file_summary_status
    FROM nodes n
    JOIN files f ON f.id = n.file_id
    JOIN repository_branches rb ON rb.id = n.repository_branch_id
    JOIN repositories r ON r.id = rb.repository_id
    JOIN projects p ON p.id = r.project_id
    WHERE f.path = $1 AND p.org_id = $2 AND n.approval_status != 'ARCHIVED'
  `;
  if (branch_id) {
    params.push(parseInt(branch_id, 10));
    sql += ` AND rb.id = $${params.length}`;
  }
  if (nodeTypes) {
    params.push(nodeTypes);
    sql += ` AND n.node_type IN (SELECT value FROM json_each($${params.length}))`;
  }
  sql += ` ORDER BY n.id ASC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await _pool.query(sql, params);
  const nodeIds = rows.map((r) => r.id);
  const nodes = rows.map((r) => ({
    id: r.id,
    name: r.name,
    node_type: r.node_type,
    confidence_tier: r.confidence_tier,
    confidence: parseFloat(r.confidence),
    summary: r.summary || null,
    canonical_key: r.canonical_key || null,
    properties: r.properties || {},
    start_line: r.start_line ?? null,
    end_line: r.end_line ?? null,
    file: { path: r.file_path },
    file_summary: r.file_summary || null,
    file_summary_status: r.file_summary_status || null,
  }));
  const edges = await fetchEdgesBetween(nodeIds);

  return cited(nodes, edges, {
    latency_ms: Date.now() - t0,
    file_path: filePath,
    limit,
    node_types: nodeTypes,
  });
}

async function getImpactSubgraphForOrg(orgId, args, deps = {}) {
  const t0 = Date.now();
  const _pool = deps.pool || pool;
  const { node_ids, depth = 2 } = args;
  // Edge-type ablation. Empty by default, so the shipped tool is unchanged; a caller that wants
  // to measure the graph without a plane (e.g. CO_CHANGES) passes it here rather than deleting
  // rows, which keeps the two arms a matched pair over one ingest.
  const excludeEdgeTypes = Array.isArray(args.exclude_edge_types)
    ? args.exclude_edge_types.filter((t) => typeof t === 'string' && t.length)
    : [];

  if (!Array.isArray(node_ids) || node_ids.length === 0) {
    throw serviceError(400, '"node_ids" must be a non-empty array of integers');
  }
  const ids = node_ids.map((id) => parseInt(id, 10)).filter(Number.isFinite);
  if (ids.length === 0) throw serviceError(400, '"node_ids" contains no valid integers');
  const maxDepth = Math.min(Math.max(parseInt(depth, 10) || 2, 1), 3);

  const { rows } = await _pool.query(
    `WITH RECURSIVE impact(node_id, depth) AS (
       SELECT value, 0
       FROM json_each($1)
       UNION
       SELECT
         CASE WHEN e.from_node_id = i.node_id THEN e.to_node_id ELSE e.from_node_id END,
         i.depth + 1
       FROM impact i
       JOIN edges e ON (e.from_node_id = i.node_id OR e.to_node_id = i.node_id)
       WHERE i.depth < $3
         AND ($4 IS NULL OR e.edge_type NOT IN (SELECT value FROM json_each($4)))
     )
     -- No outer DISTINCT. The inner SELECT DISTINCT node_id already yields one row per node, and
     -- every join under it is many-to-one on a primary key, so the outer DISTINCT can never remove
     -- a row -- but SQLite still has to prove that by deduping the whole projection, which carries
     -- the properties JSON and two summary columns. Measured on a 14,095-node store over 20 seed
     -- sets of 30: 1.96 ms -> 1.28 ms, with identical row counts on every set.
     -- (No backticks in this comment: it lives inside a JS template literal.)
     SELECT n.id, n.name, n.node_type, n.confidence_tier, n.confidence,
            n.summary, n.canonical_key, n.properties, n.start_line, n.end_line,
            f.path AS file_path, f.summary AS file_summary, f.summary_source AS file_summary_status
     FROM (SELECT DISTINCT node_id FROM impact) AS imp
     JOIN nodes n ON n.id = imp.node_id
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     JOIN projects p ON p.id = r.project_id
     LEFT JOIN files f ON f.id = n.file_id
     WHERE p.org_id = $2 AND n.approval_status != 'ARCHIVED'`,
    [ids, orgId, maxDepth, excludeEdgeTypes.length ? excludeEdgeTypes : null],
  );

  const nodeIds = rows.map((r) => r.id);
  const nodes = rows.map((r) => ({
    id: r.id,
    name: r.name,
    node_type: r.node_type,
    confidence_tier: r.confidence_tier,
    confidence: parseFloat(r.confidence),
    summary: r.summary || null,
    canonical_key: r.canonical_key || null,
    properties: r.properties || {},
    start_line: r.start_line ?? null,
    end_line: r.end_line ?? null,
    file: r.file_path ? { path: r.file_path } : null,
    file_summary: r.file_summary || null,
    file_summary_status: r.file_summary_status || null,
  }));
  const edges = await fetchEdgesBetween(nodeIds, excludeEdgeTypes);

  // Ranking. This tool returned an unordered SET: an undirected walk to `depth`, no order, no
  // cap. But a blast-radius answer is a ranked, bounded list — "the twenty things you probably
  // have to touch" — and the only order the raw response carried was hop distance with ties
  // broken by node id, i.e. insertion order. Anything reading it at a cutoff was cutting
  // arbitrarily inside a hop.
  //
  // Personalized PageRank restarted on the seeds is the ordering the graph itself supplies. It is
  // the same computation that ranks retrieval expansion candidates (graph-ppr.js), needs no
  // vector and no model, and separates a node reachable by many independent paths from one
  // hanging off a single incidental edge — which hop distance cannot.
  //
  // Off unless asked for, so the shipped response shape is unchanged for existing callers.
  let ranking = null;
  if (args.rank === 'ppr' && nodes.length > 1) {
    const seedSet = new Set(ids.map(String));
    const personalization = new Map(ids.map((id) => [String(id), 1]));
    const ppr = personalizedPageRank(nodes, edges, personalization);
    const score = (n) => ppr.scores.get(String(n.id)) || 0;
    // Seeds first: they are the change itself, not a prediction about it.
    nodes.sort((a, b) => {
      const sa = seedSet.has(String(a.id)) ? 1 : 0;
      const sb = seedSet.has(String(b.id)) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      const d = score(b) - score(a);
      return d !== 0 ? d : Number(a.id) - Number(b.id);
    });
    ranking = {
      method: 'personalized_pagerank',
      iterations: ppr.iterations,
      residual: ppr.residual,
      nodes_ranked: nodes.length,
      edges_used: edges.length,
    };
  }

  return cited(nodes, edges, {
    latency_ms: Date.now() - t0,
    seed_node_ids: ids,
    depth: maxDepth,
    excluded_edge_types: excludeEdgeTypes,
    ranking,
  });
}

// METHODs with zero inbound CALLS|HEURISTIC_CALLS
// are "potentially unused" — a guessed caller (HEURISTIC_CALLS) still counts
// as evidence of life (Track 6 context note: asymmetry vs. default traversal
// exclusion is deliberate). Name/decorator exclusions and ordering mirror
// CGC's query exactly (only the decorator default differs).
async function findDeadCodeForOrg(orgId, args = {}, deps = {}) {
  const t0 = Date.now();
  const _pool = deps.pool || pool;
  const { project_id, branch_id } = args;

  const requestedLimit = parseInt(args.limit, 10);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_DEAD_CODE_LIMIT, MAX_DEAD_CODE_LIMIT),
  );

  const patterns = Array.isArray(args.exclude_decorated_with) && args.exclude_decorated_with.length > 0
    ? args.exclude_decorated_with.filter((p) => typeof p === 'string' && p.length > 0)
    : DEFAULT_DEAD_CODE_DECORATOR_EXCLUSIONS;

  const params = [orgId];
  let sql = `
    SELECT n.id, n.name, f.path AS path, n.start_line AS line,
           CASE WHEN json_type(n.properties, '$.cyclomatic_complexity') IN ('integer', 'real')
                THEN CAST(json_extract(n.properties, '$.cyclomatic_complexity') AS INTEGER)
                ELSE NULL END AS complexity
    FROM nodes n
    JOIN repository_branches rb ON rb.id = n.repository_branch_id
    JOIN repositories r ON r.id = rb.repository_id
    JOIN projects p ON p.id = r.project_id
    LEFT JOIN files f ON f.id = n.file_id
    WHERE p.org_id = $1
      AND n.node_type = 'METHOD'
      AND n.approval_status != 'ARCHIVED'
      AND n.name NOT IN ('main', 'setup', 'run')
      AND n.name <> '<module>'
      AND NOT (n.name LIKE '\\_\\_%' ESCAPE '\\' AND n.name LIKE '%\\_\\_' ESCAPE '\\')
      AND n.name NOT LIKE '\\_test%' ESCAPE '\\'
      AND n.name NOT LIKE 'test\\_%' ESCAPE '\\'
      AND n.name NOT LIKE '%main%'
      AND lower(n.name) NOT LIKE '%application%'
      AND lower(n.name) NOT LIKE '%entry%'
  `;

  if (project_id) {
    const parsedProjectId = parseInt(project_id, 10);
    if (!Number.isFinite(parsedProjectId)) throw serviceError(400, 'Invalid project_id');
    params.push(parsedProjectId);
    sql += ` AND p.id = $${params.length}`;
  }
  if (branch_id) {
    const parsedBranchId = parseInt(branch_id, 10);
    if (!Number.isFinite(parsedBranchId)) throw serviceError(400, 'Invalid branch_id');
    params.push(parsedBranchId);
    sql += ` AND rb.id = $${params.length}`;
  }

  params.push(patterns);
  sql += `
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          CASE WHEN json_type(n.properties, '$.decorators') = 'array'
               THEN json_extract(n.properties, '$.decorators') ELSE '[]' END
        ) AS dec
        CROSS JOIN json_each($${params.length}) AS pat
        WHERE instr(dec.value, pat.value) > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN nodes caller ON caller.id = e.from_node_id
        WHERE e.to_node_id = n.id
          AND e.edge_type IN ('CALLS', 'HEURISTIC_CALLS')
          AND caller.approval_status != 'ARCHIVED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM edges e2
        JOIN nodes caller2 ON caller2.id = e2.from_node_id
        WHERE e2.to_node_id = n.id
          AND caller2.node_type = 'ENDPOINT'
      )
    ORDER BY f.path, n.start_line
    LIMIT $${params.length + 1}
  `;
  params.push(limit);

  const { rows } = await _pool.query(sql, params);
  const functions = rows.map((r) => ({
    name: r.name,
    path: r.path,
    line: r.line,
    complexity: r.complexity ?? null,
  }));

  return {
    potentially_unused_functions: functions,
    note: 'These functions might be unused, but could be entry points, callbacks, or called dynamically',
    meta: {
      latency_ms: Date.now() - t0,
      count: functions.length,
      limit,
      project_id: project_id ? parseInt(project_id, 10) : null,
      branch_id: branch_id ? parseInt(branch_id, 10) : null,
      exclude_decorated_with: patterns,
    },
  };
}

// port of CGC's find_most_complex_functions
// (code_finder.py:1378-1390) — METHODs ordered by cyclomatic_complexity DESC,
// with name/path/line/args_count. CGC exposes a SEPARATE per-file tool
// (find_most_complex_functions_in_file); we fold that into one function via
// per_file=true, which aggregates method_count/complexity_sum/complexity_max
// per file instead of listing individual METHODs (an addition here, not a
// literal port). Only METHODs carrying a numeric cyclomatic_complexity
//  are eligible — nodes from before 3b (or the LLM extraction
// path) have no such property and are excluded, mirroring CGC's
// `cyclomatic_complexity IS NOT NULL` guard.
async function findMostComplexForOrg(orgId, args = {}, deps = {}) {
  const t0 = Date.now();
  const _pool = deps.pool || pool;
  const { project_id, branch_id } = args;
  const perFile = args.per_file === true;

  const requestedLimit = parseInt(args.limit, 10);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_COMPLEXITY_LIMIT, MAX_COMPLEXITY_LIMIT),
  );

  const params = [orgId];
  let sql;

  if (perFile) {
    sql = `
      SELECT f.path AS path,
             COUNT(*) AS method_count,
             SUM(CAST(json_extract(n.properties, '$.cyclomatic_complexity') AS INTEGER)) AS complexity_sum,
             MAX(CAST(json_extract(n.properties, '$.cyclomatic_complexity') AS INTEGER)) AS complexity_max
      FROM nodes n
      JOIN repository_branches rb ON rb.id = n.repository_branch_id
      JOIN repositories r ON r.id = rb.repository_id
      JOIN projects p ON p.id = r.project_id
      JOIN files f ON f.id = n.file_id
      WHERE p.org_id = $1
        AND n.node_type = 'METHOD'
        AND n.approval_status != 'ARCHIVED'
        AND json_type(n.properties, '$.cyclomatic_complexity') IN ('integer', 'real')
    `;
  } else {
    sql = `
      SELECT n.id, n.name, f.path AS path, n.start_line AS line,
             CAST(json_extract(n.properties, '$.cyclomatic_complexity') AS INTEGER) AS complexity,
             CASE WHEN json_type(n.properties, '$.args') = 'array'
                  THEN json_array_length(n.properties, '$.args') ELSE NULL END AS args_count
      FROM nodes n
      JOIN repository_branches rb ON rb.id = n.repository_branch_id
      JOIN repositories r ON r.id = rb.repository_id
      JOIN projects p ON p.id = r.project_id
      LEFT JOIN files f ON f.id = n.file_id
      WHERE p.org_id = $1
        AND n.node_type = 'METHOD'
        AND n.approval_status != 'ARCHIVED'
        AND json_type(n.properties, '$.cyclomatic_complexity') IN ('integer', 'real')
    `;
  }

  if (project_id) {
    const parsedProjectId = parseInt(project_id, 10);
    if (!Number.isFinite(parsedProjectId)) throw serviceError(400, 'Invalid project_id');
    params.push(parsedProjectId);
    sql += ` AND p.id = $${params.length}`;
  }
  if (branch_id) {
    const parsedBranchId = parseInt(branch_id, 10);
    if (!Number.isFinite(parsedBranchId)) throw serviceError(400, 'Invalid branch_id');
    params.push(parsedBranchId);
    sql += ` AND rb.id = $${params.length}`;
  }

  sql += perFile
    ? ` GROUP BY f.path ORDER BY complexity_sum DESC, complexity_max DESC, f.path`
    : ` ORDER BY CAST(json_extract(n.properties, '$.cyclomatic_complexity') AS INTEGER) DESC, f.path, n.start_line`;

  params.push(limit);
  sql += ` LIMIT $${params.length}`;

  const { rows } = await _pool.query(sql, params);

  const meta = {
    latency_ms: Date.now() - t0,
    limit,
    per_file: perFile,
    project_id: project_id ? parseInt(project_id, 10) : null,
    branch_id: branch_id ? parseInt(branch_id, 10) : null,
  };

  if (perFile) {
    const files = rows.map((r) => ({
      path: r.path,
      method_count: parseInt(r.method_count, 10),
      complexity_sum: parseInt(r.complexity_sum, 10),
      complexity_max: parseInt(r.complexity_max, 10),
    }));
    return { files, meta: { ...meta, count: files.length } };
  }

  const functions = rows.map((r) => ({
    name: r.name,
    path: r.path,
    line: r.line,
    complexity: r.complexity,
    args_count: r.args_count === null || r.args_count === undefined ? null : parseInt(r.args_count, 10),
  }));
  return { functions, meta: { ...meta, count: functions.length } };
}

module.exports = {
  searchGraphForOrg,
  soleProjectIdForOrg,
  projectIdByName,
  branchIdsByRepoName,
  getCallersForOrg,
  getCalleesForOrg,
  getFileNodesForOrg,
  getImpactSubgraphForOrg,
  findDeadCodeForOrg,
  findMostComplexForOrg,
  DEFAULT_DEAD_CODE_DECORATOR_EXCLUSIONS,
  // Exported for the guard that pins which shapes qualify for the exact-name lookup. It is the
  // gate on the identity answer, and widening or narrowing it silently is how false "no such
  // symbol" answers come back.
  __testables: { IDENTIFIER_QUERY, EXACT_NAME_CAP },
};
