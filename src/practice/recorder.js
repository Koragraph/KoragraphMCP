'use strict';

const { openPracticeDb } = require('./db');
const { extractEvents } = require('./event-extract');

// The recorder does exactly one thing — append to `events`.
//
// It never opens graph.db. Not as a style preference: better-sqlite3 is synchronous with a busy
// wait, so a recorder that touched the graph would block the user's editor behind an ingest's
// write transaction, and `protocol.js` would launder the resulting SQLITE_BUSY into "No
// code graph is indexed yet". Separate file, separate connection, no shared lock.

const COLUMNS = [
  'session_id', 'agent_id', 'ts', 'event_type', 'tool_name', 'tool_use_id', 'repo_id',
  'file_path', 'hunk_index', 'old_start', 'old_lines', 'new_start', 'new_lines',
  'old_fingerprint', 'new_fingerprint', 'cmd', 'err_excerpt', 'payload', 'search_pattern',
];

const INSERT_SQL = `INSERT INTO events (${COLUMNS.join(', ')})
                    VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`;

function insertEvents(db, rows) {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_SQL);
  const write = db.transaction((batch) => {
    for (const r of batch) stmt.run(Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null])));
  });
  write(rows);
  return rows.length;
}

function record(input, { db = null, now = undefined } = {}) {
  const rows = extractEvents(input, now ? { now } : {});
  if (!rows.length) return { written: 0 };
  const owned = !db;
  const handle = db || openPracticeDb();
  try {
    return { written: insertEvents(handle, rows) };
  } finally {
    if (owned) handle.close();
  }
}

module.exports = { record, insertEvents, COLUMNS };
