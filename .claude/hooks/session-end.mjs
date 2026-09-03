#!/usr/bin/env node
// SessionEnd / Stop → turn captured events into facts.
//
// Registered on BOTH events on purpose. `Stop` fires every turn, so a lesson is available to the
// next turn rather than to the next session; `SessionEnd` catches the case where the process goes
// away without a Stop. Re-running is safe — harvest.js dedupes on lesson identity.
//
// Contract, in order of how expensive getting it wrong is:
//   1. Never fail or delay the user's turn. Every path exits 0, and the whole thing is bounded.
//   2. Never write to stdout. In an MCP context stdout is JSON-RPC and any byte here corrupts it.
//   3. Never open graph.db — better-sqlite3 is synchronous with a busy wait, so one require of
//      resolve.js is a stalled editor for the length of an ingest. Anchors from this path are
//      file-grain; `koragraph practice harvest` re-resolves them against the graph offline.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const root = process.env.KORAGRAPH_PRACTICE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : null;
  if (input && input.session_id) {
    const { openPracticeDb } = require(join(root, 'src', 'practice', 'db.js'));
    const { harvestSession } = require(join(root, 'src', 'practice', 'harvest.js'));
    const { closeEpisode } = require(join(root, 'src', 'practice', 'episodes.js'));
    const db = openPracticeDb();
    try {
      // Independent of harvest, and first: closing the episode is bookkeeping over events that
      // already exist, while harvesting runs a matcher that can throw on a shape nobody has seen.
      // Ordered the other way, one bad lesson loses the label for every event in the turn.
      try { closeEpisode(db, { sessionId: input.session_id, agentId: null }); } catch (e) {
        if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[practice] episode ${e.stack}\n`);
      }
      // The whole session, not `agentId: input.agent_id`. Stop carries no agent id, so passing it
      // scopes to the main loop and every subagent's lesson is never harvested by anything.
      // runFailFix still separates the agents internally, so widening here cannot manufacture a
      // cross-agent pair.
      harvestSession(db, null, { sessionId: input.session_id });
    } finally {
      db.close();
    }
  }
} catch (err) {
  if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[practice] ${err.stack}\n`);
}
process.exit(0);
