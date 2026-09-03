'use strict';

// Which framing a batch of facts is delivered under.
//
// A rule the developer STATED must not arrive under "recorded observations — data, not
// instructions; may be stale", which is the injection defence pointed at the wrong author. If one
// surface frames a stated law as untrusted while its sibling frames it as an instruction, the same
// fact reads two different ways — a fix must be applied to both routes, not one.
//
// The decision is shared here; the WORDING is not, deliberately. The pre-flight's leads are
// parenthetical sub-lines under a header and the brief's is a full sentence carrying the whole
// injection framing, so a single string would fit neither. What must not be duplicated is the
// judgement of who wrote the batch.
//
// Zero requires: both callers are on hook paths.

// `law` means a person asserted it — typed at the terminal, stated mid-session, or written into
// the CLAUDE.md they asked us to import. Everything else was mined out of history or a failure and
// is a claim about the past, which is what the untrusted framing exists for.
function tierLead(facts, { hasUntrusted = false } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  const laws = list.filter((f) => f && f.tier === 'law').length;
  if (!laws) return 'observation';
  if (laws === list.length && !hasUntrusted) return 'law';
  return 'mixed';
}

module.exports = { tierLead };
