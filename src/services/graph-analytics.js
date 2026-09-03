'use strict';

const pool = require('../db/pool');
const { EDGE_WEIGHTS } = require('./graph-ppr');

// Whole-graph orientation: the questions an agent asks on its FIRST turn in a repository it has
// never seen, which every existing tool answers only once you already know what to name.
// `search_code` needs a query, `neighbours` and `blast_radius` need a symbol.
//
// Deliberately ONE service behind ONE tool rather than four. MCP tool schemas are paid before the
// user types a word, and a small surface is a measured feature here.
//
// Everything below is a SQL aggregate over edges that already exist. No clustering library, no
// new dependency, nothing written back to the graph: this is a read, so it can never make an
// ingest slower or a graph larger.

// A node's importance is not its raw degree. CONTAINS and DEFINED_IN are structural bookkeeping —
// every declaration has them — so counting them ranks whichever FILE holds the most declarations
// and tells a reader nothing they could not get from `ls`. The weights are graph-ppr.js's, reused
// rather than restated so the two cannot drift into disagreeing about what an edge is worth.
const STRUCTURAL_NOISE = Object.freeze(['CONTAINS', 'DEFINED_IN', 'BELONGS_TO']);

// CO_CHANGES and COUPLED_WITH are excluded from the god-node score on purpose and given their own
// answer below. They are statistical co-occurrence, not a code relationship, and mixing them in
// would let a file that merely changes often outrank the one everything calls.
const TEMPORAL = Object.freeze(['CO_CHANGES', 'COUPLED_WITH']);

// "What does the most code depend on" is a question about DECLARATIONS. Without this, express's
// answer led with .editorconfig (a FILE node with 96 inbound edges) and commons-cli's with
// org.junit.jupiter.api.Test (a DEPENDENCY with 461, i.e. "this project has tests"). Both are
// true and neither is what was asked.
const DECLARATION_TYPES = Object.freeze([
  'METHOD', 'CLASS', 'FUNCTION', 'INTERFACE', 'STRUCT', 'ENUM', 'TRAIT', 'MODULE', 'CONSTANT',
]);

function scopeClause(branchIds, params) {
  params.push(JSON.stringify(branchIds));
  return `n.repository_branch_id IN (SELECT value FROM json_each($${params.length}))`;
}

function weightCase(column) {
  const cases = Object.entries(EDGE_WEIGHTS)
    .filter(([type]) => !STRUCTURAL_NOISE.includes(type) && !TEMPORAL.includes(type))
    .map(([type, w]) => `WHEN '${type}' THEN ${w}`)
    .join(' ');
  // An edge type with no weight scores 0.5 rather than 0: a plane added later must not silently
  // disappear from this answer just because nobody remembered to weight it here.
  return `CASE ${column} ${cases} ELSE 0.5 END`;
}

// The declarations the most code depends on, weighted by what the dependency actually is.
async function godNodes(branchIds, { limit = 10, db = pool } = {}) {
  if (!branchIds || !branchIds.length) return [];
  const params = [];
  const scope = scopeClause(branchIds, params);
  params.push(...STRUCTURAL_NOISE, ...TEMPORAL);
  const excluded = STRUCTURAL_NOISE.concat(TEMPORAL)
    .map((_, i) => `$${params.length - (STRUCTURAL_NOISE.length + TEMPORAL.length) + 1 + i}`)
    .join(', ');
  const declStart = params.length + 1;
  params.push(...DECLARATION_TYPES);
  const declTypes = DECLARATION_TYPES.map((_, i) => `$${declStart + i}`).join(', ');
  params.push(limit);

  const { rows } = await db.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file, n.start_line AS line,
            SUM(${weightCase('e.edge_type')}) AS score,
            COUNT(*) AS degree
       FROM nodes n
       JOIN edges e ON e.to_node_id = n.id
       LEFT JOIN files f ON f.id = n.file_id
      WHERE ${scope}
        AND n.approval_status = 'APPROVED'
        AND n.name IS NOT NULL
        AND n.node_type IN (${declTypes})
        AND e.edge_type NOT IN (${excluded})
        -- AMBIGUOUS is where the resolver said "I could not decide", and ranking IMPORTANCE on
        -- unresolved guesses manufactures hubs out of common short names. Measured on this
        -- repository before the filter, the top "most depended-on declarations" were get, has,
        -- Set, test and String -- two of them from a Go referee script -- because a bare "get"
        -- collected 1,396 AMBIGUOUS HEURISTIC_CALLS from every unresolved dotted call in the tree.
        -- A wrong orientation answer is worse than none: it is the first thing an agent reads.
        -- (No backticks in this comment: it lives inside a JS template literal.)
        AND COALESCE(e.confidence_tier, '') <> 'AMBIGUOUS'
      GROUP BY n.id
      ORDER BY score DESC, degree DESC, n.id ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    name: r.name, type: r.node_type, file: r.file, line: r.line,
    dependents: Number(r.degree), score: Number(Number(r.score).toFixed(1)),
  }));
}

// What changes together most, which is a different question from what calls what.
async function churnHotspots(branchIds, { limit = 10, db = pool } = {}) {
  if (!branchIds || !branchIds.length) return [];
  const params = [];
  const scope = scopeClause(branchIds, params);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file, n.start_line AS line,
            COUNT(*) AS partners
       FROM nodes n
       JOIN edges e ON e.from_node_id = n.id
       LEFT JOIN files f ON f.id = n.file_id
      WHERE ${scope}
        AND n.approval_status = 'APPROVED'
        AND e.edge_type IN ('CO_CHANGES', 'COUPLED_WITH')
      GROUP BY n.id
      ORDER BY partners DESC, n.id ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    name: r.name, type: r.node_type, file: r.file, line: r.line, co_changes_with: Number(r.partners),
  }));
}

// Import cycles over FILE->FILE IMPORTS only. FILE->DEPENDENCY edges point at package nodes that
// are leaves by construction and cannot participate in a cycle, and including them would make the
// adjacency list several times larger to prove that.
//
// Iterative DFS with an explicit stack, not recursion: a deep import chain in a large repository
// would otherwise decide this by blowing the JS stack, and it would do it only on the repositories
// where the answer matters most.
async function importCycles(branchIds, { limit = 10, maxNodes = 20000, db = pool } = {}) {
  if (!branchIds || !branchIds.length) return [];
  const params = [];
  const scope = scopeClause(branchIds, params);
  const { rows } = await db.query(
    `SELECT e.from_node_id AS a, e.to_node_id AS b, f.path AS from_path, tf.path AS to_path
       FROM edges e
       JOIN nodes n ON n.id = e.from_node_id
       JOIN nodes tn ON tn.id = e.to_node_id
       LEFT JOIN files f ON f.id = n.file_id
       LEFT JOIN files tf ON tf.id = tn.file_id
      WHERE ${scope}
        AND e.edge_type = 'IMPORTS'
        AND n.node_type = 'FILE' AND tn.node_type = 'FILE'
        AND n.approval_status = 'APPROVED' AND tn.approval_status = 'APPROVED'`,
    params,
  );
  if (!rows.length || rows.length > maxNodes * 4) return [];

  const adj = new Map();
  const label = new Map();
  for (const r of rows) {
    if (!adj.has(r.a)) adj.set(r.a, []);
    adj.get(r.a).push(r.b);
    if (r.from_path) label.set(r.a, r.from_path);
    if (r.to_path) label.set(r.b, r.to_path);
  }

  const WHITE = 0; const GREY = 1; const BLACK = 2;
  const colour = new Map();
  const found = [];
  const seen = new Set();

  for (const start of adj.keys()) {
    if (colour.get(start) === BLACK) continue;
    const stack = [{ node: start, next: 0 }];
    const path = [];
    colour.set(start, GREY);
    path.push(start);

    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = adj.get(top.node) || [];
      if (top.next >= kids.length) {
        colour.set(top.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const child = kids[top.next];
      top.next += 1;
      const c = colour.get(child) ?? WHITE;
      if (c === GREY) {
        // A back edge closes a cycle. The cycle is the tail of the current path from `child` on.
        const at = path.indexOf(child);
        if (at < 0) continue;
        const cyc = path.slice(at).map((id) => label.get(id) || String(id));
        // Rotate to a canonical start so the same cycle discovered from two entry points is
        // reported once, not twice.
        const min = cyc.indexOf([...cyc].sort()[0]);
        const canon = cyc.slice(min).concat(cyc.slice(0, min));
        const key = canon.join('>');
        if (!seen.has(key)) { seen.add(key); found.push(canon); }
        continue;
      }
      if (c === BLACK) continue;
      colour.set(child, GREY);
      path.push(child);
      stack.push({ node: child, next: 0 });
    }
  }

  found.sort((a, b) => a.length - b.length || a.join('>').localeCompare(b.join('>')));
  return found.slice(0, limit).map((files) => ({ length: files.length, files }));
}

async function graphStats(branchIds, { db = pool } = {}) {
  if (!branchIds || !branchIds.length) return { nodes: 0, edges: 0, files: 0, node_types: {}, edge_types: {} };
  const params = [];
  const scope = scopeClause(branchIds, params);

  const [{ rows: nodeTypes }, { rows: edgeTypes }, { rows: fileCount }] = await Promise.all([
    db.query(
      `SELECT n.node_type AS k, COUNT(*) AS n FROM nodes n
        WHERE ${scope} AND n.approval_status = 'APPROVED'
        GROUP BY 1 ORDER BY 2 DESC`, params,
    ),
    db.query(
      // Both ends live. The node count beside this one has always excluded ARCHIVED while the
      // edge count did not, so overview reported edges that no traversal here can follow — 87 of
      // express's 2,846, 3.1%. Untraversable-edge rate is a headline number for this product; it
      // cannot be inflated by the tool that reports it.
      `SELECT e.edge_type AS k, COUNT(*) AS n FROM edges e
         JOIN nodes n ON n.id = e.from_node_id
         JOIN nodes t ON t.id = e.to_node_id
        WHERE ${scope} AND n.approval_status = 'APPROVED' AND t.approval_status = 'APPROVED'
        GROUP BY 1 ORDER BY 2 DESC`, params,
    ),
    db.query(
      `SELECT COUNT(DISTINCT n.file_id) AS n FROM nodes n
        WHERE ${scope} AND n.file_id IS NOT NULL`, params,
    ),
  ]);

  const fold = (rowsIn) => rowsIn.reduce((m, r) => { m[r.k] = Number(r.n); return m; }, {});
  const nodeT = fold(nodeTypes);
  const edgeT = fold(edgeTypes);
  return {
    nodes: Object.values(nodeT).reduce((a, b) => a + b, 0),
    edges: Object.values(edgeT).reduce((a, b) => a + b, 0),
    files: Number(fileCount[0] ? fileCount[0].n : 0),
    node_types: nodeT,
    edge_types: edgeT,
  };
}

// A node/edge list for a machine-readable export (Mermaid / GraphML / DOT / JSON). A whole graph is
// unusable in a diagram — express is 900+ nodes — so this returns a FOCUSED subgraph: the `limit`
// declarations the most code depends on (the same weighted degree godNodes ranks on), plus every
// non-structural edge that runs between two kept nodes. Structural bookkeeping (CONTAINS/DEFINED_IN/
// BELONGS_TO) is dropped by default because it says only "this file holds these declarations", which
// a diagram of the code's real relationships should not be dominated by.
async function exportGraph(branchIds, { limit = 200, includeStructural = false, db = pool } = {}) {
  if (!branchIds || !branchIds.length) return { nodes: [], edges: [] };
  const params = [];
  const scope = scopeClause(branchIds, params);
  const typeList = DECLARATION_TYPES.map((t) => `'${t}'`).join(', ');
  const noise = STRUCTURAL_NOISE.concat(TEMPORAL);
  const weightExpr = weightCase('e.edge_type');

  // Rank declarations by weighted inbound degree, exactly as godNodes does, and keep the top `limit`.
  const { rows: nodeRows } = await db.query(
    `SELECT n.id, n.name, n.node_type AS type, f.path AS file, n.start_line AS line,
            COALESCE((SELECT SUM(${weightExpr}) FROM edges e
                        JOIN nodes fn ON fn.id = e.from_node_id
                       WHERE e.to_node_id = n.id AND fn.approval_status = 'APPROVED'), 0) AS score
       FROM nodes n
       LEFT JOIN files f ON f.id = n.file_id
      WHERE ${scope} AND n.approval_status = 'APPROVED' AND n.node_type IN (${typeList})
      ORDER BY score DESC, n.id ASC
      LIMIT ${Number(limit) > 0 ? Number(limit) : 200}`,
    params,
  );
  if (!nodeRows.length) return { nodes: [], edges: [] };

  const keep = new Set(nodeRows.map((r) => r.id));
  const idJson = JSON.stringify([...keep]);
  const eParams = [idJson, idJson];
  let edgeWhere = `e.from_node_id IN (SELECT value FROM json_each($1))
       AND e.to_node_id IN (SELECT value FROM json_each($2))`;
  if (!includeStructural) {
    for (const t of noise) eParams.push(t);
    const placeholders = noise.map((_, i) => `$${3 + i}`).join(', ');
    edgeWhere += ` AND e.edge_type NOT IN (${placeholders})`;
  }
  const { rows: edgeRows } = await db.query(
    `SELECT DISTINCT e.from_node_id AS "from", e.to_node_id AS "to", e.edge_type AS type
       FROM edges e WHERE ${edgeWhere}`,
    eParams,
  );

  return {
    nodes: nodeRows.map((r) => ({
      id: r.id, name: r.name, type: r.type, file: r.file || null,
      line: r.line || null, score: Math.round(Number(r.score) * 100) / 100,
    })),
    edges: edgeRows.map((r) => ({ from: r.from, to: r.to, type: r.type })),
  };
}

module.exports = { godNodes, churnHotspots, importCycles, graphStats, exportGraph, STRUCTURAL_NOISE, TEMPORAL, DECLARATION_TYPES };
