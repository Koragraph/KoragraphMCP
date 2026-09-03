'use strict';

// A 440-file ingest writes 131 lines to stderr and 47 of them are one line per file. Those lines
// were written for whoever was debugging the pass that emits them, and there is no logger to turn
// down: the services call console.error directly, and winston's Console transport writes through
// console._stderr, which bypasses the console reassignment main.js relies on. So the one place a
// verbosity decision can be made for all of them is the stream itself — the same reasoning main.js
// applies to stdout, one level down.

const ANSI = /\u001b\[[0-9;]*m/g;

// Counted, then reported as one line each. Their per-file detail is not deleted, it is behind
// --verbose: a file that declared nothing is a real signal, just not 47 real signals.
const INGEST_SUMMARISED = [
  {
    key: 'no_declarations',
    re: /^\[ingest\] \[DEGRADED\] .+: no structural nodes extracted$/,
    line: (n) => `${n} file(s) parsed but declared nothing`,
  },
  {
    key: 'config_capped',
    re: /^\[ingest\] \[CONTRACT_CONFIG\] .+: capped at /,
    line: (n) => `${n} data file(s) hit the per-file config-value cap`,
  },
  {
    key: 'nested_checkout',
    re: /^\[ingest-policy\] .+ is a separate git checkout/,
    line: (n) => `${n} nested git checkout(s) skipped`,
  },
  {
    key: 'unreadable',
    re: /^\[ingest\] \[PRESENCE_FLOOR\] /,
    line: (n) => `${n} file(s) could not be read at all`,
  },
  {
    // A re-export/barrel chain deeper than the hop cap is refused rather than guessed — a real but
    // internal signal. Counted here so a barrel-heavy repo reports one line instead of hundreds.
    key: 'barrel_too_deep',
    re: /^resolveExportedOrigin: hop cap \(\d+\) reached /,
    line: (n) => `${n} re-export chain(s) too deep to resolve (left unresolved, not guessed)`,
  },
  {
    // Summarised, not hidden: a re-extraction that produced zero nodes against live ones is a real
    // signal about data quality, and the guard keeping the old nodes is the right call. It is one
    // signal per ingest, not one per manifest.
    key: 'kept_previous',
    re: /^\[changed-file-replacement\] \[GUARD\] /,
    line: (n) => `${n} file(s) kept their previous nodes after a zero-node re-extraction`,
  },
];

// Per-pass statistics: every one is a count of something the summary already totals. The
// branch-keyed shape covers sixteen passes with a single rule, so a pass added later stays quiet
// without a rule added here — and anything that is NOT one of these shapes still reaches the
// reader, which is the safe direction for a line nobody has classified yet.
const INGEST_DETAIL = [
  /^\[[A-Za-z][\w-]*\] (?:\w+ )?branch(?:Id)?=/,
  // A tag followed by nothing but `key=value` statistics. The four cross-repo passes print exactly
  // this shape and none of them matched the branch-keyed rule above, because their first token is
  // `projectId=1` rather than a bare word — so a two-or-three-repo ingest, which IS the target
  // configuration, printed 19 lines of internal pass detail while the single-repo demo was clean.
  // Shape rather than five names, for the reason the rule above gives: a pass added later stays
  // quiet without an edit here. Two pairs minimum and nothing else on the line, so a sentence that
  // happens to contain one `=` still reaches the reader.
  /^\[[A-Za-z][\w-]*\](?=(?:[^=\n]*=){2})(?: [\w.]+(?:=[^\s]*)?)+$/,
  // The cross-repo roll-up. Prose, not key=value, and every number in it is already in the summary
  // line for the repo it belongs to.
  /^\[cross-repo-resolver\] \d+ stale \+ /,
  // DEGRADED_FILES is the same 46 files again, as one unwrapped paragraph of 25 names — the roll-up
  // the summary line replaces, not an extra fact.
  /^\[ingest\] \[(?:COVERAGE|TRUNCATED|PHASE|DEGRADED_FILES)\]/,
  /^\[ingest\] .*\bnodes? written\b/,
  /^\[ingest\] (?:gRPC facts|import backfill|qualified refs|topic facts|archived |done=)/,
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(?:info|debug|verbose|silly)\]: /,
];

// graph-retriever prints its seed and node counts unconditionally, while the traces around it are
// gated on DEBUG_RETRIEVER — so a person asking `koragraph cochange` for one symbol is shown
// "[graph-retriever] 8 seeds → 25 nodes" for their trouble. Suppressed here because the CLI is what
// a person reads.
const RETRIEVER_DETAIL = [/^\[graph-retriever\]/];

const HEARTBEAT_TICK_MS = 2000;
// Sits just above the longest gap between stderr lines on a full ingest (co-change mining can run
// silent for well over ten seconds), so the heartbeat below does not fire during a legitimately
// quiet phase.
const DEFAULT_SILENCE_MS = 10000;

// The quiet tail of an ingest can run long enough that the only honest reading of the terminal is
// "it may have hung". The heartbeat fires on SILENCE rather than on a timer, so a chatty phase adds
// no lines and only the quiet tail is narrated. It names the pass that spoke last: an internal
// tag, but the difference between "stuck" and "still mining git history".
function install(opts = {}) {
  const verbose = opts.verbose === true;
  const summarised = opts.summarised || INGEST_SUMMARISED;
  const detailRules = opts.detail || INGEST_DETAIL;
  const stream = opts.stream || process.stderr;
  const now = opts.now || Date.now;
  const silenceMs = opts.silenceMs === undefined ? DEFAULT_SILENCE_MS : opts.silenceMs;
  // The original function, not a bound copy: restore() must leave the stream byte-identical to how
  // it found it, or a second install() would wrap a wrapper. process.stderr.write lives on the
  // prototype, so an own property added here is deleted rather than assigned back.
  const original = stream.write;
  const hadOwn = Object.prototype.hasOwnProperty.call(stream, 'write');
  const realWrite = (text) => original.call(stream, text);
  const started = now();

  const counts = new Map();
  let detail = 0;
  let lastTag = null;
  let lastPrintAt = started;
  let partial = '';

  const emit = (text) => { lastPrintAt = now(); realWrite(text); };

  // A timer alone cannot do this: the ingest is better-sqlite3 and tree-sitter, both synchronous,
  // so an unref'd interval starves and can fire only a couple of times across a whole ingest. The
  // beat therefore has two triggers and one body: the timer for whenever the loop does yield, and
  // the arrival of a suppressed line, which is the only other evidence of progress on this thread.
  const maybeBeat = () => {
    if (silenceMs <= 0 || now() - lastPrintAt < silenceMs) return;
    emit(`  ... still working${lastTag ? `: ${lastTag}` : ''} (${Math.round((now() - started) / 1000)}s)\n`);
  };

  const consider = (line) => {
    const plain = line.replace(ANSI, '');
    // "[ingest]" prefixes half the passes and names none of them, so when it is the outer tag the
    // inner one is what tells the reader which phase is still running.
    const tag = /^\[([\w-]+)\](?:\s+\[([\w-]+)\]|\s+([\w-]+))?/.exec(plain);
    if (tag) lastTag = tag[1] === 'ingest' ? (tag[2] || tag[3] || tag[1]) : tag[1];
    if (verbose) return true;
    for (const rule of summarised) {
      if (rule.re.test(plain)) {
        counts.set(rule.key, (counts.get(rule.key) || 0) + 1);
        maybeBeat();
        return false;
      }
    }
    for (const re of detailRules) {
      if (re.test(plain)) { detail += 1; maybeBeat(); return false; }
    }
    return true;
  };

  stream.write = (chunk, encoding, callback) => {
    const cb = typeof encoding === 'function' ? encoding : callback;
    partial += typeof chunk === 'string' ? chunk : String(chunk);
    const parts = partial.split('\n');
    partial = parts.pop();
    let kept = '';
    for (const line of parts) {
      if (consider(line)) kept += `${line}\n`;
    }
    if (kept) emit(kept);
    if (typeof cb === 'function') cb();
    return true;
  };

  const timer = silenceMs > 0 ? setInterval(maybeBeat, HEARTBEAT_TICK_MS) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    summary() {
      const lines = [];
      for (const rule of summarised) {
        const n = counts.get(rule.key);
        if (n) lines.push(rule.line(n));
      }
      if (detail) lines.push(`${detail} line(s) of per-pass detail`);
      return lines;
    },
    restore() {
      if (timer) clearInterval(timer);
      if (hadOwn) stream.write = original; else delete stream.write;
      if (partial) { realWrite(`${partial}\n`); partial = ''; }
    },
  };
}

module.exports = { install, INGEST_SUMMARISED, INGEST_DETAIL, RETRIEVER_DETAIL };
