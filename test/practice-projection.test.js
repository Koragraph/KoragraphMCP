'use strict';

// Coverage for the deterministic Markdown projection of the practice store.
//
// The projection is a one-way, deterministic VIEW: same store state ⇒ byte-identical files. These
// tests pin the four properties that make that view trustworthy — determinism, idempotent writes,
// minimal single-file diffs, and never writing back to the store — plus the format details a human
// reads (needs-attention surfacing, symbol nesting, stale-file deletion).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openPracticeDb } = require('../src/practice/db');
const { readSnapshot } = require('../src/practice/project/snapshot');
const { render } = require('../src/practice/project/render');
const { writeProjection } = require('../src/practice/project/writer');
const { projectOnce } = require('../src/practice/project/daemon');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kg-projection-'));
}

// A real store on disk, built through the real migrations, seeded with a spread of facts and
// anchors that exercises every rendering branch.
function seededStore() {
  const dir = tmpDir();
  const file = path.join(dir, 'practice.db');
  const db = openPracticeDb({ file });
  const now = '2026-01-01T00:00:00.000Z';
  const insFact = db.prepare(
    `INSERT INTO facts (id, kind, tier, body, evidence, source, recurrence, created_at,
       expired_at, expiry_reason, contradicted_at, contradicted_reason, unconfirmed_since)
     VALUES (@id,@kind,@tier,@body,'',@source,@recurrence,@created_at,
       @expired_at,@expiry_reason,@contradicted_at,@contradicted_reason,@unconfirmed_since)`,
  );
  const insAnchor = db.prepare(
    `INSERT INTO anchors (fact_id, repo_id, file_path, symbol_name, grain, renamed_from)
     VALUES (@fact_id,@repo_id,@file_path,@symbol_name,@grain,@renamed_from)`,
  );
  const fact = (o) => insFact.run({
    expired_at: null, expiry_reason: null, contradicted_at: null, contradicted_reason: null,
    unconfirmed_since: null, source: 'user', recurrence: 1, created_at: now, ...o,
  });
  const anchor = (o) => insAnchor.run({ symbol_name: null, renamed_from: null, ...o });

  // 1: live, file-grain, human.
  fact({ id: 1, kind: 'law', tier: 'law', body: 'Always run migrations forward.' });
  anchor({ fact_id: 1, repo_id: 'github.com/acme/app', file_path: 'src/db.js', grain: 'file' });
  // 2: live, symbol-grain, agent — nests under its symbol in the same file as fact 1.
  fact({ id: 2, kind: 'hazard', tier: 'observation', body: 'openDb leaks a handle on error.', source: 'harvest' });
  anchor({ fact_id: 2, repo_id: 'github.com/acme/app', file_path: 'src/db.js', symbol_name: 'openDb', grain: 'symbol' });
  // 3: repo-grain → _general.md.
  fact({ id: 3, kind: 'ritual', tier: 'law', body: 'Run the linter before pushing.' });
  anchor({ fact_id: 3, repo_id: 'github.com/acme/app', file_path: '', grain: 'repo' });
  // 4: contradicted → needs attention.
  fact({ id: 4, kind: 'law', tier: 'law', body: 'The default branch is dev.',
    contradicted_at: now, contradicted_reason: 'only main exists' });
  anchor({ fact_id: 4, repo_id: 'github.com/acme/app', file_path: '', grain: 'repo' });
  // 5: unconfirmed → needs attention.
  fact({ id: 5, kind: 'correction', tier: 'hypothesis', body: 'Cache TTL should be 60s.',
    unconfirmed_since: now });
  anchor({ fact_id: 5, repo_id: 'github.com/acme/app', file_path: 'src/cache.js', grain: 'file' });
  // 6: expired → rendered but not attention.
  fact({ id: 6, kind: 'hazard', tier: 'observation', body: 'Old race in the poller.',
    expired_at: now, expiry_reason: 'orphaned' });
  anchor({ fact_id: 6, repo_id: 'github.com/acme/app', file_path: 'src/poll.js', grain: 'file' });
  // 7: one fact, two anchors in two repos → appears in two files.
  fact({ id: 7, kind: 'law', tier: 'law', body: 'Shared table orders is a contract.' });
  anchor({ fact_id: 7, repo_id: 'github.com/acme/app', file_path: 'src/orders.js', grain: 'file' });
  anchor({ fact_id: 7, repo_id: 'github.com/acme/svc', file_path: 'orders.py', grain: 'file' });

  db.close();
  return { dir, file };
}

function withReadonly(file, fn) {
  const db = openPracticeDb({ file, readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('render is deterministic: same store yields byte-identical output', () => {
  const { file } = seededStore();
  const a = withReadonly(file, (db) => render(readSnapshot(db)));
  const b = withReadonly(file, (db) => render(readSnapshot(db)));
  assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const key of Object.keys(a)) assert.strictEqual(a[key], b[key], `mismatch in ${key}`);
});

test('a fact with two anchors renders in both files', () => {
  const { file } = seededStore();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  assert.ok(files['github.com/acme/app/src/orders.js.md'].includes('Shared table orders'));
  assert.ok(files['github.com/acme/svc/orders.py.md'].includes('Shared table orders'));
});

test('symbol-grain facts nest under a symbol subsection in the file', () => {
  const { file } = seededStore();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  const md = files['github.com/acme/app/src/db.js.md'];
  assert.ok(md.includes('# github.com/acme/app/src/db.js'));
  assert.ok(md.includes('## openDb'), 'symbol subsection heading');
  assert.ok(md.includes('### openDb — hazard'));
  // File-level fact comes before the symbol subsection.
  assert.ok(md.indexOf('Always run migrations') < md.indexOf('## openDb'));
});

test('repo-grain facts land in _general.md', () => {
  const { file } = seededStore();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  assert.ok(files['github.com/acme/app/_general.md'].includes('Run the linter before pushing.'));
});

test('MEMORY.md surfaces contradicted and unconfirmed, not expired or live', () => {
  const { file } = seededStore();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  const mem = files['MEMORY.md'];
  const attention = mem.slice(mem.indexOf('## Needs attention'), mem.indexOf('## Index'));
  assert.ok(attention.includes('❌ CONTRADICTED'));
  assert.ok(attention.includes('⚠️ UNCONFIRMED'));
  assert.ok(!attention.includes('Always run migrations'), 'live fact must not be flagged');
  assert.ok(!attention.includes('Old race in the poller'), 'expired fact must not be flagged');
  // Contradicted is ranked ahead of unconfirmed.
  assert.ok(attention.indexOf('❌ CONTRADICTED') < attention.indexOf('⚠️ UNCONFIRMED'));
});

test('writeProjection is idempotent: a second pass writes nothing', () => {
  const { file } = seededStore();
  const out = tmpDir();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  const first = writeProjection(out, files);
  assert.ok(first.written > 0);
  const second = writeProjection(out, files);
  assert.strictEqual(second.written, 0);
  assert.strictEqual(second.deleted, 0);
  assert.ok(second.unchanged > 0);
});

test('changing one fact rewrites exactly one file', () => {
  const { file } = seededStore();
  const out = tmpDir();
  writeProjection(out, withReadonly(file, (db) => render(readSnapshot(db))));

  const db = openPracticeDb({ file });
  db.prepare('UPDATE facts SET body = ? WHERE id = 1').run('Always run migrations forward, twice.');
  db.close();

  const tally = writeProjection(out, withReadonly(file, (db) => render(readSnapshot(db))));
  assert.strictEqual(tally.written, 1, 'exactly one file changed');
  assert.strictEqual(tally.deleted, 0);
});

test('a removed fact deletes its now-empty file', () => {
  const { file } = seededStore();
  const out = tmpDir();
  writeProjection(out, withReadonly(file, (db) => render(readSnapshot(db))));
  assert.ok(fs.existsSync(path.join(out, 'github.com/acme/app/src/cache.js.md')));

  const db = openPracticeDb({ file });
  db.prepare('DELETE FROM facts WHERE id = 5').run(); // sole fact in cache.js
  db.close();

  const tally = writeProjection(out, withReadonly(file, (db) => render(readSnapshot(db))));
  assert.strictEqual(tally.deleted, 1);
  assert.ok(!fs.existsSync(path.join(out, 'github.com/acme/app/src/cache.js.md')));
});

test('projectOnce never writes memory back to practice.db', () => {
  const { file } = seededStore();
  const out = tmpDir();
  // The true invariant: the store's contents are identical after a projection. (A read-only WAL
  // connection legitimately touches -wal/-shm — SQLite's shared-memory index — which is not a
  // write to any fact, so we compare rows, not sidecar files.)
  const digest = () => withReadonly(file, (db) => JSON.stringify({
    facts: db.prepare('SELECT * FROM facts ORDER BY id').all(),
    anchors: db.prepare('SELECT * FROM anchors ORDER BY fact_id, repo_id, file_path, symbol_name').all(),
  }));
  const before = digest();
  const mtime = fs.statSync(file).mtimeMs;
  projectOnce({ file, outDir: out });
  assert.strictEqual(digest(), before, 'facts and anchors must be unchanged');
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime, 'main db file must not change');
});

// ---------------------------------------------------------------------------
// Hardening: adversarial inputs and invariants the renderer must hold no matter
// what the store contains. These drive render() directly with hand-built
// snapshots so a single branch can be isolated without a whole seeded store.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';
function mkFact(o) {
  return {
    id: 1, kind: 'law', tier: 'law', body: 'body', source: 'user', recurrence: 1, created_at: T0,
    expired_at: null, expiry_reason: null, expiry_note: null,
    contradicted_at: null, contradicted_reason: null, unconfirmed_since: null, anchors: [],
    ...o,
  };
}
function mkAnchor(o) {
  return { repo_id: 'github.com/acme/app', file_path: 'src/a.js', symbol_name: null, grain: 'file', renamed_from: null, ...o };
}

test('every rendered file ends with exactly one trailing newline', () => {
  const files = render({ facts: [
    mkFact({ id: 1, body: 'x', anchors: [mkAnchor({})] }),
    mkFact({ id: 2, body: 'y', anchors: [mkAnchor({ grain: 'repo', file_path: '' })] }),
  ] });
  for (const [key, bytes] of Object.entries(files)) {
    assert.ok(bytes.endsWith('\n'), `${key} must end with a newline`);
    assert.ok(!bytes.endsWith('\n\n'), `${key} must not end with a blank line`);
  }
});

test('a multi-line body with markdown/pipes is preserved verbatim', () => {
  const body = 'Line one.\n- a | b\n\n```js\ncode();\n```';
  const files = render({ facts: [mkFact({ id: 1, body, anchors: [mkAnchor({})] })] });
  assert.ok(files['github.com/acme/app/src/a.js.md'].includes(body), 'body kept as-is');
});

test('render is independent of fact and anchor insertion order', () => {
  const facts = [
    mkFact({ id: 3, body: 'c', anchors: [mkAnchor({ symbol_name: 'foo', grain: 'symbol' })] }),
    mkFact({ id: 1, body: 'a', anchors: [mkAnchor({})] }),
    mkFact({ id: 2, body: 'b', anchors: [mkAnchor({ symbol_name: 'bar', grain: 'symbol' })] }),
  ];
  const forward = render({ facts: [...facts].sort((a, b) => a.id - b.id) });
  const shuffled = render({ facts: [...facts].reverse() });
  // render() must impose its own ordering, not inherit the array's.
  for (const key of Object.keys(forward)) assert.strictEqual(shuffled[key], forward[key], key);
});

test('status precedence: a fact both expired and contradicted reads as CONTRADICTED', () => {
  const files = render({ facts: [mkFact({
    id: 1, body: 'z', expired_at: T0, expiry_reason: 'orphaned',
    contradicted_at: T0, contradicted_reason: 'proven false', anchors: [mkAnchor({})],
  })] });
  const md = files['github.com/acme/app/src/a.js.md'];
  assert.ok(md.includes('status: ❌ CONTRADICTED (proven false)'));
  assert.ok(!md.includes('status: expired'));
});

test('renamed_from is surfaced on the anchor line', () => {
  const files = render({ facts: [mkFact({
    id: 1, body: 'z', anchors: [mkAnchor({ symbol_name: 'newName', grain: 'symbol', renamed_from: 'oldName' })],
  })] });
  assert.ok(files['github.com/acme/app/src/a.js.md'].includes('renamed from oldName'));
});

test('source is folded to HUMAN vs AGENT and recurrence shows as confirmations', () => {
  const files = render({ facts: [
    mkFact({ id: 1, body: 'h', source: 'user', recurrence: 4, anchors: [mkAnchor({ file_path: 'h.js' })] }),
    mkFact({ id: 2, body: 'a', source: 'harvest', recurrence: 2, anchors: [mkAnchor({ file_path: 'a.js' })] }),
  ] });
  assert.ok(files['github.com/acme/app/h.js.md'].includes('source: HUMAN · tier: law · confirmations: 4'));
  assert.ok(files['github.com/acme/app/a.js.md'].includes('source: AGENT · tier: law · confirmations: 2'));
});

test('a fact with no anchor lands in _orphans.md and is reachable', () => {
  const files = render({ facts: [mkFact({ id: 1, body: 'homeless note', anchors: [] })] });
  assert.ok(files['_orphans.md'], '_orphans.md exists');
  assert.ok(files['_orphans.md'].includes('homeless note'));
  assert.ok(files['_orphans.md'].includes('### (orphan) — law'));
});

test('malformed anchors cannot escape the output directory', () => {
  const out = tmpDir();
  const files = render({ facts: [
    mkFact({ id: 1, body: 'evil', anchors: [mkAnchor({ repo_id: '../../etc', file_path: '../../../secret' })] }),
    mkFact({ id: 2, body: 'void', anchors: [mkAnchor({ repo_id: '..', file_path: '..' })] }),
  ] });
  writeProjection(out, files);
  const base = path.resolve(out);
  for (const key of Object.keys(files)) {
    const abs = path.resolve(out, key);
    assert.ok(abs.startsWith(base + path.sep), `${key} stays under out (got ${abs})`);
    assert.ok(fs.existsSync(abs), `${key} was actually written`);
  }
  // Nothing was created next to or above the output root.
  assert.ok(!fs.existsSync(path.join(path.dirname(out), 'secret.md')));
});

test('an empty store renders only MEMORY.md with a clean queue', () => {
  const { file } = (() => {
    const dir = tmpDir();
    const f = path.join(dir, 'practice.db');
    openPracticeDb({ file: f }).close(); // schema only, zero facts
    return { file: f };
  })();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  assert.deepStrictEqual(Object.keys(files), ['MEMORY.md']);
  assert.ok(files['MEMORY.md'].includes('0 fact(s) across 0 file(s).'));
  assert.ok(files['MEMORY.md'].includes('Nothing contradicted or unconfirmed. ✅'));
});

test('writeProjection leaves non-markdown files in the tree untouched', () => {
  const { file } = seededStore();
  const out = tmpDir();
  const keep = path.join(out, 'github.com/acme/app', 'notes.txt');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, 'hand-written, not ours');
  writeProjection(out, withReadonly(file, (db) => render(readSnapshot(db))));
  assert.ok(fs.existsSync(keep), 'non-.md file survives reconciliation');
  assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'hand-written, not ours');
});

test('MEMORY.md status counts reconcile with the total fact count', () => {
  const { file } = seededStore();
  const files = withReadonly(file, (db) => render(readSnapshot(db)));
  const mem = files['MEMORY.md'];
  const total = Number(mem.match(/^(\d+) fact\(s\)/m)[1]);
  const statusBlock = mem.slice(mem.indexOf('By status:'), mem.indexOf('## Needs attention'));
  const summed = [...statusBlock.matchAll(/^- \w+: (\d+)$/gm)].reduce((n, m) => n + Number(m[1]), 0);
  assert.strictEqual(summed, total, 'each fact is counted in exactly one status bucket');
});
