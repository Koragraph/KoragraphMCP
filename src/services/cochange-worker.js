'use strict';

// The detached background pass spawned by cochange-defer.js#spawnDetachedCoChange.
//
// It runs in its OWN process, opening its own connection to the same SQLite store the structural
// ingest already committed. `koragraph ingest` has reported "graph ready" and exited by the time
// this writes; WAL lets the graph keep serving reads while this merges the CO_CHANGES plane in.
//
//   argv[2] = branchId   argv[3] = repoPath
//
// Never throws out of the process: it is unref'd and detached, so an uncaught rejection would only
// print to a terminal that is no longer attached. A mine that cannot run leaves the structural
// graph exactly as it was — co-change is enrichment, never substrate.

async function main() {
  const branchId = parseInt(process.argv[2], 10);
  const repoPath = process.argv[3];
  // COCHANGE_EDGES=off is the same kill switch the inline path honours; the spawner already gates
  // on it, but a directly-invoked worker must respect it too.
  if (!Number.isFinite(branchId) || !repoPath || process.env.COCHANGE_EDGES === 'off') {
    process.exit(0);
  }

  const pool = require('../db/pool');
  const { mineCoChangeEdges } = require('./cochange-miner');
  const { coChangeMineOptions } = require('./cochange-defer');

  let code = 0;
  try {
    await mineCoChangeEdges(repoPath, branchId, coChangeMineOptions());
  } catch (_) {
    code = 1;
  } finally {
    await pool.end().catch(() => {});
  }
  process.exit(code);
}

if (require.main === module) main();
