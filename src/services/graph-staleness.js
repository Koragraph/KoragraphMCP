'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pool = require('../db/pool');

// Is the graph still describing the code on disk?
//
// Every tool answer carries line numbers and says whether a declaration exists. Both are claims
// about a snapshot, and neither says so. Measured on a real express store one commit behind HEAD:
// `search_code` for a function added by that commit answered "NO DECLARATION NAMED
// brandNewSymbol EXISTS IN THE GRAPH" -- confidently, correctly about the snapshot, and wrongly
// about the repository. An agent acts on that.
//
// The rule this shares with `doctor` and with the practice anchors: an index we cannot CHECK is
// `unknown`, and unknown is never reported as stale. A moved checkout, a deleted directory and a
// repository that was never a git repo look identical from the graph alone, and claiming
// staleness on any of them would train a reader to ignore the warning.

// One `git rev-parse` per repository per window. This runs on the read path, where a burst of
// tool calls would otherwise spawn a process each; 5 s is long enough to cover a burst and short
// enough that a re-ingest is reflected before the developer asks again.
const TTL_MS = Number(process.env.KORAGRAPH_STALENESS_TTL_MS) > 0
  ? Number(process.env.KORAGRAPH_STALENESS_TTL_MS)
  : 5000;

let cache = null;

function headOf(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim() || null;
  } catch {
    return null;
  }
}

async function readRepos(db) {
  const { rows } = await db.query(
    `SELECT r.name AS repo, r.full_path, rb.branch_name, rb.last_commit_sha
       FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id`,
  );
  return rows;
}

// Returns { stale: [...], unknown: n, checked: n }. Never throws: a staleness probe that can fail
// a tool call is worse than one that says nothing.
async function graphStaleness(deps = {}) {
  const now = deps.now || Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;

  const db = deps.pool || pool;
  const value = { stale: [], unknown: 0, checked: 0 };
  try {
    for (const row of await readRepos(db)) {
      value.checked += 1;
      // full_path can hold the repository NAME rather than a path, and a bare name resolves against
      // the CWD. A path with no separator is not a path.
      const root = row.full_path && row.full_path.includes(path.sep) ? row.full_path : null;
      if (!root || !fs.existsSync(root) || !row.last_commit_sha) { value.unknown += 1; continue; }
      const head = headOf(root);
      if (!head) { value.unknown += 1; continue; }
      if (head !== row.last_commit_sha) {
        value.stale.push({
          repo: row.repo,
          branch: row.branch_name,
          indexed: String(row.last_commit_sha).slice(0, 8),
          head: head.slice(0, 8),
        });
      }
    }
  } catch {
    // A store with no schema, a locked database mid-ingest: say nothing rather than fail the call.
    return { stale: [], unknown: 0, checked: 0 };
  }

  cache = { at: now, value };
  return value;
}

// The one line a reader sees. Null when there is nothing to say, which is the common case and is
// not a failure.
function stalenessNote(state) {
  if (!state || !state.stale || !state.stale.length) return null;
  const one = state.stale[0];
  const rest = state.stale.length - 1;
  return `The graph for ${one.repo} is behind its checkout (indexed ${one.indexed}, HEAD ${one.head}`
    + `${rest > 0 ? `, and ${rest} other repositor${rest === 1 ? 'y' : 'ies'}` : ''}). `
    + 'Line numbers may have moved and a declaration added since then will read as missing. '
    + 'Re-run: koragraph ingest';
}

function resetStalenessCache() { cache = null; }

module.exports = { graphStaleness, stalenessNote, resetStalenessCache, TTL_MS };
