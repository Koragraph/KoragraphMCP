'use strict';

const { LOCAL_ORG_ID } = require('../config/local-org');

// Name -> node ids, by composing graph-tool-service.js#searchGraphForOrg and filtering its nodes
// by name. The pool searchGraphForOrg returns is built by RANKED retrieval, so a name that loses
// the contest for its own pool would come back as a false 404. The exact-name index lookup runs
// inside searchGraphForOrg, ahead of the ranked pool and merged in front of it, so the exact tier
// below is guaranteed its candidates. It lives there rather than here because search_code has the
// identical defect and both tools enter through that one function.

// Wider than any caller's `limit`, and now actually reached: searchGraphForOrg admits up to 100
// exact-name matches before the ranked pool, so an overloaded name arrives whole rather than
// clipped to the ranked top-k.
const CANDIDATE_POOL = 100;
const MAX_NEAR_MISSES = 8;

function resolverError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// "io/reader.go:readAsCSV" -> { name: 'readAsCSV', fileHint: 'io/reader.go' }. A bare
// "Session.get" keeps its dot; the final-component tier below handles that separately, because
// `.` is a member separator in every language here and `:` never is.
function parseSymbol(raw) {
  const s = String(raw).trim();
  const idx = s.lastIndexOf(':');
  if (idx > 0 && idx < s.length - 1) {
    return { name: s.slice(idx + 1).trim(), fileHint: s.slice(0, idx).trim() };
  }
  return { name: s, fileHint: null };
}

function finalComponent(name) {
  const parts = String(name).split(/::|->|\.|\//).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(name);
}

function pathMatches(nodePath, hint) {
  if (!hint) return true;
  const p = String(nodePath || '');
  const h = String(hint).replace(/^\.\//, '');
  if (!p) return false;
  return p === h || p.endsWith(`/${h}`) || p.split('/').pop() === h.split('/').pop();
}

function shapeNode(node) {
  return {
    node_id: node.id,
    name: node.name,
    type: node.node_type,
    file: node.file?.path ?? null,
    line: node.start_line ?? null,
    end_line: node.end_line ?? null,
  };
}

// IMPORT nodes carry the imported symbol's name but are not its definition. They are kept (an
// import site is a legitimate answer to "where is this") and ranked below real declarations
// rather than filtered out, so a symbol that only ever appears as an import still resolves.
function rankResolved(a, b) {
  const isImport = (n) => (n.type === 'IMPORT' ? 1 : 0);
  if (isImport(a) !== isImport(b)) return isImport(a) - isImport(b);
  const fa = String(a.file || '');
  const fb = String(b.file || '');
  if (fa !== fb) return fa.localeCompare(fb);
  return (a.line ?? 0) - (b.line ?? 0);
}

async function resolveSymbol({ symbol, file = null, projectId = null, branchIds = null }, deps = {}) {
  const searchGraph = deps.searchGraphForOrg
    || require('../services/graph-tool-service').searchGraphForOrg;

  const { name, fileHint } = parseSymbol(symbol);
  if (!name) throw resolverError(400, 'invalid_params', '"symbol" is required');
  const hint = file || fileHint;

  const searchArgs = { query: name, limit: CANDIDATE_POOL };
  if (projectId != null) searchArgs.project_id = projectId;
  if (branchIds != null) searchArgs.branch_ids = branchIds;
  const result = await searchGraph(LOCAL_ORG_ID, searchArgs);
  const candidates = result?.nodes || [];

  const wanted = name.toLowerCase();
  const wantedFinal = finalComponent(name).toLowerCase();

  const tiers = [
    (n) => String(n.name || '').toLowerCase() === wanted,
    (n) => finalComponent(n.name || '').toLowerCase() === wantedFinal,
    (n) => String(n.name || '').toLowerCase().includes(wanted),
  ];

  let matched = [];
  for (const predicate of tiers) {
    const hits = candidates.filter((n) => predicate(n) && pathMatches(n.file?.path, hint));
    if (hits.length) { matched = hits; break; }
  }

  if (!matched.length) {
    // Never an empty success. A silent empty answer is a failed query wearing a success's
    // clothes, and the caller cannot tell "no such symbol" from "no such relation".
    const nearMisses = candidates
      .slice(0, MAX_NEAR_MISSES)
      .map((n) => ({ name: n.name, file: n.file?.path ?? null, line: n.start_line ?? null }));
    throw resolverError(404, 'symbol_not_found',
      hint
        ? `No symbol named "${name}" found in "${hint}".`
        : `No symbol named "${name}" found in the graph.`,
      { near_misses: nearMisses });
  }

  const resolved = matched.map(shapeNode).sort(rankResolved);
  return {
    resolved,
    // An overloaded or repeated name is genuinely several declarations. Picking one is a coin
    // flip, so every match is returned and the caller is told.
    ambiguous: resolved.length > 1,
    query_name: name,
    file_hint: hint,
  };
}

module.exports = { resolveSymbol, parseSymbol, finalComponent, pathMatches, resolverError };
