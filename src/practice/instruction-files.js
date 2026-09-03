'use strict';

const fs = require('fs');
const path = require('path');

const { NEVER_WALK_DIRS, loadIgnorePatterns } = require('../services/ingest-policy');

// /korainit reads the instruction files a developer already wrote — CLAUDE.md, AGENTS.md,
// .cursorrules — and turns each concrete rule into an anchored, expiring fact. This module is the
// reading half only: it finds the files, cuts them into candidate rules, and says what each rule
// looks like. Nothing here writes to practice.db and nothing here calls a model; the host agent
// does the judging and calls `remember`.
//
// NOT a hook-path module. It requires ingest-policy.js (js-yaml, git ls-files) for the ignore
// helper, which is fine on a CLI verb and would not be on PreToolUse.

// Filenames a coding agent actually loads as standing instructions. The line drawn here is
// "text an agent is told to obey", not "file a tool reads":
//   * `.aider.conf.yml` is deliberately absent — it is aider's configuration (model, api keys,
//     auto-commit), not prose the agent follows. `.aider.conf.yml` in this list would import
//     settings as rules.
//   * `.cursor/rules/*.mdc` is the current Cursor form and `.cursorrules` the deprecated one;
//     both ship in real repos, so both are here.
//   * `.clinerules` exists as both a file and a directory of `.md` files.
//   * `.github/copilot-instructions.md` is path-exact — Copilot only reads that one location.
const INSTRUCTION_FILENAMES = Object.freeze([
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.cursor/rules/*.mdc',
  '.windsurfrules',
  '.clinerules',
  '.clinerules/*.md',
  '.github/copilot-instructions.md',
]);

const BY_BASENAME = new Map([
  ['CLAUDE.md', 'claude'],
  ['CLAUDE.local.md', 'claude'],
  ['AGENTS.md', 'agents'],
  ['GEMINI.md', 'gemini'],
  ['.cursorrules', 'cursor'],
  ['.windsurfrules', 'windsurf'],
  ['.clinerules', 'cline'],
]);

const CURSOR_RULE_RE = /(?:^|\/)\.cursor\/rules\/[^/]+\.mdc$/;
const CLINE_RULE_RE = /(?:^|\/)\.clinerules\/[^/]+\.md$/;
const COPILOT_RE = /(?:^|\/)\.github\/copilot-instructions\.md$/;

const SKIP_DIRS = new Set([
  ...NEVER_WALK_DIRS,
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  '__pycache__', '.venv', '.next', '.cache',
]);

const MAX_DEPTH = 8;

function findInstructionFiles(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : MAX_DEPTH;
  const ignore = opts.respectGitignore === false ? [] : ignorePatterns(root);
  const found = [];

  const walk = (dir, relBase, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;                  // never followed: loop safety
      if (ignore.some((p) => p.test(rel))) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= maxDepth) continue;
        // A nested checkout carries its own CLAUDE.md, and agent worktrees under
        // .claude/worktrees/ are full copies of this repo — descending into one imports the same
        // rules several times over. A worktree's `.git` is a FILE, so test existence, not isDir.
        if (fs.existsSync(path.join(dir, entry.name, '.git'))) continue;
        walk(path.join(dir, entry.name), rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const match = matchInstructionFile(rel);
      if (!match) continue;
      const abs = path.join(dir, entry.name);
      let bytes = null;
      try { bytes = fs.statSync(abs).size; } catch (_) { continue; }
      found.push({ path: rel, abs, bytes, kind: match.kind, scope: match.scope });
    }
  };

  walk(root, '', 0);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

// `scope` is the directory the file's rules govern, not the directory the file sits in. A nested
// CLAUDE.md/AGENTS.md governs its own subtree — that is the whole point of nesting — while
// `.cursor/rules/` and `.github/copilot-instructions.md` are repo-wide files that merely live in a
// tool's config directory. Getting this backwards would anchor repo-wide rules to `.github`.
function matchInstructionFile(rel) {
  if (COPILOT_RE.test(rel)) return { kind: 'copilot', scope: '.' };
  if (CURSOR_RULE_RE.test(rel)) return { kind: 'cursor', scope: '.' };
  if (CLINE_RULE_RE.test(rel)) return { kind: 'cline', scope: '.' };

  const slash = rel.lastIndexOf('/');
  const base = slash < 0 ? rel : rel.slice(slash + 1);
  const kind = BY_BASENAME.get(base);
  if (!kind) return null;
  return { kind, scope: slash < 0 ? '.' : rel.slice(0, slash) };
}

function ignorePatterns(root) {
  try {
    return loadIgnorePatterns(root) || [];
  } catch (_) {
    return [];
  }
}

// ─── Segmentation ─────────────────────────────────────────────────────────────

const MIN_SEGMENT = 15;
const MAX_SEGMENT = 500;
const MAX_QUOTE_LINES = 3;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(```|~~~)/;
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/;

function segmentInstructions(markdownText) {
  const lines = String(markdownText || '').split(/\r?\n/);
  const segments = [];
  const headings = [];
  let i = 0;

  const push = (text, line) => {
    const cleaned = cleanSegment(text);
    if (cleaned.length < MIN_SEGMENT || cleaned.length > MAX_SEGMENT) return;
    segments.push({ text: cleaned, heading: headings.map((h) => h.text).join(' > '), line });
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (FENCE_RE.test(line)) {
      const marker = line.slice(0, 3);
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) i += 1;
      i += 1;
      continue;
    }
    if (!line) { i += 1; continue; }
    if (RULE_RE.test(line)) { i += 1; continue; }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, text: cleanSegment(heading[2]) });
      i += 1;
      continue;
    }

    if (isTableLine(line)) {
      while (i < lines.length && isTableLine(lines[i].trim())) i += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const start = i;
      const quoted = [];
      while (i < lines.length && (lines[i].trim().startsWith('>') || (quoted.length && lines[i].trim()))) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      // A long blockquote in an instruction file is an aside — a citation, a caveat, a quoted
      // measurement — not a rule. A short one usually is a rule someone wanted to emphasise.
      if (quoted.length <= MAX_QUOTE_LINES) {
        const body = quoted.filter((l) => l && !isTableLine(l)).join(' ');
        for (const sentence of splitSentences(body)) push(sentence, start + 1);
      }
      continue;
    }

    const item = line.match(LIST_RE);
    if (item) {
      const start = i;
      const parts = [item[2]];
      i += 1;
      // A following list item is the NEXT rule, never a continuation of this one. Without the
      // LIST_RE guard a five-bullet Traps section became one segment: one fact carrying five
      // unrelated rules, anchorable to at most one of the symbols they name, and unable to expire
      // independently. The paragraph branch below already had this guard; this branch did not.
      while (i < lines.length && isContinuation(lines[i]) && !LIST_RE.test(lines[i].trim())) {
        parts.push(lines[i].trim());
        i += 1;
      }
      push(parts.join(' '), start + 1);
      continue;
    }

    const start = i;
    const parts = [];
    while (i < lines.length && isContinuation(lines[i]) && !LIST_RE.test(lines[i])) {
      parts.push(lines[i].trim());
      i += 1;
    }
    if (!parts.length) { i += 1; continue; }
    for (const sentence of splitSentences(parts.join(' '))) push(sentence, start + 1);
  }

  return segments;
}

function isContinuation(raw) {
  const line = raw.trim();
  if (!line) return false;
  if (HEADING_RE.test(line) || FENCE_RE.test(line) || RULE_RE.test(line)) return false;
  if (line.startsWith('>') || isTableLine(line)) return false;
  return true;
}

function isTableLine(line) {
  if (line.startsWith('|')) return true;
  return line.includes('|') && /^[|\s:-]+$/.test(line);
}

function cleanSegment(text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A period after one of these is not a sentence boundary. Without the guard, "see Fig. 2. Then"
// and "e.g. a rename" both split mid-rule and each half falls under MIN_SEGMENT.
const ABBREV_RE = /(?:\b(?:e\.g|i\.e|etc|vs|cf|al|approx|Inc|No|Dr|Mr|Ms|Fig|§\s?\d+)\.)["'`)\]]*$/i;

function splitSentences(text) {
  const out = [];
  const re = /([.!?])(["'`)\]]*)\s+(?=[A-Z"'`(\[*_§])/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    const head = text.slice(start, re.lastIndex).trim();
    if (ABBREV_RE.test(head)) continue;
    out.push(head);
    start = re.lastIndex;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// ─── Classification ───────────────────────────────────────────────────────────

// Bare `fail`, `stale` and `wrong` were tried and removed: a doc that CORRECTS a stale claim, or
// reports that a run failed, is prose about the past, not a warning about the present. `will fail`
// keeps the tense that makes it a warning.
const HAZARD_RE = /\b(never|do not|don'?t|must not|cannot|can'?t|avoid|beware|watch out|traps?|gotchas?|pitfalls?|breaks?|broken|will fail|fails? silently|silently|corrupts?|corrupted|crash(?:es|ed)?|deadlocks?|costs?|dangerous|footgun|be careful|caution|warning|poisons?)\b/i;

const LAW_RE = /\b(always|prefer|must|should|shall|required?|requires|need to|only ever|house (?:rule|style)|instead of|rather than)\b/i;

const IMPERATIVE_LEAD_RE = /^(use|keep|reuse|follow|ensure|make sure|treat|put|name|write|check|read|record|measure|state|apply|wrap|route|store|return|throw|log|test|document|update|remove|delete|rename|add|create|define|declare|implement|handle|validate|verify|start|stop|run|no)\b/i;

const DESCRIPTIVE_RE = /\b(is|are|was|were|has|have|contains?|consists? of|provides?|serves?|lives? in|sits? in|holds?|houses?|powers?|handles|includes?|uses|supports?|built with|written in|responsible for)\b/i;

// A pure cross-reference carries no rule of its own; importing it stores a pointer that expires
// the moment the doc it points at moves.
const CROSS_REF_RE = /^(see|full detail|source|summary|read more|details? in)\b/i;

const COMMAND_LEAD_RE = /^(npm|npx|yarn|pnpm|bun|node|deno|python3?|pip3?|pytest|poetry|uv|go|cargo|rustc|make|cmake|ninja|git|gh|docker|docker-compose|kubectl|helm|terraform|bash|sh|zsh|rake|bundle|mvn|gradle|dotnet|tsc|vitest|jest|mocha|eslint|prettier|ruff|black|flake8|mypy|brew|apt|apt-get|psql|sqlite3|curl|wget|grep|rg|find|sed|awk|xargs|ln|ls|cd|rm|cp|mv|chmod|export|source|koragraph|claude|ingest)\b/;

const SHELL_LINE_RE = /(^|\s)\$\s+\S/;

const FILEISH_RE = /^[\w@.-]+(?:\/[\w@.*-]+)+\/?(?:\*\*)?$/;
const EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|ya?ml|toml|py|go|java|rb|rs|sh|sql|env|lock|cfg|ini|proto|sol|swift|kt|scala|ex|exs|c|h|cpp|hpp|m|mm|vue|mdc)$/i;
const SYMBOL_RE = /^[A-Za-z_$#][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\)|\([^)]*\))?$/;
const SHAPED_RE = /[A-Z].*[a-z]|_|\(\)|\.[a-z]/;

function classifySegment(text) {
  const body = cleanSegment(text);
  const referents = extractReferents(body);
  const kind = kindOf(body, referents);
  return { kind, referents };
}

function kindOf(body, referents) {
  if (body.length < MIN_SEGMENT) return 'skip';
  if (CROSS_REF_RE.test(body)) return 'skip';

  // Hazard outranks ritual on purpose: "Never `git add -A` in the main checkout" names a command
  // but is a warning, not a recipe. Storing it as a ritual would surface it as a step to run.
  if (HAZARD_RE.test(body)) return 'hazard';
  if (referents.commands.length || SHELL_LINE_RE.test(body)) return 'ritual';
  if (LAW_RE.test(body) || IMPERATIVE_LEAD_RE.test(body)) return 'law';

  // A segment that NAMES CODE is specific by definition, and specific instructions are the ones
  // agents follow. Reaching this line it matched no vocabulary — but "`acceptParams` mutates the
  // object it is given" or "`sendFileHandler` swallows ENOENT" are exactly the traps a developer
  // writes a CLAUDE.md for, and they fall into overview or skip because the hazard vocabulary wants
  // "never" / "will fail" / "breaks" and these say "mutates", "swallows", "allocates". No word list
  // closes that gap; the referent does.
  //
  // So a referent is the floor: it is a claim about a named declaration, it can be anchored, and
  // it will expire when that declaration changes — which is what makes keeping it safe. Only
  // prose with NOTHING to anchor to can be an overview.
  if (referents.symbols.length || referents.paths.length) return 'hazard';

  // Repository overviews — "this service is a Go API that talks to Postgres" — are the category
  // /korainit DROPS rather than imports: overviews do not improve agent success and cost more
  // tokens, while specific instructions are followed. Every byte of an overview is paid on every
  // turn for no gain, which is the exact cost the practice layer exists to stop paying. It is
  // classified rather than silently discarded so the import can report how many were dropped and
  // how many tokens that saved.
  if (DESCRIPTIVE_RE.test(body)) return 'overview';
  return 'skip';
}

function extractReferents(text) {
  const symbols = [];
  const paths = [];
  const commands = [];
  const seen = new Set();

  const add = (bucket, value) => {
    const v = value.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    bucket.push(v);
  };

  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    if (!span) continue;
    if (COMMAND_LEAD_RE.test(span) && /\s/.test(span)) { add(commands, span); continue; }
    // `ingest.js:4267` — the line number is a pointer into a version of the file that will not
    // survive the next edit, so it is stripped before the path is used as an anchor.
    const bare = span.replace(/:\d+(?:-\d+)?$/, '');
    if (FILEISH_RE.test(bare) || EXT_RE.test(bare)) { add(paths, bare); continue; }
    if (SYMBOL_RE.test(bare) && SHAPED_RE.test(bare)) add(symbols, bare);
  }

  const plain = text.replace(/`[^`\n]*`/g, ' ');
  // A SLASH is required outside backticks. A bare `name.ext` in prose is far more often a product
  // than a file — "Node.js", "Next.js", "Vue.js", "socket.io" — and reading one as a path made
  // "Express is a fast, minimalist web framework for Node.js" carry a referent, which promoted the
  // one sentence the import exists to drop. A file someone actually means is backticked (handled
  // above, where a bare extension is enough because the backticks are the intent) or written with
  // its directory.
  for (const m of plain.matchAll(/\b[\w@.-]+(?:\/[\w@.*-]+)+\b/g)) add(paths, m[0]);
  for (const m of plain.matchAll(/\b[A-Za-z_$][\w$]*\(\)/g)) add(symbols, m[0]);
  for (const m of plain.matchAll(/\b[A-Z][A-Za-z0-9]*\.[a-z][\w$]*\b/g)) {
    if (!EXT_RE.test(m[0])) add(symbols, m[0]);
  }
  for (const m of plain.matchAll(/\$\s+([^\n;|&]+)/g)) {
    const cmd = m[1].trim();
    if (COMMAND_LEAD_RE.test(cmd)) add(commands, cmd);
  }

  // `src/services/http.js` and `http.js`, or `UserRepo.save` and `save()`, are the same referent
  // seen by two patterns. The qualified form is the one that can be anchored, so the bare form is
  // dropped rather than shipped as a second, weaker candidate.
  return { symbols: dropSubsumed(symbols), paths: dropSubsumed(paths), commands };
}

function dropSubsumed(values) {
  const bare = (v) => v.replace(/\(\)$/, '');
  return values.filter((v) => !values.some((o) => o !== v && bare(o).length > bare(v).length
    && (bare(o).endsWith(bare(v)) || bare(o).startsWith(`${bare(v)}.`))));
}

module.exports = {
  INSTRUCTION_FILENAMES,
  findInstructionFiles,
  segmentInstructions,
  classifySegment,
  extractReferents,
};
