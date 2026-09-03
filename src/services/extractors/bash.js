'use strict';

// GRAMMAR CHOICE. This file runs on the ABI-15 @vscode build via
// base.loadGrammarNext, not the tree-sitter-wasms build every other ported
// extractor uses. The tree-sitter-wasms bash build cannot parse a `case`
// statement at all: its external scanner throws ("resolved is not a
// function") and leaves the parser instance permanently wedged, so the FIRST
// case-using script silently zeroed out every shell file after it.
// `case` is not an exotic construct in shell — it is how every argument
// parser is written.
//
// WHAT COUNTS AS A CALL, stated rather than implied. A shell `command` node is
// genuinely ambiguous: it may invoke a function defined in this file, a
// function defined in a file this one `source`s, an external binary, or a
// shell builtin. This extractor takes the only unambiguous case as a real
// edge and refuses to guess the rest:
//   - resolves to a `function_definition` in the SAME file  -> CALLS, 'same_file'
//   - anything else                                          -> unresolvedCalls,
//     for ingest-phase branch-wide resolution, which is where a `source`d
//     sibling's function can actually be found
//   - a name in _SHELL_COMMANDS (POSIX/bash builtins plus the coreutils and
//     dev tools that appear in essentially every script) -> DROPPED entirely.
//     `echo`, `set`, `local` and `git` are not edges in anybody's code graph,
//     and leaving them in unresolvedCalls would hand the branch-wide name
//     resolver hundreds of common words to match against unrelated symbols in
//     other languages. A script that defines its own `log` function still
//     gets its edges: the same-file resolution above runs first and the drop
//     list only ever suppresses the deferred bucket.
// The consequence to state honestly: a call to a function defined in a
// `source`d file produces no same-file edge here, only a deferred name.
//
// `source X` / `. X` become IMPORT FACTS, not edges: the target is a file
// path, and resolving a path to a file id is ingest/`resolution/**` work.
// The path is recorded exactly as written, so `source "${KUBE_ROOT}/hack/lib/
// util.sh"` records the unexpanded text — a shell variable's value is not
// statically known and inventing one would be a fabricated fact.
//
// Bash has no class-like construct, so CLASS is empty by the language's own
// shape, the same as c.js.

const base = require('./base');

// Dropped from the deferred-call bucket only — see the header. Builtins first,
// then the coreutils/dev tools that appear in nearly every script.
const _SHELL_COMMANDS = new Set([
  '.', ':', '[', '[[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command',
  'compgen', 'complete', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval',
  'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs',
  'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read',
  'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test',
  'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
  'awk', 'basename', 'cat', 'chmod', 'chown', 'cp', 'curl', 'cut', 'date', 'diff', 'dirname',
  'du', 'env', 'expr', 'find', 'grep', 'head', 'id', 'install', 'ln', 'ls', 'mkdir', 'mktemp',
  'mv', 'od', 'ps', 'rm', 'rmdir', 'sed', 'seq', 'sleep', 'sort', 'stat', 'tail', 'tar', 'tee',
  'touch', 'tr', 'uname', 'uniq', 'wc', 'which', 'xargs',
  'docker', 'git', 'go', 'jq', 'kubectl', 'make', 'npm', 'python', 'python3', 'yarn',
]);

const _SOURCE_COMMANDS = new Set(['source', '.']);

// `source X` and `. X` are the only two spellings of a shell include. The path is taken as
// written: an unexpanded `${VAR}` is what the file actually says, and substituting a guess for it
// would be a fabricated import.
function _extraWalkBash(node, source, ctx) {
  if (node.type !== 'command') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode || !_SOURCE_COMMANDS.has(base._readText(nameNode))) return;
  const arg = node.childForFieldName('argument') || (node.children || []).find((c) => c.isNamed && c !== nameNode);
  if (!arg) return;
  const module = base._readText(arg).replace(/^["']|["']$/g, '');
  if (!module) return;
  base.registerImportFact(ctx, { name: module, alias: null, module, line: ctx.line(node) });
}

const CONFIG = base.LanguageConfig({
  classTypes: new Set(),
  functionTypes: new Set(['function_definition']),
  importTypes: new Set(),
  extraWalkFn: _extraWalkBash,
  callTypes: new Set(['command']),
  // `command` exposes its callee through a `name` field (a `command_name` node), not
  // walkGeneric's `function` default.
  callFunctionField: 'name',
  functionBoundaryTypes: new Set(['function_definition']),
  // `case_item` is a real per-arm decision and IS counted (the tree-sitter-wasms build could not
  // parse `case` at all, which is why the previous config had to leave it out). `else_clause` is
  // not a decision. `a && b` parses as a `list` whose operator is an anonymous token that
  // logicalOperatorField cannot address — a declared undercount.
  branchNodeTypes: new Set([
    'if_statement', 'elif_clause', 'for_statement', 'c_style_for_statement',
    'while_statement', 'until_statement', 'case_item',
  ]),
});

let _parserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _parser = null;
let _parserReadyPromise = null;

function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _parser = await base.loadGrammarNext('bash');
        _parserState = 'ready';
      } catch (_) {
        _parserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

function extract(tree, content, filePath) {
  const result = base.walkGeneric(tree, content, CONFIG);
  result.nodes = result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
  result.unresolvedCalls = (result.unresolvedCalls || []).filter((c) => !_SHELL_COMMANDS.has(c.calleeName));
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') return { nodes: [], edges: [] };
  let tree = null;
  try { tree = _parser.parse(content); } catch (_) { return { nodes: [], edges: [] }; }
  if (!tree) return { nodes: [], edges: [] };
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG };
