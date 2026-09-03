'use strict';

const { parseCommandArgs, positiveInt } = require('./args');
const { EXIT, usageError } = require('./errors');
const { DECLARATION_TYPES } = require('../services/graph-analytics');

const USES_STORE = true;

const OPTIONS = {
  help: { type: 'boolean', short: 'h', default: false },
  repo: { type: 'string' },
  limit: { type: 'string' },
  all: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

const USAGE = `Usage: koragraph diff [--repo <name>] [--limit 20] [--all] [--json]

Show what changed in the graph the last time a repository was re-indexed — which declarations
appeared and which disappeared, not just how many. This is the "what moved since I last looked"
answer: cheap, because every incremental ingest already records its own diff.

With --all, list the history of re-index diffs for the repository instead of only the latest.

Options:
      --repo <name>  Only this repository (default: every indexed repository).
      --limit <n>    How many declaration names to list per side (default: 20).
      --all          Show the full re-index history, not just the most recent diff.
      --json         Emit machine-readable JSON instead of text.
  -h, --help         Show this help.

A full re-ingest re-writes everything, so its diff looks like "everything added". Diffs are most
useful after an incremental re-index (watch, git hooks, or \`koragraph ingest\` on an existing repo).`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length) throw usageError(`diff takes no positional arguments (got "${positionals[0]}").`);
  return {
    help: false,
    repo: values.repo || null,
    limit: positiveInt(values.limit, '--limit', 20),
    all: values.all,
    json: values.json,
  };
}

// Every branch of every (optionally filtered) repository, so a diff is reported per branch just as
// report and overview scope per repo. A repo with no recorded diff is simply absent from the result.
async function branchesFor(pool, only) {
  const { rows } = await pool.query(
    `SELECT rb.id AS branch_id, r.name AS repo
       FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id
      ORDER BY r.name, rb.id`,
  );
  return only ? rows.filter((r) => r.repo === only) : rows;
}

// The graph_diffs rows for a branch, newest first. Each carries the counts recorded at ingest and
// the job that produced it, whose time window bounds the declaration-level lookup below.
async function diffsForBranch(pool, branchId, all) {
  const { rows } = await pool.query(
    `SELECT gd.id, gd.ingest_job_id, gd.computed_at, gd.nodes_added, gd.nodes_archived,
            gd.edges_added, gd.edges_removed, j.created_at AS job_started, j.job_type
       FROM graph_diffs gd
       LEFT JOIN ingest_jobs j ON j.id = gd.ingest_job_id
      WHERE gd.branch_id = $1
      ORDER BY gd.computed_at DESC ${all ? '' : 'LIMIT 1'}`,
    [branchId],
  );
  return rows;
}

// The declaration names that appeared / disappeared inside one ingest's time window. A node stamps
// created_at (and bumps last_updated_at on archival) with the same ISO-8601 clock the job does, so a
// lexical range over [job_started, computed_at] selects exactly the declarations this ingest touched.
// The names are bounded by `limit` per side; the total_* counts are the full, self-consistent totals
// over the window (the graph_diffs row's own counts include non-declaration nodes and can differ).
async function declarationsInWindow(pool, branchId, from, to, limit) {
  const typeList = DECLARATION_TYPES.map((t) => `'${t}'`).join(', ');
  const lower = from || '0000';
  const [added, removed, addedCount, removedCount] = await Promise.all([
    pool.query(
      `SELECT n.name, n.node_type AS type, f.path AS file, n.start_line AS line
         FROM nodes n LEFT JOIN files f ON f.id = n.file_id
        WHERE n.repository_branch_id = $1 AND n.approval_status = 'APPROVED'
          AND n.node_type IN (${typeList})
          AND n.created_at > $2 AND n.created_at <= $3
        ORDER BY n.created_at DESC, n.id DESC LIMIT $4`,
      [branchId, lower, to, limit]),
    pool.query(
      `SELECT n.name, n.node_type AS type, f.path AS file, n.start_line AS line
         FROM nodes n LEFT JOIN files f ON f.id = n.file_id
        WHERE n.repository_branch_id = $1 AND n.approval_status = 'ARCHIVED'
          AND n.node_type IN (${typeList})
          AND n.last_updated_at > $2 AND n.last_updated_at <= $3
        ORDER BY n.last_updated_at DESC, n.id DESC LIMIT $4`,
      [branchId, lower, to, limit]),
    pool.query(
      `SELECT count(*) AS n FROM nodes n WHERE n.repository_branch_id = $1
         AND n.approval_status = 'APPROVED' AND n.node_type IN (${typeList})
         AND n.created_at > $2 AND n.created_at <= $3`, [branchId, lower, to]),
    pool.query(
      `SELECT count(*) AS n FROM nodes n WHERE n.repository_branch_id = $1
         AND n.approval_status = 'ARCHIVED' AND n.node_type IN (${typeList})
         AND n.last_updated_at > $2 AND n.last_updated_at <= $3`, [branchId, lower, to]),
  ]);
  return {
    added: added.rows, removed: removed.rows,
    totalAdded: Number(addedCount.rows[0].n), totalRemoved: Number(removedCount.rows[0].n),
  };
}

function loc(row) {
  if (!row.file) return '';
  return row.line ? ` (${row.file}:${row.line})` : ` (${row.file})`;
}

function renderDiff(repo, diff, decls, lines) {
  const when = diff.computed_at ? diff.computed_at.slice(0, 19).replace('T', ' ') : '?';
  const kind = diff.job_type === 'FULL' ? 'full re-ingest' : 'incremental';
  lines.push(`${repo}  @ ${when}  (${kind})`);
  lines.push(`  ${decls.totalAdded} declaration(s) added, ${decls.totalRemoved} removed  `
    + `(+${diff.edges_added}/-${diff.edges_removed} edges)`);
  if (decls.added.length) {
    const more = decls.totalAdded > decls.added.length ? ` of ${decls.totalAdded}` : '';
    lines.push(`  added (${decls.added.length}${more}):`);
    for (const d of decls.added) lines.push(`    + ${d.name} [${d.type}]${loc(d)}`);
  }
  if (decls.removed.length) {
    const more = decls.totalRemoved > decls.removed.length ? ` of ${decls.totalRemoved}` : '';
    lines.push(`  removed (${decls.removed.length}${more}):`);
    for (const d of decls.removed) lines.push(`    - ${d.name} [${d.type}]${loc(d)}`);
  }
  if (!decls.totalAdded && !decls.totalRemoved) {
    lines.push('  no declaration changes.');
  }
  lines.push('');
}

async function run(parsed, io) {
  const { out, err } = io;
  const pool = require('../db/pool');

  const branches = await branchesFor(pool, parsed.repo);
  if (!branches.length) {
    if (parsed.repo) { err(`No repository named "${parsed.repo}" is indexed. Run: koragraph status\n`); return EXIT.NOT_FOUND; }
    err('The graph is empty — nothing to diff. Next: koragraph ingest <path to a repository>\n');
    return EXIT.OK;
  }

  const report = [];
  for (const { branch_id, repo } of branches) {
    const diffs = await diffsForBranch(pool, branch_id, parsed.all);
    for (const diff of diffs) {
      const decls = await declarationsInWindow(pool, branch_id, diff.job_started, diff.computed_at, parsed.limit);
      report.push({ repo, diff, decls });
    }
  }

  if (!report.length) {
    if (parsed.json) { out(`${JSON.stringify({ diffs: [] })}\n`); return EXIT.OK; }
    out('No re-index diffs recorded yet — a graph diff is written each time a repository is re-ingested.\n'
      + 'Re-run `koragraph ingest` on a repository already in the graph, or install `koragraph hooks`, to record one.\n');
    return EXIT.OK;
  }

  if (parsed.json) {
    out(`${JSON.stringify({ diffs: report }, null, 2)}\n`);
    return EXIT.OK;
  }

  const lines = [];
  for (const { repo, diff, decls } of report) renderDiff(repo, diff, decls, lines);
  out(lines.join('\n'));
  return EXIT.OK;
}

module.exports = { parse, run, USAGE, OPTIONS, USES_STORE, renderDiff, declarationsInWindow };
