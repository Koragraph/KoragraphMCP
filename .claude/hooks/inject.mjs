#!/usr/bin/env node
// UserPromptSubmit: push prompt-conditioned graph context, rationed and fail-open.
//
// Sibling to context.mjs, deliberately the opposite bet. context.mjs pushes the session's LAWS and
// refuses to guess which stored notes match the prompt's words, because that guess goes wrong on a
// paraphrase. This hook takes the guess on the CODE graph instead of on stored prose: it reads the
// prompt for a phrase and a symbol, asks explore/recall what the graph knows, and injects a small,
// budgeted block. The graph answer is self-correcting in a way a prose-note guess is not: a wrong
// symbol returns few or no ranked declarations and is dropped, rather than confidently surfacing the
// wrong note. It stays additive: recall only fires for a concrete symbol, so it never re-pushes the
// repo-wide laws context.mjs already owns.
//
// Three rules, in order of how expensive getting them wrong is:
//   1. Never fail or delay the turn. Every path exits 0, each child is killed at a hard timeout,
//      and the whole hook is a no-op when it finds nothing.
//   2. Shell out to the CLI rather than open the store in-process. better-sqlite3 is a synchronous
//      busy wait; a child can be SIGKILLed at the timeout, an in-process open cannot be interrupted.
//   3. Scope to the current repo. The store here spans many repositories and gigabytes; an
//      unscoped explore is seconds, a repo-scoped one is sub-second on a warm cache.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = process.env.KORAGRAPH_PRACTICE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(root, 'bin', 'koragraph.js');

function envInt(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const CONFIG = {
  enabled: process.env.KORAGRAPH_INJECT !== '0',
  exploreBudget: envInt('KORAGRAPH_INJECT_EXPLORE_BUDGET', 400),
  recallBudget: envInt('KORAGRAPH_INJECT_RECALL_BUDGET', 150),
  // explore reopens the store per fire, so the timeout has to cover a cold open on this machine's
  // large multi-repo graph (~2.7s), not just the warm path (~0.9s). This is the latency cost of a
  // shell-out-per-prompt push; a resident index the hook talks to is what reaches a sub-second
  // budget. recall reads only the small practice store and stays fast.
  exploreTimeout: envInt('KORAGRAPH_INJECT_EXPLORE_TIMEOUT_MS', 4000),
  recallTimeout: envInt('KORAGRAPH_INJECT_RECALL_TIMEOUT_MS', 1000),
  // Defaults to the working directory's basename, which is how a single-repo checkout is named in
  // the store. Set KORAGRAPH_INJECT_SCOPE='' to search every repo (slower), or to a name to pin it.
  scope: process.env.KORAGRAPH_INJECT_SCOPE,
};

// Words that carry no code signal, so a symbol picked out of them would just be noise.
const STOP = new Set(('the a an and or but if then else of to in on for with by is are was were be '
  + 'been being do does did how what why where when which who this that these those it its as at from '
  + 'into out up down over under can could should would will your you my me we they i add fix change '
  + 'make build run test show find get set use using update remove delete function method class file '
  + 'code work works working does help please want need let just about like new').split(/\s+/));

// Pull a search phrase and, when present, a single symbol out of the prompt. The phrase feeds
// explore, which tokenises and re-ranks natural language on its own, so the prompt largely passes
// through (capped so a pasted wall of text does not become the query). The symbol feeds recall and
// must look like an identifier (camelCase, snake_case, dotted, or CapWords), because recall anchored
// to an English word returns nothing useful.
function salient(prompt) {
  const text = String(prompt || '').trim();
  if (text.length < 3) return { phrase: null, symbol: null };

  const quoted = [...text.matchAll(/[`"]([^`"]{2,64})[`"]/g)].map((m) => m[1]);
  const idents = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_.$]{2,}/g)].map((m) => m[0]);
  const codey = idents.filter((w) => (
    (/[a-z][A-Z]/.test(w) || w.includes('_') || w.includes('.') || /^[A-Z][a-z].*[A-Z]/.test(w))
    && !STOP.has(w.toLowerCase())
  ));

  // Prefer a quoted identifier, else the longest code-shaped token: length is a decent proxy for
  // specificity, and the strongest single symbol beats a diffuse set for a memory lookup.
  const symbolPool = quoted.filter((q) => /^[A-Za-z_][A-Za-z0-9_.$]*$/.test(q)).concat(codey);
  const symbol = symbolPool.sort((a, b) => b.length - a.length)[0] || null;

  const phrase = text.length <= 200
    ? text.replace(/\s+/g, ' ')
    : (quoted[0] || codey.slice(0, 6).join(' ') || text.slice(0, 200)).replace(/\s+/g, ' ');

  return { phrase: phrase || null, symbol };
}

// Run one CLI query, resolve to its stdout on a clean exit-0, or to null on anything else: a
// non-zero exit (3 = ran but empty, or a real error), a timeout kill, or a spawn failure. null means
// "nothing to inject", which is the fail-open default for every unhappy path.
function query(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out.trim() : null); });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  if (CONFIG.enabled && raw.trim()) {
    const input = JSON.parse(raw);
    const prompt = input.prompt || '';
    // A slash command is an instruction to the harness, not a question about the code.
    if (prompt && !prompt.trimStart().startsWith('/')) {
      const cwd = input.cwd || process.cwd();
      const scope = CONFIG.scope !== undefined ? CONFIG.scope : basename(cwd);
      const { phrase, symbol } = salient(prompt);

      if (phrase) {
        const exploreArgs = ['explore', phrase, '--no-fresh', '--format', 'compact',
          '--no-source', '--budget', String(CONFIG.exploreBudget)];
        if (scope) exploreArgs.push('--project', scope);

        const jobs = [query(exploreArgs, CONFIG.exploreTimeout)];
        if (symbol) {
          jobs.push(query(['recall', symbol, '--no-fresh', '--format', 'compact',
            '--budget', String(CONFIG.recallBudget)], CONFIG.recallTimeout));
        }
        const [graph, memory] = await Promise.all(jobs.length === 2 ? jobs : [jobs[0], Promise.resolve(null)]);

        const blocks = [];
        // recall falls back to the repo-wide laws when a symbol has no note of its own; context.mjs
        // already owns that law push, so keep only a real symbol-anchored recall here.
        if (memory && !/^Nothing recorded for /.test(memory)) blocks.push(`koragraph recall: ${symbol}\n${memory}`);
        if (graph) blocks.push(`koragraph explore: ${phrase}\n${graph}`);

        if (blocks.length) {
          const additionalContext = blocks.join('\n\n');
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
          }));
          if (process.env.KORAGRAPH_INJECT_DEBUG) {
            const { appendFileSync } = await import('node:fs');
            appendFileSync(process.env.KORAGRAPH_INJECT_DEBUG,
              `\n=== ${new Date().toISOString()} prompt=${JSON.stringify(prompt.slice(0, 80))}\n${additionalContext}\n`);
          }
        }
      }
    }
  }
} catch (err) {
  if (process.env.KORAGRAPH_INJECT_DEBUG) process.stderr.write(`[inject] ${err.stack}\n`);
}
process.exit(0);
