'use strict';

// Deferral seam for declaration-grain co-change mining.
//
// Co-change mining reads the whole git history and re-parses every changed file at every commit;
// measured at 50-84% of an ingest's wall time. The structural graph (nodes + every resolved edge
// plane except CO_CHANGES) is complete and committed long before it finishes, so blocking the
// "graph ready" report on it makes the tool feel minutes slow when it is queryable in seconds.
//
// The fix is not to speed the mine up but to move it off the critical path: `koragraph ingest`
// commits and reports the structural graph, then this spawns a DETACHED child that opens the same
// SQLite store and merges CO_CHANGES in the background. WAL lets the graph be read — and this one
// edge plane be written — while the parent has already exited. The write is an idempotent upsert
// (see writePairs' ON CONFLICT), so a background pass that overlaps a later ingest only rewrites
// the same edges.
//
// This module requires only node builtins so it stays cheap to load on the ingest path; the child
// it launches (cochange-worker.js) is the one that pulls in the pool and the miner.

const { spawn } = require('child_process');
const path = require('path');

// The single source of truth for the four knobs, read from the environment in one place so the
// inline mine (ingest-post-tail.js, used by the MCP/webhook path) and the detached worker cannot
// drift into mining with different parameters — every published co-change number was measured at
// these defaults.
function coChangeMineOptions(env = process.env) {
  return {
    maxFiles: parseInt(env.COCHANGE_MAX_FILES || '20', 10),
    maxDecls: parseInt(env.COCHANGE_MAX_DECLS || '30', 10),
    minSupport: parseFloat(env.COCHANGE_MIN_SUPPORT || '2'),
    halfLifeDays: parseFloat(env.COCHANGE_HALF_LIFE_DAYS || '3650'),
  };
}

// Launch the background mine and return immediately. `COCHANGE_EDGES=off` is the same kill switch
// the inline path honours — off means no plane at all, so there is nothing to defer and no child
// is spawned.
//
// detached + unref lets the parent CLI exit while the child runs on; stdio is ignored because the
// child has no console to write to once the parent's terminal is gone, and anything it needs to
// say about failure belongs in the store's job/degradation record, not orphaned stderr. env and
// cwd are passed through so the child resolves the SAME store (a relative KORAGRAPH_DB is resolved
// against cwd) and reads the same .env the parent did.
function spawnDetachedCoChange({ branchId, repoPath, env = process.env } = {}) {
  if (env.COCHANGE_EDGES === 'off') return { spawned: false, reason: 'COCHANGE_EDGES=off' };
  if (!Number.isFinite(branchId) || !repoPath) {
    return { spawned: false, reason: 'missing branchId or repoPath' };
  }
  const worker = path.join(__dirname, 'cochange-worker.js');
  const child = spawn(process.execPath, [worker, String(branchId), repoPath], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env,
  });
  child.unref();
  return { spawned: true, pid: child.pid };
}

module.exports = { coChangeMineOptions, spawnDetachedCoChange };
