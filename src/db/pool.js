'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { SqlitePool } = require('./sqlite-pool');

// The database is a file. KORAGRAPH_DB points at it; the default is graph.db under
// KORAGRAPH_HOME, or ~/.koragraph/graph.db — outside any repo, so one store serves every
// repository the developer indexes.
//
// `:memory:` is honoured for tests. A relative path is resolved against the process CWD, not this
// file, so a harness that cd's somewhere else still means what it says.
const DB_PATH = process.env.KORAGRAPH_DB
  || path.join(process.env.KORAGRAPH_HOME || path.join(require('os').homedir(), '.koragraph'), 'graph.db');

if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
}

const pool = new SqlitePool(DB_PATH);

// First run on an empty file: apply the schema rather than failing with "no such table" on the
// first query. Idempotent — every CREATE in schema.sql is IF NOT EXISTS or guarded by this check.
const hasSchema = pool.db
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'nodes'")
  .get().n > 0;
if (!hasSchema) pool.applySchema();

// A store that already HAS a schema never sees a later addition to schema.sql, because the line
// above only fires on an empty file. `nodes_fts` was added after this product had users, so every
// existing graph lacked it — and a retrieval clause naming a table that is not there raises
// "no such table", which protocol.js reads as a MISSING STORE and reports to the agent as
// "No code graph is indexed yet" on a fully populated graph.
//
// This is the narrowest possible upgrade: create the FTS objects if absent, backfill the rows that
// predate them, and touch nothing else. It is not a migration runner — `graph.db` is derived and
// disposable and deliberately has none — it is one idempotent repair for one table.
function schemaStatements() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Taken from schema.sql itself rather than restated here: two copies of a tokenizer choice is how
  // they drift. Split respecting BEGIN...END, because a trigger body is full of semicolons and a
  // naive split on `;` shreds it into fragments that fail with `near "CREATE": syntax error`.
  const statements = [];
  let current = '';
  let depth = 0;
  for (const line of schemaSql.split('\n')) {
    current += `${line}\n`;
    if (/^\s*BEGIN\b/i.test(line) || /\bBEGIN\s*$/i.test(line)) depth += 1;
    else if (/^\s*END\s*;/i.test(line)) depth = Math.max(0, depth - 1);
    if (depth === 0 && /;\s*$/.test(line)) {
      statements.push(current.trim());
      current = '';
    }
  }
  return statements;
}

// One idempotent repair for one FTS table: create its objects if absent and backfill the rows that
// predate them. Not a migration runner — graph.db is derived and disposable and deliberately has
// none. Both FTS planes need it: nodes_fts backs the exact channel, file_text_chunks_fts backs the
// lexical channel, and a store that predates either raises "no such table", which protocol.js reads
// as a MISSING STORE and reports as "No code graph is indexed yet" on a fully populated graph.
function ensureFts(statements, table, backfillSql) {
  const present = pool.db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table).n > 0;
  const re = new RegExp(`\\b${table}\\b`);
  // Not `/^CREATE/i`: a leading `--` comment line gets folded into this statement by the splitter
  // above, so anchoring to the START of the trimmed string misses the CREATE line whenever one is
  // added with an explanatory comment directly above it — the whole statement is then silently
  // excluded from ftsDdl, and the table is just never created (the backfill itself is not at fault).
  const ftsDdl = statements.filter((s) => re.test(s) && /CREATE\s+(VIRTUAL\s+TABLE|TRIGGER)/i.test(s));
  if (!ftsDdl.length) return;
  for (const stmt of ftsDdl) pool.db.exec(stmt);
  // Backfill only on first creation. The triggers keep it current from here, so re-running would
  // double every row.
  if (!present) pool.db.exec(backfillSql);
}

function ensureFtsTables() {
  if (!hasSchema) return;
  const statements = schemaStatements();
  ensureFts(statements, 'nodes_fts',
    'INSERT INTO nodes_fts(rowid, name, summary, raw_evidence) '
    + 'SELECT id, name, summary, raw_evidence FROM nodes '
    + 'WHERE id NOT IN (SELECT rowid FROM nodes_fts)');
  ensureFts(statements, 'file_text_chunks_fts',
    'INSERT INTO file_text_chunks_fts(rowid, chunk_text, search_text) '
    + 'SELECT id, chunk_text, search_text FROM file_text_chunks '
    + 'WHERE id NOT IN (SELECT rowid FROM file_text_chunks_fts)');
  // No `WHERE id NOT IN (...)` guard here, unlike the two calls above: file_source_cache_fts is
  // declared `content = 'file_source_cache'` (external content), and for such a table SQLite
  // answers a plain non-MATCH SELECT — count(*), a bare rowid scan — by reading straight through to
  // the backing table, even before a single row has been written to the FTS index proper. So a
  // `NOT IN (SELECT rowid FROM file_source_cache_fts)` guard reads as "every row already indexed"
  // on a genuinely empty index, and the backfill INSERT silently matches zero rows. `ensureFts`'s
  // own `if (!present)` already guards this to first-creation-only, so an unconditional insert here
  // is safe.
  //
  // `file_text_chunks_fts` above is declared `content = 'file_text_chunks'` — also external-content
  // — so its `WHERE id NOT IN (...)` backfill guard is exposed to the same defect on a store that
  // gets the table added after `file_text_chunks` already has rows. Same SQLite behavior, not
  // something specific to file_source_cache_fts; worth verifying directly before relying on it.
  ensureFts(statements, 'file_source_cache_fts',
    'INSERT INTO file_source_cache_fts(rowid, content) '
    + 'SELECT id, content FROM file_source_cache');
}

// Never fatal. A read-only handle, an FTS5 build without the trigram tokenizer, or a store another
// process is mid-write on must all leave retrieval working — the LIKE terms in
// retrieval-channels.js are the correctness floor and this is only an accelerator.
try {
  ensureFtsTables();
} catch (err) {
  if (process.env.KORAGRAPH_DEBUG) console.error(`[koragraph] fts upgrade skipped: ${err.message}`);
}

module.exports = pool;
