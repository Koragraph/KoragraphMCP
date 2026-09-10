'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseCommandArgs } = require('./args');
const { EXIT, usageError } = require('./errors');

// The store is opened only if its file is already there. Requiring src/db/pool.js CREATES the file
// and applies the schema, and a health check that manufactures the thing it is checking cannot
// answer "is there a store?" — main.js gates its pool teardown on the same fact.
const USES_STORE = true;

const USAGE = `Usage: koragraph doctor

One command that answers a support question. Every line is either a clean check or a named
remedy: which node, which store file, which repositories are indexed and whether any of them
has fallen behind its checkout, whether the
practice hooks are registered, and the exact line that registers this checkout with your
editor over MCP.

It writes nothing. If the store does not exist it says so rather than creating one.

Exit: 0 when nothing is broken, 5 when nothing is indexed yet, 1 when a check failed.

Options:
  -h, --help  Show this help.`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h', default: false },
};

const LEVELS = { ok: 'ok', warn: 'warn', bad: 'FAIL', unknown: '?' };

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length) throw usageError(`doctor takes no arguments (got "${positionals[0]}").`);
  return { help: false };
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function storeBytes(file) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += fs.statSync(`${file}${suffix}`).size; } catch { /* absent is 0 */ }
  }
  return total;
}

// execFileSync, not the ingest's gitSha: requiring src/services/ingest.js pulls in tree-sitter and
// the whole extraction engine, and a health check has to be cheap enough that a stuck user runs it.
function git(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

function nodeCheck(minMajor) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= minMajor) return { name: 'node', level: 'ok', detail: `${process.version} (>= ${minMajor} required)` };
  return {
    name: 'node',
    level: 'bad',
    detail: `${process.version} — this package requires node >= ${minMajor}`,
    remedy: `install node ${minMajor} or newer and re-run`,
  };
}

// An anchor we cannot check is unknown, and unknown is not stale: an absent checkout, a moved
// directory and a deleted repository look identical from the graph alone, so none of them is
// reported as "your index is behind".
function repoCheck(row) {
  const where = row.full_path && row.full_path.includes(path.sep) ? row.full_path : null;
  const name = `${row.project}/${row.repo}`;
  const indexed = row.last_commit_sha ? String(row.last_commit_sha) : null;
  const at = indexed ? indexed.slice(0, 8) : 'no commit recorded';

  if (!where || !fs.existsSync(where)) {
    return {
      name,
      level: 'unknown',
      detail: `${row.branch_name} @ ${at}, ${row.nodes} nodes — checkout not found${where ? ` at ${where}` : ''}`,
      remedy: 'if you moved it, re-run `koragraph ingest <new path>`; staleness cannot be checked from here',
    };
  }
  const head = git(where, ['rev-parse', 'HEAD']);
  if (!head) {
    return {
      name,
      level: 'unknown',
      detail: `${row.branch_name} @ ${at}, ${row.nodes} nodes — ${where} is not a git checkout`,
      remedy: null,
    };
  }
  if (indexed && head === indexed) {
    // The commit sha is written as soon as the branch row exists, before a single node is
    // extracted (see the comment on lastJobStatus in cli/ingest.js) — a process killed mid-run
    // leaves exactly this shape: sha matches HEAD, node count is 0. Reporting that "ok" would
    // hide the one case doctor exists to catch, so it is a warning instead, same as `status`.
    if (!row.nodes) {
      return {
        name,
        level: 'warn',
        detail: `${row.branch_name} @ ${at}, 0 nodes — recorded as indexed but the graph is empty`
          + ' (an interrupted ingest, or nothing extractable was found)',
        remedy: `koragraph ingest ${where}`,
      };
    }
    return { name, level: 'ok', detail: `${row.branch_name} @ ${at}, ${row.nodes} nodes — matches the working tree` };
  }
  return {
    name,
    level: 'warn',
    detail: `${row.branch_name} @ ${at}, ${row.nodes} nodes — the checkout is at ${head.slice(0, 8)}`
      + ` (${divergence(where, indexed)})`,
    remedy: `koragraph ingest ${where}`,
  };
}

// How the indexed commit stands to HEAD, in the checkout's own words.
//
// This was `rev-list --count <indexed>..HEAD`, reported as "N commit(s) later". Two things were
// wrong with it and they compounded. The count is a STRING, so `(behind ? ...)` is truthy for
// "0" and a zero count still printed "0 commit(s) later" — a warning that measures no distance.
// And the arithmetic was right while the conclusion was not: after a `git reset` or a rebase the
// indexed commit is not behind HEAD at all, it is ahead of it or on a different line, and
// `<indexed>..HEAD` is legitimately empty in every one of those cases.
//
// `merge-base --is-ancestor` is the question actually being asked, and it is asked in both
// directions. Nothing here changes the remedy — re-ingest is right for all of them — but doctor
// is the command a support question is answered with, and "0 commit(s) later" answers nothing.
function isAncestor(where, a, b) {
  try {
    execFileSync('git', ['-C', where, 'merge-base', '--is-ancestor', a, b], { stdio: 'pipe' });
    return true;
  } catch (err) {
    // Exit 1 is a real answer (not an ancestor); anything else means git could not tell — an
    // unknown object after a shallow clone or a pruned reflog — and that is not the same claim.
    return err && err.status === 1 ? false : null;
  }
}

function divergence(where, indexed) {
  if (!indexed) return 'unrelated history';
  const forward = isAncestor(where, indexed, 'HEAD');
  if (forward === null) return 'the indexed commit is not in this checkout';
  if (forward) {
    const n = git(where, ['rev-list', '--count', `${indexed}..HEAD`]);
    return n && n !== '0' ? `${n} commit(s) later` : 'the same line of history';
  }
  return isAncestor(where, 'HEAD', indexed)
    ? 'the checkout was rewound behind the graph'
    : 'the histories have diverged — rebased or force-pushed';
}

// Where a store's bytes actually went. A store can blow up to many times the size of its tracked
// source, and `nodes_fts` alone can be the majority of it — an accelerator, not waste, but a
// developer whose laptop just gained that much is owed the breakdown rather than a single total.
// This is the "graceful wall" the product promises: a legible number before an out-of-memory
// crash, not after. dbstat is compiled into better-sqlite3's build, but it is asked for
// defensively — an absent module must cost a line of detail, never the doctor run.
const STORE_LOUD_MB = 64;

function storeBreakdown(dbFile) {
  let db;
  try {
    db = new (require('better-sqlite3'))(dbFile, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      'SELECT name, sum(pgsize) AS b FROM dbstat GROUP BY name ORDER BY b DESC LIMIT 4',
    ).all();
    const total = db.prepare('SELECT sum(pgsize) AS b FROM dbstat').get().b || 0;
    return { rows, total };
  } catch (_) {
    return null;
  } finally {
    if (db) try { db.close(); } catch (_) { /* already closed */ }
  }
}

function storeDetail(dbFile, branches) {
  const head = `${dbFile} (${bytes(storeBytes(dbFile))}, ${branches} branch(es) indexed)`;
  if (storeBytes(dbFile) < STORE_LOUD_MB * 1024 * 1024) return head;
  const b = storeBreakdown(dbFile);
  if (!b || !b.rows.length) return head;
  const part = b.rows
    .map((r) => `${r.name} ${bytes(r.b)}${b.total ? ` (${Math.round((r.b / b.total) * 100)}%)` : ''}`)
    .join(', ');
  return `${head}\n  largest: ${part}`;
}

// Which hook file listens on which event, and the matcher each one needs. This is the block a
// developer has to paste to wire up live capture, so doctor prints it ready to use rather than
// describing it — the same way the MCP check beside it emits a `claude mcp add` line with the
// absolute path already filled in.
const HOOK_WIRING = Object.freeze([
  ['UserPromptSubmit', 'context.mjs', null],
  ['UserPromptSubmit', 'inject.mjs', null],
  ['PreToolUse', 'preflight.mjs', 'Bash|Edit|Write|MultiEdit|NotebookEdit'],
  ['PreToolUse', 'nudge.mjs', null],
  ['PostToolUse', 'record.mjs', null],
  ['SessionEnd', 'session-end.mjs', null],
]);

// One line per event rather than a pretty-printed object. Fully indented this is 30 lines of JSON
// inside a health report; the destination is a file, so what matters is that it can be copied and
// that a reader can see at a glance which four events are being wired.
function hooksSnippet(only = null) {
  const root = path.resolve(__dirname, '..', '..');
  // Grouped by event, not one line per HOOK_WIRING row: PreToolUse now carries two entries
  // (preflight.mjs, nudge.mjs), and a naive one-line-per-row emission would print the key twice —
  // syntactically valid JSON, but the second occurrence silently wins and the first is lost on paste.
  const byEvent = new Map();
  for (const [event, file, matcher] of HOOK_WIRING) {
    if (only && !only.includes(file)) continue;
    const cmd = { type: 'command', command: `node ${path.join(root, '.claude', 'hooks', file)}` };
    const entry = matcher ? { matcher, hooks: [cmd] } : { hooks: [cmd] };
    if (!byEvent.has(event)) byEvent.set(event, []);
    byEvent.get(event).push(entry);
  }
  const lines = [...byEvent.entries()]
    .map(([event, entries]) => `  ${JSON.stringify(event)}: [${entries.map((e) => JSON.stringify(e)).join(', ')}],`);
  if (!lines.length) return '';
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  return ['{', '"hooks": {', ...lines, '}', '}'].join('\n');
}

function hooksCheck() {
  const { hookState } = require('./status');
  const hooks = hookState();
  const name = 'practice hooks';
  if (!hooks.installed.length) {
    return {
      name,
      level: 'warn',
      detail: 'none registered — nothing is being captured while you work',
      remedy: `add to .claude/settings.json in this checkout:\n${hooksSnippet()}`,
    };
  }
  if (hooks.missing.length) {
    return {
      name,
      level: 'warn',
      detail: `${hooks.installed.join(', ')} registered`,
      // Only the missing ones, so pasting this cannot double-register what is already there.
      remedy: `not registered: ${hooks.missing.join(', ')} — add to .claude/settings.json:\n`
        + hooksSnippet(hooks.missing),
    };
  }
  return { name, level: 'ok', detail: hooks.installed.join(', ') };
}

function practiceCheck() {
  const { practiceReport } = require('./status');
  const { file, db } = practiceReport();
  const name = 'practice store';
  if (!db) {
    return {
      name,
      level: 'warn',
      detail: `nothing recorded yet (${file} does not exist)`,
      remedy: 'koragraph practice seed',
    };
  }
  if (!db.facts_live) {
    return {
      name,
      level: 'warn',
      detail: `${file} — no live facts, ${db.events.captured} event(s) captured`,
      remedy: db.events.captured ? 'koragraph practice harvest' : 'koragraph practice seed',
    };
  }
  return { name, level: 'ok', detail: `${file} — ${db.facts_live} live, ${db.facts_expired} expired` };
}

// The one line a new user cannot construct themselves, because it needs the absolute path of the
// checkout they are standing in. Printed filled in, so it can be copied.
function mcpCheck() {
  const bin = path.resolve(__dirname, '..', '..', 'bin', 'koragraph.js');
  const command = `claude mcp add koragraph -- node ${bin} mcp`;
  const configs = [
    path.join(process.cwd(), '.mcp.json'),
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const f of configs) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (text.includes(bin)) {
      return { name: 'mcp registration', level: 'ok', detail: `registered in ${f}`, configFile: f };
    }
  }
  return { name: 'mcp registration', level: 'warn', detail: 'this checkout is not registered with an editor', remedy: command };
}

// Which store the SERVER will open, versus the one this CLI just reported on. They are resolved
// independently — KORAGRAPH_HOME/KORAGRAPH_DB in the registration's `env` block binds the server
// only, and a shell never sees it — so `remember` over MCP and `practice sync` in a terminal can
// address two different databases on the same machine, for the same repo, with nothing said.
//
// Observed: an agent following the README's own hand-off prompt imported facts over MCP and then
// wrote its rulebook from a different store, because the two halves of that prompt resolve the
// path separately. Read-only and best-effort: an unparseable or exotic config says nothing rather
// than guessing.
function mcpStoreCheck(registration) {
  const name = 'mcp store';
  const cliHome = process.env.KORAGRAPH_HOME || path.join(os.homedir(), '.koragraph');
  const cliDb = process.env.KORAGRAPH_DB || path.join(cliHome, 'graph.db');
  if (!registration || !registration.configFile) {
    return { name, level: 'ok', detail: `cli reads ${cliDb}` };
  }
  let env;
  try {
    const config = JSON.parse(fs.readFileSync(registration.configFile, 'utf8'));
    env = findKoragraphServerEnv(config);
  } catch { return { name, level: 'unknown', detail: 'registration file could not be parsed' }; }
  if (!env) return { name, level: 'ok', detail: `both read ${cliDb}` };

  const mcpHome = env.KORAGRAPH_HOME || cliHome;
  const mcpDb = env.KORAGRAPH_DB || path.join(mcpHome, 'graph.db');
  if (path.resolve(mcpDb) === path.resolve(cliDb)) {
    return { name, level: 'ok', detail: `both read ${cliDb}` };
  }
  return {
    name,
    level: 'bad',
    detail: `the MCP server reads ${mcpDb} but this CLI reads ${cliDb} — facts saved by your agent will not be visible to these commands`,
    remedy: `set KORAGRAPH_HOME=${mcpHome} in your shell, or drop the env block from ${registration.configFile}`,
  };
}

// The koragraph entry can sit under `mcpServers` at the root or nested per-project, and only its
// `env` matters here.
function findKoragraphServerEnv(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  const servers = node.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const server of Object.values(servers)) {
      const args = Array.isArray(server?.args) ? server.args.join(' ') : '';
      const command = typeof server?.command === 'string' ? server.command : '';
      if (/koragraph/i.test(`${command} ${args}`) && server.env) return server.env;
    }
  }
  for (const value of Object.values(node)) {
    const hit = findKoragraphServerEnv(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function run(_parsed, io) {
  const { out, err } = io;
  const { graphDbPath } = require('../practice/paths');
  const { version, engines } = require('../../package.json');
  const minMajor = Number(String(engines?.node || '>=22').replace(/[^\d]/g, '')) || 22;

  const checks = [nodeCheck(minMajor)];
  const dbFile = graphDbPath();
  let noGraph = false;

  if (!fs.existsSync(dbFile)) {
    noGraph = true;
    checks.push({
      name: 'graph store',
      level: 'bad',
      detail: `${dbFile} does not exist — nothing has been indexed on this machine`,
      remedy: 'koragraph ingest <path to a repository>',
    });
  } else {
    let rows = null;
    try {
      // Opening the pool is part of the check, not a precondition of it: SqlitePool's constructor
      // reads the file immediately and throws synchronously on a corrupt/non-database file, so it
      // has to be inside this try — otherwise that exact failure skips doctor's own reporting and
      // crashes out through main.js's generic top-level handler instead of naming a remedy here.
      const pool = require('../db/pool');
      const { branchRows } = require('./status');
      rows = await branchRows(pool);
    } catch (e) {
      checks.push({
        name: 'graph store',
        level: 'bad',
        detail: `${dbFile} (${bytes(storeBytes(dbFile))}) cannot be read — ${e.message}`,
        remedy: 'delete it and re-run `koragraph ingest`, or check its permissions and free disk',
      });
    }
    if (rows) {
      checks.push({
        name: 'graph store',
        level: rows.length ? 'ok' : 'bad',
        detail: storeDetail(dbFile, rows.length),
        remedy: rows.length ? null : 'koragraph ingest <path to a repository>',
      });
      noGraph = rows.length === 0;
      for (const row of rows) checks.push(repoCheck(row));
    }
  }

  checks.push(practiceCheck());
  checks.push(hooksCheck());
  const registration = mcpCheck();
  checks.push(registration);
  checks.push(mcpStoreCheck(registration));

  out(`koragraph ${version} — doctor\n\n`);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    // A detail may be more than one line; every continuation lands in the value column, so the
    // report stays one aligned table rather than a table with a paragraph in the middle of it.
    const [first, ...rest] = String(c.detail).split('\n');
    out(`  [${LEVELS[c.level].padEnd(4)}] ${c.name.padEnd(width)}  ${first}\n`);
    for (const line of rest) out(`  ${' '.repeat(width + 9)}${line.trim()}\n`);
    if (c.remedy) {
      const [head, ...more] = String(c.remedy).split('\n');
      out(`  ${' '.repeat(width + 9)}-> ${head}\n`);
      for (const line of more) out(`  ${' '.repeat(width + 12)}${line}\n`);
    }
  }

  const bad = checks.filter((c) => c.level === 'bad').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  out(`\n${bad} problem(s), ${warn} warning(s).\n`);
  if (!bad && !warn) err('Everything checks out.\n');

  if (noGraph) return EXIT.NO_GRAPH;
  return bad ? EXIT.FAILURE : EXIT.OK;
}

module.exports = { divergence, isAncestor, hooksSnippet, HOOK_WIRING, storeBreakdown, storeDetail, parse, run, repoCheck, mcpCheck, USAGE, USES_STORE, OPTIONS };
