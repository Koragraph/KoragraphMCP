'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { parseCommandArgs } = require('./args');
const { EXIT, cliError, usageError } = require('./errors');
const { resolveRepoPath, branchTotals } = require('./ingest');

const USES_STORE = true;

const OPTIONS = {
  project: { type: 'string' },
  python: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

const DEFAULT_COMMAND = ['python', '-m', 'pytest', '-q'];

const USAGE = `Usage: koragraph trace <path> [--python python3] [-- <command...>]

Run a repository's own tests (or any command) and fold the calls that ACTUALLY HAPPENED into the
graph as runtime-observed edges. A precise sys.setprofile tracer records every caller->callee call,
deterministically — not a sampled profile — so the result is reproducible. Each observed edge either
CONFIRMS a static CALLS edge (marking it runtime_observed) or ADDS one the static analysis missed;
the summary is the honest static-vs-runtime comparison for this repository and this test run.

The repository must already be indexed. Python only for now (the tracer is sys.setprofile). The
command runs in the repository directory and needs its test dependencies available, exactly as you
would run the tests by hand.

  koragraph trace ./service                       # runs: python -m pytest -q
  koragraph trace ./service -- python run_all.py   # trace an arbitrary command instead

Options:
      --project <name>  Project the repo is indexed under (default: auto-detected from its path).
      --python <bin>    Python interpreter to run the tracer with (default: python3).
  -h, --help            Show this help.

Nothing leaves your machine; this runs your own code and writes to your local graph.`;

// node:util's parseArgs treats a lone `--` as "positionals follow"; the traced COMMAND is exactly
// what comes after it, so split there ourselves before parsing the flags on the left.
function parse(argv) {
  const sep = argv.indexOf('--');
  const flagArgs = sep === -1 ? argv : argv.slice(0, sep);
  const command = sep === -1 ? null : argv.slice(sep + 1);
  const { values, positionals } = parseCommandArgs(flagArgs, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length !== 1) {
    throw usageError('trace needs exactly one repository path.\n\n' + USAGE);
  }
  if (command && command.length === 0) {
    throw usageError('trace: a `--` was given but no command followed it.');
  }
  return {
    help: false,
    path: positionals[0],
    project: values.project || null,
    python: values.python || 'python3',
    command: command || DEFAULT_COMMAND.slice(),
  };
}

async function indexedByPath(pool, repoPath) {
  const { rows } = await pool.query(
    `SELECT p.name AS project, rb.id AS branch_id, rb.branch_name
       FROM repositories r
       JOIN projects p ON p.id = r.project_id
       JOIN repository_branches rb ON rb.repository_id = r.id
      WHERE r.full_path = $1 ORDER BY rb.id LIMIT 1`,
    [repoPath]);
  return rows[0] || null;
}

function tracerPath() {
  return path.resolve(__dirname, '../services/runtime-trace/tracer.py');
}

function runTracer(python, repoPath, command, err) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-trace-')), 'trace.json');
  try {
    execFileSync(python, [tracerPath(), outFile, repoPath, '--', ...command], {
      cwd: repoPath, stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // A non-zero exit from the traced command is not fatal — the tracer still wrote the edges it
    // reached before failing. Only a tracer that produced no file at all is a real error.
    if (!fs.existsSync(outFile)) {
      throw cliError(`trace: could not run ${python} (${e.message.split('\n')[0]}). Is Python installed and on PATH?`, EXIT.NOT_FOUND);
    }
    err(`trace: the traced command exited non-zero — folding in the calls it made before that.\n`);
  }
  if (!fs.existsSync(outFile)) {
    throw cliError('trace: the tracer produced no output.', EXIT.NOT_FOUND);
  }
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

async function run(parsed, io) {
  const { out, err } = io;
  const pool = require('../db/pool');

  const repoPath = resolveRepoPath(parsed.path);
  const indexed = await indexedByPath(pool, repoPath);
  if (!indexed) {
    err(`${repoPath} is not in the graph yet. Index it first: koragraph ingest ${repoPath}\n`);
    return EXIT.NOT_FOUND;
  }

  err(`trace: running \`${parsed.command.join(' ')}\` under the tracer in ${repoPath}\n`);
  const trace = runTracer(parsed.python, repoPath, parsed.command, err);
  if (trace.error) {
    err(`trace: the command raised — ${trace.error.split('\n').filter(Boolean).slice(-1)[0]}\n`);
  }

  const { mergeRuntimeEdges } = require('../services/runtime-trace/merge');
  const res = await mergeRuntimeEdges({ branchId: indexed.branch_id, edges: trace.edges || [] }, pool);

  if (!res.observed) {
    out('No calls were observed — the command ran no repository code, or exited before reaching it.\n');
    return EXIT.OK;
  }
  const totals = await branchTotals(pool, indexed.branch_id);
  const recall = res.staticRecallOfRuntime === null ? 'n/a' : `${(res.staticRecallOfRuntime * 100).toFixed(1)}%`;
  out(`${indexed.project}/${path.basename(repoPath)} ${indexed.branch_name}  runtime trace\n`);
  out(`  observed ${res.observed} call edge(s); ${res.resolved} resolved to declarations `
    + `(${res.unresolved} unresolved, ${res.selfLoops} recursive)\n`);
  const runtimeMissed = res.added + (res.runtimeOnly || 0);
  const newNote = res.runtimeOnly ? ` (${res.added} new this run)` : '';
  out(`  ${res.confirmed} confirmed an existing static edge, ${runtimeMissed} runtime-only — static analysis has no such edge${newNote}\n`);
  out(`  static recall of runtime: ${recall}  →  ${totals.nodes} nodes  ${totals.edges} edges\n`);
  out('  these calls now show as [runtime-confirmed] in `neighbours` and `blast_radius`.\n');
  return EXIT.OK;
}

module.exports = { parse, run, USAGE, OPTIONS, USES_STORE, DEFAULT_COMMAND, indexedByPath };
