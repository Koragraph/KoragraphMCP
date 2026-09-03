'use strict';

// Exit codes are part of the contract. A wrapper script has to be able to tell "the store is
// locked, retry" from "nothing is indexed yet" without parsing English out of stderr — which is
// the same distinction src/mcp/protocol.js makes for the MCP surface.
const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  STORE_BUSY: 4,
  NO_GRAPH: 5,
  STORE_UNUSABLE: 6,
});

function cliError(message, exitCode, extra = {}) {
  const err = new Error(message);
  err.exitCode = exitCode;
  Object.assign(err, extra);
  return err;
}

function usageError(message) {
  return cliError(message, EXIT.USAGE);
}

const NO_GRAPH_HINT = 'Nothing is indexed yet. Run: koragraph ingest <path to a repository>';
const STORE_UNUSABLE_HINT = 'The store exists but cannot be used — corrupt, read-only, or the disk is full. Retrying will not help: check the file named by $KORAGRAPH_DB (default ~/.koragraph/graph.db), fix its permissions or free space, or delete it and re-run `koragraph ingest`.';
const STORE_BUSY_HINT = 'The graph is intact — an ingest is holding the write lock. Retry in a few seconds.';

// The classification is imported, never re-derived: if the CLI and the MCP surface disagreed about
// what "no graph" means, one of them would tell a developer to rebuild a graph that is merely
// locked. The MESSAGES are ours, because protocol.js writes for an agent and this writes for a
// person at a terminal.
function classify(err) {
  if (!err) return cliError('Unknown failure', EXIT.FAILURE);
  if (err.exitCode !== undefined) return err;

  const { looksLikeStoreBusy, looksLikeStoreUnusable, looksLikeMissingGraph } = require('../mcp/protocol');
  if (looksLikeStoreBusy(err)) {
    return cliError(err.message, EXIT.STORE_BUSY, { hint: STORE_BUSY_HINT });
  }
  // protocol.js grew a third bucket and this classifier did not, so a corrupt or read-only store
  // printed a bare driver string ("file is not a database") with no hint and exit 1, while the MCP
  // surface named $KORAGRAPH_DB and said what to do. The comment above promises these two surfaces
  // cannot disagree; they did.
  if (looksLikeStoreUnusable(err)) {
    return cliError(err.message, EXIT.STORE_UNUSABLE, { hint: STORE_UNUSABLE_HINT });
  }
  if (looksLikeMissingGraph(err)) {
    return cliError(err.message, EXIT.NO_GRAPH, { hint: NO_GRAPH_HINT });
  }
  if (err.code === 'symbol_not_found' || err.status === 404) {
    return cliError(err.message, EXIT.NOT_FOUND, { near_misses: err.near_misses });
  }
  if (err.code === 'invalid_params' || err.status === 400) {
    return cliError(err.message, EXIT.USAGE);
  }
  return cliError(err.message || String(err), EXIT.FAILURE);
}

// symbol-resolver.js builds near_misses from the top of the ranked retrieval, so it was never a
// spelling check: "zzzNotASymbol" was answered with `totals` and seven declarations named `main`.
// A suggestion that is not a plausible typo is worse than silence — it invites the reader to doubt
// a name that is in fact correct, and it makes every real suggestion less believable.
const MAX_SUGGESTIONS = 3;
const MIN_AFFIX = 3;

function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// A dropped or added suffix ("buildAstNode" for buildAstNodes) is a real miss that no edit budget
// scaled to length would catch on a short name, so it is admitted separately — but only when the
// two names are within a factor of two, or every symbol becomes a suggestion for `get`.
function isNearMiss(query, candidate) {
  const q = String(query || '').toLowerCase();
  const c = String(candidate || '').toLowerCase();
  if (!q || !c) return false;
  const [shorter, longer] = q.length <= c.length ? [q, c] : [c, q];
  if (shorter.length >= MIN_AFFIX && shorter.length * 2 >= longer.length
      && (longer.startsWith(shorter) || longer.endsWith(shorter))) return true;
  return editDistance(q, c) <= Math.max(1, Math.floor(longer.length / 4));
}

function nearMisses(query, candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((n) => isNearMiss(query, n && n.name)).slice(0, MAX_SUGGESTIONS);
}

module.exports = {
  EXIT, cliError, usageError, classify, nearMisses, isNearMiss, editDistance,
  NO_GRAPH_HINT, STORE_BUSY_HINT,
};
