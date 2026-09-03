'use strict';

const path = require('path');

const { commandShape } = require('./event-extract');
const { isSourcePath } = require('./source-paths');

// Fail→fix distillation, offline over `events`.
//
// Offline rather than in the hook on purpose: the hook has a 5 s budget and one job, and a rule
// change here has to be replayable over events already captured rather than losing the data
// along with the bug.
//
// The obvious rule — "cmd_fail(C) … cmd_pass(C) with the SAME C" — extracts almost nothing: agent
// commands are nearly all unique strings, because an agent writes a new heredoc, a new `node -e`, a
// new scratchpad path every time. Exact command identity is a human developer's test loop, not an
// agent's.
//
// What replaces it is error-signature disappearance. Arm on a failure whose signature is about the
// CODE; after at least one intervening edit, take a pass from a command of the same SHAPE as
// proof the signature is gone. Shape (`npx vitest`, `node -e`, `go test`) is the primary key; a
// pass of any shape is a weaker rule that yields `hypothesis`, which no reader ever sees.

const IDLE_MS = 30 * 60 * 1000;
const BODY_MAX = 60;
const DETAIL_MAX = 600;
const SIGNATURE_MAX = 160;

// ─── failure classification ─────────────────────────────────────────────────────────────────────
//
// A failure is only a lesson if it is about the code. Many captured failures are harness notices
// ("This agent is isolated in the worktree …") or a bare "Exit code 1"; promoting either would put
// a fact in front of a reader that teaches nothing about their repository, and a wrong memory is
// worse than no memory. So the first job here is refusal, not extraction.

// Checked BEFORE the code rules, and the order is load-bearing: a timed-out `npx vitest` prints
// real test failures on the way to being killed, and in that case the environment is the reason.
const ENV_RULES = [
  ['worktree_isolation', /is isolated in the worktree/],
  ['interrupt', /\b(?:Command was interrupted|user (?:aborted|interrupted)|SIGINT|KeyboardInterrupt)\b/],
  ['timeout', /\b(?:Command timed out after|timed out after \d|ETIMEDOUT|Timeout of \d+ms exceeded)\b/i],
  ['oom', /\b(?:JavaScript heap out of memory|ENOMEM|Cannot allocate memory|Killed: 9|out of memory)\b/i],
  ['missing_path', /\bno such file or directory\b/i],
  // The second alternative is the zsh form (`(eval):1: ==== not found`). Anchored on the shell's
  // own `source:line:` prefix so an assertion message ending in "not found" cannot be swallowed.
  ['command_not_found', /(?:\bcommand not found\b|^(?:\(eval\)|\S+):\s*(?:\d+:\s*)?\S+ not found\s*$|is not recognized as an internal)/],
  ['shell_syntax', /\b(?:parse error near|no matches found|unmatched|bad pattern|unexpected EOF while looking for)\b/],
  ['tool_usage', /^\s*(?:sed|awk|grep|ugrep|find|xargs|tar|curl|jq|git|ls|cat|tail|head):\s*(?:\d+:\s*)?(?:error|invalid|unknown|unrecognized|usage)/im],
  ['permission', /\b(?:EACCES|Operation not permitted|Read-only file system)\b/],
];

// Ordered most-specific first. The winner is the highest-priority rule matching ANY line, and
// within a rule the first line it matches — which is what makes this pick the assertion out of a
// test log rather than the framing line above it.
const CODE_RULES = [
  ['module_not_found', /((?:Cannot find module|Cannot find package|No module named|Could not resolve)\s+['"]?[^'"\s]+)/],
  ['sql', /\b(?:SqliteError|SQLITE_[A-Z]+|OperationalError|ProgrammingError|IntegrityError)\b\s*:?\s*(.*)/],
  ['sql', /\b((?:no such (?:column|table|index|function)|NOT NULL constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed)\b.*)/i],
  ['assertion', /\b(AssertionError\b.*)/],
  ['assertion', /\b(assertion failed\b.*)/i],
  ['assertion', /\b(expected\s+.+?\s+to\s+(?:be|equal|contain|throw)\b.*)/i],
  ['compile', /\b(error\s+TS\d+\s*:.*)/],
  ['compile', /\b(error\[E\d+\]\s*:.*)/],
  ['compile', /\b(cannot find symbol|undefined reference to|implicit declaration of function)\b(.*)/i],
  ['panic', /^\s*(panic:\s*.*)/],
  // `file.ext:line[:col]: message` — the shape every compiler and linter prints, and the only way
  // a Go type error arrives. Anchored on a filename with an extension so `grep -n` output
  // (`6959:  const x`) and a node stack preamble (`tree-sitter.js:2043`, no message) cannot match.
  ['compile', /^\s*\.?\/?(\S+\.\w+):\d+(?::\d+)?:\s*(\S.*)$/],
  // `[A-Z]\w*(?:Error|Exception)` alone never matches a bare `Error:` — the quantifier demands at
  // least one character before it — and node throws plenty of those.
  ['exception', /^\s*(?:[\w.]+\.)?((?:[A-Z]\w*)?(?:Error|Exception)\b\s*:\s*\S.*)$/],
  // The thrown expression, echoed by node above the stack. It is how the tree-sitter ABI trap
  // arrives — the message is a template literal, so no formatted `Error:` line is ever printed.
  ['exception', /\bthrow new ((?:[A-Z]\w*)?(?:Error|Exception)\(`?[^`)]{4,80})/],
  ['test_failure', /^\s*(?:FAIL|✕|×|●)\s+(.*)/],
  ['test_failure', /\b(\d+ (?:tests? )?(?:failed|failing)\b.*)/i],
  ['lint', /\b(\d+ problems? \(\d+ errors?)/],
];

// A signature has to survive being produced by a different run in a different directory, or
// recurrence counting is counting nothing. Paths, line:column pairs, hex addresses and long
// integers all change run to run while naming the same failure.
function normaliseSignature(text) {
  return String(text)
    .replace(/(?:\/[\w.@+-]+)+\/([\w.@+-]+)/g, '$1')
    .replace(/\b[A-Za-z]:\\[^\s'"]+\\([\w.@+-]+)/g, '$1')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '')
    .replace(/\b\d{3,}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, SIGNATURE_MAX);
}

// Human-facing. Keeps case and the identifier that names the problem; drops the machine's
// coordinates, which the reader cannot use and which make two sightings look like two problems.
function humanBody(text) {
  const cleaned = String(text)
    .replace(/(?:\/[\w.@+-]+)+\/([\w.@+-]+)/g, '$1')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > BODY_MAX ? `${cleaned.slice(0, BODY_MAX - 1)}…` : cleaned;
}

function firstMatch(text, rules) {
  const rows = String(text).split('\n');
  for (const [family, re] of rules) {
    for (const line of rows) {
      const m = line.match(re);
      if (!m) continue;
      const captured = m.slice(1).filter(Boolean).join(' ').trim();
      return { family, message: captured || line.trim() };
    }
  }
  return null;
}

// The framing the CLI wraps a failing Bash in. Stripping it is what stops a bare "Exit code 1"
// becoming a fact body — the exit code is not the error, it is only the news that there was one.
function stripFraming(err) {
  return String(err || '')
    .replace(/^Error:\s*Exit code \d+\s*/i, '')
    .replace(/^Exit code \d+\s*/i, '')
    .trim();
}

function classifyFailure(err, { cmd = null } = {}) {
  const raw = stripFraming(err);
  if (!raw) {
    return { class: 'environment', family: 'empty', body: '', signature: '', detail: '', cmd };
  }

  const env = firstMatch(raw, ENV_RULES);
  if (env) {
    return {
      class: 'environment',
      family: env.family,
      body: humanBody(env.message),
      signature: `${env.family}|${normaliseSignature(env.message)}`,
      detail: raw.slice(0, DETAIL_MAX),
      cmd,
    };
  }

  const code = firstMatch(raw, CODE_RULES);
  if (!code) {
    // Something failed and nothing in the output names it. Refusing here keeps failures from
    // arriving with a useless body like "Exit code 1".
    return {
      class: 'environment', family: 'unrecognised', body: '', signature: '',
      detail: raw.slice(0, DETAIL_MAX), cmd,
    };
  }

  return {
    class: 'code',
    family: code.family,
    body: humanBody(code.message),
    signature: `${code.family}|${normaliseSignature(code.message)}`,
    detail: raw.slice(0, DETAIL_MAX),
    cmd,
  };
}

// Kept because it is the published name and A2's error index consumes it; it now returns the
// human-facing half of the classification and is empty for anything that is not about the code.
function errorSignature(err) {
  return classifyFailure(err).body;
}

// ─── the state machine ──────────────────────────────────────────────────────────────────────────

function scopeKey(e) {
  // session AND agent. On session alone, a subagent's edit lands between the main loop's failure
  // and its pass and becomes a fix that never happened.
  return `${e.session_id}\x00${e.agent_id || ''}`;
}

function ms(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

// One Edit is several `events` rows (one per hunk). They are the same attempt and must be treated
// as one, or a three-hunk edit reads as three competing candidate fixes.
function groupEditCalls(events) {
  const out = [];
  let current = null;
  for (const e of events) {
    if (e.event_type !== 'edit') {
      current = null;
      out.push({ kind: 'event', event: e });
      continue;
    }
    const key = `${e.tool_use_id || ''}\x00${e.file_path || ''}`;
    if (current && current.key === key) {
      current.call.hunks.push(e);
      continue;
    }
    current = {
      key,
      call: {
        tool_use_id: e.tool_use_id,
        file_path: e.file_path,
        repo_id: e.repo_id,
        ts: e.ts,
        hunks: [e],
      },
    };
    out.push({ kind: 'edit', call: current.call });
  }
  return out;
}

function fingerprintsOf(call) {
  return call.hunks.map((h) => h.new_fingerprint).filter(Boolean).sort().join(',');
}

// An edit that writes back a block this scope previously deleted. That is an approach tried and
// backed out, and it is the only "we went down the wrong road" signal already present in `events`.
// Deliberately per-file: the same three lines reappearing in a DIFFERENT file is a copy, not a
// retreat. Fingerprints from the same tool call are skipped because `replace_all` emits the same
// block several times in one call, which is one edit, not a reversal.
function revertsAnything(call, removed) {
  const seen = removed.get(call.file_path);
  if (!seen) return false;
  return call.hunks.some((h) => h.new_fingerprint && seen.has(h.new_fingerprint));
}

function recordRemoved(call, removed) {
  let seen = removed.get(call.file_path);
  if (!seen) { seen = new Set(); removed.set(call.file_path, seen); }
  for (const h of call.hunks) if (h.old_fingerprint) seen.add(h.old_fingerprint);
}

// `relativise` returns the ABSOLUTE path when a file sits outside the repository root, which is how
// a scratchpad probe script arrives here. Anchoring a fact to one would file it under the repo's
// identity at a path the repo has never contained, and it would be deleted before anyone read it.
function inRepo(filePath) {
  return !!filePath && !path.isAbsolute(filePath);
}

// The repository root as a durable coordinate. Measured on the real corpus: 4 of 17 code failures
// are fixed by editing a file OUTSIDE the tree — a probe script in the scratchpad — and the lesson
// is real while the file is not. The alternatives were both worse: anchoring to the scratchpad path
// files the fact under a path the repo never contained, and mining a file name out of the command
// text manufactures an identity (it anchored one throwaway Python bug to eight unrelated test
// files). The honest coordinate for "this happens while working in this repo" is the repo.
const REPO_GRAIN = '.';

// On a human's tight edit-run-edit-run loop, every edit between the failure and the pass is a
// plausible anchor; on an agent's it is not — an agent may edit several files next, none of which
// is the fix. A heavy, true body attached to the wrong code is worse than no fact, because expiry
// then tracks the wrong file's lifetime too.
//
// So candidates are ranked by how plausibly they caused the pass, and only the strongest class
// present is kept. This differs from mining a filename OUT of command text, which manufactures an
// identity.
// Here the text only FILTERS a set of files the agent demonstrably edited — it can narrow the
// candidates, never invent one.
const MAX_TARGETS = 3;
const MIN_BASENAME = 4;

function implicated(file, arm) {
  const base = file.split('/').pop() || '';
  // A short basename ('db.js', 'x.js') collides with unrelated prose; require enough characters
  // that a match means something.
  if (base.length < MIN_BASENAME) return false;
  const hay = `${arm.err_excerpt || ''}\n${arm.detail || ''}\n${arm.raw_cmd || ''}`;
  return hay.includes(file) || hay.includes(base);
}

// `Cannot find module 'better-sqlite3'` has two completely different causes wearing one message: a
// missing install (fixed by `npm install`, or on this machine by symlinking node_modules into a
// worktree — no declaration caused it and none can be anchored to it) and a typo'd specifier
// (`require('lodahs')`, a real code bug fixed by a real edit). The error text cannot tell them
// apart, but the FIX can: a code bug changes the specifier, an install does not. This was the
// highest-weighted fact in the live store and it was anchoring to whatever the agent edited next.
function mentionsSpecifier(call, spec) {
  if (!spec) return false;
  for (const h of call.hunks || []) {
    if (!h.payload) continue;
    try {
      const p = JSON.parse(h.payload);
      if ([...(p.old || []), ...(p.new || [])].some((l) => String(l).includes(spec))) return true;
    } catch { /* a trimmed payload is not a failure */ }
  }
  return false;
}

function specifierOf(arm) {
  const m = /(?:Cannot find module|Cannot find package|No module named|Could not resolve)\s+['"]?([^'"\s]+)/
    .exec(`${arm.detail || ''}\n${arm.body || ''}`);
  return m ? m[1] : null;
}

function targetsFor(arm) {
  const candidates = [];
  let outside = null;
  for (const [file, fix] of arm.fixes) {
    if (!inRepo(file)) { outside = outside || fix; continue; }
    // A markdown note or a lockfile cannot be the fix for a compiler or SQL error. Measured on the
    // live store: `no such column: repository_branch_id` anchored to a research .md file purely
    // because it was edited last. Same guard the history seeder already applies (seed.js#isSourcePath).
    if (!isSourcePath(file)) continue;
    const attempt = arm.attempts.get(file) || null;
    // Identical content means the file ended where it started; there is no delta to learn.
    if (attempt && fingerprintsOf(attempt) === fingerprintsOf(fix)) continue;
    candidates.push({ file_path: file, repo_id: fix.repo_id, fix, attempt });
  }

  if (arm.family === 'module_not_found') {
    const spec = specifierOf(arm);
    const touched = candidates.filter((c) => mentionsSpecifier(c.fix, spec));
    // No edit went near the specifier, so nothing here fixed it — the environment did. Returning
    // nothing drops the lesson, which is the honest answer.
    if (!touched.length) return [];
    candidates.length = 0;
    candidates.push(...touched);
  }

  if (candidates.length > 1) {
    // The final burst — edits with no command between them and the pass. A genuine multi-file fix
    // is a burst; a stretch of unrelated work has commands running through it.
    const from = arm.burst_from ?? 0;
    const burst = candidates.filter((c) => (c.fix.step ?? 0) > from);
    let kept = burst.length ? burst : candidates;

    if (kept.length > MAX_TARGETS) {
      // Still too diffuse to be one change. Narrow by evidence, strongest class only.
      // A · the failure named it — the error or the failing command pointed at this file.
      const named = kept.filter((c) => implicated(c.file_path, arm));
      // B · attempt → fix on the same file. The original design's delta, still good evidence.
      const delta = kept.filter((c) => c.attempt);
      // C · nothing distinguishes them, so take the last edit alone rather than dragging its
      // neighbours along. One wrong anchor is cheaper than five.
      kept = named.length ? named : (delta.length ? delta : [kept[kept.length - 1]]);
    }
    candidates.length = 0;
    candidates.push(...kept.slice(0, MAX_TARGETS));
  }

  if (!candidates.length && outside) {
    return [{ file_path: REPO_GRAIN, repo_id: arm.repo_id || outside.repo_id, fix: outside, attempt: null, repo_grain: true }];
  }
  return candidates;
}

// Recurrence made countable: next session you hit the same issue and waste tokens. A signature seen
// before in this repo is worth more than one seen once, and the fact has to say so or the ranking
// cannot use it.
function signatureCounts(events) {
  const counts = new Map();
  for (const e of events) {
    if (e.event_type !== 'cmd_fail') continue;
    const c = classifyFailure(e.err_excerpt, { cmd: e.cmd });
    if (c.class !== 'code') continue;
    const key = `${e.repo_id || ''}\x00${c.signature}`;
    const seen = counts.get(key)
      || { count: 0, sessions: new Set(), scopes: new Set(), first_at: e.ts, last_at: e.ts };
    seen.count += 1;
    // Two different questions. A different SESSION is the core case — you solved this
    // once and are about to pay for it again with no transcript to remind you. A different agent
    // inside one session is the same blindness in miniature (a subagent has its own context window
    // and cannot see the main loop's discovery) but the two are one keystroke apart in time, so
    // they are counted apart and weighed apart.
    seen.sessions.add(e.session_id);
    seen.scopes.add(`${e.session_id}\x00${e.agent_id || ''}`);
    if (e.ts < seen.first_at) seen.first_at = e.ts;
    if (e.ts > seen.last_at) seen.last_at = e.ts;
    counts.set(key, seen);
  }
  return counts;
}

// ─── what the lesson cost to learn ───────────────────────────────────────────────────────────────
//
// Measured over the 3,582 live events: 94 failures, 25 of them about the code, 23 distinct
// signatures, and exactly ONE that crossed a session boundary. A store that ranks all 23 the same
// is a bug diary. Ranking them by cost is what turns it into a memory.
//
// The ladder is deliberately shaped so that effort ALONE can never clear the bar. Wall clock and
// turn count are the noisiest signals here — an agent that wanders off for forty minutes looks
// identical to one that fought hard — so their combined contribution is capped below the threshold
// by construction. Only recurrence across contexts, or a genuinely abandoned approach, gets a fact
// in front of a reader.

const POINTS = Object.freeze({
  crossSession: 3.0,
  crossScope: 1.0,
  repeat: 0.5,
  abandonment: 1.25,
  workaround: 0.75,
});

const REPEAT_CAP = 1.5;
const ABANDONMENT_CAP = 2.5;
// Turn count + wall clock + workaround shape together. Below SURFACE_THRESHOLD on purpose.
const EFFORT_CAP = 2.0;

const SURFACE_THRESHOLD = 3.0;

// Descending, first match wins. Buckets rather than a curve because the number has to be
// explainable in one line to a reader who did not write it.
const TURN_STEPS = Object.freeze([[40, 1.5], [20, 1.0], [8, 0.5]]);
const ELAPSED_STEPS = Object.freeze([
  [90 * 60 * 1000, 1.5], [30 * 60 * 1000, 1.0], [10 * 60 * 1000, 0.5],
]);

function step(steps, value) {
  for (const [at, points] of steps) if (value >= at) return { at, points };
  return null;
}

function minutes(msValue) {
  return Math.round(msValue / 60000);
}

function weighLesson({
  sessions = 1, scopes = 1, occurrences = 1, turns = 0, elapsedMs = 0,
  abandonments = 0, workaround = false,
} = {}) {
  const reasons = [];
  const add = (signal, detail, points) => {
    if (points > 0) reasons.push({ signal, detail, points: Math.round(points * 100) / 100 });
  };

  const crossSession = Math.max(0, sessions - 1);
  add('cross_session', crossSession
    ? `the same failure in ${sessions} separate sessions` : '', crossSession * POINTS.crossSession);

  const crossScope = Math.max(0, scopes - Math.max(sessions, 1));
  add('cross_agent', crossScope
    ? `hit by ${scopes} agents that could not see each other` : '', crossScope * POINTS.crossScope);

  const repeats = Math.max(0, occurrences - Math.max(scopes, 1));
  add('repeated', repeats ? `recurred ${occurrences} times in all` : '',
    Math.min(repeats * POINTS.repeat, REPEAT_CAP));

  const abandoned = Math.min(abandonments * POINTS.abandonment, ABANDONMENT_CAP);
  add('abandoned_approach', abandonments
    ? `${abandonments} edit${abandonments === 1 ? '' : 's'} put back code already removed` : '',
  abandoned);

  const effort = [];
  const turnStep = step(TURN_STEPS, turns);
  if (turnStep) effort.push(['turns', `${turns} tool calls before it passed`, turnStep.points]);
  const elapsedStep = step(ELAPSED_STEPS, elapsedMs);
  if (elapsedStep) effort.push(['elapsed', `${minutes(elapsedMs)} minutes unresolved`, elapsedStep.points]);
  if (workaround) effort.push(['workaround', 'fixed somewhere other than where it broke', POINTS.workaround]);

  const rawEffort = effort.reduce((sum, [, , p]) => sum + p, 0);
  // Scaled rather than truncated, so the reasons still sum to the score a reader is shown.
  const scale = rawEffort > EFFORT_CAP ? EFFORT_CAP / rawEffort : 1;
  for (const [signal, detail, points] of effort) add(signal, detail, points * scale);

  const weight = reasons.reduce((sum, r) => sum + r.points, 0);
  return { weight: Math.round(weight * 100) / 100, reasons };
}

function explainWeight(reasons) {
  let list = reasons;
  if (typeof list === 'string') {
    try { list = JSON.parse(list || '[]'); } catch { return []; }
  }
  return Array.isArray(list) ? list.map((r) => `+${r.points} ${r.detail}`) : [];
}

function emit(lessons, arm, passEvent, { confidence, matchedBy, counts, passStep = 0 }) {
  const targets = targetsFor(confidence === 'shape' || !arm.weak_fixes
    ? arm : { ...arm, fixes: arm.weak_fixes });
  if (!targets.length) return false;
  const key = `${arm.repo_id || ''}\x00${arm.signature}`;
  const seen = counts.get(key);
  // A repo-grain target says we know the repository and not the file, so the claim is weaker than
  // the match that produced it however strong that match was.
  const repoGrain = targets.every((t) => t.repo_grain);
  // The fix landed nowhere the failing attempt had been. Only a shape when something WAS being
  // worked on — with no attempt at all there is no "elsewhere" to have moved to.
  const workaround = arm.attempts.size > 0 && targets.every((t) => !t.attempt);
  const turns = Math.max(0, passStep - arm.armed_step);
  const { weight, reasons } = weighLesson({
    sessions: seen ? seen.sessions.size : 1,
    scopes: seen ? seen.scopes.size : 1,
    occurrences: seen ? seen.count : 1,
    turns,
    elapsedMs: Math.max(0, ms(passEvent.ts) - ms(arm.failed_at)),
    abandonments: arm.abandonments,
    workaround,
  });
  lessons.push({
    kind: 'correction',
    tier: confidence === 'shape' && !repoGrain ? 'observation' : 'hypothesis',
    grain: repoGrain ? 'repo' : 'symbol',
    matched_by: matchedBy,
    session_id: arm.session_id,
    agent_id: arm.agent_id,
    repo_id: arm.repo_id,
    cmd: arm.raw_cmd,
    fixed_by_cmd: passEvent.cmd,
    normalised_cmd: arm.shape,
    err_excerpt: arm.err_excerpt,
    error_family: arm.family,
    signature: arm.signature,
    body: arm.body,
    detail: arm.detail,
    recurrence: seen ? seen.count : 1,
    recurrence_scopes: seen ? seen.scopes.size : 1,
    recurrence_sessions: seen ? seen.sessions.size : 1,
    weight,
    weight_reasons: reasons,
    failed_at: arm.failed_at,
    passed_at: passEvent.ts,
    targets,
  });
  return true;
}

function runFailFix(events, { idleMs = IDLE_MS, allowFallback = true, counts = null } = {}) {
  const sigCounts = counts || signatureCounts(events);

  const byScope = new Map();
  for (const e of events) {
    const k = scopeKey(e);
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push(e);
  }

  const lessons = [];
  for (const [, scoped] of byScope) {
    scoped.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id || 0) - (b.id || 0)));

    const pending = new Map();   // file_path -> the latest edit call on it
    const arms = new Map();      // error signature -> arm
    // file_path -> fingerprints of blocks this scope has REMOVED. Putting one back is an approach
    // that was tried and backed out, which is the cheapest evidence of a hard problem in the store.
    const removed = new Map();
    let lastTs = null;
    let stepIndex = 0;

    for (const item of groupEditCalls(scoped)) {
      const e = item.kind === 'edit' ? item.call.hunks[0] : item.event;
      stepIndex += 1;

      // "30 min idle → discard". A gap this long between two events in the same scope means the
      // developer left; whatever they do next is not a continuation of the failure.
      if (lastTs !== null && ms(e.ts) - lastTs > idleMs) {
        for (const arm of arms.values()) {
          if (!arm.weak_pass || !arm.fixes.size) continue;
          emit(lessons, arm, arm.weak_pass, {
            confidence: 'any', matchedBy: 'any_pass_after_edit', counts: sigCounts,
            passStep: arm.weak_pass_step,
          });
        }
        arms.clear();
      }
      lastTs = ms(e.ts);

      if (item.kind === 'edit') {
        const call = item.call;
        pending.set(call.file_path, call);
        // Every armed signature collects it: the fix for a Go build failure may land in a file the
        // failing attempt never touched, and multi-file fixes are normal.
        // The step is what separates one multi-file change from a stretch of unrelated work:
        // consecutive edits with no command between them are one burst, and a burst is one fix.
        call.step = stepIndex;
        for (const arm of arms.values()) arm.fixes.set(call.file_path, call);
        if (revertsAnything(call, removed)) {
          for (const arm of arms.values()) arm.abandonments += 1;
        }
        recordRemoved(call, removed);
        continue;
      }

      if (e.event_type === 'cmd_denied') continue;   // ignore, and do NOT disarm
      if (e.event_type !== 'cmd_fail' && e.event_type !== 'cmd_pass') continue;
      if (!e.cmd) continue;

      // A command the agent actually ran ends the current burst. A denial does not — nothing ran,
      // so it is not a boundary between two pieces of work. `burst_from` is the PREVIOUS command's
      // step, because the command being handled here may be the pass itself, and the burst that
      // fixed it is the edits before that pass, not after it.
      for (const arm of arms.values()) {
        arm.burst_from = arm.last_cmd_step ?? arm.armed_step ?? 0;
        arm.last_cmd_step = stepIndex;
      }

      const shape = commandShape(e.cmd);

      if (e.event_type === 'cmd_fail') {
        const c = classifyFailure(e.err_excerpt, { cmd: e.cmd });
        // The refusal that makes this whole layer safe: a harness notice, a timeout, a missing
        // scratchpad path is not evidence about anybody's code, so it never arms.
        if (c.class !== 'code') continue;
        // Re-arming on a second failure with the same signature replaces the attempt with the
        // newer hunk. The signature RECURRED, so the previous arm's weak evidence is now known to
        // be wrong and is dropped rather than retired.
        arms.delete(c.signature);
        arms.set(c.signature, {
          signature: c.signature,
          family: c.family,
          body: c.body,
          detail: c.detail,
          shape,
          raw_cmd: e.cmd,
          repo_id: e.repo_id,
          session_id: e.session_id,
          agent_id: e.agent_id || null,
          err_excerpt: e.err_excerpt || '',
          failed_at: e.ts,
          armed_step: stepIndex,
          last_cmd_step: stepIndex,
          abandonments: 0,
          attempts: new Map(pending),
          fixes: new Map(),
        });
        continue;
      }

      // cmd_pass. The armed signature is gone; the only question is how much of that is evidence.
      for (const arm of [...arms.values()]) {
        if (!arm.fixes.size) continue;   // passed with no intervening edit — flaky, not a fix
        if (arm.shape && shape && arm.shape === shape) {
          arms.delete(arm.signature);
          emit(lessons, arm, e, {
            confidence: 'shape', matchedBy: 'command_shape', counts: sigCounts, passStep: stepIndex,
          });
          continue;
        }
        // A pass of a DIFFERENT shape is remembered, not consumed. Consuming it cost 5 of 7
        // observations on the real corpus: an unrelated `git status` between the failure and the
        // re-run of the failing command retired the arm before the evidence arrived. The fixes are
        // snapshotted with it — everything edited after this pass fixed something else.
        if (allowFallback && !arm.weak_pass) {
          arm.weak_pass = e;
          arm.weak_pass_step = stepIndex;
          arm.weak_fixes = new Map(arm.fixes);
        }
      }
    }

    // Scope end. Everything still armed ended without its signature recurring, which is the weaker
    // half of the rule — a hypothesis, which no reader ever sees.
    for (const arm of arms.values()) {
      if (!arm.weak_pass || !arm.fixes.size) continue;
      emit(lessons, arm, arm.weak_pass, {
        confidence: 'any', matchedBy: 'any_pass_after_edit', counts: sigCounts,
        passStep: arm.weak_pass_step,
      });
    }
  }
  return lessons;
}

module.exports = {
  runFailFix, errorSignature, classifyFailure, signatureCounts, groupEditCalls, scopeKey,
  normaliseSignature, humanBody, stripFraming, weighLesson, explainWeight,
  revertsAnything, recordRemoved,
  ENV_RULES, CODE_RULES, IDLE_MS, BODY_MAX, DETAIL_MAX, SIGNATURE_MAX, REPO_GRAIN,
  POINTS, SURFACE_THRESHOLD, EFFORT_CAP, REPEAT_CAP, ABANDONMENT_CAP,
};
