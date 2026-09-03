'use strict';

const fs = require('fs');
const path = require('path');

const { redactSecrets, flatten, truncate } = require('./untrusted');

// An episode is one UserPromptSubmit → Stop window: the question, and everything the agent did
// before it answered. `events` already has the doing; nothing had the asking.
//
// This module runs on hook paths. It opens practice.db and nothing else, and it requires exactly
// one project module — `untrusted.js`, which itself has zero requires. Adding a require here that
// reaches db/pool means better-sqlite3's synchronous busy wait blocks the user's editor for the
// length of an ingest.
//
// It is the DATA layer only. Nothing here ranks a file or hands a filename to a reader.

const MAX_PROMPT = 4000;
// Episodes are derived capture, not facts — the never-hard-delete rule is about `facts`, and a
// laptop store that only grows is a defect. Newest wins: a router trained on last month is worth
// more than one trained on last year, and `events` keeps the raw trace either way.
const DEFAULT_CAP = 5000;
// Per episode, how many files that were only LOOKED at are kept. A single episode can inspect
// hundreds of files, most of them the tail of a `find` result or a suite run, not a route. Edited
// files are never capped — they are the label.
const MAX_INSPECTED = 40;

// The user's own prompt is not an injection vector against the user, so it is NOT defanged here —
// defanging turns `Vec<String>` into `Vec‹String›` and degrades the search corpus. Secrets are
// redacted because the store is durable and irreplaceable, and control characters are stripped
// because a stored escape repaints a terminal when the CLI prints it. Any future consumer that
// renders a prompt into a prompt must call untrusted.js#quoted itself.
function cleanPrompt(text) {
  return truncate(flatten(redactSecrets(text)), MAX_PROMPT);
}

// UserPromptSubmit also fires for prompts the CLI writes to itself. The first episode captured on
// this machine was a `<task-notification>` announcing a finished subagent — a real boundary, and a
// useless routing key, because no future question will ever resemble it. Matched at the start of
// the raw text: these wrappers are CLI-authored and always lead.
const SYNTHETIC = /^\s*<(?:task-notification|system-reminder|local-command-stdout|command-name|command-message)>/;

function maxEventId(db) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get().m;
}

function openEpisode(db, { sessionId, agentId = null, prompt, ts = null, repoId = null, source = 'hook' } = {}) {
  const text = cleanPrompt(prompt);
  const at = ts || new Date().toISOString();
  // A new prompt is proof the previous turn ended, whether or not Stop fired. Without this a
  // missed Stop leaves an episode open forever and every later event is attributed to it. It runs
  // before the checks below, because a synthetic prompt still ends the turn before it.
  if (sessionId) closeEpisode(db, { sessionId, agentId, ts: at });
  if (!sessionId || !text || SYNTHETIC.test(prompt)) return null;

  const info = db.prepare(
    `INSERT OR IGNORE INTO episodes
       (session_id, agent_id, repo_id, prompt, prompt_chars, opened_at, first_event_id, source)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(sessionId, agentId, repoId, text, String(prompt || '').length, at, maxEventId(db), source);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

// Stop carries no agent_id (the same trap harvest.js documents), so a null agentId closes every
// open episode in the session rather than only the main loop's.
function openEpisodesFor(db, sessionId, agentId) {
  const sql = agentId
    ? 'SELECT * FROM episodes WHERE session_id = ? AND closed_at IS NULL AND agent_id IS ?'
    : 'SELECT * FROM episodes WHERE session_id = ? AND closed_at IS NULL';
  return agentId ? db.prepare(sql).all(sessionId, agentId) : db.prepare(sql).all(sessionId);
}

function closeEpisode(db, { sessionId, agentId = null, ts = null, cap = null } = {}) {
  if (!sessionId) return { closed: 0, episodeIds: [] };
  const open = openEpisodesFor(db, sessionId, agentId);
  if (!open.length) return { closed: 0, episodeIds: [] };
  const at = ts || new Date().toISOString();
  const last = maxEventId(db);

  const ids = [];
  const run = db.transaction(() => {
    for (const ep of open) {
      attribute(db, ep, last, at);
      ids.push(ep.id);
    }
  });
  run();
  prune(db, cap);
  return { closed: ids.length, episodeIds: ids };
}

// Every event in the window, whichever agent produced it. A subagent spawned mid-turn is doing the
// episode's work; scoping to the parent's agent_id throws that away, and subagents never get a
// UserPromptSubmit of their own so nothing else would ever claim it.
const WINDOW_SQL = `SELECT event_type, repo_id, file_path, cmd, old_fingerprint, new_fingerprint
                    FROM events
                    WHERE session_id = ? AND id > ? AND id <= ?
                    ORDER BY id`;

// A path that escaped relativise is outside the checkout — a scratch file, a transcript, another
// repo's tree. It is real activity and useless as a route, and the store is capped, so it is
// counted in the episode totals and not stored per-file.
const isRepoRelative = (p) => !!p && !p.startsWith('/') && !p.startsWith('..');

// Files a shell command names. `cat src/x.js`, `sed -n 1,40p src/x.js`, `npx vitest run test/y.js`
// are file inspections that leave no `read` event, because the Read tool was never called: the
// live store has 22 read events against 3,054 commands, 1,877 of which name a repo-relative path.
// Without this the negative half — opened repeatedly, never edited — is empty on real data.
//
// Shape only, never a stat: this runs on a hook path and the command's cwd is not this process's.
// An extension is required so a bare word cannot become a route, and the count is capped so one
// `find` dump cannot make a hundred files look inspected.
const PATH_TOKEN = /(?:^|[\s'"`=(,])((?:\.\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z][\w]{0,4})(?=[\s'"`:,)]|$)/g;
const MAX_PATHS_PER_CMD = 12;

function commandPaths(cmd) {
  if (!cmd) return [];
  const out = new Set();
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(cmd)) !== null) {
    const p = m[1].replace(/^\.\//, '');
    if (isRepoRelative(p) && p.length <= 200) out.add(p);
    if (out.size >= MAX_PATHS_PER_CMD) break;
  }
  return [...out];
}

function attribute(db, ep, lastEventId, closedAt) {
  const rows = db.prepare(WINDOW_SQL).all(ep.session_id, ep.first_event_id, lastEventId);
  const files = new Map();
  const seenPrints = new Map();
  const totals = { edit: 0, read: 0, cmd_pass: 0, cmd_fail: 0 };
  let repoId = ep.repo_id;

  const slot = (repo, file) => {
    const k = `${repo || ''} ${file}`;
    let f = files.get(k);
    if (!f) {
      f = {
        repo_id: repo || repoId || '', file_path: file,
        reads: 0, edits: 0, searches: 0, cmd_refs: 0, survived: null, checked: false,
      };
      files.set(k, f);
    }
    return f;
  };

  for (const r of rows) {
    if (r.event_type in totals) totals[r.event_type] += 1;
    if (r.repo_id && !repoId) repoId = r.repo_id;
    if (r.cmd) for (const p of commandPaths(r.cmd)) slot(r.repo_id, p).cmd_refs += 1;
    if (!isRepoRelative(r.file_path)) continue;
    const key = `${r.repo_id || ''} ${r.file_path}`;
    const f = slot(r.repo_id, r.file_path);
    if (r.event_type === 'read') f.reads += 1;
    else if (r.event_type === 'search') f.searches += 1;
    else if (r.event_type === 'edit') {
      f.edits += 1;
      const prior = seenPrints.get(key) || new Set();
      if (r.old_fingerprint || r.new_fingerprint) {
        f.checked = true;
        // The file came back to a state it had already left: the approach was abandoned, so the
        // edit did not survive even though the file is in the diff.
        if (r.new_fingerprint && prior.has(r.new_fingerprint)) f.survived = 0;
        else if (f.survived === null) f.survived = 1;
        if (r.old_fingerprint) prior.add(r.old_fingerprint);
        seenPrints.set(key, prior);
      }
    }
  }

  const outcome = totals.edit ? 'edited' : (rows.length ? 'read_only' : 'empty');
  db.prepare(
    `UPDATE episodes SET closed_at = ?, last_event_id = ?, repo_id = COALESCE(repo_id, ?),
       n_edits = ?, n_reads = ?, n_cmd_pass = ?, n_cmd_fail = ?, outcome = ? WHERE id = ?`,
  ).run(closedAt, lastEventId, repoId, totals.edit, totals.read, totals.cmd_pass, totals.cmd_fail, outcome, ep.id);

  const put = db.prepare(
    `INSERT INTO episode_files (episode_id, repo_id, file_path, role, reads, edits, searches, cmd_refs, survived)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (episode_id, repo_id, file_path) DO UPDATE SET
       role = excluded.role, reads = excluded.reads, edits = excluded.edits,
       searches = excluded.searches, cmd_refs = excluded.cmd_refs, survived = excluded.survived`,
  );
  for (const f of capInspected([...files.values()])) {
    put.run(ep.id, f.repo_id, f.file_path, f.edits ? 'edited' : 'inspected',
      f.reads, f.edits, f.searches, f.cmd_refs, f.edits && f.checked ? f.survived : null);
  }
}

// Everything that was edited, plus the most-handled MAX_INSPECTED of what was only looked at.
// Ranked by how many times the file was opened, because a file opened nine times and never
// changed is the strongest negative the layer has and a file named once by a `find` is noise.
function capInspected(list) {
  const edited = list.filter((f) => f.edits);
  const rest = list.filter((f) => !f.edits)
    .sort((a, b) => (b.cmd_refs + b.reads + b.searches) - (a.cmd_refs + a.reads + a.searches))
    .slice(0, MAX_INSPECTED);
  return [...edited, ...rest];
}

function prune(db, cap = null) {
  const limit = cap ?? Number(process.env.KORAGRAPH_EPISODE_CAP || DEFAULT_CAP);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const n = db.prepare('SELECT COUNT(*) AS c FROM episodes').get().c;
  if (n <= limit) return 0;
  return db.prepare(
    'DELETE FROM episodes WHERE id IN (SELECT id FROM episodes ORDER BY id DESC LIMIT -1 OFFSET ?)',
  ).run(limit).changes;
}

// Identifiers a prompt and a path can be compared on. camelCase and snake_case are split as well
// as kept whole, because "retryOnConflict" in a prompt has to reach `retry-on-conflict.js`.
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'not', 'but',
  'can', 'was', 'have', 'has', 'its', 'from', 'into', 'what', 'when', 'why', 'how', 'all',
  'any', 'run', 'use', 'get', 'set', 'add', 'now', 'one', 'two', 'out', 'off', 'per', 'via']);

function tokens(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    const t = raw.toLowerCase();
    if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) out.add(t);
    for (const part of raw.split(/_|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const p = part.toLowerCase();
      if (p.length >= 3 && !STOP.has(p) && !/^\d+$/.test(p)) out.add(p);
    }
  }
  return [...out];
}

const MAX_MATCH_TOKENS = 24;

// FTS5 over prompt text, restricted to episodes that existed BEFORE `beforeId`. The bound is what
// makes a replay causal: without it every episode matches its own future.
function searchEpisodes(db, { text, before = null, repoId = null, limit = 20 } = {}) {
  const toks = tokens(text).slice(0, MAX_MATCH_TOKENS);
  if (!toks.length) return [];
  const query = toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  const where = ['e.outcome = \'edited\''];
  const args = [query];
  // Ordered by wall-clock first and id only to break a tie. Ids are insertion order, and a
  // backfill inserts one whole transcript before the next — so two sessions that ran on the same
  // afternoon get id ranges that do not interleave, and an id-only bound would let an episode see
  // hours of its own future.
  if (before) {
    where.push('(e.opened_at < ? OR (e.opened_at = ? AND e.id < ?))');
    args.push(before.opened_at, before.opened_at, before.id);
  }
  if (repoId) where.push('e.repo_id = ?');
  if (repoId) args.push(repoId);
  args.push(limit);
  try {
    return db.prepare(
      `SELECT e.id, e.prompt, e.repo_id, e.opened_at, bm25(episodes_fts) AS rank
         FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY rank LIMIT ?`,
    ).all(...args);
  } catch {
    return [];
  }
}

function episodeFiles(db, episodeIds, role = null) {
  if (!episodeIds.length) return [];
  const holes = episodeIds.map(() => '?').join(',');
  const sql = `SELECT * FROM episode_files WHERE episode_id IN (${holes})`
    + (role ? ' AND role = ?' : '');
  return db.prepare(sql).all(...(role ? [...episodeIds, role] : episodeIds));
}

// Backfill from Claude Code's own session transcripts. This is the only source of a prompt that
// predates the hook; without it the store holds only what live capture has seen since install.
//
// A transcript line with origin.kind === 'human' and a string content is a real user prompt; every
// other `user` row is a tool result the CLI wrote. The window runs to the next such prompt.
//
// `<dir>/<session>/subagents/*.jsonl` are folded into the parent turn whose wall-clock window
// contains them. That is not a convenience: on the live path a subagent's events land in the
// parent episode's id range and are attributed to it, so a backfill that read only the main
// transcript would build a differently-shaped corpus from the one capture produces — and on this
// project the main loop delegates almost every edit, so it would also be nearly empty.
function backfillFromTranscripts(db, { dir, repoId = null, now = null } = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return { files: 0, episodes: 0, withGroundTruth: 0 }; }

  const stamp = now || new Date().toISOString();
  let episodes = 0;
  let withGroundTruth = 0;
  let subagents = 0;

  for (const name of names) {
    const sessionId = name.replace(/\.jsonl$/, '');
    const main = scanTranscript(readLines(path.join(dir, name)));
    if (!main.turns.length) continue;
    const actions = main.actions;
    const subDir = path.join(dir, sessionId, 'subagents');
    let subs = [];
    try { subs = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')); } catch { /* none */ }
    for (const sub of subs) {
      subagents += 1;
      actions.push(...scanTranscript(readLines(path.join(subDir, sub))).actions);
    }
    actions.sort((a, b) => (a.ts < b.ts ? -1 : 1));

    // Bucket by wall clock. A turn owns everything from its own timestamp until the next prompt.
    let i = 0;
    for (const a of actions) {
      while (i + 1 < main.turns.length && main.turns[i + 1].ts <= a.ts) i++;
      if (a.ts < main.turns[0].ts) continue;
      const files = main.turns[i].files;
      const f = files.get(a.file) || { reads: 0, edits: 0, cmd_refs: 0 };
      f[a.key] += 1;
      files.set(a.file, f);
    }

    for (const t of main.turns) {
      const id = insertBackfilled(db, sessionId, t, repoId, stamp);
      if (id === null) continue;
      episodes += 1;
      if ([...t.files.values()].some((f) => f.edits)) withGroundTruth += 1;
    }
  }
  return { files: names.length, subagents, episodes, withGroundTruth };
}

const readLines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
};

// One transcript → the human prompts in it and every file-touching action, each with the timestamp
// that places it. A subagent transcript has no human prompts and contributes only actions.
function scanTranscript(lines) {
  const turns = [];
  const actions = [];
  const pending = new Map();
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || '';
    if (o.type === 'user' && typeof o.message?.content === 'string' && o.origin?.kind === 'human') {
      turns.push({ prompt: o.message.content, ts, cwd: o.cwd, files: new Map() });
      continue;
    }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b.type !== 'tool_use') continue;
        // A tool_use is an INTENT. It counts only once its result comes back without an error —
        // a denied or failed Edit wrote nothing and is not evidence about the code.
        if (b.name === 'Bash') { pending.set(b.id, { ts, cmd: b.input?.command || '' }); continue; }
        const target = b.input?.file_path || b.input?.notebook_path || null;
        if (!target) continue;
        const rel = relativiseTo(o.cwd, target);
        if (!isRepoRelative(rel)) continue;
        const key = /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name) ? 'edits'
          : (/^(Read|NotebookRead)$/.test(b.name) ? 'reads' : null);
        if (!key) continue;
        pending.set(b.id, { ts, file: rel, key });
      }
    }
    if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b.type !== 'tool_result') continue;
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        if (b.is_error) continue;
        if (p.cmd !== undefined) {
          for (const file of commandPaths(p.cmd)) actions.push({ ts: p.ts, file, key: 'cmd_refs' });
        } else {
          actions.push({ ts: p.ts, file: p.file, key: p.key });
        }
      }
    }
  }
  return { turns, actions };
}

function relativiseTo(cwd, filePath) {
  if (!cwd || !filePath) return filePath || null;
  const rel = path.relative(path.resolve(cwd), path.resolve(filePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.resolve(filePath);
  return rel.split(path.sep).join('/');
}

function insertBackfilled(db, sessionId, turn, repoId, stamp) {
  const text = cleanPrompt(turn.prompt);
  if (!text || SYNTHETIC.test(turn.prompt)) return null;
  const opened = turn.ts || stamp;
  const info = db.prepare(
    `INSERT OR IGNORE INTO episodes
       (session_id, agent_id, repo_id, prompt, prompt_chars, opened_at, closed_at,
        first_event_id, last_event_id, n_edits, n_reads, n_cmd_pass, n_cmd_fail, source, outcome)
     VALUES (?,?,?,?,?,?,?,0,0,?,?,0,0,'transcript',?)`,
  ).run(sessionId, null, repoId, text, turn.prompt.length, opened, opened,
    sum(turn.files, 'edits'), sum(turn.files, 'reads'),
    sum(turn.files, 'edits') ? 'edited' : (turn.files.size ? 'read_only' : 'empty'));
  if (!info.changes) return null;
  const id = Number(info.lastInsertRowid);
  const put = db.prepare(
    `INSERT OR IGNORE INTO episode_files
       (episode_id, repo_id, file_path, role, reads, edits, searches, cmd_refs, survived)
     VALUES (?,?,?,?,?,?,0,?,NULL)`,
  );
  const rows = capInspected([...turn.files].map(([file, f]) => ({ file_path: file, ...f })));
  for (const f of rows) {
    put.run(id, repoId || '', f.file_path, f.edits ? 'edited' : 'inspected', f.reads, f.edits, f.cmd_refs);
  }
  return id;
}

const sum = (map, key) => [...map.values()].reduce((a, f) => a + (f[key] || 0), 0);

module.exports = {
  openEpisode, closeEpisode, searchEpisodes, episodeFiles, backfillFromTranscripts,
  prune, tokens, cleanPrompt, MAX_PROMPT, DEFAULT_CAP, MAX_INSPECTED,
};
