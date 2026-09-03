'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { practiceDbPath } = require('./paths');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Not SqlitePool. That shim exists to make better-sqlite3 look like node-postgres for the ~400
// graph call sites that await it, and it asserts FTS5 by CREATEing a probe table — which cannot run
// on a read-only handle. The practice store has none of those constraints and one hard one the
// graph does not: the recorder runs inside a hook with a 5 s budget, so the calls must be
// synchronous and the busy wait must expire before the hook is killed.
const BUSY_TIMEOUT_MS = 2000;

function discoverMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
      return {
        version: parseInt(filename.split('_')[0], 10),
        filename,
        sql,
        // Hash the string already read, never the file again: two reads is two truths.
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

// Which named objects a migration declares. Used only by the backfill below, to tell a migration
// that ran before schema_migrations existed from one that simply happens to carry a low number.
// ALTER TABLE ... ADD COLUMN declares nothing sqlite_master can be asked about, so a migration made
// only of those returns [] and the backfill falls back to trusting the high-water mark.
const DECLARES = /CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)/gi;

function declaredObjects(sql) {
  return [...sql.matchAll(DECLARES)].map((m) => m[1]);
}

// Applied migrations are tracked INDIVIDUALLY, not by a high-water mark: migration numbers are
// assigned per author and land out of order (005 can be applied to the live store while 004 does
// not exist yet), and a `version <= max` test would then skip 004 forever, silently.
// `schema_version` is still maintained as the maximum, because it is what an operator reads.
//
// The checksum is load-bearing: keying only on the version number means a file saved half-written
// (e.g. edited while an ingest has this store open) is applied, recorded, and its finished form made
// permanently unreachable. The checksum makes an edited migration detectable.
function appliedSet(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations ('
    + 'version INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TEXT NOT NULL)');
  // SQLite has no ADD COLUMN IF NOT EXISTS.
  const cols = db.pragma('table_info(schema_migrations)').map((c) => c.name);
  if (!cols.includes('checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  const out = new Map();
  for (const r of db.prepare('SELECT version, filename, checksum FROM schema_migrations').all()) {
    out.set(r.version, r);
  }
  return out;
}

function migrate(db, dir = MIGRATIONS_DIR) {
  const discovered = discoverMigrations(dir);

  // The WHOLE pass runs inside one BEGIN IMMEDIATE transaction, and every read of applied state
  // happens INSIDE it. busy_timeout makes a concurrent opener WAIT for the write lock rather than
  // throw SQLITE_BUSY, so acquiring it up front serialises migration application across processes:
  // N processes opening a fresh or newly-upgraded store, each snapshotting the applied-set BEFORE
  // taking the lock, would all re-run the same non-idempotent DDL and throw "table already exists"
  // / "duplicate column". Re-reading under the lock makes check-then-apply atomic. All-or-nothing
  // on failure is strictly safer than a per-migration commit (a half-applied schema is worse than a
  // failed open); migrations already assume they run inside a transaction, so nothing changes for them.
  const runAll = db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    let row = db.prepare('SELECT version FROM schema_version').get();
    if (!row) {
      db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
      row = { version: 0 };
    }

    const done = appliedSet(db);
    const record = db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, filename, applied_at, checksum) VALUES (?,?,?,?)',
    );
    const adopt = db.prepare('UPDATE schema_migrations SET checksum = ?, filename = ? WHERE version = ?');
    const objectExists = db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?');

    // A store written before schema_migrations existed knows only its high-water mark. Marking every
    // version at or below it "applied" is safe ONLY if numbers were allocated in ascending time
    // order — and this project allocates them per author (003 to one agent, 004 to another), so a
    // brand-new migration numbered below the mark would be recorded as done without its SQL ever
    // running. So a migration is only assumed-applied when something it declares is actually there.
    if (!done.size && row.version > 0) {
      for (const m of discovered) {
        if (m.version > row.version) continue;
        const objects = declaredObjects(m.sql);
        if (objects.length && !objects.some((name) => objectExists.get(name))) continue;
        // checksum NULL: adopted from a high-water mark, never verified against what actually ran.
        record.run(m.version, m.filename, new Date().toISOString(), null);
        done.set(m.version, { version: m.version, filename: m.filename, checksum: null });
      }
    }

    let applied = 0;
    const adopted = [];
    for (const m of discovered) {
      const prior = done.get(m.version);
      if (prior) {
        if (prior.checksum === m.checksum) continue;
        if (prior.checksum === null) {
          // Trust on first use. There is no record of what ran, so the only options are to adopt or
          // to refuse forever; adopting makes every SUBSEQUENT edit detectable, which is the point.
          adopt.run(m.checksum, m.filename, m.version);
          adopted.push(m.filename);
          continue;
        }
        throw new Error(
          `practice.db: migration ${m.filename} has changed since it was applied `
          + `(recorded ${prior.checksum.slice(0, 12)}, file ${m.checksum.slice(0, 12)}). `
          + 'The store is behind the file. Re-applying an edited migration to a live store is not '
          + 'safe to do automatically — resolve it by hand.',
        );
      }
      db.exec(m.sql);
      record.run(m.version, m.filename, new Date().toISOString(), m.checksum);
      db.prepare('UPDATE schema_version SET version = max(version, ?)').run(m.version);
      done.set(m.version, { version: m.version, filename: m.filename, checksum: m.checksum });
      applied++;
    }
    return { applied, adopted };
  });

  const { applied, adopted } = runAll.immediate();
  return {
    version: db.prepare('SELECT version FROM schema_version').get().version, applied, adopted,
  };
}

function openPracticeDb({ file = null, readonly = false, migrationsDir = MIGRATIONS_DIR } = {}) {
  const target = file || practiceDbPath();
  if (target !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const db = new Database(target, { readonly });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (!readonly) {
    // WAL so a revalidation pass reading the store cannot block a hook appending to it. Several
    // sessions and subagents write here concurrently.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    migrate(db, migrationsDir);
  } else {
    db.pragma('foreign_keys = ON');
  }
  return db;
}

module.exports = { openPracticeDb, migrate, discoverMigrations, MIGRATIONS_DIR, BUSY_TIMEOUT_MS };
