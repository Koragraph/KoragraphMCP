'use strict';

// The graph-query verbs as CLI commands, over the same handlers the MCP surface serves. Each
// command is a thin adapter: parse argv into the tool's arguments, call the shared dispatcher, and
// print the result under an output policy the caller controls. The handlers already validate,
// resolve symbols, touch the store and render text; nothing here re-implements a query.
//
// Why the CLI carries flags the MCP surface does not: an MCP tool hands back a structured blob the
// agent can only trim AFTER it has entered context and been billed. A CLI trims BEFORE, so the
// cheap path is the default path. --budget caps the answer to a token ceiling, --no-source drops
// source spans, --format paths reduces to file:line, and the exit code says whether anything was
// found so a hook can decide, without parsing, whether to inject at all.

const { parseCommandArgs, positiveInt } = require('./args');
const { EXIT, usageError, nearMisses } = require('./errors');

// Callers that pipe or inject read exit codes, not prose. 3 (NOT_FOUND) means "the query ran and
// found nothing usable" as distinct from a real error, so a push hook injects nothing on 3 and 124.
const EXIT_TIMEOUT = 124;

// A token is ~4 characters for the text these tools emit. The estimate only has to be good enough to
// pick a line to stop at; the trailing note tells the reader the cut happened.
const CHARS_PER_TOKEN = 4;

// One spec per command. `tool` is the handler name when it differs from the command name; `arg` is
// the tool argument the lone positional fills; `list` collects every positional into an array (blast
// takes many files); `source` marks the one verb that emits source spans, so --no-source has a
// lever to pull. `passthrough` names the flags forwarded verbatim into the tool arguments.
const SPECS = {
  explore: { arg: 'query', required: true, source: true, passthrough: ['detail', 'project_id'] },
  search: { tool: 'search_code', arg: 'query', required: true, passthrough: ['limit', 'detail', 'project_id'] },
  neighbours: { arg: 'symbol', required: true, passthrough: ['file', 'direction', 'depth', 'limit', 'detail', 'project_id'] },
  blast: { tool: 'blast_radius', arg: 'files_changed', list: true, required: true, passthrough: ['depth', 'task_type', 'limit', 'detail', 'project_id'] },
  symbols: { tool: 'file_symbols', arg: 'path', required: true, passthrough: ['limit', 'detail'] },
  overview: { arg: null, required: false, passthrough: ['repo', 'limit', 'detail'] },
  recall: { arg: 'symbol', required: false, passthrough: ['file', 'task_type', 'limit', 'detail'] },
  remember: { arg: 'body', required: false, passthrough: ['kind', 'symbol', 'file', 'fact_id', 'confirm', 'resolve', 'loop_id', 'source', 'note', 'verified'] },
};

// Flags every query command accepts, on top of the per-spec passthroughs. All are strings or
// booleans so node:util parseArgs stays strict; ints are validated where they are read.
const COMMON_OPTIONS = {
  format: { type: 'string' },
  budget: { type: 'string' },
  limit: { type: 'string' },
  source: { type: 'boolean' },
  'no-source': { type: 'boolean' },
  fresh: { type: 'boolean' },
  'no-fresh': { type: 'boolean' },
  timeout: { type: 'string' },
  detail: { type: 'string' },
  project: { type: 'string' },
  direction: { type: 'string' },
  depth: { type: 'string' },
  'task-type': { type: 'string' },
  repo: { type: 'string' },
  kind: { type: 'string' },
  file: { type: 'string' },
  symbol: { type: 'string' },
  'fact-id': { type: 'string' },
  confirm: { type: 'boolean' },
  help: { type: 'boolean', short: 'h', default: false },
};

const FORMATS = new Set(['text', 'compact', 'json', 'paths']);

function usageFor(name, spec) {
  const target = spec.arg
    ? (spec.list ? `<${spec.arg} ...>` : `<${spec.arg}>`)
    : '';
  return `Usage: koragraph ${name} ${target}[options]

Query the graph through the same resolver the MCP tool "${spec.tool || name}" uses.

Output:
  --format <text|compact|json|paths>  text (default) is the full rendering; compact trims to
                                      --budget; json is the structured result; paths is file:line.
  --budget <tokens>                   Cap a compact answer to about this many tokens.
  --limit <n>                         Maximum results, where the tool takes one.
  --no-source                         Drop source spans (explore only emits them).
  --no-fresh                          Skip the live freshness check for speed (may read a snapshot
                                      one commit stale). Default checks freshness.
  --timeout <ms>                      Give up and exit ${EXIT_TIMEOUT} after this many milliseconds.
  --project <name>                    Restrict to one project or repository.
  -h, --help                          Show this help.

Exit codes: 0 found, 3 ran but found nothing, 2 bad usage, ${EXIT_TIMEOUT} timed out.`;
}

// parseArgs delivers hyphenated flags (--task-type, --fact-id, --no-source); the tools want the
// snake/camel keys their schema declares. Normalise once here so run() only ever sees tool keys.
function toToolArgs(name, spec, values, positionals) {
  const args = {};

  if (spec.arg) {
    if (spec.list) {
      if (!positionals.length && spec.required) throw usageError(`${name} needs at least one ${spec.arg}.`);
      if (positionals.length) args[spec.arg] = positionals.slice();
    } else if (positionals.length > 1) {
      throw usageError(`${name} takes one ${spec.arg} (got ${positionals.length}). Quote it if it contains spaces.`);
    } else if (positionals.length === 1) {
      args[spec.arg] = positionals[0];
    } else if (spec.required) {
      throw usageError(`${name} needs a ${spec.arg}.`);
    }
  } else if (positionals.length) {
    throw usageError(`${name} takes no positional arguments (got "${positionals[0]}").`);
  }

  // project is one user-facing flag; the tools name it project_id and accept a name string there.
  if (values.project != null) args.project_id = values.project;

  const map = {
    detail: 'detail', direction: 'direction', repo: 'repo', kind: 'kind',
    file: 'file', symbol: 'symbol', confirm: 'confirm', 'task-type': 'task_type', 'fact-id': 'fact_id',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (values[flag] !== undefined && spec.passthrough.includes(key)) args[key] = values[flag];
  }
  if (values.limit !== undefined && spec.passthrough.includes('limit')) {
    args.limit = positiveInt(values.limit, '--limit');
  }
  if (values.depth !== undefined && spec.passthrough.includes('depth')) {
    args.depth = positiveInt(values.depth, '--depth');
  }
  return args;
}

function parseFor(name, spec) {
  const options = { ...COMMON_OPTIONS };
  return function parse(argv) {
    const { values, positionals } = parseCommandArgs(argv, options);
    if (values.help) return { help: true };

    const format = values.format || 'text';
    if (!FORMATS.has(format)) throw usageError(`--format must be one of ${[...FORMATS].join(', ')} (got "${format}").`);
    if (values.source && values['no-source']) throw usageError('Pass --source or --no-source, not both.');
    if (values.fresh && values['no-fresh']) throw usageError('Pass --fresh or --no-fresh, not both.');

    return {
      help: false,
      name,
      spec,
      format,
      budget: values.budget !== undefined ? positiveInt(values.budget, '--budget') : null,
      source: values['no-source'] ? false : (values.source ? true : null),
      fresh: values['no-fresh'] ? false : true,
      timeout: values.timeout !== undefined ? positiveInt(values.timeout, '--timeout') : null,
      toolArgs: toToolArgs(name, spec, values, positionals),
    };
  };
}

// Walk the structured result for anything that carries a file and a line, in first-seen order, and
// render it as file:line. Deliberately shape-agnostic: every tool nests nodes differently, so a
// recursive scan is more robust than knowing each schema. Dedupes so a node cited as both a hit and
// a neighbour prints once.
function collectPaths(data, out = [], seen = new Set()) {
  if (!data || typeof data !== 'object') return out;
  if (Array.isArray(data)) { for (const v of data) collectPaths(v, out, seen); return out; }
  const file = data.file && typeof data.file === 'object' ? data.file.path : data.file;
  const line = data.start_line ?? data.line ?? null;
  if (typeof file === 'string' && file) {
    const key = line ? `${file}:${line}` : file;
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  }
  for (const v of Object.values(data)) collectPaths(v, out, seen);
  return out;
}

// A success can still be a miss: search fills the page from neighbours, recall returns no facts.
// The exit code has to tell those apart from a real hit so a hook does not inject an empty answer.
function looksEmpty(data, text) {
  if (data && typeof data === 'object') {
    for (const key of ['nodes', 'results', 'facts', 'symbols', 'callers', 'callees']) {
      if (Array.isArray(data[key])) return data[key].length === 0;
    }
  }
  const first = String(text || '').split('\n', 1)[0];
  return /\b(nothing|no results|no declaration|not found|no co-change|is empty|found no)\b/i.test(first);
}

// Drop the source spans explore embeds, keeping the declaration headers, callers and callees. A
// span opens with a "--- source file:a-b ---" line and runs until the next structural boundary: the
// next "■" focus item or the "other matches:" tail. It cannot end on indentation, because a
// top-level declaration's own source begins in column 0, so only these two markers close a span.
// The callers/callees lines print before the span, so removing it keeps the edges to navigate by.
const SOURCE_OPEN = /^\s*---\s*source\b/;
const SPAN_END = /^(■\s|other matches:)/;
function stripSource(text) {
  const out = [];
  let inSpan = false;
  for (const line of text.split('\n')) {
    if (inSpan) {
      if (!SPAN_END.test(line)) continue;
      inSpan = false;
    }
    if (SOURCE_OPEN.test(line)) { inSpan = true; continue; }
    out.push(line);
  }
  // Collapse the blank runs the removed spans leave behind so the result stays dense.
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Keep whole lines until the token budget is spent; never split a line, because a half-printed
// path:line is worse than a shorter answer. The trailing note exists so the reader knows the cut
// happened and can raise --budget, rather than reflexively re-running to "get the rest".
function trimToBudget(text, budgetTokens) {
  if (!budgetTokens) return text;
  const cap = budgetTokens * CHARS_PER_TOKEN;
  if (text.length <= cap) return text;
  // Stop at the first line that would overflow and drop the rest, rather than cherry-picking later
  // short lines past a dropped long one. The results are ranked, so a contiguous prefix keeps the
  // strongest hits whole instead of scattering an item's header from its edges.
  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const cost = lines[i].length + 1;
    if (used + cost > cap && kept.length) break;
    kept.push(lines[i]);
    used += cost;
  }
  const dropped = lines.length - i;
  if (dropped > 0) kept.push(`# +${dropped} lines trimmed to fit --budget ${budgetTokens} (raise it to see more)`);
  return kept.join('\n');
}

function runFor(name, spec) {
  return async function run(parsed, io) {
    const { out, err } = io;

    const quiet = require('./stderr-filter').install({
      summarised: [], detail: require('./stderr-filter').RETRIEVER_DETAIL, silenceMs: 0,
    });

    try {
      const { callTool } = require('../mcp/protocol');
      const deps = { cwd: process.cwd() };
      // The real freshness module touches git and both stores; opt in the same way mcp/start.js
      // does. --no-fresh leaves it undefined, which the handlers read as the no-op default.
      if (parsed.fresh) deps.freshness = require('../services/live-freshness');

      const call = callTool(spec.tool || name, parsed.toolArgs, deps);
      const result = parsed.timeout
        ? await Promise.race([call, new Promise((r) => setTimeout(() => r({ __timeout: true }), parsed.timeout))])
        : await call;

      if (result && result.__timeout) {
        err(`koragraph ${name}: timed out after ${parsed.timeout}ms\n`);
        return EXIT_TIMEOUT;
      }

      const text = result.content?.[0]?.text ?? '';
      const data = result.structuredContent ?? null;

      if (result.isError) {
        // A resolver near-miss is the useful case: reprint the candidates the way the other
        // commands do rather than a bare error line.
        if (data && Array.isArray(data.near_misses) && data.near_misses.length) {
          err(`koragraph ${name}: ${text}\n`);
          const nm = nearMisses(parsed.toolArgs[spec.arg] || '', data.near_misses);
          err(`Did you mean:\n${nm.map((n) => `  ${n.name}${n.file ? `  ${n.file}${n.line ? `:${n.line}` : ''}` : ''}`).join('\n')}\n`);
          return EXIT.NOT_FOUND;
        }
        err(`koragraph ${name}: ${text}\n`);
        // Map the tool's error to a meaningful exit code so a script or hook can branch on it: a
        // store problem to its own code, a bad tool argument to usage, and a resolver miss ("no
        // symbol named X") to NOT_FOUND — the same code search and blast already return for a miss,
        // so an unknown symbol is not reported as a hard failure.
        const code = (data && data.code) || '';
        if (code === 'no_graph') return EXIT.NO_GRAPH;
        if (code === 'store_busy') return EXIT.STORE_BUSY;
        if (code === 'store_unusable') return EXIT.STORE_UNUSABLE;
        if (code === 'invalid_params') return EXIT.USAGE;
        if (/\b(no symbol named|not found|no declaration|does not exist|no file)\b/i.test(text)) return EXIT.NOT_FOUND;
        return EXIT.FAILURE;
      }

      // --no-source only removes what explore emits; the other verbs carry no spans to strip.
      const shown = parsed.source === false ? stripSource(text) : text;

      if (parsed.format === 'json') {
        out(`${JSON.stringify(data, null, 2)}\n`);
      } else if (parsed.format === 'paths') {
        const paths = collectPaths(data);
        if (paths.length) out(`${paths.join('\n')}\n`);
      } else if (parsed.format === 'compact') {
        out(`${trimToBudget(shown, parsed.budget).replace(/\n*$/, '')}\n`);
      } else {
        out(shown.endsWith('\n') ? shown : `${shown}\n`);
      }

      return looksEmpty(data, text) ? EXIT.NOT_FOUND : EXIT.OK;
    } catch (raw) {
      if (raw && raw.near_misses) raw.near_misses = nearMisses(parsed.toolArgs[spec.arg] || '', raw.near_misses);
      throw raw;
    } finally {
      quiet.restore();
    }
  };
}

// Build one command module per spec, shaped exactly like the hand-written CLI commands
// (parse/run/USAGE/USES_STORE/OPTIONS) so src/cli/main.js registers them the same way.
function makeCommand(name) {
  const spec = SPECS[name];
  return {
    parse: parseFor(name, spec),
    run: runFor(name, spec),
    USAGE: usageFor(name, spec),
    USES_STORE: true,
    OPTIONS: COMMON_OPTIONS,
  };
}

const COMMAND_NAMES = Object.keys(SPECS);

// The output-policy helpers are exported so a hook can format an in-process or shelled result the
// same way the CLI does, rather than re-deriving budget/source/emptiness rules that must not drift.
module.exports = {
  makeCommand, COMMAND_NAMES, SPECS,
  trimToBudget, stripSource, looksEmpty, collectPaths,
};
