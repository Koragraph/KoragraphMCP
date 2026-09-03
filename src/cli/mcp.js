'use strict';

const { parseCommandArgs } = require('./args');
const { EXIT, usageError } = require('./errors');

const OPTIONS = {
  help: { type: 'boolean', short: 'h', default: false },
};

const USAGE = `Usage: koragraph mcp

Serve the graph to your editor over MCP on stdio. This is the command you put in an MCP
config; it speaks JSON-RPC on stdout and nothing else, and every log line goes to stderr.

Claude Code, from a checkout:
  claude mcp add koragraph -- node /absolute/path/to/bin/koragraph.js mcp

Or, in an mcp.json:
  { "mcpServers": { "koragraph": { "command": "node",
      "args": ["/absolute/path/to/bin/koragraph.js", "mcp"] } } }

The npx form is not shown because the package is unpublished — run it from a checkout.
\`koragraph doctor\` prints the line above with this checkout's absolute path already in it.

The session ends when the editor closes stdin. Index a repository with \`koragraph ingest\`
first — with an empty store the tools answer with the command to run, not an error.

Options:
  -h, --help  Show this help.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length) throw usageError(`mcp takes no arguments (got "${positionals[0]}").`);
  return { help: false };
}

async function run() {
  // src/mcp/start.js IS the entry point — requiring it starts the server rather than restating
  // its stdout redirect, its crash handlers and its exit-on-stdin-close. It owns the process from
  // here; returning lets the CLI set an exit code that only applies if the server never starts.
  require('../mcp/start');
  return EXIT.OK;
}

module.exports = { parse, run, USAGE, OPTIONS };
