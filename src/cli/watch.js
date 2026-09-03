'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EXIT, cliError } = require('./errors');
const {
  resolveRepoPath, ensureProject, findIndexedBranch, openJob, closeJob, branchTotals, rebaseDiffToIngestRoot,
} = require('./ingest');
const { computeChangesAsync, signatureOf, debounceStep } = require('../services/repo-watcher');

const DEFAULT_INTERVAL_MS = 800;

function cliEntry() {
  return path.resolve(__dirname, '../../bin/koragraph.js');
}

// A repo not yet in the graph is indexed once, up front, by the same command a manual ingest runs
// — a subprocess rather than a duplicated ingestAll, so watch and `koragraph ingest` cannot drift.
function fullIndexSubprocess(repoPath, project, io) {
  io.err(`watch: ${path.basename(repoPath)} is not in the graph yet — indexing it once before watching.\n`);
  execFileSync(process.execPath, [cliEntry(), 'ingest', repoPath, '--project', project], { stdio: 'inherit' });
}

// The branch row for a checkout already in the graph, located by its absolute path — so watch
// reindexes into the SAME project the manual ingest used, even when --project is omitted, rather
// than creating a duplicate repo under "default".
async function indexedByPath(pool, repoPath) {
  const { rows } = await pool.query(
    `SELECT p.name AS project, r.project_id, r.id AS repo_id,
            rb.id AS branch_id, rb.branch_name, rb.last_commit_sha
       FROM repositories r
       JOIN projects p ON p.id = r.project_id
       JOIN repository_branches rb ON rb.repository_id = r.id
      WHERE r.full_path = $1 ORDER BY rb.id LIMIT 1`,
    [repoPath]);
  return rows[0] || null;
}

async function resolveTarget(pool, repoPath, projectHint) {
  let row = await indexedByPath(pool, repoPath);
  if (!row) {
    // Not indexed yet: index it once under the hinted project, then locate it by path.
    fullIndexSubprocess(repoPath, projectHint, { err: (s) => process.stderr.write(s) });
    row = await indexedByPath(pool, repoPath);
    if (!row) {
      // A checkout whose basename differs from what upsertRepo recorded can miss the path match;
      // fall back to the name lookup under the hinted project before giving up.
      const projectId = await ensureProject(pool, projectHint);
      const branch = await findIndexedBranch(pool, projectId, path.basename(repoPath), null);
      if (!branch) return null;
      row = { project: projectHint, project_id: projectId, repo_id: branch.repo_id,
        branch_id: branch.branch_id, branch_name: branch.branch_name, last_commit_sha: branch.last_commit_sha };
    }
  }
  return {
    repoPath, project: row.project, projectId: row.project_id,
    repoId: row.repo_id, branchId: row.branch_id, branchName: row.branch_name,
    recordedSha: row.last_commit_sha || null,
    state: { prev: undefined, applied: undefined },
  };
}

// One incremental re-index of the union set. newCommitSha = HEAD advances the recorded SHA, so a
// commit and any uncommitted edits on top of it are folded into a single re-extraction.
async function reindexTarget(pool, target, changes, io) {
  const { runIncrementalIngest, gitTopLevel } = require('../services/ingest');
  const headMoved = changes.head && changes.head !== target.recordedSha;
  // `git status`/`git diff` (repo-watcher.js) always report paths relative to the git working-tree
  // ROOT, never `target.repoPath`. When the watched path is a subdirectory of the checkout (a
  // monorepo workspace), those paths double up against the ingest root inside
  // `filterIncrementalPaths` and are silently dropped — the same class of bug fixed for a one-shot
  // incremental re-ingest in `cli/ingest.js`, here on the `--watch` path instead.
  const gitRoot = gitTopLevel(target.repoPath);
  const rebased = rebaseDiffToIngestRoot(
    { changed: changes.changed, removed: changes.removed },
    gitRoot, path.resolve(target.repoPath),
  );
  if (rebased.outOfScope) {
    io.err(`watch: ${rebased.outOfScope} changed path(s) outside this watch target's subdirectory ignored\n`);
  }
  const jobId = await openJob(pool, {
    projectId: target.projectId, repoPath: target.repoPath, branchName: target.branchName,
    stack: null, jobType: 'INCREMENTAL',
  });
  try {
    const res = await runIncrementalIngest({
      repoPath: target.repoPath, projectId: target.projectId, repoId: target.repoId,
      branchId: target.branchId, branchName: target.branchName,
      changedPaths: rebased.changed, removedPaths: rebased.removed,
      newCommitSha: changes.head, jobId,
    });
    await closeJob(pool, jobId, {
      status: res.errors > 0 ? 'DEGRADED' : 'COMPLETE',
      files_done: res.done || 0, files_total: (res.done || 0) + (res.skipped || 0),
      nodes_written: res.nodes || 0,
    });
    target.recordedSha = changes.head || target.recordedSha;

    const totals = await branchTotals(pool, target.branchId);
    const stamp = new Date().toISOString().slice(11, 19);
    io.out(`[${stamp}] ${target.project}/${path.basename(target.repoPath)}  `
      + `${rebased.changed.length} changed, ${rebased.removed.length} removed  `
      + `→ ${totals.nodes} nodes  ${totals.edges} edges\n`);

    // Co-change only depends on git HISTORY, so it is worth re-mining only when a commit landed —
    // an uncommitted save moves no commit and changes no co-change. Deferred as always.
    if (headMoved) {
      const { spawnDetachedCoChange } = require('../services/cochange-defer');
      spawnDetachedCoChange({ branchId: target.branchId, repoPath: target.repoPath });
    }
  } catch (e) {
    await closeJob(pool, jobId, { status: 'FAILED', error_msg: e.message.slice(0, 2000) }).catch(() => {});
    io.err(`watch: re-index of ${path.basename(target.repoPath)} failed — ${e.message}\n`);
  }
}

// One poll across all targets: detect changes, apply the debounce, re-index what is ready. Split
// out from the timer so a test can drive ticks deterministically without real time.
async function tick(pool, targets, io) {
  for (const target of targets) {
    let changes;
    try {
      changes = await computeChangesAsync(target.repoPath, target.recordedSha);
    } catch (_) {
      continue;                              // a transient git error: try again next poll
    }
    const clean = !changes.changed.length && !changes.removed.length
      && (!changes.head || changes.head === target.recordedSha);
    const sig = signatureOf(changes);
    const step = debounceStep(target.state, sig, clean);
    target.state = { prev: step.prev, applied: step.applied };
    if (step.act) await reindexTarget(pool, target, changes, io);
  }
}

async function runWatch(parsed, io) {
  const { out, err } = io;
  const pool = require('../db/pool');
  const intervalMs = parsed.interval > 0 ? parsed.interval : DEFAULT_INTERVAL_MS;
  // Each re-index is a full incremental ingest and prints the same per-pass narration a one-shot
  // ingest does. Quiet by default (--verbose to see it) so the watch surface is just the one clean
  // line per re-index that runWatch emits on stdout.
  const log = require('./stderr-filter').install({ verbose: parsed.verbose });

  const targets = [];
  for (const input of parsed.paths) {
    const repoPath = resolveRepoPath(input);
    let target = null;
    try {
      target = await resolveTarget(pool, repoPath, parsed.project);
    } catch (e) {
      err(`watch: could not index ${repoPath} (${e.message.split('\n')[0]}) — skipping it.\n`);
      continue;
    }
    if (!target) {
      err(`watch: could not index ${repoPath} — skipping it.\n`);
      continue;
    }
    targets.push(target);
  }
  if (!targets.length) {
    log.restore();
    throw cliError('watch: nothing to watch.', EXIT.NOT_FOUND);
  }

  out(`Watching ${targets.length} repo(s) every ${intervalMs}ms. Edit, commit, checkout — the graph follows. Ctrl-C to stop.\n`);
  for (const t of targets) out(`  ${t.project}/${path.basename(t.repoPath)}  @ ${(t.recordedSha || '-').slice(0, 8)}\n`);

  return new Promise((resolve) => {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;                   // a slow re-index must not overlap the next poll
      running = true;
      try { await tick(pool, targets, io); } catch (e) { err(`watch: ${e.message}\n`); }
      running = false;
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      log.restore();
      err('\nwatch: stopped.\n');
      resolve(EXIT.OK);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

module.exports = { runWatch, tick, reindexTarget, resolveTarget, DEFAULT_INTERVAL_MS };
