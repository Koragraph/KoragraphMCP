'use strict';

const pool = require('../../db/pool');
const { edgeWriteTier } = require('../resolution/tiers');

// Merge a set of runtime-observed caller->callee edges (from tracer.py) into the graph for one
// branch. Two outcomes per observed edge whose ends both resolve to a real declaration node:
//   - a static CALLS edge already exists  -> it is CONFIRMED (properties.runtime_observed = true)
//   - no static edge exists               -> a new CALLS edge is ADDED at tier 1 (it happened)
// The counts are the honest per-repo static-vs-runtime comparison: how much of what actually ran the
// static analysis already had, and what it missed. Nothing here is a guess — an observed edge is the
// call itself, so a resolved pair is EXTRACTED-grade truth.

const DECL_TYPES = ['METHOD', 'FUNCTION', 'CLASS'];

// file -> name -> [{ id, line }] for the branch's declarations, so an observed (file, name, line)
// resolves to a node, disambiguating same-name declarations in one file by nearest def line. Nested
// maps rather than a joined string key, so no separator character can collide with a path or a name.
async function buildNodeIndex(branchId, _pool) {
  const typeList = DECL_TYPES.map((t) => `'${t}'`).join(', ');
  const { rows } = await _pool.query(
    `SELECT n.id, n.name, n.start_line AS line, f.path AS file
       FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1 AND n.approval_status = 'APPROVED'
        AND n.node_type IN (${typeList})`,
    [branchId]);
  const index = new Map();
  for (const r of rows) {
    let byName = index.get(r.file);
    if (!byName) { byName = new Map(); index.set(r.file, byName); }
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push({ id: r.id, line: r.line });
  }
  return index;
}

function resolveNode(index, ref) {
  const byName = index.get(ref.file);
  const cands = byName && byName.get(ref.name);
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0].id;
  // Multiple same-name declarations in the file: the one whose def line is closest to the observed
  // first line (a method and a module-level function can share a name; the line breaks the tie).
  let best = cands[0];
  let bestDelta = Math.abs((cands[0].line ?? 0) - (ref.line ?? 0));
  for (const c of cands.slice(1)) {
    const d = Math.abs((c.line ?? 0) - (ref.line ?? 0));
    if (d < bestDelta) { best = c; bestDelta = d; }
  }
  return best.id;
}

function parseProps(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

async function confirmOrAdd(from, to, _pool) {
  // A pre-existing CALLS edge counts as a STATIC confirmation only if static analysis produced it.
  // An edge a PRIOR trace added carries resolution 'runtime_observed'; counting it as "confirmed
  // static" would make static-recall climb toward 100% on every re-run of the same trace. Such an
  // edge is runtime-only, exactly as it was the run it was first added, so the metric stays stable.
  const { rows } = await _pool.query(
    `SELECT properties FROM edges WHERE from_node_id = $1 AND to_node_id = $2 AND edge_type = 'CALLS'`,
    [from, to]);
  if (rows.length) {
    const runtimeOnly = parseProps(rows[0].properties).resolution === 'runtime_observed';
    await _pool.query(
      `UPDATE edges SET properties = json_set(COALESCE(properties, '{}'), '$.runtime_observed', json('true'))
        WHERE from_node_id = $1 AND to_node_id = $2 AND edge_type = 'CALLS'`,
      [from, to]);
    return runtimeOnly ? 'runtime_only' : 'confirmed';
  }
  const derived = edgeWriteTier('runtime_observed', 'CALLS');
  const ins = await _pool.query(
    `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
     VALUES ($1, $2, 'CALLS', $3, $4, $5, $6)
     ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
    [from, to, derived.label, JSON.stringify({ resolution: 'runtime_observed', runtime_observed: true }), derived.tier, derived.confidence]);
  // A concurrent/other-type conflict leaves rowCount 0 without an insert; the edge is present but not
  // static, so it is runtime-only, not a static confirmation.
  return (ins.rowCount ?? 0) > 0 ? 'added' : 'runtime_only';
}

async function mergeRuntimeEdges({ branchId, edges }, _pool = pool) {
  const result = { observed: edges.length, resolved: 0, confirmed: 0, added: 0, runtimeOnly: 0, unresolved: 0, selfLoops: 0 };
  if (!edges.length) return result;
  const index = await buildNodeIndex(branchId, _pool);

  for (const e of edges) {
    const from = resolveNode(index, e.caller);
    const to = resolveNode(index, e.callee);
    if (from === null || to === null) { result.unresolved++; continue; }
    if (from === to) { result.selfLoops++; continue; }   // recursion — a self CALLS edge is noise here
    result.resolved++;
    const outcome = await confirmOrAdd(from, to, _pool);
    if (outcome === 'confirmed') result.confirmed++;
    else if (outcome === 'added') result.added++;
    else result.runtimeOnly++;   // a prior trace already added this runtime edge — not static, not new
  }

  // The per-repo static-vs-runtime headline: of everything that actually ran and resolved to two
  // declarations, the fraction the STATIC graph already had an edge for. runtimeOnly is excluded from
  // the numerator (it is not static), so re-running the identical trace reports the same number.
  result.staticRecallOfRuntime = result.resolved > 0
    ? Math.round((result.confirmed / result.resolved) * 1000) / 1000 : null;
  return result;
}

module.exports = { mergeRuntimeEdges, buildNodeIndex, resolveNode };
