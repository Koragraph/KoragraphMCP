// sql-ddl.js — deterministic (zero-token) SQL DDL parser. Parses CREATE TABLE
// statements into {table, columns} objects using node-sql-parser. Never throws: parse
// errors or non-DDL SQL (SELECT/INSERT/etc.) return [].

'use strict';

const { Parser } = require('node-sql-parser');

const DIALECTS = ['mysql', 'postgresql', 'sqlite', 'mssql'];

function extractColumnName(createDef) {
  const col = createDef.column && createDef.column.column;
  if (!col) return null;
  if (typeof col === 'string') return col;
  // Quoted identifiers (postgresql dialect) come back as { expr: { type, value } }.
  if (col.expr && typeof col.expr.value === 'string') return col.expr.value;
  return null;
}

function extractColumnType(createDef) {
  const def = createDef.definition;
  if (!def) return null;
  return def.dataType || null;
}

function astToTables(ast) {
  const statements = Array.isArray(ast) ? ast : [ast];
  const tables = [];
  for (const stmt of statements) {
    if (!stmt || stmt.type !== 'create' || stmt.keyword !== 'table') continue;
    const tableRef = Array.isArray(stmt.table) ? stmt.table[0] : stmt.table;
    const tableName = tableRef && (tableRef.table || tableRef);
    if (!tableName) continue;
    const columns = (stmt.create_definitions || [])
      .filter((cd) => cd.resource === 'column')
      .map((cd) => ({ name: extractColumnName(cd), type: extractColumnType(cd) }))
      .filter((c) => c.name);
    tables.push({ table: tableName, columns });
  }
  return tables;
}

// Split on semicolons that are not inside a string literal or a line/block
// comment. Crude by design — it only has to be right enough to isolate the
// CREATE TABLE statements the whole-file parse choked on.
function splitStatements(content) {
  const out = [];
  let buf = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (lineComment) { buf += ch; if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { buf += ch; if (ch === '*' && next === '/') { buf += next; i++; blockComment = false; } continue; }
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '-' && next === '-') { buf += ch; lineComment = true; continue; }
    if (ch === '/' && next === '*') { buf += ch; blockComment = true; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { buf += ch; quote = ch; continue; }
    if (ch === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Table-body clauses that declare a constraint rather than a column.
const CONSTRAINT_LEADERS = /^(?:primary|foreign|unique|key|constraint|index|check|fulltext|spatial|exclude|like|period)\b/i;

// Split a CREATE TABLE body on top-level commas (depth 0 only, so
// `DECIMAL(10, 2)` stays one clause).
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, buf = '', quote = null;
  for (const ch of body) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { buf += ch; quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

// Last-resort CREATE TABLE reader for statements no dialect grammar accepts.
// Measured need: H2's `VARCHAR_IGNORECASE(30)` column type is unknown to all
// four node-sql-parser dialects, which cost spring-petclinic the `owners` and
// `pets` tables — two of the seven the application is built on. A table node
// with a plainly-read column list is worth more to the graph than no node, and
// this only ever runs where the real parser has already refused.
function regexTables(stmt) {
  const m = /create\s+(?:\w+\s+)*table\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)[`"\]]?\s*\(([\s\S]*)\)/i.exec(stmt);
  if (!m) return [];
  const table = m[1].includes('.') ? m[1].split('.').pop() : m[1];
  const columns = [];
  for (const clause of splitTopLevel(m[2])) {
    const t = clause.trim();
    if (!t || CONSTRAINT_LEADERS.test(t)) continue;
    const c = /^[`"[]?([A-Za-z_]\w*)[`"\]]?\s+([A-Za-z_]\w*)/.exec(t);
    if (c) columns.push({ name: c[1], type: c[2].toUpperCase() });
  }
  return columns.length ? [{ table, columns }] : [];
}

// parseSqlDdl(content) -> [{ table, columns: [{name, type}] }]
// Zero-token, deterministic. Returns [] on parse failure or non-DDL content — never throws.
//
// Two passes, because whole-file parsing is all-or-nothing and real schema
// files carry dialect quirks node-sql-parser has no grammar for. Measured on
// spring-petclinic: `db/h2/schema.sql` opens with seven `DROP TABLE x IF
// EXISTS;` statements (H2 puts IF EXISTS after the name), which failed every
// dialect and took all seven CREATE TABLEs down with them — the file's whole
// schema plane, lost to one unsupported statement. The statement-level pass
// parses each statement on its own so an unparseable one costs only itself.
function parseSqlDdl(content) {
  if (!content || !content.trim()) return [];
  const parser = new Parser();
  for (const database of DIALECTS) {
    try {
      const ast = parser.astify(content, { database });
      const tables = astToTables(ast);
      if (tables.length > 0) return tables;
    } catch (_) {
      // try next dialect
    }
  }

  const byTable = new Map();
  for (const stmt of splitStatements(content)) {
    if (!/^\s*create\s+/i.test(stmt)) continue;
    let tables = [];
    for (const database of DIALECTS) {
      try {
        tables = astToTables(parser.astify(stmt, { database }));
      } catch (_) {
        continue;
      }
      if (tables.length) break;
    }
    if (!tables.length) tables = regexTables(stmt);
    for (const t of tables) if (!byTable.has(t.table)) byTable.set(t.table, t);
  }
  return [...byTable.values()];
}

module.exports = { parseSqlDdl };
