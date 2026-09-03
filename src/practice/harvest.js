'use strict';

const { runFailFix, signatureCounts, IDLE_MS } = require('./fail-fix');

// The step nothing called. `facts` held 0 rows over 2,403 captured events for two independent
// reasons: the matcher emitted nothing (fixed in fail-fix.js) and no code ever ran the promotion
// chain. This is the second one.
//
// `promote.js` is A5's and is soft-required at CALL time, not at load time: this module sits on the
// SessionEnd/Stop hook path, and a top-level require of the promoter drags `resolve.js` — the one
// module that opens graph.db — into the hook's require graph. There is a test for that.

// A failure armed in the previous turn has to stay visible to a pass that arrives in this one, so
// the recently-harvested tail is deliberately re-read. Identity, not `harvested_at`, is what stops
// the re-read producing a duplicate fact.
const REPLAY_MS = IDLE_MS;

function lessonKey(lesson) {
  const ids = [...new Set(lesson.targets.flatMap(
    (t) => [t.attempt, t.fix].filter(Boolean).map((c) => c.tool_use_id || ''),
  ))].sort().join(',');
  return [
    lesson.session_id || '', lesson.agent_id || '', lesson.signature || lesson.body || '',
    lesson.failed_at || '', ids,
  ].join('\x00');
}

function selectEvents(practiceDb, { sessionId, agentId, replayFrom }) {
  const where = ['(harvested_at IS NULL OR ts >= @replayFrom)'];
  if (sessionId) where.push('session_id = @sessionId');
  // A NULL agent_id is the main loop and is a scope of its own, so `agentId: null` cannot mean
  // "every agent" — the caller says that by leaving it undefined.
  if (agentId !== undefined) where.push(agentId === null ? 'agent_id IS NULL' : 'agent_id = @agentId');
  return practiceDb.prepare(
    `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ts, id`,
  ).all({ sessionId: sessionId || null, agentId: agentId === undefined ? null : agentId, replayFrom });
}

function harvestSession(practiceDb, graphDb, {
  sessionId = null, agentId = undefined, now = new Date(), replayMs = REPLAY_MS,
} = {}) {
  const replayFrom = new Date(now.getTime() - replayMs).toISOString();
  const events = selectEvents(practiceDb, { sessionId, agentId, replayFrom });
  if (!events.length) return { lessons: 0, factIds: [] };

  // Recurrence is counted over the WHOLE store, not over the harvested slice: "you hit this same
  // issue last week" is the claim, and a slice that starts today cannot make it.
  const counts = signatureCounts(
    practiceDb.prepare("SELECT repo_id, session_id, agent_id, ts, cmd, err_excerpt, event_type FROM events WHERE event_type = 'cmd_fail'").all(),
  );

  const candidates = runFailFix(events, { counts });
  const seen = practiceDb.prepare('SELECT 1 FROM harvested_lessons WHERE lesson_key = ?');
  const fresh = candidates.filter((l) => !seen.get(lessonKey(l)));

  let factIds = [];
  if (fresh.length) {
    let promoteLessons = null;
    try { ({ promoteLessons } = require('./promote')); } catch { /* not available: capture still stands */ }
    if (promoteLessons) ({ factIds } = promoteLessons(practiceDb, graphDb, fresh, { now, source: 'harvest' }));
  }

  const stamp = now.toISOString();
  const markLesson = practiceDb.prepare(
    'INSERT OR IGNORE INTO harvested_lessons (lesson_key, session_id, agent_id, fact_id, created_at) VALUES (?,?,?,?,?)',
  );
  const markEvent = practiceDb.prepare('UPDATE events SET harvested_at = ? WHERE id = ? AND harvested_at IS NULL');
  // promoteLessons drops a lesson whose targets resolve to no anchor at all, so the id list is
  // positional only when nothing was dropped. Guessing an alignment would file a lesson under
  // another lesson's fact.
  const aligned = factIds.length === fresh.length;
  practiceDb.transaction(() => {
    fresh.forEach((l, i) => markLesson.run(lessonKey(l), l.session_id || '', l.agent_id || null, aligned ? factIds[i] : null, stamp));
    for (const e of events) markEvent.run(stamp, e.id);
  })();

  return { lessons: fresh.length, factIds };
}

module.exports = { harvestSession, lessonKey, REPLAY_MS };
