#!/usr/bin/env node
// Second, independent ground truth for TypeScript — from the TypeScript compiler's own
// parser, not from tree-sitter.
//
// Why this exists. On Java the tree-sitter referee was genuinely independent of both systems:
// Graphify parses with tree-sitter, and Koragraph's Java path is regex. On TypeScript that is
// no longer true — Koragraph's TS path is *also* tree-sitter, so a tree-sitter referee grades
// two systems that share a parser and can only disagree about which nodes to keep. A referee
// built on `typescript`'s own AST removes that objection: it is the definition of what a
// TypeScript declaration is, and neither system uses it.
//
// Emits the same JSON shape as ast-referee.py so ast-layer-compare.py can score against it
// unchanged. The inclusion rules are the same rules, restated in the compiler's vocabulary.
//
// Usage: node scripts/ast-referee-tsc.js <repoPath> --out truth.json

const fs = require('fs');
const path = require('path');
// TypeScript 7 ("tsgo") ships no JavaScript AST API — `require('typescript')` there exports
// only { version, versionMajorMinor } — so resolve a 5.x compiler explicitly.
// Override with TSC_REFEREE_PATH if this checkout moves.
// Resolution order: an explicit override, then a `typescript` installed beside this referee
// (what a reader gets from the shipped package.json), then the in-repo copy. The last of those
// was the ONLY path before, and it resolves into an unrelated marketing site's node_modules
// where `typescript` is not even a declared dependency — it arrives as a peer of
// eslint-config-next. An `npm update` over there would have silently changed benchmark truth,
// and for anyone outside this repo the path does not exist at all.
const TSC_CANDIDATES = [
  process.env.TSC_REFEREE_PATH,
  path.join(__dirname, 'node_modules/typescript'),
  path.join(__dirname, '../node_modules/typescript'),
].filter(Boolean);

const ts = (() => {
  for (const p of TSC_CANDIDATES) {
    try { return require(p); } catch (_) { /* next */ }
  }
  throw new Error(
    'ast-referee-tsc: no TypeScript compiler found. Install the pinned version beside this '
    + 'referee (npm ci in referees/) or set TSC_REFEREE_PATH. Note TypeScript 7 ("tsgo") '
    + 'exports no JavaScript AST API and cannot be used.');
})();
// Recorded in the truth file: a different compiler is a different truth.
const TS_VERSION = ts.version;

const SKIP = new Set(['.git', 'node_modules', 'target', 'build', 'vendor', '.gradle', 'out',
  'dist', 'coverage', '.next', 'bazel-out', '.angular']);
const EXTS_TS = ['.ts', '.tsx', '.mts', '.cts'];
const EXTS_JS = ['.js', '.jsx', '.mjs', '.cjs'];
const LANG = process.argv.includes('--lang')
  ? process.argv[process.argv.indexOf('--lang') + 1] : 'typescript';
const EXTS = LANG === 'javascript' ? EXTS_JS : EXTS_TS;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (EXTS.includes(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name));
  }
  return out;
}

const FN_VALUE_KINDS = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
]);

function nameOf(node) {
  const n = node.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return null; // computed property name — no stable identifier
}

function collect(sf, rel, out) {
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const enclosingType = (node) => {
    let cur = node.parent;
    while (cur) {
      if (ts.isClassDeclaration(cur) || ts.isInterfaceDeclaration(cur)
        || ts.isEnumDeclaration(cur) || ts.isTypeAliasDeclaration(cur)) {
        return nameOf(cur);
      }
      if (ts.isObjectLiteralExpression(cur) || ts.isClassExpression(cur)) return '<anonymous>';
      cur = cur.parent;
    }
    return null;
  };

  // A module constant is bound at the top level: VariableDeclaration -> VariableDeclarationList
  // -> VariableStatement -> SourceFile. Anything deeper is a local.
  const isModuleLevel = (node) => {
    const list = node.parent;
    const stmt = list && list.parent;
    return !!stmt && ts.isVariableStatement(stmt) && !!stmt.parent && ts.isSourceFile(stmt.parent);
  };

  // Is this declaration inside the BODY of some enclosing function?
  //
  // §5.2 of the paper section charges Graphify for a scope its walk is documented not to enter
  // (its own source cites issue #1077, "does not descend into a statement_block"), and publishes
  // how much of the corpus that is. That number was computed once, by hand, and could not be
  // re-derived from the artifacts afterwards: nothing recorded it. It cannot be recovered from
  // declaration spans either — lodash wraps its entire source in an anonymous IIFE, which is a
  // function body containing 95% of the file's declarations and is not itself a named
  // declaration truth records. Only the parse tree knows, so the referee has to answer it.
  //
  // A class body is NOT a function body: a method of a top-level class is top-scope for this
  // purpose, and Graphify does emit those.
  const inFunctionBody = (node) => {
    let cur = node.parent, child = node;
    while (cur) {
      if ((ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)
        || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)
        || ts.isConstructorDeclaration(cur) || ts.isGetAccessor(cur) || ts.isSetAccessor(cur))
        && cur.body && child === cur.body) {
        return true;
      }
      child = cur; cur = cur.parent;
    }
    return false;
  };

  const span = (node) => ({
    line: lineOf(node.getStart(sf)), end_line: lineOf(node.getEnd()),
    in_function_body: inFunctionBody(node),
  });

  const addType = (node, kind) => {
    const name = nameOf(node);
    if (name) out.types.push({ file: rel, name, kind, ...span(node) });
  };
  const addMethod = (node, kind, nameOverride) => {
    const name = nameOverride || nameOf(node);
    if (!name) return;
    const params = (node.parameters || []).map((p) => p.getText(sf)).join(', ');
    out.methods.push({
      file: rel, name, kind, owner: enclosingType(node),
      params: params.replace(/\s+/g, ' ').trim(), ...span(node),
    });
  };
  const addField = (node, kind, name, typeText) => {
    if (name) out.fields.push({ file: rel, name, kind, owner: enclosingType(node), type: typeText || null, line: lineOf(node.getStart(sf)), in_function_body: inFunctionBody(node) });
  };

  const visit = (node) => {
    if (ts.isClassDeclaration(node)) addType(node, 'class');
    else if (ts.isInterfaceDeclaration(node)) addType(node, 'interface');
    else if (ts.isEnumDeclaration(node)) addType(node, 'enum');
    else if (ts.isTypeAliasDeclaration(node)) addType(node, 'type_alias');
    else if (ts.isFunctionDeclaration(node)) addMethod(node, node.body ? 'function' : 'function_signature');
    else if (ts.isMethodDeclaration(node)) addMethod(node, node.body ? 'method' : 'method_signature');
    else if (ts.isConstructorDeclaration(node)) addMethod(node, 'method', 'constructor');
    else if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) addMethod(node, 'method');
    else if (ts.isMethodSignature(node)) addMethod(node, 'method_signature');
    else if (ts.isPropertyDeclaration(node)) {
      const name = nameOf(node);
      if (node.initializer && FN_VALUE_KINDS.has(node.initializer.kind)) {
        addMethod(node.initializer, 'class_property_fn', name);
      } else {
        addField(node, 'class_property', name, node.type ? node.type.getText(sf) : null);
      }
    } else if (ts.isPropertySignature(node)) {
      addField(node, 'property_signature', nameOf(node), node.type ? node.type.getText(sf) : null);
    } else if (ts.isEnumMember(node)) {
      addField(node, 'enum_member', nameOf(node), null);
    } else if (ts.isVariableDeclaration(node)) {
      if (node.initializer && FN_VALUE_KINDS.has(node.initializer.kind) && ts.isIdentifier(node.name)) {
        addMethod(node.initializer, 'const_fn', node.name.text);
      } else if (ts.isIdentifier(node.name) && isModuleLevel(node)) {
        out.constants.push({ file: rel, name: node.name.text, kind: 'module_constant', line: lineOf(node.getStart(sf)) });
      }
    } else if (ts.isPropertyAssignment(node)) {
      if (node.initializer && FN_VALUE_KINDS.has(node.initializer.kind)) {
        addMethod(node.initializer, 'object_prop_fn', nameOf(node));
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.right && FN_VALUE_KINDS.has(node.right.kind) && ts.isPropertyAccessExpression(node.left)) {
      // JavaScript only: `exports.f = fn`, `module.exports.f = fn`, `Foo.prototype.bar = fn`,
      // `this.x = fn`. Restricted to these four shapes — the same set Graphify accepts — so
      // neither side is scored against a definition the other does not use.
      const left = node.left;
      const member = ts.isIdentifier(left.name) ? left.name.text : null;
      const obj = left.expression;
      let kind = null;
      let owner = null;
      if (obj.kind === ts.SyntaxKind.ThisKeyword) kind = 'this_member';
      else if (ts.isIdentifier(obj) && obj.text === 'exports') kind = 'exports_member';
      else if (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.name)) {
        const innerObj = obj.expression;
        if (ts.isIdentifier(innerObj) && innerObj.text === 'module' && obj.name.text === 'exports') kind = 'exports_member';
        else if (ts.isIdentifier(innerObj) && obj.name.text === 'prototype') { kind = 'prototype_member'; owner = innerObj.text; }
      }
      if (kind && member) {
        addMethod(node.right, kind, member);
        if (owner) out.methods[out.methods.length - 1].owner = owner;
      }
    } else if (ts.isParameter(node)) {
      // Parameter property: an accessibility/readonly modifier on a constructor parameter
      // declares a class field.
      const mods = ts.getModifiers ? ts.getModifiers(node) : node.modifiers;
      const isParamProp = (mods || []).some((m) => [
        ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword,
        ts.SyntaxKind.OverrideKeyword,
      ].includes(m.kind));
      if (isParamProp && node.parent && ts.isConstructorDeclaration(node.parent) && ts.isIdentifier(node.name)) {
        addField(node, 'parameter_property', node.name.text, node.type ? node.type.getText(sf) : null);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

function main() {
  const repo = process.argv[2];
  const outPath = process.argv[process.argv.indexOf('--out') + 1];
  const files = walk(repo);
  const out = { repo, lang: LANG, referee: 'typescript-compiler',
    referee_version: `typescript ${TS_VERSION}`, files: 0, parse_errors: 0, types: [], methods: [], fields: [], constants: [] };

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const scriptKind = LANG === 'javascript'
      ? (f.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
      : (f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, scriptKind);
    if (sf.parseDiagnostics && sf.parseDiagnostics.length) out.parse_errors++;
    out.files++;
    collect(sf, path.relative(repo, f), out);
  }

  const kinds = {};
  for (const plane of ['types', 'methods', 'fields', 'constants']) {
    for (const it of out[plane]) if (it.kind) kinds[`${plane}:${it.kind}`] = (kinds[`${plane}:${it.kind}`] || 0) + 1;
  }
  out.counts = {
    files: out.files, types: out.types.length, methods: out.methods.length,
    fields: out.fields.length, constants: out.constants.length, parse_errors: out.parse_errors,
  };
  out.kind_breakdown = Object.fromEntries(Object.entries(kinds).sort());
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(JSON.stringify({ ...out.counts, kinds: out.kind_breakdown }, null, 2));
}

main();
