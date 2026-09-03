'use strict';

const {
  retrieveAllChannels,
  T1_CHANNELS,
} = require('./retrieval-channels');
const {
  fuseRetrievalCandidates,
  resolveCalibration,
  readFusionWeights,
  structuralFusionWeights,
} = require('./retrieval-fusion');

const DEFAULT_TOP_K = parseInt(process.env.RETRIEVAL_TOP_K || '8', 10);
const DEFAULT_MIN_SCORE = parseFloat(process.env.RETRIEVAL_MIN_SCORE || '0.30');
// The rescue exists because an exact-string hit is trustworthy evidence even when fusion cannot
// score it. A lexical chunk hit with a verified span is the same kind of evidence — leaving it out
// of the rescue means an escalated query whose only hits are lexical returns zero seeds.
const RETRIEVAL_ANCHOR_CHANNELS = (process.env.RETRIEVAL_ANCHOR_CHANNELS || 'exact,lexical')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function buildRetrievalQueryPlan({
  requirementText,
  itemQueryTexts = [],
  intent,
  language,
  risk,
}) {
  const items = Array.isArray(itemQueryTexts) ? itemQueryTexts : [];
  const queries = items.length ? [requirementText, ...items] : [requirementText];
  return {
    queries,
    anchorQuery: requirementText,
    queryCount: queries.length,
    multiQuery: items.length > 0,
    intent: intent || 'default',
    language,
    risk,
  };
}

// Runs fusion + the anchor-channel rescue for one candidate set.
// Extracted so this pipeline can run twice — once on T1 candidates, once on the
// T1+T2(lexical) merged set — without duplicating the scoring/threshold logic.
async function fuseAndSelectSeeds(candidates, { calibration, threshold, topK }) {
  if (!candidates.length) {
    return { seeds: [], fusionResult: { candidates: [], fusion_method: null, weights: null, thresholds: null } };
  }

  const fusionResult = fuseRetrievalCandidates(candidates, {
    calibration,
    weights: structuralFusionWeights(),
  });

  // In `weighted_rrf` the max achievable fusedScore is `1/RRF_K`
  // (~0.01667), while `fusion_min_score` is calibrated as if fusedScore were in (0,1] on the
  // same scale as the dense_cosine path. Comparing the two directly rejects every candidate.
  // `fuseRetrievalCandidates` already returns a scale-corrected `thresholds.fusion_min_score`
  // for whichever method it actually ran (isDenseOnly can pick dense_cosine even when
  // RETRIEVAL_FUSION_METHOD=weighted_rrf), so read it from there rather than re-deriving it here.
  const effectiveThreshold = fusionResult.thresholds?.fusion_min_score ?? threshold;

  let seeds = [...fusionResult.candidates]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .filter((c) => c.fusedScore >= effectiveThreshold)
    .slice(0, topK);

  if (!seeds.length) {
    // Rescue on membership in the anchor-channel set (default exact,lexical), not just 'exact'. An
    // exact-string hit and a lexical chunk hit with a verified span are the same kind of
    // trustworthy evidence when fusion cannot score them.
    const exact = candidates.filter((c) => (
      c.channels?.some((ch) => RETRIEVAL_ANCHOR_CHANNELS.includes(ch))
      || RETRIEVAL_ANCHOR_CHANNELS.includes(c.channel)
    ));
    if (exact.length) {
      const floor = Math.max(threshold, calibration.dense_min_score ?? DEFAULT_MIN_SCORE, 0.34);
      seeds = exact.map((c) => ({ ...c, fusedScore: floor })).slice(0, topK);
    }
  }

  return { seeds, fusionResult, effectiveThreshold };
}

async function retrieveChannelSeeds({
  queryText,
  branchIds,
  activeGenerationIds = [],
  scopedBranchIds = null,
  topK = DEFAULT_TOP_K,
  intent,
  language,
  risk,
  fusionMinScore,
  channels,
}) {
  const branchScope = scopedBranchIds?.length ? scopedBranchIds : branchIds;
  const candidateBound = parseInt(process.env.RETRIEVAL_CHANNEL_CANDIDATE_BOUND || '1000', 10);
  // Explicit T1_CHANNELS, never the bare ALL_CHANNELS default — adding a channel to ALL_CHANNELS
  // must never silently change what an un-escalated T1 pass runs. A caller that passes `channels`
  // explicitly is unaffected — this only changes the *default*.
  const channelResult = await retrieveAllChannels({
    queryText,
    branchIds,
    activeGenerationIds,
    scopedBranchIds: branchScope,
    channels: channels || T1_CHANNELS,
    candidateBound,
    intent,
    language,
    risk,
  });

  const candidates = channelResult.candidates || [];
  const channelStats = channelResult.channel_stats || [];

  const calibration = channelResult.fusion_calibration || resolveCalibration({ intent, language, risk });
  const threshold = fusionMinScore ?? calibration.fusion_min_score ?? DEFAULT_MIN_SCORE;

  const { seeds, fusionResult, effectiveThreshold } = await fuseAndSelectSeeds(candidates, {
    calibration,
    threshold,
    topK,
  });

  // The router runs on the T1 result actually about to be returned (the accepted `seeds`, not the
  // raw unfiltered candidate pool) — that is the evidence set the rest of the system will see if we
  // do not escalate.
  // The lexical channel is a T1 channel here, not a T2 escalation: with dense and sparse gone it
  // is the only channel that can reach a body identifier the declaration index does not name. A
  // T2 pass would re-run the identical query and merge it with itself. Recorded explicitly rather
  // than silently skipped, so an artifact still shows why nothing escalated.
  const escalation = {
    escalated: false,
    reason: 'lexical_already_in_t1',
    tier: 'T1',
    sufficiency_score: null,
    t1_candidate_count: candidates.length,
    t2_candidate_count: 0,
    t2_latency_ms: 0,
  };

  const seedIds = new Set(seeds.map((s) => s.id));
  const rejected_candidates = collectRejectedCandidates(candidates, seedIds, effectiveThreshold ?? threshold, topK);

  const fusionTrace = fusionResult.fusion_method ? {
    fusion_method: fusionResult.fusion_method,
    weights: fusionResult.weights || readFusionWeights(),
    thresholds: fusionResult.thresholds,
    executed_channels: channelStats.filter((s) => s.status === 'executed').map((s) => s.channel),
  } : null;

  return {
    seeds,
    rejected_candidates,
    channel_stats: channelStats,
    fusion_trace: fusionTrace,
    candidates,
    escalation,
  };
}

function collectRejectedCandidates(candidates, seedIds, fusionMinScore, topK) {
  const rejected = [];
  const sorted = [...candidates].sort(
    (a, b) => Number(b.fusedScore ?? b.dense_score ?? 0) - Number(a.fusedScore ?? a.dense_score ?? 0),
  );

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (seedIds.has(c.id)) continue;

    const score = Number(c.fusedScore ?? c.dense_score ?? c.channel_score ?? 0);
    let reason = 'below_threshold';
    if (score < fusionMinScore) {
      reason = 'below_threshold';
    } else if (i >= topK) {
      reason = 'truncated_top_k';
    } else {
      reason = 'not_selected';
    }

    rejected.push({
      node_id: c.id,
      name: c.name,
      node_type: c.node_type,
      score: Math.round(score * 10000) / 10000,
      channels: c.channels || (c.channel ? [c.channel] : []),
      reject_reason: reason,
    });
  }

  return rejected;
}

async function executeMultiQueryPlan({
  plan,
  branchIds,
  activeGenerationIds,
  topKPerQuery,
  scopeBranchIds,
}) {
  const perQueryResults = await Promise.all(
    plan.queries.map((q, i) => retrieveChannelSeeds({
      queryText: q,
      branchIds,
      activeGenerationIds,
      scopedBranchIds: scopeBranchIds,
      topK: topKPerQuery?.[i] ?? DEFAULT_TOP_K,
      intent: plan.intent,
      language: plan.language,
      risk: plan.risk,
    })),
  );

  const seedMap = new Map();
  const rejected = [];
  for (const result of perQueryResults) {
    for (const seed of result.seeds) {
      const existing = seedMap.get(seed.id);
      if (!existing || seed.fusedScore > existing.fusedScore) {
        seedMap.set(seed.id, seed);
      }
    }
    rejected.push(...result.rejected_candidates);
  }

  const seeds = [...seedMap.values()].sort((a, b) => b.fusedScore - a.fusedScore);
  seeds._channelStats = perQueryResults[0]?.channel_stats || [];
  seeds._fusionTrace = perQueryResults[0]?.fusion_trace || null;
  seeds._rejected_candidates = rejected;

  // An aggregate across ALL per-query results, not just [0] — a multi-query plan can escalate on
  // item query 3 and not on the anchor query, and escalation_rate is a per-query statistic that
  // needs that per-query detail preserved, not collapsed to the anchor.
  const perQueryEscalations = perQueryResults.map((r) => r.escalation).filter(Boolean);
  const anyEscalated = perQueryEscalations.some((e) => e.escalated);
  // `reason` is a single representative value (the first escalated query's reason, or the first
  // query's reason if none escalated) so a caller reading `_escalation.reason` on the multi-query
  // path sees the same shape as the single-query path; `reasons` keeps the full per-query detail.
  const escalation = perQueryEscalations.length ? {
    escalated: anyEscalated,
    reason: (anyEscalated
      ? perQueryEscalations.find((e) => e.escalated)?.reason
      : perQueryEscalations[0]?.reason) || null,
    escalated_count: perQueryEscalations.filter((e) => e.escalated).length,
    query_count: perQueryEscalations.length,
    reasons: [...new Set(perQueryEscalations.map((e) => e.reason))],
    per_query: perQueryEscalations,
  } : null;
  seeds._escalation = escalation;

  return {
    seeds,
    rejected_candidates: rejected,
    channel_stats: perQueryResults[0]?.channel_stats || [],
    fusion_trace: perQueryResults[0]?.fusion_trace || null,
    escalation,
    resolvedRepoIds,
  };
}

module.exports = {
  buildRetrievalQueryPlan,
  retrieveChannelSeeds,
  collectRejectedCandidates,
  executeMultiQueryPlan,
};
