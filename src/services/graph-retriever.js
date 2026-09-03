// Graph retriever
//
// Two phases per question:
//
//   Phase A — Seed retrieval (retrieval-query-plan.js → retrieval-channels.js)
//     Single-query mode: run the exact, lexical and graph channels, fuse their ranks, keep the
//     top-K seeds above the score threshold.
//     Multi-query mode: run that per item query text concurrently, then union the per-item seeds
//     and deduplicate by node id, keeping the highest score. Each item gets its own targeted
//     seed, so semantically distant parts of one question are all represented in the subgraph
//     rather than only whichever one dominates.
//
//   Phase B — Graph expansion
//     Recursive SQL CTE from the seed nodes over TRAVERSAL_EDGE_TYPES (graph-vocabulary.js):
//       depth 1 — any traversable edge type, same-repo and cross-repo
//       depth 2 — cross-repo edges and BELONGS_TO only; same-repo CALLS and friends stop at one
//                 hop, and IMPORTS is never traversed (deduped hub risk)
//     Hard cap: SUBGRAPH_MAX_NODES nodes.
//
// Config via environment variables:
//   RETRIEVAL_TOP_K          — seed nodes to keep in single-query mode (default 8)
//   RETRIEVAL_SEEDS_PER_ITEM — seeds per item in multi-query mode (default 2)
//   RETRIEVAL_ANCHOR_SEEDS   — seeds for the anchor query in multi-query mode (default 4)
//   RETRIEVAL_MIN_SCORE      — fused-score threshold (default 0.30)
//   SUBGRAPH_MAX_NODES       — max nodes in the expanded subgraph (default 25)

const pool = require('../db/pool');
const { resolveActiveSnapshot, generationFilterSql } = require('./ingest-generation-service');
const {
  buildRetrievalQueryPlan,
  retrieveChannelSeeds,
  executeMultiQueryPlan,
} = require('./retrieval-query-plan');
const {
  TRAVERSAL_EDGE_TYPES,
  resolveExpansionHopLimit,
  shouldPullThroughEdge,
  buildExpansionRejectionReport,
  ENDPOINT_ONTOLOGY_TYPES,
  ENDPOINT_CAP,
  capFileFanout,
} = require('./graph-expansion-policy');
const { enrichNodesWithSourceIdentity } = require('./source-evidence-contract');
const { personalizedPageRank } = require('./graph-ppr');

const TOP_K = parseInt(process.env.RETRIEVAL_TOP_K || '8', 10);
const SEEDS_PER_ITEM = parseInt(process.env.RETRIEVAL_SEEDS_PER_ITEM || '2', 10);
const ANCHOR_SEEDS = parseInt(process.env.RETRIEVAL_ANCHOR_SEEDS || '4', 10);
const MIN_SCORE = parseFloat(process.env.RETRIEVAL_MIN_SCORE || '0.30');
const MAX_NODES = parseInt(process.env.SUBGRAPH_MAX_NODES || '25', 10);

// A caller's context budget (tokens) is a request-time signal, not a corpus constant — deriving
// maxNodes from it (instead of the flat MAX_NODES=25) is what lets a 32000-token caller actually
// receive more than a 1000-token caller. The ratio is measured from the shipped formatter itself
// (~34 tokens/node), which is a property of the render format rather than of any one repo.
const AVG_TOKENS_PER_NODE = parseInt(process.env.SUBGRAPH_AVG_TOKENS_PER_NODE || '34', 10);
// Hard ceiling independent of budget: expandSubgraph's SQL pulls maxNodes * EXPANSION_SAFETY_MULTIPLIER
// candidate rows, each scored by a correlated subquery. Without a ceiling a
// 32000-token budget would request 400 nodes -> an 8000-row safety pull, which is a latency/cost
// bound, not a recall one.
const MAX_NODES_CEILING = parseInt(process.env.SUBGRAPH_MAX_NODES_CEILING || '200', 10);

function deriveMaxNodesFromBudget(budgetTokens) {
  const budget = budgetTokens != null ? parseInt(budgetTokens, 10) : NaN;
  if (!Number.isFinite(budget) || budget <= 0) return MAX_NODES;
  const derived = Math.ceil(budget / AVG_TOKENS_PER_NODE);
  return Math.min(MAX_NODES_CEILING, Math.max(MAX_NODES, derived));
}

// Scaling breadth (maxNodes) with budget while the seed count stays flat just returns more graph
// neighbours of the same few anchors: a declaration that is neither a top-K seed nor
// graph-reachable from one stays absent, because seeds — not breadth — decide which regions of the
// graph are visited at all. Seeds therefore scale with the derived breadth, holding seed density
// constant as breadth grows. Capped independently because each seed costs its own search — this is
// a latency bound, not a recall one.
const TOP_K_CEILING = parseInt(process.env.RETRIEVAL_TOP_K_CEILING || '64', 10);

// Seeds per retrieved node. This used to be derived as TOP_K / MAX_NODES, which coupled seed
// density to two independently-drifting env vars — an untracked `.env` setting SUBGRAPH_MAX_NODES
// silently changed how many seeds every query got, which is not a property anyone tuning node
// breadth expects to touch. It is now its own constant.
//
// Why it matters: seeds are the ONLY way a node that is not graph-reachable from another seed can
// enter the subgraph. A gold declaration that is neither a top-K hit nor a neighbour of one cannot
// be reached by widening breadth; only more seeds can reach it.
const SEED_DENSITY = parseFloat(process.env.RETRIEVAL_SEED_DENSITY || '0.35');

function deriveTopKFromBudget(budgetTokens) {
  const maxNodes = deriveMaxNodesFromBudget(budgetTokens);
  if (maxNodes <= MAX_NODES) return TOP_K;
  return Math.min(TOP_K_CEILING, Math.max(TOP_K, Math.ceil(maxNodes * SEED_DENSITY)));
}

// A single FILE node's CONTAINS fan-out (p95 52 nodes/file, max 2000) can dominate the edges returned for
// an already node-capped (MAX_NODES) subgraph, crowding out the CALLS/
// EXTENDS/IMPLEMENTS edges that actually carry answer-relevant signal.
// capFileFanout (graph-expansion-policy.js) caps CONTAINS edges per source
// FILE node and passes every other edge type through untouched.
const CONTAINS_FANOUT_CAP = parseInt(process.env.SUBGRAPH_CONTAINS_FANOUT_CAP || '15', 10);

// Defect fix (graph-retriever expandSubgraph): the expansion SQL used to LIMIT the
// candidate set to maxNodes BEFORE relevance ranking, so a coarse type/depth/id
// heuristic — never the seed's real fusedScore — decided which nodes survived
// truncation. We now pull a generously bounded candidate set, rank it in JS by the
// same score attachRetrievalScores() computes, then truncate to maxNodes. This
// multiplier only bounds the *unranked* SQL pull so a large branch can't blow up
// query/memory cost; it is not itself the relevance cutoff.
const EXPANSION_SAFETY_MULTIPLIER = parseInt(process.env.SUBGRAPH_EXPANSION_SAFETY_MULTIPLIER || '20', 10);

// Personalized PageRank over the retrieved candidate subgraph, seeded on the query's own seeds.
//
// This is the only relevance signal for expansion candidates: the per-node cosine that used to
// differentiate them is gone with the vectors. Without PPR a non-seed candidate's rank score is
// the flat constant `bestSeedScore * decay^depth`, every candidate at a given depth ties, and
// the delivered set is chosen by a type/depth/id tiebreak rather than by relevance.
//
// Read at call time (not module load) so one process can run both arms of a matched pair.
function pprEnabled(explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const v = process.env.SUBGRAPH_PPR;
  return v === '1' || v === 'true' || v === 'on';
}
const PPR_DAMPING = parseFloat(process.env.SUBGRAPH_PPR_DAMPING || '0.85');
const PPR_DIRECTED = process.env.SUBGRAPH_PPR_DIRECTED === '1' || process.env.SUBGRAPH_PPR_DIRECTED === 'true';

// Hop-1 expansion is bidirectional by default on every TRAVERSAL edge type (plus BELONGS_TO),
// so one seed pulls unrelated controllers, domains, and reverse CALLS — noise dominates.
// Set SUBGRAPH_EXPAND_DIRECTED=1 for outbound-only edges (from_node_id = seed).
const EXPAND_DIRECTED =
  process.env.SUBGRAPH_EXPAND_DIRECTED === '1' ||
  process.env.SUBGRAPH_EXPAND_DIRECTED === 'true';

// ─── Phase A: Single-query Seed Retrieval ─────────────────────────────────────

// Retrieves up to `topK` seed nodes for a single query text.
// Used directly for single-query mode and as a building block for multi-query mode.
//
// resolvedRepoIds: pre-resolved repo IDs from Phase 0 (pass [] for cross-repo, null to resolve inline)

async function retrieveSeeds(queryText, branchIds, topK = TOP_K, resolvedRepoIds = null, activeGenerationIds = [], opts = {}) {
  if (!branchIds || !branchIds.length) return [];

  // No query embedding is computed at all — not an empty one, none. Repo resolution went with
  // it: resolveRepos scored repos by cosine against a repo embedding, so with no query vector
  // there is nothing to score and every branch stays in scope.
  const result = await retrieveChannelSeeds({
    queryText,
    branchIds,
    activeGenerationIds,
    scopedBranchIds: branchIds,
    topK,
    intent: opts.intent,
    language: opts.language,
    risk: opts.risk,
    fusionMinScore: opts.fusionMinScore,
    channels: opts.channels,
  });

  const seeds = result.seeds;
  if (process.env.DEBUG_RETRIEVER) {
    console.log('[graph-retriever] channel stats:', JSON.stringify(result.channel_stats));
    seeds.forEach(s =>
      console.log(`[graph-retriever] seed: ${s.name} (${s.node_type}) fused=${s.fusedScore.toFixed(4)} channels=${(s.channels || []).join(',')} query="${queryText.substring(0, 60)}"`)
    );
  }

  seeds._channelStats = result.channel_stats;
  seeds._fusionTrace = result.fusion_trace;
  seeds._rejectedCandidates = result.rejected_candidates;
  // attach point 1 of 3 (graph-retriever.js:296-298 in the plan's caller map) — reached
  // by retrieveSubgraph whenever no itemQueryTexts are passed.
  seeds._escalation = result.escalation;
  return seeds;
}

// ─── Phase A (multi-query): Per-item Seed Retrieval ───────────────────────────
//
// Runs one retrieveSeeds call per item query concurrently (Promise.all), then
// unions results deduplicating by node ID — keeping the highest fusedScore when
// the same node appears in multiple per-item results.
//
// This mirrors how a human reviewer works: for each checklist item they search
// the codebase specifically for that item, rather than searching once for the
// entire requirement. Semantically distant flows (e.g. token generation in one
// service and the outbound call in another) each get their own targeted seed, so
// neither gets crowded out of the subgraph by the other.
//
// queryTexts[0] is treated as the "anchor" (full requirement text) and gets
// ANCHOR_SEEDS slots. All subsequent items get SEEDS_PER_ITEM slots each.

async function retrieveSeedsMulti(queryTexts, branchIds, activeGenerationIds = [], opts = {}) {
  if (!queryTexts || !queryTexts.length) return [];

  const plan = buildRetrievalQueryPlan({
    requirementText: queryTexts[0],
    itemQueryTexts: queryTexts.slice(1),
    intent: opts.intent,
    language: opts.language,
    risk: opts.risk,
  });


  const topKPerQuery = queryTexts.map((_, i) => (i === 0 ? ANCHOR_SEEDS : SEEDS_PER_ITEM));
  const { seeds, rejected_candidates, channel_stats, fusion_trace, escalation } = await executeMultiQueryPlan({
    plan,
    branchIds,
    activeGenerationIds,
    resolvedRepoIds: [],
    topKPerQuery,
    scopeBranchIds: branchIds,
  });

  seeds._channelStats = channel_stats;
  seeds._fusionTrace = fusion_trace;
  seeds._rejectedCandidates = rejected_candidates;
  // Attach point 2 of 3: this is the path retrieveSubgraph takes whenever itemQueryTexts is
  // non-empty, i.e. the normal multi-query ask. Skipping it is the easy way to lose escalation
  // on the common path.
  seeds._escalation = escalation;
  return seeds;
}

// ─── Phase B: Graph Expansion ─────────────────────────────────────────────────
//
// From seed node IDs, follow TRAVERSAL_EDGE_TYPES up to depth 2 (recursive CTE).
//
// Bidirectional hop-1 (SUBGRAPH_EXPAND_DIRECTED unset / false):
//   • Join is bidirectional: (from = frontier OR to = frontier). Any neighbor on CALLS,
//     BELONGS_TO, READS, … is pulled in. That is why "correct seeds" still yield a busy
//     subgraph: e.g. a SERVICE seed also pulls every controller that CALLS that service.
//
// Directed hop-1 (SUBGRAPH_EXPAND_DIRECTED=1):
//   • Join is outbound only: e.from_node_id = frontier → e.to_node_id is the next node.
//
// Depth rule (both modes):
//   depth 1 — all matching edges from the rule above (subject to directed vs bidirectional join)
//   depth 2 — only cross-repo edges OR BELONGS_TO (same-repo CALLS etc. do not extend a 2nd hop)
//
// BELONGS_TO at depth 2 keeps domain grouping edges per original design.

async function expandSubgraph(seedNodeIds, branchIds, opts = {}) {
  if (!seedNodeIds || !seedNodeIds.length) return { nodes: [], edges: [] };

  const edgeTypesSql = TRAVERSAL_EDGE_TYPES.map(t => `'${t}'`).join(',');
  const parsedHopLimit = Number.parseInt(opts.maxHops ?? 2, 10);
  const hopLimit = Number.isFinite(parsedHopLimit) ? Math.max(parsedHopLimit, 0) : 2;
  const reverseTraversal = opts.reverseEdges === true;

  const nextNodeExpr = reverseTraversal
    ? 'e.from_node_id'
    : (EXPAND_DIRECTED
      ? 'e.to_node_id'
      : `CASE WHEN e.from_node_id = exp.node_id THEN e.to_node_id ELSE e.from_node_id END`);
  const edgeJoinSql = reverseTraversal
    ? 'e.to_node_id = exp.node_id'
    : (EXPAND_DIRECTED
      ? 'e.from_node_id = exp.node_id'
      : '(e.from_node_id = exp.node_id OR e.to_node_id = exp.node_id)');

  if (reverseTraversal) {
    console.log('[graph-retriever] expandSubgraph: reverseEdges=1 (upstream hop traversal)');
  } else if (EXPAND_DIRECTED) {
    console.log('[graph-retriever] expandSubgraph: SUBGRAPH_EXPAND_DIRECTED=1 (outbound hop-1)');
  }

  const activeGenerationIds = opts.activeGenerationIds || [];
  const genFilter = generationFilterSql('n.ingest_generation_id', activeGenerationIds, 4);

  const maxNodes = opts.maxNodes || MAX_NODES;
  const safetyLimit = maxNodes * EXPANSION_SAFETY_MULTIPLIER;
  const usePpr = pprEnabled(opts.ppr);


  const { rows: rawExpandedNodes } = await pool.query(
    `WITH RECURSIVE expansion(node_id, depth) AS (
       -- Seed nodes
       SELECT id, 0
       FROM nodes
       WHERE id IN (SELECT value FROM json_each($1))
         AND approval_status = 'APPROVED'

       UNION

       -- Expand one hop at a time
       SELECT
         ${nextNodeExpr} AS node_id,
         exp.depth + 1
       FROM expansion exp
       JOIN edges e
         ON ${edgeJoinSql}
       WHERE exp.depth < ${hopLimit}
         AND e.edge_type IN (${edgeTypesSql})
         AND (
           exp.depth < 1
           OR e.is_cross_repo = true
           OR e.edge_type = 'BELONGS_TO'
           OR e.edge_type NOT IN ('COUPLED_WITH','DEFINED_IN')
         )
     )
     SELECT n.id, n.node_type, n.name, n.summary, n.properties,
            n.raw_evidence,
            n.file_id,
            n.file_sha_at_extract,
            n.start_line,
            n.end_line,
            n.repository_branch_id,
            f.path AS file_path,
            f.file_sha,
            ex.min_depth
     FROM nodes n
     LEFT JOIN files f ON f.id = n.file_id
     JOIN (
       SELECT node_id, MIN(depth) AS min_depth
       FROM expansion
       GROUP BY node_id
     ) ex ON n.id = ex.node_id
     WHERE n.approval_status = 'APPROVED'
       AND (
         -- CONFIG_VALUE/DEPENDENCY are deliberately allowed into the
         -- 'exact' seed channel (retrieval-channels.js EXACT_NODE_TYPES)
         -- for filename/config reachability. Excluding them here unconditionally
         -- meant a node that legitimately won a seed slot (depth 0) was still
         -- thrown away before delivery, wasting the slot for nothing. Rescue them
         -- ONLY as depth-0 seeds; IMPORT/TEST (never seed types) and any
         -- CONFIG_VALUE/DEPENDENCY reached via expansion (depth > 0) stay excluded.
         -- Container nodes are not declarations, and reaching them by EXPANSION spends budget
         -- on rows that answer nothing: every symbol line already carries '@ path:line', so a
         -- FILE/DIRECTORY row repeats a location the reader has. Measured on psf/requests at a
         -- 1000-token budget, FILE+DIRECTORY+DEPENDENCY were ~280 of the delivered index lines.
         -- They stay reachable as depth-0 SEEDS (filename and module-name matching are real
         -- retrieval channels); only the expansion rung is closed.
         n.node_type NOT IN ('CONFIG_VALUE', 'DEPENDENCY', 'IMPORT', 'FILE', 'DIRECTORY'${opts.includeTests ? '' : ", 'TEST'"})
         OR (ex.min_depth = 0 AND n.node_type IN ('CONFIG_VALUE', 'DEPENDENCY', 'FILE', 'DIRECTORY'))
       )
       AND (
         n.repository_branch_id IN (SELECT value FROM json_each($3))
         OR n.repository_branch_id IS NULL
       )${genFilter.clause}
     ORDER BY
       CASE n.node_type
         WHEN 'ENDPOINT'   THEN 0
         WHEN 'SERVICE'    THEN 0
         WHEN 'REPOSITORY' THEN 0
         WHEN 'CLASS'      THEN 1
         WHEN 'METHOD'     THEN 1
         WHEN 'ENTITY'     THEN 1
         ELSE 2
       END,
       ex.min_depth,
       n.id
     LIMIT $2`,
    [seedNodeIds, safetyLimit, branchIds, ...genFilter.params]
  );

  if (!rawExpandedNodes.length) return { nodes: [], edges: [] };

  // Rank the full (safety-bounded) candidate set by real relevance,
  // then truncate to maxNodes — instead of letting the SQL LIMIT (type/depth/id
  // heuristic) decide before the seed's actual fusedScore is ever consulted.
  // Mirrors the scoring attachRetrievalScores() applies later (graph-retriever.js
  // EXPANSION_SCORE_DECAY): depth-0 seed rows keep their real fusedScore, expansion
  // rows decay that score by depth. The old type/depth/id CASE is kept only as a
  // tiebreaker for equal scores, not as the primary ranking signal.
  const seedScoreById = new Map();
  for (const s of opts.seeds || []) {
    const score = Number(s.fusedScore);
    if (Number.isFinite(score)) seedScoreById.set(String(s.id), Math.max(0, Math.min(1, score)));
  }
  const bestSeedScore = seedScoreById.size ? Math.max(...seedScoreById.values()) : 0;
  const typePriority = (nodeType) => {
    if (nodeType === 'ENDPOINT' || nodeType === 'SERVICE' || nodeType === 'REPOSITORY') return 0;
    if (nodeType === 'CLASS' || nodeType === 'METHOD' || nodeType === 'ENTITY') return 1;
    return 2;
  };

  // ── Personalized PageRank over the candidate set ──────────────────────────
  // Runs on the FULL safety-bounded candidate set, before truncation — ranking after the cut
  // would only reorder what a type/depth/id heuristic had already chosen to keep, which is the
  // defect this exists to fix. The edges are fetched once here for the candidate ids; the
  // post-truncation edge query below is unchanged and still decides what is delivered.
  let pprById = null;
  let pprTrace = null;
  if (usePpr && rawExpandedNodes.length > 1) {
    const candidateIds = rawExpandedNodes.map((n) => n.id);
    // Restricted to TRAVERSAL_EDGE_TYPES — the same relation set the subgraph itself is built
    // from. Diffusing relevance over edges the expansion does not follow would rank candidates by
    // a graph the caller never sees.
    const { rows: pprEdges } = await pool.query(
      `SELECT e.from_node_id, e.to_node_id, e.edge_type
         FROM edges e
        WHERE e.from_node_id IN (SELECT value FROM json_each($1))
          AND e.to_node_id   IN (SELECT value FROM json_each($1))
          AND e.edge_type    IN (SELECT value FROM json_each($2))
        ORDER BY e.id`,
      [candidateIds, TRAVERSAL_EDGE_TYPES]
    );
    const personalization = new Map(seedScoreById);
    const t0 = Date.now();
    const ppr = personalizedPageRank(rawExpandedNodes, pprEdges, personalization, {
      damping: PPR_DAMPING,
      directed: PPR_DIRECTED,
    });
    pprById = ppr.scores;
    pprTrace = {
      candidates: rawExpandedNodes.length,
      edges: pprEdges.length,
      iterations: ppr.iterations,
      residual: ppr.residual,
      damping: PPR_DAMPING,
      directed: PPR_DIRECTED,
      ms: Date.now() - t0,
    };
  }
  const seedNumIds = new Set(seedScoreById.keys());
  const pprValues = pprById
    ? rawExpandedNodes.filter((n) => !seedNumIds.has(String(n.id)))
      .map((n) => pprById.get(String(n.id)) || 0)
    : [];
  const maxPpr = pprValues.length ? Math.max(...pprValues) : 0;

  const rankedNodes = rawExpandedNodes.map((n) => {
    const depth = Number(n.min_depth) || 0;
    const seedScore = seedScoreById.get(String(n.id));
    const decayFactor = Math.pow(EXPANSION_SCORE_DECAY, Math.max(1, depth));
    const decayed = bestSeedScore * decayFactor;

    // PPR mass (~1e-3) and fused RRF scores (~1e-2) live on different scales, so PPR is
    // normalised to a 0-1 RATIO against the best value in this candidate set and applied as a
    // multiplier on the untouched `decayed` ceiling. Blending directly pushes expansion nodes
    // above the actual seeds — measured previously to cost ~0.2 recall.
    const relevance = (pprById && maxPpr > 0)
      ? (pprById.get(String(n.id)) || 0) / maxPpr
      : 1;

    const rankScore = seedScore != null ? seedScore : decayed * relevance;
    return { ...n, _rankScore: rankScore, _typePriority: typePriority(n.node_type) };
  });

  rankedNodes.sort((a, b) => {
    if (b._rankScore !== a._rankScore) return b._rankScore - a._rankScore;
    if (a._typePriority !== b._typePriority) return a._typePriority - b._typePriority;
    if (a.min_depth !== b.min_depth) return a.min_depth - b.min_depth;
    return a.id - b.id;
  });

  if (process.env.DEBUG_RETRIEVER) {
    console.log(`[graph-retriever] expandSubgraph: ${rawExpandedNodes.length} candidates (safety limit ${safetyLimit}) → ranked, truncating to maxNodes=${maxNodes}`);
  }
  const expandedNodes = rankedNodes
    .slice(0, maxNodes)
    .map(({ _rankScore, _typePriority, ...n }) => n);

  if (!expandedNodes.length) return { nodes: [], edges: [] };

  // ── Post-collection deduplication ─────────────────────────────────────────
  //
  // Multi-branch repos (main/develop/staging) produce duplicate nodes: the same
  // class in the same file_path exists in 2-3 branches. Auth Domain BELONGS_TO
  // expansion amplifies this — the same filter appears once per branch.
  // Deduplicate by (name, file_path): keep the node with the richest data
  // (longest summary + largest properties blob) so the LLM sees one clean entry.
  //
  // ENDPOINT cap: CALLS edges from a service seed pull in ALL its endpoints at
  // depth=1, flooding context with irrelevant leaf nodes. ENDPOINT_CAP (graph-expansion-policy.js,
  // which also applies it when it builds the rejection report below) leaves room for more
  // semantically dense nodes.

  const dedupMap = new Map();
  let endpointCount = 0;
  let endpointCapDropped = 0;

  for (const n of expandedNodes) {
    if (ENDPOINT_ONTOLOGY_TYPES.has(n.node_type)) {
      if (endpointCount >= ENDPOINT_CAP) {
        endpointCapDropped += 1;
        continue;
      }
      endpointCount++;
    }

    // Scoped by branch. name + repo-RELATIVE path collides across repositories, and the ICP is
    // two or three of them: repoA/svc.js:shared and repoB/svc.js:shared deduped to one node and
    // the loser was discarded by a richness heuristic, so search_code returned one of two real
    // declarations and neighbours reported ambiguous:false. src/index.js, main.py, models.py and
    // handler.go are the normal case, not the edge case. The multi-BRANCH dedup this key was
    // built for still works — branches of one repo have distinct repository_branch_id too.
    const key = `${n.repository_branch_id ?? ''}||${n.name}||${n.file_path || ''}`;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, n);
    } else {
      const richness = (node) =>
        (node.summary || '').length + JSON.stringify(node.properties || {}).length;
      if (richness(n) > richness(existing)) dedupMap.set(key, n);
    }
  }

  const dedupedNodes = [...dedupMap.values()];
  const expansionReport = buildExpansionRejectionReport({
    rawNodes: expandedNodes,
    retainedNodes: dedupedNodes,
    maxNodes,
    endpointCap: ENDPOINT_CAP,
  });

  if (process.env.DEBUG_RETRIEVER) {
    console.log(`[graph-retriever] expandSubgraph: ${expandedNodes.length} raw → ${dedupedNodes.length} after dedup+cap:`);
    dedupedNodes.forEach(n =>
      console.log(`  [${n.node_type}] ${n.name}${n.file_path ? ' @ ' + n.file_path : ''}`)
    );
  }

  const nodeIds = dedupedNodes.map(n => n.id);

  // Fetch all edges between the expanded node set.
  //
  // ORDER BY e.id is load-bearing, not tidiness. Without it the rows come back in whatever order
  // the plan happens to produce, and that order decides two visible things: which CONTAINS edges
  // survive capFileFanout, and the order of the target list inside each rendered edge group
  // (subgraph-builder.js keys them in a Map, which iterates by insertion). `e.id` is unique, so
  // this pins the order to the graph rather than to the storage layout.
  const { rows: edges } = await pool.query(
    `SELECT e.id, e.from_node_id, e.to_node_id, e.edge_type, e.is_cross_repo,
            fn.name AS from_name, fn.node_type AS from_type,
            tn.name AS to_name,   tn.node_type AS to_type
     FROM edges e
     JOIN nodes fn ON fn.id = e.from_node_id
     JOIN nodes tn ON tn.id = e.to_node_id
     WHERE e.from_node_id IN (SELECT value FROM json_each($1))
       AND e.to_node_id   IN (SELECT value FROM json_each($1))
       AND e.edge_type    IN (${edgeTypesSql})
     ORDER BY e.id`,
    [nodeIds]
  );

  return {
    nodes: dedupedNodes,
    edges: capFileFanout(edges, CONTAINS_FANOUT_CAP),
    expansion_rejected: expansionReport.rejected_candidates,
    expansion_truncation: expansionReport.truncation,
    ppr: pprTrace,
  };
}

// Neighborhood / Flow Trace strips properties + raw_evidence for a slim UI payload.
// Project context (SPECTRA) needs them — merge from nodes after the neighborhood walk.
async function enrichNodesFromDb(nodeRows, opts = {}) {
  if (!nodeRows.length) return [];
  const ids = [...new Set(nodeRows.map((n) => n.id))];
  const { rows } = await pool.query(
    `SELECT n.id, n.properties, n.raw_evidence, n.summary, f.path AS file_path,
            n.file_id, n.file_sha_at_extract, n.start_line, n.end_line, f.file_sha
     FROM nodes n
     LEFT JOIN files f ON f.id = n.file_id
     WHERE n.id IN (SELECT value FROM json_each($1))`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const merged = nodeRows.map((n) => {
    const row = byId.get(n.id);
    if (!row) return { ...n };
    return {
      ...n,
      summary: row.summary ?? n.summary,
      properties: row.properties ?? n.properties ?? null,
      raw_evidence: row.raw_evidence ?? n.raw_evidence ?? null,
      file_path: row.file_path ?? n.file_path ?? null,
      file_id: row.file_id ?? n.file_id ?? null,
      file_sha: row.file_sha ?? n.file_sha ?? null,
      file_sha_at_extract: row.file_sha_at_extract ?? n.file_sha_at_extract ?? null,
      start_line: row.start_line ?? n.start_line ?? null,
      end_line: row.end_line ?? n.end_line ?? null,
    };
  });
  return enrichNodesWithSourceIdentity(merged, {
    activeGenerationIds: opts.activeGenerationIds,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
//
// retrieveSubgraph(requirementText, branchIds, itemQueryTexts?, options?)
//
//   requirementText  — full "title: description" string (always used as anchor)
//   branchIds        — branch IDs scoping the search
//   itemQueryTexts   — optional array of atomic item strings extracted from the
//                      requirement description (e.g. "Generate 6-digit OTP",
//                      "Send OTP via SMS"). When provided, multi-query mode is
//                      used for richer, more targeted seed retrieval.
//
// Returns { nodes, edges, seedCount, queryCount }
//

// Expansion nodes are reachable from *some* seed but the CTE does not record which,
// so a derived score decays the best seed score by hop depth. `retrieval_origin`
// marks the difference: consumers must not read a derived score as a measured one.
//
// Configurable because it is the binding constraint on traversal depth, not a cosmetic
// weight. An expansion node's rank ceiling is `bestSeedScore * DECAY^depth * (ppr/maxPpr)`,
// and `ppr/maxPpr <= 1` by construction — so at 0.6 a depth-d node can never outrank a
// depth-(d-1) node regardless of how relevant it actually is (it would need a ratio of
// 1/0.6 = 1.67x, which the normalisation forbids). Depth beyond 2 is therefore inert at this
// value: the deep rows are fetched by the CTE, then sorted below every shallow row and cut by
// the maxNodes truncation. Raising hop limits without raising this measures nothing.
const EXPANSION_SCORE_DECAY = parseFloat(process.env.SUBGRAPH_EXPANSION_SCORE_DECAY || '0.6');


async function attachRetrievalScores(nodeRows, seeds, queryText = null) {
  const seedScoreById = new Map();
  for (const s of seeds || []) {
    const score = Number(s.fusedScore);
    if (Number.isFinite(score)) seedScoreById.set(String(s.id), Math.max(0, Math.min(1, score)));
  }
  const bestSeedScore = seedScoreById.size ? Math.max(...seedScoreById.values()) : 0;


  // Exact name matches reached by EXPANSION, not just by seeding.
  //
  // The exact channel only ever scores seeds. A node the question names by name but that the
  // subgraph reached one hop later scored `bestSeedScore * decay^depth` — the same as any
  // incidental neighbour — so the symbol the user actually asked about sat wherever the decay
  // put it. Measured on requests: gold found as a seed ranked 1; gold found by expansion ranked
  // 21, 39 and 52, and the context is rendered in this order, so those are the ranks a reader
  // sees. It is why fixing the fusion leg alone did not move MRR at all.
  //
  // A node whose name the query contains verbatim is placed just below the best seed: above
  // every other expansion node, but never displacing a seed that the fused score already ranked
  // first (which is itself usually the exact match, when the exact channel found it).
  // Match VERBATIM, case included. Case-insensitive matching against any query token was far too
  // loose: "Add type annotation for `Request.hooks`" put CONSTANT HOOKS and two METHOD `request`
  // nodes at the same top score as the CLASS `Request` the question actually names, and the
  // alphabetical tie-break then rendered the answer fourth. In code, case IS the signal that
  // separates a class from a method from a constant, so requiring the identifier to appear in
  // the question exactly as written is what makes this discriminate rather than flood.
  const q = queryText ? String(queryText) : '';
  const namedByQuery = (n) => {
    if (!q || !n.name) return false;
    const name = String(n.name);
    const candidates = [name];
    const tail = name.split(/[.:]{1,2}/).pop();
    if (tail && tail !== name) candidates.push(tail);
    return candidates.some((c) => {
      if (c.length < 4) return false; // 'get'/'set' are words, not evidence
      const re = new RegExp(`(?<![A-Za-z0-9_])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
      return re.test(q);
    });
  };

  return (nodeRows || []).map((n) => {
    // A node the question names verbatim is the most relevant thing in the subgraph, whether it
    // arrived as a seed or by expansion, and it ranks first. Placing it just BELOW the seed block
    // (the first version of this fix) left it behind 8-12 vector seeds, burying the named symbol
    // at record ~3.7. Finding the answer and then not showing it first is not a win.
    const exactNamed = namedByQuery(n);
    const seedScore = seedScoreById.get(String(n.id));
    if (seedScore != null) {
      return {
        ...n,
        retrieval_score: exactNamed ? 1.0 : seedScore,
        retrieval_origin: exactNamed ? 'seed_exact_name' : 'seed',
        retrieval_depth: 0,
      };
    }
    const depth = Number.isFinite(Number(n.min_depth)) ? Math.max(1, Number(n.min_depth)) : 1;
    const decayFactor = Math.pow(EXPANSION_SCORE_DECAY, depth);
    const baseDecayed = bestSeedScore * decayFactor;
    return {
      ...n,
      retrieval_score: exactNamed ? 1.0 : baseDecayed,
      retrieval_origin: exactNamed ? 'expansion_exact_name' : 'expansion',
      retrieval_depth: depth,
    };
  });
}

async function retrieveSubgraph(requirementText, branchIds, itemQueryTexts = [], options = {}) {
  let seeds;
  let queryCount;

  const snapshot = options.activeGenerationIds
    ? { activeGenerationIds: options.activeGenerationIds }
    : await resolveActiveSnapshot(branchIds);
  const activeGenerationIds = snapshot.activeGenerationIds || [];

  const callerTopK = options.topK != null ? parseInt(options.topK, 10) : undefined;

  const retrievalOpts = {
    intent: options.intent,
    language: options.language,
    risk: options.risk,
    channels: options.channels,
  };

  let rejectedCandidates = [];

  if (itemQueryTexts.length > 0) {
    const allQueries = [requirementText, ...itemQueryTexts];
    queryCount = allQueries.length;

    const plan = buildRetrievalQueryPlan({
      requirementText,
      itemQueryTexts,
      ...retrievalOpts,
    });
    seeds = await retrieveSeedsMulti(
      allQueries,
      branchIds,
      activeGenerationIds,
      retrievalOpts,
    );
    rejectedCandidates = seeds._rejectedCandidates || [];

    console.log(
      `[graph-retriever] Multi-query: ${queryCount} queries (1 anchor + ${itemQueryTexts.length} items)` +
      ` → ${seeds.length} unique seeds`
    );
  } else {
    queryCount = 1;
    seeds = await retrieveSeeds(
      requirementText,
      branchIds,
      callerTopK ?? deriveTopKFromBudget(options.budget),
      [],
      activeGenerationIds,
      retrievalOpts,
    );
    rejectedCandidates = seeds._rejectedCandidates || [];
  }

  if (callerTopK != null && seeds.length > callerTopK) {
    seeds = seeds.slice(0, callerTopK);
  }

  const rawHopLimit = options.maxHops ?? process.env.SUBGRAPH_NEIGHBORHOOD_HOPS;
  const hopLimit = resolveExpansionHopLimit(options.intent, rawHopLimit);
  const reverseEdges = options.reverseEdges === true;

  // an explicit options.maxNodes always wins (existing callers stay byte-identical).
  // Otherwise, an explicit options.budget (tokens) derives a wider breadth cap so a caller who
  // asked for more context actually gets more nodes to fill it. Absent both, behaviour is
  // unchanged (MAX_NODES=25).
  const derivedMaxNodes = options.maxNodes != null
    ? options.maxNodes
    : deriveMaxNodesFromBudget(options.budget);

  const fusionTrace = seeds._fusionTrace || null;
  const channelStats = seeds._channelStats || [];
  // captured before any reassignment below (e.g. the fan-out merge rebuilds `seeds` as
  // a plain array via `[...seedMap.values()]`, which drops the underscore-prefixed properties) —
  // this is the value every return statement in this function must expose as `_escalation`.
  const escalation = seeds._escalation || null;

  if (hopLimit === 0) {
    const seedNodes = await attachRetrievalScores(
      await enrichNodesFromDb(seeds, { activeGenerationIds }),
      seeds,
    );
    return {
      nodes: seedNodes, edges: [], seedCount: seeds.length, queryCount,
      _escalation: escalation,
      retrieval_trace: _buildRetrievalTrace(branchIds, seeds.length, queryCount, hopLimit, 0, 0, channelStats, fusionTrace, {
        rejectedCandidates,
        intent: options.intent,
      }),
    };
  }

  if (!seeds.length) {
    console.log('[graph-retriever] No seeds found — subgraph is empty');
    return {
      nodes: [], edges: [], seedCount: 0, queryCount,
      _escalation: escalation,
      retrieval_trace: _buildRetrievalTrace(branchIds, 0, queryCount, hopLimit, 0, 0, [], null, {
        rejectedCandidates,
        intent: options.intent,
      }),
    };
  }

  const seedIds = seeds.map(s => s.id);

  let expansionRejected = [];
  let expansionTruncation = null;
  let pprTrace = null;
  let nodes;
  let edges;
  {
    const expanded = await expandSubgraph(seedIds, branchIds, { ...options, maxNodes: derivedMaxNodes, maxHops: hopLimit, reverseEdges, activeGenerationIds, seeds });
    nodes = expanded.nodes;
    edges = expanded.edges;
    expansionRejected = expanded.expansion_rejected || [];
    expansionTruncation = expanded.expansion_truncation || null;
    pprTrace = expanded.ppr || null;
  }

  // Gated like the four other traces in this file. Ungated, this line went to the user's terminal
  // on every CLI symbol lookup and every MCP call — retriever internals presented as program output.
  if (process.env.DEBUG_RETRIEVER) {
    console.log(
      `[graph-retriever] ${seeds.length} seeds → ${nodes.length} nodes, ${edges.length} edges` +
      (itemQueryTexts.length > 0 ? ` (multi-query: ${queryCount} queries)` : '')
    );
  }

  // ── Typed pull-through (post Phase B) ──────────────────────────────────────
  // Graph edges encode typed relationships that are always relevant regardless
  // of hop depth.  After expansion we explicitly pull:
  //   1. READS_TABLE / WRITES_TABLE from any NODE_SERVICE / NODE_CONTROLLER found
  //      → services always own their DB tables; never leave them behind
  //   2. CALLS edges from any ENDPOINT found → its handler / controller
  //      → an endpoint without its implementation is half an answer
  // This removes the dependency on hop count for discovering the DB layer.
  { // block scope to avoid variable leaks
    const nodeIdSet = new Set(nodes.map(n => String(n.id)));
    const edgeIdSet = new Set(edges.map(e => String(e.id)));

    // Normalise IDs to strings — PostgreSQL BIGINT comes back as string from node-pg
    // but AGE/neighborhood results may return numbers. Mixing causes.includes() to miss.
    const serviceNodeIds = nodes
      .filter(n => n.node_type === 'NODE_SERVICE' || n.node_type === 'NODE_CONTROLLER')
      .map(n => String(n.id));
    const endpointNodeIds = nodes
      .filter(n => n.node_type === 'ENDPOINT')
      .map(n => String(n.id));

    const pullIds = [...new Set([...serviceNodeIds, ...endpointNodeIds])];

    if (pullIds.length) {
      try {
        const { rows: pullRows } = await pool.query(
          `SELECT
             e.id as edge_id, e.edge_type, e.from_node_id, e.to_node_id, e.is_cross_repo, e.properties,
             n.id, n.node_type, n.name, n.summary, n.raw_evidence, n.start_line, n.end_line, n.properties as node_properties,
             n.confidence, n.canonical_key, n.repository_branch_id, n.file_id, n.file_sha_at_extract
           FROM edges e
           JOIN nodes n ON n.id = e.to_node_id
           WHERE e.from_node_id IN (SELECT value FROM json_each($1))
             AND e.edge_type IN (SELECT value FROM json_each($2))
           ORDER BY e.id`,
          [
            pullIds,
            ['READS_TABLE', 'WRITES_TABLE', 'CALLS'],
          ]
        );

        let newNodes = 0;
        let newEdges = 0;
        for (const row of pullRows) {
          const fromIdStr = String(row.from_node_id);
          const fromNode = nodes.find((n) => String(n.id) === fromIdStr) || { node_type: null };
          const toNode = { node_type: row.node_type };

          if (!shouldPullThroughEdge(fromNode, toNode, row.edge_type)) continue;

          if (!nodeIdSet.has(String(row.id))) {
            nodes.push({
              id: row.id, node_type: row.node_type, name: row.name,
              summary: row.summary, raw_evidence: row.raw_evidence,
              properties: row.node_properties, confidence: row.confidence,
              canonical_key: row.canonical_key,
              repository_branch_id: row.repository_branch_id,
              file_id: row.file_id ?? null,
              file_sha_at_extract: row.file_sha_at_extract ?? null,
              start_line: row.start_line ?? null,
              end_line: row.end_line ?? null,
            });
            nodeIdSet.add(String(row.id));
            newNodes++;
          }
          if (!edgeIdSet.has(String(row.edge_id))) {
            edges.push({
              id: row.edge_id, edge_type: row.edge_type,
              from_node_id: row.from_node_id, to_node_id: row.to_node_id,
              is_cross_repo: row.is_cross_repo, properties: row.properties,
            });
            edgeIdSet.add(String(row.edge_id));
            newEdges++;
          }
        }
        if (newNodes > 0) {
          console.log(`[graph-retriever] Pull-through: +${newNodes} nodes, +${newEdges} edges (DB tables + endpoint handlers)`);
        }
      } catch (err) {
        console.warn(`[graph-retriever] Pull-through failed (non-blocking): ${err.message}`);
      }
    }
  }

  const omittedNodeCount = expansionTruncation?.total_truncated
    ?? (MAX_NODES > 0 && nodes.length >= MAX_NODES ? 1 : 0);
  const allRejected = [...rejectedCandidates, ...expansionRejected];
  nodes = await enrichNodesWithSourceIdentity(nodes, { activeGenerationIds });
  nodes = await attachRetrievalScores(nodes, seeds, requirementText);
  return {
    nodes,
    edges,
    seedCount: seeds.length,
    queryCount,
    _escalation: escalation,
    retrieval_trace: _buildRetrievalTrace(branchIds, seeds.length, queryCount, hopLimit, omittedNodeCount, 0, channelStats, fusionTrace, {
      rejectedCandidates: allRejected,
      truncation: expansionTruncation,
      intent: options.intent,
      ppr: pprTrace,
    }),
  };
}

function _buildRetrievalTrace(branchIds, seedCount, queryCount, hopLimit, omittedNodeCount, staleCitationCount, channelStats = null, fusionTrace = null, extras = {}) {
  return {
    branch_ids:            branchIds || [],
    seed_count:            seedCount,
    query_count:           queryCount,
    hop_limit:             hopLimit,
    edge_types:            TRAVERSAL_EDGE_TYPES,
    omitted_node_count:    omittedNodeCount,
    stale_citation_count:  staleCitationCount,
    channel_stats:         channelStats || [],
    executed_channels:     fusionTrace?.executed_channels || (channelStats || []).filter((s) => s.status === 'executed').map((s) => s.channel),
    fusion_method:         fusionTrace?.fusion_method || null,
    fusion_weights:        fusionTrace?.weights || null,
    fusion_thresholds:     fusionTrace?.thresholds || null,
    rejected_candidates:   extras.rejectedCandidates || [],
    truncation:            extras.truncation || null,
    // A ranking that cannot be inspected cannot be trusted: `ppr` records the candidate/edge
    // counts, iterations and residual the delivered order was actually produced from.
    ppr:                   extras.ppr || null,
  };
}

module.exports = { retrieveSubgraph, expandSubgraph, _buildRetrievalTrace };
