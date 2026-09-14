'use strict';

// Orchestration: open the store read-only, snapshot it, render, diff-write. And the sync daemon
// that repeats that on change. The store stays authoritative and untouched — every handle here is
// opened `readonly`, so the projection can never write memory back into practice.db.

const { openPracticeDb } = require('../db');
const { readSnapshot } = require('./snapshot');
const { render } = require('./render');
const { writeProjection } = require('./writer');

function openReadonly(file) {
  return openPracticeDb({ file: file || undefined, readonly: true });
}

// One full pass over an already-open handle. Returns the write tally.
function projectPass(db, outDir) {
  const snapshot = readSnapshot(db);
  const files = render(snapshot);
  return writeProjection(outDir, files);
}

// Render once and stop — the --once / CI / pre-commit path.
function projectOnce({ file, outDir }) {
  const db = openReadonly(file);
  try {
    return projectPass(db, outDir);
  } finally {
    db.close();
  }
}

// PRAGMA data_version on a read-only connection increments whenever any OTHER connection commits a
// write, and is stable across this connection's own reads. Polling it is the cheapest reliable
// change signal: no table scan, no mtime races, no fs-watch debounce.
function dataVersion(db) {
  return db.pragma('data_version', { simple: true });
}

// The sync daemon. Renders immediately, then re-renders whenever the store's data_version moves.
// `signal` (an AbortSignal) stops the loop; `log` receives one line per re-render. Returns a
// promise that resolves when aborted.
function watch({ file, outDir, intervalMs = 2000, log = () => {}, signal }) {
  const db = openReadonly(file);
  let version = dataVersion(db);
  const tally = projectPass(db, outDir);
  log(`projected: ${tally.written} written, ${tally.deleted} deleted, ${tally.unchanged} unchanged`);

  return new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      db.close();
      resolve();
    };
    if (signal) {
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
    }
    const timer = setInterval(() => {
      let next;
      try {
        next = dataVersion(db);
      } catch {
        return; // transient; try again next tick
      }
      if (next === version) return;
      version = next;
      const t = projectPass(db, outDir);
      if (t.written || t.deleted) {
        log(`re-rendered: ${t.written} written, ${t.deleted} deleted`);
      }
    }, intervalMs);
    // The interval is what keeps the process alive: this is a daemon, and it should stay running
    // until aborted. (Do not unref it — an unresolved promise does not hold the event loop open, so
    // an unref'd timer would let Node exit right after the first render.)
  });
}

module.exports = { projectOnce, watch, projectPass, openReadonly };
