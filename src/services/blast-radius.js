'use strict';

// Blast radius: changed files → nodes → REVERSE edges → callers. "If I change this, what else
// has to be looked at?" — answerable only from the graph, which is why no standalone diff tool
// can do it.

const pool = require('../db/pool');
const { logger } = require('../common-services/logger');
const { policyFor } = require('./retrieval-policy');

// HEURISTIC_CALLS (guess-grade CALLS edges, resolution/tiers.js#edgeWriteTier)
// is explicitly appended,
// not folded into the CALLS entry above — blast radius over-approximates
// deliberately (a missed caller is worse here than an extra one), unlike
// graph-tool-service.js's get_callers/get_callees, which default-exclude it.
const REVERSE_EDGE_TYPES = ['CALLS', 'HEURISTIC_CALLS', 'IMPORTS', 'DEPENDS_ON', 'USES', 'REFERENCES', 'EXTENDS'];
const DEFAULT_BREADTH_CAP = 25;
const MAX_DEPTH = 2;

// Per-hop cap on how many nodes carry forward to the next hop. `breadthCap` applies to the
// *collected* set after every hop has already run — it bounds the answer, never the walk. With
// reverse CALLS fan-out, hop 3+ would otherwise query an unbounded frontier and then throw the
// result away, because rankRiskSurface sorts depth ASC and slices at the breadth cap. Capping the
// frontier is what makes depth a real option rather than a way to run the same query more
// expensively. Null = uncapped, which stays the default at depth <= 2.
const DEFAULT_FRONTIER_CAP = 40;

async function resolveBranchIds({ orgId, projectId, db }) {
  const { rows } = await db.query(
    `SELECT rb.id
       FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id
       JOIN projects p ON p.id = r.project_id
      WHERE p.org_id = $1
        AND p.id = $2`,
    [orgId, projectId],
  );
  return rows.map((row) => row.id);
}

async function resolveChangedNodeIds({ orgId, branchIds, filesChanged, db }) {
  if (!branchIds.length || !filesChanged.length) return [];
  const { rows } = await db.query(
    `SELECT n.id
       FROM nodes n
       JOIN files f ON f.id = n.file_id
       JOIN repository_branches rb ON rb.id = n.repository_branch_id
       JOIN repositories r ON r.id = rb.repository_id
       JOIN projects p ON p.id = r.project_id
      WHERE p.org_id = $1
        AND rb.id IN (SELECT value FROM json_each($2))
        AND f.path IN (SELECT value FROM json_each($3))`,
    [orgId, branchIds, filesChanged],
  );
  return rows.map((row) => row.id);
}

// The known failure mode is IMPORT nodes with zero IMPORTS edges — orphaned imports that make
// import-reverse callers structurally unfindable while `graph_coverage` still
// reports 'resolved' because unrelated CALLS/USES nodes matched. Fail loudly on
// that exact signature instead of silently under-reporting coverage.
async function assertImportReverseCoverage({ orgId, branchIds, db }) {
  if (!branchIds.length) return;
  const { rows } = await db.query(
    `SELECT
        (SELECT count(*)
           FROM nodes n
           JOIN repository_branches rb ON rb.id = n.repository_branch_id
           JOIN repositories r ON r.id = rb.repository_id
           JOIN projects p ON p.id = r.project_id
          WHERE p.org_id = $1 AND rb.id IN (SELECT value FROM json_each($2)) AND n.node_type = 'IMPORT'
        ) AS import_nodes,
        (SELECT count(*)
           FROM edges e
           JOIN nodes caller ON caller.id = e.from_node_id
           JOIN repository_branches rb ON rb.id = caller.repository_branch_id
           JOIN repositories r ON r.id = rb.repository_id
           JOIN projects p ON p.id = r.project_id
          WHERE p.org_id = $1 AND rb.id IN (SELECT value FROM json_each($2)) AND e.edge_type = 'IMPORTS'
        ) AS imports_edges`,
    [orgId, branchIds],
  );
  const importNodes = rows[0]?.import_nodes || 0;
  const importsEdges = rows[0]?.imports_edges || 0;
  if (importNodes > 0 && importsEdges === 0) {
    const err = new Error(
      `Blast radius import-reverse coverage is broken: ${importNodes} IMPORT node(s) exist on this branch with zero IMPORTS edges — reverse-edge callers through imports cannot be found`,
    );
    err.code = 'import_reverse_coverage_missing';
    throw err;
  }
}

// What the task type does to a blast-radius walk. `null` means "no task type was supplied", and
// every existing caller lands there: same edge types, same depth, same output keys.
//
// `CO_CHANGES` is admitted only as a first-hop NEIGHBOUR and is never carried into the frontier.
// It is a statistical co-occurrence with no structural claim attached — expanding a co-change
// neighbour's callers would present strangers as reachable from the seed, and the `relation`
// field exists so a consumer can never read one as a caller.
function reversePlanFor(taskType) {
  if (taskType == null || taskType === '' || taskType === 'unknown') return null;
  const policy = policyFor(taskType);
  return {
    edgeTypes: REVERSE_EDGE_TYPES.filter(
      (t) => t !== 'HEURISTIC_CALLS' || policy.includeHeuristic,
    ),
    cochange: policy.includeCochange,
    depth: policy.depth,
  };
}

async function queryCallers({ orgId, branchIds, targetNodeIds, db, edgeTypes = REVERSE_EDGE_TYPES }) {
  if (!targetNodeIds.length) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT caller.id,
            caller.name,
            caller.node_type,
            caller.file_id,
            f.path AS file_path,
            caller.start_line,
            caller.end_line,
            json_extract(COALESCE(NULLIF(caller.properties, ''), '{}'), '$.covered') AS covered,
            json_extract(COALESCE(NULLIF(e.properties, ''), '{}'), '$.runtime_observed') AS runtime_observed,
            e.edge_type,
            r.name AS repo
       FROM edges e
       JOIN nodes changed ON changed.id = e.to_node_id
       JOIN nodes caller  ON caller.id  = e.from_node_id
       JOIN files f ON f.id = caller.file_id
       JOIN repository_branches rb ON rb.id = caller.repository_branch_id
       JOIN repositories r ON r.id = rb.repository_id
       JOIN projects p ON p.id = r.project_id
      WHERE p.org_id = $1
        AND changed.id IN (SELECT value FROM json_each($2))
        AND caller.repository_branch_id IN (SELECT value FROM json_each($3))
        AND e.edge_type IN (SELECT value FROM json_each($4))
      ORDER BY caller.id,
               CASE e.edge_type WHEN 'CALLS' THEN 0 WHEN 'HEURISTIC_CALLS' THEN 2 ELSE 1 END,
               CASE WHEN json_extract(COALESCE(NULLIF(e.properties, ''), '{}'), '$.runtime_observed') IS NOT NULL THEN 0 ELSE 1 END,
               e.edge_type`,
    [orgId, targetNodeIds, branchIds, edgeTypes],
  );
  return rows;
}

function looksLikeTestPath(filePath) {
  return /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/|_test\.)/.test(String(filePath || ''));
}

// Ranked risk surface: edge distance ASC, then callers with no visible test
// coverage first (coverage ASC), then name for determinism. Historical change
// coupling is a v2 refinement — the column data for it is sparse today.
function rankRiskSurface(callers, { breadthCap = DEFAULT_BREADTH_CAP } = {}) {
  const ranked = [...callers].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.has_test_coverage !== b.has_test_coverage) {
      return a.has_test_coverage ? 1 : -1;
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const targeted = ranked.slice(0, breadthCap);
  const dropped = ranked.length - targeted.length;
  return {
    callers_found: ranked.length,
    callers_targeted: targeted.length,
    callers_dropped: dropped,
    drop_reason: dropped > 0 ? 'breadth_cap' : null,
    callers: targeted,
  };
}

// Which callers carry forward when the frontier is capped. Deterministic and zero-token: a
// resolved CALLS edge outranks a HEURISTIC_CALLS guess (resolution/tiers.js writes the latter at
// tier >=8), production outranks test, then name for a stable tiebreak. This is deliberately not
// a relevance model — it is a fan-out control, and a control that reorders unpredictably between
// runs would make deep traversal irreproducible.
function rankFrontier(callers) {
  return [...callers].sort((a, b) => {
    const heuristic = (c) => (c.edge_type === 'HEURISTIC_CALLS' ? 1 : 0);
    if (heuristic(a) !== heuristic(b)) return heuristic(a) - heuristic(b);
    const test = (c) => (looksLikeTestPath(c.file_path) ? 1 : 0);
    if (test(a) !== test(b)) return test(a) - test(b);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

async function computeBlastRadius({
  orgId,
  projectId,
  // Pre-resolved branch ids narrow the walk to exactly one repository. When supplied, this wins
  // over `projectId` — `projectId` in a multi-repo project scopes to every repository the project
  // holds, which is a no-op for a caller trying to scope to just one of them (the eval's `project_id:
  // "subscriptionservice"` request read every repo in the same project as the numeric id it already
  // got with no scope at all — same result set, no error, no signal scoping had no effect).
  branchIds: presetBranchIds,
  filesChanged = [],
  breadthCap = DEFAULT_BREADTH_CAP,
  maxDepth,
  frontierCap,
  taskType = null,
  db,
}) {
  const _db = db || pool;
  if (!orgId || (!projectId && !(presetBranchIds && presetBranchIds.length))) {
    const err = new Error('computeBlastRadius requires orgId and (projectId or branchIds)');
    err.code = 'scope_context_missing';
    throw err;
  }

  const branchIds = presetBranchIds && presetBranchIds.length
    ? presetBranchIds
    : await resolveBranchIds({ orgId, projectId, db: _db });
  await assertImportReverseCoverage({ orgId, branchIds, db: _db });
  const changedNodeIds = await resolveChangedNodeIds({ orgId, branchIds, filesChanged, db: _db });

  // An explicit `maxDepth` always wins; otherwise the task type's policy decides, and with no
  // task type the historical constant does. Existing callers pass neither and are unaffected.
  const plan = reversePlanFor(taskType);
  const effectiveMaxDepth = maxDepth != null ? maxDepth : (plan ? plan.depth : MAX_DEPTH);

  // A frontier cap is only defaulted ON when the caller actually asks to go deeper than the
  // historical MAX_DEPTH. At depth <= 2 an unbounded frontier is what every existing caller has
  // always received, and silently narrowing it would change blast-radius answers that other
  // callers already depend on.
  // `!== undefined`, not `!= null`: an explicit `frontierCap: null` is a caller asking for an
  // uncapped walk, which is a different request from omitting the option, and `!= null` silently
  // collapsed the two into the default.
  const effectiveFrontierCap = frontierCap !== undefined
    ? frontierCap
    : (effectiveMaxDepth > MAX_DEPTH ? DEFAULT_FRONTIER_CAP : null);
  const walkEdgeTypes = plan ? plan.edgeTypes : REVERSE_EDGE_TYPES;

  const seen = new Set(changedNodeIds);
  const collected = [];
  const frontierTruncations = [];

  let frontier = changedNodeIds;
  let depthReached = 0;
  for (let depth = 1; depth <= effectiveMaxDepth && frontier.length; depth += 1) {
    const edgeTypes = plan && plan.cochange && depth === 1
      ? [...walkEdgeTypes, 'CO_CHANGES']
      : walkEdgeTypes;
    const callers = await queryCallers({ orgId, branchIds, targetNodeIds: frontier, db: _db, edgeTypes });
    const fresh = [];
    for (const caller of callers) {
      if (seen.has(caller.id)) continue;
      seen.add(caller.id);
      fresh.push(caller);
    }

    // Rank BEFORE capping, and cap the walk rather than the answer — everything fresh is still
    // reported at this depth; the cap only decides which of them get to expand again.
    const ranked = rankFrontier(fresh);
    const expandable = ranked.filter((c) => c.edge_type !== 'CO_CHANGES');
    const carried = effectiveFrontierCap != null
      ? expandable.slice(0, effectiveFrontierCap) : expandable;
    if (expandable.length > carried.length) {
      frontierTruncations.push({ depth, frontier_found: expandable.length, frontier_carried: carried.length });
    }

    for (const caller of ranked) {
      collected.push({
        node_id: caller.id,
        name: caller.name,
        node_type: caller.node_type,
        file_path: caller.file_path,
        // The repository this caller lives in — distinguishes two callers at the same relative
        // path in different repos (a shared base package across sibling services, e.g.), which
        // `file_path` alone cannot.
        repo: caller.repo,
        start_line: caller.start_line,
        end_line: caller.end_line,
        edge_type: caller.edge_type,
        depth,
        // Real coverage when an artifact recorded it (coverage-graph.js), the path heuristic
        // otherwise. `looksLikeTestPath` answers "is this file under test/", which is a different
        // question from "is this code exercised" — it was the only answer available before.
        has_test_coverage: caller.covered != null
          ? Boolean(caller.covered)
          : looksLikeTestPath(caller.file_path),
        // This caller PROVABLY reaches the changed code — `koragraph trace` saw the call run. A
        // runtime-confirmed dependent is a higher-certainty risk than a statically-guessed one.
        ...(caller.runtime_observed ? { runtime_observed: true } : {}),
        ...(plan ? { relation: caller.edge_type === 'CO_CHANGES' ? 'cochange' : 'caller' } : {}),
      });
    }
    if (fresh.length) depthReached = depth;
    frontier = carried.map((c) => c.id);
  }

  const surface = rankRiskSurface(collected, { breadthCap });
  if (surface.callers_dropped > 0) {
    // Logged, never silently truncated.
    logger.info('blast_radius.breadth_cap', {
      org_id: orgId,
      project_id: projectId,
      callers_found: surface.callers_found,
      callers_dropped: surface.callers_dropped,
    });
  }
  for (const t of frontierTruncations) {
    logger.info('blast_radius.frontier_cap', { org_id: orgId, project_id: projectId, ...t });
  }

  // Coverage self-report: which edge types this walk actually followed, which of the tool's known
  // reverse-edge types it left out, and — separate from either — what no edge type here can ever
  // see. An eval against a real 9-repo store found a caller only reachable through a field/generic
  // type reference (a `List<Subscription>` field), independently re-derived it with grep, and
  // flagged that blast_radius gave no way to know a supplementary check might be worth running.
  // These fields make that check unnecessary by default instead of something a caller has to
  // discover by getting burned once.
  const edgeTypesExcluded = REVERSE_EDGE_TYPES.filter((t) => !walkEdgeTypes.includes(t));
  const nextActions = edgeTypesExcluded.length
    ? [{
      tool: 'grep',
      reason: `This walk excluded ${edgeTypesExcluded.join(', ')} edges (narrowed by task_type "${taskType}"). `
        + 'A caller relying only on this result for rename/delete safety should also text-search '
        + 'the changed declarations’ names to catch dependents this walk could not reach.',
    }]
    : [];

  return {
    ...surface,
    changed_files: filesChanged,
    changed_node_count: changedNodeIds.length,
    graph_coverage: changedNodeIds.length > 0 ? 'resolved' : 'unresolved',
    // `breadthCap` bounds the answer and `frontier_cap` bounds the walk; a consumer reasoning
    // about completeness needs to tell those apart, and needs to know the walk stopped because
    // the graph ran out (depth_reached < max_depth) rather than because the limit was hit.
    max_depth: effectiveMaxDepth,
    depth_reached: depthReached,
    frontier_cap: effectiveFrontierCap,
    frontier_truncations: frontierTruncations,
    edge_types_included: walkEdgeTypes,
    edge_types_excluded: edgeTypesExcluded,
    // True regardless of which edge types were walked: none of them come from executing the code
    // or resolving a string, so reflection, dynamic dispatch, and config/string-driven wiring
    // (a class name read out of a YAML file, e.g.) are structurally invisible to this tool.
    coverage_note: 'Structural walk only — reflection, dynamic dispatch, and string/config-driven '
      + 'references (e.g. a class name read from a config file) are not captured by any edge type.',
    ...(nextActions.length ? { next_actions: nextActions } : {}),
    ...(plan ? { task_type: taskType, edge_types: plan.edgeTypes, cochange_admitted: plan.cochange } : {}),
  };
}

module.exports = {
  REVERSE_EDGE_TYPES,
  reversePlanFor,
  DEFAULT_BREADTH_CAP,
  DEFAULT_FRONTIER_CAP,
  MAX_DEPTH,
  computeBlastRadius,
  rankRiskSurface,
  rankFrontier,
  looksLikeTestPath,
  assertImportReverseCoverage,
};
