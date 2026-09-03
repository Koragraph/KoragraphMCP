'use strict';

// After the graph is written, re-walk HEURISTIC_CALLS edges (tier 8/9, guess-grade) and
// upgrade the ones a *structural* fact — not another guess — can now settle. Candidates
// reachable through the inheritance graph are preferred; this file is the inheritance half
// only.
//
// Algorithm:
//   - a `json_extract(properties, '$.called_name')` (every HEURISTIC_CALLS edge carries it)
//     that names exactly ONE live METHOD declaration branch-wide upgrades directly — no
//     inheritance evidence needed, the ambiguity was never real.
//   - a name matching several METHOD declarations upgrades only if exactly one candidate's
//     declaring CLASS/INTERFACE is reachable (any number of EXTENDS/IMPLEMENTS hops, self
//     included) from a type the caller's own FILE node lists in `properties.imports`. Two or
//     more survivors is still a refusal — never guess among plausible targets.
//   - if the upgrade's (from, to, CALLS) triple collides with the `edges_resolved_unique`
//     index (a real CALLS edge to that same target already exists), the winning fact is
//     already recorded at better provenance — the HEURISTIC_CALLS row is deleted, not left
//     stranded.
//
// Batched, not per-edge: one query for every ambiguous edge in the branch, one recursive
// CTE for the branch's whole EXTENDS/IMPLEMENTS closure, one query for every candidate
// declaration, one query for every caller file's import facts.

const pool = require('../../db/pool');
const { edgeWriteTier } = require('./tiers');

async function runInheritanceReresolve(branchId, _pool = pool) {
  const { rows: ambiguousEdges } = await _pool.query(
    `SELECT e.id AS edge_id, e.from_node_id, json_extract(e.properties, '$.called_name') AS called_name,
            fn.file_id AS caller_file_id
       FROM edges e
       JOIN nodes fn ON fn.id = e.from_node_id
      WHERE e.edge_type = 'HEURISTIC_CALLS'
        AND e.resolution_tier IN (8, 9)
        AND json_type(e.properties, '$.called_name') IS NOT NULL
        AND fn.repository_branch_id = $1
        AND fn.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  if (!ambiguousEdges.length) return 0;

  const calledNames = [...new Set(ambiguousEdges.map((r) => r.called_name).filter(Boolean))];
  if (!calledNames.length) return 0;

  // Every live METHOD declaration on this branch whose name matches one of
  // the ambiguous called_names, plus the CLASS/INTERFACE it's declared on
  // (DEFINED_IN) — the candidate pool the ambiguity resolves within.
  const { rows: candidateRows } = await _pool.query(
    `SELECT m.name AS called_name, m.id AS method_id, di.to_node_id AS class_id
       FROM nodes m
       LEFT JOIN edges di ON di.from_node_id = m.id AND di.edge_type = 'DEFINED_IN'
      WHERE m.repository_branch_id = $1
        AND m.node_type = 'METHOD'
        AND m.approval_status != 'ARCHIVED'
        AND m.name IN (SELECT value FROM json_each($2))`,
    [branchId, calledNames]
  );
  const candidatesByName = new Map();
  for (const row of candidateRows) {
    if (!candidatesByName.has(row.called_name)) candidatesByName.set(row.called_name, []);
    candidatesByName.get(row.called_name).push({ methodId: row.method_id, classId: row.class_id });
  }
  if (!candidatesByName.size) return 0;

  // EXTENDS/IMPLEMENTS transitive descendants (ancestor -> every descendant, any depth, self
  // included), computed in JS rather than a recursive CTE. The CTE version was byte-equivalent but
  // ran the closure over the WHOLE branch and, on a multiple-inheritance DAG, walked every PATH to
  // each descendant — `UNION` deduped the pairs but not the work. Measured on sympy (2,138
  // EXTENDS/IMPLEMENTS edges) that single query took 166 s, 65% of the entire ingest. A memoised
  // DFS is O(V+E) and immune to path multiplicity, and `reachableFrom` is only ever read for a
  // handful of imported type ids below, never the whole branch, so nothing needs the full closure.
  const { rows: hierEdges } = await _pool.query(
    `SELECT e.from_node_id AS descendant_id, e.to_node_id AS ancestor_id
       FROM edges e
       JOIN nodes cn ON cn.id = e.from_node_id
      WHERE e.edge_type IN ('EXTENDS', 'IMPLEMENTS')
        AND cn.repository_branch_id = $1
        AND cn.approval_status != 'ARCHIVED'
        AND e.to_node_id IS NOT NULL`,
    [branchId]
  );
  const childrenOf = new Map(); // ancestorId -> [direct descendant ids]
  for (const row of hierEdges) {
    if (row.ancestor_id == null || row.descendant_id == null) continue;
    if (!childrenOf.has(row.ancestor_id)) childrenOf.set(row.ancestor_id, []);
    childrenOf.get(row.ancestor_id).push(row.descendant_id);
  }
  const _descMemo = new Map();
  const reachableFrom = {
    // Set(descendantId, self included). Cycle-safe (a class that transitively extends itself in a
    // malformed graph visits each node once); memoised so a re-queried ancestor is free.
    get(ancestorId) {
      if (_descMemo.has(ancestorId)) return _descMemo.get(ancestorId);
      const out = new Set();
      const stack = [ancestorId];
      while (stack.length) {
        const id = stack.pop();
        if (out.has(id)) continue;
        out.add(id);
        for (const c of childrenOf.get(id) || []) if (!out.has(c)) stack.push(c);
      }
      _descMemo.set(ancestorId, out);
      return out;
    },
  };

  // Caller-file import facts (FILE.properties.imports[].name) — read
  // directly off the FILE node, not the resolved IMPORTS edges: this pass
  // runs right after resolveOverrideEdges in ingest-post-tail.js, BEFORE
  // resolveImportStubEdges, so those edges are not guaranteed to exist yet
  // on a fresh ingest.
  const callerFileIds = [...new Set(ambiguousEdges.map((r) => r.caller_file_id).filter(Boolean))];
  const importNamesByFileId = new Map();
  if (callerFileIds.length) {
    const { rows: fileRows } = await _pool.query(
      `SELECT file_id, json_extract(properties, '$.imports') AS imports
         FROM nodes
        WHERE repository_branch_id = $1 AND node_type = 'FILE' AND approval_status != 'ARCHIVED'
          AND file_id IN (SELECT value FROM json_each($2))`,
      [branchId, callerFileIds]
    );
    for (const row of fileRows) {
      const names = (Array.isArray(row.imports) ? row.imports : [])
        .map((imp) => imp?.name)
        .filter(Boolean);
      importNamesByFileId.set(row.file_id, names);
    }
  }

  // Imported type name -> CLASS/INTERFACE node id(s), branch-wide name match — a plain name
  // index is the same evidence grade every other pre-import-edge heuristic tier in ingest.js
  // already uses.
  const importedNames = [...new Set([...importNamesByFileId.values()].flat())];
  const typeIdsByName = new Map();
  if (importedNames.length) {
    const { rows: typeRows } = await _pool.query(
      `SELECT name, id FROM nodes
        WHERE repository_branch_id = $1 AND node_type IN ('CLASS', 'INTERFACE') AND approval_status != 'ARCHIVED'
          AND name IN (SELECT value FROM json_each($2))`,
      [branchId, importedNames]
    );
    for (const row of typeRows) {
      if (!typeIdsByName.has(row.name)) typeIdsByName.set(row.name, []);
      typeIdsByName.get(row.name).push(row.id);
    }
  }

  const upgrades = []; // [edgeId, toNodeId]
  for (const edge of ambiguousEdges) {
    const allCandidates = candidatesByName.get(edge.called_name);
    if (!allCandidates || !allCandidates.length) continue;
    const candidates = allCandidates.filter((c) => c.methodId !== edge.from_node_id); // no self-edges
    if (!candidates.length) continue;

    if (candidates.length === 1) {
      upgrades.push([edge.edge_id, candidates[0].methodId]);
      continue;
    }

    const importNames = importNamesByFileId.get(edge.caller_file_id) || [];
    if (!importNames.length) continue; // no evidence to break the tie — refuse
    const reachableClassIds = new Set();
    for (const name of importNames) {
      for (const typeId of typeIdsByName.get(name) || []) {
        for (const id of reachableFrom.get(typeId) || []) reachableClassIds.add(id);
      }
    }
    if (!reachableClassIds.size) continue;

    const survivors = candidates.filter((c) => c.classId && reachableClassIds.has(c.classId));
    if (survivors.length !== 1) continue; // 0 or >1 survivors — refuse, never guess
    upgrades.push([edge.edge_id, survivors[0].methodId]);
  }

  if (!upgrades.length) return 0;

  const derived = edgeWriteTier('inheritance', 'CALLS');
  let written = 0;
  for (const [edgeId, toNodeId] of upgrades) {
    const { rowCount } = await _pool.query(
      `UPDATE edges AS e SET to_node_id = $2,
              edge_type = $3,
              confidence_tier = $4,
              resolution_tier = $5,
              confidence = $6,
              properties = json_merge(e.properties, '{"resolution":"inheritance"}')
        WHERE e.id = $1
          AND NOT EXISTS (
            SELECT 1 FROM edges e2
             WHERE e2.from_node_id = e.from_node_id AND e2.to_node_id = $2 AND e2.edge_type = $3 AND e2.id <> e.id
          )`,
      [edgeId, toNodeId, derived.edgeType, derived.label, derived.tier, derived.confidence]
    );
    if (rowCount > 0) {
      written++;
      continue;
    }
    // `edges_resolved_unique` collision: a CALLS edge from this caller to
    // the winning target already exists at (necessarily) better provenance
    // — the UPDATE above is the only way rowCount lands at 0 here, since
    // edgeId was read from the DB moments earlier and always exists. The
    // heuristic row now duplicates a better-provenance fact, so drop it
    // instead of leaving a stale HEURISTIC_CALLS guess sitting next to the
    // real edge.
    await _pool.query(`DELETE FROM edges WHERE id = $1`, [edgeId]);
  }
  return written;
}

// A CLASS node whose `properties.constructs` array includes 'partial' (csharp.js's
// `_hasPartialModifier`) shares a name with another such node in a DIFFERENT file on the
// branch — cross-file C# partial declarations of one type. Same-file duplicates stay merged
// into one node by base.js#mergeSameFileDuplicates upstream of this, so this pass only ever
// sees at most one candidate per (name, file) pair — grouping by name and requiring >=2
// distinct files is therefore both the cross-file test AND the same-file exclusion in one
// condition.
//
// Primary selection is deterministic (lowest start_line in lowest-path file): sort the
// group by (file_path, start_line) ascending and take the first as primary; every other
// member gets a PARTIAL_OF edge pointing AT the primary (secondary -> primary).
async function linkCrossFileConstructs(branchId, _pool = pool) {
  const { rows } = await _pool.query(
    `SELECT n.id, n.name, COALESCE(json_extract(n.properties, '$.namespace'), '') AS namespace,
            f.path AS file_path, n.start_line
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1
        AND n.approval_status != 'ARCHIVED'
        AND n.node_type = 'CLASS'
        -- jsonb's ARRAY-CONTAINS. In SQLite the same symbol is the parameter marker, so the
        -- operator form fails at prepare time; EXISTS over json_each is the equivalent.
        AND EXISTS (SELECT 1 FROM json_each(json_extract(n.properties, '$.constructs'))
                     WHERE value = 'partial')
      ORDER BY n.name, f.path, n.start_line`,
    [branchId]
  );
  if (!rows.length) return 0;

  // Group by `{namespace}::{name}`, not name alone — two unrelated `partial class Widget` in
  // DIFFERENT namespaces must never link, so the group key must include namespace
  // (csharp.js's `_enclosingNamespace`, '' for the global namespace) alongside name.
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.namespace}::${row.name}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const pairs = []; // [secondaryId, primaryId]
  for (const group of byKey.values()) {
    const distinctFiles = new Set(group.map((r) => r.file_path));
    if (distinctFiles.size < 2) continue; // same-file case — the same-file merge already owns it
    const sorted = [...group].sort((a, b) => (
      a.file_path === b.file_path ? a.start_line - b.start_line : (a.file_path < b.file_path ? -1 : 1)
    ));
    const primary = sorted[0];
    for (const secondary of sorted.slice(1)) {
      pairs.push([secondary.id, primary.id]);
    }
  }
  if (!pairs.length) return 0;

  const derived = edgeWriteTier('partial_of', 'PARTIAL_OF');
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const params = [];
    const valueClauses = chunk.map(([from, to]) => {
      const p = params.length;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution: 'partial_of' }), derived.tier, derived.confidence);
      return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[linkCrossFileConstructs] branch=${branchId} PARTIAL_OF edges written=${written}`);
  return written;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : undefined;
  };
  const branchId = getArg('branch') ? parseInt(getArg('branch'), 10) : undefined;
  if (!branchId) {
    console.error('Usage: node src/services/resolution/post-resolution.js --branch=<branchId>');
    process.exit(1);
  }
  (async () => {
    const t10 = await runInheritanceReresolve(branchId);
    console.log(`[post-resolution] branchId=${branchId} upgraded_t10=${t10}`);
    pool.end();
  })().catch((err) => { console.error('Failed:', err.message); pool.end(); process.exit(1); });
}

module.exports = { runInheritanceReresolve, linkCrossFileConstructs };
