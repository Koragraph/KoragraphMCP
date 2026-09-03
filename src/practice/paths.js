'use strict';

const os = require('os');
const path = require('path');

// practice.db sits beside graph.db but is a separate file with a separate connection — that
// separation is the point, not an accident of layout. KORAGRAPH_PRACTICE_DB overrides it
// outright; ':memory:' is honoured for tests.
function practiceDbPath() {
  if (process.env.KORAGRAPH_PRACTICE_DB) return process.env.KORAGRAPH_PRACTICE_DB;
  return path.join(koragraphHome(), 'practice.db');
}

function koragraphHome() {
  return process.env.KORAGRAPH_HOME || path.join(os.homedir(), '.koragraph');
}

// The code graph, opened READ-ONLY and only at use time. Mirrors pool.js's resolution so the two
// stores agree about where the graph lives without this module requiring pool.js — requiring it
// would open graph.db read-write inside the hook process, which the hook path forbids.
function graphDbPath() {
  if (process.env.KORAGRAPH_DB) return process.env.KORAGRAPH_DB;
  return path.join(koragraphHome(), 'graph.db');
}

module.exports = { practiceDbPath, graphDbPath, koragraphHome };
