// Zero-token deterministic KV/config parser.
//
// Feeds the contract_config ingest pass — structured config formats that need no LLM
// to become searchable/comprehended: .properties, .yml/.yaml, .json, .editorconfig,
// .gitattributes. Pure function, no I/O, no DB, so it is unit-testable without an ingest.
//
// Contract: parseConfigFile(relPath, content) -> {kind, entries:[{key, value, line}]} | null
// `null` means "not a recognized/parseable config format for this path" — callers must
// treat that as a skip, never a throw. A parser exception here would abort the ingest
// tail and lose files (see the adversarial case in the C2 PROOF).
//
// A result carrying `data_shape` is a file whose extension says config and whose structure says
// data; it returns zero entries so the caller's existing zero-entry branch keeps the source cache
// and the lexical chunks and writes no nodes. See the discriminator below.

const path = require('path');
const yaml = require('js-yaml');

function safeStringifyValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
}

function newShape() {
  return { leaves: 0, positional: 0, maxFanout: 0, maxFanoutPath: '' };
}

// Recursively flattens a parsed YAML/JSON document into dotted-path entries.
// Empty objects/arrays and scalars are emitted as leaves so nothing is silently dropped.
// `shape` accumulates the structural facts describeDataShape judges on, during the walk the
// flatten already performs — a second traversal would be a second answer to the same question.
function flattenToEntries(value, prefix, out, shape) {
  if (value === null || typeof value !== 'object') {
    out.push({ key: prefix, value: safeStringifyValue(value), line: null });
    countLeaf(prefix, shape);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ key: prefix, value: '[]', line: null });
      countLeaf(prefix, shape);
      return;
    }
    countFanout(value.length, prefix, shape);
    value.forEach((item, i) => flattenToEntries(item, prefix ? `${prefix}[${i}]` : `[${i}]`, out, shape));
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    out.push({ key: prefix, value: '{}', line: null });
    countLeaf(prefix, shape);
    return;
  }
  countFanout(keys.length, prefix, shape);
  for (const k of keys) {
    flattenToEntries(value[k], prefix ? `${prefix}.${k}` : k, out, shape);
  }
}

function countLeaf(prefix, shape) {
  if (!shape) return;
  shape.leaves++;
  if (/\[\d+\]/.test(prefix)) shape.positional++;
}

function countFanout(width, prefix, shape) {
  if (!shape || width <= shape.maxFanout) return;
  shape.maxFanout = width;
  shape.maxFanoutPath = prefix || '(root)';
}

function splitLines(content) {
  return content.split(/\r\n|\r|\n/);
}

// Java-style .properties: '#'/'!' comments, KV split on first unescaped '=' or ':',
// trailing '\' continues onto the next line. Duplicate keys: last occurrence wins,
// but the reported line is the line where the final value was set.
function parseProperties(content) {
  const rawLines = splitLines(content);
  const entries = new Map();

  let i = 0;
  while (i < rawLines.length) {
    let lineNo = i + 1;
    let line = rawLines[i];
    i++;

    // Line continuation: a trailing single backslash (not an escaped backslash) means
    // the logical line continues. Keep joining until no more continuation.
    while (/(^|[^\\])\\$/.test(line) && i < rawLines.length) {
      line = line.replace(/\\$/, '') + rawLines[i].replace(/^\s*/, '');
      i++;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;

    const sepMatch = trimmed.match(/[:=]/);
    if (!sepMatch) continue; // no separator — not a KV line, skip rather than guess
    const sepIdx = sepMatch.index;
    const key = trimmed.slice(0, sepIdx).trim();
    const value = trimmed.slice(sepIdx + 1).trim();
    if (!key) continue;

    entries.set(key, { key, value, line: lineNo });
  }

  return { kind: 'properties', entries: [...entries.values()] };
}

function parseYamlFile(content) {
  if (!content.trim()) return { kind: 'yaml', entries: [] };
  let doc;
  try {
    // json:true tolerates duplicate mapping keys (last wins) instead of throwing —
    // config files churn on duplicate keys far more often than hand-written YAML.
    doc = yaml.load(content, { json: true });
  } catch (_) {
    return null; // malformed YAML — not a parse failure the caller should crash on
  }
  if (doc === undefined || doc === null) return { kind: 'yaml', entries: [] };

  const out = [];
  const shape = newShape();
  flattenToEntries(doc, '', out, shape);
  // A bare scalar document flattens to a single entry with key '' — normalize that
  // to a stable placeholder key so downstream consumers never see an empty string.
  return { kind: 'yaml', entries: out.map(e => ({ ...e, key: e.key || '(root)' })), shape };
}

function parseJsonFile(content) {
  const trimmed = content.trim();
  if (!trimmed) return { kind: 'json', entries: [] };
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
  const out = [];
  const shape = newShape();
  flattenToEntries(doc, '', out, shape);
  return { kind: 'json', entries: out.map(e => ({ ...e, key: e.key || '(root)' })), shape };
}

// .editorconfig: INI-like. `[glob]` section headers scope subsequent `key = value`
// lines; keys are namespaced by their section so `[*.md]` and `[*.js]` entries for
// the same property name don't collide.
function parseEditorConfig(content) {
  const rawLines = splitLines(content);
  const entries = new Map();
  let section = '';

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      return;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const rawKey = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!rawKey) return;
    const key = section ? `${section}::${rawKey}` : rawKey;
    entries.set(key, { key, value, line: lineNo });
  });

  return { kind: 'editorconfig', entries: [...entries.values()] };
}

// .gitattributes: `<pattern> <attr1> <attr2>=<value> ...` — one entry per pattern,
// key = the glob pattern, value = the space-joined attribute list.
function parseGitAttributes(content) {
  const rawLines = splitLines(content);
  const entries = [];

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const parts = trimmed.split(/\s+/);
    const key = parts[0];
    const value = parts.slice(1).join(' ');
    if (!key) return;
    entries.push({ key, value, line: lineNo });
  });

  return { kind: 'gitattributes', entries };
}

// gettext .po/.pot: a catalogue of `msgid "..."` / `msgstr "..."` pairs, each
// optionally continued over adjacent bare string lines. This is the same object
// a Java `.properties` bundle is — the translatable-string catalogue — and it
// was the only widely-used catalogue format the config pass could not read, so
// django-machina's 24 locale files landed in the graph as 24 empty FILE nodes.
//
// The key is the msgid, not the translation: msgid is what source code and
// templates reference, and it is what a "add this string everywhere" ripple has
// to touch in every locale. Entries with an empty msgid are the catalogue
// header, not a string, and are skipped.
function parsePoFile(content) {
  const rawLines = splitLines(content);
  const entries = [];
  let msgid = null;
  let msgstr = null;
  let target = null;   // 'id' | 'str' | null — which field a bare "..." continues
  let startLine = 0;

  const unquote = (s) => {
    const m = /^\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(s);
    return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : null;
  };
  const flush = () => {
    if (msgid) entries.push({ key: msgid, value: msgstr || '', line: startLine });
    msgid = null; msgstr = null; target = null;
  };

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    let m;
    if ((m = /^msgid\s+(.*)$/.exec(trimmed))) {
      flush();
      startLine = lineNo;
      msgid = unquote(m[1]) ?? '';
      target = 'id';
      return;
    }
    if ((m = /^msgid_plural\s+(.*)$/.exec(trimmed))) { target = null; return; }
    if ((m = /^msgstr(?:\[\d+\])?\s+(.*)$/.exec(trimmed))) {
      if (msgstr === null) msgstr = unquote(m[1]) ?? '';
      target = 'str';
      return;
    }
    const cont = unquote(trimmed);
    if (cont !== null && target === 'id') msgid = (msgid || '') + cont;
    else if (cont !== null && target === 'str') msgstr = (msgstr || '') + cont;
  });
  flush();

  return { kind: 'po', entries };
}

// The ingest pass writes one CONFIG_VALUE node per entry, sequentially. A generated or vendored
// config (a 120k-key i18n dump, a machine-written .properties) parses in tens of milliseconds and
// would then issue that many round-trips inside the ingest tail. Cap the entry count per file and
// record the truncation so a capped file is a visible fact, not a silently short node list — the
// file still gets its presence floor and its full text is still in the chunk index either way.
const MAX_CONFIG_ENTRIES_PER_FILE = parseInt(process.env.INGEST_MAX_CONFIG_ENTRIES_PER_FILE || '2000', 10);

// Data-vs-config discriminator. A .json/.yaml extension says how a file is encoded, not what it
// is, and the flattener treats both the same — so a tokenizer vocabulary, a lockfile, a benchmark
// artifact and a fixture corpus all became CONFIG_VALUE nodes. Measured on this repository:
// 113,993 of 120,075 nodes were CONFIG_VALUE, of which `src/` contributed 15.
//
// The distinction is structural, not lexical. Configuration is a NAMESPACE — every leaf is
// reachable by a name a person wrote and code can reference by that name, which is the only thing
// a USES_CONFIG edge can ever be built from. Data is a COLLECTION — its leaves are reachable only
// by array position, or its keys are themselves payload. A blocklist of directory names would
// encode this repository and nothing else, so all three tests below are shape tests.
//
// Line-oriented formats (.properties, .po, .editorconfig, .gitattributes) are deliberately exempt:
// one entry per authored line cannot blow up the way a nested document can, and the i18n
// catalogues template-graph.js joins against live there.
const DATA_SHAPE_ENABLED = String(process.env.INGEST_CONFIG_DATA_SHAPE || 'on').toLowerCase() !== 'off';

// Checked before parsing, so a 26 MB benchmark artifact is never JSON.parse'd at all. No
// hand-maintained config in this tree exceeds 2 KB; the largest structured file under this bound
// is package-lock.json at 92 KB, which the fan-out test catches instead.
const DATA_MAX_BYTES = 200000;
// One container with this many siblings is a dictionary, not a settings block. Catches the
// map-shaped data a positional test cannot see: arm_20000/tokenizer.json holds 151,643 keys under
// `model.vocab`, package-lock.json 204 under `packages`.
const DATA_MAX_FANOUT = 200;
// `cases[137].expected` names nothing any caller can reference, so a document that is mostly
// positional is a record collection. Floored at a leaf count because small real configs are
// legitimately array-heavy — .claude/settings.json is 100% positional across 21 leaves.
const DATA_MIN_LEAVES = 100;
const DATA_POSITIONAL_SHARE = 0.9;
// KNOWN OVER-REACH: these thresholds can drop large but legitimate hand-written configs (a k8s
// manifest with many env vars, a package.json at exactly 200 keys). Two fixes were tried and both
// FAILED, so do not repeat them:
//   - counting a leaf positional only when the path ENDS at `[n]`: loses genuine record corpora,
//     because `cases[i].expected` is a named field too.
//   - requiring the largest array to be big: record corpora and real manifests overlap on array
//     width, so it does not separate the classes.
// The signal that does look separable is total leaves, but picking that threshold needs a corpus
// of real operational config.
// This blocks build-order #3, the config/infra join, because that plane needs exactly these files.

// npm/pnpm lockfiles are machine-generated dependency manifests, never hand-maintained config.
// The fan-out test was meant to catch package-lock.json (its `packages` map), but a project with
// fewer than DATA_MAX_FANOUT dependencies has a smaller map AND object keys the positional test
// cannot see, so a small repo's lockfile slips all three shape tests and floods the graph — 1,213
// CONFIG_VALUE nodes (20% of the whole graph) on this very repository. `lockfileVersion` is a
// definitive marker that cannot appear in real configuration.
const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml']);
function isLockfile(base, content) {
  if (LOCKFILE_NAMES.has(base)) return true;
  return /"lockfileVersion"\s*:/.test(content.slice(0, 4096));
}

// Returns a human-readable reason the payload is data, or null if it reads as configuration.
function describeDataShape(shape) {
  if (!shape) return null;
  if (shape.maxFanout >= DATA_MAX_FANOUT) {
    return `container of ${shape.maxFanout} siblings at "${shape.maxFanoutPath}"`;
  }
  if (shape.leaves >= DATA_MIN_LEAVES && shape.positional / shape.leaves >= DATA_POSITIONAL_SHARE) {
    const pct = Math.round((100 * shape.positional) / shape.leaves);
    return `${pct}% of ${shape.leaves} leaves addressed by array index`;
  }
  return null;
}

// Zero entries, not null: the caller's zero-entry branch still writes the source cache and the
// T2 lexical chunks, so a data file stays fully searchable and only stops occupying graph nodes.
// Same trade the CONFIG_LEXICAL_ONLY_PATTERNS deny-list in ingest.js already makes.
function dataFileResult(kind, reason) {
  return { kind, entries: [], data_shape: { reason } };
}

function parseConfigFile(relPath, content) {
  if (typeof content !== 'string') return null;

  const base = path.basename(relPath || '');
  const ext = path.extname(relPath || '').toLowerCase();
  const treeKind = (ext === '.yml' || ext === '.yaml') ? 'yaml' : (ext === '.json' ? 'json' : null);

  if (DATA_SHAPE_ENABLED && treeKind) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > DATA_MAX_BYTES) return dataFileResult(treeKind, `${bytes} bytes`);
  }

  let parsed;
  try {
    if (base === '.editorconfig') parsed = parseEditorConfig(content);
    else if (base === '.gitattributes') parsed = parseGitAttributes(content);
    else if (ext === '.properties') parsed = parseProperties(content);
    else if (ext === '.yml' || ext === '.yaml') parsed = parseYamlFile(content);
    else if (ext === '.json') parsed = parseJsonFile(content);
    else if (ext === '.po' || ext === '.pot') parsed = parsePoFile(content);
    else return null;
  } catch (_) {
    // Never let a malformed input abort the ingest tail — see Rule/adversarial in C2.
    return null;
  }

  if (DATA_SHAPE_ENABLED && parsed && parsed.shape) {
    const reason = describeDataShape(parsed.shape);
    if (reason) return dataFileResult(parsed.kind, reason);
  }
  // Fallback AFTER the structural tests, not before: a large lockfile is still caught by fan-out
  // (and keeps that reason), but a small repo's lockfile has a `packages` map below DATA_MAX_FANOUT
  // with object keys the positional test cannot see, so it would otherwise slip through and flood
  // the graph. `lockfileVersion` is definitive and appears in no hand-maintained config.
  if (DATA_SHAPE_ENABLED && parsed && isLockfile(base, content)) {
    return dataFileResult(parsed.kind, 'dependency lockfile');
  }

  if (!parsed || !Array.isArray(parsed.entries)) return parsed || null;
  if (parsed.entries.length > MAX_CONFIG_ENTRIES_PER_FILE) {
    return {
      ...parsed,
      entries: parsed.entries.slice(0, MAX_CONFIG_ENTRIES_PER_FILE),
      truncated: { total_entries: parsed.entries.length, cap: MAX_CONFIG_ENTRIES_PER_FILE },
    };
  }
  return parsed;
}

module.exports = { parseConfigFile, MAX_CONFIG_ENTRIES_PER_FILE, DATA_MAX_BYTES, DATA_MAX_FANOUT };
