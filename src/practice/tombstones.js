'use strict';

const path = require('path');

const {
  classifyFailure, signatureCounts, groupEditCalls, scopeKey, weighLesson,
  revertsAnything, recordRemoved, REPO_GRAIN,
} = require('./fail-fix');
const { commandShape } = require('./event-extract');
const { isSourcePath } = require('./source-paths');
const { quoted, safePath, truncate, redactSecrets } = require('./untrusted');

// The other half of a two-hour debug. fail-fix.js records the edit that finally worked; the two
// hours went into approaches A, B, C that were tried and backed out, and those are what stop the
// next agent starting at A. Nothing in the store records them, so this does.
//
// Offline over `events`, for the same reason fail-fix.js is: a rule change here has to be
// replayable over what has already been captured rather than losing the data with the bug.
//
// Three sources, all mechanical — nothing here infers, so precision is structural:
//   1 revert      an edit whose content this scope had already removed came back (the approach
//                 that was standing when it came back is the one that was thrown away)
//   2 dead command   a command SHAPE that failed 2+ times with one error signature and never
//                 passed again in the scope
//   3 abandoned file   episode_files.survived = 0 — edited and reverted inside one turn

const KIND = 'tombstone';
const TIER = 'observation';
const BODY_MAX = 200;
const SNIPPET_MAX = 56;
const WHY_MAX = 72;
const SHAPE_MAX = 48;

// Leading `NAME=value` tokens, which a shell applies as environment for one command. redactSecrets
// already removes the VALUE, but the NAME is worth dropping too — it is the posture the shape gave
// us for free, and `API_KEY=«redacted» npm test` tells a reader nothing `npm test` does not.
const LEADING_ENV = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

// The shape decides GROUPING; this decides what the reader is shown. `commandShape` collapses
// `npm run build` to `npm run`, which is right for counting one approach across its invocations
// and useless in a sentence — "npm run has been abandoned" is true of every script in the
// repository. Falls back to the shape when no raw command was recorded.
function commandForReader(group) {
  const raw = group.failure && group.failure.cmd ? String(group.failure.cmd) : '';
  const stripped = redactSecrets(raw).replace(LEADING_ENV, '').trim();
  return stripped || group.shape;
}
const PROMPT_MAX = 56;
// Once is a correction, not an abandonment. Two is the first count at which "we kept trying this
// and it kept not working" is a statement about the repository rather than about one keystroke.
const MIN_FAILS = 2;

function ms(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

// Same rule as fail-fix.js#inRepo: `relativise` hands back an ABSOLUTE path for a file outside the
// checkout (a scratchpad probe), and anchoring a fact to one files it under a path the repo has
// never contained. `isSourcePath` is the second half — a markdown note or a lockfile reverted is
// not an approach anybody abandoned.
function anchorable(filePath) {
  return !!filePath && !path.isAbsolute(filePath) && isSourcePath(filePath);
}

// The abandoned lines themselves, out of the reverting hunk's PRE-edit side. That side is the
// approach as it stood the moment it was discarded, which is the only rendering of it that exists
// anywhere — the file no longer holds it and neither does git.
function abandonedText(call, fingerprint) {
  for (const h of call.hunks || []) {
    if (h.old_fingerprint !== fingerprint || !h.payload) continue;
    try {
      const p = JSON.parse(h.payload);
      const text = (p.old || []).join(' ').trim();
      if (text) return text;
    } catch { /* a trimmed payload is not a failure */ }
  }
  return '';
}

function rangeOf(call) {
  let start = null;
  let end = null;
  for (const h of call.hunks || []) {
    if (h.new_start == null) continue;
    const s = h.new_start;
    const e = h.new_start + Math.max(1, h.new_lines || 1) - 1;
    if (start === null || s < start) start = s;
    if (end === null || e > end) end = e;
  }
  return { start, end };
}

// `<what>. <why>.` — an instruction to the next agent, not a diary entry. Everything interpolated
// came out of a command line, a compiler's stderr or a user prompt, so every one of them goes
// through the untrusted layer: this store is durable, and a command carries inlined environment
// secrets often enough that redaction at render is not optional.
function composeBody(what, why) {
  const tail = why ? ` It failed with ${why}.` : '';
  return truncate(`Tried and abandoned: ${what}.${tail}`, BODY_MAX);
}

function whyOf(failure) {
  return failure && failure.body ? quoted(failure.body, WHY_MAX) : '';
}

// Weighing is fail-fix.js's `weighLesson`, unchanged and deliberately not a second scale: a
// tombstone and a correction end up in the same ranked list in front of the same reader, and two
// scales would make "this cost more to learn" mean two different things in one digest. The mapping
// is the only new part — attempts become `occurrences`, the discarded approaches become
// `abandonments`, and the span between the first attempt and the abandonment becomes `elapsedMs`.
function weighTombstone({ counts, repoId, signature, attempts, abandonments, turns, elapsedMs }) {
  const seen = signature ? counts.get(`${repoId || ''}\x00${signature}`) : null;
  return weighLesson({
    sessions: seen ? seen.sessions.size : 1,
    scopes: seen ? seen.scopes.size : 1,
    occurrences: Math.max(seen ? seen.count : 1, attempts || 1),
    turns: Math.max(0, turns || 0),
    elapsedMs: Math.max(0, elapsedMs || 0),
    abandonments: Math.max(0, abandonments || 0),
    workaround: false,
  });
}

function lessonOf({
  source, body, targets, repoId, sessionId, agentId, startedAt, abandonedAt,
  failure, shape, cmd, attempts, weight, reasons, evidence,
}) {
  return {
    kind: KIND,
    tier: TIER,
    source: source || 'harvest',
    matched_by: evidence.tombstone_source,
    grain: targets.some((t) => t.start_line != null) ? 'symbol' : 'file',
    session_id: sessionId || null,
    agent_id: agentId || null,
    repo_id: repoId || null,
    // Redacted again on the way out even though event-extract.js redacts at capture: this miner
    // also runs over replayed and imported rows that never passed through the recorder, and
    // practice.db is durable — a secret written into it is written forever.
    cmd: cmd ? redactSecrets(cmd) : null,
    normalised_cmd: shape || null,
    err_excerpt: failure ? redactSecrets(failure.detail || '') : '',
    error_family: failure ? failure.family : null,
    signature: failure ? failure.signature : null,
    body,
    detail: failure ? redactSecrets(failure.detail || '') : '',
    recurrence: Math.max(1, attempts || 1),
    weight,
    weight_reasons: reasons,
    failed_at: startedAt || null,
    // promote.js writes `valid_at` from `passed_at` — "when this became true of the code". For a
    // tombstone that moment is the abandonment, not a pass; nothing passed.
    passed_at: abandonedAt || null,
    targets,
    evidence,
  };
}

// ─── 1 · reverts ────────────────────────────────────────────────────────────────────────────────

function mineReverts(scoped, { counts, lessons, claimed }) {
  const removed = new Map();          // file -> Set(fingerprints this scope has deleted)
  const introduced = new Map();       // file -> Map(fingerprint -> the call that wrote it)
  const editsOn = new Map();          // file -> [call]
  let failure = null;                 // the most recent code-class failure standing over this scope
  let step = 0;

  for (const item of groupEditCalls(scoped)) {
    step += 1;

    if (item.kind !== 'edit') {
      const e = item.event;
      if (e.event_type === 'cmd_fail') {
        const c = classifyFailure(e.err_excerpt, { cmd: e.cmd });
        // Same refusal fail-fix.js makes: a harness notice, a timeout or a missing scratchpad path
        // is not evidence about anybody's code, so it never becomes the "why" of a tombstone.
        if (c.class === 'code') failure = { ...c, ts: e.ts };
      } else if (e.event_type === 'cmd_pass') {
        failure = null;
      }
      continue;
    }

    const call = item.call;
    call.step = step;

    if (revertsAnything(call, removed) && anchorable(call.file_path)) {
      const seen = removed.get(call.file_path);
      const hunk = call.hunks.find((h) => h.new_fingerprint && seen.has(h.new_fingerprint));
      const discarded = hunk ? hunk.old_fingerprint : null;
      const intro = discarded ? (introduced.get(call.file_path) || new Map()).get(discarded) : null;

      const snippet = discarded ? abandonedText(call, discarded) : '';
      const what = snippet
        ? `an edit to ${safePath(call.file_path)} — ${quoted(snippet, SNIPPET_MAX)} — put back`
        : `an edit to ${safePath(call.file_path)}, put back`;

      const startedAt = intro ? intro.ts : call.ts;
      const history = editsOn.get(call.file_path) || [];
      const introStep = intro ? intro.step : call.step;
      const attempts = Math.max(1, history.filter((c) => c.step >= introStep).length);
      const { start, end } = rangeOf(call);
      const { weight, reasons } = weighTombstone({
        counts,
        repoId: call.repo_id,
        signature: failure ? failure.signature : null,
        attempts,
        abandonments: attempts,
        turns: call.step - introStep,
        elapsedMs: ms(call.ts) - ms(startedAt),
      });

      claimed.add(`${call.repo_id || ''}\x00${call.file_path}`);
      lessons.push(lessonOf({
        body: composeBody(what, whyOf(failure)),
        targets: [{
          repo_id: call.repo_id,
          file_path: call.file_path,
          start_line: start,
          end_line: end,
          // The reverting call IS the delta: its old side is the approach, its new side is what the
          // code went back to. promote.js reads the range and the abs path off `fix`.
          attempt: intro || null,
          fix: call,
        }],
        repoId: call.repo_id,
        sessionId: call.hunks[0].session_id,
        agentId: call.hunks[0].agent_id,
        startedAt,
        abandonedAt: call.ts,
        failure,
        shape: null,
        cmd: failure ? failure.cmd : null,
        attempts,
        weight,
        reasons,
        evidence: {
          tombstone_source: 'revert',
          abandoned_at: call.ts,
          abandoned_fingerprint: discarded,
          restored_fingerprint: hunk ? hunk.new_fingerprint : null,
          attempts,
          span_ms: Math.max(0, ms(call.ts) - ms(startedAt)),
        },
      }));
    }

    recordRemoved(call, removed);
    let prints = introduced.get(call.file_path);
    if (!prints) { prints = new Map(); introduced.set(call.file_path, prints); }
    for (const h of call.hunks) if (h.new_fingerprint) prints.set(h.new_fingerprint, call);
    let history = editsOn.get(call.file_path);
    if (!history) { history = []; editsOn.set(call.file_path, history); }
    history.push(call);
  }
}

// ─── 2 · dead commands ──────────────────────────────────────────────────────────────────────────

function mineDeadCommands(scoped, { counts, lessons }) {
  const groups = new Map();
  const passes = new Map();           // shape -> [step]
  let step = 0;

  for (const e of scoped) {
    step += 1;
    if (e.event_type !== 'cmd_fail' && e.event_type !== 'cmd_pass') continue;
    if (!e.cmd) continue;
    const shape = commandShape(e.cmd);
    if (!shape) continue;

    if (e.event_type === 'cmd_pass') {
      if (!passes.has(shape)) passes.set(shape, []);
      passes.get(shape).push(step);
      continue;
    }

    const c = classifyFailure(e.err_excerpt, { cmd: e.cmd });
    if (c.class !== 'code') continue;
    const key = `${shape}\x00${c.signature}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        shape, failure: c, repo_id: e.repo_id, session_id: e.session_id, agent_id: e.agent_id,
        first_step: step, last_step: step, first_ts: e.ts, last_ts: e.ts, attempts: 0,
      };
      groups.set(key, g);
    }
    g.attempts += 1;
    g.last_step = step;
    g.last_ts = e.ts;
    g.repo_id = g.repo_id || e.repo_id;
  }

  for (const g of groups.values()) {
    if (g.attempts < MIN_FAILS) continue;
    // A pass of the same shape after the first failure is a fail→fix lesson and fail-fix.js already
    // owns it. Emitting a tombstone here too would double-count one stretch of work as both "this
    // was solved" and "this was given up on".
    if ((passes.get(g.shape) || []).some((s) => s > g.first_step)) continue;
    // anchors.repo_id is NOT NULL, and a tombstone with nowhere to live is not a fact.
    if (!g.repo_id) continue;

    const { weight, reasons } = weighTombstone({
      counts,
      repoId: g.repo_id,
      signature: g.failure.signature,
      attempts: g.attempts,
      abandonments: g.attempts - 1,
      turns: g.last_step - g.first_step,
      elapsedMs: ms(g.last_ts) - ms(g.first_ts),
    });

    // The shape decides GROUPING; the body names the command the reader will actually type.
    // `commandShape` collapses `npm run build` to `npm run`, which is right for counting one
    // approach across its invocations and useless in a sentence — "npm run has been abandoned" is
    // true of every script in the repository and tells the reader nothing. The raw command is
    // redacted and quoted like any other captured string; the shape is not sanitisation and never
    // was, so nothing is lost by preferring the specific form when one was recorded.
    const shown = commandForReader(g);
    const what = `${quoted(shown, SHAPE_MAX)}, which failed ${g.attempts} times and never passed`;

    lessons.push(lessonOf({
      body: composeBody(what, whyOf(g.failure)),
      targets: [{
        // The honest coordinate for "this happens while working in this repo" (fail-fix.js#REPO_GRAIN).
        // Mining a filename out of the command text manufactures an identity — see §Traps.
        repo_id: g.repo_id,
        file_path: REPO_GRAIN,
        start_line: null,
        end_line: null,
        attempt: null,
        fix: null,
      }],
      repoId: g.repo_id,
      sessionId: g.session_id,
      agentId: g.agent_id,
      startedAt: g.first_ts,
      abandonedAt: g.last_ts,
      failure: g.failure,
      shape: g.shape,
      cmd: g.failure.cmd,
      attempts: g.attempts,
      weight,
      reasons,
      evidence: {
        tombstone_source: 'dead_command',
        abandoned_at: g.last_ts,
        shape: g.shape,
        attempts: g.attempts,
        span_ms: Math.max(0, ms(g.last_ts) - ms(g.first_ts)),
      },
    }));
  }
}

// ─── 3 · abandoned files ────────────────────────────────────────────────────────────────────────

// Accepts either episodes carrying their `files`, or a flat list of `episode_files` rows. Both are
// how the table is read back in practice and neither may crash the other's path.
function episodeRows(episodes) {
  const out = [];
  for (const ep of episodes || []) {
    if (!ep) continue;
    const files = Array.isArray(ep.files) ? ep.files : (ep.file_path ? [ep] : []);
    for (const f of files) if (f) out.push({ file: f, episode: ep });
  }
  return out;
}

function mineAbandonedFiles(episodes, { counts, lessons, claimed }) {
  for (const { file, episode } of episodeRows(episodes)) {
    // `survived` is 1 kept, 0 reverted, NULL "we could not check". NULL must never read as a
    // negative, so the comparison is explicit rather than falsy.
    if (file.survived === null || file.survived === undefined) continue;
    if (Number(file.survived) !== 0) continue;
    if (!anchorable(file.file_path)) continue;
    const repoId = file.repo_id || episode.repo_id || null;
    if (!repoId) continue;
    // The revert miner saw the same retreat with a line range and the discarded lines attached.
    if (claimed.has(`${repoId}\x00${file.file_path}`)) continue;

    const edits = Math.max(1, Number(file.edits) || 1);
    const { weight, reasons } = weighTombstone({
      counts,
      repoId,
      signature: null,
      attempts: edits,
      abandonments: 1,
      turns: edits,
      elapsedMs: ms(episode.closed_at) - ms(episode.opened_at),
    });

    // The prompt is the label that makes this usable — "while doing X, this file was tried and
    // backed out" — and it is the most sensitive column in the store, so it arrives bounded and
    // quoted like every other borrowed string here.
    const task = episode.prompt ? ` while working on ${quoted(episode.prompt, PROMPT_MAX)}` : '';
    const what = `an edit to ${safePath(file.file_path)}, reverted before the turn ended${task}`;

    lessons.push(lessonOf({
      body: composeBody(what, ''),
      targets: [{
        repo_id: repoId,
        file_path: file.file_path,
        start_line: null,
        end_line: null,
        attempt: null,
        fix: null,
      }],
      repoId,
      sessionId: episode.session_id,
      agentId: episode.agent_id,
      startedAt: episode.opened_at,
      abandonedAt: episode.closed_at || episode.opened_at,
      failure: null,
      shape: null,
      cmd: null,
      attempts: edits,
      weight,
      reasons,
      evidence: {
        tombstone_source: 'abandoned_file',
        abandoned_at: episode.closed_at || episode.opened_at,
        episode_id: episode.id ?? null,
        edits,
        span_ms: Math.max(0, ms(episode.closed_at) - ms(episode.opened_at)),
      },
    }));
  }
}

// ─── entry point ────────────────────────────────────────────────────────────────────────────────

function mineTombstones(events, opts = {}) {
  const rows = Array.isArray(events) ? events : [];
  const counts = opts.counts || signatureCounts(rows);
  const lessons = [];
  const claimed = new Set();

  const byScope = new Map();
  for (const e of rows) {
    const k = scopeKey(e);
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push(e);
  }

  for (const [, scoped] of byScope) {
    scoped.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id || 0) - (b.id || 0)));
    mineReverts(scoped, { counts, lessons, claimed });
    mineDeadCommands(scoped, { counts, lessons });
  }

  mineAbandonedFiles(opts.episodes, { counts, lessons, claimed });

  lessons.sort((a, b) => (a.passed_at < b.passed_at ? -1 : a.passed_at > b.passed_at ? 1
    : a.body.localeCompare(b.body)));
  return lessons;
}

module.exports = {
  mineTombstones, mineReverts, mineDeadCommands, mineAbandonedFiles,
  KIND, TIER, BODY_MAX, MIN_FAILS,
};
