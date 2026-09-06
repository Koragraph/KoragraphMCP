#!/usr/bin/env node
// Ground truth for the EDGE planes of a TypeScript/JavaScript repository, from the TypeScript
// compiler's own parser.
//
// Sibling of edge-referee-cpython.py, and it exists for the same reason: declaration benchmarks
// grade the NODES of a code graph and say nothing about the edges, which are the part a
// blast-radius or call-chain query actually traverses.
//
// Same referee philosophy as the declaration benchmark, and the same compiler: this is
// ast-referee-tsc.js's parser applied to the edge planes, so both benchmarks agree on what a
// TypeScript file contains. It parses each file standalone — no tsconfig, no module resolution,
// no type checker — so it reads every file exactly as written, and neither system under test
// uses it (Koragraph's TS path is tree-sitter).
//
// Three planes, each chosen because the syntax tree answers it EXACTLY — no heuristics, no
// resolution guesses:
//
//   imports      (file, name)            `import ... from 'x'`, `export ... from 'x'`,
//                                        `import x = require('x')`, and top-level-or-nested
//                                        `require('x')` calls -> the module specifier 'x'.
//                                        The FULL specifier is kept, unlike the Python referee's
//                                        first dotted component, because a specifier is one
//                                        opaque string to the module system: './a/b' and
//                                        '@scope/pkg' have no meaningful first component, and
//                                        truncating them would invent a package boundary the
//                                        language does not have.
//   inheritance  (file, child, base)     `class C extends B`, `class C implements I`,
//                                        `interface I extends A, B` -> one row per base, exactly
//                                        as the Python referee emits one row per base class.
//                                        Qualified bases keep only the final component
//                                        (`ns.Base` -> `Base`) and type arguments are dropped
//                                        (`Base<T>` -> `Base`), because the systems under test
//                                        resolve to a symbol name, not a dotted generic type,
//                                        and demanding the full form would score the naming
//                                        convention rather than the edge.
//   calls        (file, caller, callee)  a call inside a function/method body. `caller` is the
//                                        enclosing named function (or '<module>'), `callee` is
//                                        the called expression's final component. NAME-LEVEL,
//                                        deliberately: without a type checker the parser cannot
//                                        say which `send` is meant, and this referee runs no
//                                        checker on purpose (a checker needs a resolvable
//                                        tsconfig + installed dependencies, which most checkouts
//                                        do not have, and its answers would then vary with
//                                        node_modules). Anything stricter would grade our guess
//                                        against another guess.
//
// Two call-plane judgements worth naming because they are not forced by the AST:
//
//   `new C()` counts as a call to `C`. Python cannot distinguish construction from invocation —
//   `C()` is an ast.Call — so the CPython referee necessarily counts it. Excluding it here would
//   mean the two referees disagree about what the word "call" means, and cross-language numbers
//   would stop being comparable. Tagged templates and decorators are NOT counted: they have no
//   Python analogue in the CPython referee's Call plane.
//
//   Anonymous arrow/function expressions do NOT open a new caller scope; their calls attribute
//   to the nearest enclosing NAMED function. This mirrors Python lambdas, whose bodies the
//   CPython referee attributes to the enclosing def. A function expression bound to a name
//   (`const f = () => {}`, `{ f: function () {} }`, `Foo.prototype.f = function () {}`) DOES open
//   a scope named `f`, because that is the JavaScript spelling of `def f`.
//
// SKIP is edge-referee-cpython.py's set verbatim, plus bin/obj, so all sides see the same files.
// It deliberately does NOT include the declaration referee's dist/coverage/.next: the skip set is
// the Python edge referee's, and diverging would mean the two edge truths cover different trees.
//
//   node scripts/edge-referee-tsc.js <checkout> --out truth-edges.json [--lang typescript|javascript]

const fs = require('fs');
const path = require('path');

// TypeScript 7 ("tsgo") ships no JavaScript AST API — `require('typescript')` there RESOLVES and
// exports only { version, versionMajorMinor }, so a naive require succeeds and then dies on the
// first ts.SyntaxKind access. Every candidate is therefore probed for the AST API, not merely
// required, and the first one that actually has it wins. koragraph_api/node_modules currently
// holds exactly that TS7 trap, which is why the check is not optional.
// Override with TSC_REFEREE_PATH.
const TSC_CANDIDATES = [
  process.env.TSC_REFEREE_PATH,
  path.join(__dirname, 'node_modules/typescript'),
  path.join(__dirname, '../node_modules/typescript'),
  path.join(__dirname, '../../extraction-benchmark/referees/node_modules/typescript'),
  path.join(__dirname, '../../koragraph_site/node_modules/typescript'),
].filter(Boolean);

const ts = (() => {
  for (const p of TSC_CANDIDATES) {
    let mod;
    try { mod = require(p); } catch (_) { continue; }
    if (mod && mod.createSourceFile && mod.SyntaxKind) return mod;
  }
  throw new Error(
    'edge-referee-tsc: no TypeScript compiler with an AST API found. Install the pinned version '
    + '(npm ci in extraction-benchmark/referees) or set TSC_REFEREE_PATH. Note TypeScript 7 '
    + '("tsgo") exports no JavaScript AST API and cannot be used.');
})();
// Recorded in the truth file: a different compiler is a different truth.
const TS_VERSION = ts.version;

const SKIP = new Set(['.git', 'node_modules', 'target', 'build', 'vendor', '.gradle', 'out',
  '.gitnexus', 'graphify-out', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache',
  'bin', 'obj']);
const EXTS_TS = ['.ts', '.tsx', '.mts', '.cts'];
const EXTS_JS = ['.js', '.jsx', '.mjs', '.cjs'];

const argv = process.argv;
const LANG = argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : 'typescript';
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

// Final component of a callee/base expression, or null when there is no stable identifier
// (computed access `a[k]()`, immediately-invoked expressions, `super()` handled by its own kind).
function final(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return final(node.name);
  if (ts.isQualifiedName(node)) return final(node.right);
  if (ts.isExpressionWithTypeArguments(node)) return final(node.expression);
  if (ts.isTypeReferenceNode(node)) return final(node.typeName);
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return final(node.expression);
  if (node.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  return null;
}

// The name a function VALUE is bound to, so `const f = () => {}` opens a scope called `f`.
// Returns null for a genuinely anonymous function, whose body then belongs to its enclosing
// named function (the Python-lambda rule documented at the top).
function boundName(node) {
  const p = node.parent;
  if (!p) return null;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) {
    const n = p.name;
    if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) return n.text;
    return null;
  }
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && p.right === node) {
    return final(p.left);
  }
  return null;
}

function declName(node) {
  const n = node.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n)
    || ts.isNumericLiteral(n)) return n.text;
  return null; // computed member name — no stable identifier
}

function collect(sf, rel, out) {
  const stack = [];
  const caller = () => (stack.length ? stack[stack.length - 1] : '<module>');

  const addImport = (spec) => {
    if (spec && ts.isStringLiteralLike(spec)) out.imports.push({ file: rel, name: spec.text });
  };

  const visit = (node) => {
    let pushed = false;

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // `export { x } from 'y'` is an import of 'y'; a bare `export { x }` has no specifier.
      addImport(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) addImport(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'require' && node.arguments.length === 1) {
      addImport(node.arguments[0]);
    } else if (node.kind === ts.SyntaxKind.ImportKeyword && node.parent
      && ts.isCallExpression(node.parent) && node.parent.expression === node
      && node.parent.arguments.length) {
      addImport(node.parent.arguments[0]); // dynamic import('x')
    }

    if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) {
      const child = declName(node) || '<anonymous>';
      for (const h of node.heritageClauses || []) {
        for (const t of h.types) {
          const base = final(t.expression) || final(t);
          if (base) out.inheritance.push({ file: rel, child, base });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = final(node.expression);
      if (callee) out.calls.push({ file: rel, caller: caller(), callee });
    } else if (ts.isNewExpression(node)) {
      const callee = final(node.expression);
      if (callee) out.calls.push({ file: rel, caller: caller(), callee });
    }

    // Scope opening. Class bodies push their own name so a method with no name of its own is
    // still attributed somewhere sane, matching the CPython referee's class/def stack.
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isMethodSignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)
      || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const n = declName(node);
      if (n) { stack.push(n); pushed = true; }
    } else if (ts.isConstructorDeclaration(node)) {
      stack.push('constructor'); pushed = true;
    } else if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const n = (ts.isFunctionExpression(node) && declName(node)) || boundName(node);
      if (n) { stack.push(n); pushed = true; }
    }

    ts.forEachChild(node, visit);
    if (pushed) stack.pop();
  };

  ts.forEachChild(sf, visit);
}

function main() {
  const repo = argv[2];
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  if (!repo || !outPath) {
    process.stderr.write(
      'usage: edge-referee-tsc.js <checkout> --out truth-edges.json [--lang typescript|javascript]\n');
    process.exit(2);
  }

  const out = {
    imports: [], inheritance: [], calls: [], parse_errors: [], files: 0,
    referee: `TypeScript compiler API (${LANG})`, referee_version: `typescript ${TS_VERSION}`,
  };

  for (const f of walk(repo)) {
    const rel = path.relative(repo, f);
    out.files++;
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { out.parse_errors.push(rel); continue; }
    const scriptKind = LANG === 'javascript'
      ? (f.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
      : (f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, scriptKind);
    // The compiler recovers from syntax errors and still produces a (partial) tree. A file with
    // parse diagnostics is recorded as an error AND still walked, exactly as an honest referee
    // must: reporting the doubt, never silently dropping or inventing what is in the file.
    if (sf.parseDiagnostics && sf.parseDiagnostics.length) out.parse_errors.push(rel);
    collect(sf, rel, out);
  }

  fs.writeFileSync(outPath, JSON.stringify(out));
  process.stderr.write(
    `[edge-truth] ${out.files} files: ${out.imports.length} imports, `
    + `${out.inheritance.length} inheritance, ${out.calls.length} calls, `
    + `${out.parse_errors.length} parse errors -> ${outPath}\n`);
}

main();
