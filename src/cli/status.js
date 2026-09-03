'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCommandArgs } = require('./args');
const { EXIT, usageError } = require('./errors');

const USES_STORE = true;

// A graph this small is a synthetic or abandoned one, and it matters because the pre-flight and the
// annotation path resolve against it: below this they cannot fire at all and nothing else says so.
const EMPTY_GRAPH_NODES = 50;

const OPTIONS = {
  all: { type: 'boolean', short: 'a', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const USAGE = `Usage: koragraph status [--all]

Show the repository you are standing in — how big it is, how many declaration-grain co-change
edges it carries, and when it was last indexed — then the second layer: what has been LEARNED
about this code, how much of it still resolves, and whether the hooks that capture it are
installed. The store holds every repo you have ever indexed; --all shows all of them.

This is the "did it work?" command. Run it after an ingest, and run it first when a tool
answers something you did not expect.

Options:
  -a, --all   Show every repository in the store, not just the one you are in.
  -h, --help  Show this help.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length) throw usageError(`status takes no arguments (got "${positionals[0]}").`);
  return { help: false, all: values.all };
}

async function branchRows(pool) {
  const { rows } = await pool.query(
    `SELECT p.name AS project, r.name AS repo, r.full_path, rb.branch_name, rb.last_commit_sha,
            rb.last_synced_at, rb.is_tracked,
            (SELECT count(*) FROM nodes n
              WHERE n.repository_branch_id = rb.id AND n.approval_status != 'ARCHIVED') AS nodes,
            (SELECT count(*) FROM edges e
               JOIN nodes n2 ON n2.id = e.from_node_id
               JOIN nodes t2 ON t2.id = e.to_node_id
              WHERE n2.repository_branch_id = rb.id
                AND n2.approval_status != 'ARCHIVED' AND t2.approval_status != 'ARCHIVED') AS edges,
            (SELECT count(*) FROM edges e
               JOIN nodes n3 ON n3.id = e.from_node_id
               JOIN nodes t3 ON t3.id = e.to_node_id
              WHERE n3.repository_branch_id = rb.id AND e.edge_type = 'CO_CHANGES'
                AND n3.approval_status != 'ARCHIVED' AND t3.approval_status != 'ARCHIVED') AS cochange
       FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id
       JOIN projects p ON p.id = r.project_id
      ORDER BY p.name, r.name, rb.branch_name`,
  );
  return rows;
}

async function lastJob(pool) {
  const { rows } = await pool.query(
    `SELECT j.status, j.job_type, j.branch, j.local_path, j.github_url, j.updated_at,
            j.files_done, j.files_total, j.nodes_written, j.error_msg, j.coverage_warning
       FROM ingest_jobs j ORDER BY j.id DESC LIMIT 1`,
  );
  return rows[0] || null;
}

function table(rows) {
  const header = ['REPOSITORY', 'BRANCH', 'NODES', 'EDGES', 'CO-CHANGE', 'COMMIT', 'LAST INDEXED'];
  const body = rows.map((r) => [
    `${r.project}/${r.repo}`,
    r.branch_name + (r.is_tracked ? '' : ' (untracked)'),
    String(r.nodes),
    String(r.edges),
    String(r.cochange),
    r.last_commit_sha ? String(r.last_commit_sha).slice(0, 8) : '-',
    r.last_synced_at ? String(r.last_synced_at).replace('T', ' ').slice(0, 19) : '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

// Hook installation is the difference between a layer that learns and one that is merely present,
// and nothing else in the product can tell the user which they have.
function hookState() {
  const files = [
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  const wanted = ['record.mjs', 'preflight.mjs', 'nudge.mjs', 'session-end.mjs', 'context.mjs'];
  const found = new Set();
  let anySettings = false;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    anySettings = true;
    for (const w of wanted) if (text.includes(w)) found.add(w);
  }
  return { anySettings, installed: [...found], missing: wanted.filter((w) => !found.has(w)) };
}

// The ingest stores its coverage note as one semicolon-joined string, and one of its clauses ends
// in every degraded filename — 25 of them arrived here as a single unwrapped terminal paragraph
// that buried the three facts beside it. One clause per line, and a list is a count plus its head.
const KEEP_ITEMS = 3;

function coverageLines(text) {
  if (!text) return [];
  return String(text).split(/;\s*/).map((c) => c.trim()).filter(Boolean).map((clause) => {
    const at = clause.indexOf(': ');
    if (at < 0) return clause;
    const tail = clause.slice(at + 2);
    if (tail.startsWith('{')) return clause;
    const items = tail.split(', ');
    if (items.length <= KEEP_ITEMS) return clause;
    return `${clause.slice(0, at)}: ${items.slice(0, KEEP_ITEMS).join(', ')} and ${items.length - KEEP_ITEMS} more`;
  });
}

function tally(rows, field) {
  const out = {};
  for (const r of rows) {
    const k = r[field] == null ? '(none)' : String(r[field]);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function pairs(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join('  ') : 'none';
}

// Reads practice.db only, never creates it, and opens it READ-ONLY — which also means it does not
// migrate. A health report that upgrades the schema of the thing it is reporting on cannot be run
// to find out what state that thing is in. Missing tables are reported as missing.
function practiceReport() {
  const { practiceDbPath } = require('../practice/paths');
  const file = practiceDbPath();
  if (!fs.existsSync(file)) return { file, db: null };

  const { openPracticeDb } = require('../practice/db');
  const db = openPracticeDb({ readonly: true });
  const { eventCounts } = require('../practice/digest');
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);

  // Deliverability, not just counts. A tier tally tells a reader nothing about how much can
  // actually reach a session — a store can be full of facts while delivering almost none of them.
  //
  // The `contradicted_at` column only exists from a later migration, so it is probed rather than
  // named: this opens the store read-only and a read-only open does not migrate.
  const hasContradicted = db.prepare("SELECT 1 FROM pragma_table_info('facts') WHERE name = 'contradicted_at'").get();
  const live = db.prepare(
    `SELECT f.kind, f.tier, ${hasContradicted ? 'f.contradicted_at' : 'NULL AS contradicted_at'},
            (SELECT a.grain FROM anchors a WHERE a.fact_id = f.id ORDER BY a.grain LIMIT 1) AS grain
       FROM facts f WHERE f.expired_at IS NULL`,
  ).all();
  const dead = db.prepare('SELECT expiry_reason FROM facts WHERE expired_at IS NOT NULL').all();
  const anchors = db.prepare(
    `SELECT a.grain, a.renamed_from, f.expired_at
       FROM anchors a JOIN facts f ON f.id = a.fact_id`,
  ).all();
  const runs = {};
  for (const kind of ['harvest', 'seed', 'revalidate']) {
    runs[kind] = has('ops_runs') ? db.prepare(
      'SELECT ran_at, summary FROM ops_runs WHERE kind = ? ORDER BY ran_at DESC LIMIT 1',
    ).get(kind) || null : null;
  }
  const report = {
    file,
    facts_live: live.length,
    facts_expired: dead.length,
    by_tier: tally(live, 'tier'),
    by_kind: tally(live, 'kind'),
    by_reason: tally(dead, 'expiry_reason'),
    // A hypothesis never reaches a reader (recall.js filters it in SQL), and neither does a
    // contradicted fact. Both are stored on purpose and both are invisible, which is the point.
    undeliverable_hypothesis: live.filter((f) => f.tier === 'hypothesis').length,
    undeliverable_contradicted: live.filter((f) => f.contradicted_at).length,
    // Repo-grain laws compete for the rulebook's five slots. Deliverable in principle, mostly
    // unseen in practice — the one number that says how much of a bulk import is dead weight.
    repo_laws: live.filter((f) => f.tier === 'law' && f.grain === 'repo' && !f.contradicted_at).length,
    anchors_live: anchors.filter((a) => !a.expired_at).length,
    anchors_expired: anchors.filter((a) => a.expired_at).length,
    anchors_symbol: anchors.filter((a) => !a.expired_at && a.grain === 'symbol').length,
    anchors_file: anchors.filter((a) => !a.expired_at && a.grain === 'file').length,
    anchors_renamed: anchors.filter((a) => a.renamed_from).length,
    events: eventCounts(db),
    runs,
    // Probed, not named: an older store has no open_loops table. Open loops are not facts —
    // separate table, separate physics (context not instruction, closed on completion not drift).
    open_loops: has('open_loops')
      ? db.prepare('SELECT count(*) c FROM open_loops WHERE resolved_at IS NULL').get().c : 0,
  };
  db.close();
  return { file, db: report };
}

function renderPractice(r, out, warn) {
  // Required HERE, not at module load. `--help` must open no store and load no engine (see the
  // loader note in main.js), and context-brief pulls in the practice read path. Imported rather
  // than restating the number so the two cannot disagree about how many rules a session gets.
  const { MAX_LAWS_SHOWN: RULEBOOK_SLOTS } = require('../practice/context-brief');
  out(`\nPractice (second layer): ${r.file}\n`);
  out(`  facts       ${r.facts_live} live, ${r.facts_expired} expired\n`);
  out(`  by tier     ${pairs(r.by_tier)}\n`);
  out(`  by kind     ${pairs(r.by_kind)}\n`);
  out(`  expired by  ${pairs(r.by_reason)}\n`);
  const hidden = r.undeliverable_hypothesis + r.undeliverable_contradicted;
  if (hidden) {
    const parts = [];
    if (r.undeliverable_hypothesis) parts.push(`${r.undeliverable_hypothesis} hypothesis (unanchored)`);
    if (r.undeliverable_contradicted) parts.push(`${r.undeliverable_contradicted} contradicted`);
    out(`  NOT DELIVERED  ${hidden} of ${r.facts_live} fact(s) can never reach a session: `
      + `${parts.join(', ')}\n`);
  }
  if (r.repo_laws > RULEBOOK_SLOTS) {
    out(`  rulebook    ${r.repo_laws} repository-wide rule(s) compete for ${RULEBOOK_SLOTS} slots; `
      + `${r.repo_laws - RULEBOOK_SLOTS} are stored but rarely seen\n`);
  }
  out(`  anchors     ${r.anchors_live} live (${r.anchors_symbol} symbol-grain, `
    + `${r.anchors_file} file-grain), ${r.anchors_expired} on expired facts, `
    + `${r.anchors_renamed} followed a rename\n`);
  if (r.open_loops) {
    out(`  open loops  ${r.open_loops} unfinished (sticky notes — context, not rules; `
      + '`koragraph practice loops`)\n');
  }
  const ev = r.events;
  out(`  events      ${ev.captured} captured`
    + (ev.harvested === null ? ' (no harvest bookkeeping in this schema)'
      : `, ${ev.harvested} harvested, ${ev.unharvested} not yet`) + '\n');
  for (const [kind, row] of Object.entries(r.runs)) {
    out(`  last ${kind.padEnd(11)}${row ? String(row.ran_at).replace('T', ' ').slice(0, 19) : 'never'}\n`);
  }

  if (!r.facts_live && ev.captured) {
    warn.push(`\n${ev.captured} events are captured and no fact has been promoted from them. Run\n`
      + '`koragraph practice harvest`, and `koragraph practice digest` to see what it made.\n');
  }
  if (!r.runs.revalidate) {
    warn.push('\nRevalidation has never run, so no fact has been checked against the code since it\n'
      + 'was learned. Run `koragraph practice revalidate` — it also runs after every ingest.\n');
  }
}

async function run(_parsed, io) {
  const { out, err } = io;
  const pool = require('../db/pool');

  // better-sqlite3 reports the file it actually opened, which is the only answer that cannot be
  // wrong about which .env or which KORAGRAPH_HOME won.
  out(`Store: ${pool.db.name}\n\n`);

  const rows = await branchRows(pool);
  if (rows.length === 0) {
    out('No repositories are indexed yet.\n');
    err('\n!! The graph is EMPTY. Nothing can be retrieved, and the practice layer\'s pre-flight\n'
      + '   and annotation paths resolve against it, so neither of those can fire either.\n'
      + '   Next: koragraph ingest <path to a repository>\n');
    reportSecondLayer(out, err);
    return EXIT.OK;
  }
  // Default to the repository you are standing in — the whole-store table surprised first-time
  // users who expected one project. `--all` restores the full store view.
  const mine = _parsed.all ? null : currentRepoRows(rows);
  const shown = mine && mine.length ? mine : rows;
  out(`${table(shown)}\n`);
  if (mine && mine.length && rows.length > mine.length) {
    const others = rows.length - mine.length;
    out(`\n+ ${others} other repositor${others === 1 ? 'y' : 'ies'} in this store — `
      + '`koragraph status --all` to see them.\n');
  }

  const totalNodes = shown.reduce((n, r) => n + Number(r.nodes), 0);
  if (totalNodes < EMPTY_GRAPH_NODES) {
    err(`\n!! The graph holds ${totalNodes} nodes across ${shown.length} branch(es) — that is an empty\n`
      + '   or synthetic graph, not a real index. Retrieval will answer almost nothing, and the\n'
      + '   practice layer cannot resolve an anchor to a symbol, so pre-flight and annotation\n'
      + '   silently never fire. Next: koragraph ingest <path to a repository>\n');
  }

  const job = await lastJob(pool);
  if (job) {
    const where = job.local_path || job.github_url;
    out(`\nLast ingest: ${job.status} ${job.job_type.toLowerCase()} of ${where} (${job.branch}) `
      + `at ${String(job.updated_at).replace('T', ' ').slice(0, 19)} — `
      + `${job.files_done}/${job.files_total} files, ${job.nodes_written} nodes\n`);
    if (job.error_msg) out(`  error: ${job.error_msg}\n`);
    for (const line of coverageLines(job.coverage_warning)) out(`  coverage: ${line}\n`);
  }

  const totalCochange = shown.reduce((n, r) => n + Number(r.cochange), 0);
  if (totalCochange === 0) {
    err('\nNo co-change edges were mined. They need a git checkout with history, and a pair of\n'
      + 'declarations has to have moved together enough times to clear the support threshold.\n');
  }

  cwdWarning(out, err);
  reportSecondLayer(out, err);
  return EXIT.OK;
}

// The repository you are standing in, matched to its rows in the store by normalised remote
// (full_path), else by name. Returns null when we cannot tell what repo this is, so the caller
// falls back to the whole-store view.
function currentRepoRows(rows) {
  let identity;
  try { identity = require('../practice/repo-identity').repoIdentity(process.cwd()); } catch { return null; }
  if (!identity || !identity.repoId) return null;
  let mine = rows.filter((r) => r.full_path && r.full_path === identity.repoId);
  if (!mine.length && identity.repoName) mine = rows.filter((r) => r.repo === identity.repoName);
  return mine.length ? mine : null;
}

// The repository you are STANDING IN is the one whose facts will be looked up, so its absence from
// the graph is the specific thing worth saying — a full graph of other people's repositories tells
// you nothing about whether this one will answer.
function cwdWarning(out, err) {
  let identity;
  try { identity = require('../practice/repo-identity').repoIdentity(process.cwd()); } catch { return; }
  if (!identity || !identity.repoId) return;

  const { openGraphDb, resolveBranch } = require('../practice/resolve');
  let graph = null;
  try { graph = openGraphDb(); } catch { return; }
  try {
    const branch = resolveBranch(graph, { repoId: identity.repoId, repoName: identity.repoName, repoRoot: identity.repoRoot });
    if (branch) {
      out(`\nThis checkout: ${identity.repoId} -> branch ${branch.branchName} (matched by ${branch.matchedBy}).\n`);
    } else {
      err(`\n!! The repository you are in is NOT in the graph: ${identity.repoId}\n`
        + '   Facts about it cannot resolve to a symbol, and nothing will be surfaced\n'
        + '   while you edit it.\n'
        + `   Next: koragraph ingest ${identity.repoRoot}\n`);
    }
  } finally {
    graph.close();
  }
}

function reportSecondLayer(out, err) {
  const { file, db } = practiceReport();
  const warn = [];
  if (!db) out(`\nPractice (second layer): nothing recorded yet (${file} does not exist).\n`);
  else renderPractice(db, out, warn);

  const hooks = hookState();
  if (hooks.installed.length) {
    out(`  hooks       ${hooks.installed.join(', ')}`
      + `${hooks.missing.length ? `  (not registered: ${hooks.missing.join(', ')})` : ''}\n`);
  } else {
    warn.push('\nNo practice hooks are registered, so nothing is being captured. Without them the\n'
      + 'second layer can only be seeded from git history (`koragraph practice seed`).\n');
  }
  for (const w of warn) err(w);
}

module.exports = {
  parse, run, table, branchRows, coverageLines, hookState, practiceReport, renderPractice,
  USAGE, USES_STORE, OPTIONS,
  EMPTY_GRAPH_NODES,
};
