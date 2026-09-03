'use strict';

const fs = require('fs');
const path = require('path');

const { repoIdentity, repoNameOf } = require('./repo-identity');
const { statedLaws } = require('./context-brief');
const { neutralise } = require('./untrusted');

// Auto-delivery in EVERY agent, with no dependency on any agent's hook system. Every coding agent
// already loads one thing unconditionally: its own rules file (AGENTS.md, .cursor/rules/*.mdc,
// .windsurfrules, .clinerules, .github/copilot-instructions.md, CLAUDE.md, GEMINI.md). That file IS
// the universal delivery bus. This module renders the current rulebook — the repo-grain laws that
// are still live and uncontradicted — into a delimited block in each of those files, so the agent
// delivers koragraph's memory the same way it delivers any instruction: by reading its own file.
//
// The value over a hand-maintained file is the ONE thing that file cannot do: this block is
// regenerated from the store, so a rule that expired when its code changed simply stops appearing
// here on the next sync. The file self-heals; the developer never edits it.
//
// Two shapes of target. An OWNED file (Cursor/Cline dedicated rule files) is a whole file koragraph
// writes and can freely overwrite. A SHARED file (AGENTS.md and the rest) holds the developer's own
// content too, so koragraph only ever rewrites what is between its markers and never touches the
// rest.

const MARK_START = '<!-- koragraph:start — auto-generated rulebook. Edits inside this block are overwritten. -->';
const MARK_END = '<!-- koragraph:end -->';
const BLOCK_RE = /<!-- koragraph:start[\s\S]*?<!-- koragraph:end -->\n?/;

const MAX_RULES = 200;

// Every agent target this product knows how to write, keyed by an --agent name. `owned` files are
// written whole (with any frontmatter the format needs); the rest get a managed block. `always`
// files are created even when absent (the universal ones); the others are written only when the
// developer already uses that agent, detected by the file or its directory being present.
const TARGETS = [
  { agent: 'agents', file: 'AGENTS.md', owned: false, always: true },
  { agent: 'claude', file: 'CLAUDE.md', owned: false, always: false },
  { agent: 'cursor', file: '.cursor/rules/koragraph.mdc', owned: true, dir: '.cursor', frontmatter: true },
  { agent: 'cline', file: '.clinerules/koragraph.md', owned: true, dir: '.clinerules' },
  { agent: 'windsurf', file: '.windsurfrules', owned: false, always: false },
  { agent: 'copilot', file: '.github/copilot-instructions.md', owned: false, always: false },
  { agent: 'gemini', file: 'GEMINI.md', owned: false, always: false },
];

// Deliberately uncapped (MAX_RULES=200 is a query-performance ceiling, not a display cap): every
// LIVE, uncontradicted repo-grain law shows, in full. The fix for a bloated rulebook is sorting
// each rule to the right layer — anchor it to a file/symbol if it CAN be anchored, so it delivers
// through node-traversal instead; only what genuinely can't be anchored belongs here — not hiding
// entries from a well-sorted repo's own file behind a "+N more" line.
function rulebookLines(db, { repoId, now }) {
  const laws = statedLaws(db, { repoId, now, limit: MAX_RULES });
  return laws.map((l) => `- ${neutralise(l.body, 300)}`);
}

// Session-start delivery for anything with nowhere else to be delivered. Node-traversal delivery
// covers anything with a real anchor; what it cannot cover is a temporary situation with no node
// to attach to, or one the session simply never visits. Reuses the exact size discipline
// MAX_LOOPS_SHOWN/LOOP_CHARS already define in context-brief.js rather than inventing new numbers.
//
// Shows every open loop, capped, not just repo-grain ones — cheap (short sentences, small cap) and
// guards against a session that never visits the node an anchored loop is waiting on. A genuinely
// noisy result is the signal to narrow this to repo-grain-only later.
function openLoopLines(db, { repoId, cwd }) {
  const { listOpen } = require('./open-loops');
  const { MAX_LOOPS_SHOWN, LOOP_CHARS } = require('./context-brief');
  const open = listOpen(db, { repoId, cwd, limit: 200 })
    .sort((a, b) => (b.mentions || 0) - (a.mentions || 0)
      || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!open.length) return [];

  const lines = [];
  let spent = 0;
  let shown = 0;
  for (const loop of open) {
    if (shown >= MAX_LOOPS_SHOWN) break;
    const line = `- ${neutralise(loop.body, 200)}`;
    if (shown && spent + line.length > LOOP_CHARS) break;
    spent += line.length;
    shown += 1;
    lines.push(line);
  }
  if (open.length > shown) lines.push(`- … ${open.length - shown} more — \`koragraph practice loops\` for the rest`);
  return lines;
}

// Rituals are delivered here, not only through the hook: the hook is Claude-Code-specific
// infrastructure (a `UserPromptSubmit` handler wired in `.claude/settings.json`), so an agent
// using a different harness — or one running with hooks off — would never see them there. This
// file is read by any agent, hook or no hook, the same way the rules and notes sections already
// are. Purely mechanical and
// unconditional (mineRituals takes no prompt — nothing here is guessed from what the developer just
// said), so it belongs with the rules/notes sections rather than the corrections tripwire, which is
// the one piece of hook behavior that actually needs live prompt text and stays hook-only.
// No "+N more" line: unlike a law or a note, a ritual is recoverable by trying the command, so
// dropping the rest below the cap costs nothing the way silently dropping a rule or a note would.
function ritualLines(db, { repoId, repoRoot }) {
  const { mineRituals } = require('./rituals');
  const { MAX_RITUALS_SHOWN, MAX_RITUAL_CHARS } = require('./context-brief');
  const rituals = mineRituals(db, { repoId, repoRoot, limit: MAX_RITUALS_SHOWN });
  if (!rituals.length) return [];

  const lines = [];
  let spent = 0;
  for (const r of rituals) {
    const line = `- \`${neutralise(r.form, 100)}\` — ${r.passes} ok, ${r.fails} failed`;
    if (lines.length && spent + line.length > MAX_RITUAL_CHARS) break;
    spent += line.length;
    lines.push(line);
  }
  return lines;
}

// The inner content — the rules themselves plus a one-line note that names what makes this different
// from a static file. Empty is a valid, meaningful state: it means every rule this repo had has
// expired, and the block should say so rather than leave a stale list behind.
// The usage primer is the whole point of writing to a file the agent ALREADY loads: MCP server
// instructions are advisory and read once, so an agent falls back to grep; a directive in the
// always-loaded rules file is in context every turn, next to the conventions the agent already
// obeys. Kept short because it is paid on every turn. Present even with zero rules, because the graph
// tools are useful from the first minute, before any memory has accumulated.
const USAGE_PRIMER = [
  'USE KORAGRAPH AND KORAMEMORY. This repo has a resolved code graph and durable, code-anchored',
  'memory as MCP tools — reach for them before grep, Read, or code comments. Each tool\'s own',
  'description carries the details; use this as the index:',
  '- `overview` — what matters in this repo when you have no name to start from.',
  '- `explore` — start here for the code itself, before grep/Read/find.',
  '- `search_code` — find a declaration by name, path, or description of what it does.',
  '- `file_symbols` — everything in one file, with line ranges, without reading it.',
  '- `neighbours` — what calls this symbol, and what it calls.',
  '- `blast_radius` — what depends on the files you are about to edit, and what is untested.',
  '- `changes_with` — what tends to be edited in the same commit (mined from git history).',
  '- `recall` — what past sessions learned here (hazards, fixes, stated rules); call it before you start on unfamiliar code or answer "what should I watch out for / is this safe to change".',
  '- `remember` — THE WRITER, and the one tool you must reach for WITHOUT being asked. The moment the',
  '  developer says something worth keeping, CALL remember IN THE SAME TURN. Do NOT just reply "noted"',
  '  or "saved" in prose — prose saves nothing; only a remember call does. Two triggers: (a) an EXPLICIT',
  '  ask — "save this", "remember that", "note that down", "jot this down", "keep this in mind",',
  '  "remind me to …", "save that for wednesday"; and (b) a rule / preference / hazard / correction',
  '  dropped in passing while asking for other work. WHEN IN DOUBT, CAPTURE IT — a stray save costs one',
  '  line; a dropped one is gone next session. Route it by what it is:',
  '    • a rule/hazard/correction about specific code → pass `symbol` or `file` to anchor it (it expires',
  '      when that code changes). e.g. remember("never console.log in the mcp path", file:"src/mcp/start.js").',
  '    • a repo-wide rule with no single anchor → a plain durable fact. e.g. "prefer pnpm over npm",',
  '      "always lint before commit", "node 22 is the minimum".',
  '    • a deferral / reminder / "save this for later, wednesday, tomorrow" → kind:"open_loop". e.g.',
  '      remember("pick the payments refactor back up wednesday", kind:"open_loop").',
  '  NEVER let a "save this / remember that / for wednesday" pass without a remember call — that exact',
  '  case is the whole reason this memory layer exists.',
].join('\n');

function renderBody(lines, loopLines = [], ritualLines = []) {
  const header = 'Repository rules, maintained by koragraph. These are anchored to the code and are '
    + 'removed automatically when the code they describe changes — do not edit by hand.';
  const preamble = `${USAGE_PRIMER}\n\n${header}`;
  let body = lines.length
    ? `${preamble}\n\n${lines.join('\n')}`
    : `${preamble}\n\n_No active repository rules yet. State one with the koragraph \`remember\` tool._`;
  // Rituals and temporary notes are both dropped entirely when empty, rather than a permanent empty
  // heading nobody asked to see. Kept as two clearly separate headers rather than merged into one
  // list — a ritual is a mechanically-counted observation ("this command has worked N times"), a
  // note is the developer's own word ("hold off on this for now"); collapsing them into one
  // undifferentiated list would blur exactly the distinction their separate provenance exists to
  // preserve.
  if (ritualLines.length) {
    const ritualsHeader = 'How this repo runs things — command shapes that have actually succeeded '
      + 'here, counted, not guessed. Self-updating; do not hand-maintain.';
    body = `${body}\n\n${ritualsHeader}\n\n${ritualLines.join('\n')}`;
  }
  if (loopLines.length) {
    const notesHeader = 'Temporary notes — situational, not rules; resolved with `koragraph practice '
      + 'resolve` and dropped from here automatically once closed.';
    body = `${body}\n\n${notesHeader}\n\n${loopLines.join('\n')}`;
  }
  return body;
}

function blockFor(body) {
  return `${MARK_START}\n${body}\n${MARK_END}\n`;
}

// Owned files carry the whole content (Cursor needs frontmatter with alwaysApply so it is always in
// context). A shared file keeps the block form so the developer's own rules above/below survive.
function fileContents(target, body, existing) {
  if (target.owned) {
    const fm = target.frontmatter
      ? '---\ndescription: Repository conventions, auto-maintained by koragraph\nalwaysApply: true\n---\n\n'
      : '';
    return `${fm}${body}\n`;
  }
  const block = blockFor(body);
  const prior = existing || '';
  if (BLOCK_RE.test(prior)) return prior.replace(BLOCK_RE, block);
  // Append, keeping one blank line from any existing content.
  return prior ? `${prior.replace(/\s*$/, '')}\n\n${block}` : block;
}

// `maintainOnly` is the ingest-tail mode: refresh files koragraph ALREADY manages, but never create
// a new one — an ingest silently adding AGENTS.md to a repo would be a surprise. A file is
// already-managed if it is an owned file that exists, or a shared file that already carries the
// block.
function shouldWrite(target, root, maintainOnly) {
  const abs = path.join(root, target.file);
  if (maintainOnly) {
    if (!fs.existsSync(abs)) return false;
    if (target.owned) return true;
    try { return BLOCK_RE.test(fs.readFileSync(abs, 'utf8')); } catch { return false; }
  }
  if (target.always) return true;
  if (fs.existsSync(abs)) return true;
  if (target.dir && fs.existsSync(path.join(root, target.dir))) return true;
  return false;
}

// Render the rulebook into the agent files this repo uses. `only` (an --agent name) forces exactly
// one target, created if absent. Returns the list of files written with what happened to each, so
// the caller can report it — legibility is a first-class requirement here.
function syncRepo(db, {
  cwd = process.cwd(), only = null, maintainOnly = false, now = new Date(),
} = {}) {
  const { repoRoot, repoId } = repoIdentity(cwd);
  if (!repoId) return { ok: false, reason: 'not inside a git repository', written: [] };
  const root = repoRoot || cwd;

  const body = renderBody(
    rulebookLines(db, { repoId, now }),
    openLoopLines(db, { repoId, cwd: root }),
    ritualLines(db, { repoId, repoRoot: root }),
  );
  const chosen = only
    ? TARGETS.filter((t) => t.agent === only)
    : TARGETS.filter((t) => shouldWrite(t, root, maintainOnly));
  if (only && !chosen.length) {
    return { ok: false, reason: `unknown agent "${only}"`, written: [] };
  }

  const written = [];
  for (const target of chosen) {
    const abs = path.join(root, target.file);
    let existing = null;
    try { existing = fs.readFileSync(abs, 'utf8'); } catch { existing = null; }
    const next = fileContents(target, body, existing);
    if (next === existing) { written.push({ file: target.file, agent: target.agent, status: 'unchanged' }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    written.push({ file: target.file, agent: target.agent, status: existing == null ? 'created' : 'updated' });
  }
  return {
    ok: true, repo_id: repoId, rule_count: rulebookLines(db, { repoId, now }).length,
    open_note_count: openLoopLines(db, { repoId, cwd: root }).length,
    ritual_count: ritualLines(db, { repoId, repoRoot: root }).length,
    written,
  };
}

module.exports = {
  syncRepo, renderBody, rulebookLines, openLoopLines, ritualLines, TARGETS, MARK_START, MARK_END, BLOCK_RE,
};
