'use strict';

// Keeps a tool ANSWER current with the working tree, without the developer having to remember a
// separate `--watch` process or a manual re-ingest. The read path itself checks, and catches up
// only what is actually dirty, right before answering — so the cost is paid exactly once per real
// edit, exactly when something is asked about it, never on an idle background clock.
//
// Two granularities, chosen by what the caller already knows:
//   - ensureFilesFresh: the caller named specific file(s) (file_symbols' `path`, blast_radius's
//     `files_changed`, a resolved symbol's own file). Cheapest possible check — one stat + one
//     hash per file, compared against the `files` rows the graph already tracks them under. No
//     git, no subprocess. Several files check and catch up together in ONE ingest call, not one
//     per file.
//   - ensureRepoFresh: the caller has no file to scope to at all (explore's query-driven search,
//     search_code, recall/neighbours with no `file`, overview). Falls back to the same
//     `git status`-based dirty set `--watch` already uses (repo-watcher.js), scoped to whatever
//     that reveals.
//
// Both funnel into the exact same `runIncrementalIngest` the CLI and `--watch` already use — this
// is a new TRIGGER, not a new ingest mechanism. Never throws: a freshness probe that can fail a
// tool call is worse than one that occasionally answers one edit late.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const pool = require('../db/pool');

// A burst of tool calls in the same few seconds (an agent calling explore three times in a row
// while reasoning about one function) should not each re-stat/re-hash/re-query the same file or
// re-run `git status` on the same repo. Short TTL, not a cache of the ANSWER — only of "did we
// already just check this."
const TTL_MS = Number(process.env.KORAGRAPH_FRESHNESS_TTL_MS) > 0
  ? Number(process.env.KORAGRAPH_FRESHNESS_TTL_MS)
  : 1500;

const fileChecked = new Map(); // cache key -> { at, promise }
const repoChecked = new Map(); // cwd -> { at, promise }

function cacheGuard(map, key, ttl, fn) {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.at < ttl) return hit.promise;
  const promise = fn().catch(() => null);
  map.set(key, { at: now, promise });
  return promise;
}

// Same four-way match (root/identity/web_url/name) resolve.js#resolveBranch already implements
// and tests for the practice layer — reused as-is via a short-lived read-only handle, rather than
// re-deriving repo/branch identity a second, possibly-diverging way. `repoRoot` comes from
// repoIdentity(cwd) (a pure filesystem/git operation), not the graph's own `full_path` column,
// which the ingest path can store as a bare repo NAME rather than a real directory — see
// checkoutRoot's own comment in resolve.js.
function branchRowFor(cwd) {
  const { repoIdentity } = require('../practice/repo-identity');
  const { openGraphDb, resolveBranch } = require('../practice/resolve');
  const identity = repoIdentity(cwd);
  if (!identity.repoRoot) return null;
  let graphDb;
  try {
    graphDb = openGraphDb();
  } catch {
    return null; // no graph.db yet — nothing to freshen
  }
  try {
    const match = resolveBranch(graphDb, {
      repoId: identity.repoId, repoName: identity.repoName, repoRoot: identity.repoRoot,
    });
    if (!match) return null;
    // The graph's last-indexed commit for this branch. ensureRepoFresh needs it to fold in files a
    // PRIOR session committed (HEAD moved past this SHA) — `git status` alone only reports the
    // working tree, so a committed-and-untouched change would otherwise never be caught on read.
    const shaRow = graphDb.prepare('SELECT last_commit_sha FROM repository_branches WHERE id = ?').get(match.branchId);
    return {
      repoPath: identity.repoRoot,
      projectId: null, // resolved from the repository row on first use — see projectIdFor
      repoId: match.repositoryId,
      branchId: match.branchId,
      branchName: match.branchName,
      recordedSha: shaRow ? shaRow.last_commit_sha : null,
    };
  } finally {
    try { graphDb.close(); } catch { /* already gone */ }
  }
}

async function projectIdFor(repositoryId) {
  const { rows } = await pool.query('SELECT project_id FROM repositories WHERE id = $1', [repositoryId]);
  return rows[0] ? rows[0].project_id : null;
}

function hashOf(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  // Matches ingest-file-processor.js's own fileSha computation exactly (sha256 of the raw utf8
  // content, first 40 hex chars) — a mismatched algorithm here would make every file look dirty
  // on every call, which is a correctness-neutral but very expensive bug (a false "dirty" still
  // pays the full unscoped tail on this incremental run, since nothing was actually touched to
  // scope resolveCallExpressionEdges against).
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
}

// `newCommitSha` advances the branch's recorded SHA to the caught-up HEAD. ensureRepoFresh passes
// it (its change set is the full commit-diff, so recording HEAD is correct and stops every later
// read re-diffing the same range); ensureFilesFresh must NOT — its set is only the named files, so
// claiming the branch is at HEAD would skip every other file the same commit touched.
async function runCatchUp(branchRow, changedPaths, removedPaths, newCommitSha = null) {
  const { runIncrementalIngest } = require('./ingest');
  const { openJob, closeJob } = require('../cli/ingest');
  const projectId = branchRow.projectId ?? await projectIdFor(branchRow.repoId);
  const jobId = await openJob(pool, {
    projectId, repoPath: branchRow.repoPath, branchName: branchRow.branchName,
    stack: null, jobType: 'INCREMENTAL',
  });
  try {
    const res = await runIncrementalIngest({
      repoPath: branchRow.repoPath, projectId, repoId: branchRow.repoId,
      branchId: branchRow.branchId, branchName: branchRow.branchName,
      changedPaths, removedPaths, newCommitSha, jobId,
    });
    await closeJob(pool, jobId, {
      status: res.errors > 0 ? 'DEGRADED' : 'COMPLETE',
      files_done: res.done || 0, files_total: (res.done || 0) + (res.skipped || 0),
      nodes_written: res.nodes || 0,
    });
  } catch (err) {
    await closeJob(pool, jobId, { status: 'FAILED', error_msg: String(err.message || err).slice(0, 2000) })
      .catch(() => {});
    return; // the graph didn't move — nothing for revalidation to check against yet
  }
  revalidatePractice();
}

// The graph catching up is only half the freshness story — a fact/open-loop anchored to code
// that just changed still needs its own check against the NEW body (unconfirmed_since, a
// rename/move follow, an orphan expiry). `koragraph ingest` already runs this right after every
// ingest (cli/ingest.js); this is the same pairing, just on the reactive per-query trigger
// instead of only a manual/CLI ingest. Best-effort and silent: this fires on the read path behind
// a tool call already in flight, and a revalidation hiccup must never surface as a tool error.
// Sync (better-sqlite3), same as the CLI path — practice.db is small (facts, not graph nodes), so
// this is cheap relative to the ingest tail it rides behind. Deliberately skips the CLI's
// ops_runs audit-log row: that is for a deliberate `koragraph ingest`/`revalidate` invocation, and
// this can fire many times per session — logging every one would make the audit trail noise, not
// signal, without changing what the developer can actually do about it.
function revalidatePractice() {
  let practice;
  let graph;
  try {
    practice = require('../practice/db').openPracticeDb();
    const liveFacts = practice.prepare('SELECT count(*) c FROM facts WHERE expired_at IS NULL').get().c;
    if (!liveFacts) return;
    graph = require('../practice/resolve').openGraphDb();
    require('../practice/revalidate').revalidate(practice, graph);
    try { require('../practice/loop-anchors').revalidateLoopAnchors(practice, graph); } catch { /* best-effort */ }
  } catch {
    // No practice.db yet, a locked file, a mid-migration store — say nothing, try again next call.
  } finally {
    if (graph) { try { graph.close(); } catch { /* already gone */ } }
    if (practice) { try { practice.close(); } catch { /* already gone */ } }
  }
}

// `file` is repo-relative, the same form every tool already carries (files.path). Convenience
// single-file wrapper over the plural form below.
async function ensureFileFresh({ cwd = process.cwd(), file } = {}) {
  if (!file) return;
  return ensureFilesFresh({ cwd, files: [file] });
}

// blast_radius's files_changed is an array — checking and, if needed, catching up each file with
// its own separate ingest call would pay the whole-branch tail cost once PER file instead of once
// for the batch. One dirty set computed for all of them, one catch-up call for whichever are
// actually dirty.
async function ensureFilesFresh({ cwd = process.cwd(), files = [] } = {}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return;
  const key = `${cwd} ${list.slice().sort().join(',')}`;
  return cacheGuard(fileChecked, key, TTL_MS, async () => {
    const branchRow = branchRowFor(cwd);
    if (!branchRow) return;

    const relPaths = [];
    for (const file of list) {
      const relPath = path.isAbsolute(file) ? path.relative(branchRow.repoPath, file) : file.replace(/^\.\//, '');
      if (!relPath.startsWith('..')) relPaths.push(relPath); // outside this checkout: not ours to freshen
    }
    if (!relPaths.length) return;

    const { rows } = await pool.query(
      `SELECT path, file_sha FROM files
        WHERE repository_branch_id = $1 AND index_status != 'REMOVED'
          AND path IN (SELECT value FROM json_each($2))`,
      [branchRow.branchId, relPaths],
    );
    const storedByPath = new Map(rows.map((r) => [r.path, r.file_sha]));

    const changed = [];
    const removed = [];
    for (const relPath of relPaths) {
      const absPath = path.join(branchRow.repoPath, relPath);
      const onDisk = fs.existsSync(absPath);
      const stored = storedByPath.get(relPath);
      if (!onDisk) {
        if (stored !== undefined) removed.push(relPath); // deleted since last look
        continue;
      }
      if (stored === undefined) { changed.push(relPath); continue; } // new file, never seen
      let currentSha;
      try { currentSha = hashOf(absPath); } catch { continue; } // unreadable — leave it, not our call
      if (currentSha !== stored) changed.push(relPath);
    }
    if (changed.length || removed.length) await runCatchUp(branchRow, changed, removed);
  });
}

// No single file to scope to — the same working-tree dirty set `--watch` computes
// (repo-watcher.js), applied once instead of polled.
async function ensureRepoFresh({ cwd = process.cwd() } = {}) {
  return cacheGuard(repoChecked, cwd, TTL_MS, async () => {
    const branchRow = branchRowFor(cwd);
    if (!branchRow) return;
    // computeChangesAsync, not computeChanges: it folds the commit-diff (recordedSha..HEAD) into the
    // working-tree set, so a change a prior session COMMITTED and never re-touched is caught here on
    // the next repo-scoped read — not left lagging until a manual `koragraph ingest`. Paid once per
    // new commit: runCatchUp advances the recorded SHA to HEAD, after which this is a working-tree-
    // only no-op again.
    const { computeChangesAsync } = require('./repo-watcher');
    let changes;
    try { changes = await computeChangesAsync(branchRow.repoPath, branchRow.recordedSha); } catch { return; } // not a git repo, or git unavailable
    if (!changes.changed.length && !changes.removed.length) return;
    await runCatchUp(branchRow, changes.changed, changes.removed, changes.head);
  });
}

function resetFreshnessCache() { fileChecked.clear(); repoChecked.clear(); }

module.exports = { ensureFileFresh, ensureFilesFresh, ensureRepoFresh, resetFreshnessCache };
