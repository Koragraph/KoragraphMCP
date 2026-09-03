'use strict';

const fs = require('fs');
const path = require('path');

const pool = require('../db/pool');
const { edgeWriteTier } = require('./resolution/tiers');
const { parseSqlDdl } = require('./contract-parsers/sql-ddl');

// Post-tail resolver linking every .sql file to the tables it touches.
//
// The CONTRACT_SQL pass writes DB_TABLE nodes, but a table is one node per
// branch (canonical-key deduped), so when a repo ships the same schema for
// several engines only the LAST file to declare a table ends up owning it.
// Measured on spring-petclinic: all seven DB_TABLE nodes anchored to
// `db/postgres/schema.sql`, leaving `db/h2/schema.sql` and `db/mysql/schema.sql`
// as isolated vertices despite declaring the same seven tables — and the three
// `data.sql` seed files isolated too, since an INSERT declares nothing.
//
// Dedup is right (one table, one node). Losing the other declaration sites is
// not: "where is this table defined for MySQL" is a question the graph should
// answer. This writes the missing edges from each file to the tables it
// actually names:
//
//   FILE -[CONTAINS]->     DB_TABLE   the file declares it (CREATE TABLE)
//   FILE -[WRITES_TABLE]-> DB_TABLE   the file seeds/mutates it (INSERT/UPDATE)
//
// Zero-token: the same deterministic DDL parser plus one regex for DML.

const DML_RE = /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+[`"[]?([A-Za-z_][\w$]*)[`"\]]?/gi;
const MAX_SQL_BYTES = 2_000_000;

async function resolveSqlFileTableEdges(branchId, repoPath, _pool = pool) {
  if (!repoPath || !fs.existsSync(repoPath)) return { files: 0, declares: 0, writes: 0 };

  const { rows: tableRows } = await _pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1 AND node_type = 'DB_TABLE' AND approval_status != 'ARCHIVED'`,
    [branchId]
  );
  if (!tableRows.length) return { files: 0, declares: 0, writes: 0 };
  const tableByName = new Map();
  for (const t of tableRows) {
    const k = (t.name || '').toLowerCase();
    if (k && !tableByName.has(k)) tableByName.set(k, t.id);
  }

  const { rows: fileNodes } = await _pool.query(
    `SELECT n.id AS node_id, f.path
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.node_type = 'FILE' AND n.approval_status != 'ARCHIVED'
       AND lower(f.path) LIKE '%.sql'`,
    [branchId]
  );
  if (!fileNodes.length) return { files: 0, declares: 0, writes: 0 };

  const edgeRows = [];
  let declares = 0, writes = 0, files = 0;

  for (const fn of fileNodes) {
    let content;
    try {
      const full = path.join(repoPath, fn.path);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_SQL_BYTES) continue;
      content = fs.readFileSync(full, 'utf8');
    } catch (_) {
      continue;
    }
    files++;

    const declared = new Set();
    for (const t of parseSqlDdl(content)) {
      const target = tableByName.get(String(t.table).toLowerCase());
      if (!target || target === fn.node_id) continue;
      declared.add(target);
      edgeRows.push({ from: fn.node_id, to: target, edgeType: 'CONTAINS', resolution: 'sql_reference', calledName: t.table });
      declares++;
    }

    DML_RE.lastIndex = 0;
    const seenDml = new Set();
    let m;
    while ((m = DML_RE.exec(content)) !== null) {
      const name = m[1].toLowerCase();
      const target = tableByName.get(name);
      // A file that already CREATEs the table does not also need a write edge
      // to it from the same statement set — the declaration is the stronger fact.
      if (!target || target === fn.node_id || declared.has(target) || seenDml.has(target)) continue;
      seenDml.add(target);
      edgeRows.push({ from: fn.node_id, to: target, edgeType: 'WRITES_TABLE', resolution: 'sql_reference', calledName: m[1] });
      writes++;
    }
  }

  let written = 0;
  if (edgeRows.length) {
    const params = [];
    const values = edgeRows.map(({ from, to, edgeType, resolution, calledName }) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, edgeType);
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution, called_name: calledName }), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    const { rowCount } = await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${values.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written = rowCount ?? edgeRows.length;
  }

  console.log(`[sql-file-graph] branchId=${branchId} sql_files=${files} declares=${declares} writes=${writes} written=${written}`);
  return { files, declares, writes, written };
}

module.exports = { resolveSqlFileTableEdges };
