'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

// A `--depth 1` clone leaves exactly one commit in the checkout.
// git-coupling-analyzer.js derives COUPLED_WITH from co-change across commits,
// so on a remote ingest it would see a single commit, find no pairs, and write
// 0 edges.
//
// `--filter=blob:none` is a partial clone: the full commit and tree history
// comes down, file contents are fetched lazily and only for the checked-out
// commit. `git log --name-only` works against it without fetching a single
// extra blob (name-only reads trees, which a blobless clone keeps).
//
// Servers that do not advertise the filter capability reject the clone, so the
// shallow clone stays as the fallback: coupling degrades to 0 exactly as it did
// before, rather than the ingest failing.
const HISTORY_CLONE_ARGS = ['--filter=blob:none'];
const SHALLOW_CLONE_ARGS = ['--depth', '1'];

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

// Scrub embedded credentials before an error escapes — execFile puts the whole
// command line, auth URL included, in err.message.
function scrub(message) {
  return String(message).replace(/https?:\/\/[^@\s]+@/g, 'https://[credentials]@');
}

/**
 * Clone `cloneUrl` into `destDir` with enough history for co-change analysis,
 * falling back to a shallow clone when the remote refuses partial clone.
 */
async function cloneWithHistory(cloneUrl, destDir, { timeout = 120_000, logPrefix = 'git-clone' } = {}) {
  try {
    await run(['clone', ...HISTORY_CLONE_ARGS, cloneUrl, destDir], timeout);
    return { mode: 'blobless' };
  } catch (err) {
    console.warn(`[${logPrefix}] partial clone unavailable, falling back to depth-1 (git coupling will be empty): ${scrub(err.message)}`);
    // A refused clone can still leave a partial destDir behind, and `git clone`
    // refuses a non-empty target — the fallback would fail for the wrong reason.
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) { /* clone will report it */ }
  }
  try {
    await run(['clone', ...SHALLOW_CLONE_ARGS, cloneUrl, destDir], timeout);
    return { mode: 'shallow' };
  } catch (err) {
    throw new Error(scrub(err.message));
  }
}

module.exports = { cloneWithHistory, HISTORY_CLONE_ARGS, SHALLOW_CLONE_ARGS };
