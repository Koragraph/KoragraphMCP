'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { commandShape } = require('./event-extract');
const { redactSecrets, neutralise } = require('./untrusted');

// The half of the capture plane nobody was mining. Measured on the live store: 2,942 cmd_pass
// against 96 cmd_fail — successes outnumber failures 30:1, carry no inference risk, and answer the
// question an agent asks at the start of every session and currently rediscovers by guessing: how
// do things run in THIS repo.
//
// Pure counting. No model, no inference, no similarity, nothing that can hallucinate. A ritual is
// a command shape that succeeded often, recently, and rarely failed.
//
// practice.db only — this runs on the UserPromptSubmit hook path (see preflight.js).

const HALF_LIFE_DAYS = 30;
const MIN_PASSES = 5;
const MIN_WEIGHT = 3;
const MAX_FAIL_RATE = 0.25;
// A shape whose last two attempts both failed is demoted whatever its history says. The history is
// what the repo used to do; two consecutive failures are what it does now.
const RECENT_FAIL_STREAK = 2;
const MAX_RITUALS = 4;
const MAX_TOKENS = 8;
// A ritual is program plus subcommand. Past that it stops being how the repo works and starts
// being what one session happened to be doing.
const MAX_PREFIX_TOKENS = 4;
const MAX_TOKEN_CHARS = 32;
const SCAN_LIMIT = 20000;
// A literal survives generalisation only if it dominates its group. Below this the argument is
// what varies between runs, which is exactly what a placeholder is for.
const DOMINANCE = 0.6;

// Programs an agent already knows how to drive. Telling a reader that this repo uses `cat` is the
// repository-overview failure mode in miniature: measurably >20% more tokens for no gain in task
// success. A ritual has to be something about THIS repo.
const UBIQUITOUS = new Set([
  'cat', 'sed', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'echo', 'printf', 'wc', 'head', 'tail',
  'awk', 'find', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'chmod', 'chown', 'diff', 'du', 'df', 'ps',
  'kill', 'pkill', 'pgrep', 'sleep', 'which', 'whereis', 'env', 'date', 'basename', 'dirname',
  'tee', 'mktemp', 'open', 'less', 'more', 'file', 'stat', 'realpath', 'readlink', 'seq', 'yes',
  'md5', 'md5sum', 'shasum', 'sha256sum', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'nl', 'column',
  'git', 'gh', 'ssh', 'scp', 'rsync', 'nc', 'ping', 'lsof', 'top', 'uname', 'whoami', 'hostname',
  'for', 'while', 'until', 'if', 'case', 'do', 'done', 'then', 'else', 'fi', 'esac', 'function',
  'wait', 'jobs', 'trap', 'exec', 'eval', 'read', 'test', 'let', 'declare', 'local', 'return',
  // Wrappers. commandShape() skips `time` but not these, so without them the shape of a ritual
  // becomes the shape of how someone happened to launch it once.
  'nohup', 'sudo', 'caffeinate', 'watch', 'timeout', 'stdbuf', 'nice', 'command', 'builtin', 'xcrun',
]);

// An interpreter is only a ritual when it carries a path this repo owns. `node -e` and
// `python3 - <<EOF` are the agent's own scratch work, run a hundred times, about nothing.
const INTERPRETERS = new Set([
  'node', 'python', 'python3', 'python2', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'deno', 'bun',
  'osascript', 'php',
]);

const PLACEHOLDER = /^<(?:path|arg)>$/;
const PATHISH = /[/~]|\.[A-Za-z0-9]{1,6}$/;
const WORDISH = /^[-\w][-\w.:=+@]*$/;
const ENV_ASSIGN = /^[A-Za-z_]\w*=/;

// Segment-aware, quote-aware, and deliberately not a shell parser. commandShape() stops at the
// first quote because identity is all the fail→fix matcher needs; a ritual has to be RUNNABLE, so
// the argument tail is the whole deliverable and has to survive tokenisation intact.
function tokenise(text) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let quoted = false;
  let q = null;
  let i = 0;
  const s = String(text);

  const endToken = () => {
    if (cur) tokens.push({ text: cur, quoted });
    cur = '';
    quoted = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; i++; continue; }
      cur += c;
      i++;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { q = c; quoted = true; i++; continue; }
    if (c === '\\' && s[i + 1]) { cur += s[i + 1]; i += 2; continue; }
    // A heredoc body is the user's own program, not a command line. Everything after it is script.
    if (c === '<' && s[i + 1] === '<') break;
    if (c === '\n' || c === ';') { endSegment(); i++; continue; }
    if ((c === '&' || c === '|') && s[i + 1] === c) { endSegment(); i += 2; continue; }
    if (c === '|') { endSegment(); i++; continue; }
    if (c === '&') { endSegment(); i++; continue; }
    // A redirection says where the output went, never what was run. `2>&1`, `>log`, `<in` and the
    // filename that follows are dropped together.
    if (c === '>' || c === '<' || (/\d/.test(c) && (s[i + 1] === '>' || s[i + 1] === '<'))) {
      endToken();
      while (i < s.length && /[\d<>&]/.test(s[i])) i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      while (i < s.length && !/[\s;|&\n]/.test(s[i])) i++;
      continue;
    }
    if (/\s/.test(c)) { endToken(); i++; continue; }
    cur += c;
    i++;
  }
  endSegment();
  return segments;
}

function programOf(token) {
  return token.split('/').pop();
}

// The segment commandShape() named, so the shape and the form can never disagree about which
// command in a compound line the ritual is about.
function segmentFor(cmd, shape) {
  const program = shape.split(' ')[0];
  for (const tokens of tokenise(cmd)) {
    let i = 0;
    while (i < tokens.length && !tokens[i].quoted && ENV_ASSIGN.test(tokens[i].text)) i++;
    if (i >= tokens.length) continue;
    if (programOf(tokens[i].text) === program) return tokens.slice(i);
  }
  return null;
}

function homeAbbrev(p, home) {
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function expandHome(p, home) {
  return p.startsWith('~/') && home ? path.join(home, p.slice(2)) : p;
}

// A path token becomes a coordinate a reader can act on, or a placeholder. Absolute paths inside
// the checkout become repo-relative because that is the form every other anchor in this store
// uses; anything with a shell variable in it is per-run scratch and can never be a coordinate.
function pathLiteral(raw, { repoRoot, home }) {
  if (/[$`*?{}]/.test(raw)) return null;
  let p = raw;
  if (repoRoot && path.isAbsolute(p)) {
    const rel = path.relative(repoRoot, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return homeAbbrev(p, home);
  }
  return homeAbbrev(p, home);
}

// Quoting is not a class. `sqlite3 "$S/g.db"` and `sqlite3 ~/.koragraph/graph.db` are the same
// shape of command, and treating the quoted one as an opaque argument splits one ritual in two.
// What does decide the class is whether the token holds whitespace — an inlined SQL statement or a
// -e program is content, not an argument a reader fills in.
function classify(tok, ctx) {
  const raw = tok.text;
  if (!raw || /\s/.test(raw) || raw.length > 80) return { form: '<arg>', literal: null };
  if (raw.startsWith('-')) {
    return WORDISH.test(raw) && raw.length <= MAX_TOKEN_CHARS
      ? { form: raw, literal: null }
      : { form: '<arg>', literal: null };
  }
  if (PATHISH.test(raw)) return { form: '<path>', literal: pathLiteral(raw, ctx) };
  if (WORDISH.test(raw) && raw.length <= MAX_TOKEN_CHARS) return { form: raw, literal: null };
  return { form: '<arg>', literal: null };
}

// program + generalised argument tail. Two runs of the suite over different files collapse here;
// two different programs never do.
function formOf(cmd, shape, ctx) {
  const segment = segmentFor(cmd, shape);
  if (!segment) return null;
  const forms = [programOf(segment[0].text)];
  const literals = [null];
  for (const tok of segment.slice(1, MAX_TOKENS)) {
    const c = classify(tok, ctx);
    forms.push(c.form);
    literals.push(c.literal);
  }
  return { key: forms.join(' '), forms, literals };
}

function decay(ageMs, halfLifeDays) {
  const days = ageMs / 86400000;
  return days <= 0 ? 1 : 0.5 ** (days / halfLifeDays);
}

// Judged on the RESOLVED form, after dominant literals are substituted back — before that every
// path is a placeholder and every ritual looks equally uninformative.
function eligible(forms) {
  const program = forms[0];
  if (UBIQUITOUS.has(program)) return false;
  // A one-character program is a word out of a `for x in c cpp csharp` list that the segment split
  // saw as a command line. There is no tool worth teaching whose name is one letter.
  if (program.length < 2) return false;
  const tail = forms.slice(1);
  // `node bin/koragraph.js ingest` is a ritual; `node -e`, and `node <path> java` where the script
  // varies run to run, are the agent talking to itself. The script argument IS the instruction.
  if (INTERPRETERS.has(program)) return !!tail[0] && !PLACEHOLDER.test(tail[0]) && PATHISH.test(tail[0]);
  return tail.some((f) => !PLACEHOLDER.test(f));
}

// Substitute a dominant literal back into its placeholder. The group key already fixed the token
// count and the token classes, so position is a stable identity across the group's members.
function resolveLiterals(group) {
  const forms = group.forms.slice();
  for (let i = 1; i < forms.length; i++) {
    if (forms[i] !== '<path>') continue;
    const counts = group.literalCounts[i];
    if (!counts) continue;
    let best = null;
    let bestN = 0;
    for (const [value, n] of counts) if (n > bestN) { best = value; bestN = n; }
    if (best && bestN / group.passes >= DOMINANCE) forms[i] = best;
  }
  return forms;
}

// Program plus subcommand, everything a caller fills in cut away — resolved literals FIRST, because
// `node scripts/goldset.mjs java` and `node bin/koragraph.js ingest` are indistinguishable until
// the dominant path is known, and cutting at the placeholder before that throws away the only
// token that makes the second one an instruction.
function prefixOf(forms) {
  const out = [forms[0]];
  let takesPath = false;
  for (const f of forms.slice(1)) {
    if (PLACEHOLDER.test(f) || f.startsWith('-')) { takesPath = f === '<path>'; break; }
    if (out.length >= MAX_PREFIX_TOKENS) break;
    out.push(f);
  }
  return { prefix: out, takesPath };
}

const SCAN_SQL = `
SELECT event_type, cmd, ts
  FROM events
 WHERE repo_id = ?
   AND cmd IS NOT NULL
   AND event_type IN ('cmd_pass','cmd_fail')
 ORDER BY id DESC
 LIMIT ?`;

// A token long enough to need truncating cannot be pasted into a shell, and a ritual that cannot
// be run is a description — pure cost, not a runnable command.
function renderToken(f) {
  if (PLACEHOLDER.test(f)) return f;
  const clean = neutralise(redactSecrets(f));
  if (!clean || clean.length > MAX_TOKEN_CHARS) return PATHISH.test(f) ? '<path>' : '<arg>';
  return clean;
}

function renderForm(forms) {
  return forms.map(renderToken);
}

function tally(g, row, w, literals) {
  if (row.event_type === 'cmd_pass') {
    g.passes++;
    g.passWeight += w;
    g.streakOpen = false;
    if (!g.lastPassAt) g.lastPassAt = row.ts;
    if (literals) {
      for (let i = 1; i < literals.length; i++) {
        const lit = literals[i];
        if (!lit) continue;
        if (!g.literalCounts[i]) g.literalCounts[i] = new Map();
        g.literalCounts[i].set(lit, (g.literalCounts[i].get(lit) || 0) + 1);
      }
    }
  } else {
    g.fails++;
    g.failWeight += w;
    if (g.streakOpen) g.streak++;
    if (!g.lastFailAt) g.lastFailAt = row.ts;
  }
}

function emptyGroup(shape, forms) {
  return {
    shape,
    forms,
    passes: 0,
    fails: 0,
    passWeight: 0,
    failWeight: 0,
    streak: 0,
    streakOpen: true,
    lastPassAt: null,
    lastFailAt: null,
    literalCounts: forms.map(() => null),
  };
}

function mineRituals(db, {
  repoId,
  repoRoot = null,
  now = new Date(),
  limit = MAX_RITUALS,
  halfLifeDays = HALF_LIFE_DAYS,
  minPasses = MIN_PASSES,
  minWeight = MIN_WEIGHT,
  maxFailRate = MAX_FAIL_RATE,
  exists = (p) => fs.existsSync(p),
  home = os.homedir(),
} = {}) {
  if (!repoId) return [];
  let rows;
  try {
    rows = db.prepare(SCAN_SQL).all(repoId, SCAN_LIMIT);
  } catch {
    return [];
  }

  const ctx = { repoRoot, home };
  const nowMs = now.getTime();
  const parsed = [];
  const byKey = new Map();

  // Descending id throughout, so the first row a group sees is its most recent — which is what the
  // demotion streak reads.
  for (const row of rows) {
    const shape = commandShape(row.cmd);
    if (!shape) continue;
    const form = formOf(row.cmd, shape, ctx);
    if (!form || UBIQUITOUS.has(form.forms[0])) continue;
    let g = byKey.get(form.key);
    if (!g) { g = emptyGroup(shape, form.forms); byKey.set(form.key, g); }
    const w = decay(nowMs - Date.parse(row.ts), halfLifeDays);
    tally(g, row, w, form.literals);
    parsed.push({ key: form.key, row, w, shape });
  }

  // Two passes, because the rendered form is not knowable until the whole group has been counted:
  // `npx vitest run <path>`, `npx vitest run --config x.js` and `npx vitest run <path> <path>` all
  // reduce to `npx vitest run`, and counting them separately reported the same ritual five times,
  // each carrying a fifth of its evidence.
  const shapeByKey = new Map();
  for (const [key, g] of byKey) shapeByKey.set(key, prefixOf(renderForm(resolveLiterals(g))));

  const merged = new Map();
  for (const p of parsed) {
    const { prefix, takesPath } = shapeByKey.get(p.key);
    const text = prefix.join(' ');
    let g = merged.get(text);
    if (!g) { g = emptyGroup(p.shape, prefix); g.pathPasses = 0; merged.set(text, g); }
    tally(g, p.row, p.w, null);
    if (takesPath && p.row.event_type === 'cmd_pass') g.pathPasses++;
  }

  const out = [];
  for (const [text, g] of merged) {
    if (g.streak >= RECENT_FAIL_STREAK) continue;
    if (g.passes < minPasses || g.passWeight < minWeight) continue;
    const total = g.passWeight + g.failWeight;
    const failRate = total > 0 ? g.failWeight / total : 0;
    if (failRate > maxFailRate) continue;
    if (!eligible(g.forms)) continue;
    // The path expiry rule, checked on the RENDERED form rather than at substitution time: a
    // ritual naming a script that has since been deleted is worse than no ritual, and the check has
    // to be able to fire on a form that was mined while the file still existed.
    const dead = g.forms.slice(1).some((f) => !PLACEHOLDER.test(f) && PATHISH.test(f)
      && !exists(path.resolve(repoRoot || '.', expandHome(f, home))));
    if (dead) continue;

    // The trailing placeholder is what turns a name into an instruction: `npx vitest run` is a
    // description of the tool, `npx vitest run <path>` is a command with a hole the reader fills.
    const form = g.pathPasses / g.passes >= 0.5 ? `${text} <path>` : text;
    out.push({
      shape: g.shape,
      form,
      passes: g.passes,
      fails: g.fails,
      weight: Number((g.passWeight * (1 - failRate)).toFixed(3)),
      fail_rate: Number(failRate.toFixed(3)),
      last_pass_at: g.lastPassAt,
      last_fail_at: g.lastFailAt,
    });
  }

  out.sort((a, b) => b.weight - a.weight || a.form.localeCompare(b.form));
  return out.slice(0, limit);
}

const PUSHED_SQL = 'SELECT 1 FROM ritual_pushes WHERE session_id = ? AND repo_id = ?';
const MARK_SQL = 'INSERT OR REPLACE INTO ritual_pushes (session_id, repo_id, pushed_at, forms) VALUES (?,?,?,?)';

// Once per session, and the marker has to outlive the hook process, which is why it is a row.
function alreadyPushed(db, sessionId, repoId) {
  if (!sessionId || !repoId) return false;
  try {
    return !!db.prepare(PUSHED_SQL).get(sessionId, repoId);
  } catch {
    return false;
  }
}

function markPushed(db, sessionId, repoId, forms, now = new Date()) {
  if (!sessionId || !repoId) return false;
  try {
    db.prepare(MARK_SQL).run(sessionId, repoId, now.toISOString(), JSON.stringify(forms || []));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  mineRituals, alreadyPushed, markPushed, tokenise, formOf, eligible,
  UBIQUITOUS, INTERPRETERS, MAX_RITUALS, HALF_LIFE_DAYS, MIN_PASSES, MAX_FAIL_RATE,
};
