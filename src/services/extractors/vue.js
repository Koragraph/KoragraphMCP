'use strict';

// NOT a language port. `.vue`
// Single-File Components have no grammar of their own; this masking layer
// blanks every non-`<script>` region of the file to blank spaces, keeping
// `\r`/`\n` so line numbers stay accurate, then runs the SAME
// `_extract_generic` config-driven core every other Tier 2 language uses —
// selecting `_TSX_CONFIG`/`_JS_CONFIG`/`_TS_CONFIG` by the `<script>` block's
// `lang` attribute. This file is that masking layer plus a delegation to
// `typescript.js` (which owns both the `typescript` and `tsx` grammars) or
// `javascript.js` (`CONFIG` only — this file does its own grammar loading
// through `base.loadGrammar` rather than routing through either module's
// `extractFile`, since `extractFile`'s grammar selection is driven by the
// FILE'S extension, always `.vue` here, not the `lang` attribute this masking
// layer must honor instead).
//
// The masking function behaves as follows (translated to JS regex):
//   - blank everything outside `<script>` bodies using `[^\r\n]` -> ' ',
//     preserving every `\r` and `\n` so line numbers in the masked source
//     match the original `.vue` file exactly (a naive delete/collapse would
//     shift every downstream node's start_line — this is the single most
//     important property of this pass).
//   - the open-tag matcher `(?:"[^"]*"|'[^']*'|[^>"'])*` skips over quoted
//     attribute values so a `>` inside one (e.g. Vue 3.3+ generic components,
//     `<script setup lang="ts" generic="T extends Record<string, unknown>">`)
//     does not prematurely end the tag.
//   - `lang` is read from the FIRST script block only.
//
// Declared divergences:
//   - Every CLASS/METHOD/IMPORT divergence typescript.js/javascript.js already
//     document applies here unchanged — this file adds no new AST-walking
//     logic of its own beyond the mask and the dynamic-import regex recovery.
//   - `_emit_rescued_import`'s cross-file stub/edge machinery (extract.py:
//     1290-...) is NOT ported: it resolves specifiers against the filesystem
//     and mints FILE-level `imports_from`/`dynamic_import` edges to a FILE
//     node type this codebase's closed contract does not have (CLASS/METHOD/
//     IMPORT only). Cross-file edge resolution belongs to
//     `resolveAndWriteEdges` (ingest.js), branch-scoped, entirely outside this
//     file's scope. Instead, each recovered `import('…')` specifier is
//     registered as its own IMPORT node (the same shape `_importTs`/`_importJs`
//     already use for static imports), which is the closed-contract-legal
//     translation of "recognize this specifier as an import."

const base = require('./base');
const typescriptExtractor = require('./typescript');
const javascriptExtractor = require('./javascript');

const SCRIPT_RE = /(<script\b(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(<\/script\s*>)/gi;
const LANG_RE = /\blang\s*=\s*['"]?([A-Za-z]+)['"]?/i;

function _blank(s) {
  return s.replace(/[^\r\n]/g, ' ');
}

// Blanks everything outside `<script>` bodies, keeping every `\r`/`\n` so
// line numbers stay accurate. Returns { masked, lang } — `lang` is the first
// script block's declared `lang` attribute, or `null` if none/unset.
function _maskNonScript(src) {
  let out = '';
  let pos = 0;
  let lang = null;
  SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_RE.exec(src)) !== null) {
    out += _blank(src.slice(pos, m.index)); // markup/style before this block
    out += _blank(m[1]);                    // <script …> open tag
    out += m[2];                            // script body, verbatim
    out += _blank(m[3]);                    // </script> close tag
    pos = m.index + m[0].length;
    if (lang === null) {
      const lm = LANG_RE.exec(m[1]);
      if (lm) lang = lm[1].toLowerCase();
    }
  }
  out += _blank(src.slice(pos));
  return { masked: out, lang };
}

// `tsx`->TSX, `js`/`jsx`->JS, `ts` or unset->TS (a safe default: TS is a
// syntactic superset of JS) — mirrors `extract_vue`'s own dispatch
// (extract.py:1505-1511) exactly.
function _selectTarget(lang) {
  if (lang === 'tsx') return { grammar: 'tsx', config: typescriptExtractor.CONFIG };
  if (lang === 'js' || lang === 'jsx') return { grammar: 'javascript', config: javascriptExtractor.CONFIG };
  return { grammar: 'typescript', config: typescriptExtractor.CONFIG };
}

// Recovers dynamic `import('…')` calls the AST walk does not edge (neither
// typescript.js's nor javascript.js's CONFIG treats `import(...)` as a
// call-import-worthy construct), run against the RAW (unmasked) source. Each
// new specifier becomes its own IMPORT node — the closed-contract-legal
// translation of "recognize this as an import" (see file-header divergence
// note on why the FILE-node/edge shape is not ported).
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

// A rescued dynamic-import specifier is appended to `result.importFacts` (the
// same flat shape walkGeneric's static-import handling produces, threaded to
// the FILE node's properties.imports).
function _recoverDynamicImports(result, rawSrc) {
  if (!Array.isArray(result.importFacts)) result.importFacts = [];
  const existingNames = new Set(result.importFacts.map((f) => f.name));
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = DYNAMIC_IMPORT_RE.exec(rawSrc)) !== null) {
    const spec = m[1];
    if (!spec || existingNames.has(spec)) continue;
    const line = rawSrc.slice(0, m.index).split('\n').length;
    existingNames.add(spec);
    result.importFacts.push({ name: spec, alias: null, module: spec, line });
  }
}

async function extractFile(filePath, content) {
  const { masked, lang } = _maskNonScript(content);
  const { grammar, config } = _selectTarget(lang);
  let parser;
  try {
    parser = await base.loadGrammar(grammar);
  } catch (_) {
    return { nodes: [], edges: [], importFacts: [] };
  }
  const tree = parser.parse(masked);
  const result = base.walkGeneric(tree, masked, config);
  result.nodes = result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
  _recoverDynamicImports(result, content);
  base.validateOutput(result); // re-validate: dynamic-import nodes were appended after walkGeneric's own check
  return result;
}

async function ready() {
  try {
    await base.loadGrammar('typescript');
    await base.loadGrammar('tsx');
    await base.loadGrammar('javascript');
    return 'ready';
  } catch (_) {
    return 'failed';
  }
}

module.exports = {
  extractFile,
  ready,
  CONFIG: {
    ts: typescriptExtractor.CONFIG,
    tsx: typescriptExtractor.CONFIG,
    js: javascriptExtractor.CONFIG,
  },
  _maskNonScript, // exported for direct unit testing of the line-preservation property
};
