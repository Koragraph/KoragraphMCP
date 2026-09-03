'use strict';

// One graph, projected differently depending on what the developer is doing.
//
// Every competitor retrieves the same way whatever the task is. Zimmermann et al. (IEEE TSE 31(6)
// 2005, >100k transactions over eight programs) measured the size of the opportunity on one axis
// of this: restricting evolutionary coupling to maintenance transactions almost doubled recall to
// 44% with precision roughly unchanged. `bugfix` is where that lands here.
//
// `unknown` is not a degraded mode — it is today's default projection, unchanged, so a caller
// that is not sure what it's doing (or omits task_type entirely) costs exactly nothing.

const { TRAVERSAL_EDGE_TYPES } = require('./graph-vocabulary');
const { resolveExpansionHopLimit } = require('./graph-expansion-policy');

const TASK_TYPES = Object.freeze(['bugfix', 'feature', 'refactor', 'config', 'unknown']);

const DEFAULT_WEIGHTS = Object.freeze({
  exact: 1, lexical: 1, graph: 1, cochange: 1, test: 1,
});

const CONFIG_EDGE_TYPES = Object.freeze([
  'USES_CONFIG', 'READS_TABLE', 'WRITES_TABLE', 'DEPENDS_ON', 'MAPS_TO',
  'CONTAINS', 'DEFINED_IN', 'BELONGS_TO', 'CALLS',
]);

const TEMPLATES = Object.freeze({
  // Tight depth, maintenance-conditioned coupling, and the practice layer's own record of what
  // broke here before. Depth 1 because a bugfix answer that walks two hops is mostly noise: the
  // fix lives at the seed or one edge from it.
  bugfix: {
    edgeTypes: [...TRAVERSAL_EDGE_TYPES, 'CO_CHANGES'],
    includeCochange: true,
    includeHeuristic: false,
    depth: 1,
    weights: { ...DEFAULT_WEIGHTS, cochange: 1.4, test: 1.3, lexical: 1.2 },
    cochangeChangeTypes: ['alter'],
    includePractice: true,
    practiceKinds: ['correction', 'revert', 'hazard'],
  },
  // The edge set is the default one; what changes is where the weight sits. A feature question is
  // answered by analogous implementations and the module's public surface, which the lexical and
  // containment planes carry — co-change carries nothing, because code that does not exist yet has
  // no history.
  feature: {
    edgeTypes: [...TRAVERSAL_EDGE_TYPES],
    includeCochange: false,
    includeHeuristic: false,
    depth: 2,
    weights: { ...DEFAULT_WEIGHTS, lexical: 1.3, graph: 1.1, cochange: 0 },
    cochangeChangeTypes: null,
    includePractice: true,
    practiceKinds: ['ritual', 'law'],
  },
  // Over-approximate deliberately: a missed caller is worse than an extra one, which is why the
  // guess-grade CALLS split is admitted here and nowhere else.
  //
  // Co-change stays OUT. `CO_CHANGES` is statistical co-occurrence with no structural claim
  // attached, and the refactor question is literally "who calls this" — a co-change neighbour
  // presented in that answer would be a false caller.
  refactor: {
    edgeTypes: [...TRAVERSAL_EDGE_TYPES, 'HEURISTIC_CALLS'],
    includeCochange: false,
    includeHeuristic: true,
    depth: 3,
    weights: { ...DEFAULT_WEIGHTS, graph: 1.4, test: 1.2, cochange: 0 },
    cochangeChangeTypes: null,
    includePractice: true,
    practiceKinds: ['hazard', 'law'],
  },
  config: {
    edgeTypes: [...CONFIG_EDGE_TYPES],
    includeCochange: false,
    includeHeuristic: false,
    depth: 2,
    weights: { ...DEFAULT_WEIGHTS, exact: 1.3, graph: 1.2, cochange: 0 },
    cochangeChangeTypes: null,
    includePractice: true,
    practiceKinds: ['ritual', 'hazard'],
  },
  unknown: {
    edgeTypes: [...TRAVERSAL_EDGE_TYPES],
    includeCochange: false,
    includeHeuristic: false,
    depth: resolveExpansionHopLimit(undefined),
    weights: { ...DEFAULT_WEIGHTS },
    cochangeChangeTypes: null,
    includePractice: false,
    practiceKinds: [],
  },
});

// An unmapped value throws rather than defaulting (resolution/tiers.js:242-248 is the precedent):
// silently projecting an unrecognised task type onto the default plane would hide a caller bug
// behind an answer that looks fine. Absence is different from a wrong value and maps to `unknown`.
function policyFor(taskType) {
  const key = taskType == null || taskType === '' ? 'unknown' : taskType;
  const template = TEMPLATES[key];
  if (!template) {
    throw new Error(`retrieval-policy: unknown task type '${taskType}' (expected one of ${TASK_TYPES.join(', ')})`);
  }
  return {
    ...template,
    edgeTypes: [...template.edgeTypes],
    weights: { ...template.weights },
    cochangeChangeTypes: template.cochangeChangeTypes ? [...template.cochangeChangeTypes] : null,
    practiceKinds: [...template.practiceKinds],
  };
}

module.exports = {
  policyFor,
  TASK_TYPES,
  DEFAULT_WEIGHTS,
  CONFIG_EDGE_TYPES,
};
