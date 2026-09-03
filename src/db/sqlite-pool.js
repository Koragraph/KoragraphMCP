'use strict';

// The pg-shaped shim over better-sqlite3.
//
// The driver-level defects handled here are all the same shape: the SQL is unchanged and the type
// mapping underneath it moved. Each is fixable here exactly once, or it leaks into hundreds of call
// sites where it is invisible in a diff.
//
// better-sqlite3 is synchronous. Every method below is still `async` because the tree it replaces
// awaits them, and because an accidental sync/async mismatch at 400 call sites is not worth the
// microseconds. The work itself does not yield.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const JSONB_COLUMNS = require('./jsonb-columns.json');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// ─── startup assertions ──────────────────────────────────────────────────────
//
// Two of these four are compile-time settings of whatever binary happens to ship, not language
// guarantees, so they are asserted rather than trusted. A better-sqlite3 built without FTS5
// ingests a graph perfectly and then answers nothing.
function assertDriverFloor(db) {
  const version = db.prepare('SELECT sqlite_version() AS v').get().v;
  const [maj, min] = version.split('.').map(Number);
  if (maj < 3 || (maj === 3 && min < 35)) {
    throw new Error(`SQLite ${version} is below the 3.35 floor RETURNING needs`);
  }

  // The ceiling is 32766 on this build, not the 999 of pre-3.32 defaults. Probed rather than
  // assumed, because it is SQLITE_MAX_VARIABLE_NUMBER at compile time.
  let paramCeiling = 0;
  for (const n of [999, 32766]) {
    try { db.prepare(`SELECT 1 WHERE 1 IN (${'?,'.repeat(n - 1)}?)`); paramCeiling = n; } catch { break; }
  }
  if (paramCeiling < 999) throw new Error(`SQLite parameter ceiling is below 999 (measured ${paramCeiling})`);

  // case_sensitive_like must be OFF. Every exact-channel ILIKE->LIKE swap depends on it, and
  // setting it flips all of them at once, silently.
  if (db.prepare("SELECT ('A' LIKE 'a') AS x").get().x !== 1) {
    throw new Error('LIKE is case-sensitive — PRAGMA case_sensitive_like must never be set');
  }

  // The lexical channel is one of three, and it is FTS5 or nothing. Probe in `temp.`, which is the
  // whole point: whether FTS5 is compiled into this driver is a fact about the BUILD, and asking it
  // by writing to the shared database file makes every open — including a read-only one — queue
  // behind whatever holds the write lock and return SQLITE_BUSY, telling an agent querying during
  // an ingest that the store is unusable. The temp database is per-connection, so this also avoids
  // any two-pools race: no other connection can see this table, let alone drop it first.
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp._fts5_probe USING fts5(a)');
    db.exec('DROP TABLE IF EXISTS temp._fts5_probe');
  } catch (err) {
    // A busy error must still reach protocol.js's classifier with its code intact rather than
    // being rewritten as a build problem.
    if (err.code) throw err;
    throw new Error(`better-sqlite3 was built without FTS5 (${err.message})`);
  }

  return { version, paramCeiling };
}

// ─── $n → ? ──────────────────────────────────────────────────────────────────
//
// Not a String.replace. Replacing `$1` before `$10` corrupts `$10`-`$19`, and `$` inside a string
// literal must be left alone. This lexes the statement and emits one `?` per occurrence, pushing
// the corresponding value each time — so a repeated `$1` (common: `IN (SELECT value FROM json_each($1)) OR ... IN (SELECT value FROM json_each($1))`)
// binds correctly, which an index-order translation cannot do.
//
// A missed `$n` does NOT raise a syntax error, because `$1` is itself legal SQLite named-parameter
// syntax. It surfaces as "Too many parameter values were provided", which reads like a caller bug.
function translatePlaceholders(sql, params) {
  const out = [];
  const values = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      out.push(c); i++;
      while (i < sql.length) {
        out.push(sql[i]);
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out.push(sql[++i]); i++; continue; }  // '' escape
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') out.push(sql[i++]);
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      out.push(sql[i++], sql[i++]);
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) out.push(sql[i++]);
      if (i < sql.length) out.push(sql[i++], sql[i++]);
      continue;
    }
    if (c === '$') {
      const m = /^\$(\d+)/.exec(sql.slice(i));
      if (m) {
        const idx = Number(m[1]) - 1;
        if (idx < 0 || idx >= params.length) {
          throw new Error(`SQL references $${m[1]} but only ${params.length} parameter(s) were supplied`);
        }
        out.push('?');
        values.push(params[idx]);
        i += m[0].length;
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return { sql: out.join(''), values };
}

// ─── parameter coercion ──────────────────────────────────────────────────────
//
// run(true) and run(new Date()) both throw "SQLite3 can only bind numbers, strings, bigints,
// buffers, and null" — loud, but mid-ingest rather than at load. Coerced here rather than at the
// binding sites.
function coerceParam(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);   // jsonb params, json_each arrays
  return v;
}

// Raised by _deadline_check(). Replaces Postgres SQLSTATE 57014 (query_canceled), which
// better-sqlite3 never produces — it raises SQLITE_ERROR for everything, so any `err.code ===
// '57014'` check silently stops matching and the error escapes instead of degrading the channel.
const QUERY_TIMEOUT_CODE = 'KORAGRAPH_QUERY_TIMEOUT';

// Did this result column come out of a json_* function? Decided from the statement, never from
// the row's contents — see the note in _prepare.
//
// `snippet` and `highlight` are FTS5 text shapers and are deliberately NOT on this list; they
// return document text, which for an ingested .json file is valid JSON.
const JSON_FN = 'json_extract|json_object|json_array|json_group_array|json_group_object'
  + '|json_insert|json_set|json_replace|json_remove|json_patch|json_quote|json_merge'
  + '|json_merge_arrays';

function producedByJsonFunction(sql, name) {
  if (!name) return false;
  // An unaliased expression takes the expression text as its column name.
  if (new RegExp(`^\\s*(?:${JSON_FN})\\s*\\(`, 'i').test(name)) return true;
  const alias = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:${JSON_FN})\\s*\\([\\s\\S]*?\\)\\s+AS\\s+["'\`]?${alias}["'\`]?\\b`, 'i').test(sql);
}

// Two coding-agent sessions can point `koragraph mcp` at the same store at once, and the moment
// each one opens its own connection is exactly when a second writer (another session, or an
// ingest) is most likely to be mid-transaction. Without a busy_timeout, better-sqlite3 surfaces
// SQLITE_BUSY the instant it cannot get the lock, and protocol.js turns that into a "store busy,
// retry" tool error on a call that would have gone through half a second later. Same fix,
// same rationale, as practice/db.js's BUSY_TIMEOUT_MS — set it low enough that a genuinely stuck
// writer (a multi-minute full ingest) still fails fast rather than hanging the caller.
const BUSY_TIMEOUT_MS = 2000;

class SqlitePool {
  constructor(filename, { readonly = false } = {}) {
    this.db = new Database(filename, { readonly });
    this.driver = assertDriverFloor(this.db);

    // Never case_sensitive_like. WAL + NORMAL is the standard local durability trade; foreign_keys
    // is OFF by default in SQLite and the schema relies on it.
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // SQLite's builtin lower()/upper() are ASCII-only — lower('ÜNICODE') is 'Ünicode'. The
    // equality tiers in retrieval-channels.js compare lower() to lower(), so a non-ASCII identifier
    // silently stops matching. Overriding the builtin is allowed and is the only fix that reaches
    // every call site.
    this.db.function('lower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
    this.db.function('upper', { deterministic: true }, (s) => (s == null ? null : String(s).toUpperCase()));

    // SQLite has no regex. Postgres's 'g'/'n' flags map to JS 'g'/'m'.
    //
    // varargs, because better-sqlite3 otherwise infers a FIXED arity from fn.length and the tree
    // calls this with both three and four arguments. A fixed arity fails the three-arg call at
    // PREPARE time with "wrong number of arguments", so it would not even reach a query.
    this.db.function('regexp_replace', { deterministic: true, varargs: true }, (s, pattern, replacement, flags) => {
      if (s == null || pattern == null) return s ?? null;
      const jsFlags = String(flags || '').replace(/n/g, 'm').replace(/[^gimsuy]/g, '');
      return String(s).replace(new RegExp(pattern, jsFlags), replacement ?? '');
    });

    // Bounded: retrieval-channels.js builds its exact-channel SQL per query (one clause per
    // needle), so the statement text is not a small fixed set. FIFO eviction — a prepared
    // statement is cheap to rebuild and expensive to leak.
    // Postgres's jsonb `||` — shallow object merge, right wins. SQLite has no operator for it,
    // and json_patch() is NOT it: RFC 7396 DELETES any key whose value in the right operand is
    // null, and nodes routinely carry null-valued keys, so json_patch would silently drop those
    // keys on every re-ingest merge. This does exactly what `||` does.
    this.db.function('json_merge', { deterministic: true }, (a, b) => {
      const parse = (v) => {
        if (v == null) return {};
        try { const o = JSON.parse(v); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
        catch { return {}; }
      };
      return JSON.stringify({ ...parse(a), ...parse(b) });
    });

    // Union of two extraction_source markers, each of which may be a scalar or an array — the
    // shape writeNode's upsert has to reconcile. Postgres expressed it with jsonb || over
    // CASE-wrapped jsonb_array_elements; this is the same union with the scalar/array split
    // handled once, in one place, instead of twice in SQL.
    this.db.function('json_merge_arrays', { deterministic: true }, (a, b) => {
      const arr = (v) => {
        if (v == null) return [];
        try { const o = JSON.parse(v); return Array.isArray(o) ? o : [o]; } catch { return [v]; }
      };
      return JSON.stringify([...arr(a), ...arr(b)]);
    });

    // SQLite parses `x REGEXP y` but ships no implementation, and has no case-insensitive variant
    // at all. Postgres's ~ and ~* both map here; the 'i' flag is chosen by the caller rewriting ~*
    // to regexp_i. \m (a Postgres word-boundary) becomes \b.
    const rx = (flags) => (pattern, value) => {
      if (value == null || pattern == null) return 0;
      try { return new RegExp(String(pattern).replace(/\\m/g, '\\b'), flags).test(String(value)) ? 1 : 0; }
      catch { return 0; }
    };
    this.db.function('regexp', { deterministic: true }, rx(''));
    this.db.function('regexp_i', { deterministic: true }, rx('i'));

    // An in-query deadline, because there is no other kind available. `SET LOCAL statement_timeout`
    // has no SQLite equivalent; better-sqlite3 exposes neither interrupt() nor a progress-handler
    // binding, and a setImmediate deadline cannot fire because the driver is synchronous and the
    // event loop is blocked for the whole query.
    //
    // What does work: SQLite aborts a statement when a user-defined function raises, and
    // better-sqlite3 propagates the thrown error with its own properties intact. Declared
    // non-deterministic so SQLite cannot hoist it out of the row loop, so it runs once per row and
    // a throw aborts at the call it fires on. The guard exists because this query can run long, and
    // losing it turns a slow query into a hang.
    this._deadlineAt = 0;
    this._deadlineTick = 0;
    this.db.function('_deadline_check', { deterministic: false }, () => {
      // Date.now() per row would cost more than the check saves; every 256th row bounds the
      // overshoot to a few milliseconds on any query worth timing out.
      if ((this._deadlineTick++ & 0xff) !== 0) return 1;
      if (this._deadlineAt && Date.now() > this._deadlineAt) {
        const err = new Error('query exceeded its deadline');
        err.code = QUERY_TIMEOUT_CODE;
        throw err;
      }
      return 1;
    });

    this._stmtCache = new Map();
    this._stmtCacheMax = 512;
    this._txDepth = 0;
    this._savepointSeq = 0;
  }

  static open(filename, opts) { return new SqlitePool(filename, opts); }

  applySchema() {
    this.db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }

  _prepare(sql) {
    let entry = this._stmtCache.get(sql);
    if (entry) return entry;
    const stmt = this.db.prepare(sql);
    // Driven by the jsonb column map. stmt.columns() reports the ORIGIN table and column of every
    // result column — `null` for an expression — so an aliased `e.properties AS ep` is still
    // recognised and a `count(*) AS nodes` is still left alone. Matching on the column NAME alone
    // would do neither.
    //
    // A second class the origin map cannot see: a COMPUTED column. Postgres's `properties->'imports'`
    // returned jsonb and node-postgres parsed it, so callers read `row.imports` as a live array.
    // `json_extract(properties,'$.imports')` returns TEXT and reports table:null, so origin
    // matching leaves it a string, `Array.isArray(row.imports)` is false, and the import plane
    // yields zero facts with no error.
    //
    // Expression columns are therefore parsed too — but the candidate set is decided by the SQL,
    // not by what the DATA happens to look like.
    //
    // "Parse it if the text looks like JSON" is not safe here, because this product INGESTS JSON
    // FILES AS SOURCE. A chunk of package.json or tsconfig.json is valid JSON by definition, so
    // `substr(chunk_text, ...)` and FTS5's `snippet()` — both expressions, both returning text —
    // would hand the caller an object where every consumer expects a string.
    //
    // So a column qualifies only when the statement shows it came from a json_* function.
    let jsonCols = null;
    let maybeJsonCols = null;
    if (stmt.reader) {
      const cols = stmt.columns();
      jsonCols = cols
        .filter((c) => c.table && (JSONB_COLUMNS[c.table] || []).includes(c.column))
        .map((c) => c.name);
      maybeJsonCols = cols
        .filter((c) => !c.table && !c.column && producedByJsonFunction(sql, c.name))
        .map((c) => c.name);
      if (!jsonCols.length) jsonCols = null;
      if (!maybeJsonCols.length) maybeJsonCols = null;
    }
    entry = { stmt, jsonCols, maybeJsonCols };
    if (this._stmtCache.size >= this._stmtCacheMax) {
      this._stmtCache.delete(this._stmtCache.keys().next().value);
    }
    this._stmtCache.set(sql, entry);
    return entry;
  }

  _hydrate(rows, jsonCols, maybeJsonCols) {
    if (!jsonCols && !maybeJsonCols) return rows;
    for (const row of rows) {
      if (jsonCols) {
        for (const c of jsonCols) {
          const v = row[c];
          if (typeof v !== 'string') continue;
          try { row[c] = JSON.parse(v); } catch { /* not JSON — leave the raw text */ }
        }
      }
      if (maybeJsonCols) {
        for (const c of maybeJsonCols) {
          const v = row[c];
          if (typeof v !== 'string' || v.length < 2) continue;
          const head = v[0];
          if (head !== '[' && head !== '{') continue;
          try {
            const parsed = JSON.parse(v);
            if (parsed && typeof parsed === 'object') row[c] = parsed;
          } catch { /* not JSON — leave the raw text */ }
        }
      }
    }
    return rows;
  }

  // A transaction control statement, or null. `BEGIN READ ONLY` does not parse in SQLite.
  _txVerb(sql) {
    const m = /^\s*(BEGIN(?:\s+(?:READ\s+ONLY|READ\s+WRITE|DEFERRED|IMMEDIATE|EXCLUSIVE|TRANSACTION))?|COMMIT|END|ROLLBACK)\b/i.exec(sql);
    if (!m) return null;
    const verb = m[1].trim().split(/\s+/)[0].toUpperCase();
    return verb === 'END' ? 'COMMIT' : verb;
  }

  // BEGIN inside BEGIN is a hard error in SQLite ("cannot start a transaction within a
  // transaction"), not a no-op. Depth 0 gets a real transaction; anything deeper gets a savepoint.
  _runTx(verb) {
    if (verb === 'BEGIN') {
      if (this._txDepth === 0) this.db.exec('BEGIN');
      else this.db.exec(`SAVEPOINT sp${this._savepointSeq++}`);
      this._txDepth++;
      return;
    }
    if (this._txDepth === 0) return;      // COMMIT/ROLLBACK with nothing open — pg tolerates it
    this._txDepth--;
    if (this._txDepth === 0) {
      this.db.exec(verb === 'COMMIT' ? 'COMMIT' : 'ROLLBACK');
    } else {
      const sp = `sp${this._savepointSeq - 1}`;
      this._savepointSeq--;
      this.db.exec(verb === 'COMMIT' ? `RELEASE ${sp}` : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    }
  }

  async query(text, params = []) {
    const sql = typeof text === 'string' ? text : text.text;
    const values = typeof text === 'string' ? params : (text.values || params);

    const verb = this._txVerb(sql);
    if (verb) { this._runTx(verb); return { rows: [], rowCount: 0, command: verb }; }

    const translated = translatePlaceholders(sql, values || []);
    const bound = translated.values.map(coerceParam);
    const { stmt, jsonCols, maybeJsonCols } = this._prepare(translated.sql);

    // Branch on stmt.reader, NEVER on the SQL verb. `INSERT ... RETURNING` run through .run()
    // reports { changes: 1 } and discards its rows with no error — which would make a claim loop
    // spin forever on a queue it is successfully draining.
    if (stmt.reader) {
      const rows = this._hydrate(stmt.all(...bound), jsonCols, maybeJsonCols);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...bound);
    // Many call sites read rowCount, and `undefined === 0` is false — omitting it takes a silently
    // wrong branch rather than crashing.
    return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  // Some callers check out a transaction-scoped client. There is one connection, so the client is
  // the pool with a release() that does nothing but satisfy the contract.
  async connect() {
    const self = this;
    return {
      query: (text, params) => self.query(text, params),
      release: () => {},
    };
  }

  // The ceiling probed above is a limit on BOUND PARAMETERS, and every bulk INSERT in the tree
  // binds `paramsPerRow` of them per row — so the row count a chunk may carry is the ceiling
  // divided by that width, never a constant. A hardcoded chunk size can bind past the ceiling and
  // throw `too many SQL variables`, and because the first slice is `slice(0, CHUNK)` the loss is
  // all-or-nothing: a whole edge plane can go missing while the ingest still reports success.
  safeChunk(paramsPerRow) {
    if (!Number.isInteger(paramsPerRow) || paramsPerRow < 1) {
      throw new Error(`safeChunk needs a positive integer params-per-row (got ${paramsPerRow})`);
    }
    return Math.max(1, Math.floor(this.driver.paramCeiling / paramsPerRow));
  }

  // Arms the deadline for the calling query and returns a release. Not re-entrant by design:
  // there is one connection and one query in flight at a time.
  setQueryDeadline(ms) {
    this._deadlineAt = ms > 0 ? Date.now() + ms : 0;
    this._deadlineTick = 0;
    return () => { this._deadlineAt = 0; };
  }

  async end() { this.db.close(); }
  get open() { return this.db.open; }
}

module.exports = { SqlitePool, translatePlaceholders, coerceParam, assertDriverFloor, QUERY_TIMEOUT_CODE };
