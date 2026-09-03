'use strict';

const { EXIT, classify } = require('./errors');
const { version } = require('../../package.json');

// Loaders, not modules: `koragraph --help` and every parse error must resolve without opening the
// store or pulling in tree-sitter. Each command module requires only node builtins at load time
// and takes its services inside run().
const COMMANDS = {
  ingest: { summary: 'Index one or more local repositories into the graph', load: () => require('./ingest') },
  status: { summary: 'Show what is in the graph and when it was last indexed', load: () => require('./status') },
  report: { summary: 'Write a Markdown snapshot of the graph (GRAPH_REPORT.md)', load: () => require('./report') },
  serve: { summary: 'Open an interactive picture of the graph in your browser (local, no network)', load: () => require('./serve') },
  doctor: { summary: 'Check the install end to end and name a remedy for anything wrong', load: () => require('./doctor') },
  cochange: { summary: 'Show what has historically changed together with a symbol', load: () => require('./cochange') },
  diff: { summary: 'Show which declarations appeared or disappeared in the last re-index', load: () => require('./diff') },
  trace: { summary: 'Run tests and fold the calls that actually happened into the graph (Python)', load: () => require('./trace') },
  hooks: { summary: 'Install git hooks that re-index a repository automatically on commit/checkout', load: () => require('./hooks') },
  practice: { summary: 'Inspect, correct and maintain what has been learned about this code', load: () => require('./practice') },
  mcp: { summary: 'Serve the graph to your editor over MCP on stdio', load: () => require('./mcp') },
};

const HELP = `koragraph — a local, multi-repo code graph for your coding agent

Usage: koragraph <command> [options]

Commands:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)}${c.summary}`).join('\n')}

  koragraph <command> --help    Options for one command
  koragraph --version           Print the version

The graph lives in a single SQLite file: $KORAGRAPH_DB, or graph.db under $KORAGRAPH_HOME,
or ~/.koragraph/graph.db. Nothing leaves your machine and no API tokens are spent.

What has been LEARNED about the code lives in a second file beside it, practice.db, and it is
durable where the graph is disposable: delete graph.db and re-ingest and it is back, but
"we tried pooling here and reverted it" cannot be rebuilt from anything.

Config note: a .env file in the CURRENT WORKING DIRECTORY is loaded when the store opens, and
its values do not override variables already set in the environment.
`;

async function run(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => process.stderr.write(s));
  const [name, ...rest] = argv;

  if (!name || name === 'help' || name === '--help' || name === '-h') { out(HELP); return EXIT.OK; }
  if (name === '--version' || name === '-v') { out(`${version}\n`); return EXIT.OK; }

  const entry = COMMANDS[name];
  if (!entry) {
    err(`koragraph: unknown command "${name}".\n\n${HELP}`);
    return EXIT.USAGE;
  }

  // stdout is the JSON-RPC channel for `koragraph mcp`, and services on both the read and the
  // ingest path call console.log unconditionally — one such line corrupts a session for good.
  // Same redirect src/mcp/start.js applies, hoisted ahead of the first service load so it also
  // covers module-load-time logging. It costs the other commands nothing: their own output goes
  // through `out` below, so stdout stays the result channel and stderr carries the narration.
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);
  console.debug = (...args) => console.error(...args);
  console.dir = (...args) => console.error(...args);

  const command = entry.load();
  try {
    const parsed = command.parse(rest);
    if (parsed.help) { out(`${command.USAGE}\n`); return EXIT.OK; }
    return await command.run(parsed, { out, err });
  } catch (raw) {
    const e = classify(raw);
    err(`koragraph: ${e.message}\n`);
    if (e.hint) err(`${e.hint}\n`);
    if (Array.isArray(e.near_misses) && e.near_misses.length) {
      err(`Did you mean:\n${e.near_misses.map((n) => `  ${n.name}${n.file ? `  ${n.file}${n.line ? `:${n.line}` : ''}` : ''}`).join('\n')}\n`);
    }
    if (process.env.KORAGRAPH_CLI_TRACE) err(`${raw?.stack || raw}\n`);
    return e.exitCode;
  } finally {
    // better-sqlite3 does not hold the event loop open, but leaving the handle open leaves the
    // -wal/-shm files behind on a WAL database. Gated on the module already being loaded, because
    // requiring src/db/pool.js CREATES the database file and applies the schema — a mistyped flag
    // must not leave a store behind. `mcp` owns its own lifetime and never lands here.
    if (command.USES_STORE && require.cache[require.resolve('../db/pool')]) {
      await require('../db/pool').end().catch(() => {});
    }
  }
}

module.exports = { run, COMMANDS, HELP };
