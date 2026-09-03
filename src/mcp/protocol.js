'use strict';

const { SERVER_INFO, SERVER_INSTRUCTIONS, listTools, getTool } = require('./tool-contracts');
const { validateArgs } = require('./validate');
const { HANDLERS } = require('./tool-handlers');

// Recovered from the deleted src/mcp/transport.js: the JSON-RPC error shape, the numeric codes,
// and the rule that a failure never escapes as a bare throw. What is NOT recovered is the HTTP
// StreamableHTTP session machinery, DNS-rebinding host allow-lists and CORS origins — all of
// which exist to defend a server reachable over a network. This one is a child process on the
// developer's own laptop speaking stdio to their editor; a session table of one would be
// ceremony, and an origin allow-list would defend nothing.

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

// The single most important error this product emits: a developer whose graph is not built yet
// must get the next command, not a connection stack trace.
//
// Deliberately NOT keyed off a SQLSTATE. The data layer is being ported from Postgres to
// better-sqlite3, which raises `SQLITE_ERROR` for essentially everything — a `code === '42P01'`
// catch would silently stop matching the day that lands, and the error would escape raw. So:
// recognise our own tool errors structurally first, then translate anything that smells like
// "the store is not there", across both drivers — and separate lock contention out first,
// because "busy" is not "absent" and the two need opposite advice.

// Errors this surface raises about the caller's request, not about the store. They are real
// answers and must never be laundered into "no graph".
const OWN_TOOL_ERROR_CODES = new Set([
  'symbol_not_found',
  'file_not_in_graph',
  'project_scope_required',
  'invalid_params',
  'unknown_tool',
]);

// The service layer's own structural signal for an empty graph: graph-tool-service.js throws this
// when no tracked branch exists, which is exactly the state of a fresh install. Matched on the
// message because that is what the service throws; it carries no code.
const NO_BRANCHES = /No tracked branches found/i;

// Lock contention, not a missing store — the graph is there, someone else is writing to it, which
// is the normal state while an ingest runs. Prefixes rather than an exact set because
// better-sqlite3 raises sqlite3_extended_errcode (src/objects/database.cpp:55), so
// SQLITE_BUSY_SNAPSHOT / SQLITE_BUSY_RECOVERY / SQLITE_LOCKED_SHAREDCACHE arrive verbatim
// alongside the primary codes. SQLITE_PROTOCOL is the WAL locking-protocol failure and is equally
// transient.
const STORE_BUSY_CODES = [/^SQLITE_BUSY/, /^SQLITE_LOCKED/, /^SQLITE_PROTOCOL$/];

// Driver-agnostic on purpose. Left column is pg, right is better-sqlite3; both are listed so the
// Postgres -> SQLite port cannot quietly break this path. Only codes that mean the store itself is
// absent belong here: a blanket /^SQLITE_/ also swallowed the busy codes above and told a
// developer whose graph was merely locked to go and rebuild it. SQLITE_ERROR is deliberately not
// listed — it covers every ordinary SQL fault as well as a missing table, so that case is matched
// on the message instead.
// Narrowing the blanket /^SQLITE_/ to CANTOPEN was right — telling someone with a corrupt store
// to run an ingest was never good advice — but it dropped six codes that all mean "your store
// exists and is unusable" into a bare driver string. They need their own answer, not either of
// the other two: nothing to retry and nothing an ingest fixes.
const STORE_UNUSABLE_CODES = [
  /^SQLITE_CORRUPT/, /^SQLITE_NOTADB/, /^SQLITE_READONLY/,
  /^SQLITE_PERM/, /^SQLITE_IOERR/, /^SQLITE_FULL/, /^SQLITE_AUTH/,
];

const STORE_UNAVAILABLE_CODES = [
  /^ECONNREFUSED$/, /^ENOTFOUND$/, /^ETIMEDOUT$/, /^EAI_AGAIN$/, /^ECONNRESET$/,
  /^SQLITE_CANTOPEN/,
];

const STORE_UNAVAILABLE_MESSAGES = [
  /does not exist/i,            // pg: database/relation/schema does not exist
  /no such table/i,             // sqlite
  /no such column/i,            // sqlite: schema drift from a half-applied migration
  /unable to open database/i,   // sqlite: the file is not there
  /connection terminated/i,
  /timeout expired/i,
  /authentication failed/i,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/,
];

const NO_GRAPH_MESSAGE = [
  'No code graph is indexed yet.',
  'The store applies its own schema the first time it is opened, so nothing needs migrating —',
  'what is missing is an ingest. Run `koragraph ingest <path-to-repo>` for at least one',
  'repository, then retry. `koragraph status` shows what is indexed.',
].join(' ');

const STORE_UNUSABLE_MESSAGE = [
  'The code graph store exists but cannot be used — it is corrupt, unreadable, read-only, or the disk is full.',
  'This is not a missing index and retrying will not help.',
  'Check the file named by $KORAGRAPH_DB (default ~/.koragraph/graph.db): fix its permissions or free disk space,',
  'or delete it and re-run an ingest to rebuild the graph from scratch.',
].join(' ');

const STORE_BUSY_MESSAGE = [
  'The code graph store is locked by another writer — almost always an ingest running right now.',
  'The graph is intact; nothing needs rebuilding. Retry this call in a few seconds.',
].join(' ');

function looksLikeStoreUnusable(err) {
  if (!err) return false;
  if (OWN_TOOL_ERROR_CODES.has(err.code)) return false;
  return STORE_UNUSABLE_CODES.some((re) => re.test(String(err.code || '')));
}

function looksLikeStoreBusy(err) {
  if (!err) return false;
  if (OWN_TOOL_ERROR_CODES.has(err.code)) return false;
  return STORE_BUSY_CODES.some((re) => re.test(String(err.code || '')));
}

function looksLikeMissingGraph(err) {
  if (!err) return false;
  if (OWN_TOOL_ERROR_CODES.has(err.code)) return false;
  if (looksLikeStoreBusy(err)) return false;
  if (looksLikeStoreUnusable(err)) return false;
  const message = String(err.message || '');
  if (NO_BRANCHES.test(message)) return true;
  const code = String(err.code || '');
  if (STORE_UNAVAILABLE_CODES.some((re) => re.test(code))) return true;
  return STORE_UNAVAILABLE_MESSAGES.some((re) => re.test(message));
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolError(message, code, extra) {
  const payload = { error: message, code: code || 'tool_error' };
  if (extra && Object.keys(extra).length) Object.assign(payload, extra);
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: payload,
    isError: true,
  };
}

function toolSuccess({ data, text }) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError: false,
  };
}

function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

async function callTool(name, rawArgs, deps = {}) {
  const contract = getTool(name);
  if (!contract) return toolError(`Unknown tool "${name}". Available: ${listTools().map((t) => t.name).join(', ')}`, 'unknown_tool');

  const handlers = deps.handlers || HANDLERS;
  const handler = handlers[name];
  if (!handler) return toolError(`Tool "${name}" has no handler`, 'not_implemented');

  let args;
  try {
    args = validateArgs(contract.inputSchema, rawArgs);
  } catch (err) {
    return toolError(err.message, 'invalid_params');
  }

  try {
    return toolSuccess(await handler(args, deps));
  } catch (err) {
    if (looksLikeStoreBusy(err)) return toolError(STORE_BUSY_MESSAGE, 'store_busy');
    if (looksLikeStoreUnusable(err)) return toolError(STORE_UNUSABLE_MESSAGE, 'store_unusable');
    if (looksLikeMissingGraph(err)) return toolError(NO_GRAPH_MESSAGE, 'no_graph');
    const extra = {};
    if (err.near_misses) extra.near_misses = err.near_misses;
    return toolError(err.message || 'Internal error', err.code || 'tool_error', extra);
  }
}

async function handleMessage(message, deps = {}) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return jsonRpcError(message?.id ?? null, RPC.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
  }

  const { id, method, params } = message;
  // A notification carries NO id member and must never be answered. An explicit `id: null` is a
  // request per JSON-RPC 2.0 (discouraged, but legal) and must be answered, or a client that sent
  // one hangs waiting for a reply that never comes.
  const isNotification = id === undefined;

  switch (method) {
    case 'initialize': {
      if (isNotification) return null;
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return isNotification ? null : jsonRpcResult(id, {});
    case 'tools/list':
      if (isNotification) return null;
      return jsonRpcResult(id, { tools: listTools() });
    case 'tools/call': {
      if (isNotification) return null;
      const name = params?.name;
      if (typeof name !== 'string' || !name) {
        return jsonRpcError(id, RPC.INVALID_PARAMS, '"name" is required');
      }
      return jsonRpcResult(id, await callTool(name, params?.arguments, deps));
    }
    default:
      if (isNotification) return null;
      return jsonRpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

module.exports = {
  handleMessage,
  callTool,
  jsonRpcResult,
  jsonRpcError,
  negotiateProtocol,
  looksLikeMissingGraph,
  looksLikeStoreBusy,
  looksLikeStoreUnusable,
  RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL_VERSION,
  NO_GRAPH_MESSAGE,
  STORE_BUSY_MESSAGE,
  STORE_UNUSABLE_MESSAGE,
};
