#!/usr/bin/env node
// UserPromptSubmit brief for the practice graph.
//
// The agent has not acted yet. What this pushes is session-conditioned, not prompt-conditioned: the
// LAWS (repo-grain rules the developer stated), pushed once and never again this session, because a
// token admitted at turn t is re-billed on every remaining turn.
//
// Deliberately does not try to guess which stored facts or open loops are relevant to the prompt's
// words — that guess goes wrong on a natural paraphrase, and worse, can confidently surface the
// WRONG note once a realistic number of notes exist. Relevance is instead read off the code itself:
// an agent calling explore/neighbours/blast_radius/file_symbols on a piece of code sees what is
// known about THAT code, a far stronger and cheaper signal than prompt text. A situation with no
// node to attach to, or a session that never visits the right one, is covered by the session-start
// file block `practice sync` writes into AGENTS.md/CLAUDE.md/etc. instead.
//
// Rituals are not pushed here, even though laws are: this hook only fires for a Claude-Code session
// with the hook wired up in `.claude/settings.json`, invisible to any other agent and to this same
// agent with hooks off, so anything delivered only here has narrow reach. Rituals live in that same
// synced file instead (sync.js#ritualLines), reaching every agent. Laws are pushed through BOTH
// channels regardless — deliberately redundant with the file, which pays for them on every turn
// where this hook pays once per session — because a rule the developer stated is worth the extra
// channel; a ritual, recoverable by trying it, is not.
//
// Same three rules as preflight.mjs — never fail the turn, never touch graph.db, exit 0 always.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const root = process.env.KORAGRAPH_PRACTICE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  if (raw.trim()) {
    const input = JSON.parse(raw);
    const { buildLawPush } = require(join(root, 'src', 'practice', 'context-brief.js'));
    const { markPushed } = require(join(root, 'src', 'practice', 'rituals.js'));
    const { openPracticeDb } = require(join(root, 'src', 'practice', 'db.js'));
    // corrections.js has ZERO requires, by design (see its own header) — safe to use unconditionally,
    // with no DB needed at all, right on this read path.
    const { looksWorthRemembering } = require(join(root, 'src', 'practice', 'corrections.js'));
    // The episode recorder, when it lands. Soft-required so this hook keeps working — and the tree
    // keeps building — while that module does not exist.
    let openEpisode = null;
    try { ({ openEpisode } = require(join(root, 'src', 'practice', 'episodes.js'))); } catch { /* not built yet */ }
    // The correction channel. Staged here as an audit trail only, because anchoring needs graph.db
    // and this path may not open it.
    let captureStated = null;
    try { ({ captureStated } = require(join(root, 'src', 'practice', 'stated.js'))); } catch { /* not built yet */ }

    const cwd = input.cwd || process.cwd();
    const sessionId = input.session_id || null;
    let sections = [];
    let pushed = null;

    // Tripwire: a single trailing clause, never a paragraph, and nothing at all on the common
    // case where the prompt looked like ordinary task talk. The actual judgment — is this a rule or
    // a situation, does it name real code, is it worth keeping — is the agent's, using `remember`'s
    // own tool description; this is only ever a nudge to make that call, never a silent write.
    const tripwire = looksWorthRemembering(input.prompt || '');
    if (tripwire) {
      sections.push('THE DEVELOPER MAY HAVE JUST STATED SOMETHING TO REMEMBER. IF SO, CALL THE '
        + 'koragraph `remember` TOOL RIGHT NOW, in this same turn, unasked — do NOT just acknowledge '
        + 'it in prose, and do NOT treat "remind me / save this for <day>" as a scheduled task or cron: '
        + 'it is a koramemory open_loop. Route it: a rule/hazard/preference → kind:"law"/"hazard" '
        + '(anchor it to a symbol or file when it names one); an explicit "save this / note that down / '
        + 'pick this up wednesday" or any deferral → kind:"open_loop". If unsure which, STILL capture '
        + 'it — open_loop is the safe default. A stray save costs one line; a dropped one is gone.');
    }

    // Read-only: this hook fires on every prompt and must never contend with the recorder for the
    // write lock.
    //
    // Kept in its own try/catch, SEPARATE from the write block below: a read-only open does not
    // migrate or create the file, so it throws on a fresh install where practice.db does not exist
    // yet (because `ingest` does not create it either). That failure must only skip the push, never
    // the write below -- which is what creates the store and can record the FIRST rule a developer
    // ever states, on the exact install where the correction channel is the only thing this layer
    // has.
    let db = null;
    try {
      db = openPracticeDb({ readonly: true });
      const lawPush = buildLawPush(db, { cwd, sessionId, prompt: input.prompt || null });
      if (lawPush) { sections.push(lawPush.text); pushed = lawPush; }
    } catch {
      // Nothing to deliver from a store that is not there yet. Not an error, and not a reason to
      // drop what the developer just said.
    } finally {
      if (db) { try { db.close(); } catch { /* already gone */ } }
    }

    if (sections.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: sections.join('\n\n') },
      }));
    }

    // Everything below writes, and a write on this path can block on the recorder's transaction.
    // It happens after the answer is already on stdout, and the busy wait is cut to a tenth of the
    // default: showing a rulebook twice costs far less than a keystroke that hangs.
    if (pushed || openEpisode || captureStated) {
      let wdb = null;
      try {
        wdb = openPracticeDb();
        wdb.pragma('busy_timeout = 100');
        if (pushed) markPushed(wdb, sessionId, pushed.repo_id, pushed.laws.map((l) => l.fact_id));
        if (openEpisode) openEpisode(wdb, { sessionId, prompt: input.prompt || '', ts: new Date().toISOString() });
        if (captureStated) captureStated(wdb, { prompt: input.prompt || '', session_id: sessionId, cwd });
      } catch (err) {
        if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[practice] ${err.stack}\n`);
      } finally {
        if (wdb) wdb.close();
      }
    }
  }
} catch (err) {
  if (process.env.KORAGRAPH_PRACTICE_DEBUG) process.stderr.write(`[practice] ${err.stack}\n`);
}
process.exit(0);
