'use strict';

// Personalized PageRank over a retrieved candidate subgraph.
//
// WHY THIS EXISTS
// ---------------
// expandSubgraph pulls a generously-bounded candidate set and then has to decide which
// `maxNodes` of it the caller actually receives. Until now the only relevance signal available
// for a NON-seed candidate was `own_similarity` — a per-node cosine against the query vector.
// In the structural-only configuration (no embedding server, no stored vectors) that signal does
// not exist, so every expansion candidate at the same depth scored the identical constant
// `bestSeedScore * decay^depth` and the delivered set was decided by a type/depth/id tiebreak.
// That is not a ranking; it is an ordering.
//
// Personalized PageRank is the structural answer to the same question: how much of the query's
// own relevance mass, injected at the seeds and diffused along real edges, settles on each
// candidate. It needs no vector, no model and no network — only the graph we already retrieved.
//
// It is also the "centrality fallback when the vector channel has no opinion" that the
// commons-cli loss was diagnosed as needing.
//
// SCALE
// -----
// Deliberately NOT global PageRank over the whole branch. The restart distribution is the query's
// seeds, so the scores are query-specific; and it runs over the already-bounded candidate set
// (hundreds of nodes), so it is a few milliseconds of arithmetic, not an index build.

const DAMPING = 0.85;
// Convergence is geometric at the damping rate, so 0.85^100 ~ 1e-7 bounds the residual even
// without the tolerance test firing. A few hundred nodes x 100 sweeps is well under a millisecond;
// there is no reason to stop early and report a rank order that has not settled.
const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-9;

// Edge weights by type. Call/containment/inheritance edges carry the "you must read this too"
// relationship the co-change and retrieval planes are actually about; the weaker association
// types (COUPLED_WITH is a statistical co-occurrence, not a code relationship) are damped so they
// cannot dominate a node's outgoing mass. Anything unlisted gets 1.0.
const EDGE_WEIGHTS = Object.freeze({
  CALLS: 1.0,
  EXTENDS: 1.0,
  IMPLEMENTS: 1.0,
  DEPENDS_ON: 0.9,
  READS_TABLE: 0.9,
  WRITES_TABLE: 0.9,
  MAPS_TO: 0.9,
  PRODUCES: 0.9,
  CONSUMES: 0.9,
  USES_CONFIG: 0.7,
  BELONGS_TO: 0.6,
  CONTAINS: 0.5,
  DEFINED_IN: 0.5,
  // A FILE containing 300 declarations would otherwise hand each of them the same mass as a real
  // call target, which makes the biggest file in the repo the most "relevant" thing in it.
  COUPLED_WITH: 0.25,
});

function edgeWeight(edgeType) {
  const w = EDGE_WEIGHTS[edgeType];
  return w === undefined ? 1.0 : w;
}

/**
 * @param {Array<{id: any}>} nodes            candidate set (ids as string or number)
 * @param {Array<{from_node_id, to_node_id, edge_type}>} edges  edges among the candidate set
 * @param {Map<string, number>} personalization  seed id -> restart weight (unnormalised)
 * @param {object} [opts]
 * @param {number} [opts.damping]
 * @param {boolean} [opts.directed] follow edge direction only (default false: a callee is
 *        evidence for its caller exactly as much as the reverse, and expansion is bidirectional)
 * @returns {{scores: Map<string, number>, iterations: number, converged: boolean}}
 */
function personalizedPageRank(nodes, edges, personalization, opts = {}) {
  const damping = Number.isFinite(opts.damping) ? opts.damping : DAMPING;
  const directed = opts.directed === true;

  const ids = nodes.map((n) => String(n.id));
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  if (!n) return { scores: new Map(), iterations: 0, converged: true };

  // Restart vector. A seed the fusion layer scored higher injects proportionally more mass.
  // If no personalization survives the candidate set (every seed was filtered out), fall back to
  // uniform restart — that degrades to ordinary PageRank rather than to a divide-by-zero.
  const restart = new Float64Array(n);
  let restartSum = 0;
  for (const [id, w] of personalization || []) {
    const i = index.get(String(id));
    if (i === undefined) continue;
    const v = Math.max(0, Number(w) || 0);
    restart[i] += v;
    restartSum += v;
  }
  if (restartSum <= 0) {
    // All seeds carrying zero weight is a real case: weighted_rrf fusedScores are ~0.01, and a
    // rescued seed can be exactly 0. Uniform-over-seeds beats uniform-over-everything, because
    // the seeds are still the query's own entry points.
    for (const [id] of personalization || []) {
      const i = index.get(String(id));
      if (i === undefined) continue;
      restart[i] = 1;
      restartSum += 1;
    }
  }
  if (restartSum <= 0) {
    for (let i = 0; i < n; i++) restart[i] = 1;
    restartSum = n;
  }
  for (let i = 0; i < n; i++) restart[i] /= restartSum;

  // Weighted adjacency, built as CSR-ish arrays of (target, weight) per source.
  const out = Array.from({ length: n }, () => []);
  const outWeight = new Float64Array(n);
  for (const e of edges || []) {
    const a = index.get(String(e.from_node_id));
    const b = index.get(String(e.to_node_id));
    if (a === undefined || b === undefined || a === b) continue;
    const w = edgeWeight(e.edge_type);
    if (w <= 0) continue;
    out[a].push([b, w]);
    outWeight[a] += w;
    if (!directed) {
      out[b].push([a, w]);
      outWeight[b] += w;
    }
  }

  let rank = new Float64Array(restart);
  let next = new Float64Array(n);
  let iterations = 0;
  let converged = false;
  let delta = Infinity;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    next.fill(0);
    // Dangling mass (nodes with no outgoing edge) returns to the restart distribution, not to a
    // uniform one — otherwise an isolated candidate leaks relevance to every other candidate and
    // the personalization stops meaning anything.
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outWeight[i] <= 0) { dangling += rank[i]; continue; }
      const share = rank[i] / outWeight[i];
      for (const [j, w] of out[i]) next[j] += share * w;
    }
    delta = 0;
    for (let i = 0; i < n; i++) {
      const v = damping * (next[i] + dangling * restart[i]) + (1 - damping) * restart[i];
      delta += Math.abs(v - rank[i]);
      next[i] = v;
    }
    const tmp = rank; rank = next; next = tmp;
    if (delta < TOLERANCE) { converged = true; iterations += 1; break; }
  }

  const scores = new Map();
  for (let i = 0; i < n; i++) scores.set(ids[i], rank[i]);
  // `delta` is the final L1 residual. Reported rather than swallowed: at damping 0.85 the
  // iteration contracts geometrically, so 100 sweeps bound it near 1e-7 — immaterial for a rank
  // order, but an artifact that claims a ranking should be able to show how settled it was.
  return { scores, iterations, converged, residual: delta };
}

module.exports = { personalizedPageRank, EDGE_WEIGHTS, DAMPING };
