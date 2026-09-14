'use strict';

// The renderer: a pure function from a store snapshot to a set of Markdown files. Same snapshot in,
// byte-identical files out — no clock, no environment, no filesystem. Determinism lives here so the
// writer downstream can stay dumb (write what differs) and git diffs stay minimal: one fact
// changing touches one file and a few lines.

// A fact's `source` is one of the store's provenance tags. Fold them onto the two the reader cares
// about: a person stated or imported it (HUMAN) versus a machine mined it from activity (AGENT).
const HUMAN_SOURCES = new Set(['user', 'import', 'seed']);

function origin(source) {
  return HUMAN_SOURCES.has(source) ? 'HUMAN' : 'AGENT';
}

// Store timestamps are ISO-8601 with milliseconds and a Z. The date alone is stable and enough for
// a human skimming a note; ordering within a day is carried by fact id, not the clock.
function day(ts) {
  if (!ts) return '?';
  return String(ts).slice(0, 10);
}

// Classify a fact into exactly one status, most-alarming first. CONTRADICTED and UNCONFIRMED are
// the human-visible MAINTAIN queue; `expired` is a dead fact kept only until it is pruned; `live`
// is the common case.
function statusOf(f) {
  if (f.contradicted_at) {
    const why = f.contradicted_reason ? ` (${f.contradicted_reason})` : '';
    return { key: 'contradicted', attention: true, label: `❌ CONTRADICTED${why}` };
  }
  if (f.expired_at) {
    const reason = f.expiry_reason || 'unknown';
    const note = f.expiry_note ? ` — ${f.expiry_note}` : '';
    return { key: 'expired', attention: false, label: `expired (${reason}${note})` };
  }
  if (f.unconfirmed_since) {
    return { key: 'unconfirmed', attention: true, label: `⚠️ UNCONFIRMED (since ${day(f.unconfirmed_since)})` };
  }
  return { key: 'live', attention: false, label: 'live' };
}

// repo_id is a coordinate like "github.com/host/name"; file_path is repo-relative. Turn the pair
// into the relative path of the .md that holds the fact. Repo-grain facts and facts anchored to the
// repo root ('' or '.') collect in the repo's _general.md; everything else sits beside its file.
// Path segments are validated so a malformed anchor can never escape the output directory.
function safeSegments(p) {
  return String(p)
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..');
}

// A fact with no anchor at all still exists and still counts; it collects in a top-level
// _orphans.md so it stays reachable from the tree and its count reconciles with what is on disk.
const ORPHANS_MD = '_orphans.md';
const ORPHAN_ANCHOR = Object.freeze({ repo_id: '', file_path: '', symbol_name: null, grain: 'orphan', renamed_from: null });

function mdPathFor(anchor) {
  const repoDir = safeSegments(anchor.repo_id).join('/');
  // A repo_id that is empty or made only of traversal segments would otherwise produce a
  // root-anchored "/_general.md"; route it to _orphans.md rather than let it escape the tree.
  if (!repoDir) return ORPHANS_MD;
  const isGeneral = anchor.grain === 'repo' || anchor.file_path === '' || anchor.file_path === '.';
  if (isGeneral) return `${repoDir}/_general.md`;
  const fileRel = safeSegments(anchor.file_path).join('/');
  if (!fileRel) return `${repoDir}/_general.md`;
  return `${repoDir}/${fileRel}.md`;
}

// A placement is one appearance of one fact in one .md file. A fact with several anchors appears in
// several places; a symbol-grain anchor also carries the symbol it nests under. A fact with none
// gets a single orphan placement.
function placementsFor(fact) {
  if (!fact.anchors.length) {
    return [{ mdPath: ORPHANS_MD, symbol: null, anchor: ORPHAN_ANCHOR, fact }];
  }
  const out = [];
  for (const a of fact.anchors) {
    out.push({
      mdPath: mdPathFor(a),
      symbol: a.grain === 'symbol' ? (a.symbol_name || null) : null,
      anchor: a,
      fact,
    });
  }
  return out;
}

// First line of a body, collapsed and clipped for a one-line summary. Uses a code-point-safe slice
// so a multi-byte character is never cut in half.
function clip(body, max = 80) {
  const first = body.trim().split('\n')[0];
  const chars = [...first];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : first;
}

function anchorLine(anchor) {
  if (anchor.grain === 'orphan') return '(orphan)';
  const loc = anchor.symbol_name ? `${anchor.file_path}:${anchor.symbol_name}` : anchor.file_path;
  const renamed = anchor.renamed_from ? ` · renamed from ${anchor.renamed_from}` : '';
  return `${loc || '(repo)'}${renamed}`;
}

// One fact rendered as an H3 block. `headName` is the symbol or file the block is titled by, per
// the agreed layout: "### <name> — <kind>".
function factBlock(fact, headName, anchor) {
  const st = statusOf(fact);
  const lines = [];
  lines.push(`### ${headName} — ${fact.kind}`);
  lines.push('');
  lines.push(fact.body.trim());
  lines.push('');
  lines.push(`- source: ${origin(fact.source)} · tier: ${fact.tier} · confirmations: ${fact.recurrence}`);
  lines.push(`- status: ${st.label}`);
  lines.push(`- anchor: ${anchorLine(anchor)} · captured: ${day(fact.created_at)}`);
  return lines.join('\n');
}

// Assemble one file's Markdown from its placements. File-level facts come first (stable by id),
// then one subsection per symbol (stable by symbol name, facts stable by id within).
function renderFile(relFilePath, placements) {
  const fileLevel = placements.filter((p) => !p.symbol).sort((a, b) => a.fact.id - b.fact.id);
  const bySymbol = new Map();
  for (const p of placements) {
    if (!p.symbol) continue;
    if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
    bySymbol.get(p.symbol).push(p);
  }

  // Title the page by the source path the .md mirrors (strip the repo dir and the .md suffix).
  const title = relFilePath.replace(/\.md$/, '');
  const blocks = [`# ${title}`, ''];

  for (const p of fileLevel) {
    let headName = '(repo)';
    if (p.anchor.grain === 'orphan') headName = '(orphan)';
    else if (p.anchor.file_path && p.anchor.file_path !== '.') headName = p.anchor.file_path;
    blocks.push(factBlock(p.fact, headName, p.anchor), '');
  }

  for (const symbol of [...bySymbol.keys()].sort()) {
    blocks.push(`## ${symbol}`, '');
    for (const p of bySymbol.get(symbol).sort((a, b) => a.fact.id - b.fact.id)) {
      blocks.push(factBlock(p.fact, symbol, p.anchor), '');
    }
  }

  // Normalize to exactly one trailing newline.
  return `${blocks.join('\n').replace(/\n+$/, '')}\n`;
}

// The index. Counts, then the MAINTAIN queue (contradicted + unconfirmed) so the file that a human
// git-diffs first is also the one that tells them what needs a decision, then a link tree.
function renderIndex(facts, fileKeys) {
  const byKind = new Map();
  const byStatus = new Map();
  const attention = [];
  for (const f of facts) {
    byKind.set(f.kind, (byKind.get(f.kind) || 0) + 1);
    const st = statusOf(f);
    byStatus.set(st.key, (byStatus.get(st.key) || 0) + 1);
    if (st.attention) attention.push({ fact: f, st });
  }

  const lines = ['# MEMORY', ''];
  lines.push(`${facts.length} fact(s) across ${fileKeys.length} file(s).`, '');

  lines.push('## Counts', '');
  lines.push('By kind:');
  for (const k of [...byKind.keys()].sort()) lines.push(`- ${k}: ${byKind.get(k)}`);
  lines.push('', 'By status:');
  for (const k of [...byStatus.keys()].sort()) lines.push(`- ${k}: ${byStatus.get(k)}`);
  lines.push('');

  lines.push('## Needs attention', '');
  if (!attention.length) {
    lines.push('Nothing contradicted or unconfirmed. ✅', '');
  } else {
    // Contradicted before unconfirmed, then by id — a fixed order independent of scan order.
    const rank = { contradicted: 0, unconfirmed: 1 };
    attention.sort((a, b) => (rank[a.st.key] - rank[b.st.key]) || (a.fact.id - b.fact.id));
    for (const { fact, st } of attention) {
      const where = fact.anchors.length ? mdPathFor(fact.anchors[0]) : ORPHANS_MD;
      // A compact marker only — the full reason and body live one click away in the file, so this
      // queue stays skimmable no matter how long a contradiction note is.
      const marker = st.key === 'contradicted' ? '❌ CONTRADICTED' : `⚠️ UNCONFIRMED (since ${day(fact.unconfirmed_since)})`;
      lines.push(`- ${marker} — ${fact.kind}: ${clip(fact.body)} — [${where}](${where})`);
    }
    lines.push('');
  }

  lines.push('## Index', '');
  for (const key of fileKeys) lines.push(`- [${key}](${key})`);

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// Pure: snapshot -> { relpath: fileBytes }. The only entry point.
function render(snapshot) {
  const facts = snapshot.facts;
  const byFile = new Map();
  for (const fact of facts) {
    for (const p of placementsFor(fact)) {
      if (!byFile.has(p.mdPath)) byFile.set(p.mdPath, []);
      byFile.get(p.mdPath).push(p);
    }
  }

  const files = {};
  const fileKeys = [...byFile.keys()].sort();
  for (const key of fileKeys) files[key] = renderFile(key, byFile.get(key));
  files['MEMORY.md'] = renderIndex(facts, fileKeys);
  return files;
}

module.exports = { render, statusOf, origin, mdPathFor };
