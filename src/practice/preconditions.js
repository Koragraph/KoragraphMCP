'use strict';

const fs = require('fs');
const path = require('path');

const { neutralise, safePath } = require('./untrusted');

// PreToolUse on Bash. Not a memory — a check.
//
// Measured over 3,892 captured events and 1,740 real transcript commands: only FIVE failures ever
// repeated across sessions, and four of the five are statements about the filesystem as it is right
// now, not about the past. `Cannot find module 'better-sqlite3'` is the highest-weighted fact in
// the live practice store (p#7, weight 5.5) and it is worth nothing as a memory, because the answer
// is one `fs.existsSync` away at the moment the command is about to run.
//
// So this file stores nothing, anchors nothing and expires nothing. It opens NO database at all —
// not graph.db, not practice.db — which is what keeps it affordable on a hook that fires before
// every Bash call the agent makes. `untrusted.js` has no requires of its own, so the require graph
// from here is two files deep and touches no driver.
//
// The design rule is abstention. Every predicate below is validated against the authority that
// will actually decide — zsh for globs, node's own resolver for specifiers — and anything the
// parser cannot resolve completely is dropped rather than guessed. Measured on the real corpus:
// 13/13 glob findings and 41/41 module findings agreed with that authority, on a combined fire
// rate of 1.1% of commands. A check that fires on every command is a tax; silence is the answer
// almost every time and that is the point.

const MAX_FINDINGS = 2;
const GLOB = /[*?]/;
const CMD_MAX = 120;

// Only the resolver's own list matters here, so a package genuinely named `stream` in
// node_modules is not what this is about — a bare specifier that node satisfies from the builtin
// set can never be the missing-install failure this check is for.
const BUILTINS = new Set(['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty', 'url', 'util',
  'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite']);

// ── the shell's own vocabulary ──────────────────────────────────────────────────────────────────

function varMap(cmd) {
  const map = new Map();
  const re = /(?:^|[\n;&|(]|&&|\|\|)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("([^"\n]*)"|'([^'\n]*)'|([^\s;&|)\n]*))/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    map.set(m[1], val == null ? '' : val);
  }
  return map;
}

function expand(tok, map, depth = 0) {
  // `~` is expanded before `$`, and unconditionally: a token can carry a tilde and no variable at
  // all, and returning early on "no $ present" made the check read ~/x as a relative path.
  if (tok.startsWith('~/')) return expand(path.join(process.env.HOME || '', tok.slice(2)), map, depth);
  if (depth > 4 || !tok.includes('$')) return tok;
  const out = tok.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => {
    const k = a || b;
    return map.has(k) ? map.get(k) : all;
  });
  return out === tok ? out : expand(out, map, depth + 1);
}

// A token still carrying `$` or a subshell is one this file could not finish resolving, and a
// half-resolved path is a guess. Guesses are the whole failure mode here.
function resolved(tok) { return !!tok && !tok.includes('$') && !tok.includes('`'); }

// A heredoc body is data, not shell words — but it is also where a script's `require` calls live,
// so it is separated rather than discarded.
function splitHeredocs(cmd) {
  const lines = String(cmd).split('\n');
  const heredocs = [];
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!m) { kept.push(line); i += 1; continue; }
    const tgt = /(?:>>?|\|\s*tee)\s*(\S+)/.exec(line);
    kept.push(line);
    const term = m[2];
    const body = [];
    i += 1;
    while (i < lines.length && lines[i].trim() !== term) { body.push(lines[i]); i += 1; }
    i += 1;
    heredocs.push({ target: tgt ? tgt[1] : null, body: body.join('\n') });
  }
  return { stripped: kept.join('\n'), heredocs };
}

// Words the shell would see unquoted. A quoted word is never glob-expanded, so it must not reach
// the glob check: `?,?,?,?` inside a SQL string is not a pattern, and treating it as one is the
// single largest source of wrong findings.
function bareTokens(text) {
  const out = [];
  let buf = '';
  let quote = null;
  let quoted = false;
  const push = () => { if (buf && !quoted) out.push(buf); buf = ''; quoted = false; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      // A `\"` inside a double-quoted word does NOT close it. Without this the tokeniser lost
      // its place on `grep -noE "'X'|\"X\""` and handed the glob check a fragment of the next
      // echo's prose as if it were a pattern.
      if (c === '\\' && quote === '"') { buf += text[i + 1] || ''; i += 1; continue; }
      if (c === quote) { quote = null; quoted = true; } else buf += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\') { buf += text[i + 1] || ''; i += 1; continue; }
    if (/\s/.test(c) || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { push(); continue; }
    buf += c;
  }
  push();
  return out;
}

function effectiveCwd(cmd, cwd, map) {
  let dir = cwd;
  // The word must stop at the shell's separators. `\S+` swallowed the `;` in `cd /repo; grep …`
  // and every relative path after it then resolved under a directory that does not exist — which
  // the glob check read as "nothing matches" and reported, 22 times over the real corpus.
  const re = /(?:^|[\n;&|]|&&)\s*cd\s+(?!-)([^\s;&|)]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const t = expand(m[1].replace(/^["']|["']$/g, ''), map);
    if (!resolved(t)) continue;
    dir = path.resolve(dir, t);
  }
  return dir;
}

// ── check · an unquoted glob that matches nothing ───────────────────────────────────────────────
//
// zsh's NOMATCH is on by default and it aborts the WHOLE command line before running any of it —
// which is why this failure is expensive out of proportion to its cause: a twenty-minute pipeline
// dies on `rm -f $DB*` because the file it was about to remove was not there. bash does the
// opposite (the pattern is passed through literally, and `rm -f` then succeeds), so the check is
// gated on the shell actually being zsh.

function globMatches(pattern, cwd) {
  const abs = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (GLOB.test(dir) || dir.includes('[')) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return false; }
  let src = '';
  for (let i = 0; i < base.length; i += 1) {
    const c = base[i];
    if (c === '*') { src += '.*'; continue; }
    if (c === '?') { src += '.'; continue; }
    if (c === '[') {
      const close = base.indexOf(']', i + 1);
      if (close < 0) return null;
      src += `[${base.slice(i + 1, close).replace(/\\/g, '\\\\')}]`;
      i = close;
      continue;
    }
    src += c.replace(/[.+^${}()|\\\]]/, '\\$&');
  }
  return entries.some((e) => new RegExp(`^${src}$`).test(e));
}

function isZsh() { return /(^|\/)zsh$/.test(process.env.SHELL || ''); }

// A glob that the shell will NOT abort on even when it matches nothing, so the check must stay
// silent. `noglob` turns globbing off for the command; `setopt nonomatch` / `unsetopt nomatch`
// turn the NOMATCH abort off for the shell. In all three the "zsh aborts the whole command line"
// premise is simply false.
function nomatchDisabled(stripped) {
  return /\bnoglob\b/.test(stripped)
    || /\bsetopt\s+(?:no_?nomatch)\b/i.test(stripped)
    || /\bunsetopt\s+nomatch\b/i.test(stripped);
}

// A zsh glob qualifier — `src/*.js(N)`, `(.)`, `(om[1])` — changes the outcome: `(N)` (NULL_GLOB)
// makes an unmatched pattern expand to nothing rather than abort. bareTokens splits on `(`, so the
// qualifier is gone by the time a token is judged; detect it on the raw command instead. A glob
// immediately followed by `(` carries a qualifier and must not be reported.
function hasGlobQualifier(stripped, raw) {
  let idx = stripped.indexOf(raw);
  while (idx !== -1) {
    if (stripped[idx + raw.length] === '(') return true;
    idx = stripped.indexOf(raw, idx + 1);
  }
  return false;
}

function checkGlob(cmd, cwd) {
  if (!isZsh()) return null;
  const map = varMap(cmd);
  const { stripped } = splitHeredocs(cmd);
  if (nomatchDisabled(stripped)) return null;
  const cwdEff = effectiveCwd(cmd, cwd, map);
  // A cwd this file could not verify makes every relative pattern under it look unmatched.
  if (!fs.existsSync(cwdEff)) return null;
  for (const raw of bareTokens(stripped)) {
    // `*` only. A lone `?` is punctuation far more often than it is a pattern — every real
    // `no matches found` failure in the captured corpus used a star.
    if (!raw.includes('*') || raw.startsWith('-')) continue;
    // Without a separator this is almost always a pattern meant for the current directory, and the
    // tokeniser's confidence in it is lowest. A path-shaped glob is the one that kills pipelines.
    if (!raw.includes('/')) continue;
    // Quoting debris means the tokeniser lost its place; drop the token rather than judge it.
    if (/["'`<>|\s]/.test(raw)) continue;
    // A glob qualifier (e.g. `(N)`) changes what the shell does on no match; do not judge it.
    if (hasGlobQualifier(stripped, raw)) continue;
    const t = expand(raw, map);
    if (!resolved(t) || !GLOB.test(t)) continue;
    if (globMatches(t, cwdEff) === false) {
      return { check: 'glob', subject: t, say: `no file matches \`${safePath(t)}\` — zsh aborts the whole command line on an unmatched glob` };
    }
  }
  return null;
}

// ── check · a bare specifier with no node_modules above it ──────────────────────────────────────
//
// The failure this prevents is `Cannot find module 'better-sqlite3'` from a scratchpad directory —
// the most-repeated cross-session failure on this machine and, as a fact, the heaviest thing in the
// practice store. As a check it needs no store at all.

// A template literal in a `node -e` is almost always a FIXTURE — a snippet of some other
// project's source handed to the extractor — not something this process will resolve. Leaving
// them in produced findings for `@nestjs/common`, `vue` and `vue-property-decorator` on commands
// that were never going to load them.
function stripTemplates(text) {
  return String(text).replace(/`(?:\\.|[^`\\])*`/g, '``');
}

// `from '<x>'` on its own was dropped: it matches English prose in a markdown or Python heredoc
// ("copied from 'built'"), which is where two of the wrong findings in the first pass came from.
// An import statement has to start a line.
function specifiersOf(text) {
  const body = stripTemplates(text);
  const out = new Set();
  const res = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+[^'"\n;]*\bfrom\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    // Not `@import("std")`: a zig sample string inside a `.js` fixture matched the bare form and
    // reported `std` as a missing package.
    /(?<![\w@$.])import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(body)) !== null) {
      const s = m[1];
      if (s.startsWith('.') || s.startsWith('/') || s.startsWith('node:')) continue;
      const pkg = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
      if (!pkg || BUILTINS.has(pkg) || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg)) continue;
      out.add(pkg);
    }
  }
  return [...out];
}

// The nearest ancestor that HAS a node_modules, or null. The finding's wording turns on this:
// "no node_modules above it" is a different problem from "installed tree exists, package absent",
// and the second is the common one. Reporting the first when the second is true sends the reader
// to run `npm install` in a directory that already has one.
function modulesRoot(base) {
  let dir = base;
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(path.join(dir, 'node_modules'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function hasModule(base, pkg) {
  let dir = base;
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(path.join(dir, 'node_modules', pkg))) return true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

// node resolves from the directory of the file doing the requiring, so a heredoc written into a
// scratchpad is judged from the scratchpad — not from the cwd the agent happens to be standing in,
// which is usually the checkout and would make every one of these look fine.
const JS_TARGET = /\.(?:js|cjs|mjs|jsx|ts|tsx|mts|cts)$/;
// A specifier only matters if something is going to try to load it. A heredoc that writes a `.zig`
// or `.vue` fixture, and a `grep` whose PATTERN happens to contain `require('express')`, are not
// about to resolve anything — and both produced wrong findings before this gate existed.
const RUNS_NODE = /(?:^|[\n;&|]|&&)\s*(?:npx\s+)?(?:node|vitest|tsx|ts-node)\b/;

// The script text of `node -e '…'` / `node --eval "…"`, quoting respected. Written without a
// nested quantifier on purpose: `(?:\S+\s+)*?(-e|--eval)` backtracks catastrophically on the
// multi-kilobyte one-liners an agent actually writes, and this runs before every command.
function evalScripts(cmd) {
  const out = [];
  const re = /(?:^|\s)(?:-e|--eval)\s+(['"])/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const q = m[1];
    let i = m.index + m[0].length;
    let buf = '';
    for (; i < cmd.length; i += 1) {
      if (cmd[i] === '\\') { buf += cmd[i + 1] || ''; i += 1; continue; }
      if (cmd[i] === q) break;
      buf += cmd[i];
    }
    out.push(buf);
  }
  return out;
}

const SCRIPT_MAX = 512 * 1024;

// A test file is not a script whose specifiers are about to be resolved — it is fixtures and
// assertions, and the package names invented inside it are props. runFiles carried this rule from
// the day the check went live; the heredoc branch below did NOT, and writing this very test file
// with a heredoc made the check report express's requires as missing. Same rule, one definition,
// because that is the trap: a fix applied to one route is not applied to its sibling.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// The script argument of a plain `node` invocation. Deliberately a two-step scan rather than one
// regex with a nested quantifier — see evalScripts.
//
// `node` only, and never a test file. A test runner's argument is not a script whose specifiers
// are about to be resolved — it is a file full of fixtures and assertions, and the first thing
// this check did once it was live was read its own test file and report the two package names
// invented inside it.
//
// The script argument is POSITIONAL, and scanning past it for anything ending in `.js` is how this
// check produced its first false positive on a real command. `node cli.js remember "do not edit
// lib/express.js" --file lib/express.js` walked over `remember` and the opening quote, found
// `lib/express.js` inside an argument that is prose, read express's real source, and reported its
// four requires missing — from a repository that is not being loaded at all. So: skip the flags,
// take the first token in script position, and if that token is not JS-shaped there is no script
// here to read. Abstention over a guess, which is the rule this whole file is built on.
const VALUE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import',
  '--loader', '--experimental-loader', '--conditions', '-C']);

function runFiles(cmd) {
  const out = [];
  const re = /(?:^|[\n;&|]|&&)\s*node\s([^\n;&|]*)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const words = m[1].split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i];
      if (w.startsWith('-')) {
        // `-r dotenv/config app.js`: the value is not the script, and treating it as one would
        // stop the scan one token early and lose a real script.
        if (VALUE_FLAGS.has(w)) i += 1;
        continue;
      }
      const bare = w.replace(/^["']|["']$/g, '');
      // `node $K` is the common shape and the token in script position carries no extension yet,
      // so shape is judged AFTER expansion in resolutionBases. Deciding it here would either drop
      // every variable-held script or, as before, walk past it into the arguments.
      if (/[$~]/.test(bare) || /\.(?:js|cjs|mjs)$/.test(bare)) out.push(bare);
      break;
    }
  }
  return out;
}

function resolutionBases(cmd, cwdEff, map) {
  const { heredocs } = splitHeredocs(cmd);
  const bases = [];
  const runs = RUNS_NODE.test(cmd);
  for (const h of heredocs) {
    if (!h.target || !runs) continue;
    const t = expand(h.target, map);
    if (!resolved(t) || !JS_TARGET.test(t) || TEST_FILE.test(t)) continue;
    const specs = specifiersOf(h.body);
    if (!specs.length) continue;
    bases.push({ base: path.dirname(path.resolve(cwdEff, t)), specs });
  }
  for (const script of (runs ? evalScripts(cmd) : [])) {
    const specs = specifiersOf(script);
    if (specs.length) bases.push({ base: cwdEff, specs });
  }
  // `node path/to/thing.js`, where the script was written by an EARLIER command. Reading it is
  // the only way to see its requires, and node is about to read the same bytes anyway — but it is
  // the one I/O this file does beyond a stat, so it is capped and it never leaves the happy path.
  for (const t of runFiles(cmd)) {
    const p = expand(t, map);
    if (!resolved(p) || !/\.(?:js|cjs|mjs)$/.test(p) || TEST_FILE.test(p)) continue;
    const abs = path.resolve(cwdEff, p);
    let src;
    try {
      if (fs.statSync(abs).size > SCRIPT_MAX) continue;
      src = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    const specs = specifiersOf(src);
    if (specs.length) bases.push({ base: path.dirname(abs), specs });
  }
  return bases;
}

function checkModules(cmd, cwd) {
  const map = varMap(cmd);
  const cwdEff = effectiveCwd(cmd, cwd, map);
  const missing = [];
  for (const { base, specs } of resolutionBases(cmd, cwdEff, map)) {
    // A base that does not exist yet is not evidence of anything; `mkdir -p` may be two words away.
    if (!fs.existsSync(base)) continue;
    for (const s of specs) if (!hasModule(base, s) && !missing.some((x) => x.pkg === s)) missing.push({ pkg: s, base });
  }
  if (!missing.length) return null;
  const names = missing.map((m) => neutralise(m.pkg, 60)).join(', ');
  const root = modulesRoot(missing[0].base);
  return {
    check: 'module',
    subject: names,
    say: root
      ? `\`${names}\` is not installed under ${safePath(root)}/node_modules`
      : `\`${names}\` does not resolve from ${safePath(missing[0].base)} — no node_modules above it`,
  };
}

// ── check · a git worktree with no node_modules ─────────────────────────────────────────────────
//
// The documented trap: an agent worktree needs node_modules symlinked or the extractors cannot
// resolve their WASM and the suite shows ~243 phantom failures. It is not the same finding as the
// one above — node's own resolution walks up out of `.claude/worktrees/<x>/` into the checkout's
// node_modules and succeeds, so the specifier check is silent while the run is still broken.
// A worktree's `.git` is a FILE, not a directory, which is exactly what identifies one.

const NODE_RUNNER = /(?:^|[\n;&|]|&&)\s*(?:npx|npm|node|pnpm|yarn|vitest)\b/;

function worktreeRoot(dir) {
  let d = dir;
  for (let i = 0; i < 64; i += 1) {
    const dotgit = path.join(d, '.git');
    try { if (fs.statSync(dotgit).isFile()) return d; } catch { /* not here */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function checkWorktree(cmd, cwd) {
  if (!NODE_RUNNER.test(cmd)) return null;
  const map = varMap(cmd);
  const cwdEff = effectiveCwd(cmd, cwd, map);
  if (!fs.existsSync(cwdEff)) return null;
  const root = worktreeRoot(cwdEff);
  if (!root || fs.existsSync(path.join(root, 'node_modules'))) return null;
  return {
    check: 'worktree',
    subject: root,
    say: `${safePath(root)} is a git worktree with no node_modules — symlink the main checkout's before running node here`,
  };
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────

const CHECKS = [checkGlob, checkModules, checkWorktree];

function findings(cmd, cwd) {
  const out = [];
  for (const fn of CHECKS) {
    let r = null;
    // A check that throws is a check that abstains. Nothing here is worth failing a tool call for.
    try { r = fn(cmd, cwd); } catch { r = null; }
    if (r) out.push(r);
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

// The command is echoed back neutralised and truncated for the same reason preflight.js does it:
// what lands in an agent's context is data, and an imperative sentence inside it must not read as
// a directive from the harness.
function render(cmd, hits) {
  const lines = [
    '⚠ Practice graph — precondition check (current state, not a memory):',
    ...hits.map((h) => `  · ${h.say}`),
    `  on \`${neutralise(String(cmd).replace(/\s+/g, ' '), CMD_MAX)}\``,
  ];
  return lines.join('\n');
}

// Returns the text to inject, or null. Null is the common answer and is the correct one.
function preconditions(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  const cmd = input.tool_input && input.tool_input.command;
  if (!cmd || typeof cmd !== 'string') return null;
  const cwd = input.cwd || process.cwd();
  const hits = findings(cmd, cwd);
  return hits.length ? render(cmd, hits) : null;
}

module.exports = {
  preconditions, findings, checkGlob, checkModules, checkWorktree, render, evalScripts, runFiles, resolutionBases,
  varMap, expand, bareTokens, splitHeredocs, specifiersOf, effectiveCwd, globMatches,
  worktreeRoot, isZsh, modulesRoot, MAX_FINDINGS, BUILTINS,
};
