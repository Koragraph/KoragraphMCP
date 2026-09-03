'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { parseCommandArgs, positiveInt } = require('./args');
const { EXIT, cliError, usageError } = require('./errors');

// This command never opens graph.db to READ a fact — the practice store answers on its own. The
// graph is opened, read-only and optionally, by the passes that need resolution (revalidate, seed,
// harvest); their absence degrades to "unknown", never to "gone".
const USES_STORE = false;

const VERBS = Object.freeze({
  remember: 'Record a rule you are stating yourself, anchored to code',
  why: 'What do we believe about a symbol, and on what evidence',
  list: 'Everything known, filterable by repo, kind and tier',
  forget: 'Expire one fact by id — never a hard delete',
  instructions: 'Report the instruction files in this repo and what is importable from them',
  digest: 'What the second layer learned recently',
  audit: 'Three numbers on your stated rules: how many, how many already reference gone code, and the oldest silent staleness',
  harvest: 'Promote lessons from captured events now',
  seed: 'Mine git history for lessons now',
  revalidate: 'Re-check every anchor against the code and expire what no longer exists',
  loops: 'List the open loops (sticky notes) for this repository',
  resolve: 'Close an open loop by id or by restating it — never a hard delete',
  sync: 'Write the live rulebook into your agent files (AGENTS.md, Cursor, Cline, Copilot, …)',
});

const OPTIONS = {
  repo: { type: 'string' },
  file: { type: 'string' },
  symbol: { type: 'string' },
  kind: { type: 'string' },
  agent: { type: 'string' },
  tier: { type: 'string' },
  source: { type: 'string' },
  verified: { type: 'string' },
  note: { type: 'string' },
  'fact-id': { type: 'string' },
  confirm: { type: 'boolean', default: false },
  limit: { type: 'string' },
  days: { type: 'string' },
  since: { type: 'string' },
  reason: { type: 'string' },
  session: { type: 'string' },
  path: { type: 'string' },
  all: { type: 'boolean', default: false },
  expired: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  resolve: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const USAGE = `Usage: koragraph practice <verb> [options]

The second layer: what was learned about this code from watching real work — the attempt that
failed, the fix that worked, the hazard that recurs. Anchored to declarations, and expired when
the code it describes changes.

Verbs:
${Object.entries(VERBS).map(([v, s]) => `  ${v.padEnd(14)}${s}`).join('\n')}

  koragraph practice remember "<rule>"   What you know. Add --symbol/--file to anchor it.
  koragraph practice why <symbol|p#id>  Symbol, "path/to/file.js:symbol", a file path, or the
                                        p#N id printed on every line this product delivers.
  koragraph practice forget <id>         The id printed as [p#<id>] beside every fact.
  koragraph practice instructions        CLAUDE.md, AGENTS.md, .cursorrules and the rest.
  koragraph practice audit [--json]      Three numbers on your stated rules — how many, how many
                                        already reference gone code, and the oldest silent
                                        staleness. Run it after instructions/korainit imports one.
  koragraph practice remember "<note>" --kind open_loop   A sticky note / unfinished task. It
                                        resurfaces (as context, not a rule) until it is done.
  koragraph practice loops               The open loops for this repository.
  koragraph practice resolve <id|text>   Close an open loop — by loop#N or by restating it.
  koragraph practice sync [--agent X]    Write the live rulebook into your agent files so ANY
                                        agent (Cursor, Cline, Copilot, Codex, Claude, …) reads it.
                                        Expired rules drop out on the next ingest automatically.

Options:
  --repo <id>       Restrict to one repository (the normalised git remote).
  --file <path>     Disambiguate a symbol that occurs in more than one file. For remember, the
                    file the rule is about.
  --symbol <name>   remember: the declaration the rule is about.
  --kind <kind>     correction | law | ritual | revert | hazard
                    remember writes one of: law | hazard | ritual | tombstone | correction |
                    open_loop (a sticky note, delivered as context and closed when done)
  --resolve         remember --kind open_loop: mark the loop done instead of opening one.
  --tier <tier>     law | observation   (hypothesis is never shown — see below)
  --source <src>    remember: user (default) | import | hook. Pass import when filing a rule read
                    out of a CLAUDE.md/AGENTS.md rather than one the developer just said.
  --verified <v>    remember, when --source import: confirmed | contradicted | unverifiable — read
                    the code the rule names FIRST, then say what you found. contradicted: stored
                    but withheld until a human settles it. unverifiable: stored below full
                    authority. Omit for your own first-hand observations.
  --note <text>     remember, with --verified contradicted|unverifiable: one sentence on what you
                    found. Shown next to the fact.
  --fact-id <n>     remember: resolve a verdict against an EXISTING fact instead of storing a new
                    one — pair with --confirm (still accurate) or --verified contradicted (no
                    longer accurate). No positional body needed.
  --confirm         remember --fact-id: you read the code behind an "(unconfirmed since …)" flag
                    and it still holds. Clears the flag in place.
  --limit <n>       Maximum results (default 20). For seed, how many commits to scan
                    (default 400).
  --days <n>        Digest window in days (default 7).
  --since <rev>     Seed from this git revision or date onwards.
  --reason <text>   Why you are forgetting a fact. Recorded; it is a signal about our precision.
  --session <id>    Harvest one session instead of every unharvested one.
  --path <dir>      Repository to work against (default: the current directory). Used by seed,
                    remember and instructions.
  --all             Include expired facts, which are retained rather than deleted.
  --expired         Show ONLY expired facts.
  --json            instructions: the machine form, segment text included.
  --dry-run         revalidate: report what would expire and change nothing.
  -h, --help        Show this help.

The store is $KORAGRAPH_PRACTICE_DB, or practice.db under $KORAGRAPH_HOME, or
~/.koragraph/practice.db. It is plain SQLite and yours to inspect with sqlite3.

Two rules worth knowing before you read the output:

  A fact is never deleted, only expired with a reason — orphaned (the code is gone), superseded, or
  user (you rejected it). A rejected fact is itself evidence about how precise this layer is, so it
  is kept. A fact whose anchored code changed body is not expired at all: it is flagged
  "unconfirmed" and left live until an agent that reads the code says whether it still holds
  (practice remember --confirm or --verified contradicted).

  An anchor that cannot be CHECKED is "unknown", and unknown never expires anything. A missing
  repository, a file not yet indexed, or no graph at all look exactly like deletion if you only
  ask the graph — and deleting graph.db is routine.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  const verb = positionals[0];
  if (!verb) throw usageError(`practice needs a verb.\n\n${USAGE}`);
  if (!VERBS[verb]) {
    throw usageError(`practice: unknown verb "${verb}" (expected ${Object.keys(VERBS).join(', ')}).`);
  }
  if (verb === 'why' && !positionals[1]) throw usageError('practice why needs a symbol or a fact id (p#12).');
  if (verb === 'forget' && !positionals[1]) throw usageError('practice forget needs a fact id.');
  // A confirm/contradict-existing call (--fact-id or --confirm) has nothing new to store, so it
  // carries no body positional — the same "resolve a verdict, don't mint a fact" shape the MCP
  // `remember` tool uses.
  if (verb === 'remember' && !positionals[1] && !values['fact-id'] && !values.confirm) {
    throw usageError('practice remember needs the rule to record, in quotes (or --fact-id to confirm/contradict an existing one).');
  }
  if (verb === 'resolve' && !positionals[1]) {
    throw usageError('practice resolve needs a loop id (loop#N) or the loop text to close, in quotes.');
  }
  if (positionals.length > 2) {
    throw usageError(`practice ${verb} takes at most one argument (got ${positionals.length - 1}).`);
  }
  return {
    help: false,
    verb,
    target: positionals[1] || null,
    repo: values.repo || null,
    file: values.file || null,
    symbol: values.symbol || null,
    kind: values.kind || null,
    agent: values.agent || null,
    tier: values.tier || null,
    source: values.source || null,
    verified: values.verified || null,
    note: values.note || null,
    limit: positiveInt(values.limit, '--limit', 20),
    // `seed` reads --limit as a COMMIT SCAN depth while every other verb reads it as "maximum
    // results". With the results default of 20 silently applied, `koragraph practice seed` — the
    // first command the docs tell a user to run — scanned 20 commits, usually found nothing, and
    // printed a message blaming the repository. Recorded so seed can fall back to git-history's own
    // default of 400 instead.
    limitExplicit: values.limit !== undefined,
    days: positiveInt(values.days, '--days', 7),
    since: values.since || null,
    reason: values.reason || null,
    session: values.session || null,
    repoPath: values.path || null,
    all: values.all === true,
    expiredOnly: values.expired === true,
    json: values.json === true,
    dryRun: values['dry-run'] === true,
    resolveFlag: values.resolve === true,
    factId: values['fact-id'] != null ? positiveInt(values['fact-id'], '--fact-id', null) : null,
    confirmFlag: values.confirm === true,
  };
}

// Read verbs must not CREATE the store: "there is nothing recorded yet" is a real answer and it
// should not leave a file behind. Write passes may create it, because they are about to write.
function openPractice(create) {
  const { practiceDbPath } = require('../practice/paths');
  const { openPracticeDb } = require('../practice/db');
  const file = practiceDbPath();
  if (file !== ':memory:' && !create && !fs.existsSync(file)) return { db: null, file };
  return { db: openPracticeDb(), file };
}

// Read-only and optional. `fileMustExist` means an absent graph throws here rather than creating
// one, and every caller treats null as "cannot check", never as "nothing there".
function openGraph() {
  try {
    const { openGraphDb } = require('../practice/resolve');
    return openGraphDb();
  } catch {
    return null;
  }
}

function recordRun(db, kind, summary) {
  const watermark = db.prepare('SELECT max(id) m FROM events').get().m || null;
  db.prepare('INSERT INTO ops_runs (kind, ran_at, event_watermark, summary) VALUES (?,?,?,?)')
    .run(kind, new Date().toISOString(), watermark, JSON.stringify(summary));
}

function workingDir(parsed) {
  return parsed.repoPath ? path.resolve(parsed.repoPath) : process.cwd();
}

function splitTarget(raw) {
  const at = raw.lastIndexOf(':');
  if (at > 0 && !raw.slice(at + 1).includes('/')) {
    return { file: raw.slice(0, at), name: raw.slice(at + 1) };
  }
  if (raw.includes('/') || raw.includes('.')) return { file: raw, name: null };
  return { file: null, name: raw };
}

const FACT_COLS = `f.id AS fact_id, f.kind, f.tier, f.body, f.evidence, f.recurrence, f.source,
                   f.created_at, f.valid_at, f.expired_at, f.expiry_reason, f.expiry_note`;

// contradicted_at arrives with 011 and this store may predate it, so the column is probed and
// substituted with NULL rather than named directly. Naming it on an older store would throw and
// take the whole audit surface down, which is the one surface a developer needs when they already
// suspect something is wrong.
function factCols(db) {
  try {
    return db.prepare("SELECT 1 FROM pragma_table_info('facts') WHERE name = 'contradicted_at'").get()
      ? `${FACT_COLS}, f.contradicted_at, f.contradicted_reason`
      : `${FACT_COLS}, NULL AS contradicted_at, NULL AS contradicted_reason`;
  } catch {
    return `${FACT_COLS}, NULL AS contradicted_at, NULL AS contradicted_reason`;
  }
}

// Hypothesis is excluded structurally, not by a caller remembering to filter: a hypothesis never
// reaches a reader, which is what makes a wrong one free.
function factRows(db, { where, params, limit, all, expiredOnly }) {
  const clauses = ["f.tier IN ('law','observation')", ...where];
  if (expiredOnly) clauses.push('f.expired_at IS NOT NULL');
  else if (!all) clauses.push('f.expired_at IS NULL');
  return db.prepare(
    `SELECT DISTINCT ${factCols(db)} FROM facts f
       LEFT JOIN anchors a ON a.fact_id = f.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.expired_at IS NOT NULL ASC, f.recurrence DESC, f.created_at DESC, f.id DESC
      LIMIT ${Number(limit)}`,
  ).all(params);
}

// One edge, two sentences. `supersedes` and `superseded by` are the same row read from either end,
// and an audit of a fact needs whichever end it is standing on — a reader asking why a rule expired
// is looking for the inbound one, which the outbound wording never gives them.
// `supersedes` is the only edge type any writer in this codebase produces — `contradicts`,
// `caused_by`, and `same_cause` have no writer anywhere, so they are left out rather than mapped
// to phrasing nothing ever emits.
const EDGE_PHRASE = Object.freeze({
  supersedes: { out: 'supersedes', in: 'superseded by' },
});

const EDGE_BODY_CHARS = 120;

function renderFact(db, row, { provenanceOf, oneLine, edgesOf }, { edges = false } = {}) {
  const anchors = db.prepare(
    'SELECT * FROM anchors WHERE fact_id = ? ORDER BY file_path, symbol_name',
  ).all(row.fact_id);
  const p = provenanceOf(row);
  const lines = [];

  const head = anchors.length
    ? (anchors[0].symbol_name ? `${anchors[0].file_path}:${anchors[0].symbol_name}` : anchors[0].file_path)
    : '(no anchor)';
  const seen = row.recurrence > 1 ? `  seen ${row.recurrence}×` : '';
  const dead = row.expired_at
    ? `  EXPIRED ${row.expiry_reason}${row.expiry_note ? ` — ${row.expiry_note}` : ''}` : '';
  // A contradicted fact is live, stored, and NOT delivered. Shown exactly like a healthy one, the
  // listing defeated the reason it is kept rather than expired: the developer settles it, and they
  // cannot settle what they cannot see.
  const disputed = !row.expired_at && row.contradicted_at ? '  WITHHELD' : '';
  lines.push(`[p#${row.fact_id}] ${row.kind}/${row.tier}${seen}${dead}${disputed}`);
  lines.push(`  ${oneLine(row.body, 400)}`);
  lines.push(`  where    ${head}`);
  if (p.when) lines.push(`  when     ${p.when}`);
  if (p.cmd) lines.push(`  command  ${p.cmd}`);
  if (p.error) lines.push(`  error    ${oneLine(p.error, 160)}`);
  if (p.commits.length) lines.push(`  commit   ${p.commits.map((c) => c.slice(0, 12)).join(', ')}`);
  if (p.session_id) lines.push(`  session  ${p.session_id}${p.agent_id ? ` (agent ${p.agent_id})` : ''}`);
  if (row.source) lines.push(`  source   ${row.source}`);
  for (const a of anchors.slice(1)) {
    lines.push(`  also     ${a.symbol_name ? `${a.file_path}:${a.symbol_name}` : a.file_path}`);
  }
  for (const a of anchors) {
    if (a.renamed_from) lines.push(`  renamed  ${a.renamed_from} -> ${a.symbol_name}`);
  }
  if (edges) {
    for (const e of edgesOf(db, row.fact_id)) {
      const phrase = EDGE_PHRASE[e.edge_type];
      if (!phrase) continue;
      lines.push(`  ↳ ${phrase[e.direction]} p#${e.fact_id}: ${oneLine(e.body, EDGE_BODY_CHARS)}`);
    }
  }
  if (!row.expired_at && row.contradicted_reason) {
    lines.push(`  withheld ${oneLine(row.contradicted_reason, 200)}`);
    lines.push(`  settle   koragraph practice forget ${row.fact_id} if the rule is wrong, `
      + 'or state it again if it is right');
  } else if (!row.expired_at) {
    lines.push(`  wrong?   koragraph practice forget ${row.fact_id}`);
  }
  return lines.join('\n');
}

function emptyStore(out, file, what) {
  out(`No practice database yet at ${file}.\n`);
  out(`Nothing has been ${what}. The layer records a lesson only when a captured failure was\n`
    + 'followed by a fix, so an empty store on a fresh install is expected.\n');
  return EXIT.OK;
}

// The write door from a terminal. Same door the MCP `remember` tool uses, same renderer for the
// confirmation — src/mcp/render.js is text over ../practice/untrusted and pulls in no server, no
// protocol and no schema, so sharing it costs nothing and stops the two surfaces describing the
// same stored fact differently.
function runRemember(parsed, io) {
  const { out, err } = io;
  const { rememberFact } = require('../practice/author');
  const { renderRemember } = require('../mcp/render');

  const kind = parsed.kind || 'law';
  const { db } = openPractice(true);
  // An UNANCHORED open loop needs no graph at all; opening it lazily keeps a plain
  // `remember --kind open_loop` on a graph-less repo from printing the spurious "no graph" warning.
  // A loop that names a `--symbol`/`--file` DOES need the graph to anchor, the same way a fact
  // does — skipping it here would silently anchor nothing and never say why.
  const needsGraph = kind !== 'open_loop' || Boolean(parsed.symbol || parsed.file);
  const graph = needsGraph ? openGraph() : null;
  let result;
  try {
    result = rememberFact(db, graph, {
      body: parsed.target,
      kind,
      symbol: parsed.symbol,
      file: parsed.file,
      // --repo is a defined option (used by why/list/forget to scope reads) but this verb never
      // forwarded it: passing it here silently did nothing, and a caller resolving the target
      // repo by name fell back to cwd — exactly the wrong answer when cwd isn't a checkout of it.
      repo: parsed.repo,
      cwd: workingDir(parsed),
      // Only the interactive verb defaults to 'user' — an import run (koragraph practice remember
      // called from the korainit playbook) passes --source import explicitly so the fact is not
      // stamped with the developer's own authority for something they never said.
      source: parsed.source || 'user',
      resolve: parsed.resolveFlag === true,
      verified: parsed.verified || null,
      note: parsed.note || null,
      fact_id: parsed.factId,
      confirm: parsed.confirmFlag === true,
    });
  } finally {
    if (graph) graph.close();
    db.close();
  }

  if (result.status === 'rejected') {
    err(`${renderRemember(result)}\n`);
    return EXIT.USAGE;
  }
  out(`${renderRemember(result)}\n`);
  // Without a graph a named symbol cannot be looked up at all, so the fact lands at repo grain and
  // renderRemember reports it as anchored — true, but not what the reader asked for.
  if (!graph && (parsed.symbol || parsed.file)) {
    err('No code graph was available, so the name you gave could not be resolved and the fact\n'
      + 'anchored at repository grain. Run `koragraph ingest <path>`, then restate it.\n');
  }
  return EXIT.OK;
}

// Open loops read side. Never opens graph.db — a loop anchors to no code.
function runLoops(parsed, io) {
  const { out } = io;
  const { listOpen } = require('../practice/open-loops');
  const { db } = openPractice(false);
  if (!db) { out('No open loops. Nothing is recorded yet.\n'); return EXIT.OK; }
  let loops;
  try {
    loops = listOpen(db, { repoId: parsed.repo || null, cwd: workingDir(parsed), limit: parsed.limit });
  } finally {
    db.close();
  }
  if (!loops.length) {
    out('No open loops for this repository. Open one with '
      + '`koragraph practice remember "<note>" --kind open_loop`.\n');
    return EXIT.OK;
  }
  out(`Open loops (${loops.length}) — open until done, never on a timer:\n`);
  for (const l of loops) {
    const seen = l.mentions > 1 ? ` (noted ${l.mentions}×)` : '';
    out(`  loop#${l.id}  ${l.body}${seen}\n`);
  }
  out('\nClose one with `koragraph practice resolve <id>` once it is handled.\n');
  return EXIT.OK;
}

function runResolve(parsed, io) {
  const { out, err } = io;
  const { resolveLoop } = require('../practice/open-loops');
  const { renderRemember } = require('../mcp/render');
  const { db } = openPractice(false);
  if (!db) { err('No open loops to close — nothing is recorded yet.\n'); return EXIT.OK; }

  // A bare integer (optionally "loop#12") closes by id; anything else is the loop text to match.
  const arg = String(parsed.target).replace(/^loop#/i, '').trim();
  const asId = /^\d+$/.test(arg) ? Number(arg) : null;
  let result;
  try {
    result = resolveLoop(db, {
      id: asId,
      body: asId == null ? parsed.target : null,
      cwd: workingDir(parsed),
      reason: 'user',
    });
  } finally {
    db.close();
  }
  out(`${renderRemember(result)}\n`);
  return EXIT.OK;
}

// Auto-delivery for every agent. Renders the live rulebook into the agent rule files this repo
// uses. Never opens graph.db — the rulebook is repo-grain and lives entirely in practice.db.
function runSync(parsed, io) {
  const { out, err } = io;
  const { syncRepo } = require('../practice/sync');
  // Create the store if it does not exist yet. `sync` is the explicit opt-in that installs
  // koragraph's always-on usage primer into the repo's agent file (AGENTS.md/CLAUDE.md), and
  // sync.js writes that primer even with zero rules — "useful from the first minute, before any
  // memory has accumulated." Refusing on an empty store meant the primer could never land on a
  // fresh repo, which is exactly when an agent most needs to be told the graph tools exist: the
  // one place a standing "save what you learn with remember" instruction is in context every turn,
  // not only when the capture tripwire happens to fire.
  const { db, file } = openPractice(true);
  let result;
  try {
    result = syncRepo(db, { cwd: workingDir(parsed), only: parsed.agent });
  } finally {
    db.close();
  }
  if (!result.ok) {
    err(`Could not sync: ${result.reason}.\n`);
    return EXIT.USAGE;
  }
  if (!result.written.length) {
    out('No agent rule files to sync. Pass --agent <agents|cursor|cline|windsurf|copilot|claude|gemini>\n'
      + 'to create one, or add one and re-run.\n');
    return EXIT.OK;
  }
  out(`Synced ${result.rule_count} rule(s)`
    + `${result.ritual_count ? `, ${result.ritual_count} ritual(s)` : ''}`
    + `${result.open_note_count ? ` and ${result.open_note_count} temporary note(s)` : ''} from ${file}:\n`);
  for (const w of result.written) out(`  ${w.status.padEnd(9)} ${w.file}\n`);
  out('\nThese stay current on their own — a rule whose code changes is dropped on the next\n'
    + '`koragraph ingest`. Re-run `koragraph practice sync` after an ingest to refresh the files.\n');
  return EXIT.OK;
}

const SEGMENT_KINDS = Object.freeze(['law', 'hazard', 'ritual', 'overview', 'skip']);

function segmentsOf(file, warn) {
  const { segmentInstructions, classifySegment } = require('../practice/instruction-files');
  let text;
  try {
    text = fs.readFileSync(file.abs, 'utf8');
  } catch (e) {
    warn(`Could not read ${file.path}: ${e.message}\n`);
    return [];
  }
  return segmentInstructions(text).map((s) => ({ ...s, ...classifySegment(s.text) }));
}

// What /korainit reads. The JSON form carries the segment TEXT, not just its classification, so the
// importing agent decides what to remember from this output alone — re-reading and re-segmenting
// every instruction file to get the sentences back would be a second segmenter that can disagree
// with this one.
function runInstructions(parsed, io) {
  const { out, err } = io;
  const { findInstructionFiles, INSTRUCTION_FILENAMES } = require('../practice/instruction-files');
  const { repoIdentity } = require('../practice/repo-identity');

  const cwd = workingDir(parsed);
  const { repoRoot } = repoIdentity(cwd);
  const root = repoRoot || cwd;

  const files = findInstructionFiles(root).map((f) => ({
    path: f.path, abs: f.abs, kind: f.kind, scope: f.scope, bytes: f.bytes,
    segments: segmentsOf(f, err),
  }));

  if (parsed.json) {
    out(`${JSON.stringify(files, null, 2)}\n`);
    return EXIT.OK;
  }

  if (!files.length) {
    out(`No instruction files under ${root}.\n`);
    err(`Looked for: ${INSTRUCTION_FILENAMES.join(', ')}.\n`);
    return EXIT.OK;
  }

  out(`${files.length} instruction file(s) under ${root}:\n\n`);
  for (const f of files) {
    const tally = SEGMENT_KINDS.map((k) => `${k} ${f.segments.filter((s) => s.kind === k).length}`);
    out(`${f.path}\n`);
    out(`  ${f.kind}  scope ${f.scope}  ${f.bytes} bytes  ${f.segments.length} segment(s)\n`);
    out(`  ${tally.join('  ')}\n`);
  }
  const importable = files.reduce(
    (n, f) => n + f.segments.filter((s) => s.kind !== 'skip' && s.kind !== 'overview').length, 0,
  );
  out(`\n${importable} segment(s) look importable. Add --json for the segment text itself.\n`);
  return EXIT.OK;
}

function runWhy(parsed, io, ctx) {
  const { out, err } = io;
  const { db, file } = openPractice(false);
  if (!db) return emptyStore(out, file, 'recorded');

  // A fact ID, because every delivered line ends in `[p#N]` and both delivery leads say
  // "koragraph practice why <id> shows the evidence". The verb only accepted a SYMBOL, so the
  // audit surface the whole trust argument rests on answered "Nothing is recorded about 1" for an
  // id it had just handed the reader.
  const asId = /^p?#?(\d+)$/i.exec(String(parsed.target || '').trim());
  const { file: wantFile, name } = asId ? { file: null, name: null } : splitTarget(parsed.target);
  const where = [];
  const params = {};
  if (asId) { where.push('f.id = @factId'); params.factId = Number(asId[1]); }
  if (name) { where.push('a.symbol_name = @name'); params.name = name; }
  const filePart = parsed.file || wantFile;
  if (filePart) {
    where.push('(a.file_path = @file OR a.file_path LIKE @fileLike)');
    params.file = filePart;
    params.fileLike = `%/${filePart}`;
  }
  if (parsed.repo) { where.push('a.repo_id = @repo'); params.repo = parsed.repo; }
  if (!where.length) return emptyStore(out, file, 'recorded');

  const rows = factRows(db, {
    where,
    params,
    limit: parsed.limit,
    // An id names ONE fact and the caller asked for it by number. An expired or contradicted one is
    // exactly what they are auditing, so the live-only default must not hide it.
    all: parsed.all || Boolean(asId),
    expiredOnly: parsed.expiredOnly,
  });

  if (!rows.length) {
    out(`Nothing is recorded about ${parsed.target}.\n`);
    const near = db.prepare(
      'SELECT DISTINCT symbol_name, file_path FROM anchors WHERE symbol_name LIKE ? LIMIT 5',
    ).all(`%${name || filePart || ''}%`).filter((r) => r.symbol_name);
    if (near.length) {
      err('Did you mean:\n' + near.map((r) => `  ${r.file_path}:${r.symbol_name}`).join('\n') + '\n');
    } else {
      err('That is an answer, not a failure. Silence is the correct output when nothing\n'
        + 'high-confidence is known — a wrong memory is far worse than no memory.\n');
    }
    db.close();
    return EXIT.OK;
  }

  out(`${rows.length} fact${rows.length === 1 ? '' : 's'} about ${parsed.target}:\n\n`);
  out(`${rows.map((r) => renderFact(db, r, ctx, { edges: true })).join('\n\n')}\n`);

  if (!parsed.all && !parsed.expiredOnly) {
    const hidden = factRows(db, { where, params, limit: 500, all: true, expiredOnly: true }).length;
    if (hidden) err(`\n${hidden} expired fact(s) hidden. Add --all to see them; they are retained, not deleted.\n`);
  }
  db.close();
  return EXIT.OK;
}

function runList(parsed, io, ctx) {
  const { out, err } = io;
  const { db, file } = openPractice(false);
  if (!db) return emptyStore(out, file, 'recorded');

  const where = [];
  const params = {};
  if (parsed.repo) { where.push('a.repo_id = @repo'); params.repo = parsed.repo; }
  if (parsed.kind) { where.push('f.kind = @kind'); params.kind = parsed.kind; }
  if (parsed.tier) { where.push('f.tier = @tier'); params.tier = parsed.tier; }
  if (!where.length) where.push('1 = 1');

  const rows = factRows(db, {
    where, params, limit: parsed.limit, all: parsed.all, expiredOnly: parsed.expiredOnly,
  });
  if (!rows.length) {
    out('No facts match.\n');
    const total = db.prepare('SELECT count(*) c FROM facts').get().c;
    err(total
      ? `The store holds ${total} fact(s); none matched these filters.\n`
      : 'The store holds no facts yet. Run `koragraph practice harvest` after a session with a\n'
        + 'failure that was then fixed, or `koragraph practice seed` to mine git history.\n');
    db.close();
    return EXIT.OK;
  }
  out(`${rows.map((r) => renderFact(db, r, ctx)).join('\n\n')}\n`);
  db.close();
  return EXIT.OK;
}

function runForget(parsed, io, ctx) {
  const { out, err } = io;
  const { db, file } = openPractice(false);
  if (!db) throw cliError(`No practice database at ${file} — there is nothing to forget.`, EXIT.NOT_FOUND);

  const id = Number(parsed.target.replace(/^p?#?/, ''));
  if (!Number.isInteger(id) || id < 1) {
    db.close();
    throw usageError(`practice forget needs a numeric fact id (got "${parsed.target}").`);
  }
  const before = db.prepare(`SELECT ${FACT_COLS} FROM facts f WHERE f.id = ?`).get(id);
  if (!before) {
    db.close();
    throw cliError(`No fact with id ${id}.`, EXIT.NOT_FOUND);
  }

  out('Before:\n');
  out(`${renderFact(db, before, ctx)}\n`);

  if (before.expired_at) {
    err(`\nAlready expired (${before.expiry_reason}) at ${before.expired_at}. Nothing changed.\n`);
    db.close();
    return EXIT.OK;
  }

  db.prepare(
    "UPDATE facts SET expired_at = ?, expiry_reason = 'user', expiry_note = ? WHERE id = ?",
  ).run(new Date().toISOString(), parsed.reason || null, id);

  const after = db.prepare(`SELECT ${FACT_COLS} FROM facts f WHERE f.id = ?`).get(id);
  out('\nAfter:\n');
  out(`${renderFact(db, after, ctx)}\n`);
  // Retention is the point, not a technicality: a fact you rejected is the only direct measurement
  // of this layer's precision that exists.
  err('\nExpired, not deleted. The row and its anchors are retained so the rule that produced it\n'
    + 'can be replayed and corrected.\n');
  db.close();
  return EXIT.OK;
}

function runDigest(parsed, io, ctx) {
  const { out } = io;
  const { db, file } = openPractice(false);
  if (!db) return emptyStore(out, file, 'learned');
  const d = ctx.digest(db, { days: parsed.days, limit: parsed.limit });
  out(`${ctx.renderDigest(d)}\n`);
  db.close();
  return EXIT.OK;
}

function runAudit(parsed, io, ctx) {
  const { out } = io;
  const { db, file } = openPractice(false);
  if (!db) return emptyStore(out, file, 'learned');
  const a = ctx.auditSummary(db);
  out(parsed.json ? `${JSON.stringify(a, null, 2)}\n` : `${ctx.renderAudit(a)}\n`);
  db.close();
  return EXIT.OK;
}

function scopesIn(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.session_id}\x00${e.agent_id || ''}`;
    if (!seen.has(key)) seen.set(key, { session_id: e.session_id, agent_id: e.agent_id });
  }
  return [...seen.values()].sort((a, b) => (a.session_id < b.session_id ? -1
    : a.session_id > b.session_id ? 1 : 0));
}

// The other half of the same events. fail-fix.js keeps the edit that finally worked; the hours went
// into the approaches that were backed out, and those are what stop the next agent starting at A.
// Both go through promoteLessons, so a tombstone anchors, drifts and expires exactly like a
// correction rather than becoming a second kind of memory with its own rules.
function harvestTombstones(db, graph, events, lessonKey) {
  const { mineTombstones } = require('../practice/tombstones');
  const { promoteLessons } = require('../practice/promote');

  // Namespaced. `lessonKey` keys on the failure SIGNATURE, which a tombstone and the fail→fix
  // lesson about the same failure share — an un-prefixed key would let whichever ran first
  // silently suppress the other.
  const keyOf = (l) => `tombstone\x00${lessonKey(l)}`;
  const seen = db.prepare('SELECT 1 FROM harvested_lessons WHERE lesson_key = ?');
  const fresh = mineTombstones(events).filter((l) => !seen.get(keyOf(l)));
  if (!fresh.length) return { count: 0, factIds: [] };

  const now = new Date();
  const { factIds } = promoteLessons(db, graph, fresh, { now, source: 'harvest' });
  // Same alignment rule harvest.js applies: promoteLessons drops a lesson that resolves to no
  // anchor, so the ids are positional only when nothing was dropped.
  const aligned = factIds.length === fresh.length;
  const mark = db.prepare(
    'INSERT OR IGNORE INTO harvested_lessons (lesson_key, session_id, agent_id, fact_id, created_at) VALUES (?,?,?,?,?)',
  );
  const stamp = now.toISOString();
  db.transaction(() => {
    fresh.forEach((l, i) => mark.run(
      keyOf(l), l.session_id || '', l.agent_id || null, aligned ? factIds[i] : null, stamp,
    ));
  })();
  return { count: fresh.length, factIds };
}

function runHarvest(parsed, io) {
  const { out, err } = io;
  let harvestSession = null;
  let lessonKey = null;
  try { ({ harvestSession, lessonKey } = require('../practice/harvest')); } catch { /* not built yet */ }

  const { db } = openPractice(true);
  if (!harvestSession) {
    err('The harvester is not present in this checkout (src/practice/harvest.js).\n');
    db.close();
    return EXIT.FAILURE;
  }

  const graph = openGraph();
  // Read once, and derive the session list from the rows rather than asking for it separately: the
  // tombstone miner needs the rows themselves, and harvestSession stamps `harvested_at` as it goes,
  // so a second query after the loop would come back empty.
  const events = parsed.session
    ? db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY ts, id').all(parsed.session)
    : db.prepare('SELECT * FROM events WHERE harvested_at IS NULL ORDER BY ts, id').all();
  const sessions = parsed.session
    ? [{ session_id: parsed.session, agent_id: null }]
    : scopesIn(events);

  let lessons = 0;
  const factIds = [];
  for (const s of sessions) {
    const r = harvestSession(db, graph, { sessionId: s.session_id, agentId: s.agent_id }) || {};
    lessons += r.lessons || 0;
    for (const id of r.factIds || []) factIds.push(id);
  }

  const tombstones = harvestTombstones(db, graph, events, lessonKey);
  for (const id of tombstones.factIds) factIds.push(id);

  recordRun(db, 'harvest', {
    sessions: sessions.length, lessons, tombstones: tombstones.count, facts: factIds.length,
  });

  out(`Harvested ${sessions.length} session(s): ${lessons} lesson(s), `
    + `${tombstones.count} tombstone(s), ${factIds.length} fact(s).\n`);
  if (factIds.length) out(`New facts: ${factIds.map((i) => `p#${i}`).join(' ')}\n`);
  if (!graph) {
    err('No code graph was available, so lessons anchored at file grain rather than to a symbol.\n');
  }
  if (graph) graph.close();
  db.close();
  return EXIT.OK;
}

function runSeed(parsed, io) {
  const { out, err } = io;
  let seedFromHistory = null;
  try { ({ seedFromHistory } = require('../practice/seed')); } catch { /* not built yet */ }

  const { db } = openPractice(true);
  if (!seedFromHistory) {
    err('The history seeder is not present in this checkout (src/practice/seed.js).\n');
    db.close();
    return EXIT.FAILURE;
  }

  const { repoIdentity } = require('../practice/repo-identity');
  const cwd = workingDir(parsed);
  // `repoIdentity(cwd).repoRoot` is promoted to the enclosing git checkout on purpose (durable
  // identity should not depend on which subdirectory happened to be current) — but `cwd` itself is
  // what `seed.js#seedFromHistory` needs as the actual ingest root to correlate git-reported paths
  // against the graph. `seedFromHistory` does its OWN promotion internally; passing the
  // already-promoted value here made it a no-op there, so a subdirectory ingest (crates/ inside a
  // git root two levels up) could never resolve its branch or rebase a path, and every fact fell
  // back to file grain on a path the graph didn't have anyway. Only `repoId` should come from the
  // promoted identity.
  const { repoRoot, repoId } = repoIdentity(cwd);
  if (!repoRoot) {
    db.close();
    throw cliError(`${cwd} is not inside a git checkout — there is no history to seed from.`, EXIT.USAGE);
  }

  const graph = openGraph();
  // Seeding without a graph anchors every fact to a file rather than a declaration, which is a
  // materially weaker result. It degrades rather than failing, so the seeder must be able to say so
  // — on stderr, because stdout is the result channel.
  const r = seedFromHistory(db, graph, {
    repoRoot: cwd, repoId, since: parsed.since,
    ...(parsed.limitExplicit ? { limit: parsed.limit } : {}),
    // seed.js already terminates each warning; tolerate either so the sink cannot double-space.
    warn: (m) => err(String(m).endsWith('\n') ? m : `${m}\n`),
  }) || {};
  recordRun(db, 'seed', { repoId, scanned: r.scanned || 0, facts: (r.factIds || []).length });

  const used = r.commitsUsed ?? 0;
  out(`Seeded ${repoId}: ${r.scanned || 0} commit(s) scanned, ${used} usable, `
    + `${(r.factIds || []).length} fact(s).\n`);
  const why = Object.entries(r.skippedByReason || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`);
  if (why.length) out(`  skipped: ${why.join(', ')}\n`);
  if (used === 0 && (r.scanned || 0) > 0) {
    out('  Nothing here looks like a fix commit. This is normal for a young or squash-merged repo.\n');
  }
  if (graph) graph.close();
  db.close();
  return EXIT.OK;
}

// Everyone can store "pooling was wrong here"; nobody else notices when the function it was about
// got renamed, moved or deleted.
function runRevalidate(parsed, io) {
  const { out, err } = io;
  const { revalidate } = require('../practice/revalidate');
  const { db } = openPractice(true);
  const graph = openGraph();

  let report;
  if (parsed.dryRun) {
    const Rollback = class extends Error {};
    try {
      db.transaction(() => {
        report = revalidate(db, graph);
        throw new Rollback();
      })();
    } catch (e) {
      if (!(e instanceof Rollback)) { db.close(); if (graph) graph.close(); throw e; }
    }
  } else {
    report = revalidate(db, graph);
    recordRun(db, 'revalidate', report);
  }

  let loopAnchorReport = null;
  if (!parsed.dryRun) {
    try {
      const { revalidateLoopAnchors } = require('../practice/loop-anchors');
      loopAnchorReport = revalidateLoopAnchors(db, graph);
    } catch { /* loop-anchor revalidation is best-effort; never fail a revalidate over it */ }
  }

  // Open loops get their own state re-check on the same cadence: an "add <path>" loop a human
  // satisfied by hand — with no agent ever seeing it — closes here. Disk + practice.db only, so it
  // is safe beside the anchor pass, and it is skipped under --dry-run like every other write.
  let closedLoops = [];
  if (!parsed.dryRun) {
    try {
      const { checkableClose } = require('../practice/open-loops');
      closedLoops = checkableClose(db, { cwd: workingDir(parsed) }).closed;
    } catch { /* open-loops is best-effort; never fail a revalidate over it */ }
  }

  out(`Checked ${report.facts_checked} live fact(s) over ${report.anchors_checked} anchor(s).\n`);
  out(`  ok ${report.ok}  unconfirmed ${report.unconfirmed}  renamed ${report.renamed}  `
    + `moved ${report.moved || 0}  orphaned ${report.orphaned}  unknown ${report.unknown}\n`);
  if (report.expired.length) {
    out(`Expired ${report.expired.length}:\n`);
    for (const e of report.expired) out(`  p#${e.fact_id}  ${e.reason}\n`);
  }
  // A contradiction is not an expiry, so it was invisible in the counters above AND absent from
  // the expired list — a rule stopped reaching every future session and the verb whose whole job
  // is reporting what changed said `ok`. The id alone is not actionable; the reason is.
  if (report.contradicted && report.contradicted.length) {
    out(`Withheld ${report.contradicted.length} — kept and auditable, not expired:\n`);
    for (const c of report.contradicted) {
      out(`  p#${c.fact_id}  ${c.reason}\n`);
    }
    out('Settle one with `koragraph practice forget <id>` if it is wrong, '
      + 'or state it again if it is right.\n');
  }
  if (report.uncontradicted) {
    out(`${report.uncontradicted} previously-withheld rule(s) agree with the repository again.\n`);
  }
  if (closedLoops.length) {
    out(`Closed ${closedLoops.length} open loop(s) whose named file now exists:\n`);
    for (const l of closedLoops) out(`  loop#${l.id}  ${l.body}\n`);
  }
  if (loopAnchorReport && (loopAnchorReport.renamed || loopAnchorReport.moved || loopAnchorReport.dropped)) {
    out(`Open-loop anchors: ${loopAnchorReport.renamed} renamed, ${loopAnchorReport.moved} moved, `
      + `${loopAnchorReport.dropped} fell back to repo-wide (named code is gone; the loop itself stays open).\n`);
  }
  if (parsed.dryRun) err('\nDry run — nothing was written.\n');

  if (!graph) {
    err('\nNo code graph is present, so every anchor read as UNKNOWN and nothing expired. That is\n'
      + 'the rule, not a failure: a missing index looks exactly like deleted code, and a memory\n'
      + 'product that forgets whenever its index is stale is worse than one that never forgets.\n');
  } else if (report.unknown && report.unknown === report.anchors_checked) {
    err('\nEvery anchor was unknown — the repositories these facts describe are not in the graph.\n'
      + 'Run `koragraph ingest <path>` for them, then revalidate again. Nothing was expired.\n');
  }
  if (graph) graph.close();
  db.close();
  return EXIT.OK;
}

async function run(parsed, io) {
  const { digest, renderDigest, provenanceOf, oneLine, auditSummary, renderAudit } = require('../practice/digest');
  const { edgesOf } = require('../practice/fact-edges');
  const ctx = { digest, renderDigest, provenanceOf, oneLine, edgesOf, auditSummary, renderAudit };
  switch (parsed.verb) {
    case 'remember': return runRemember(parsed, io);
    case 'why': return runWhy(parsed, io, ctx);
    case 'list': return runList(parsed, io, ctx);
    case 'forget': return runForget(parsed, io, ctx);
    case 'instructions': return runInstructions(parsed, io);
    case 'digest': return runDigest(parsed, io, ctx);
    case 'audit': return runAudit(parsed, io, ctx);
    case 'harvest': return runHarvest(parsed, io);
    case 'seed': return runSeed(parsed, io);
    case 'revalidate': return runRevalidate(parsed, io);
    case 'loops': return runLoops(parsed, io);
    case 'resolve': return runResolve(parsed, io);
    case 'sync': return runSync(parsed, io);
    default: throw usageError(`practice: unknown verb "${parsed.verb}".`);
  }
}

module.exports = { parse, run, splitTarget, USAGE, USES_STORE, OPTIONS, VERBS };
