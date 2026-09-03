// env-file.js — deterministic (zero-token) reader for `.env` and `.env.example`.
//
// The ICP is one developer with two or three repositories wired together by a compose file, a
// shared database, an `.env`, and one HTTP call. Of those four, the `.env` was the only one the
// graph could not read at all. `topic-facts.js` matches `process.env.X` *inside application
// source* — the reference. Nothing read the file that supplies it — the definition. So the graph
// knew a service reads `DATABASE_URL` and had no idea what `DATABASE_URL` points at, which is
// precisely the fact that joins two repos to one database.
//
// WHAT IS WORTH EXTRACTING, AND WHAT IS NOT
// -----------------------------------------
// Not the values. A `.env` is a secrets file; see resource-ref.js for the redaction rules, which
// are applied here in `strict` mode for a real `.env` and in the ordinary mode for a committed
// `.env.example`. What is worth extracting is:
//   * the KEY NAMESPACE — every `process.env.X` in the source has a definition site now, and a
//     key present in one repo's `.env.example` and absent from another's is a real finding;
//   * what the values POINT AT — a `DATABASE_URL` parsed into scheme/host/port/dbname, a
//     `SERVICE_B_URL` naming another service, an `S3_BUCKET`, a topic name. That structure is
//     the join key (resource-ref.js#normalizeRef), and a raw string is not.
//
// FORMAT, AS THE DOTENV FAMILY ACTUALLY SPELLS IT
// -----------------------------------------------
//   export FOO=bar        the `export` prefix is accepted and recorded, not stripped silently
//   FOO="a b"             double quotes: `\n`/`\t`/`\"` unescaped, `${VAR}` interpolated
//   FOO='a b'             single quotes: literal, no escapes, no interpolation
//   FOO=bar # note        an inline comment ends an UNQUOTED value; inside quotes `#` is data
//   FOO=                  the empty string, which is not the same as an absent key
//   KEY="line1
//   line2"                a quote left open continues onto the following lines
//   FOO=${BAR:-default}   interpolated against this file's own earlier keys, then opts.lookup
// Duplicate keys: last occurrence wins, and the recorded line is where the winning value was set
// — the same rule `contract-config.js#parseProperties` already uses for `.properties`.

'use strict';

const path = require('path');
const { MAX_CONFIG_ENTRIES_PER_FILE } = require('../contract-config');
const { redactValue, referenceFrom, expandInterpolation, stripUserInfo } = require('./resource-ref');

const ENV_BASENAME_RE = /^\.env(?:\.[A-Za-z0-9_.-]+)?$/;
const ENV_ALT_BASENAME_RE = /^env\.(?:example|sample|template|dist|defaults?)$/i;
// direnv's `.envrc` is a shell script, not a KV file, and reading it as one produces nonsense.
const ENV_EXCLUDE_RE = /^\.env(?:rc|rc\..*)$/i;

// A file whose whole point is to be committed. Everything else named `.env*` is assumed to hold
// live credentials and gets strict redaction — the safe default when the name is ambiguous.
const EXAMPLE_SUFFIX_RE = /\.(?:example|sample|template|dist|defaults?|schema)$/i;

function isEnvFilePath(relPath) {
  const base = path.basename(relPath || '');
  if (!base || ENV_EXCLUDE_RE.test(base)) return false;
  return ENV_BASENAME_RE.test(base) || ENV_ALT_BASENAME_RE.test(base);
}

function isExampleEnvPath(relPath) {
  const base = path.basename(relPath || '');
  return EXAMPLE_SUFFIX_RE.test(base) || ENV_ALT_BASENAME_RE.test(base);
}

const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;
const EXPORT_RE = /^\s*export\s+/;

function unescapeDouble(s) {
  return s.replace(/\\([nrtfbv"'\\$])/g, (_, c) => {
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'f': return '\f';
      case 'b': return '\b';
      case 'v': return '\v';
      default: return c;
    }
  });
}

// Read a value starting at `rest` (the text after `=`), consuming further lines when a quote is
// left open. Returns the value, its quoting, and how many extra lines were used.
function readValue(rest, lines, startIndex) {
  const trimmedLeft = rest.replace(/^[ \t]+/, '');
  const quote = trimmedLeft[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    // Unquoted: an inline comment needs whitespace before `#`, so `FOO=a#b` keeps the `#`.
    const cut = trimmedLeft.replace(/\s+#.*$/, '');
    return { value: cut.trim(), quoted: null, consumed: 0 };
  }

  const closeAt = (text, from) => {
    for (let i = from; i < text.length; i++) {
      if (text[i] === '\\' && quote !== "'") { i++; continue; }
      if (text[i] === quote) return i;
    }
    return -1;
  };

  let buf = trimmedLeft;
  let end = closeAt(buf, 1);
  let consumed = 0;
  while (end === -1 && startIndex + consumed + 1 < lines.length) {
    consumed++;
    const from = buf.length + 1;
    buf += `\n${lines[startIndex + consumed]}`;
    end = closeAt(buf, from);
  }
  const body = end === -1 ? buf.slice(1) : buf.slice(1, end);
  const quoted = quote === "'" ? 'single' : quote === '`' ? 'backtick' : 'double';
  return { value: quoted === 'single' ? body : unescapeDouble(body), quoted, consumed };
}

/**
 * parseEnvFile(relPath, content, opts) -> {kind, isExample, strict, entries, refs, truncated?} | null
 *
 * `null` for a path this parser does not own — the same "not mine" signal `manifest.js` and
 * `contract-config.js` use, and for the same reason: this parser owns its own path dispatch.
 * Never throws.
 *
 * opts.lookup — a Map/object of variable values from outside this file (a shell environment, or
 * the `.env` a `.env.local` layers over). Consulted after the file's own earlier keys, so a local
 * definition always wins, matching `topic-facts.js#extractTopicFacts`'s treatment of
 * `opts.bindings`.
 */
function parseEnvFile(relPath, content, opts = {}) {
  if (typeof content !== 'string') return null;
  if (!isEnvFilePath(relPath)) return null;

  try {
    const isExample = isExampleEnvPath(relPath);
    const strict = !isExample;
    const lines = content.split(/\r\n|\r|\n/);
    const raw = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = ASSIGN_RE.exec(line);
      if (!m) continue;
      const key = m[1];
      const read = readValue(m[2], lines, i);
      raw.set(key, {
        key,
        raw: read.value,
        quoted: read.quoted,
        exported: EXPORT_RE.test(line),
        line: i + 1,
      });
      i += read.consumed;
    }

    // Pass 1: resolve interpolation left to right against this file's own earlier keys.
    const resolvedValues = new Map();
    const expansion = new Map();
    for (const [key, e] of raw) {
      if (e.quoted === 'single') {
        expansion.set(key, { value: e.raw, vars: [], resolved: true });
        resolvedValues.set(key, e.raw);
        continue;
      }
      const lookup = new Map(resolvedValues);
      if (opts.lookup) {
        const extra = opts.lookup instanceof Map ? opts.lookup : new Map(Object.entries(opts.lookup));
        for (const [k, v] of extra) if (!lookup.has(k)) lookup.set(k, v);
      }
      const exp = expandInterpolation(e.raw, lookup);
      expansion.set(key, exp);
      if (exp.resolved) resolvedValues.set(key, exp.value);
    }

    // Pass 2: `DB_HOST` needs `DB_PORT`, which may be defined after it.
    const portOf = (key) => {
      const sibling = resolvedValues.get(key.replace(/(HOST|HOSTNAME|ADDR|ADDRESS|SERVER)$/i, 'PORT'));
      const n = sibling != null ? Number(sibling) : NaN;
      return Number.isFinite(n) ? n : null;
    };

    const entries = [];
    const refs = [];
    const seenRef = new Set();
    for (const [key, e] of raw) {
      const exp = expansion.get(key);
      const red = redactValue(key, exp.value, { strict });
      const entry = {
        key,
        value: red.value,
        redacted: red.redacted,
        redactionReason: red.reason,
        quoted: e.quoted,
        exported: e.exported,
        line: e.line,
        // A variable NAME is not a secret, but `${SESSION_SECRET:-hunter2}`'s default is — so the
        // default is dropped alongside the value whenever the entry is redacted.
        interpolated: red.redacted ? exp.vars.map((v) => ({ ...v, default: v.default === null ? null : '' })) : exp.vars,
        resolved: exp.resolved,
        ref: null,
      };
      if (!red.redacted || red.reason === 'userinfo') {
        // Not gated on `exp.resolved` — see the same note in compose.js: an unexpanded variable
        // in the credential position does not stop the rest of the URL being a join key.
        const ref = referenceFrom(key, stripUserInfo(exp.value), { siblingPort: portOf(key) });
        if (ref) {
          entry.ref = ref;
          const dedupe = `${ref.canonical || ref.weakKey}|${ref.provenance}|${key}`;
          if (!seenRef.has(dedupe)) { seenRef.add(dedupe); refs.push({ ...ref, line: e.line }); }
        }
      }
      entries.push(entry);
    }

    const result = { kind: 'env', file: relPath || null, isExample, strict, entries, refs };
    if (entries.length > MAX_CONFIG_ENTRIES_PER_FILE) {
      return {
        ...result,
        entries: entries.slice(0, MAX_CONFIG_ENTRIES_PER_FILE),
        truncated: { total_entries: entries.length, cap: MAX_CONFIG_ENTRIES_PER_FILE },
      };
    }
    return result;
  } catch (_) {
    // Same contract as every other parser here: a malformed input must never abort the ingest.
    return null;
  }
}

module.exports = { parseEnvFile, isEnvFilePath, isExampleEnvPath };
