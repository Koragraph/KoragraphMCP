'use strict';

const { LOCAL_ORG_ID } = require('../config/local-org');
const { TASK_TYPES } = require('../services/retrieval-policy');
const { EDGE_RENDER_WEIGHT } = require('../services/subgraph-builder');
const { resolveSymbol, resolverError } = require('./symbol-resolver');
const render = require('./render');

// Symbol-grain annotation: explore, neighbours, changes_with, and blast_radius's own callers each
// have a per-node line to attach one to. search_code groups nodes one line per file and has no
// per-node structure to annotate at all. file_symbols is DIFFERENT, not absent: it has no per-node
// line either, but it (and blast_radius's changed files) still get a FILE-grain annotation via the
// separate fileAnnotationFor/renderFileAnnotationLine path below — see that function's own comment.
//
// Reads practice.db only, read-only, and returns null on anything unexpected — an annotation is a
// bonus on a retrieval response and must never be able to turn one into an error.
//
// The lookup goes through practice/recall.js rather than practice/annotate.js because recall.js
// can scope by repo_id and annotate.js cannot — without it, two repositories sharing a
// repo-relative path AND a symbol name would swap facts. A rendered response carries no
// repository, so the identity comes from the server's own working directory (below), which is the
// repository the developer's session is in.
function annotationFor(candidates, deps) {
  const lookup = deps.lookupAnnotation
    || ((c, opts) => require('../practice/recall').annotationFrom(null, c, opts));
  try {
    return lookup(candidates, { repoId: deps.repoId !== undefined ? deps.repoId : serverRepoId() }) || null;
  } catch (_) {
    return null;
  }
}

// Grain-widening companion: a file-grain fact/note about a file the tool call is directly
// ABOUT (file_symbols, blast_radius's changed files) — never per-symbol.
function fileAnnotationFor(filePaths, deps) {
  const lookup = deps.lookupFileAnnotation
    || ((paths, opts) => require('../practice/recall').fileAnnotationFrom(null, paths, opts));
  try {
    return lookup(filePaths, { repoId: deps.repoId !== undefined ? deps.repoId : serverRepoId() }) || null;
  } catch (_) {
    return null;
  }
}

let repoIdCache;

// Resolved once per server process. KORAGRAPH_REPO_ID exists because an MCP server can be launched
// from anywhere; an empty string means "deliberately unscoped" and restores the old behaviour.
function serverRepoId() {
  if (repoIdCache !== undefined) return repoIdCache;
  if (process.env.KORAGRAPH_REPO_ID !== undefined) {
    repoIdCache = process.env.KORAGRAPH_REPO_ID || null;
    return repoIdCache;
  }
  try {
    repoIdCache = require('../practice/repo-identity').repoIdentity(process.cwd()).repoId;
  } catch {
    repoIdCache = null;
  }
  return repoIdCache;
}

function resetRepoId() { repoIdCache = undefined; }

function detailOf(args) {
  return args.detail === 'full' ? 'full' : 'concise';
}

// Commentary ABOUT the code, not declarations in it. A DOC node's `purpose` is the docstring
// itself, so shipping them is pasting the file back at a reader who can open it — the one thing
// this surface says it does not do.
//
// Measured on express lib/application.js: 46 symbols, of which 22 were DOC, and one concise
// file_symbols call cost ~3,070 tokens. Dropping them costs nothing a reader wanted and is the
// difference between a tool an agent can afford to call and one it cannot. `full` still returns
// everything, which is what `full` is for.
const COMMENTARY_TYPES = Object.freeze(['DOC', 'DOC_REF', 'RATIONALE']);

// The one-line descriptor a concise result carries per symbol. It is the node's summary (a
// signature for a METHOD, a short line for anything else), surfaced under `purpose` for a stable
// tool contract; bounded rather than dropped so a DOC node's whole block cannot paste back in.
const DESCRIPTOR_MAX = 120;
// Concise search returns the ranked head, not every match. The billed structuredContent carried all
// 30 by default — half of it low-ranked rows in tests/fixtures/plan docs — so the head is what the
// caller pays for; `detail:"full"` still returns the whole list.
const SEARCH_CONCISE_CAP = 12;

function conciseSymbol(n) {
  const e = { name: n.name, type: n.type, line: n.line };
  if (n.purpose) {
    e.purpose = n.purpose.length > DESCRIPTOR_MAX ? `${n.purpose.slice(0, DESCRIPTOR_MAX - 1)}…` : n.purpose;
  }
  return e;
}

function withoutCommentary(nodes) {
  const kept = nodes.filter((n) => !COMMENTARY_TYPES.includes(n.type));
  // Never return nothing because everything was commentary — a file that is all documentation
  // still has to answer "what is in here".
  return kept.length ? kept : nodes;
}

// Groups the structured payload one line per file, the same way the text renderer does, instead of
// repeating the whole path on every node. `node_id` and `end_line` are dropped too: no tool on
// this surface takes a node id as an argument, so shipping them is paying to carry a key nothing
// can turn.
function compactNodes(nodes) {
  const byFile = new Map();
  for (const n of nodes) {
    const key = n.file || '';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(conciseSymbol(n));
  }
  return [...byFile].map(([file, symbols]) => ({ file, symbols }));
}

function compactRelation(r) {
  const out = { name: r.name, type: r.type, file: r.file, line: r.line, edge_type: r.edge_type };
  if (r.call_line != null) out.call_line = r.call_line;
  if (r.confidence_tier && r.confidence_tier !== 'EXTRACTED') out.confidence_tier = r.confidence_tier;
  if (r.cross_repo) out.cross_repo = true;
  // Kept even in concise: "this call provably runs" is the strongest thing the tool can say.
  if (r.runtime_observed) out.runtime_observed = true;
  return out;
}

// The declaration-grain co-change plane (cochange-miner.js). NOT `COUPLED_WITH`: that name is
// carried by three unrelated things — a structural same-file type reference from the Go/Rust/ObjC
// extractors, a file-grain statistical edge from git-coupling-analyzer.js, and the weight entry in
// subgraph-builder.js. Only `CO_CHANGES` is the measured declaration-grain plane, so only it is
// gated behind include_cochange and only it is what changes_with serves.
const COCHANGE_EDGE_TYPE = 'CO_CHANGES';

// CO_CHANGES has no EDGE_RENDER_WEIGHT entry, so the shared table's `?? 1.0` fallback would rank a
// statistical co-occurrence above a resolved CALLS edge. Pinned here to COUPLED_WITH's weight,
// which the table sets to 0.25 for precisely this reason. Not a second weight table: the shared
// one still decides every other type, and it is not edited because the serializer's output is a
// pinned, byte-for-byte contract.
const COCHANGE_RENDER_WEIGHT = 0.25;

const TIER_RANK = Object.freeze({ EXTRACTED: 0, INFERRED: 1, AMBIGUOUS: 2 });

// Each hop fans out multiplicatively. Capping the frontier PER HOP bounds the walk; `limit` bounds
// the answer, and a cap on the answer alone would run an unbounded walk and throw the result away —
// the same defect blast-radius.js documents in its own DEFAULT_FRONTIER_CAP.
const HOP_FRONTIER_CAP = 20;

function services(deps) {
  const gts = deps.graphToolService || require('../services/graph-tool-service');
  return {
    searchGraphForOrg: deps.searchGraphForOrg || gts.searchGraphForOrg,
    getCallersForOrg: deps.getCallersForOrg || gts.getCallersForOrg,
    getCalleesForOrg: deps.getCalleesForOrg || gts.getCalleesForOrg,
    getFileNodesForOrg: deps.getFileNodesForOrg || gts.getFileNodesForOrg,
    soleProjectIdForOrg: deps.soleProjectIdForOrg || gts.soleProjectIdForOrg,
    projectIdByName: deps.projectIdByName || gts.projectIdByName,
    branchIdsByRepoName: deps.branchIdsByRepoName || gts.branchIdsByRepoName,
    computeBlastRadius: deps.computeBlastRadius || require('../services/blast-radius').computeBlastRadius,
  };
}

// Unlike `services(deps)` above, this does NOT default to the real implementation. The real one
// touches the filesystem, git, and both databases — every existing test on this surface builds
// its own `deps` for the read services above but has no reason to know this exists, and a
// default-to-real here would make hundreds of unit tests against synthetic fixtures start
// resolving repo identity and probing graph.db for real. Opt-in only: the actual server
// (mcp/start.js) wires the real module in; everything else — every test, every handler called
// without it — gets a no-op, which is exactly today's behavior before this existed.
const NOOP_FRESHNESS = Object.freeze({
  ensureFileFresh: async () => {},
  ensureFilesFresh: async () => {},
  ensureRepoFresh: async () => {},
});
function freshnessOf(deps) {
  return deps.freshness || NOOP_FRESHNESS;
}

// project_id arrives as an integer id (validated) or a name string from overview. A REPOSITORY name
// resolves to that repo's branch set — true per-repo scope, narrower than the project. A PROJECT
// (workspace) name or a numeric id resolves to project scope. Returns { projectId, branchIds };
// exactly one is set (or neither, for an absent scope).
async function resolveProjectScope(value, svc) {
  if (value == null) return { projectId: null, branchIds: null };
  if (typeof value === 'number') return { projectId: value, branchIds: null };
  const branchIds = svc.branchIdsByRepoName ? await svc.branchIdsByRepoName(LOCAL_ORG_ID, value) : [];
  if (branchIds && branchIds.length) return { projectId: null, branchIds };
  const projectId = await svc.projectIdByName(LOCAL_ORG_ID, value);
  if (projectId != null) return { projectId, branchIds: null };
  throw resolverError(400, 'project_not_found',
    `No project or repository named "${value}". Run overview to see the names in this store.`);
}

function shapeSearchNode(n) {
  return {
    node_id: n.id,
    name: n.name,
    type: n.node_type,
    file: n.file?.path ?? null,
    line: n.start_line ?? null,
    end_line: n.end_line ?? null,
    purpose: n.summary || null,
  };
}

// getCallers/getCallees return { nodes, edges } where `nodes` includes the target itself. Fold
// them into one flat relation per edge, carrying call_line / resolution_tier / confidence_tier /
// cross_repo — the fields graph-tool-service.js was fixed to surface, and which a consumer needs
// to tell a resolved relation from an inferred one.
function foldRelations(result, targetId, direction) {
  const byId = new Map((result.nodes || []).map((n) => [n.id, n]));
  const out = [];
  for (const e of result.edges || []) {
    const otherId = direction === 'in' ? e.from_node_id : e.to_node_id;
    if (otherId === targetId) continue;
    const node = byId.get(otherId);
    if (!node) continue;
    out.push({
      node_id: otherId,
      name: node.name,
      type: node.node_type,
      file: node.file?.path ?? null,
      line: node.start_line ?? null,
      edge_type: e.edge_type,
      direction,
      call_line: e.call_line ?? null,
      resolution_tier: e.resolution_tier ?? null,
      confidence: e.confidence ?? null,
      confidence_tier: e.confidence_tier ?? null,
      cross_repo: Boolean(e.is_cross_repo),
      // Present only when `koragraph trace` saw this call execute — a fact, not a resolution guess.
      ...(e.runtime_observed ? { runtime_observed: true } : {}),
      from_node_id: targetId,
    });
  }
  return out;
}

function weightOf(edgeType) {
  if (edgeType === COCHANGE_EDGE_TYPE) return COCHANGE_RENDER_WEIGHT;
  return EDGE_RENDER_WEIGHT[edgeType] ?? 1.0;
}

function sameDir(a, b) {
  const da = String(a || '').split('/').slice(0, -1).join('/');
  const db = String(b || '').split('/').slice(0, -1).join('/');
  return da && da === db;
}

function rankRelations(rels, anchorFile) {
  return [...rels].sort((a, b) => {
    const ta = TIER_RANK[a.confidence_tier] ?? 1;
    const tb = TIER_RANK[b.confidence_tier] ?? 1;
    if (ta !== tb) return ta - tb;
    const wa = weightOf(a.edge_type);
    const wb = weightOf(b.edge_type);
    if (wa !== wb) return wb - wa;
    const la = a.file === anchorFile ? 0 : (sameDir(a.file, anchorFile) ? 1 : 2);
    const lb = b.file === anchorFile ? 0 : (sameDir(b.file, anchorFile) ? 1 : 2);
    if (la !== lb) return la - lb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function dedupe(rels) {
  const seen = new Set();
  const out = [];
  for (const r of rels) {
    const key = `${r.direction}|${r.from_node_id}|${r.node_id}|${r.edge_type}|${r.call_line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function incidentSet(svc, nodeId, { direction, edgeTypes, includeHeuristic }) {
  const args = { node_id: nodeId, include_heuristic: includeHeuristic };
  if (edgeTypes && edgeTypes.length) args.edge_types = edgeTypes;
  const jobs = [];
  if (direction === 'in' || direction === 'both') {
    jobs.push(svc.getCallersForOrg(LOCAL_ORG_ID, args).then((r) => foldRelations(r, nodeId, 'in')));
  }
  if (direction === 'out' || direction === 'both') {
    jobs.push(svc.getCalleesForOrg(LOCAL_ORG_ID, args).then((r) => foldRelations(r, nodeId, 'out')));
  }
  const parts = await Promise.all(jobs);
  return parts.flat();
}

// A client may render `structuredContent` and NOT the text block — Claude Code does. Asked to quote
// overview's first line verbatim, a real session answered: "The response has no free-text first
// line, but as verbatim first field: `\"detail\":\"concise\"`". So the highest-attention position in
// the payload every agent actually reads was an echo of the request parameter, and the sentence
// carrying the answer was not in that object at all.
//
// One leading `summary` line, not the whole text: structuredContent is already ~74% of the payload
// and duplicating the body would be the wrong trade. The headline is the part a reader needs first
// and the part that is cheapest to carry.
function structuredResult(data, text) {
  const summary = String(text || '').split('\n', 1)[0].trim();
  return { data: summary ? { summary, ...data } : data, text };
}

// search_code never says "not found": graph expansion always fills the page, so a query for a
// symbol that does not exist came back as a confident list of its neighbours. That is the same
// defect as neighbours' false 404 seen from the other side — the tool reports success having found
// nothing — and it is harder to spot, because near-misses from the right file look like an answer.
// Only fires on an identifier-shaped query with no name matching it even as a substring, so a
// deliberate partial search ("Walk") and any prose query are left alone. The comparison is on the
// name FIELD, never a substring of the serialised response: `buildGenericAstNodes` in the same
// file would otherwise read as a match for `buildAstNodes`. Deliberately not imported from
// graph-tool-service.js, which carries the same shape test: `recall` is the one tool on this
// surface that must never open graph.db, and a top-level require of the service layer would load
// the pool for it.
const IDENTIFIER_QUERY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Attached to every tool answer that carries line numbers or asserts a declaration's absence.
// Both are claims about a SNAPSHOT and neither said so: on an express store one commit behind
// HEAD, search_code for a function added by that commit answered "NO DECLARATION NAMED ... EXISTS
// IN THE GRAPH" -- true of the snapshot, false of the repository, and an agent acts on it.
//
// Soft-required and swallowed: a staleness probe that can fail a tool call is worse than one that
// says nothing.
async function stalenessOf(deps = {}) {
  if (deps.staleness !== undefined) return deps.staleness;
  try {
    const { graphStaleness } = require('../services/graph-staleness');
    return await graphStaleness({ pool: deps.pool });
  } catch {
    return null;
  }
}

function stalenessLine(state) {
  try {
    return require('../services/graph-staleness').stalenessNote(state);
  } catch {
    return null;
  }
}

function nameMissNote(query, nodes) {
  const q = String(query || '').trim();
  if (!IDENTIFIER_QUERY.test(q) || !nodes.length) return '';
  const lower = q.toLowerCase();
  if (nodes.some((n) => String(n.name || '').toLowerCase().includes(lower))) return '';
  return ` — NO DECLARATION NAMED "${q}" EXISTS IN THE GRAPH. The rows below are related code, not "${q}"; do not read any of them as that symbol.`;
}

async function searchCode(args, deps = {}) {
  const svc = services(deps);
  // No single file this query is about — repo-wide dirty check (git status), same as --watch
  // uses, scoped to whatever it finds. See live-freshness.js's own header for the full design.
  await freshnessOf(deps).ensureRepoFresh({ cwd: deps.cwd });
  const detail = detailOf(args);
  const searchArgs = { query: args.query, limit: args.limit ?? 30 };
  const searchScope = await resolveProjectScope(args.project_id, svc);
  if (searchScope.projectId != null) searchArgs.project_id = searchScope.projectId;
  if (searchScope.branchIds != null) searchArgs.branch_ids = searchScope.branchIds;
  const result = await svc.searchGraphForOrg(LOCAL_ORG_ID, searchArgs);
  const nodes = (result.nodes || []).map(shapeSearchNode);
  const files = new Set(nodes.map((n) => n.file));
  // The text is NOT capped in concise mode. renderSymbols already costs ~49 chars per node against
  // ~90 for a per-node line, so the grouped rows are the cheap part of this response and dropping
  // them would trade real routing information for very little. What concise cuts is the structured
  // duplicate, which was 4.0x the text.
  // A channel that timed out makes this answer known-partial, and `0 match(es)` is then a WRONG
  // answer, not a small one — measured: a forced lexical timeout took `normaliseErrorText` from 30
  // results to 0 with a header indistinguishable from "no such symbol". It goes in the TEXT, not
  // only in the structured meta, because the structured half is the half a reader skips.
  const degraded = (result.meta && result.meta.degraded_channels) || null;
  const partial = degraded ? ` — PARTIAL: the ${degraded.map((d) => d.channel).join(', ')} channel(s) did not answer, so this is an incomplete result, not an empty one` : '';
  const miss = nameMissNote(args.query, nodes);
  // The staleness line goes in the TEXT, and it goes NEXT TO the miss, for the same reason the
  // partial-channel line does: "this symbol does not exist" and "the graph is behind your
  // checkout" are the same sentence to a reader, and only together are they true.
  const stale = miss ? stalenessLine(await stalenessOf(deps)) : null;
  const staleNote = stale ? ` — ${stale}` : '';
  const header = (detail === 'full'
    ? `${nodes.length} match(es) for "${args.query}"`
    : `${nodes.length} match(es) for "${args.query}" across ${files.size} file(s)`) + partial + miss + staleNote;
  const data = detail === 'full'
    ? {
      results: nodes,
      meta: {
        ...(result.meta || {}),
        ...(miss ? { exact_match: false } : {}),
        ...(stale ? { graph_stale: true } : {}),
      },
    }
    : {
      results: compactNodes(nodes.slice(0, SEARCH_CONCISE_CAP)),
      meta: {
        count: nodes.length,
        files: files.size,
        ...(nodes.length > SEARCH_CONCISE_CAP ? { shown: SEARCH_CONCISE_CAP } : {}),
        ...(miss ? { exact_match: false } : {}),
        ...(stale ? { graph_stale: true } : {}),
        ...(degraded ? { degraded_channels: degraded } : {}),
      },
    };
  return structuredResult(data, render.renderSymbols(nodes, header));
}

async function neighbours(args, deps = {}) {
  const svc = services(deps);
  // `args.file` disambiguates a symbol the caller already knows the location of — the cheap
  // single-file check. Without it there is nothing to scope to yet, so fall back to the repo-wide
  // dirty check rather than skip freshening entirely.
  const fresh = freshnessOf(deps);
  if (args.file) await fresh.ensureFileFresh({ cwd: deps.cwd, file: args.file });
  else await fresh.ensureRepoFresh({ cwd: deps.cwd });
  const projectScope = await resolveProjectScope(args.project_id, svc);
  const t0 = Date.now();
  const direction = args.direction || 'both';
  const detail = detailOf(args);
  const limit = args.limit ?? 60;
  const depth = args.depth ?? 1;
  const includeCochange = args.include_cochange === true;

  // `symbol_not_found` is an absence claim about a SNAPSHOT, and the resolver THROWS it, so the
  // note has to be attached here rather than on a payload the handler never reaches. Measured on
  // an express store one commit behind HEAD: a function added by that commit came back as
  // "No symbol named ... found in the graph" with nothing to say the graph was behind.
  let resolution;
  try {
    resolution = await resolveSymbol(
      { symbol: args.symbol, file: args.file ?? null, projectId: projectScope.projectId, branchIds: projectScope.branchIds },
      { searchGraphForOrg: svc.searchGraphForOrg },
    );
  } catch (err) {
    if (err && err.code === 'symbol_not_found') {
      const note = stalenessLine(await stalenessOf(deps));
      if (note) err.message = `${err.message} ${note}`;
    }
    throw err;
  }

  const opts = {
    direction,
    edgeTypes: args.edge_types || null,
    includeHeuristic: args.include_heuristic === true,
  };

  let rels = [];
  for (const node of resolution.resolved) {
    rels.push(...await incidentSet(svc, node.node_id, opts));
  }
  // The service layer filters heuristics but not co-change, so a statistical relation would
  // otherwise arrive inside a CALLS-shaped answer. An explicit edge_types allow-list naming
  // CO_CHANGES is treated as consent.
  const explicitlyAsked = (args.edge_types || []).includes(COCHANGE_EDGE_TYPE);
  if (!includeCochange && !explicitlyAsked) {
    rels = rels.filter((r) => r.edge_type !== COCHANGE_EDGE_TYPE);
  }

  if (depth > 1) {
    // A trace-style task ("walk the call chain") was measured hand-chaining `neighbours` once per
    // hop — 12 calls for a 14-function chain — because depth topped out at 2. Walking `depth - 1`
    // further hops here turns that into one call. `visited` spans every hop, not just the anchor:
    // real call graphs have cycles (recursion, event loops), and without it a later hop could
    // re-expand a node an earlier hop already covered.
    const anchorFile = resolution.resolved[0]?.file ?? null;
    const visited = new Set(resolution.resolved.map((n) => n.node_id));
    let frontierPool = rels;
    for (let hop = 2; hop <= depth; hop += 1) {
      const frontier = rankRelations(dedupe(frontierPool), anchorFile)
        .filter((r) => !visited.has(r.node_id))
        .slice(0, HOP_FRONTIER_CAP);
      if (!frontier.length) break;
      const hopRels = [];
      for (const r of frontier) {
        visited.add(r.node_id);
        const next = await incidentSet(svc, r.node_id, opts);
        for (const h of next) hopRels.push({ ...h, depth: hop });
      }
      const filtered = hopRels.filter((r) => includeCochange || r.edge_type !== COCHANGE_EDGE_TYPE);
      rels.push(...filtered);
      frontierPool = filtered; // next hop expands from what THIS hop found, not the whole pool again
    }
  }

  const anchorFile = resolution.resolved[0]?.file ?? null;
  const ranked = rankRelations(dedupe(rels), anchorFile);
  const atLimit = ranked.slice(0, limit);
  const kept = detail === 'concise' ? atLimit.slice(0, render.CONCISE_ROWS) : atLimit;

  const payload = {
    resolved: resolution.resolved,
    ambiguous: resolution.ambiguous,
    // Candidate order is render order, so the one annotation lands on the most prominent line.
    annotation: annotationFor([...resolution.resolved, ...kept], deps),
    detail,
    concise_dropped: atLimit.length - kept.length,
    neighbours: {
      in: kept.filter((r) => r.direction === 'in'),
      out: kept.filter((r) => r.direction === 'out'),
    },
    truncated: ranked.length > atLimit.length,
    limit,
    meta: {
      node_count: resolution.resolved.length,
      edge_count: kept.length,
      edge_count_before_truncation: ranked.length,
      depth,
      latency_ms: Date.now() - t0,
    },
  };
  const text = render.renderNeighbours(payload);
  if (detail === 'full') return structuredResult(payload, text);
  return structuredResult({
    resolved: compactNodes(payload.resolved),
    ambiguous: payload.ambiguous,
    annotation: payload.annotation,
    detail,
    neighbours: {
      in: payload.neighbours.in.map(compactRelation),
      out: payload.neighbours.out.map(compactRelation),
    },
    shown: kept.length,
    total: ranked.length,
  }, text);
}

async function changesWith(args, deps = {}) {
  const svc = services(deps);
  const projectScope = await resolveProjectScope(args.project_id, svc);
  const t0 = Date.now();
  const detail = detailOf(args);
  const limit = args.limit ?? 25;

  // `symbol_not_found` is an absence claim about a SNAPSHOT, and the resolver THROWS it, so the
  // note has to be attached here rather than on a payload the handler never reaches. Measured on
  // an express store one commit behind HEAD: a function added by that commit came back as
  // "No symbol named ... found in the graph" with nothing to say the graph was behind.
  let resolution;
  try {
    resolution = await resolveSymbol(
      { symbol: args.symbol, file: args.file ?? null, projectId: projectScope.projectId, branchIds: projectScope.branchIds },
      { searchGraphForOrg: svc.searchGraphForOrg },
    );
  } catch (err) {
    if (err && err.code === 'symbol_not_found') {
      const note = stalenessLine(await stalenessOf(deps));
      if (note) err.message = `${err.message} ${note}`;
    }
    throw err;
  }

  let rels = [];
  for (const node of resolution.resolved) {
    rels.push(...await incidentSet(svc, node.node_id, {
      direction: 'both',
      edgeTypes: [COCHANGE_EDGE_TYPE],
      includeHeuristic: false,
    }));
  }

  // The miner emits each pair in both directions, so an undirected coupling arrives twice.
  const byNode = new Map();
  for (const r of rels) {
    const prev = byNode.get(r.node_id);
    if (!prev || (r.confidence ?? 0) > (prev.confidence ?? 0)) byNode.set(r.node_id, r);
  }

  const coupled = [...byNode.values()]
    .filter((r) => !resolution.resolved.some((n) => n.node_id === r.node_id))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || String(a.name).localeCompare(String(b.name)));

  const atLimit = coupled.slice(0, limit);
  const kept = (detail === 'concise' ? atLimit.slice(0, render.CONCISE_ROWS) : atLimit).map((r) => ({
    node_id: r.node_id,
    name: r.name,
    type: r.type,
    file: r.file,
    line: r.line,
    // The miner stores cochange_count / decayed_support / source_commits in edge properties, but
    // graph-tool-service.js lifts only call_line off properties. `confidence` is the miner's own
    // support ratio (shared commits / source commits) and is the strongest signal reachable
    // without a new query. See the track report.
    support: r.confidence,
    confidence_tier: r.confidence_tier,
  }));

  const payload = {
    resolved: resolution.resolved,
    ambiguous: resolution.ambiguous,
    annotation: annotationFor([...resolution.resolved, ...kept], deps),
    detail,
    concise_dropped: atLimit.length - kept.length,
    coupled: kept,
    truncated: coupled.length > atLimit.length,
    limit,
    caveat: 'CO_CHANGES is statistical git coupling, not a call relationship. Measured gain was concentrated in one of four benchmark repositories and flat in the other three.',
    meta: { coupled_count: coupled.length, latency_ms: Date.now() - t0 },
  };
  const text = render.renderCoChange(payload);
  if (detail === 'full') return structuredResult(payload, text);
  return structuredResult({
    resolved: compactNodes(payload.resolved),
    annotation: payload.annotation,
    detail,
    coupled: kept.map((c) => ({ name: c.name, type: c.type, file: c.file, line: c.line, support: c.support })),
    shown: kept.length,
    total: coupled.length,
    // The caveat is not dropped in concise mode. It is the only thing standing between a
    // statistical co-occurrence and an agent reading it as a call.
    caveat: payload.caveat,
  }, text);
}

// A single-project store — the ICP configuration, and what a developer has the day they install —
// had no way to answer this: blast_radius refused every call, and the server instructions tell an
// agent to run it before editing. One project is not an ambiguity. Two or more still is, and the
// refusal is kept for that case, because guessing between them would silently answer about the
// wrong repository.
async function resolveProjectId(args, svc) {
  if (args.project_id != null) {
    if (typeof args.project_id === 'number') return args.project_id;
    const id = await svc.projectIdByName(LOCAL_ORG_ID, args.project_id);
    if (id == null) {
      throw resolverError(400, 'project_not_found',
        `No project or repository named "${args.project_id}". Run overview to see the names in this store.`);
    }
    return id;
  }
  const fromEnv = parseInt(process.env.KORAGRAPH_PROJECT_ID || '', 10);
  if (Number.isFinite(fromEnv)) return fromEnv;
  const sole = await svc.soleProjectIdForOrg(LOCAL_ORG_ID);
  if (sole != null) return sole;
  throw resolverError(400, 'project_scope_required',
    'blast_radius needs a project scope: this store holds no project, or more than one, so there is nothing unambiguous to pick. Pass project_id, or set KORAGRAPH_PROJECT_ID in the environment the server runs in.');
}

// retrieval-policy.js THROWS on a string it does not recognise, deliberately — a silently
// defaulted task type would hide a caller bug behind an answer that looks fine. So nothing
// unrecognised is allowed to reach it from here. The tool schema's enum already constrains the MCP
// path; this guards the direct-call path and any classifier result.
function normaliseTaskType(value) {
  if (value == null || value === '' || value === 'unknown') return null;
  return TASK_TYPES.includes(value) ? value : null;
}

async function blastRadius(args, deps = {}) {
  const svc = services(deps);
  // blast_radius names the exact files it is about — check and, if needed, catch up all of them
  // in ONE ingest call rather than one per file (see ensureFilesFresh's own comment).
  await freshnessOf(deps).ensureFilesFresh({ cwd: deps.cwd, files: args.files_changed });
  const t0 = Date.now();
  const projectId = await resolveProjectId(args, svc);
  const detail = detailOf(args);
  const limit = args.limit ?? 25;
  const taskType = normaliseTaskType(args.task_type);

  const request = {
    orgId: LOCAL_ORG_ID,
    projectId,
    filesChanged: args.files_changed,
    breadthCap: limit,
  };
  // `maxDepth` only when the CLIENT asked for one. blast-radius.js lets an explicit maxDepth win
  // over the policy, so passing it unconditionally made policyFor('bugfix').depth === 1 and
  // policyFor('refactor').depth === 3 unreachable through this path.
  if (args.depth != null) request.maxDepth = args.depth;
  if (taskType) request.taskType = taskType;

  const surface = await svc.computeBlastRadius(request);

  const payload = {
    changed_files: surface.changed_files,
    changed_node_count: surface.changed_node_count,
    graph_coverage: surface.graph_coverage,
    callers_found: surface.callers_found,
    callers_targeted: surface.callers_targeted,
    callers_dropped: surface.callers_dropped,
    drop_reason: surface.drop_reason,
    max_depth: surface.max_depth,
    depth_reached: surface.depth_reached,
    callers: (surface.callers || []).map((c) => ({
      node_id: c.node_id,
      name: c.name,
      type: c.node_type,
      file: c.file_path,
      line: c.start_line,
      edge_type: c.edge_type,
      depth: c.depth,
      // blast-radius.js names this has_test_coverage but computes "this caller is itself a test
      // file". Renamed on the way out rather than misreported.
      is_test: c.has_test_coverage,
      // This dependent provably reaches the changed code — `koragraph trace` saw the call execute.
      ...(c.runtime_observed ? { runtime_observed: true } : {}),
      // 'cochange' when the row arrived on a CO_CHANGES edge: a statistical co-occurrence with no
      // structural claim. It is carried in BOTH modes because dropping it in concise would leave a
      // co-occurrence indistinguishable from a caller, which is the one error this tool's contract
      // explicitly warns about.
      relation: c.relation || (c.edge_type === 'CO_CHANGES' ? 'cochange' : 'caller'),
    })),
    detail,
    task_type: taskType,
    meta: { latency_ms: Date.now() - t0, project_id: projectId },
  };
  const allCallers = payload.callers;
  if (detail === 'concise') payload.callers = allCallers.slice(0, render.CONCISE_ROWS);
  payload.concise_dropped = allCallers.length - payload.callers.length;
  // A caller's own symbol-grain fact/note wins when there is one; otherwise fall back to a
  // file-grain item about one of the CHANGED files themselves — blast_radius is the one tool whose
  // whole subject is "these files", so that is a real hit, not a stretch.
  payload.annotation = annotationFor(payload.callers, deps) || fileAnnotationFor(payload.changed_files, deps);
  const text = render.renderBlastRadius(payload);
  if (detail === 'full') return structuredResult(payload, text);
  return structuredResult({
    changed_files: payload.changed_files,
    changed_node_count: payload.changed_node_count,
    graph_coverage: payload.graph_coverage,
    callers_found: payload.callers_found,
    callers_dropped: payload.callers_dropped,
    drop_reason: payload.drop_reason,
    depth_reached: payload.depth_reached,
    annotation: payload.annotation,
    detail,
    task_type: taskType,
    callers: payload.callers.map((c) => ({
      name: c.name, type: c.type, file: c.file, line: c.line, edge_type: c.edge_type,
      depth: c.depth, is_test: c.is_test, relation: c.relation,
      ...(c.runtime_observed ? { runtime_observed: true } : {}),
    })),
    shown: payload.callers.length,
  }, text);
}

async function fileSymbols(args, deps = {}) {
  const svc = services(deps);
  await freshnessOf(deps).ensureFileFresh({ cwd: deps.cwd, file: args.path });
  const detail = detailOf(args);
  const serviceArgs = { path: args.path, limit: args.limit ?? 100 };
  if (args.node_types) serviceArgs.node_types = args.node_types;
  const result = await svc.getFileNodesForOrg(LOCAL_ORG_ID, serviceArgs);
  const nodes = (result.nodes || []).map(shapeSearchNode);
  if (!nodes.length) {
    throw resolverError(404, 'file_not_in_graph',
      `No graph nodes for "${args.path}". The path must match the graph exactly (repository-relative). Use search_code to find the right spelling.`);
  }
  const fileAnnotation = fileAnnotationFor([args.path], deps);
  const annotationLine = render.renderFileAnnotationLine(fileAnnotation);
  const withAnnotation = (text) => (annotationLine ? `${text}\n${annotationLine}` : text);

  if (detail === 'full') {
    const text = withAnnotation(render.renderSymbols(nodes, `${nodes.length} symbol(s) in ${args.path}`));
    return structuredResult({ path: args.path, symbols: nodes, annotation: fileAnnotation, meta: result.meta || {} }, text);
  }
  // Every node repeated the same `file` the top-level `path` already carries — eight copies of one
  // string on an eight-symbol file.
  const shown = withoutCommentary(nodes);
  const dropped = nodes.length - shown.length;
  const header = `${shown.length} symbol(s) in ${args.path}`
    + (dropped ? ` (${dropped} doc comment(s) omitted — pass detail:"full" for them)` : '');
  return structuredResult({
    path: args.path,
    symbols: shown.map(conciseSymbol),
    annotation: fileAnnotation,
    meta: { count: shown.length, ...(dropped ? { commentary_omitted: dropped } : {}) },
  }, withAnnotation(render.renderSymbols(shown, header)));
}

// The one tool on this surface that does not read graph.db. It answers the question the code
// cannot: what happened last time someone worked on this. Everything it can return has already
// been filtered by recall.js — never a hypothesis, never an expired fact — so there is no
// precision decision left to make here.
async function recall(args, deps = {}) {
  const t0 = Date.now();
  // recall reads practice.db, not graph.db directly — but a fact/note's freshness (unconfirmed
  // since, orphaned, renamed) is only ever discovered by revalidation, which rides the same
  // catch-up this triggers (see live-freshness.js's revalidatePractice). Skipped entirely for a
  // bare repo-wide recall with no file/symbol — nothing there names specific code to check.
  const fresh = freshnessOf(deps);
  if (args.file) await fresh.ensureFileFresh({ cwd: deps.cwd, file: args.file });
  else if (args.symbol) await fresh.ensureRepoFresh({ cwd: deps.cwd });
  const detail = detailOf(args);
  const limit = args.limit ?? 5;
  const recallFor = deps.recallFor || require('../practice/recall').recallFor;
  const repoId = deps.repoId !== undefined ? deps.repoId : serverRepoId();

  const facts = recallFor(deps.practiceDb || null, {
    repoId,
    filePath: args.file || null,
    symbolName: args.symbol || null,
    taskType: args.task_type || null,
    limit,
    budgetChars: detail === 'full' ? 4000 : 800,
  });

  // A file/symbol-anchored open loop is otherwise visible only as a side-effect annotation
  // on explore/neighbours/file_symbols/blast_radius — never through the tool the agent is told to
  // "call FIRST" for exactly this file/symbol. Same coordinates recallFor already resolved above;
  // this is one more indexed lookup, not a second round trip.
  const noteAt = deps.noteAt || require('../practice/recall').noteAt;
  let note = null;
  if (args.file) {
    try { note = noteAt(deps.practiceDb || null, { repoId, filePath: args.file, symbolName: args.symbol || null }); } catch { note = null; }
  }

  const subject = args.symbol || args.file || (repoId ? `this repository (${repoId})` : 'this repository');
  // What was ASKED for, so the renderer can tell a repository-wide rule from a hit on the subject.
  const subjectGrain = args.symbol ? 'symbol' : (args.file ? 'file' : 'repo');
  const payload = {
    subject, subject_grain: subjectGrain, detail, facts,
    ...(note ? { note } : {}),
    meta: { repo_id: repoId, count: facts.length, latency_ms: Date.now() - t0 },
  };
  const text = render.renderRecall(payload);
  if (detail === 'full') return structuredResult(payload, text);
  return structuredResult({
    subject,
    detail,
    facts: facts.map((f) => ({
      fact_id: f.fact_id, tier: f.tier, kind: f.kind, body: f.body,
      when: f.provenance.when, symbol: f.anchor.symbol_name, file: f.anchor.file_path,
    })),
    ...(note ? { note } : {}),
    count: facts.length,
  }, text);
}

// The write side of `recall`, and the only handler on this surface that opens practice.db for
// WRITING and graph.db at the same time. That combination is exactly what no hook may do — a
// synchronous busy wait on graph.db during an ingest would stall the editor — and it is why
// declaration-grain anchoring lives here rather than in session-end.mjs: an MCP call is not a
// hook, so it can afford to resolve a symbol properly.
//
// The graph handle is optional throughout. With no graph the fact still lands, at repository
// grain; refusing to record something because the index is missing would lose the developer's
// words to fix a problem that is ours.
async function remember(args, deps = {}) {
  const t0 = Date.now();
  const detail = detailOf(args);
  const { rememberFact } = require('../practice/author');

  let practiceDb = deps.practiceDb || null;
  let graphDb = deps.graphDb !== undefined ? deps.graphDb : null;
  const ownPractice = !practiceDb;
  const ownGraph = deps.graphDb === undefined;

  try {
    if (!practiceDb) practiceDb = require('../practice/db').openPracticeDb({});
    if (ownGraph) {
      try { graphDb = require('../practice/resolve').openGraphDb(); } catch { graphDb = null; }
    }

    const result = rememberFact(practiceDb, graphDb, {
      body: args.body,
      kind: args.kind || 'law',
      symbol: args.symbol || null,
      file: args.file || null,
      repo: args.repo || null,
      // Do NOT default to 'user': an agent calling remember with no explicit source has not been
      // told this by the developer, and tagging it 'user' forges the developer's authority as the
      // provenance. Leave it unasserted (null); the passive correction channel, which IS the
      // developer speaking, passes source:'user' explicitly.
      source: args.source || null,
      cwd: deps.cwd || process.cwd(),
      // open_loop only; ignored for every other kind.
      resolve: args.resolve === true,
      loop_id: args.loop_id ?? null,
      sessionId: deps.sessionId || null,
      // Set only when the caller just read the code an IMPORTED rule names and judged whether it
      // still holds, OR when targeting an existing `fact_id`. Absent for a first-hand
      // observation — there is nothing to have "checked".
      verified: args.verified ?? null,
      note: args.note ?? null,
      // Resolve a verdict against an existing fact instead of storing a new one.
      fact_id: args.fact_id ?? null,
      confirm: args.confirm === true,
    });

    const payload = { ...result, detail, meta: { latency_ms: Date.now() - t0 } };
    const text = render.renderRemember(payload);
    if (detail === 'full') return structuredResult(payload, text);
    if (result.batch) {
      return structuredResult({ status: result.status, batch: true, results: result.results }, text);
    }
    if (result.open_loop) {
      return structuredResult({
        status: result.status,
        loop_id: result.id ?? null,
        open_loop: true,
        // Present only when the caller named a symbol/file to anchor to (author.js only sets
        // `anchored` in that case) — omitted entirely for a plain, unanchored note.
        ...(typeof result.anchored === 'boolean' ? { anchored: result.anchored } : {}),
        ...(result.missing ? { missing: result.missing } : {}),
        ...(result.mentions ? { mentions: result.mentions } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      }, text);
    }
    return structuredResult({
      status: result.status,
      fact_id: result.fact_id,
      tier: result.tier,
      kind: result.kind,
      anchor: result.anchor,
      superseded: (result.superseded || []).map((s) => s.fact_id),
      ...(result.verified ? { verified: result.verified } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    }, text);
  } finally {
    if (ownPractice && practiceDb) { try { practiceDb.close(); } catch { /* already gone */ } }
    if (ownGraph && graphDb) { try { graphDb.close(); } catch { /* already gone */ } }
  }
}


// The first-turn tool. Every other read here needs a name you already have; this one answers
// "what is this repository" from the graph alone.
//
// Repo scoping follows blast_radius's rule: a store holding exactly one repository answers
// without being told which, because the caller cannot know a name it was never given, and the
// refusal survives only for the genuinely ambiguous case.
async function overview(args, deps = {}) {
  const t0 = Date.now();
  // A structural summary across every ingested repo — no single file to scope to, and no reason
  // to freshen every listed repo's checkout for one call. Covers the caller's own (cwd's) repo,
  // the common single-repo-per-session case; a multi-repo listing's OTHER repos are unaffected.
  await freshnessOf(deps).ensureRepoFresh({ cwd: deps.cwd });
  const detail = detailOf(args);
  const limit = Math.min(args.limit ?? 10, 50);
  const analytics = deps.analytics || require('../services/graph-analytics');
  const db = deps.pool || require('../db/pool');

  const { rows: repos } = await db.query(
    `SELECT rb.id AS branch_id, r.name AS repo
       FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id`,
  );
  if (!repos.length) {
    return structuredResult({ detail, error: 'no repository is indexed yet' },
      'No repository is indexed yet. Run: koragraph ingest <path>');
  }

  const names = [...new Set(repos.map((r) => r.repo))];
  let scoped = repos;
  if (args.repo) {
    scoped = repos.filter((r) => r.repo === args.repo);
    if (!scoped.length) {
      return structuredResult({ detail, error: `unknown repository "${args.repo}"`, known: names },
        `No repository named "${args.repo}". Indexed: ${names.join(', ')}`);
    }
  } else if (names.length > 1) {
    // Not a refusal. This is the first-turn tool, so the caller cannot be expected to name a
    // repository it has not been told about — the same reasoning that made blast_radius answer
    // for a single-repo store, applied to the multi-repo case this product is actually for.
    //
    // Counts only: graphStats is three aggregates, while the hub / co-change / cycle passes are
    // the expensive ones and mean nothing averaged across four repositories anyway. Drilling in
    // by name is one more call and now the caller has the names.
    const byRepo = new Map();
    for (const r of repos) {
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
      byRepo.get(r.repo).push(r.branch_id);
    }
    const listed = await Promise.all([...byRepo.entries()].map(async ([repo, ids]) => {
      const st = await analytics.graphStats(ids, { db });
      return { repo, nodes: st.nodes, edges: st.edges, files: st.files, branches: ids.length };
    }));
    listed.sort((a, b) => b.nodes - a.nodes);
    const indexPayload = {
      detail, repos: listed, known: names, meta: { branches: repos.length, latency_ms: Date.now() - t0 },
    };
    return structuredResult(indexPayload, render.renderOverviewIndex(indexPayload));
  }

  const branchIds = scoped.map((r) => r.branch_id);
  const [stats, gods, churn, cycles] = await Promise.all([
    analytics.graphStats(branchIds, { db }),
    analytics.godNodes(branchIds, { limit, db }),
    analytics.churnHotspots(branchIds, { limit, db }),
    analytics.importCycles(branchIds, { limit: Math.min(limit, 10), db }),
  ]);

  const payload = {
    repo: scoped[0].repo,
    detail,
    stats,
    most_depended_on: gods,
    changes_together: churn,
    import_cycles: cycles,
    meta: { branches: branchIds.length, latency_ms: Date.now() - t0 },
  };
  const text = render.renderOverview(payload);
  if (detail === 'full') return structuredResult(payload, text);
  return structuredResult({
    repo: payload.repo,
    detail,
    stats: { nodes: stats.nodes, edges: stats.edges, files: stats.files },
    // `score` is what the ordering is ON, so dropping it from concise left the structured half
    // unable to explain its own row order — the same defect the text carried.
    most_depended_on: gods.slice(0, render.CONCISE_ROWS).map((g) => ({ name: g.name, file: g.file, dependents: g.dependents, score: g.score })),
    changes_together: churn.slice(0, render.CONCISE_ROWS).map((c) => ({ name: c.name, file: c.file, co_changes_with: c.co_changes_with })),
    import_cycles: cycles.slice(0, 5),
    meta: payload.meta,
  }, text);
}

// ── explore: one call returns ranked matches + the source of the top hits + their callers/callees.
// The split tools (search_code names things, neighbours gives edges, and "read the files yourself"
// forces separate Read calls) cost the agent many round-trips. This front-loads structure +
// relationships + SOURCE so the agent can answer in one or two turns. Source is read from the
// checkout on disk (the server's cwd is the repo); if a file cannot be read the row degrades to
// signature-only, never an error.
const path = require('path');
const fs = require('fs');

function readSpan(file, startLine, endLine, capLines, cwd) {
  if (!file || !startLine) return null;
  try {
    const root = path.resolve(cwd || process.cwd());
    const abs = path.resolve(root, file);
    // Stay inside the checkout; never follow a path that escapes it. The prefix test alone is not
    // enough — fs.readFileSync follows symlinks, so a symlink inside the checkout pointing outside it
    // would be read. Resolve links first and re-check containment on the real path.
    if (!abs.startsWith(root + path.sep)) return null;
    let real;
    try { real = fs.realpathSync(abs); } catch { return null; }
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    const lines = fs.readFileSync(real, 'utf8').split('\n');
    const from = Math.max(1, startLine);
    const to = Math.min(lines.length, endLine && endLine >= startLine ? endLine : startLine, from + capLines - 1);
    const body = lines.slice(from - 1, to).join('\n');
    const truncated = (endLine || startLine) > to;
    return { body, from, to, truncated };
  } catch (_) {
    return null;
  }
}

const EXPLORE_SOURCE_TYPES = new Set(['METHOD', 'CLASS', 'FUNCTION']);
// A query token that IS a declaration's whole name outranks any number of substring hits. Large
// enough to dominate word-count differences, so an exact-named symbol always leads its focus.
const EXPLORE_EXACT_NAME_BONUS = 100;
const EXPLORE_STOP = new Set([
  'the', 'and', 'for', 'how', 'does', 'is', 'are', 'what', 'where', 'when', 'get', 'set', 'this',
  'that', 'with', 'from', 'into', 'out', 'via', 'run', 'code', 'file', 'files', 'function',
  'functions', 'trace', 'find', 'show', 'invoked', 'called', 'work', 'works', 'used', 'use',
]);

async function explore(args, deps = {}) {
  const svc = services(deps);
  const t0 = Date.now();
  const detail = detailOf(args);
  const cwd = deps.cwd || process.cwd();
  // explore takes only a query, not a file — there is no known target to scope a check to until
  // AFTER the search below runs, so this is always the repo-wide (git status) check.
  await freshnessOf(deps).ensureRepoFresh({ cwd });
  const scope = await resolveProjectScope(args.project_id, svc);

  const searchArgs = { query: args.query, limit: 30 };
  if (scope.projectId != null) searchArgs.project_id = scope.projectId;
  if (scope.branchIds != null) searchArgs.branch_ids = scope.branchIds;
  const result = await svc.searchGraphForOrg(LOCAL_ORG_ID, searchArgs);
  const nodes = (result.nodes || []).map(shapeSearchNode);

  const envInt = (name, dflt) => { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v > 0 ? v : dflt; };
  // An NL phrase ("trace the not-found handler") tokenises diffusely, so raw search order puts the
  // wrong declaration first. Re-rank the source-bearing candidates by how many of the query's
  // content words appear in the node NAME or its file's final segment — a deterministic, zero-dep
  // stand-in for semantic matching. "notFound"/"handler" then win over unrelated high-centrality
  // nodes. Ties keep search order (which already merges exact-name matches ahead).
  const qWords = String(args.query || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !EXPLORE_STOP.has(w));
  // A wide structural MAP (6 focus, source on top 2) helped a sprawling monorepo trace (44→35 turns)
  // but REGRESSED contained traces, because the extra breadth is overhead when the flow is local. No
  // clean trigger separates the two (match file-spread does not — a contained trace's matches can be
  // just as concentrated), so the wide map is NOT a default; it stays reachable via
  // KORAGRAPH_EXPLORE_FOCUS/SOURCE_FOCUS. The keeper is the trivial-getter demotion below, a pure
  // ranking fix.
  const focusCount = envInt('KORAGRAPH_EXPLORE_FOCUS', detail === 'full' ? 3 : 2);
  const sourceFocus = envInt('KORAGRAPH_EXPLORE_SOURCE_FOCUS', focusCount);
  const capLines = envInt('KORAGRAPH_EXPLORE_CAPLINES', detail === 'full' ? 250 : 120);
  const relCount = envInt('KORAGRAPH_EXPLORE_RELS', 6);
  const othersCount = envInt('KORAGRAPH_EXPLORE_OTHERS', 12);
  // Unlike the wide-FOCUS experiment above, one extra hop of callees is additive rather than a
  // reshuffle, so it does not carry the same "regresses the contained case" risk. But making it
  // unconditional costs turns on tasks that never asked for a chain: without it, an agent tracing a
  // call chain gets one hop from explore, needs several more, and hand-chains `neighbours` calls (or
  // falls back to grep) to get them — exactly the shape a "trace the call chain" prompt asks for.
  // Turn ON by default only when the query itself asks for a chain/trace/flow; a plain "how does X
  // work" query still gets the lean, unregressed shape. KORAGRAPH_EXPLORE_CHAIN=1 forces it on
  // unconditionally (old behavior); =0 forces it off even for a trace query, for comparison.
  const TRACE_QUERY_RE = /\b(trace|call\s*chain|call\s*graph|invocation\s*chain|flow|step[- ]by[- ]step)\b/i;
  const chainEnv = process.env.KORAGRAPH_EXPLORE_CHAIN;
  const chainOn = chainEnv === '0' ? false : (chainEnv === '1' || TRACE_QUERY_RE.test(String(args.query || '')));
  const chainFocus = chainOn ? envInt('KORAGRAPH_EXPLORE_CHAIN_FOCUS', 2) : 0;
  const chainWidth = envInt('KORAGRAPH_EXPLORE_CHAIN_WIDTH', 4);
  const nameScore = (n) => {
    if (!qWords.length) return 0;
    const name = String(n.name || '').toLowerCase();
    const hay = `${name} ${String(n.file || '').split('/').pop().toLowerCase()}`;
    let s = 0;
    for (const w of qWords) if (hay.includes(w)) s += 1;
    // An exact name match — a query token IS this declaration's name — is a far stronger signal
    // than a substring hit. A prose query ("the rememberFact write door") never got the exact-name
    // merge that an identifier query does, so `rememberFact` scored the same +1 as any node merely
    // sharing the word "practice" and lost the tiebreak to raw search order. Rank it decisively.
    if (qWords.includes(name)) s += EXPLORE_EXACT_NAME_BONUS;
    return s;
  };
  // A 1-3 line method is a getter/accessor/delegate, not the logic a trace is about. It was leading
  // the focus (e.g. a `provider()` returning `this.config.provider`) purely because "provider" was in
  // the query. Sink trivial nodes below real logic so the structurally-meaningful symbols lead.
  const isTrivial = (n) => Number.isFinite(n.line) && Number.isFinite(n.end_line) && (n.end_line - n.line) <= 2;
  const sourceCands = nodes.filter((n) => EXPLORE_SOURCE_TYPES.has(n.type));
  const focusCandidates = sourceCands
    .map((n, i) => ({ n, i, score: nameScore(n), triv: isTrivial(n) ? 1 : 0 }))
    .sort((a, b) => (a.triv - b.triv) || (b.score - a.score) || (a.i - b.i))
    .slice(0, focusCount)
    .map((x) => x.n);

  const focus = [];
  let idx = 0;
  for (const n of focusCandidates) {
    const rels = await incidentSet(svc, n.node_id, { direction: 'both', edgeTypes: null, includeHeuristic: false });
    const ranked = rankRelations(dedupe(rels), n.file);
    const rawCallees = ranked.filter((r) => r.direction === 'out');
    const src = idx < sourceFocus ? readSpan(n.file, n.line, n.end_line, capLines, cwd) : null;
    const entry = {
      name: n.name, type: n.type, file: n.file, line: n.line, purpose: n.purpose,
      source: src ? src.body : null,
      source_lines: src ? `${src.from}-${src.to}${src.truncated ? '+' : ''}` : null,
      callers: ranked.filter((r) => r.direction === 'in').slice(0, relCount).map(compactRelation),
      callees: rawCallees.slice(0, relCount).map(compactRelation),
    };
    // Forward call chain: expand each top callee one more hop, on the top `chainFocus` focus nodes,
    // so a trace can resolve in one call. Off unless KORAGRAPH_EXPLORE_CHAIN=1.
    if (idx < chainFocus && rawCallees.length) {
      const seen = new Set([`${n.file}:${n.line}`]);
      for (const c of rawCallees.slice(0, chainWidth)) seen.add(`${c.file}:${c.line}`);
      const chain = [];
      for (const c of rawCallees.slice(0, chainWidth)) {
        if (c.node_id == null) continue;
        const sub = rankRelations(
          dedupe(await incidentSet(svc, c.node_id, { direction: 'out', edgeTypes: null, includeHeuristic: false })),
          c.file,
        ).filter((r) => !seen.has(`${r.file}:${r.line}`)).slice(0, chainWidth);
        if (sub.length) chain.push({ from: compactRelation(c), calls: sub.map(compactRelation) });
      }
      if (chain.length) entry.chain = chain;
    }
    focus.push(entry);
    idx += 1;
  }

  const focusKeys = new Set(focus.map((f) => `${f.file}:${f.line}`));
  const others = nodes.filter((n) => !focusKeys.has(`${n.file}:${n.line}`)).slice(0, othersCount);

  const withSource = focus.filter((f) => f.source).length;
  // explore is the "start here" tool, so the confident-near-miss failure the narrower tools guard
  // against is worst here: an identifier query with no real match otherwise returns a ranked page of
  // unrelated neighbours (with source) and nothing saying it is not the symbol asked for. Same note
  // and same degraded-channel honesty as search_code.
  const exploreMiss = nameMissNote(args.query, nodes);
  const exploreDegraded = (result.meta && result.meta.degraded_channels) || null;
  const explorePartial = exploreDegraded
    ? ` — PARTIAL: the ${exploreDegraded.map((d) => d.channel).join(', ')} channel(s) did not answer, so this is incomplete, not empty`
    : '';
  // explore is the primary "start here" tool, so it is where a hazard/rule/open note is most
  // valuable to surface — the agent is already looking at exactly this code.
  const exploreAnnotation = annotationFor(focus, deps);
  const annotate = render.annotator(exploreAnnotation);
  const lines = [`${nodes.length} match(es) for "${args.query}"${exploreMiss}${explorePartial}. Focus: ${focus.length} symbol(s) with callers/callees${withSource < focus.length ? `; source on top ${withSource}` : ' + source'}.`];
  for (const f of focus) {
    lines.push('');
    lines.push(`■ ${f.type} ${f.name} @ ${f.file}:${f.line}${f.purpose ? ` — ${f.purpose.slice(0, 100)}` : ''}${annotate(f)}`);
    if (f.callers.length) lines.push(`  callers: ${f.callers.map((c) => `${c.name}@${c.file}:${c.line}`).join(', ')}`);
    if (f.callees.length) lines.push(`  callees: ${f.callees.map((c) => `${c.name}@${c.file}:${c.line}`).join(', ')}`);
    if (f.chain && f.chain.length) {
      lines.push('  call chain:');
      for (const link of f.chain) lines.push(`    ${link.from.name}@${link.from.file}:${link.from.line} -> ${link.calls.map((c) => `${c.name}@${c.file}:${c.line}`).join(', ')}`);
    }
    if (f.source) {
      lines.push(`  --- source ${f.file}:${f.source_lines} ---`);
      lines.push(f.source);
    }
  }
  if (others.length) {
    lines.push('');
    lines.push('other matches:');
    for (const o of others) lines.push(`  ${o.type} ${o.name} @ ${o.file}:${o.line}`);
  }

  // Only structuredContent is billed by the Claude Code client (the text block is dropped before
  // the model sees it), so concise trims the JSON, not the prose: drop the request echoes and
  // latency; strip `purpose` where `source` already carries the signature; cut `others` to a short,
  // coordinate-only tail (the low-ranked matches were ~half the payload and are a fallback).
  if (detail === 'full') {
    return structuredResult(
      { detail, query: args.query, match_count: nodes.length, focus, others,
        annotation: exploreAnnotation, meta: { latency_ms: Date.now() - t0 } },
      lines.join('\n'),
    );
  }
  const leanFocus = focus.map((f) => {
    const e = { name: f.name, type: f.type, file: f.file, line: f.line };
    if (!f.source && f.purpose) e.purpose = f.purpose;
    if (f.source) { e.source = f.source; e.source_lines = f.source_lines; }
    if (f.callers && f.callers.length) e.callers = f.callers;
    if (f.callees && f.callees.length) e.callees = f.callees;
    if (f.chain) e.chain = f.chain;
    return e;
  });
  const EXPLORE_OTHERS_CONCISE = envInt('KORAGRAPH_EXPLORE_OTHERS_CONCISE', 6);
  const leanOthers = others.slice(0, EXPLORE_OTHERS_CONCISE)
    .map((o) => ({ name: o.name, type: o.type, file: o.file, line: o.line }));
  return structuredResult(
    { match_count: nodes.length, focus: leanFocus,
      ...(leanOthers.length ? { others: leanOthers } : {}),
      ...(others.length > leanOthers.length ? { others_omitted: others.length - leanOthers.length } : {}),
      ...(exploreAnnotation ? { annotation: exploreAnnotation } : {}) },
    lines.join('\n'),
  );
}

const HANDLERS = Object.freeze({
  explore,
  search_code: searchCode,
  neighbours,
  changes_with: changesWith,
  blast_radius: blastRadius,
  recall,
  remember,
  file_symbols: fileSymbols,
  overview,
});

module.exports = {
  HANDLERS,
  explore,
  overview,
  searchCode,
  neighbours,
  changesWith,
  blastRadius,
  recall,
  remember,
  fileSymbols,
  detailOf,
  normaliseTaskType,
  compactNodes,
  compactRelation,
  serverRepoId,
  resetRepoId,
  foldRelations,
  rankRelations,
  dedupe,
  annotationFor,
  fileAnnotationFor,
  COCHANGE_EDGE_TYPE,
  COCHANGE_RENDER_WEIGHT,
};
