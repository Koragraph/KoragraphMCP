'use strict';

const { parseCommandArgs, positiveInt } = require('./args');
const { EXIT, cliError, usageError, nearMisses } = require('./errors');

const USES_STORE = true;

const OPTIONS = {
  file: { type: 'string' },
  project: { type: 'string' },
  limit: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

// The caveat is not optional: a CLI that prints a ranked list with no qualifier reads as a
// guarantee, when these edges are historical evidence, not a prediction.
const CAVEAT = [
  'These edges are mined from git history at DECLARATION grain — "this function changes with',
  'that function", not the usual file-level co-change. The signal is repo-dependent: on some',
  'histories it is strong, on others essentially flat. It is evidence about how this repository',
  'has changed, not a guarantee about your next change.',
].join('\n');

const USAGE = `Usage: koragraph cochange <symbol> [options]

Show the declarations that have historically changed in the same commits as <symbol>.

<symbol> is a name, optionally qualified by a file: "readAsCSV" or "io/reader.go:readAsCSV".

Options:
  --file <path>     Disambiguate when the name occurs in more than one file.
  --project <name>  Restrict to one project.
  --limit <n>       Maximum results (default 20).
  -h, --help        Show this help.

${CAVEAT}`;

const DEFAULT_LIMIT = 20;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length === 0) throw usageError(`cochange needs a symbol.\n\n${USAGE}`);
  if (positionals.length > 1) {
    throw usageError(`cochange takes one symbol (got ${positionals.length}: ${positionals.join(', ')}). `
      + 'Quote it if the name contains spaces.');
  }
  return {
    help: false,
    symbol: positionals[0],
    file: values.file || null,
    project: values.project || null,
    limit: positiveInt(values.limit, '--limit', DEFAULT_LIMIT),
  };
}

async function projectIdByName(pool, name) {
  const { rows } = await pool.query('SELECT id FROM projects WHERE name = $1', [name]);
  if (!rows.length) throw cliError(`No project named "${name}" is in the graph.`, EXIT.NOT_FOUND);
  return rows[0].id;
}

function location(node) {
  if (!node.file?.path) return '';
  return `${node.file.path}${node.start_line ? `:${node.start_line}` : ''}`;
}

async function run(parsed, io) {
  const { out, err } = io;
  const pool = require('../db/pool');
  // Reused rather than re-queried: symbol-resolver.js already composes the exact retrieval channel
  // into name -> node ids, with the near-miss reporting a bare SELECT would not have.
  const { resolveSymbol } = require('../mcp/symbol-resolver');
  const { getCalleesForOrg } = require('../services/graph-tool-service');
  const { LOCAL_ORG_ID } = require('../config/local-org');

  const projectId = parsed.project ? await projectIdByName(pool, parsed.project) : null;
  const quiet = require('./stderr-filter').install({
    summarised: [], detail: require('./stderr-filter').RETRIEVER_DETAIL, silenceMs: 0,
  });
  let resolution;
  let graph;
  try {
    resolution = await resolveSymbol({ symbol: parsed.symbol, file: parsed.file, projectId });
    // CO_CHANGES is stored in both directions with an ASYMMETRIC confidence, so the outgoing side
    // is the one that answers "when I touch this, what else do I touch" — the converse is a
    // different claim and a different number.
    graph = await getCalleesForOrg(LOCAL_ORG_ID, {
      node_id: resolution.resolved[0].node_id,
      edge_types: ['CO_CHANGES'],
      include_imports: true,
    });
  } catch (e) {
    if (e && e.near_misses) e.near_misses = nearMisses(parsed.symbol, e.near_misses);
    throw e;
  } finally {
    quiet.restore();
  }
  const { resolved, ambiguous } = resolution;

  const target = resolved[0];
  if (ambiguous) {
    err(`"${parsed.symbol}" matches ${resolved.length} declarations; showing ${location(target) || target.name}. `
      + 'Use --file to pick another:\n'
      + `${resolved.slice(1, 6).map((n) => `  ${n.file || '?'}${n.line ? `:${n.line}` : ''}`).join('\n')}\n`);
  }

  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const results = edges
    .map((e) => ({ node: byId.get(e.to_node_id), confidence: e.confidence ?? 0 }))
    .filter((r) => r.node)
    .sort((a, b) => b.confidence - a.confidence || String(a.node.name).localeCompare(String(b.node.name)))
    .slice(0, parsed.limit);

  const seed = byId.get(target.node_id);
  out(`${target.name}  ${location(seed || target) || target.file || ''}\n`);

  if (results.length === 0) {
    out('\nNo co-change edges recorded for this declaration.\n');
    err('\nThat is an answer, not a failure: a pair has to clear the decayed-support threshold\n'
      + 'before an edge is written, and mining needs a git checkout with history. Check\n'
      + '`koragraph status` for the co-change count on this repository.\n');
    return EXIT.OK;
  }

  out(`\nChanges together with (share of commits touching ${target.name} that also touched it):\n`);
  const width = Math.max(...results.map((r) => String(r.node.name).length));
  for (const r of results) {
    out(`  ${r.confidence.toFixed(2)}  ${String(r.node.name).padEnd(width)}  ${location(r.node)}\n`);
  }
  err(`\n${CAVEAT}\n`);
  return EXIT.OK;
}

module.exports = { parse, run, USAGE, CAVEAT, USES_STORE, OPTIONS };
