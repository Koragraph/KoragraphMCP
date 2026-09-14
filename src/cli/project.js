'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { parseCommandArgs, positiveInt } = require('./args');
const { EXIT, usageError, cliError } = require('./errors');

// This command opens practice.db READ-ONLY and writes only Markdown. It manages its own handle and
// never touches graph.db, so USES_STORE stays false (main.js would otherwise create graph.db).
const USES_STORE = false;

const DEFAULT_OUT = 'memory';
const DEFAULT_INTERVAL_SEC = 2;

const OPTIONS = {
  help: { type: 'boolean', short: 'h', default: false },
  out: { type: 'string', short: 'o' },
  interval: { type: 'string' },
  once: { type: 'boolean', default: false },
};

const USAGE = `Usage: koragraph project [--out <dir>] [--once] [--interval <sec>]

Project the practice store (practice.db) into a tree of readable Markdown that a human can read and
git-diff. The store stays the source of truth; this is a one-way, deterministic VIEW — the same
store always renders the same bytes, and memory is never written back from Markdown into the store.

  <out>/MEMORY.md              index: counts, a "needs attention" queue, links to every file
  <out>/<repo>/<file>.md       the facts anchored to that file (symbol facts nested beneath it)
  <out>/<repo>/_general.md     repo-wide facts

By default it runs as a daemon: render now, then re-render whenever the store changes.

Options:
  -o, --out <dir>       Where to write the tree (default: ${DEFAULT_OUT}).
      --once            Render once and exit (for CI / pre-commit). Otherwise runs as a daemon.
      --interval <sec>  Daemon poll interval in seconds (default: ${DEFAULT_INTERVAL_SEC}).
  -h, --help            Show this help.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length) throw usageError(`project takes no positional arguments (got "${positionals[0]}").`);
  return {
    help: false,
    out: values.out || DEFAULT_OUT,
    once: values.once === true,
    intervalSec: positiveInt(values.interval, '--interval', DEFAULT_INTERVAL_SEC),
  };
}

async function run(parsed, { out, err }) {
  const { practiceDbPath } = require('../practice/paths');
  const file = practiceDbPath();
  if (file !== ':memory:' && !fs.existsSync(file)) {
    throw cliError(`no practice store at ${file} — nothing to project yet.`, EXIT.USAGE, {
      hint: 'The store is created the first time a lesson is recorded.',
    });
  }

  const outDir = path.resolve(parsed.out);
  const { projectOnce, watch } = require('../practice/project/daemon');

  if (parsed.once) {
    const t = projectOnce({ file, outDir });
    out(`projected to ${outDir}: ${t.written} written, ${t.deleted} deleted, ${t.unchanged} unchanged\n`);
    return EXIT.OK;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  err(`watching ${file} → ${outDir} (every ${parsed.intervalSec}s; Ctrl-C to stop)\n`);
  await watch({
    file,
    outDir,
    intervalMs: parsed.intervalSec * 1000,
    log: (line) => err(`${line}\n`),
    signal: controller.signal,
  });
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  return EXIT.OK;
}

module.exports = { parse, run, USAGE, USES_STORE };
