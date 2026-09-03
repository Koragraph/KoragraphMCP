'use strict';


const FUSION_METHOD = process.env.RETRIEVAL_FUSION_METHOD || 'weighted_rrf';
const RRF_K = parseInt(process.env.RETRIEVAL_RRF_K || '60', 10);

// RETRIEVER_DELTA (lexical leg) is added at 0.15, and alpha/beta/delta are rescaled
// proportionally over a 1.15 total so that RETRIEVER_DELTA=0 reproduces the non-lexical ranking
// exactly (activeWeightSum divides the active weights back out — see fuseRetrievalCandidates). A
// non-proportional rebalance would silently change every query's ranking.
// epsilon is the exact-name-match leg. It is normalised into the same 1.15 denominator so
// alpha+beta+delta keep their ratios to one another — an exact match is an additive signal rather
// than weight taken from the vector legs, so a query with no exact hit ranks as if epsilon were 0.
const DEFAULT_WEIGHTS = Object.freeze({
  alpha: 0.70 / 1.15,
  beta: 0.30 / 1.15,
  delta: 0.15 / 1.15,
  // epsilon must EXCEED alpha, or an exact name match never becomes a seed: under weighted RRF a
  // rank-1 candidate contributes weight/(K+1), so below alpha the best exact match sorts beneath
  // the dense hits and falls outside RETRIEVAL_TOP_K. Above alpha, a node the question names by
  // name is seeded ahead of cosine neighbours. The exact leg trades against dense recall, so too
  // far above alpha the trade goes negative.
  epsilon: 0.50 / 1.15,
});

const INTENT_CALIBRATION = Object.freeze({
  lookup:       { fusionMin: 0.28, denseMin: 0.35 },
  trace:        { fusionMin: 0.30, denseMin: 0.32 },
  impact:       { fusionMin: 0.32, denseMin: 0.38 },
  architecture: { fusionMin: 0.30, denseMin: 0.33 },
  compare:      { fusionMin: 0.30, denseMin: 0.33 },
  default:      { fusionMin: 0.30, denseMin: 0.35 },
});

const RISK_CALIBRATION = Object.freeze({
  low:    { fusionMinDelta: -0.02 },
  medium: { fusionMinDelta: 0 },
  high:   { fusionMinDelta: 0.04 },
});

function _readWeight(envKey, defaultVal) {
  const raw = process.env[envKey];
  if (!raw) return defaultVal;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

// RETRIEVER_GAMMA is not a live weight; a config that sets it and balances α+β+γ+δ to 1.0 will
// sum to <1 and trip the lexical sum check on every query, with an error that never mentions the
// key. Warn once so an unrelated message does not send someone hunting through alpha/beta/delta.
let _gammaWarned = false;
function _warnIfGammaSet() {
  if (_gammaWarned || !process.env.RETRIEVER_GAMMA) return;
  _gammaWarned = true;
  console.warn(
    '[retrieval-fusion] RETRIEVER_GAMMA is set but no longer exists — that leg was removed. '
    + 'It is being IGNORED. If α+β+δ no longer sum '
    + `to 1.0, redistribute gamma's weight across them or unset all RETRIEVER_* keys to take the defaults.`,
  );
}

function readFusionWeights() {
  _warnIfGammaSet();
  return {
    alpha: _readWeight('RETRIEVER_ALPHA', DEFAULT_WEIGHTS.alpha),
    beta: _readWeight('RETRIEVER_BETA', DEFAULT_WEIGHTS.beta),
    delta: _readWeight('RETRIEVER_DELTA', DEFAULT_WEIGHTS.delta),
    epsilon: _readWeight('RETRIEVER_EPSILON', DEFAULT_WEIGHTS.epsilon),
  };
}

// Structural-only fusion weights. alpha/beta must be zeroed: retrieveExactChannel and
// retrieveGraphChannel stamp a CONSTANT placeholder `dense_score` (0.5 / 0.42) onto their rows so
// fuseRetrievalCandidates has a numeric field to read, so a nonzero alpha would rank on a signal
// invented by that placeholder. delta is set to 1.0 because validateFusionWeights requires
// alpha+beta+delta == 1 whenever the lexical leg is active; rawFused divides by activeWeightSum,
// so scaling delta and epsilon by the same factor changes no ordering. epsilon is the additive
// exact-match leg; RETRIEVAL_STRUCTURAL_EXACT_RATIO tunes it, default 1.0 (equal standing with
// the IDF-ranked full-text leg, arbitrated by RRF).
function structuralFusionWeights(base = readFusionWeights()) {
  const raw = parseFloat(process.env.RETRIEVAL_STRUCTURAL_EXACT_RATIO || '1.0');
  const ratio = Number.isFinite(raw) && raw >= 0 ? raw : 1.0;
  return { alpha: 0, beta: 0, delta: 1.0, epsilon: ratio };
}

function validateFusionWeights(weights = readFusionWeights()) {
  // Called unconditionally, not via the default param — a caller passing explicit
  // weights never evaluates that default, so the warn would otherwise never fire
  // for exactly the direct-weights callers most likely to carry a stale gamma.
  _warnIfGammaSet();
  // epsilon (the exact-match leg) is deliberately OUTSIDE the sum check below: it is an additive
  // signal, not a redistribution of the vector legs, so alpha+beta+delta must still sum to 1.0
  // exactly as before and every existing caller/test that matches on
  // 'weights_must_sum_to_one_when_lexical_active' is unaffected.
  const { alpha, beta, delta = 0, epsilon = 0 } = weights;
  const errors = [];
  if (alpha < 0 || beta < 0 || delta < 0 || epsilon < 0) errors.push('negative_weight');
  if (alpha === 0 && beta === 0 && delta === 0) errors.push('all_weights_zero');
  const sum = alpha + beta + delta;
  if (delta > 0 && Math.abs(sum - 1.0) > 1e-6) {
    // Keep this code EXACT — callers and tests match on it by equality. The gamma
    // hint is a second, separate code rather than a suffix on this one.
    errors.push('weights_must_sum_to_one_when_lexical_active');
    if (process.env.RETRIEVER_GAMMA) errors.push('retriever_gamma_removed');
  }
  if (delta === 0 && alpha + beta === 0) errors.push('dense_sparse_weights_zero');
  return { valid: errors.length === 0, errors, sum };
}

function resolveCalibration({ intent, language, risk } = {}) {
  const intentKey = INTENT_CALIBRATION[intent] ? intent : 'default';
  const riskKey = RISK_CALIBRATION[risk] ? risk : 'medium';

  const intentCal = INTENT_CALIBRATION[intentKey];
  const riskCal = RISK_CALIBRATION[riskKey];

  return {
    fusion_min_score: intentCal.fusionMin + riskCal.fusionMinDelta,
    dense_min_score: intentCal.denseMin,
    intent: intentKey,
    risk: riskKey,
    language: language || 'default',
    fusion_method: FUSION_METHOD,
  };
}

// Reciprocal rank fusion. Lived in embedding-service.js, which was pure vector plumbing; this is
// ranking math and has nothing to do with embeddings.
function rrfScore(ranks, k = 60) {
  return ranks.reduce((sum, rank) => sum + (rank >= 0 ? 1 / (k + rank) : 0), 0);
}

function buildRankMap(items, scoreFn, hasSignalFn) {
  const ranked = items
    .map((item, i) => ({ i, score: scoreFn(item, i) }))
    .filter((x) => hasSignalFn(items[x.i], x.i))
    .sort((a, b) => b.score - a.score);

  const map = {};
  for (let i = 0; i < items.length; i++) map[i] = -1;
  ranked.forEach((item, rank) => { map[item.i] = rank; });
  return map;
}

function fuseRetrievalCandidates(candidates, {
  weights = null,
  calibration = {},
} = {}) {
  const w = weights || readFusionWeights();
  const validation = validateFusionWeights(w);
  if (!validation.valid) {
    throw new Error(`Invalid fusion weights: ${validation.errors.join(', ')}`);
  }

  const thresholds = resolveCalibration(calibration);
  const hasDenseSignal = candidates.some((c) => Number(c.dense_score ?? 0) > 0);
  // the lexical leg's real score lives in `channel_scores.lexical`,
  // never `channel_score` — `unionChannelCandidates` sets `channel_score = Math.max(...)`
  // across every channel that found the candidate, so a dense+lexical hit's `channel_score`
  // reads the dense score, not the lexical one.
  // 'file_lexical' (retrieval-file-lexical.js, opt-in only — never present unless a caller
  // explicitly requests it) is folded into the SAME delta-weighted leg as 'lexical': it is the
  // same kind of evidence (BM25 term match) at a different grain (whole file vs. chunk), not a
  // fourth thing needing its own weight knob. A default caller that never requests the channel
  // sees candidates with no file_lexical signal, so this is a no-op for every existing number.
  const hasLexicalSignal = candidates.some((c) => (
    (!!c.channels?.includes('lexical')
      && Number(c.channel_scores?.lexical ?? c.lexical_score ?? 0) > 0)
    || (!!c.channels?.includes('file_lexical')
      && Number(c.channel_scores?.file_lexical ?? c.file_lexical_score ?? 0) > 0)
  ));
  // An exact name match counts as signal for routing, exactly as lexical does. Without this the
  // fast path below ranks by raw cosine and the exact leg never applies — and `isDenseOnly` is
  // the common case, so the exact channel was ignored for ranking on most queries, not a few.
  const hasExactSignal = candidates.some(
    (c) => !!(c.channels?.includes('exact') || c.channel === 'exact'),
  );
  const isDenseOnly = !hasLexicalSignal && !hasExactSignal;
  // The `dense_cosine` env override must not silently swallow the lexical leg either — if
  // lexical has signal, route through weighted_rrf regardless of FUSION_METHOD.
  const useDenseCosine = isDenseOnly
    || (FUSION_METHOD === 'dense_cosine' && !hasLexicalSignal && !hasExactSignal);

  if (useDenseCosine) {
    const scored = candidates.map((c) => {
      const denseScore = Math.max(0, Number(c.dense_score ?? c.channel_score ?? 0));
      return {
        ...c,
        fusedScore: denseScore,
        dense_passes_threshold: denseScore >= thresholds.dense_min_score,
      };
    });
    return {
      candidates: scored,
      fusion_method: 'dense_cosine',
      weights: { alpha: 1, beta: 0, delta: 0 },
      thresholds,
      channels_with_signal: hasDenseSignal ? ['dense'] : [],
    };
  }

  const denseRankMap = buildRankMap(
    candidates,
    (c) => Number(c.dense_score ?? 0),
    (c) => Number(c.dense_score ?? 0) > 0,
  );
  const lexicalRankMap = buildRankMap(
    candidates,
    (c) => Number(c.channel_scores?.lexical ?? c.lexical_score
      ?? c.channel_scores?.file_lexical ?? c.file_lexical_score ?? 0),
    (c) => !!(c.channels?.includes('lexical') || c.channels?.includes('file_lexical')),
  );
  // The exact channel found this candidate by matching the query's own token against a
  // declaration name (retrieval-channels.js#retrieveExactChannel). Until now that fact carried
  // ZERO ranking weight: `exact` appeared only in applyFusionThresholds, as permission to
  // survive a filter. A node whose name the question literally contains therefore competed for
  // rank on vector similarity alone.
  //
  // An exact name match is the strongest relevance signal there is for a symbol lookup — "where
  // is TBinaryProtocol.writeI32 implemented" should not rank the definition below whatever the
  // embedding happened to like. This is standard hybrid retrieval: lexical-exact and vector
  // legs both contribute to the ranking, not just to admission.
  const exactRankMap = buildRankMap(
    candidates,
    (c) => Number(c.channel_scores?.exact ?? (c.channel === 'exact' ? c.channel_score : 0) ?? 0),
    (c) => !!(c.channels?.includes('exact') || c.channel === 'exact'),
  );

  const activeWeightSum = (w.alpha > 0 && hasDenseSignal ? w.alpha : 0)
    + (w.delta > 0 && hasLexicalSignal ? w.delta : 0)
    + (w.epsilon > 0 && hasExactSignal ? w.epsilon : 0);

  // weighted_rrf's rawFused is bounded by `1/RRF_K` (~0.01667 at the
  // default K=60), but `thresholds.fusion_min_score` is calibrated on a (0,1] scale meant for
  // the dense_cosine path. Compared directly, nothing ever clears the filter. Option (b) from
  // the slice: scale the threshold down by RRF_K for this fusion method rather than normalizing
  // every fusedScore up — narrower blast radius, and the dense_cosine path (the one that runs
  // today whenever sparse has no signal) is untouched.
  const scaledFusionMinScore = thresholds.fusion_min_score / RRF_K;

  const scored = candidates.map((c, i) => {
    const denseContrib = hasDenseSignal && denseRankMap[i] >= 0
      ? w.alpha * rrfScore([denseRankMap[i]], RRF_K)
      : 0;
    const lexicalContrib = hasLexicalSignal && lexicalRankMap[i] >= 0
      ? (w.delta || 0) * rrfScore([lexicalRankMap[i]], RRF_K)
      : 0;
    const exactContrib = hasExactSignal && exactRankMap[i] >= 0
      ? (w.epsilon || 0) * rrfScore([exactRankMap[i]], RRF_K)
      : 0;

    const rawFused = activeWeightSum > 0
      ? (denseContrib + lexicalContrib + exactContrib) / activeWeightSum
      : 0;

    return {
      ...c,
      fusedScore: rawFused,
      dense_passes_threshold: Number(c.dense_score ?? 0) >= thresholds.dense_min_score,
      fusion_passes_threshold: rawFused >= scaledFusionMinScore,
    };
  });

  const channelsWithSignal = [];
  if (hasDenseSignal) channelsWithSignal.push('dense');
  if (hasLexicalSignal) channelsWithSignal.push('lexical');

  return {
    candidates: scored,
    // Reports the fusion method actually used, not the raw env/FUSION_METHOD value — when
    // FUSION_METHOD=dense_cosine is overridden by a live lexical signal (above), this branch
    // is running weighted_rrf math and must say so, not echo back a stale label.
    fusion_method: 'weighted_rrf',
    weights: w,
    thresholds: { ...thresholds, fusion_min_score: scaledFusionMinScore },
    channels_with_signal: channelsWithSignal,
  };
}

function applyFusionThresholds(candidates, calibration = {}) {
  const thresholds = resolveCalibration(calibration);
  return candidates.filter((c) => {
    const fusionScore = Number(c.fusedScore ?? 0);
    const denseScore = Number(c.dense_score ?? c.channel_score ?? 0);
    if (fusionScore >= thresholds.fusion_min_score) return true;
    if (denseScore >= thresholds.dense_min_score && (c.channels?.includes('exact') || c.channel === 'exact')) {
      return true;
    }
    return false;
  });
}

module.exports = {
  FUSION_METHOD,
  RRF_K,
  readFusionWeights,
  structuralFusionWeights,
  validateFusionWeights,
  resolveCalibration,
  fuseRetrievalCandidates,
  applyFusionThresholds,
  buildRankMap,
};
