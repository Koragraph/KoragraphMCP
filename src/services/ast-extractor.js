'use strict';

// Carrier for the Go walk's qualified-reference fact. It is deliberately NOT a seventh key on the
// extractor result: all four tree-sitter extractors are held to one six-key shape , and widening a cross-language contract for a Go-only
// fact would trade a real invariant for convenience. Read it with extractGoQualifiedRefs().
let _lastGoQualifiedRefs = [];

const path = require('path');
const { augmentHttpCallsAcrossLanguages, parameteriseConcatenatedTarget } = require('./http-call-scan');
// Identifier shapes shared by the tree-sitter planes. Every grammar here admits Unicode
// letters in identifiers (`Größe`, `変数`, `café`), so the checks are written against the Unicode
// letter/number classes rather than ASCII ranges, which would drop such a callee as if it were a
// conversion or a generic instantiation. Go exports on an uppercase first letter of any script.
const IDENT_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const DOTTED_IDENT_RE = /^[\p{L}_][\p{L}\p{N}_.]*$/u;
const GO_EXPORTED_RE = /^\p{Lu}[\p{L}\p{N}_]*$/u;

/**
 * AST-like structural extractor — uses regex patterns to extract classes,
 * functions, imports, and exports from source files without any external
 * parser dependency.
 *
 * Supports: Java, JavaScript/TypeScript, Python, Go, C#, Dart, Ruby, PHP, Rust
 *
 * Each extraction function returns structured objects with name, line number,
 * and relevant metadata (extends, implements, parameters, etc.).
 */

// ─── Language identifiers ─────────────────────────────────────────────────────

/** @enum {string} */
const LANG = Object.freeze({
  JAVA:       'java',
  JAVASCRIPT: 'javascript',
  TYPESCRIPT: 'typescript',
  PYTHON:     'python',
  GO:         'go',
  CSHARP:     'csharp',
  DART:       'dart',
  RUBY:       'ruby',
  PHP:        'php',
  RUST:       'rust',
});

// ─── Constant exclusion sets (module-level to avoid re-allocation per call) ────

const PYTHON_BUILTINS = new Set(['object', 'Exception', 'BaseException', 'ABC', 'type']);

const TS_DI_PRIMITIVES = new Set([
  'String','Number','Boolean','Array','Object','Promise','Observable',
  'Map','Set','any','void','never','undefined','null',
]);

const PYTHON_DI_BUILTINS = new Set([
  'str','int','float','bool','list','dict','tuple','set','bytes','bytearray',
  'Optional','List','Dict','Tuple','Set','Any','Type','Union','Sequence',
  'Callable','Awaitable','Coroutine','Generator','AsyncGenerator','Iterable',
]);

const GO_DI_BUILTINS = new Set([
  'error','string','int','int8','int16','int32','int64',
  'uint','uint8','uint16','uint32','uint64','uintptr',
  'float32','float64','complex64','complex128',
  'bool','byte','rune','Context',
]);

/**
 * Normalize language string to canonical form.
 * @param {string} lang
 * @returns {string}
 */
function normalizeLang(lang) {
  if (!lang) return LANG.JAVASCRIPT;
  const l = lang.toLowerCase().replace(/[^a-z]/g, '');
  switch (l) {
    case 'java':                       return LANG.JAVA;
    case 'js': case 'javascript':
    case 'jsx':                        return LANG.JAVASCRIPT;
    case 'ts': case 'typescript':
    case 'tsx':                        return LANG.TYPESCRIPT;
    case 'py': case 'python':          return LANG.PYTHON;
    case 'go': case 'golang':          return LANG.GO;
    case 'cs': case 'csharp':
    case 'c':                          return LANG.CSHARP;
    case 'dart':                       return LANG.DART;
    case 'rb': case 'ruby':            return LANG.RUBY;
    case 'php':                        return LANG.PHP;
    case 'rs': case 'rust':            return LANG.RUST;
    default:                           return LANG.JAVASCRIPT;
  }
}

/**
 * Helper: split content into lines (preserving empty lines) for line-number tracking.
 * @param {string} content
 * @returns {string[]}
 */
function toLines(content) {
  return (content || '').split('\n');
}

// Languages whose fallback (non-tree-sitter) passes below scan raw `content`/per-line text with
// regexes rather than a parse tree — DI detection, barrel re-exports, Rust impl-for, and similar.
// None of those regexes distinguish live code from a commented-out statement or a log-message
// string that happens to contain a class name as plain text: a real repo produced a DEPENDS_ON
// edge from `// log.info("calling " + OTPService...")`, a dead line matching nothing but its own
// text. `stripComments` runs once before such a pass touches `content`, blanking comment bodies to
// spaces so they cannot match a declaration/reference-shaped regex, while every caller's line and
// offset math (`lineOf`, per-line regex loops, `content.slice(0, i)`) keeps working unmodified —
// length and newline positions are preserved exactly, only comment TEXT is replaced.
//
// String-aware on purpose: a `//` inside a live string (a URL in a log message, e.g.) must not be
// read as a comment start and truncate the rest of a real code line.
const LINE_COMMENT_LANGS = new Set([
  LANG.JAVA, LANG.JAVASCRIPT, LANG.TYPESCRIPT, LANG.GO, LANG.CSHARP, LANG.RUST, LANG.DART, LANG.PHP,
]);
const BLOCK_COMMENT_LANGS = LINE_COMMENT_LANGS;
const HASH_COMMENT_LANGS = new Set([LANG.PYTHON, LANG.RUBY, LANG.PHP]);

function stripComments(content, lang) {
  const src = content || '';
  const hasLine = LINE_COMMENT_LANGS.has(lang);
  const hasBlock = BLOCK_COMMENT_LANGS.has(lang);
  const hasHash = HASH_COMMENT_LANGS.has(lang);
  if (!hasLine && !hasBlock && !hasHash) return src;

  let out = '';
  let quote = null; // '"', "'", or '`' while inside a string literal; null otherwise.
  const n = src.length;
  for (let i = 0; i < n; i += 1) {
    const c = src[i];
    if (quote) {
      out += c;
      // Swallow the escaped character too, so `\"` inside the string can't be misread as its end.
      if (c === '\\' && i + 1 < n) { out += src[i + 1]; i += 1; }
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && (lang === LANG.JAVASCRIPT || lang === LANG.TYPESCRIPT))) {
      quote = c;
      out += c;
      continue;
    }
    if (hasBlock && c === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      // `i` sits on the closing comment's `*` (or ran off the end of an unterminated comment).
      // Blank both `*/` characters and land on the `/` — the loop's own `i += 1` then steps past
      // it, so the next iteration resumes exactly one character after the comment, same as the
      // unterminated case where `i` is already `n` and this block is skipped entirely.
      if (i < n) { out += '  '; i += 1; }
      continue;
    }
    if (hasLine && c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      i -= 1;
      continue;
    }
    if (hasHash && c === '#') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      i -= 1;
      continue;
    }
    out += c;
  }
  return out;
}

// ─── Class extraction ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClassInfo
 * @property {string}   name       - Class name
 * @property {number}   line       - 1-indexed line number
 * @property {string}   [extends]  - Parent class name
 * @property {string[]} [implements] - Implemented interfaces
 * @property {string[]} [decorators] - Decorators/annotations
 * @property {string}   [visibility] - public, private, protected, default
 */

/** Regex patterns per language for class declarations. */
const CLASS_PATTERNS = {
  // Group 2 is the type name; group 3 is the FULL header tail up to `{` (or line
  // end), parsed by parseJavaSupertypes so generics (`<N extends Number>`), dotted
  // bases (`Converter.Factory`), and multiple interfaces after a generic
  // (`implements Iterable<Character>, Serializable`) all survive — the old
  // per-clause `(\w+)` / `[\w\s,]` groups dropped every one of those.
  [LANG.JAVA]: [
    // public @interface Foo {  (annotation — no supertypes; must precede interface)
    /^\s*(?:(public|private|protected)\s+)?(?:(?:static|abstract)\s+)*@interface\s+(\w+)()\s*\{?/,
    // public class Foo<T> extends Bar<T> implements Baz, Qux {
    /^\s*(?:(public|private|protected)\s+)?(?:(?:abstract|final|static|sealed|non-sealed|strictfp)\s+)*class\s+(\w+)([^{]*)/,
    // public interface Foo extends Bar, Qux {
    /^\s*(?:(public|private|protected)\s+)?(?:(?:static|abstract|final|sealed|non-sealed|strictfp)\s+)*interface\s+(\w+)([^{]*)/,
    // public enum Foo implements Bar {
    /^\s*(?:(public|private|protected)\s+)?(?:(?:static|final|strictfp)\s+)*enum\s+(\w+)([^{]*)/,
    // public record Point(int x, int y) implements Foo {
    // Records (Java 16+) had no class pattern at all, so `record LocalRecord(int i) {` fell
    // through to FUNC_PATTERNS and became a METHOD named LocalRecord with return type "record".
    /^\s*(?:(public|private|protected)\s+)?(?:(?:static|final)\s+)*record\s+(\w+)([^{]*)/,
  ],
  [LANG.JAVASCRIPT]: [
    // class Foo extends Bar {
    /^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{?/,
  ],
  [LANG.TYPESCRIPT]: [
    // class Foo extends Bar implements IBaz {
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,<>]+))?\s*\{?/,
    // interface Foo extends Bar {
    /^\s*(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w\s,<>]+))?\s*\{?/,
  ],
  [LANG.PYTHON]: [
    // class Foo(Bar, Baz):
    /^\s*class\s+(\w+)(?:\(([\w\s,.=]+)\))?\s*:/,
    // Topic = model_factory(AbstractTopic)  — a class defined by a call rather
    // than a `class` statement. django-machina builds every concrete model this
    // way, and before this the whole module produced nothing: no `Topic` node,
    // and so no link from the concrete model to the abstract class where its
    // fields are actually declared. That is the worst gap a code graph can
    // have, because lexical search cannot supply it either — a call site reads
    // `Topic.objects.filter(...)` and contains no token naming `AbstractTopic`.
    // Column 0 only (module scope), and the name must look like a type.
    /^([A-Z]\w*)\s*=\s*(?:\w+\.)*\w+\s*\(([\w\s,.=]*)\)\s*(?:#.*)?$/,
  ],
  [LANG.GO]: [
    // type Foo struct {
    /^\s*type\s+(\w+)\s+struct\s*\{?/,
    // type Foo interface {
    /^\s*type\s+(\w+)\s+interface\s*\{?/,
  ],
  [LANG.CSHARP]: [
    // public class Foo : Bar, IBaz {   — and struct / record / record struct, which the
    // pattern did not cover at all. On the files where the C# grammar gives up and this
    // scanner has to carry them, that lost every struct and record: efcore's struct recall was
    // 97.1% and record 97.2% against Roslyn purely from this omission.
    /^\s*(?:(public|private|protected|internal)\s+)?(?:(?:abstract|sealed|static|partial|readonly|ref|unsafe)\s+)*(?:class|struct|record\s+struct|record)\s+(\w+)(?:\s*[:(]\s*([\w\s,<>.]+))?\s*[\{;(]?/,
    // public interface IFoo : IBar {
    /^\s*(?:(public|private|protected|internal)\s+)?(?:partial\s+)?interface\s+(\w+)(?:\s*:\s*([\w\s,<>.]+))?\s*\{?/,
    // public enum Foo {
    /^\s*(?:(public|private|protected|internal)\s+)?enum\s+(\w+)\s*\{?/,
  ],
  [LANG.DART]: [
    // class Foo extends Bar with Mixin implements IBaz {
    /^\s*(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+with\s+([\w\s,]+))?(?:\s+implements\s+([\w\s,]+))?\s*\{?/,
    // mixin Foo on Bar {
    /^\s*mixin\s+(\w+)(?:\s+on\s+([\w\s,]+))?\s*\{?/,
  ],
  [LANG.RUBY]: [
    // class Foo < Bar  or  module Foo
    /^\s*class\s+(\w+)(?:\s*<\s*(\S+))?/,
    /^\s*module\s+(\w+)/,
  ],
  [LANG.PHP]: [
    // class Foo extends Bar implements IBaz {
    /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,\\]+))?\s*\{?/,
    // interface Foo extends IBar {
    /^\s*interface\s+(\w+)(?:\s+extends\s+([\w\s,\\]+))?\s*\{?/,
    // trait Foo {
    /^\s*trait\s+(\w+)\s*\{?/,
  ],
  [LANG.RUST]: [
    // struct Foo {  or  struct Foo;
    /^\s*(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)/,
    // enum Foo {
    /^\s*(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)/,
    // trait Foo {
    /^\s*(?:pub(?:\([\w:]+\))?\s+)?trait\s+(\w+)/,
  ],
};

/**
 * Extract class/interface/struct declarations from source code.
 * @param {string} content  - Source file content
 * @param {string} language - Language identifier
 * @returns {ClassInfo[]}
 */
function extractClasses(content, language) {
  const lang = normalizeLang(language);
  const lines = toLines(content);
  const patterns = CLASS_PATTERNS[lang] || CLASS_PATTERNS[LANG.JAVASCRIPT];
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Collect decorators/annotations above the class line
    const decorators = [];
    for (let d = i - 1; d >= 0; d--) {
      const dl = lines[d].trim();
      if (/^@\w+/.test(dl)) {
        decorators.unshift(dl);
        continue;
      }
      break;
    }

    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;

      const info = buildClassInfo(match, lang, i + 1, decorators);
      if (info) results.push(info);
      break;
    }
  }

  return results;
}

/**
 * Build a ClassInfo object from a regex match.
 * @param {RegExpExecArray} match
 * @param {string} lang
 * @param {number} lineNum
 * @param {string[]} decorators
 * @returns {ClassInfo|null}
 */
// Drop balanced <...> groups from a Java header tail so generic type parameters
// (`<N extends Number>`, whose own `extends` would otherwise be mis-read) and
// generic base arguments (`Iterable<Character>`) don't break clause splitting.
function _stripJavaAngles(s) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') depth++;
    else if (ch === '>') { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out;
}

// Parse a Java type header tail (everything after the type name up to `{`) into
// its `extends` and `implements` super-type names, keeping dotted names
// (Converter.Factory) and every entry of a comma list. Generics are stripped
// first, so bounded type params and generic bases no longer truncate the parse.
function parseJavaSupertypes(tail) {
  const s = _stripJavaAngles(tail || '');
  const permits = s.search(/\bpermits\b/);
  const body = permits >= 0 ? s.slice(0, permits) : s;
  const names = (clause) => (clause || '').split(',')
    .map((x) => x.trim()).filter((x) => /^[\w.]+$/.test(x));
  const em = body.match(/\bextends\s+([^]*?)(?=\bimplements\b|$)/);
  const im = body.match(/\bimplements\s+([^]*?)$/);
  return { extends: em ? names(em[1]) : [], implements: im ? names(im[1]) : [] };
}

function buildClassInfo(match, lang, lineNum, decorators) {
  switch (lang) {
    case LANG.JAVA: {
      // match[2] = type name, match[3] = full header tail (see CLASS_PATTERNS).
      const isAnnotation = match[0].includes('@interface');
      const isInterface = !isAnnotation && /\binterface\b/.test(match[0]);
      // Space-delimited (` enum `) missed every package-private top-level enum: at column 0
      // the match begins with the keyword, so there is no leading space.
      const isEnum = /(?:^|\s)enum\s+\w/.test(match[0]);
      const isRecord = /\brecord\s+\w/.test(match[0]);
      const name = match[2];
      if (!name) return null;
      const info = {
        name, line: lineNum,
        kind: isAnnotation ? 'annotation'
          : isRecord ? 'record' : isInterface ? 'interface' : isEnum ? 'enum' : 'class',
      };
      if (match[1]) info.visibility = match[1];
      const supers = parseJavaSupertypes(match[3]);
      if (isInterface) {
        // an interface's `extends` clause lists its super-interfaces
        if (supers.extends.length) info.implements = supers.extends;
      } else if (isRecord || isEnum || isAnnotation) {
        // these cannot extend a class; only implement interfaces
        if (supers.implements.length) info.implements = supers.implements;
      } else {
        if (supers.extends.length) [info.extends] = supers.extends;
        if (supers.implements.length) info.implements = supers.implements;
      }
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.JAVASCRIPT: {
      const name = match[1];
      if (!name) return null;
      const info = { name, line: lineNum, kind: 'class' };
      if (match[2]) info.extends = match[2];
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.TYPESCRIPT: {
      const isInterface = match[0].includes('interface');
      const name = match[1];
      if (!name) return null;
      const info = { name, line: lineNum, kind: isInterface ? 'interface' : 'class' };
      if (match[2]) {
        info.extends = match[2];
      }
      if (!isInterface && match[3]) {
        info.implements = match[3].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.PYTHON: {
      const name = match[1];
      if (!name) return null;
      // The factory-assignment pattern reaches here too. Its group 2 holds call
      // ARGUMENTS, not declared base classes, so only an argument that looks
      // like a type counts — a literal, a keyword value or a lowercase name is
      // ignored rather than guessed at.
      const isFactory = !/^\s*class\s/.test(match[0]);
      const info = { name, line: lineNum, kind: 'class' };
      if (isFactory) info.factoryAssigned = true;
      if (match[2]) {
        const bases = match[2]
          .split(',')
          .map(s => s.trim().split('=')[0].trim())
          .filter(b => b && !PYTHON_BUILTINS.has(b))
          .filter(b => !isFactory || /^[A-Z]/.test(b));
        if (isFactory && !bases.length) return null;
        if (bases.length === 1) info.extends = bases[0];
        else if (bases.length > 1) { info.extends = bases[0]; info.implements = bases.slice(1); }
      } else if (isFactory) {
        return null;
      }
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.GO: {
      const name = match[1];
      if (!name) return null;
      const isInterface = match[0].includes('interface');
      return { name, line: lineNum, kind: isInterface ? 'interface' : 'struct' };
    }
    case LANG.CSHARP: {
      const isInterface = match[0].includes('interface');
      // Space-delimited (` enum `) missed every package-private top-level enum: at column 0
      // the match begins with the keyword, so there is no leading space. `enum State` in netty
      // was typed CLASS, and with no enum owner its constants were not emitted at all — 181 of
      // the Java field-plane misses.
      const isEnum = /(?:^|\s)enum\s+\w/.test(match[0]);
      const name = match[2];
      if (!name) return null;
      const info = { name, line: lineNum, kind: isInterface ? 'interface' : isEnum ? 'enum' : 'class' };
      if (match[1]) info.visibility = match[1];
      if (match[3]) {
        const bases = match[3].split(',').map(s => s.trim()).filter(Boolean);
        // In C#, first base could be a class (no 'I' prefix) or interface
        if (bases.length > 0) {
          const firstIsClass = bases[0] && !bases[0].startsWith('I');
          if (firstIsClass && !isInterface) {
            info.extends = bases[0];
            if (bases.length > 1) info.implements = bases.slice(1);
          } else {
            info.implements = bases;
          }
        }
      }
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.DART: {
      const name = match[1];
      if (!name) return null;
      const isMixin = match[0].trimStart().startsWith('mixin');
      const info = { name, line: lineNum, kind: isMixin ? 'mixin' : 'class' };
      if (match[2]) info.extends = match[2].trim();
      // match[3] = with clause (Dart), match[4] = implements clause
      const impls = [];
      if (match[3]) impls.push(...match[3].split(',').map(s => s.trim()).filter(Boolean));
      if (match[4]) impls.push(...match[4].split(',').map(s => s.trim()).filter(Boolean));
      if (impls.length) info.implements = impls;
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.RUBY: {
      const isModule = match[0].trimStart().startsWith('module');
      const name = match[1];
      if (!name) return null;
      const info = { name, line: lineNum, kind: isModule ? 'module' : 'class' };
      if (!isModule && match[2]) info.extends = match[2].replace('::', '.').trim();
      return info;
    }
    case LANG.PHP: {
      const isTrait = match[0].trimStart().startsWith('trait');
      const isInterface = match[0].trimStart().replace(/^(abstract|final)\s+/, '').startsWith('interface');
      const name = match[1];
      if (!name) return null;
      const info = { name, line: lineNum, kind: isTrait ? 'trait' : isInterface ? 'interface' : 'class' };
      if (match[2]) info.extends = match[2].trim();
      if (match[3]) info.implements = match[3].split(',').map(s => s.replace(/\\/g, '.').trim()).filter(Boolean);
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.RUST: {
      const isEnum = match[0].includes('enum ');
      const isTrait = match[0].includes('trait ');
      const name = match[1];
      if (!name) return null;
      const vis = /pub\b/.test(match[0]) ? 'pub' : undefined;
      const info = { name, line: lineNum, kind: isEnum ? 'enum' : isTrait ? 'trait' : 'struct' };
      if (vis) info.visibility = vis;
      return info;
    }
    default:
      return null;
  }
}

// ─── Function extraction ──────────────────────────────────────────────────────

/**
 * @typedef {Object} FunctionInfo
 * @property {string}   name       - Function/method name
 * @property {number}   line       - 1-indexed line number
 * @property {string}   [params]   - Parameter list (raw string)
 * @property {string}   [returnType] - Return type annotation
 * @property {string}   [visibility] - Access modifier
 * @property {boolean}  [isAsync]  - Whether the function is async
 * @property {boolean}  [isStatic] - Whether the function is static
 * @property {string[]} [decorators] - Decorators/annotations
 */

const FUNC_PATTERNS = {
  [LANG.JAVA]: [
    // public static ResponseEntity<Foo> methodName(String arg, int count) {
    // The return type was matched but not
    // captured, so `nd.returnType` was always empty on Java and the REFERENCES
    // emission that reads it (referencedTypeNames, below) was a no-op on Java.
    // Capturing it shifts name to group 4
    // and params to group 5 — buildFuncInfo's Java case moves with it.
    // The return-type group must START with a word character: a class containing `\s` would
    // match the LINE'S OWN INDENTATION as the return type, turning any indented bare call into a
    // Mockito/AssertJ call site with a summary like `assertThat(constraintViolations.size()`.
    // Requiring a leading \w kills all of them and keeps every real declaration, including
    // generics with embedded commas and spaces (`Map<String, Integer> counts(...)`).
    // The return-type class must not admit `\s` as its FIRST character (indentation would be
    // parsed as a type). It must admit `?`, `.` and `&` after it:
    // `Class<?>`, `List<? extends T>`, `java.util.Map<K, V>` and intersection types are ordinary
    // Java, and excluding `?` alone meant `public static Class<?> getRawType(Type type)` matched
    // nothing — the method vanished, and with it its span, so its local variables then leaked
    // into the FIELD plane as though they were class state.
    // A Java 8 TYPE annotation sits between the modifiers and the return type — `public
    // @Nullable K higherKey(@ParametricNullness K key)` — and inside generic arguments
    // (`Entry<K, @Nullable V>`). The return-type group admitted no `@`, so every such method
    // was invisible: guava alone writes 3,000+ of them and the seven development repos have
    // almost none.
    // A generic method declares its type parameters BEFORE the return type — `<A extends
    // Appendable> A appendOptions(...)`. The return-type group must begin with `\w` (see above),
    // so `<` stopped the match dead and the method vanished. Losing the method loses its span,
    // and the FIELD plane below separates fields from locals by span: every local in the body
    // then shipped as class state. On commons-cli that was 2 lost methods and 17 phantom
    // fields from just two declarations. One level of nesting is admitted so
    // `<K, V extends Map<K, V>>` matches.
    /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(?:final|synchronized|abstract|native|default|strictfp)\s+)*(?:@\w+(?:\s*\([^()]*\))?\s+)*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?(\w[\w<>\[\],?.&@\s]*?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w\s,.]+)?\s*\{?/,
    // Constructor. The pattern above requires a return-type group, and a constructor has none,
    // so `public Owner()` only matched by backtracking onto the modifier — which means a
    // package-private constructor (`ClassWithField() {`, `DummyAdapter(int n) {`) had nothing
    // before the name and matched nothing at all. That was 178 of gson's 3,422 methods, almost
    // all constructors of nested and local classes. Groups 2 and 3 are deliberately empty so
    // the capture layout stays aligned with the pattern above; an empty group 3 is what marks
    // this as a constructor candidate, validated against the enclosing class name in
    // buildAstNodes (a name that is not its class's name is not a constructor).
    /^\s*(?:(public|private|protected)\s+)?()()(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?([A-Z]\w*)\s*\(([^)]*)\)\s*(?:throws\s+[\w\s,.]+)?\s*\{/,
  ],
  [LANG.JAVASCRIPT]: [
    // async function foo(a, b) {
    /^\s*(?:export\s+)?(?:default\s+)?(async\s+)?function\s*(\*?)\s*(\w+)\s*\(([^)]*)\)/,
    // const foo = async (a, b) => {   OR   const foo = function(a, b) {
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?(?:function\s*\*?\s*)?\(([^)]*)\)\s*(?:=>)?\s*\{?/,
    // method(a, b) {   (class method shorthand)
    /^\s*(async\s+)?(?:(static)\s+)?(?:(get|set)\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
  ],
  [LANG.TYPESCRIPT]: [
    // async function foo(a: string, b: number): Promise<void> {
    /^\s*(?:export\s+)?(?:default\s+)?(async\s+)?function\s*(\*?)\s*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+(?:<[^>]+>)?))?\s*\{?/,
    // const foo = async (a: string): Promise<void> => {
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(async\s+)?(?:function\s*\*?\s*)?(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s=>{]+(?:<[^>]+>)?))?\s*(?:=>)?\s*\{?/,
    // method(a: string): void {   (class method)
    /^\s*(async\s+)?(?:(static)\s+)?(?:(public|private|protected)\s+)?(?:(abstract|readonly)\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+(?:<[^>]+>)?))?\s*\{?/,
  ],
  [LANG.PYTHON]: [
    // def foo(self, x, y=10):    or    async def bar(request):
    /^\s*(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\w[\w\[\],\s]*))?\s*:/,
  ],
  [LANG.GO]: [
    // func (s *Server) HandleRequest(w http.ResponseWriter, r *http.Request) error {
    /^\s*func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s+(?:\(([^)]*)\)|(\w[\w.*]*)))?\s*\{?/,
  ],
  [LANG.CSHARP]: [
    // public async Task<IActionResult> GetUser(int id) {
    //
    // The return-type class must NOT contain `\s`, and the group must NOT be optional. With
    // both, `        DoThing(x);` matched with the leading indentation read as a return type
    // and every indented call became a METHOD — the same defect that cost Java 4,078 fabricated
    // nodes on gson, and worse here because the group was optional too. Measured on ShareX:
    // 6,728 fabricated methods against 8,268 real ones (54.9% precision).
    //
    // The trailing brace is NOT required: C# convention puts `{` on its own line, and the
    // paren-join only joins while parentheses are unbalanced, so demanding it on the same line
    // dropped 88% of the real methods. Anchoring the end of the line instead keeps
    // `Assert.Equal(a, b);`-style calls out without that cost.
    /^\s*(?:(public|private|protected|internal)\s+)?(?:(static|virtual|override|abstract|async|sealed|extern|unsafe|new|readonly|partial)\s+)*([\w<>\[\]?,.]+)\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:\{|=>|;)?\s*$/,
  ],
  [LANG.DART]: [
    // Future<void> fetchData(int id) async {   or   void _initState() {
    /^\s*(?:(static)\s+)?(?:([\w<>?]+)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\s*\{?/,
  ],
  [LANG.RUBY]: [
    // def foo(a, b)  or  def self.foo
    /^\s*def\s+((?:self\.)?[A-Za-z_]\w*[!?=]?)\s*(?:\(([^)]*)\))?/,
  ],
  [LANG.PHP]: [
    // Matches any ordering of visibility + modifiers (PSR-12: abstract/final before visibility)
    // e.g. "abstract public function", "public static function", "private function"
    /^\s*((?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*[\w\\?|]+)?\s*(?:\{|;)?/,
  ],
  [LANG.RUST]: [
    // pub async fn foo(arg: Type) -> ReturnType {   or   fn bar() {
    /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*[^{]+)?\s*\{?/,
  ],
};

// Patterns to ignore — constructors, control flow, etc.
const FUNC_IGNORE = /^\s*(?:if|else|for|while|switch|catch|do|try|return|throw|new|super|this)\b/;

// Split on commas that are not inside brackets, quotes or a template literal.
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

// A parameter list and a call's argument list are both `( ... )`, and `foo(args, function () {`
// closes with `) {` exactly as a method shorthand does — so requiring a trailing brace does
// NOT distinguish them. It was assumed to: `it('...', function () {` and
// `describe('...', () => {` were read as declarations, which on express fabricated 1,661
// METHOD nodes against 223 real ones (7.1% precision).
//
// The discriminator is what each top-level element STARTS with. A binding can only begin with
// an identifier, `{`, `[` or `...`; a string, number, regex, parenthesised arrow or `function`
// literal in that position is an argument, never a parameter. Defaults are unaffected —
// `f(mode = 'fast')` still begins with an identifier.
// A word that can never be a return TYPE, and one that can never be a method NAME. Both are
// declaration-vs-statement discriminators of the same kind as looksLikeParameterList: on a
// degraded parse the regex scanner sees `await AssertSum(x);` as `type=await name=AssertSum`,
// and `nameof(X)` / `typeof(T)` as calls to a method of that name. Measured on efcore, where
// the C# grammar gives up on its largest test files and the scanner has to carry them: 2,825
// fabricated methods, led by `nameof` (80), `Dispose` (61) and `AssertSum` (60).
const NOT_A_RETURN_TYPE = new Set([
  'await', 'return', 'throw', 'yield', 'new', 'using', 'case', 'goto', 'lock', 'fixed',
  'checked', 'unchecked', 'is', 'as', 'in', 'out', 'ref', 'params', 'when', 'where', 'select',
  'from', 'let', 'orderby', 'group', 'join', 'into', 'on', 'equals', 'by', 'ascending',
  'descending', 'and', 'or', 'not', 'null', 'true', 'false', 'base', 'this', 'typeof',
  'sizeof', 'nameof', 'default', 'stackalloc', 'switch', 'while', 'if', 'else', 'for',
  'foreach', 'do', 'try', 'catch', 'finally', 'break', 'continue', 'else', 'add', 'remove',
]);
const NOT_A_METHOD_NAME = new Set(['nameof', 'typeof', 'sizeof', 'default', 'checked', 'unchecked', 'sizeof']);

// A source line whose first token continues the previous expression. No declaration in any of
// these languages begins this way, and a method CALL on such a line is otherwise indistinguishable
// from a declaration to a line-anchored pattern. `?` and `:` are the ternary arms an
// expression-bodied C# member wraps onto; `=>`, `&&`, `||`, `.` and `+` are the rest of the set
// that appears at the head of a wrapped expression.
// Deliberately NOT included: `*` and `-`, which begin a C/C++ pointer return type and a negative
// default respectively, and `@`, which begins an annotation.
const CONTINUATION_LINE = /^\s*(?:\?|:|=>|&&|\|\||\.|\+\+?|\?\?)(?![\w:])/;

const PARAM_ELEMENT_START = /^(?:\.\.\.)?(?:[A-Za-z_$][\w$]*|\{|\[)/;
const NOT_A_PARAM_NAME = /^(?:function|new|typeof|void|delete|await|yield|class|return|in|of|instanceof|true|false|null|undefined)$/;

function looksLikeParameterList(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return true;
  for (const part of splitTopLevelCommas(s)) {
    const t = part.trim();
    if (!t) return false;
    if (!PARAM_ELEMENT_START.test(t)) return false;
    const head = /^[A-Za-z_$][\w$]*/.exec(t.replace(/^\.\.\./, ''));
    if (head && NOT_A_PARAM_NAME.test(head[0])) return false;
  }
  return true;
}

// Languages whose declarations can wrap across lines and nest parentheses inside the
// parameter list. Ruby/Python declarations terminate on the same logical line.
const PAREN_JOIN_LANGS = new Set([
  LANG.JAVA, LANG.CSHARP, LANG.TYPESCRIPT, LANG.JAVASCRIPT, LANG.PHP, LANG.DART, LANG.RUST, LANG.GO,
]);

// A declaration head may span lines. Every FUNC_PATTERNS entry matches a single line and
// requires a closing `)`, so `void foo(\n  String a\n)` matched nothing at all and the method
// was dropped outright. Join forward while parens are unbalanced so the pattern sees one
// logical declaration. Capped: an unbalanced `(` in a malformed file must not swallow the file.
const MAX_DECL_JOIN_LINES = 20;

// A line that could be the first half of a wrapped declaration head: modifiers and a return
// type, and nothing that would make it a statement in its own right.
const JOIN_BEFORE_PARAMS_LANGS = new Set([LANG.JAVA, LANG.CSHARP]);
const DECL_HEAD_NO_PARAMS = /[(){};=,:]|^\s*$|^\s*(?:\/\/|\*|\/\*|@|import\b|package\b)/;
const PARAM_LIST_OPENS = /^[\w$]+\s*\(/;

// Depth-aware, string-aware paren reader. `[^)]*` in the patterns stops at the FIRST `)`, so
// an annotated Java parameter — `findByLastName(@Param("lastName") String lastName)` — captured
// only `@Param("lastName")`. Two overloads then produced identical parameter text, identical
// canonical_key, and the ON CONFLICT upsert silently discarded one real method. Measured on
// spring-petclinic-rest: 2 of 530 methods lost this way; on annotation-heavy Spring code
// (@RequestParam/@PathVariable/@Valid) the exposure is far larger.
// Returns the text between the balanced parens, or null if they never close.
function readBalancedParens(text, openIndex) {
  if (text[openIndex] !== '(') return null;
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') break;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

// True when `line` opens more parens than it closes (outside strings) — the signal that the
// declaration continues onto the next line.
function hasUnclosedParen(line) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth > 0;
}

// Java modifiers the return-type group can capture when the declaration has no
// return type at all (a constructor) and the pattern backtracks onto them.
const JAVA_MODIFIER_KEYWORDS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract',
  'synchronized', 'native', 'strictfp', 'default', 'transient', 'volatile',
]);

// Java words that can lead a `<word> <word>;` statement without being a type. Without these a
// wrapped `throws JsonParseException;` continuation parses as a field of type "throws".
const JAVA_NON_TYPE_KEYWORDS = new Set([
  'throws', 'extends', 'implements', 'permits', 'package', 'import', 'return',
  'case', 'default', 'yield', 'assert', 'break', 'continue',
]);

// Keywords that look like call expressions but aren't callee names we care about.
const CALL_EXPR_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw',
  'typeof', 'instanceof', 'delete', 'void', 'await', 'yield',
  'super', 'this', 'do', 'try', 'else', 'class', 'function',
  'import', 'require', 'module', 'define', 'assert',
  'async', 'static', 'final', 'private', 'public', 'protected',
  'abstract', 'synchronized', 'native', 'volatile', 'transient',
]);

// The body scan below is a regex over raw source, so it reads string and comment content as
// code. On nestjs/nest,
// `forwardRef()` appears in circular-dependency.exception.ts only inside an error MESSAGE, and
// produced 9 call edges to a real `forwardRef`. Blanking literal and comment spans — keeping
// `${...}` substitutions, which ARE code — removes that class of edge without touching real
// call sites. Cached per `lines` array because every method in a file shares one.
//
// Regex literals are NOT tracked: distinguishing `/` division from a regex opener needs the
// parse this scanner exists to avoid. A regex would have to contain `identifier(` to fabricate
// anything, which is rare; the tree-sitter plane above this one is unaffected either way.
const _jsMaskCache = new WeakMap();
function maskJsLiterals(lines) {
  const cached = _jsMaskCache.get(lines);
  if (cached) return cached;
  const out = new Array(lines.length);
  const SP = (n) => ' '.repeat(n);
  let mode = null;            // null | 'block' | 'tmpl'
  const tmplStack = [];       // brace depth of each open ${ inside the current template
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let buf = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (mode === 'block') {
        const end = line.indexOf('*/', i);
        if (end < 0) { buf += SP(line.length - i); i = line.length; }
        else { buf += SP(end + 2 - i); i = end + 2; mode = null; }
        continue;
      }
      if (mode === 'tmpl') {
        if (ch === '\\') { buf += '  '; i += 2; continue; }
        if (ch === '`') { buf += ' '; i++; mode = null; continue; }
        if (ch === '$' && line[i + 1] === '{') { buf += '  '; i += 2; tmplStack.push(0); mode = null; continue; }
        buf += ' '; i++; continue;
      }
      if (tmplStack.length) {
        if (ch === '{') tmplStack[tmplStack.length - 1]++;
        else if (ch === '}') {
          if (tmplStack[tmplStack.length - 1] === 0) { tmplStack.pop(); buf += ' '; i++; mode = 'tmpl'; continue; }
          tmplStack[tmplStack.length - 1]--;
        }
      }
      if (ch === '/' && line[i + 1] === '/') { buf += SP(line.length - i); i = line.length; continue; }
      if (ch === '/' && line[i + 1] === '*') { buf += '  '; i += 2; mode = 'block'; continue; }
      if (ch === '`') { buf += ' '; i++; mode = 'tmpl'; continue; }
      if (ch === '"' || ch === "'") {
        const q = ch; buf += ' '; i++;
        while (i < line.length && line[i] !== q) {
          if (line[i] === '\\') { buf += '  '; i += 2; continue; }
          buf += ' '; i++;
        }
        if (i < line.length) { buf += ' '; i++; }
        continue;
      }
      buf += ch; i++;
    }
    out[li] = buf;
  }
  _jsMaskCache.set(lines, out);
  return out;
}

// Scans lines[startIdx..endIdx) (0-indexed, endIdx exclusive) for call expressions.
// A curated, purely structural HTTP-client shape — the same callee/verb vocabulary
// ingest.js#resolveHttpClientEdges' own (now largely unreachable) text-scan already looks
// for, mirrored here so the two stay in sync. When a call site matches, the URL/path literal
// is pulled from THIS call's own RAW (unmasked) source line — never the JS/TS literal-masked
// copy, since a URL argument is exactly the string content that mask blanks out — so
// cross-repo HTTP resolution has something structural to match against. No LLM anywhere in
// this path: it is a regex over source text already being read, at the exact line already
// captured.
const HTTP_CLIENT_CALLEE_RE = /^(?:fetch|axios(?:\.\w+)?|requests\.(?:get|post|put|delete|patch)|http\.(?:get|post|put|delete|patch)|resttemplate\.\w+|webclient\.\w+|httpclient\.\w+|feignclient\.\w+|alamofire\.\w+|urlsession\w*|okhttp\w*|retrofit\w*)$/i;
// Backtick included: a template literal is how a parameterised URL is written in JS/TS
// (`${base}/api/orders/${id}`), and leaving it out meant the single commonest shape of a
// real client call produced no edge at all.
const HTTP_URL_LITERAL_RE = /(['"`])(\/?(?:api|v\d|\/)[^'"`]*|https?:\/\/[^'"`]*)\1/;
const HTTP_VERB_HINT_RE = /\bmethod\s*:\s*['"](get|post|put|delete|patch)['"]/i;
const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);

function _httpCallHint(callee, method, rawLine) {
  if (!HTTP_CLIENT_CALLEE_RE.test(callee)) return null;
  const urlMatch = HTTP_URL_LITERAL_RE.exec(rawLine || '');
  if (!urlMatch) return null;
  const methodLower = (method || '').toLowerCase();
  const verb = HTTP_VERBS.has(methodLower) ? methodLower
    : (HTTP_VERB_HINT_RE.exec(rawLine || '') || [])[1]?.toLowerCase() || null;
  const httpTarget = parameteriseConcatenatedTarget(urlMatch[2], rawLine || '', urlMatch);
  return { httpTarget, ...(verb ? { httpVerb: verb } : {}) };
}

// Language-agnostic outbound-HTTP-call capture is shared with extractors/base.js — see
// ./http-call-scan.js. `_httpCallHint` above still handles the JS/TS/regex paths inline (it keys off
// the AST callee); the shared scan below fills in every other language at the _stampPlane chokepoint.

// Returns [{ callee: string, line: number }] with 1-indexed line numbers.
function extractCallExpressionsFromBody(rawLines, startIdx, endIdx, opts = {}) {
  const lines = opts.maskLiterals ? maskJsLiterals(rawLines) : rawLines;
  const results = [];
  const seen = new Set();
  // The receiver chain was discarded: `visitRepository.findById(id)` yielded the bare name
  // `findById`, so resolveCallExpressionEdges only ever saw an unqualified callee and had to
  // guess among every class declaring that name — 378 of 438 HEURISTIC_CALLS on
  // spring-petclinic-rest were `call_expression_ambiguous`. Its class-qualified branch
  // (`rawCallee.includes('.')`) existed but was unreachable from the regex plane. Capturing
  // the chain makes it live, and for the common DI shape the field name IS the lowercased
  // type name (`visitRepository` -> VisitRepository), which resolves exactly.
  const callPattern = /\b((?:[a-zA-Z_$][\w$]*\s*\.\s*)*)([a-zA-Z_$][\w$]*)\s*\(/g;
  for (let i = startIdx; i < Math.min(endIdx, lines.length); i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;
    callPattern.lastIndex = 0;
    let m;
    while ((m = callPattern.exec(lines[i])) !== null) {
      const name = m[2];
      if (CALL_EXPR_KEYWORDS.has(name)) continue;
      if (/\bnew\s*$/.test(lines[i].slice(0, m.index))) continue;
      // `this.`/`super.` name the caller's own class, which the resolver already prefers by
      // caller-class narrowing; carrying them through would key lookups on a keyword.
      const chain = m[1].replace(/\s+/g, '').replace(/\.$/, '')
        .split('.').filter((p) => p && p !== 'this' && p !== 'super');
      const receiver = chain.length ? chain[chain.length - 1] : null;
      const callee = receiver ? `${receiver}.${name}` : name;
      const key = `${callee}:${i + 1}`;
      if (!seen.has(key)) {
        seen.add(key);
        const entry = { callee, line: i + 1, ...(receiver ? { receiver, method: name } : {}) };
        const httpHint = _httpCallHint(callee, name, rawLines[i]);
        if (httpHint) Object.assign(entry, httpHint);
        results.push(entry);
      }
    }
  }
  return results;
}

/**
 * Extract function/method declarations from source code.
 * @param {string} content  - Source file content
 * @param {string} language - Language identifier
 * @returns {FunctionInfo[]}
 */
// Lines that are inside a multi-line string literal are text, not code, and scanning them for
// declarations is how a SQL assertion becomes a METHOD node. efcore's test suite is thousands
// of lines of `"""..."""` raw-string SQL, and on the regex fallback that produced 5,372
// fabricated methods. Covers C#/Java/Kotlin raw and text blocks (`"""`) and Python's triple
// quotes; the pattern loop below skips every line the scanner reports as inside one.
// Lines inside a multi-line string literal, which declare nothing however much they look like a
// declaration.
//
// `'''` is PYTHON's triple quote. It is not a delimiter in Java or in C#, and treating it as one
// is why this was originally scoped to C# alone: commons-lang's DurationFormatUtilsTest.java
// contains `"H'h'''m'm'"` — three apostrophes inside an ordinary string literal — which opened a
// phantom block that never closed and masked 732 lines, costing 49 real methods. The rule was
// then withheld from Java *because it moved a published number*, which is a language gate chosen
// by its effect on a score and has no place in a benchmark. The scanner is correct now and the
// rule applies to Java as well.
//
// Java opens a text block only with `"""` followed by a line terminator (JLS §3.10.6); C#'s raw
// string literal may also be single-line (`"""x"""`), so it keeps the rest-of-line test.
const MULTILINE_STRING_DELIMS = {
  [LANG.JAVA]: ['"""'],
  [LANG.CSHARP]: ['"""'],
  [LANG.PYTHON]: ['"""', "'''"],
};

function multilineStringMask(lines, lang) {
  const delims = MULTILINE_STRING_DELIMS[lang];
  if (!delims) return null;
  const openAtEolOnly = lang === LANG.JAVA;
  const mask = new Array(lines.length).fill(false);
  let inBlock = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      mask[i] = true;
      if (line.includes(inBlock)) inBlock = null;
      continue;
    }
    for (const delim of delims) {
      const first = line.indexOf(delim);
      if (first < 0) continue;
      const rest = line.slice(first + delim.length);
      if (openAtEolOnly ? rest.trim() === '' : !rest.includes(delim)) { inBlock = delim; break; }
    }
  }
  return mask;
}

// Languages whose annotations may share a line with the declaration they annotate.
const JAVA_STYLE_DECORATOR_LANGS = new Set([LANG.JAVA]);

// Lines inside an unterminated /* ... */ run, for the C-family syntaxes that have one. Cheap and
// length-preserving: index i is true when line i is comment interior, so callers keep their line
// numbers. Languages without C-style block comments get an all-false mask rather than a special
// case at every call site.
const _BLOCK_COMMENT_LANGS = new Set([LANG.JAVA, LANG.JAVASCRIPT, LANG.TYPESCRIPT, LANG.CSHARP, LANG.CPP, LANG.GO, LANG.PHP, LANG.RUST, LANG.SCALA, LANG.SWIFT, LANG.KOTLIN]);

function blockCommentMask(lines, lang) {
  const mask = new Array(lines.length).fill(false);
  if (!_BLOCK_COMMENT_LANGS.has(lang)) return mask;
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      mask[i] = true;
      if (line.includes('*/')) open = false;
      continue;
    }
    const start = line.indexOf('/*');
    if (start >= 0 && !line.slice(start).includes('*/')) open = true;
  }
  return mask;
}

// Lines that begin INSIDE an unclosed `(` — a wrapped argument list, not a declaration. gson
// writes `constructor, getBoundFields(gson, type, raw, blockInaccessible, false));` on its own
// line, and the Java method pattern reads that as return type `constructor`, name
// `getBoundFields`, params `gson, type, ...`. It is the same class of phantom as a licence
// header matching the method shape, from a different source.
// The innermost bracket must be the paren: an anonymous class body opens `{` inside the
// argument list — `foo(new Runnable() { public void run() {` — and the declarations in there
// are real, so a plain "paren depth > 0" test would delete them.
function argListContinuationMask(lines, lang) {
  const mask = new Array(lines.length).fill(false);
  if (!_BLOCK_COMMENT_LANGS.has(lang)) return mask;
  const stack = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    mask[i] = !inBlock && stack[stack.length - 1] === '(';
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (inBlock) { if (c === '*' && line[j + 1] === '/') { inBlock = false; j++; } continue; }
      if (c === '/' && line[j + 1] === '*') { inBlock = true; j++; continue; }
      if (c === '/' && line[j + 1] === '/') break;
      if (c === '"' || c === "'") {
        const quote = c;
        for (j++; j < line.length; j++) { if (line[j] === '\\') j++; else if (line[j] === quote) break; }
        continue;
      }
      if (c === '(' || c === '{' || c === '[') stack.push(c);
      else if (c === ')' || c === '}' || c === ']') stack.pop();
    }
  }
  return mask;
}

function extractFunctions(content, language) {
  const lang = normalizeLang(language);
  const lines = toLines(content);
  const patterns = FUNC_PATTERNS[lang] || FUNC_PATTERNS[LANG.JAVASCRIPT];
  const results = [];
  const seenNames = new Set();
  const inString = multilineStringMask(lines, lang);
  const inBlockComment = blockCommentMask(lines, lang);
  const inArgList = lang === LANG.JAVA ? argListContinuationMask(lines, lang) : null;

  for (let i = 0; i < lines.length; i++) {
    if (inString && inString[i]) continue;
    if (inArgList && inArgList[i]) continue;
    // The per-line check below only catches a comment whose FIRST non-space character is a
    // marker. A /* */ block written without leading asterisks — the Apache licence header on
    // every file in commons-cli — has continuation lines that look like code, and
    // `Licensed to the Apache Software Foundation (ASF) under one or more` matched the Java
    // method pattern as `Foundation (ASF)`. That produced one phantom METHOD per file: 35
    // across 36 files, 4.03% of all declarations in that corpus. JS never had it because only
    // JS/TS mask literals before scanning.
    if (inBlockComment[i]) continue;
    const line = lines[i];

    // Skip comment lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }
    if (FUNC_IGNORE.test(line)) continue;

    // Collect decorators above. Only a line that is ENTIRELY annotations belongs to this
    // declaration — `^@\w+` alone also matched the PREVIOUS declaration when it was written
    // `@JsonProperty("x") public String getX() { ... }`, attaching a whole method signature to
    // the next method as a decorator. The FIELD path has required this since it was written.
    const decorators = [];
    for (let d = i - 1; d >= 0; d--) {
      const dl = lines[d].trim();
      if (JAVA_STYLE_DECORATOR_LANGS.has(lang) ? /^(?:@\w+(?:\s*\([^()]*\))?\s*)+$/.test(dl) : /^@\w+/.test(dl)) {
        decorators.unshift(dl); continue;
      }
      if (dl === '' || dl.startsWith('//') || dl.startsWith('*')) continue;
      break;
    }

    // Java allows the annotation and the signature on ONE line — `@Override public abstract
    // int intValue();` — and every pattern here anchors on the modifiers, so an inline
    // annotation made the whole declaration invisible. The FIELD path has stripped these since
    // it was written; the method path never did. rxjava's Flowable/Observable and jackson's
    // node hierarchy are written this way throughout: 5,149 of the held-out corpus's 116,994
    // methods, against 242 on the seven development repos, which is what a held-out corpus is
    // supposed to surface. Kept as decorators rather than discarded.
    let subject = line;
    if (lang === LANG.JAVA) {
      for (;;) {
        const lead = /^\s*@[\w.]+(?:\s*\([^()]*\))?\s+(?=[\w@])/.exec(subject);
        if (!lead) break;
        decorators.push(lead[0].trim());
        subject = subject.slice(lead[0].length);
      }
    }
    // The break can also fall BEFORE the parameter list, between the return type and the name:
    //     public legacy_gencode_test.proto3.Proto3GencodeTestProto.TestMessage
    //         getDefaultInstanceForType() {
    // Neither line has a paren, so the unbalanced-paren test never fired and neither line
    // matched on its own. Generated code wraps this way constantly — protobuf's Java gencode
    // loses 262 methods in a single file — and so does any code with long qualified types.
    // Joined only when this line cannot be a statement (no `(`, `;`, `{`, `}`, `=`, `,` or
    // `:`) and the next one opens a parameter list, which no expression continuation does.
    if (JOIN_BEFORE_PARAMS_LANGS.has(lang) && !DECL_HEAD_NO_PARAMS.test(line)) {
      for (let j = i + 1; j < Math.min(lines.length, i + 1 + 3); j++) {
        const nxt = lines[j].trim();
        if (!nxt) continue;
        if (PARAM_LIST_OPENS.test(nxt)) subject = `${line} ${nxt}`;
        break;
      }
    }
    if (PAREN_JOIN_LANGS.has(lang) && hasUnclosedParen(subject)) {
      const from = subject === line ? i + 1 : i + 2;
      for (let j = from; j < Math.min(lines.length, i + 1 + MAX_DECL_JOIN_LINES); j++) {
        subject += ' ' + lines[j].trim();
        if (!hasUnclosedParen(subject)) break;
      }
    }

    // A line that OPENS with a continuation operator is the middle of an expression, and a
    // declaration never is. C# expression-bodied members put a call on such a line constantly:
    //
    //     public virtual bool CanSetForeignKey(...)
    //         => propertyNames is not null
    //             ? CanSetForeignKey(          <-- reads as `<type?> CanSetForeignKey(` to a
    //                 properties,                  pattern that only sees one line
    //
    // and the recursive call was emitted as a second declaration of the enclosing method. The
    // containment dedupe in mergeDegradedPlanes catches those; it cannot catch the ones that
    // call a DIFFERENT method, because there is no same-named node to be contained by.
    if (CONTINUATION_LINE.test(line)) continue;

    for (const pattern of patterns) {
      const match = pattern.exec(subject);
      if (!match) continue;

      const info = buildFuncInfo(match, lang, i + 1, decorators);
      if (info && !seenNames.has(`${info.name}:${info.line}`)) {
        // Re-read the parameter list with a balanced scanner. The pattern's `[^)]*` group is
        // only a gate; it truncates at any `)` nested inside an annotation or default value.
        if (PAREN_JOIN_LANGS.has(lang)) {
          const nameAt = subject.indexOf(info.name);
          if (nameAt >= 0) {
            const openAt = subject.indexOf('(', nameAt + info.name.length);
            if (openAt >= 0) {
              const balanced = readBalancedParens(subject, openAt);
              if (balanced !== null) info.params = balanced.replace(/\s+/g, ' ').trim();
            }
          }
        }
        seenNames.add(`${info.name}:${info.line}`);
        results.push(info);
      }
      break;
    }
  }

  return results;
}

/**
 * Build a FunctionInfo from a regex match.
 * @param {RegExpExecArray} match
 * @param {string} lang
 * @param {number} lineNum
 * @param {string[]} decorators
 * @returns {FunctionInfo|null}
 */
function buildFuncInfo(match, lang, lineNum, decorators) {
  switch (lang) {
    case LANG.JAVA: {
      const name = match[4];
      if (!name || /^(if|else|for|while|switch|catch|return|new|class|interface)$/.test(name)) return null;
      const info = { name, line: lineNum };
      if (match[1]) info.visibility = match[1];
      if (match[2]) info.isStatic = true;
      // A constructor has no return type, so the pattern backtracks and the
      // type group swallows a modifier instead (`public Owner(` yields
      // "public"). Rejecting the modifier keywords — and a group identical to
      // the method name — is what keeps `returnType` a type and not noise.
      const rawReturn = match[3] ? match[3].trim() : '';
      // `record Foo(int x)` matches the method shape with "record" as the return type. It is a
      // type declaration, handled by CLASS_PATTERNS — emitting it here too would duplicate it
      // as a METHOD. `record` is a restricted identifier, so it is never a real return type.
      if (/(?:^|\s)record$/.test(rawReturn)) return null;
      // Empty group 3 means the constructor pattern matched. Flagged, not trusted: buildAstNodes
      // keeps it only if the name equals the class it sits inside.
      if (match[3] === '') info.isCtorCandidate = true;
      if (rawReturn && rawReturn !== name && !JAVA_MODIFIER_KEYWORDS.has(rawReturn)) info.returnType = rawReturn;
      if (match[5] !== undefined) info.params = match[5].trim();
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.JAVASCRIPT: {
      // Pattern 0: function declaration
      if (match[3] !== undefined && /^(?:async\s+)?function/.test(match[0].trim().replace(/^export\s+(default\s+)?/, ''))) {
        const name = match[3];
        if (!name) return null;
        const info = { name, line: lineNum };
        if (match[1]) info.isAsync = true;
        if (match[4] !== undefined) info.params = match[4].trim();
        return info;
      }
      // Pattern 1: const assignment
      if (match[1] && /^\s*(?:export\s+)?(?:const|let|var)/.test(match[0])) {
        const name = match[1];
        const info = { name, line: lineNum };
        if (match[2]) info.isAsync = true;
        if (match[3] !== undefined) info.params = match[3].trim();
        return info;
      }
      // Pattern 2: class method shorthand
      {
        const name = match[4] || match[3];
        if (!name || /^(if|else|for|while|switch|catch|return|new)$/.test(name)) return null;
        if (!looksLikeParameterList(match[5])) return null;
        const info = { name, line: lineNum };
        if (match[1]) info.isAsync = true;
        if (match[2]) info.isStatic = true;
        if (match[5] !== undefined) info.params = match[5].trim();
        return info;
      }
    }
    case LANG.TYPESCRIPT: {
      // Pattern 0: function declaration
      if (/function/.test(match[0])) {
        const name = match[3];
        if (!name) return null;
        const info = { name, line: lineNum };
        if (match[1]) info.isAsync = true;
        if (match[4] !== undefined) info.params = match[4].trim();
        if (match[5]) info.returnType = match[5].trim();
        return info;
      }
      // Pattern 1: const assignment
      if (/^\s*(?:export\s+)?(?:const|let|var)/.test(match[0])) {
        const name = match[1];
        if (!name) return null;
        const info = { name, line: lineNum };
        if (match[2]) info.isAsync = true;
        if (match[3] !== undefined) info.params = match[3].trim();
        if (match[4]) info.returnType = match[4].trim();
        return info;
      }
      // Pattern 2: class method
      {
        const name = match[5];
        if (!name || /^(if|else|for|while|switch|catch|return|new|class|interface|type|enum)$/.test(name)) return null;
        const info = { name, line: lineNum };
        if (match[1]) info.isAsync = true;
        if (match[2]) info.isStatic = true;
        if (match[3]) info.visibility = match[3];
        if (match[6] !== undefined) info.params = match[6].trim();
        if (match[7]) info.returnType = match[7].trim();
        return info;
      }
    }
    case LANG.PYTHON: {
      const name = match[2];
      if (!name) return null;
      const info = { name, line: lineNum };
      if (match[1]) info.isAsync = true;
      if (match[3] !== undefined) info.params = match[3].trim();
      if (match[4]) info.returnType = match[4].trim();
      if (name.startsWith('_') && !name.startsWith('__')) info.visibility = 'private';
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.GO: {
      const name = match[3];
      if (!name) return null;
      const info = { name, line: lineNum };
      if (match[1] && match[2]) {
        info.receiver = `${match[1]} ${match[2]}`;
      }
      if (match[4] !== undefined) info.params = match[4].trim();
      if (match[5]) info.returnType = `(${match[5].trim()})`;
      else if (match[6]) info.returnType = match[6].trim();
      // Go visibility: uppercase = exported (public), lowercase = private
      info.visibility = name[0] === name[0].toUpperCase() ? 'public' : 'private';
      return info;
    }
    case LANG.CSHARP: {
      const name = match[4];
      if (!name || /^(if|else|for|foreach|while|switch|catch|return|new|class|interface|enum|using|namespace)$/.test(name)) return null;
      // `await AssertSum(x);` parses as type=`await`, name=`AssertSum`; `nameof(X)` as a call
      // to a method named `nameof`. Neither is a declaration. See NOT_A_RETURN_TYPE.
      if (NOT_A_METHOD_NAME.has(name)) return null;
      if (match[3] && NOT_A_RETURN_TYPE.has(match[3].trim().split(/\s+/).pop())) return null;
      if (!looksLikeParameterList(match[5])) return null;
      const info = { name, line: lineNum };
      if (match[1]) info.visibility = match[1];
      if (match[2]) {
        const mods = match[2].trim().split(/\s+/);
        if (mods.includes('static')) info.isStatic = true;
        if (mods.includes('async')) info.isAsync = true;
      }
      if (match[3]) info.returnType = match[3].trim();
      if (match[5] !== undefined) info.params = match[5].trim();
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.DART: {
      const name = match[3];
      if (!name || /^(if|else|for|while|switch|catch|return|new|class|mixin)$/.test(name)) return null;
      const info = { name, line: lineNum };
      if (match[1]) info.isStatic = true;
      if (match[2]) info.returnType = match[2].trim();
      if (match[4] !== undefined) info.params = match[4].trim();
      if (name.startsWith('_')) info.visibility = 'private';
      if (match[0].includes('async')) info.isAsync = true;
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.RUBY: {
      const rawName = match[1];
      if (!rawName) return null;
      const isSelf = rawName.startsWith('self.');
      const name = isSelf ? rawName.slice(5) : rawName;
      if (!name) return null;
      const info = { name, line: lineNum };
      if (match[2] !== undefined) info.params = match[2].trim();
      info.isStatic = isSelf;
      if (name.startsWith('_')) info.visibility = 'private';
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.PHP: {
      const name = match[2];
      if (!name || /^(if|else|for|while|foreach|switch|catch|return|new|class|interface|trait|namespace)$/.test(name)) return null;
      const info = { name, line: lineNum };
      const modStr = (match[1] || '').trim();
      if (modStr) {
        const mods = modStr.split(/\s+/);
        const vis = mods.find(m => /^(public|private|protected)$/.test(m));
        if (vis) info.visibility = vis;
        if (mods.includes('static')) info.isStatic = true;
      }
      if (match[3] !== undefined) info.params = match[3].trim();
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    case LANG.RUST: {
      const name = match[1];
      if (!name || /^(if|else|for|while|match|loop|return|let|use|mod|impl|pub|struct|enum|trait|type)$/.test(name)) return null;
      const info = { name, line: lineNum };
      if (match[2] !== undefined) info.params = match[2].trim();
      // Rust visibility: pub = public, else private to module
      info.visibility = /pub\b/.test(match[0]) ? 'public' : 'private';
      if (/async\s+fn/.test(match[0])) info.isAsync = true;
      if (decorators.length) info.decorators = decorators;
      return info;
    }
    default:
      return null;
  }
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ImportInfo
 * @property {string} source  - Module/package path
 * @property {number} line    - 1-indexed line number
 * @property {string[]} [names] - Named imports
 * @property {string} [alias] - Alias name (import as)
 * @property {string} [kind]  - 'default', 'named', 'namespace', 'side-effect'
 */

const IMPORT_PATTERNS = {
  [LANG.JAVA]: [
    // import com.example.MyClass;
    // import static org.junit.Assert.*;
    // Group 3 captures the wildcard suffix so buildImportInfo can tell a package/type import
    // apart from one that brings everything in scope unqualified — no capturing group around
    // it left the two indistinguishable from match[2] alone.
    /^\s*import\s+(static\s+)?([\w.]+)(\.\*)?;/,
  ],
  [LANG.JAVASCRIPT]: [
    // import Foo from 'bar';                          (default)
    // import { Foo, Bar as Baz } from 'bar';          (named)
    // import * as Foo from 'bar';                     (namespace)
    // import 'bar';                                   (side-effect)
    /^\s*import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\}\s*,?\s*)?(?:\*\s+as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/,
    // import 'foo';
    /^\s*import\s+['"]([^'"]+)['"]/,
    // const Foo = require('bar');
    /^\s*(?:const|let|var)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\(['"]([^'"]+)['"]\)/,
  ],
  [LANG.TYPESCRIPT]: [
    // Same as JS plus type-only imports:
    // import type { Foo } from 'bar';
    /^\s*import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
    /^\s*import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\}\s*,?\s*)?(?:\*\s+as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/,
    /^\s*import\s+['"]([^'"]+)['"]/,
    /^\s*(?:const|let|var)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\(['"]([^'"]+)['"]\)/,
  ],
  [LANG.PYTHON]: [
    // from foo.bar import Baz, Qux
    /^\s*from\s+([\w.]+)\s+import\s+(.+)/,
    // import foo.bar
    /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/,
  ],
  [LANG.GO]: [
    // import "fmt"
    /^\s*import\s+"([^"]+)"/,
    // import alias "path/to/pkg" — anchored to `import` so a bare `word "string"`
    // line (e.g. shell embedded in a Go string literal) is not read as an import.
    // The block form (`import ( ... )`) is handled line-by-line above.
    /^\s*import\s+(\w+)\s+"([^"]+)"/,
  ],
  [LANG.CSHARP]: [
    // using System.Collections.Generic;
    // using Alias = System.Collections.Generic;
    // global using System.Reflection;  — a C# 10 file-spanning using (typically collected in a
    // GlobalUsings.cs), which the compiler applies to every file in the assembly; the leading
    // `global` modifier is optional so both plain and global usings are captured.
    /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/,
  ],
  [LANG.DART]: [
    // import 'package:foo/bar.dart';
    // import 'package:foo/bar.dart' as baz;
    // import 'package:foo/bar.dart' show Foo, Bar;
    // import 'package:foo/bar.dart' hide Baz;
    /^\s*import\s+'([^']+)'(?:\s+as\s+(\w+))?(?:\s+(?:show|hide)\s+([\w\s,]+))?;/,
  ],
  [LANG.RUBY]: [
    // Capture the keyword separately so require_relative can be tagged and filtered downstream
    /^\s*(require_relative|require)\s+['"]([^'"]+)['"]/,
    // include SomeModule  or  extend AnotherModule
    /^\s*(include|extend|prepend)\s+(\S+)/,
  ],
  [LANG.PHP]: [
    // use App\Http\Controllers\UserController;
    // use Illuminate\Support\Facades\DB as Database;
    /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/,
    // require / require_once / include
    /^\s*(?:require|include)(?:_once)?\s+['"]([^'"]+)['"]/,
  ],
  [LANG.RUST]: [
    // use std::io::{Read, Write};
    // use crate::services::UserService;
    // pub use tokio_macros::main;            <- a RE-EXPORT is still an import of that crate
    // pub(crate) use foo::Bar;
    //
    // The visibility prefix was not accepted before, and re-exports are how a Rust facade crate
    // depends on its dependencies: tokio's `src/lib.rs` reaches tokio-macros exclusively through
    // `pub use tokio_macros::…`, so the whole `tokio -> tokio-macros` dependency was invisible.
    /^\s*(?:pub\s*(?:\([^)]*\))?\s+)?use\s+([\w:]+(?:::\{[^}]+\})?(?:::\*)?);/,
    // extern crate serde;
    /^\s*(?:pub\s+)?extern\s+crate\s+(\w+)/,
  ],
};

/**
 * Extract import/require/using statements from source code.
 * @param {string} content  - Source file content
 * @param {string} language - Language identifier
 * @returns {ImportInfo[]}
 */
function extractImports(content, language) {
  const lang = normalizeLang(language);
  const lines = toLines(content);
  const patterns = IMPORT_PATTERNS[lang] || IMPORT_PATTERNS[LANG.JAVASCRIPT];
  const results = [];

  // For Go, handle multi-line import blocks
  let inGoImportBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Go multi-line import block
    if (lang === LANG.GO) {
      if (/^\s*import\s*\(\s*$/.test(line)) {
        inGoImportBlock = true;
        continue;
      }
      if (inGoImportBlock) {
        if (/^\s*\)\s*$/.test(line)) {
          inGoImportBlock = false;
          continue;
        }
        const goMatch = /^\s*(?:(\w+)\s+)?"([^"]+)"/.exec(line);
        if (goMatch) {
          results.push({
            source: goMatch[2],
            line: i + 1,
            ...(goMatch[1] ? { alias: goMatch[1] } : {}),
            kind: 'named',
          });
        }
        continue;
      }
    }

    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;

      const info = buildImportInfo(match, lang, i + 1);
      if (info) results.push(info);
      break;
    }
  }

  return results;
}

/**
 * Build an ImportInfo from a regex match.
 * @param {RegExpExecArray} match
 * @param {string} lang
 * @param {number} lineNum
 * @returns {ImportInfo|null}
 */
function buildImportInfo(match, lang, lineNum) {
  switch (lang) {
    case LANG.JAVA: {
      const raw = match[2];
      const isStatic = !!match[1];
      const isWildcard = !!match[3];
      const segs = raw.split('.').filter(Boolean);
      // A wildcard (`import a.b.*;`) or a static-member import (`import static a.B.thing;`,
      // `import static a.B.*;`) brings its target(s) into UNQUALIFIED scope — nobody writes
      // `assertEquals.foo()` or `b.SomeClass` for the wildcard's package prefix — so neither
      // ever doubles as a call-site qualifier the way a plain class import's simple name does.
      // Only `import a.b.Foo;` makes `Foo` the receiver of `Foo.method()`, which is exactly the
      // shape cross-repo-edge-resolver.js's qualified-call binder (aliasByFile) needs to bind a
      // shared-library method call across repos — see extractors/java.js's `_importJava` for
      // the tree-sitter equivalent of this same split.
      const name = (!isWildcard && segs.length > 1) ? segs[segs.length - 1] : null;
      const module = (!isWildcard && segs.length > 1) ? segs.slice(0, -1).join('.') : raw;
      return {
        source: raw,
        line: lineNum,
        kind: isStatic ? 'static' : 'named',
        ...(name ? { name, module } : {}),
        ...(name && !isStatic ? { alias: name } : {}),
      };
    }
    case LANG.JAVASCRIPT:
    case LANG.TYPESCRIPT: {
      // Type-only import (TS only)
      if (match[0].includes('import type')) {
        const bindings = match[1] ? match[1].split(',').map(s => {
          const parts = s.trim().split(/\s+as\s+/);
          return parts[0] ? { name: parts[0], alias: parts[1] || null } : null;
        }).filter(Boolean) : [];
        return { source: match[2], line: lineNum, names: bindings.map((binding) => binding.name), bindings, kind: 'type' };
      }
      // Side-effect import: import 'foo';
      if (match.length === 2 && !match[0].includes('require')) {
        return { source: match[1], line: lineNum, kind: 'side-effect' };
      }
      // require() call
      if (match[0].includes('require')) {
        const source = match[3];
        if (!source) return null;
        const names = [];
        if (match[1]) names.push(match[1]);
        if (match[2]) names.push(...match[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
        return { source, line: lineNum, names, kind: 'require' };
      }
      // ES module import
      const source = match[4];
      if (!source) return null;
      const names = [];
      const bindings = [];
      let kind = 'named';
      if (match[1]) { names.push(match[1]); kind = 'default'; }
      if (match[2]) {
        for (const specifier of match[2].split(',')) {
          const parts = specifier.trim().split(/\s+as\s+/);
          if (!parts[0]) continue;
          names.push(parts[0]);
          bindings.push({ name: parts[0], alias: parts[1] || null });
        }
        if (kind === 'default') kind = 'mixed';
        else kind = 'named';
      }
      if (match[3]) { kind = 'namespace'; names.push(match[3]); }
      return { source, line: lineNum, names, ...(bindings.length ? { bindings } : {}), kind };
    }
    case LANG.PYTHON: {
      if (match[0].trim().startsWith('from')) {
        const source = match[1];
        const bindings = match[2].split(',').map(s => {
          const parts = s.trim().split(/\s+as\s+/);
          const name = parts[0].trim();
          return name ? { name, alias: parts[1]?.trim() || null } : null;
        }).filter(Boolean);
        return { source, line: lineNum, names: bindings.map((b) => b.name), bindings, kind: 'named' };
      }
      return {
        source: match[1],
        line: lineNum,
        ...(match[2] ? { alias: match[2] } : {}),
        kind: 'default',
      };
    }
    case LANG.GO: {
      return {
        source: match[2] || match[1],
        line: lineNum,
        ...(match[1] && match[2] ? { alias: match[1] } : {}),
        kind: 'named',
      };
    }
    case LANG.CSHARP: {
      return {
        source: match[2],
        line: lineNum,
        ...(match[1] ? { alias: match[1] } : {}),
        kind: match[1] ? 'alias' : 'named',
      };
    }
    case LANG.DART: {
      const info = { source: match[1], line: lineNum, kind: 'named' };
      if (match[2]) info.alias = match[2];
      if (match[3]) {
        info.names = match[3].split(',').map(s => s.trim()).filter(Boolean);
      }
      return info;
    }
    case LANG.RUBY: {
      const keyword = match[1];
      const source = match[2];
      if (!source) return null;
      const isRelative = keyword === 'require_relative';
      const isInclude = keyword === 'include' || keyword === 'extend' || keyword === 'prepend';
      return { source, line: lineNum, kind: isRelative ? 'require_relative' : isInclude ? 'include' : 'require' };
    }
    case LANG.PHP: {
      const source = match[2] || match[1];
      if (!source) return null;
      const info = { source, line: lineNum, kind: 'named' };
      if (match[2]) info.alias = match[2];
      return info;
    }
    case LANG.RUST: {
      const source = match[1];
      if (!source) return null;
      return { source, line: lineNum, kind: match[0].includes('extern crate') ? 'extern' : 'use' };
    }
    default:
      return null;
  }
}

// ─── Export extraction ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExportInfo
 * @property {string}   name     - Exported symbol name
 * @property {number}   line     - 1-indexed line number
 * @property {string}   kind     - 'named', 'default', 'module.exports', 're-export'
 * @property {string}   [type]   - 'class', 'function', 'const', 'interface', etc.
 */

const EXPORT_PATTERNS = {
  [LANG.JAVA]: [
    // Java: public classes/methods are implicitly exported — detect public declarations
    /^\s*public\s+(?:(?:abstract|final|static)\s+)*(?:class|interface|enum)\s+(\w+)/,
  ],
  [LANG.JAVASCRIPT]: [
    // module.exports = { foo, bar }
    /^\s*module\.exports\s*=\s*\{([^}]+)\}/,
    // module.exports = Foo
    /^\s*module\.exports\s*=\s*(\w+)/,
    // exports.foo = ...
    /^\s*exports\.(\w+)\s*=/,
    // export default Foo
    /^\s*export\s+default\s+(?:class|function\s*\*?\s*)?(\w+)?/,
    // export { foo, bar }
    /^\s*export\s+\{([^}]+)\}/,
    // export const/let/var/function/class foo
    /^\s*export\s+(?:const|let|var|function\s*\*?|class|async\s+function)\s+(\w+)/,
  ],
  [LANG.TYPESCRIPT]: [
    // Same as JS plus:
    // export type Foo = ...
    // export interface Foo {
    /^\s*export\s+(?:type|interface|enum)\s+(\w+)/,
    /^\s*export\s+default\s+(?:class|function\s*\*?\s*)?(\w+)?/,
    /^\s*export\s+\{([^}]+)\}/,
    /^\s*export\s+(?:const|let|var|function\s*\*?|class|async\s+function|abstract\s+class)\s+(\w+)/,
    /^\s*module\.exports\s*=\s*\{([^}]+)\}/,
    /^\s*module\.exports\s*=\s*(\w+)/,
  ],
  [LANG.PYTHON]: [
    // __all__ = ['foo', 'bar']
    /^\s*__all__\s*=\s*\[([^\]]+)\]/,
  ],
  [LANG.GO]: [
    // Uppercase-first identifiers are exported in Go
    /^\s*func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)\s*\(/,
    /^\s*type\s+([A-Z]\w*)\s+(?:struct|interface)/,
    /^\s*var\s+([A-Z]\w*)\s/,
    /^\s*const\s+([A-Z]\w*)\s/,
  ],
  [LANG.CSHARP]: [
    // public class/interface/enum
    /^\s*public\s+(?:(?:abstract|sealed|static|partial)\s+)*(?:class|interface|enum)\s+(\w+)/,
  ],
  [LANG.DART]: [
    // Dart: non-underscore-prefixed top-level declarations are public
    // export 'package:...' (re-export)
    /^\s*export\s+'([^']+)'\s*;/,
  ],
};

/**
 * Extract export statements from source code.
 * @param {string} content  - Source file content
 * @param {string} language - Language identifier
 * @returns {ExportInfo[]}
 */
function extractExports(content, language) {
  const lang = normalizeLang(language);
  const lines = toLines(content);
  const patterns = EXPORT_PATTERNS[lang] || EXPORT_PATTERNS[LANG.JAVASCRIPT];
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }

    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;

      const infos = buildExportInfo(match, lang, i + 1);
      if (infos && infos.length) {
        results.push(...infos);
      }
      break;
    }
  }

  return results;
}

/**
 * Build ExportInfo array from a regex match.
 * @param {RegExpExecArray} match
 * @param {string} lang
 * @param {number} lineNum
 * @returns {ExportInfo[]}
 */
function buildExportInfo(match, lang, lineNum) {
  switch (lang) {
    case LANG.JAVA:
    case LANG.CSHARP: {
      const name = match[1];
      if (!name) return [];
      return [{ name, line: lineNum, kind: 'named' }];
    }
    case LANG.JAVASCRIPT:
    case LANG.TYPESCRIPT: {
      const raw = match[0].trim();
      // module.exports = { foo, bar }
      if (raw.startsWith('module.exports') && match[1] && match[1].includes(',')) {
        return match[1].split(',').map(s => {
          const n = s.trim().split(/\s*:\s*/)[0].trim();
          return n ? { name: n, line: lineNum, kind: 'module.exports' } : null;
        }).filter(Boolean);
      }
      // module.exports = Foo
      if (raw.startsWith('module.exports')) {
        const name = match[1];
        return name ? [{ name, line: lineNum, kind: 'module.exports' }] : [];
      }
      // exports.foo = ...
      if (raw.startsWith('exports.')) {
        return [{ name: match[1], line: lineNum, kind: 'named' }];
      }
      // export default
      if (raw.startsWith('export default')) {
        const name = match[1] || 'default';
        return [{ name, line: lineNum, kind: 'default' }];
      }
      // export { foo, bar }
      if (/^export\s+\{/.test(raw)) {
        return (match[1] || '').split(',').map(s => {
          const parts = s.trim().split(/\s+as\s+/);
          const name = parts[0].trim();
          return name ? { name, line: lineNum, kind: 'named' } : null;
        }).filter(Boolean);
      }
      // export const/function/class/type/interface/enum
      if (match[1]) {
        let type = 'unknown';
        if (/export\s+const/.test(raw)) type = 'const';
        else if (/export\s+(?:async\s+)?function/.test(raw)) type = 'function';
        else if (/export\s+(?:abstract\s+)?class/.test(raw)) type = 'class';
        else if (/export\s+interface/.test(raw)) type = 'interface';
        else if (/export\s+type/.test(raw)) type = 'type';
        else if (/export\s+enum/.test(raw)) type = 'enum';
        return [{ name: match[1], line: lineNum, kind: 'named', type }];
      }
      return [];
    }
    case LANG.PYTHON: {
      if (!match[1]) return [];
      // Parse __all__ list: ['foo', 'bar']
      return match[1].split(',').map(s => {
        const name = s.trim().replace(/^['"]|['"]$/g, '');
        return name ? { name, line: lineNum, kind: 'named' } : null;
      }).filter(Boolean);
    }
    case LANG.GO: {
      const name = match[1];
      return name ? [{ name, line: lineNum, kind: 'named' }] : [];
    }
    case LANG.DART: {
      // re-export
      if (match[1]) {
        return [{ name: match[1], line: lineNum, kind: 're-export' }];
      }
      return [];
    }
    default:
      return [];
  }
}

// ─── File extension → AST language mapping ────────────────────────────────────

// This map drives the
// BESPOKE tier (extractTypeScriptTreeSitter/extractKotlinTreeSitter dispatch at
// :1943-1953), a different tier from EXT_TO_GRAMMAR's generic tier above. It
// shares the same '.tsx'->non-JSX-grammar defect as the
// generic tier — extractTypeScriptTreeSitter loads the 'typescript' grammar,
// not 'tsx', for both '.ts' and '.tsx'. Left unchanged: fixing it here would mean
// editing extractTypeScriptTreeSitter's
// grammar-loading, which only matters while the
// bespoke tier is reached at all. '.kt'/'.kts'->'java' and '.vue'->'javascript'
// are likewise left as-is; note that '.vue' never reaches this map on the
// shipping path, since extractVueSfc claims it first.
const EXT_TO_AST_LANG = {
  '.java': 'java', '.py': 'python', '.pyi': 'python',
  // .mts/.cts (and .mjs/.cjs) are the module-flavoured extensions modern packages ship; they
  // were unmapped, so every such file produced zero nodes rather than a degraded parse.
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.cs': 'csharp', '.dart': 'dart', '.go': 'go',
  '.rb': 'ruby', '.php': 'php', '.rs': 'rust', '.vue': 'javascript',
  '.kt': 'java', '.kts': 'java',
  '.sql': 'sql',
  '.c': 'cpp', '.h': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
};

// ─── Injected-dependency extraction (GQ-7a) ───────────────────────────────────

// Scans Java/C# source for @Autowired/@Inject annotated fields and constructor
// parameters, plus Spring 5+ implicit single-constructor injection (no annotation needed).
// Returns [{ fieldType, annotation, line }].
function extractInjectedDependencies(content, lang) {
  if (lang !== LANG.JAVA && lang !== LANG.CSHARP && lang !== LANG.TYPESCRIPT && lang !== LANG.PYTHON && lang !== LANG.GO) return [];
  // Every pass below is a regex over raw text, so a commented-out field/constructor declaration —
  // or, worse, a log message that merely contains a type name — would otherwise read as a real DI
  // site and emit a DEPENDS_ON edge to nothing. `content` is stripped once, up front, rather than
  // in each pass, so `lines`/line numbers derived from it are already comment-blind.
  content = stripComments(content, lang);
  const lines = toLines(content);
  const results = [];

  // Pass 1: explicit @Autowired / @Inject
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const annMatch = trimmed.match(/^@(Autowired|Inject)\b/);
    if (!annMatch) continue;
    const annotation = annMatch[1];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith('//') || next.startsWith('*')) continue;
      if (/^@\w+/.test(next)) continue;
      // Field: (private|public|protected) [final|static]* TypeName fieldName;
      const fieldMatch = next.match(
        /^(?:private|public|protected)\s+(?:(?:final|static)\s+)*([A-Z][\w]*(?:<[^>]+>)?)\s+\w+\s*(?:=.*)?;/
      );
      if (fieldMatch) {
        const rawType = fieldMatch[1].replace(/<[^>]*>/g, '').trim();
        if (rawType && /^[A-Z]/.test(rawType)) results.push({ fieldType: rawType, annotation, line: j + 1 });
        break;
      }
      // Constructor or setter: public TypeOrVoid Name(TypeA a, TypeB b)
      const ctorMatch = next.match(/^(?:public|protected)\s+(?:\w+\s+)?(\w+)\s*\(([^)]*)\)/);
      if (ctorMatch) {
        const paramPattern = /([A-Z][\w]*(?:<[^>]+>)?)\s+\w+/g;
        let pm;
        while ((pm = paramPattern.exec(ctorMatch[2])) !== null) {
          const rawType = pm[1].replace(/<[^>]*>/g, '').trim();
          if (rawType && /^[A-Z]/.test(rawType)) results.push({ fieldType: rawType, annotation, line: j + 1 });
        }
        break;
      }
      break;
    }
  }

  // Pass 1b: NestJS/TypeScript constructor injection.
  // Detects @Injectable() classes (or any class with a constructor having typed uppercase params).
  // Matches: constructor(private readonly foo: FooService, private bar: BarService)
  if (lang === LANG.TYPESCRIPT) {
    const ctorBlockRe = /constructor\s*\(([^)]*)\)/g;
    let cm;
    while ((cm = ctorBlockRe.exec(content)) !== null) {
      const paramStr = cm[1];
      const ctorLine = lineOf(content, cm.index);
      // Match each typed param: optional modifiers then name: Type
      const paramRe = /(?:private|public|protected|readonly|\s)+\w+\s*[?!]?\s*:\s*([A-Z]\w*)/g;
      let pm;
      while ((pm = paramRe.exec(paramStr)) !== null) {
        const rawType = pm[1].trim();
        if (rawType && !TS_DI_PRIMITIVES.has(rawType)) {
          results.push({ fieldType: rawType, annotation: 'Injectable', line: ctorLine });
        }
      }
    }
  }

  // Pass 1c: Python __init__ typed param DI (PEP 484 type hints + FastAPI Depends).
  // Matches: def __init__(self, repo: UserRepository, db: AsyncSession, name: str)
  // Also matches: svc: ArticleService = Depends(ArticleService)
  if (lang === LANG.PYTHON) {
    // Find all __init__ method param blocks
    const initRe = /def\s+__init__\s*\(\s*self\s*(?:,\s*([^)]+))?\)/g;
    let im;
    while ((im = initRe.exec(content)) !== null) {
      const paramStr = im[1];
      if (!paramStr) continue;
      const initLine = lineOf(content, im.index);
      // Match typed params: name: Type or name: Type = Depends(...)
      const typedParamRe = /\b\w+\s*:\s*([A-Z]\w*)/g;
      let pm;
      while ((pm = typedParamRe.exec(paramStr)) !== null) {
        const rawType = pm[1].trim();
        if (rawType && !PYTHON_DI_BUILTINS.has(rawType)) {
          results.push({ fieldType: rawType, annotation: 'init', line: initLine });
        }
      }
    }
  }

  // Pass 1d: Go constructor injection via NewXxx functions.
  // Pattern: func NewUserService(repo UserRepository, db *Database, logger *zap.Logger) *UserService
  // Each NewXxx param with an uppercase type (or *UppercaseType) is treated as an injected dependency.
  // Params like `ctx context.Context` or `err error` are excluded via GO_DI_BUILTINS.
  // structName is stored on each result so the calling block can do name-based (not line-based)
  // attribution — Go NewXxx functions are free functions unattached to the struct body by line.
  if (lang === LANG.GO) {
    // Match Go NewXxx constructor functions (exported, start with New)
    const newFuncRe = /\bfunc\s+New(\w+)\s*\(([^)]*)\)/g;
    let nm;
    while ((nm = newFuncRe.exec(content)) !== null) {
      const structName = nm[1]; // "UserService" from "NewUserService"
      const paramStr = nm[2];
      if (!paramStr || !paramStr.trim()) continue;
      const funcLine = lineOf(content, nm.index);
      // Go params: "name Type" or "name *Type" or "name pkg.Type" — we want the Type part
      // Multiple names can share a type: "a, b UserRepository"
      const paramRe = /\b\w+(?:\s*,\s*\w+)*\s+\*?(?:[\w]+\.)?([A-Z]\w*)/g;
      let pm;
      while ((pm = paramRe.exec(paramStr)) !== null) {
        const rawType = pm[1].trim();
        if (rawType && !GO_DI_BUILTINS.has(rawType)) {
          results.push({ fieldType: rawType, annotation: 'constructor', line: funcLine, structName });
        }
      }
    }
  }

  // Pass 2: Spring 5+ implicit single-constructor injection (no @Autowired needed).
  // If there is exactly one public/package-private constructor that takes injected-looking
  // params (all uppercase-starting types, stored as private final fields), treat its
  // params as DI. This covers the common Spring Boot pattern:
  //   private final OwnerRepository owners;
  //   OwnerController(OwnerRepository owners) { this.owners = owners; }
  if (lang === LANG.JAVA && results.length === 0) {
    const constructors = [];
    const ctorRe = /^(?:public\s+|protected\s+)?([A-Z]\w+)\s*\(([^)]*)\)\s*(?:throws\s+\S+\s*)?\{/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(ctorRe);
      if (m && m[2].trim().length > 0) constructors.push({ params: m[2], line: i + 1 });
    }
    if (constructors.length === 1) {
      const paramPattern = /([A-Z][\w]*(?:<[^>]+>)?)\s+\w+/g;
      let pm;
      while ((pm = paramPattern.exec(constructors[0].params)) !== null) {
        const rawType = pm[1].replace(/<[^>]*>/g, '').trim();
        if (rawType && /^[A-Z]/.test(rawType)) {
          results.push({ fieldType: rawType, annotation: 'implicit', line: constructors[0].line });
        }
      }
    }
  }

  return results;
}

// ─── Module-level helper ──────────────────────────────────────────────────────

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

// ─── SQL/JPQL reference extraction (GQ-8) ─────────────────────────────────────

// Convert a TypeORM repository variable name to an entity name.
// "userRepository" or "UserRepository" → "User"; "articleRepo" → "Article".
function _repoToEntity(repoName) {
  // strip Repository / Repo suffix (case-insensitive)
  const stripped = repoName.replace(/Repository$/i, '').replace(/Repo$/i, '');
  if (!stripped || stripped.length < 2) return null;
  // Capitalise first letter to get a Pascal-case entity name
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// Convert a camelCase Prisma model accessor to a Pascal-case entity name.
// "article" → "Article"; "userProfile" → "UserProfile".
function _camelToPascal(name) {
  if (!name || name.length < 2) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Scans source for SQL/JPQL entity/table references inside string literals and
// @Query annotations. Returns [{ entityName, operation: 'READ'|'WRITE', line }].
function extractSqlReferences(content, lang) {
  const results = [];
  const seen = new Set();
  const addRef = (name, operation, line) => {
    if (!name || name.length < 2) return;
    const key = `${name.toLowerCase()}:${operation}`;
    if (!seen.has(key)) { seen.add(key); results.push({ entityName: name, operation, line }); }
  };
  const scanSql = (text, lineHint) => {
    // A read pattern that matched the FROM of `DELETE FROM audit_log` would emit a READS_TABLE
    // edge alongside the WRITES_TABLE one, so consume the write forms first and scan the
    // remainder for reads.
    const writePat = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_]\w*)/gi;
    let m;
    writePat.lastIndex = 0;
    while ((m = writePat.exec(text)) !== null) addRef(m[1], 'WRITE', lineHint);
    const readable = text.replace(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[A-Za-z_]\w*/gi, ' ');
    const readPat = /\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)/gi;
    readPat.lastIndex = 0;
    while ((m = readPat.exec(readable)) !== null) addRef(m[1], 'READ', lineHint);
  };
  // @Query annotation strings (JPQL / native SQL)
  const annPat = /@Query\s*\(\s*(?:value\s*=\s*)?["']([^"']{3,1000})["']/g;
  const javaMethodLines = lang === LANG.JAVA
    ? extractFunctions(content, lang).map((fn) => fn.line).sort((a, b) => a - b)
    : [];
  let m;
  while ((m = annPat.exec(content)) !== null) {
    const annotationLine = lineOf(content, m.index);
    const ownerLine = javaMethodLines.find((line) => line > annotationLine) || annotationLine;
    scanSql(m[1], ownerLine);
  }
  // Generic string literals that look like SQL.
  //
  // This scanned every quoted run in the raw source — with
  // a ZERO minimum length and a test that fired on any occurrence of the words SELECT, UPDATE,
  // DELETE, FROM or JOIN anywhere in the text. Since it runs over the whole file, comments and
  // prose counted: two apostrophes on one line ("the user's cache ... don't") delimit a
  // pseudo-literal, and "from"/"update" are ordinary English. On a negative corpus
  // that contains no SQL at all: 7 false table references, including READS_TABLE `the`,
  // WRITES_TABLE `your` and READS_TABLE `favourites` from UI copy — and because each hit is
  // attributed to the narrowest containing method, those false edges looked precisely
  // sourced.
  //
  // A literal now has to BE a SQL statement rather than merely contain a SQL word: anchored at
  // the start (leading whitespace allowed) on a statement-introducing verb. That needs no
  // comment lexer and no parse tree, and it keeps every
  // real statement in the positive corpus. Residual: SQL that does not begin its literal, and
  // template-literal SQL, are not matched; both are recorded as owned risks.
  // The anchor alone is not enough: English imperatives collide with SQL verbs, so UI copy like
  // 'Update your profile from settings' and 'Delete from favourites' still matched (3 residual
  // false positives on the negative corpus). A real embedded statement also carries STRUCTURE —
  // a second clause keyword, a bound parameter, or a terminator — which product copy does not.
  const looksLikeSqlStatement = (text) => {
    // A SELECT needs more than the two words: 'Select From Orders History without saving your
    // changes' passed an anchor-plus-FROM-anywhere test and became a real READS_TABLE edge to
    // the `orders` table (residual). Two grammar facts settle it — the
    // select list is mandatory, so SELECT immediately followed by FROM is not SQL; and after
    // the table (plus an optional alias) a statement either ends or continues with a clause
    // keyword, whereas prose continues with more prose.
    if (/^\s*SELECT\b/i.test(text)) {
      const CLAUSE = 'WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|ON|USING|FOR|WINDOW';
      // The alias group must not swallow a clause keyword — without this lookahead the WHERE in
      // `SELECT id, total FROM orders WHERE tenant_id = $1` was parsed as the table's alias and
      // the statement was rejected as prose.
      const shape = new RegExp(
        `^\\s*SELECT\\s+(?!FROM\\b)(.+?)\\s+FROM\\s+([A-Za-z_]\\w*)(?:\\s+(?:AS\\s+)?(?!(?:${CLAUSE})\\b)([A-Za-z_]\\w*))?\\s*([\\s\\S]*)$`,
        'i',
      ).exec(text);
      if (!shape) return false;
      const tail = (shape[4] || '').trim();
      if (!tail || tail === ';') return true;
      return /^(?:WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|ON|USING|FOR\s+UPDATE|WINDOW|;)\b/i.test(tail);
    }
    if (/^\s*WITH\b/i.test(text)) return /\bSELECT\b/i.test(text);
    if (/^\s*INSERT\s+INTO\b/i.test(text)) return /\b(?:VALUES|SELECT)\b/i.test(text);
    if (/^\s*UPDATE\b/i.test(text)) return /\bSET\b/i.test(text);
    // A bare `DELETE FROM <table>` and the UI string 'Delete from favourites' are structurally
    // identical, so this one form needs a qualifier: a predicate, a bound parameter, or a
    // terminator. Cost: an unqualified whole-table delete is not matched. That is a rare and
    // deliberately conspicuous statement in application code, and the alternative is accepting
    // product copy as a table reference.
    if (/^\s*DELETE\s+FROM\b/i.test(text)) {
      return /\bWHERE\b/i.test(text) || /\$\d|:[A-Za-z_]\w*|\?/.test(text) || /;\s*$/.test(text);
    }
    return false;
  };
  const strPat = /"([^"\r\n]{12,500})"|'([^'\r\n]{12,500})'/g;
  while ((m = strPat.exec(content)) !== null) {
    const text = m[1] ?? m[2];
    if (looksLikeSqlStatement(text)) {
      scanSql(text, lineOf(content, m.index));
    }
  }

  // Local scan helper: runs pat against content, applies optional transform to m[1], calls addRef.
  const scan = (pat, op, transform) => {
    let sm;
    while ((sm = pat.exec(content)) !== null) {
      const name = transform ? transform(sm[1]) : sm[1];
      if (name) addRef(name, op, lineOf(content, sm.index));
    }
  };

  // ─── GQH-8a: Django ORM + SQLAlchemy (Python) ─────────────────────────────
  if (lang === LANG.PYTHON) {
    // Django ORM reads: Model.objects.<read_method>(
    scan(/\b([A-Z][A-Za-z0-9_]*)\.objects\.(?:filter|get|all|exclude|values|annotate|first|last|count|exists)\s*\(/g, 'READ');
    // Django ORM writes: Model.objects.<write_method>( and instance.save()
    scan(/\b([A-Z][A-Za-z0-9_]*)\.objects\.(?:create|update|bulk_create|bulk_update)\s*\(/g, 'WRITE');
    // SQLAlchemy reads: session/db.query(Model), select(Model)
    scan(/\b(?:session|db)\.(?:query|get|execute)\s*\(\s*([A-Z][A-Za-z0-9_]*)/g, 'READ');
    scan(/\bselect\s*\(\s*([A-Z][A-Za-z0-9_]*)/g, 'READ');
    // SQLAlchemy writes: session/db.add(instance), session.merge(instance)
    // Special: only record if variable looks like an instance or model (length >= 2)
    const saWritePat = /\b(?:session|db)\.(?:add|merge|flush)\s*\(\s*([A-Za-z_]\w*)/g;
    while ((m = saWritePat.exec(content)) !== null) {
      if (m[1] && m[1].length >= 2) addRef(m[1], 'WRITE', lineOf(content, m.index));
    }
  }

  // ─── GQH-8b: TypeORM + Prisma (TypeScript / JavaScript) ──────────────────
  if (lang === LANG.TYPESCRIPT || lang === LANG.JAVASCRIPT) {
    // TypeORM reads: this.userRepository.findOne / findBy / etc.
    // Strip "Repository"/"Repo" suffix to get the entity name (userRepository → User).
    scan(/\b(\w+(?:[Rr]epository|[Rr]epo))\.(?:find|findOne|findOneBy|findBy|findAndCount|count|exists)\s*\(/g, 'READ', _repoToEntity);
    // TypeORM writes: this.userRepository.save / create / insert / update / delete / upsert / remove
    scan(/\b(\w+(?:[Rr]epository|[Rr]epo))\.(?:save|create|insert|update|delete|upsert|remove)\s*\(/g, 'WRITE', _repoToEntity);
    // Prisma reads: prisma.modelName.findMany / findFirst / findUnique / findUniqueOrThrow / count / aggregate / groupBy
    scan(/\bprisma\.(\w+)\.(?:findMany|findFirst|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g, 'READ', _camelToPascal);
    // Prisma writes: prisma.modelName.create / createMany / update / updateMany / upsert / delete / deleteMany
    scan(/\bprisma\.(\w+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g, 'WRITE', _camelToPascal);
  }

  // ─── GQH-8c: Go GORM ──────────────────────────────────────────────────────
  if (lang === LANG.GO) {
    // GORM reads: db.Find(&user), db.First(&user), db.Take(&user), db.Last(&user),
    // db.Where(...).Find(&user), db.Preload(...).Find(&user), gorm.Find(&user)
    scan(/\b(?:db|gorm)\.(?:(?:Where\s*\([^)]*\)\s*\.|Preload\s*\([^)]*\)\s*\.)?(?:Find|First|Take|Last))\s*\(\s*&?(\w+)/g, 'READ', _camelToPascal);
    // GORM writes: db.Create(&user), db.Save(&user), db.Update(...), db.Updates(&user),
    // db.Delete(&user), db.Where(...).Delete(&user), db.Where(...).Update(...)
    // Special: skip string literals passed as first arg (e.g. db.Where("...").Delete("table"))
    const gormWritePat = /\b(?:db)\.(?:(?:Where\s*\([^)]*\)\s*\.)?(?:Create|Save|Update|Updates|Delete))\s*\(\s*&?(\w+)/g;
    while ((m = gormWritePat.exec(content)) !== null) {
      if (/^["']/.test(m[1])) continue;
      addRef(_camelToPascal(m[1]), 'WRITE', lineOf(content, m.index));
    }
  }

  // ─── GQH-8c: Ruby ActiveRecord ────────────────────────────────────────────
  if (lang === LANG.RUBY) {
    // ActiveRecord reads: Model.where(...), Model.find(...), Model.find_by(...),
    // Model.all, Model.first, Model.last, Model.includes(...), Model.joins(...), Model.select(...)
    scan(/\b([A-Za-z_]\w*)\.(?:where|find|find_by|all|first|last|includes|joins|select)\s*[({[]/g, 'READ');
    // ActiveRecord writes: Model.create, Model.create!, instance.update, instance.update!,
    // instance.save, instance.save!, instance.destroy, instance.delete, Model.new
    scan(/\b([A-Za-z_]\w*)\.(?:create!?|update!?|save!?|destroy|delete|new)\b/g, 'WRITE');
  }

  return results;
}

// ─── Shared content-derived side channels ─────────────────────────────────────
//
// These three arrays are derived from raw file content, not from any parse tree,
// so both the regex path and the tree-sitter paths must produce them identically.
// They live here as reusable helpers so the tree-sitter extractors return the same
// six-key contract as buildAstNodes' regex tail (GQ-6a/7b/8).

// DEPENDS_ON: JS/TS relative imports (GQ-7b) + barrel re-exports (GQH-6a).
// fromIndex must index into the CALLER's nodes[] array — the caller passes the
// nodeIndex of its own source node, so this never leaks indices across paths.
function buildRelativeImportEdges(content, filePath, lang, sourceNodeIndex) {
  const edges = [];
  if (lang !== LANG.JAVASCRIPT && lang !== LANG.TYPESCRIPT) return edges;
  if (typeof sourceNodeIndex !== 'number' || sourceNodeIndex < 0) return edges;
  try {
    for (const imp of extractImports(content, lang)) {
      if (imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'))) {
        const rawTarget = path.normalize(path.join(path.dirname(filePath), imp.source));
        edges.push({ fromIndex: sourceNodeIndex, targetRelPath: rawTarget });
      }
    }

    // GQH-6a: re-export statements (barrel files) — `export { X } from './path'` and `export * from './path'`
    // These are not captured by extractImports() but are DEPENDS_ON edges (barrel → target module).
    // Scanned on comment-stripped text only (not `content` itself, which extractImports() above
    // still needs raw) — otherwise a commented-out `// export { X } from './path'` reads as a live
    // barrel re-export and writes a DEPENDS_ON edge to a module the file does not actually use.
    const reExportRe = /export\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*['"]([.][^'"]+)['"]/gm;
    let reMatch;
    const seenReExportPaths = new Set();
    const reExportScanText = stripComments(content, lang);
    while ((reMatch = reExportRe.exec(reExportScanText)) !== null) {
      const relSource = reMatch[1];
      if ((relSource.startsWith('./') || relSource.startsWith('../')) && !seenReExportPaths.has(relSource)) {
        seenReExportPaths.add(relSource);
        const rawTarget = path.normalize(path.join(path.dirname(filePath), relSource));
        edges.push({ fromIndex: sourceNodeIndex, targetRelPath: rawTarget });
      }
    }
  } catch (_) {}
  return edges;
}

// `export {X} from './y'` / `export *
// from './y'` re-export statements aren't captured by extractImports() —
// the regex above is the only place that recognizes them, and it
// requires a CLASS/METHOD node to anchor the edge on.
// IMPORT nodes are retired; a pure-barrel file (only re-exports, no
// CLASS/METHOD) now has NO node buildRelativeImportEdges can anchor on at
// all. Re-exported symbols are real imports for resolution purposes too
// (mirrors extractors/typescript.js's own _extraWalkTs re-export handling) —
// capturing them as import facts closes
// that gap, since a fact needs no node index: it is attached to the FILE
// node's properties.imports once one exists, not to
// a same-file extraction-time anchor. Same regex, same lang gate as
// buildRelativeImportEdges, so this is additive, not a behavior change to
// the edge side.
function extractReExportFacts(content, lang) {
  const facts = [];
  if (lang !== LANG.JAVASCRIPT && lang !== LANG.TYPESCRIPT) return facts;
  try {
    const reExportRe = /export\s*(?:\{([^}]*)\}|(\*)(?:\s+as\s+(\w+))?)\s*from\s*['"]([^'"]+)['"]/gm;
    let m;
    // Comment-stripped: this scan feeds `importFacts` → the FILE node's `properties.imports` →
    // IMPORTS_SYMBOL/IMPORTS edges (ingest.js), one of blast_radius's own reverse-edge types. A
    // commented-out `// export { X } from './y'` read as raw text otherwise resolves as a live
    // re-export, and a file that never actually re-exports X reports as its dependent.
    const scanText = stripComments(content, lang);
    while ((m = reExportRe.exec(scanText)) !== null) {
      const namedList = m[1];
      const isStar = !!m[2];
      const starAlias = m[3];
      const modulePath = m[4];
      if (!modulePath) continue;
      if (namedList) {
        for (const seg of namedList.split(',')) {
          const raw = seg.trim();
          if (!raw) continue;
          const asIdx = raw.indexOf(' as ');
          const name = (asIdx >= 0 ? raw.slice(0, asIdx) : raw).trim();
          if (name) facts.push({ name, module: modulePath, alias: null, line: null });
        }
      } else if (isStar) {
        facts.push({ name: modulePath, module: modulePath, alias: starAlias || null, line: null });
      }
    }
  } catch (e) { sideChannelWarn('extractReExportFacts', e); }
  return facts;
}

// A swallowed exception here zeros a whole side-channel plane on every file with errors=0 — the
// exact "a plane stops being written silently" failure the ingest guards against elsewhere. Report
// the first occurrence of each so a regression is visible, without one line per file.
const _sideChannelWarned = new Set();
function sideChannelWarn(channel, err) {
  if (_sideChannelWarned.has(channel)) return;
  _sideChannelWarned.add(channel);
  console.error(`[ingest] [WARN] ${channel} threw and was skipped — this plane may be empty: ${err && err.message ? err.message : err}`);
}

// SQL/JPQL entity refs (GQ-8) + config/env-var refs (GQ-6a).
// Both are keyed by fileId downstream (ingest-file-processor commitExtractedNodes),
// not by node index, so they are path-independent.
function buildContentSideChannels(content, lang) {
  let sqlReferences = [];
  try { sqlReferences = extractSqlReferences(content, lang); } catch (e) { sideChannelWarn('extractSqlReferences', e); }
  let configValueRefs = [];
  try { configValueRefs = extractConfigValueRefs(content, lang); } catch (e) { sideChannelWarn('extractConfigValueRefs', e); }
  return { sqlReferences, configValueRefs };
}

function langForFile(filePath) {
  return EXT_TO_AST_LANG[path.extname(String(filePath || '')).toLowerCase()] || null;
}

// ─── Shared tree-sitter init ──────────────────────────────────────────────────

// Parser.init() must be called exactly once across all language parsers —
// calling it a second time after it has already resolved corrupts the
// web-tree-sitter module object (its `init`/`Language` statics are replaced by
// the raw Emscripten runtime, confirmed by execution: a second,
// later `Parser.init()` call left `Parser.init` `undefined`). All language
// IIFEs in this file, and extractors/base.js's loadGrammar(), must await THIS
// SAME promise rather than calling Parser.init() again themselves.
const _tsInitPromise = (async () => {
  // web-tree-sitter 0.25 moved Parser and Language from the module object to named exports.
  // Every call site here and in extractors/base.js uses the 0.24 shape
  // (`new Parser()` / `Parser.Language.load`), so normalise back to it rather than editing six
  // loaders — and keep working on either version, because the wasm ABI a grammar needs is now
  // a real constraint: the 0.24 runtime rejects ABI 15, which is what the current C#,
  // JavaScript, Python and Go grammar builds are compiled against.
  const mod = require('web-tree-sitter');
  const Parser = mod.Parser || mod;
  const Language = mod.Language || Parser.Language;
  await (typeof Parser.init === 'function' ? Parser.init() : mod.init());
  if (!Parser.Language) Parser.Language = Language;
  // web-tree-sitter 0.24 is an Emscripten build with MODULARIZE off: finishing init overwrites
  // its own `module.exports` with the raw Module (HEAP8, HEAPU32, ...), so the NEXT
  // `require('web-tree-sitter')` in the process gets heap views instead of the Parser class and
  // this IIFE throws "mod.init is not a function". Node's single CJS cache normally means there
  // is no next require — but under a module runner that evaluates this file twice (vitest reaches
  // it once through the ESM graph and again through extractors/base.js's `require('../ast-
  // extractor')`), the second evaluation's init rejects, every ported extractor reports `failed`,
  // and the whole tree-sitter plane silently degrades with no error surfaced anywhere.
  const cacheEntry = require.cache[require.resolve('web-tree-sitter')];
  if (cacheEntry && cacheEntry.exports !== Parser) cacheEntry.exports = Parser;
  return Parser;
})();

// Exported so extractors/base.js's loadGrammar() can await the one shared init
// instead of racing a second Parser.init() call.
function tsInitPromise() {
  return _tsInitPromise;
}

// Same reason, for the ABI-15 runtime: web-tree-sitter-next's `Parser.init()` assigns its cached
// Emscripten module AFTER its own await, so two overlapping init calls each build one and the
// loser's language pointers go stale — `setLanguage` then throws "memory access out of bounds".
// A ported extractor needing an ABI-15 grammar (extractors/bash.js) awaits this one promise.
function tsNextInitPromise() {
  return _tsNextInitPromise;
}

// Two grammar sources, preferred in order. `tree-sitter-wasms` covers 36 languages but its
// build is old enough to fail on constructs the current grammars accept — a regex literal
// containing `[^]`, and a class whose `implements` clause starts on the next line, both of
// which appear in ordinary library code (vue-core and Angular respectively) and truncated the
// file's parse. `@vscode/tree-sitter-wasm` ships a newer build of 16 of those languages and
// parses both. Prefer the newer build where it exists; fall back for everything else.
// Several @vscode grammars are compiled against tree-sitter ABI 15, which this runtime's
// web-tree-sitter (0.24.x, ABI 13-14) rejects — javascript, python, go, c-sharp, php and rust
// all fall through to the older build today. That is why the loader tries in order and records
// which one won, rather than assuming the newer one is in use.
//
// web-tree-sitter is held at 0.24.x: 0.26 would unlock the ABI-15 grammars, but
// tree-sitter-wasms 0.1.13 — which supplies all ~36 grammars this file's tree-sitter tiers
// load — is compiled against the older ABI, so upgrading the runtime alone stops every one of
// them loading. The blocker is the grammar *bundle*, not the runtime; revisit when
// tree-sitter-wasms publishes an ABI-15 build.
// npm hoists dependencies to the INSTALLER's node_modules, so a hard-coded
// `../../node_modules/...` only resolves when this file is run from a checkout. Installed as a
// package every grammar path missed, _loadWasmParser fell through to the regex tier, and the
// ingest still exited 0 — a silently degraded graph with no warning, on the one plane the
// product competes on. require.resolve follows node's own resolution, so it finds the package
// wherever npm actually put it.
//
// package.json is tried first because it is the one file whose location fixes the package root;
// some packages block it behind an `exports` map, hence the main-entry fallback.
const _pkgRootCache = new Map();
function _pkgRoot(pkg) {
  if (_pkgRootCache.has(pkg)) return _pkgRootCache.get(pkg);
  let root = null;
  try {
    root = require('path').dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    try {
      let d = require('path').dirname(require.resolve(pkg));
      for (let i = 0; i < 6 && d && d !== require('path').dirname(d); i += 1) {
        if (require('fs').existsSync(require('path').join(d, 'package.json'))) { root = d; break; }
        d = require('path').dirname(d);
      }
    } catch { root = null; }
  }
  if (!root) {
    const legacy = require('path').join(__dirname, '../../node_modules', pkg);
    if (require('fs').existsSync(legacy)) root = legacy;
  }
  _pkgRootCache.set(pkg, root);
  return root;
}

function _wasmPath(pkg, relTemplate, name) {
  const root = _pkgRoot(pkg);
  if (!root) return null;
  return require('path').join(root, relTemplate.split('%s').join(name));
}

const _WASM_SOURCES = [
  ['vscode', '@vscode/tree-sitter-wasm', 'wasm/tree-sitter-%s.wasm'],
  ['tree-sitter-wasms', 'tree-sitter-wasms', 'out/tree-sitter-%s.wasm'],
];

// The two packages spell some grammars differently (`c-sharp` vs `c_sharp`).
const _WASM_NAME_ALIASES = { c_sharp: { vscode: 'c-sharp' } };

// Which source each grammar actually resolved to. Recorded rather than assumed for the same
// reason `extractor_tier` is: several of the newer builds are compiled against a tree-sitter
// ABI this runtime does not accept and fall back silently, so "we are on the new grammar" has
// to be checkable. Exposed through awaitTreeSitterReady().
const _wasmSourceUsed = {};

// A SECOND, isolated tree-sitter runtime.
//
// The current grammar builds (@vscode/tree-sitter-wasm) are compiled against tree-sitter ABI 15,
// which web-tree-sitter 0.24 rejects. Upgrading the shared runtime to 0.26 unlocks them but
// breaks every one of the ~36 grammars `tree-sitter-wasms` 0.1.13 supplies — measured: 287 unit
// tests failed. So the upgrade is scoped instead of global. The two runtimes are separate npm
// packages, hence separate Emscripten modules with separate state, and both work in one process
// (verified: the 0.24 runtime keeps parsing after 0.26 initialises).
//
// Only planes that need an ABI-15 grammar use this. Everything else stays on 0.24.
const _tsNextInitPromise = (async () => {
  const mod = require('web-tree-sitter-next');
  const Parser = mod.Parser || mod;
  const Language = mod.Language || Parser.Language;
  await (typeof Parser.init === 'function' ? Parser.init() : mod.init());
  return { Parser, Language };
})();

const _loadWasmParserNext = async (grammar) => {
  const { Parser, Language } = await _tsNextInitPromise;
  const name = (_WASM_NAME_ALIASES[grammar] || {}).vscode || grammar;
  const wasmPath = _wasmPath('@vscode/tree-sitter-wasm', 'wasm/tree-sitter-%s.wasm', name);
  if (!wasmPath || !require('fs').existsSync(wasmPath)) throw new Error(`no vscode grammar for ${grammar}`);
  const lang = await Language.load(wasmPath);
  const p = new Parser();
  p.setLanguage(lang);
  _wasmSourceUsed[grammar] = 'vscode@abi15';
  return p;
};

const _loadWasmParser = async (grammar) => {
  const Parser = await _tsInitPromise;
  const fsMod = require('fs');
  let lastError = null;
  for (const [label, pkg, template] of _WASM_SOURCES) {
    const name = (_WASM_NAME_ALIASES[grammar] || {})[label] || grammar;
    const wasmPath = _wasmPath(pkg, template, name);
    if (!wasmPath || !fsMod.existsSync(wasmPath)) continue;
    try {
      const lang = await Parser.Language.load(wasmPath);
      const p = new Parser();
      p.setLanguage(lang);
      _wasmSourceUsed[grammar] = label;
      return p;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`no wasm grammar for ${grammar}`);
};



// web-tree-sitter allocates every syntax tree inside the wasm heap and NEVER frees it unless
// the caller calls tree.delete(). None of these extractors did, so the heap grew with every
// file until Emscripten aborted the module — and once it aborts, the parser is dead for the
// rest of the process, so every subsequent file yields nothing. Measured on efcore (5,761
// files): 1,568 parsed, then 4,193 consecutive failures and a 77% method recall that looked
// like an extraction defect. Any repository large enough would have hit this in production
// ingest, silently.
// What fraction of the file the grammar failed to parse. A tree can be `hasError` and still be
// almost entirely good (one bad construct), or it can be error from byte zero — efcore has a
// 360KB test file whose parse is one ERROR spanning the whole file, which yields a handful of
// nodes rather than none and so slipped past a zero-node check. The ratio separates the two.
function parseErrorRatio(root, length) {
  if (!root || !root.hasError || !length) return 0;
  let covered = 0;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'ERROR') { covered += n.endIndex - n.startIndex; continue; }
    if (!n.hasError) continue;
    for (const c of n.children) stack.push(c);
  }
  return covered / length;
}

// Union of two extraction planes for one file, keeping every declaration either found and
// dropping the duplicates. Matched on (node_type, name), either by CONTAINMENT in the primary
// node's span or within a +/-2 line tolerance.
//
// The tolerance alone was the whole rule, and it is not enough: the two planes anchor a
// declaration differently — the grammar walk spans the attribute list, the regex scanner matches
// the signature line — so any declaration carrying three or more attribute lines fell outside
// the window and was emitted twice. `JsonConvert.SerializeObject` is anchored at 527 by the
// grammar and 530 by the scanner and appears as two methods. Across the C# development corpus
// that is 538 fabricated method nodes, and each one also lands on the wrong line, so it costs
// precision and line accuracy at once. Containment is the rule the tolerance was approximating.
// Control-flow / statement keywords that a line-based regex scanner can mis-read as a method
// declaration (`if (cond)` looks like `<type> if(...)`). No language declares a method with one of
// these bare names, so dropping them from a merged plane only ever removes a false positive.
const _MERGE_KEYWORD_NONNAMES = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally',
  'return', 'throw', 'using', 'lock', 'fixed', 'checked', 'unchecked', 'break', 'continue',
  'goto', 'yield', 'when', 'default',
]);

function mergeDegradedPlanes(primary, secondary) {
  const nodes = [...(primary.nodes || [])];
  const seen = new Map();
  const add = (n) => {
    const key = `${n.node_type}\0${n.name}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push([n.start_line, n.end_line]);
  };
  for (const n of nodes) add(n);
  for (const n of (secondary.nodes || [])) {
    const spans = seen.get(`${n.node_type}\0${n.name}`);
    const line = n.start_line || 0;
    if (spans && spans.some(([lo, hi]) => Math.abs((lo || 0) - line) <= 2
      || (lo != null && hi != null && lo <= line && line <= hi))) continue;
    add(n);
    nodes.push(n);
  }
  // A regex scanner recovering declarations from a partly-degraded parse can mis-read a control
  // keyword as a method (`if (...)` → a method named `if`); drop those — they are never real.
  const filtered = nodes.filter((n) => !_MERGE_KEYWORD_NONNAMES.has(n.name));
  return {
    nodes: filtered,
    structuralEdges: primary.structuralEdges || [],
    inheritanceEdges: primary.inheritanceEdges || [],
    relativeImportEdges: primary.relativeImportEdges || [],
    sqlReferences: primary.sqlReferences || [],
    configValueRefs: primary.configValueRefs || [],
    importFacts: primary.importFacts || [],
  };
}

function releaseTree(tree) {
  try { if (tree && typeof tree.delete === 'function') tree.delete(); } catch (_) {}
}

// ─── Kotlin tree-sitter extractor ────────────────────────────────────────────

// Lazy-init the Kotlin parser once at module load; falls back to Java regex if
// the WASM fails to load (e.g. cold Lambda, missing file).
let _ktState  = 'pending';   // 'pending' | 'ready' | 'failed'
let _ktParser = null;

const _ktReady = (async () => {
  try {
    // Uses the shared loader so this plane gets the newer grammar build where one exists,
    // and so which build won is recorded rather than assumed.
    _ktParser = await _loadWasmParser('kotlin');
    _ktState = 'ready';
  } catch (_) {
    _ktState = 'failed';
  }
})();

// Extracts CLASS (class_declaration, object_declaration) and METHOD
// (function_declaration) nodes from Kotlin source using tree-sitter.
// Only top-level declarations and direct class members are emitted.
// Return shape is byte-compatible with the Java-regex path in buildAstNodes.
// Kotlin lets any declaration be named with backticks — `fun \`returns true when empty\`()` is
// the standard spelling of a test name, and mockk alone has hundreds. The backticks are QUOTING
// SYNTAX, not part of the identifier: the compiler reports the inner text, and so must we.
const ktIdent = (n) => (n ? n.text.replace(/^`/, '').replace(/`$/, '') : null);

// The modifiers a Kotlin type carries sit before its name as separate tokens. Reading them from
// the source text up to the name is more robust across grammar builds than matching the
// modifier node types, which differ between tree-sitter-kotlin generations.
function ktClassKind(node, nameNode) {
  const head = node.text.slice(0, Math.max(0, nameNode.startIndex - node.startIndex));
  if (/\binterface\b/.test(head)) return 'interface';
  if (/\bannotation\b/.test(head)) return 'annotation';
  if (/\benum\b/.test(head)) return 'enum';
  if (/\bdata\b/.test(head)) return 'data_class';
  if (/\bsealed\b/.test(head)) return 'sealed_class';
  return 'class';
}

const KT_TYPE_BODIES = new Set(['class_body', 'enum_class_body']);

// The tree-sitter-kotlin build this runtime can load is ABI 13-14 and is behind the language:
// it rejects `fun interface` (Kotlin 1.4 SAM conversion) and `context(...)` receivers outright.
// Both are pure prefix syntax, so blanking the keyword leaves a declaration the grammar does
// parse, and blanking preserves every byte offset so no other declaration moves.
//
// Deliberately NOT masked, and this is why Kotlin does not reach the bar: the same grammar also
// fails on INFIX function calls (`table.id eq id1`), which is not prefix syntax and cannot be
// blanked without destroying the expression that contains it. See §4 of the paper section.
//
// An earlier version of this also tried to mask the delegation in `object : X by y {}` by
// scanning forward to the next `{`. That scan was unbounded: on Exposed's entity classes the
// next `{` is in a later declaration, so it blanked real `var name by Table.name` property
// declarations in between. Same defect class as the SQL session's `\copy` blanker. Removed.
const KT_FUN_INTERFACE = /\bfun(\s+interface\b)/g;

function maskKotlinModernSyntax(content) {
  let out = content;
  let hit = false;
  const swapped = out.replace(KT_FUN_INTERFACE, (m, rest) => { hit = true; return '   ' + rest; });
  if (swapped !== out) out = swapped;

  // `context(...)` only counts as a receiver list when it starts a line — `context(foo)` as an
  // ordinary call sits mid-expression and must not be touched.
  let i = 0;
  while ((i = out.indexOf('context', i)) !== -1) {
    const lineStart = out.lastIndexOf('\n', i - 1) + 1;
    if (!/^[ \t]*$/.test(out.slice(lineStart, i))) { i += 7; continue; }
    let j = i + 7;
    while (j < out.length && (out[j] === ' ' || out[j] === '\t')) j++;
    if (out[j] !== '(') { i += 7; continue; }
    let depth = 0;
    let k = j;
    for (; k < out.length; k++) {
      if (out[k] === '(') depth++;
      else if (out[k] === ')') { depth--; if (depth === 0) break; }
      // Bounded: a receiver list never spans a blank line. Without this a stray `(` would
      // blank the rest of the file.
      else if (out[k] === '\n' && /^[ \t]*$/.test(out.slice(k + 1, out.indexOf('\n', k + 1)))) { k = out.length; break; }
    }
    if (k >= out.length) { i += 7; continue; }
    out = out.slice(0, i) + out.slice(i, k + 1).replace(/[^\n]/g, ' ') + out.slice(k + 1);
    hit = true;
    i = k + 1;
  }
  return hit ? out : null;
}

// tree-sitter-kotlin misreads class delegation. In `class B(...) : A by delegate { ... }` it
// takes the class body for a trailing-lambda argument to `delegate`: the `explicit_delegation`
// swallows a `call_expression > call_suffix > annotated_lambda`, and the class_declaration ends
// up with no `class_body` child at all, so every member of a delegating class is invisible. No
// parse error is raised — the file looks clean and the declarations are simply gone. Kotlin
// leans on `by` for composition over inheritance, so this is not a corner: exposed's
// ColumnType.kt alone loses 142 of its 292 declarations.
//
// Blanking the `by <expr>` makes the same source parse correctly, and costs nothing that is
// scored: the supertype is declared by the `user_type` beside it, which survives. Same
// mask-and-reparse pattern as the C recovery path, PHP property hooks and `fun interface`.
function maskKotlinDelegation(content, root) {
  const descendant = (node, type) => {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === type) return n;
      for (const c of n.children) stack.push(c);
    }
    return null;
  };
  const spans = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'class_declaration' || n.type === 'object_declaration') {
      // Only where the misparse actually happened. A delegating class that DID get a
      // class_body parsed fine, and a lambda inside the delegate expression is then a real
      // argument, not the body — blanking it would be a fabrication of our own.
      if (!n.children.some((c) => KT_TYPE_BODIES.has(c.type))) {
        for (const d of n.children.filter((c) => c.type === 'delegation_specifier')) {
          const ed = descendant(d, 'explicit_delegation');
          if (!ed) continue;
          const by = ed.children.find((c) => c.type === 'by');
          const lam = descendant(ed, 'annotated_lambda') || descendant(ed, 'lambda_literal');
          if (by && lam && lam.startIndex > by.startIndex) spans.push([by.startIndex, lam.startIndex]);
        }
      }
    }
    for (const c of n.children) stack.push(c);
  }
  if (!spans.length) return null;
  const out = content.split('');
  for (const [lo, hi] of spans) {
    for (let i = lo; i < hi; i++) if (out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

// The same defect reached the other way. When the misparse ALSO produces a file-level ERROR
// there is no `explicit_delegation` node left to key on: exposed's `AutoIncColumnType` — a
// delegating class holding both a `: this(...)` secondary constructor and a property getter
// with a trailing lambda — collapses the ENTIRE file to one ERROR node, taking the other 1,650
// lines with it. So the same mask is applied textually, anchored on the `by <expr>` that ends a
// class header, and kept only when the parse measurably improves. A regex over Kotlin source is
// a guess; the error-ratio gate turns a wrong guess into a no-op rather than a corruption.
// A second grammar defect with the same shape: a primary constructor written on its own line,
// `public class CircuitBreaker\nprivate constructor(...)`. The class_declaration then ends at
// the type name and the constructor becomes a stray `call_expression`, so the class keeps its
// name and loses every parameter, property and member. Blanking the keyword leaves
// `class CircuitBreaker\n    (...)`, which the same grammar parses correctly — verified, not
// assumed. Only when the PREVIOUS non-blank line is a bare class header, which a secondary
// constructor's never is.
const KT_PRIMARY_CTOR = /^(\s*)((?:(?:@\w+(?:\([^()]*\))?|public|private|protected|internal|actual|expect)\s+)*)constructor\b/;
const KT_BARE_CLASS_HEAD = /\b(?:class|object|interface)\s+`?[\w$]+`?(?:\s*<[^<>]*>)?\s*$/;

function maskKotlinHeaderSyntax(content) {
  const lines = content.split('\n');
  let hit = false;
  const blank = (i, from, to) => {
    lines[i] = lines[i].slice(0, from) + ' '.repeat(to - from) + lines[i].slice(to);
    hit = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const ctor = KT_PRIMARY_CTOR.exec(line);
    if (ctor) {
      let p = i - 1;
      while (p >= 0 && !lines[p].trim()) p--;
      if (p >= 0 && KT_BARE_CLASS_HEAD.test(lines[p])) {
        blank(i, ctor[1].length, ctor[0].length);
        continue;
      }
    }

    if (!trimmed.endsWith('{') || line.includes('=')) continue;
    // `) : Foo by bar {` (wrapped header) or `class A : Foo by bar {`. A `val x: T by lazy {`
    // is a PROPERTY delegate, a different construct the grammar reads correctly.
    if (!(trimmed.startsWith(')') || /\b(?:class|object|interface)\s/.test(trimmed))) continue;
    const colon = line.indexOf(':');
    const brace = line.lastIndexOf('{');
    if (colon < 0 || brace <= colon) continue;
    const m = /\bby\s+[\w.$]+(?:\s*\([^()]*\))?\s*$/.exec(line.slice(colon, brace));
    if (!m) continue;
    blank(i, colon + m.index, brace);
  }
  return hit ? lines.join('\n') : null;
}

// Groups `nodes` by the innermost `entries` span containing each one, in a single pass.
// The per-entry form ("for every entry, scan every node, and for each node scan every entry")
// is cubic in a file's declaration count, and every comparison reads `startIndex`/`endIndex`
// off a tree-sitter node, which is a wasm round-trip. Here each node's span is read once,
// entries are sorted by position, and a stack of open spans yields the innermost owner.
// Declaration spans come from one syntax tree, so they nest or are disjoint; an entry whose
// span is identical to an already-open one is skipped, so the entry listed first wins the tie.
// Entries without a span own nothing.
function groupByInnermost(nodes, entries) {
  const byEntry = new Map();
  const spans = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (typeof e.startIndex !== 'number' || typeof e.endIndex !== 'number') continue;
    spans.push({ e, i, s: e.startIndex, t: e.endIndex });
  }
  spans.sort((a, b) => a.s - b.s || b.t - a.t || a.i - b.i);
  const positioned = nodes.map((n) => ({ n, s: n.startIndex, t: n.endIndex }));
  positioned.sort((a, b) => a.s - b.s || b.t - a.t);
  const open = [];
  let next = 0;
  for (const p of positioned) {
    while (next < spans.length && spans[next].s <= p.s) {
      const cand = spans[next];
      next += 1;
      while (open.length && open[open.length - 1].t < cand.s) open.pop();
      const top = open[open.length - 1];
      if (top && top.s === cand.s && top.t === cand.t) continue;
      open.push(cand);
    }
    while (open.length && open[open.length - 1].t < p.s) open.pop();
    let k = open.length - 1;
    while (k >= 0 && open[k].t < p.t) k -= 1;
    if (k < 0) continue;
    const owner = open[k].e;
    let list = byEntry.get(owner);
    if (!list) { list = []; byEntry.set(owner, list); }
    list.push(p.n);
  }
  return byEntry;
}

function extractKotlinTreeSitter(content, filePath) {
  let tree = _ktParser.parse(content);
  const unDelegated = maskKotlinDelegation(content, tree.rootNode);
  if (unDelegated) tree = _ktParser.parse(unDelegated);
  if (parseErrorRatio(tree.rootNode, content.length) > 0) {
    const textual = maskKotlinHeaderSyntax(unDelegated || content);
    if (textual) {
      const alt = _ktParser.parse(textual);
      if (parseErrorRatio(alt.rootNode, textual.length)
        < parseErrorRatio(tree.rootNode, content.length)) tree = alt;
    }
  }
  const root = tree.rootNode;
  const _errorRatio = parseErrorRatio(root, content.length);

  const nodes              = [];
  const classEntries       = [];
  const methodEntries      = [];
  const memberEntries      = [];   // { nodeIndex, line, ownerName } — fields and methods
  const structuralEdges    = [];
  const inheritanceEdges   = [];

  const base = (node, extra) => ({
    confidence_tier: 'EXTRACTED', confidence: 1.0, _sourceFile: filePath,
    line: node.startPosition.row + 1,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    ...extra,
  });

  const bodyOf = (node) => node.children.find((c) => KT_TYPE_BODIES.has(c.type)) || null;

  const emitProperty = (decl, ownerName, kind) => {
    // `val (a, b) = pair` is a destructuring declaration: it binds two names through one
    // construct and the taxonomy excludes it on every side, as it does every other form with
    // no single stable identifier.
    for (const vd of decl.children.filter((c) => c.type === 'variable_declaration')) {
      const name = ktIdent(vd.children.find((c) => c.type === 'simple_identifier' || c.type === 'identifier'));
      if (!name) continue;
      const typeNode = vd.children.find((c) => c.type === 'user_type' || c.type === 'nullable_type');
      const isConst = /\bconst\b/.test(decl.text.slice(0, Math.max(0, vd.startIndex - decl.startIndex)));
      // Where the grammar has already failed somewhere in this file, its error recovery
      // re-parents class members to the file root: mockk's `VarargMatcher(private val prefix:
      // ...)` constructor properties and coroutines' `private val receivers = atomic(0L)` both
      // arrive as file-scope properties and were emitted as module constants. A Kotlin
      // top-level declaration is at column 0 — an indented one at file scope is a recovery
      // artefact, not a constant. Applied ONLY when the parse is known-degraded, so a clean
      // parse is still trusted completely.
      if (!ownerName && _errorRatio > 0 && decl.startPosition.column > 0) continue;
      const nd = base(decl, ownerName
        ? { node_type: 'FIELD', name, kind: 'property', field_type: typeNode ? typeNode.text : null,
            summary: `property ${name}`, parent_class: ownerName }
        : { node_type: 'CONSTANT', name, kind: isConst ? 'const' : 'val', summary: name });
      if (ownerName) memberEntries.push({ nodeIndex: nodes.length, line: nd.line, ownerName });
      nodes.push(nd);
    }
  };

  // `class Point(val x: Int)` declares a real property; a plain `(name: String)` parameter
  // declares nothing. The distinction is the `val`/`var` keyword and nothing else — the same
  // rule TypeScript parameter properties and PHP promoted properties already follow.
  const emitConstructorProperties = (typeNode, ownerName) => {
    const pc = typeNode.children.find((c) => c.type === 'primary_constructor');
    if (!pc) return;
    for (const p of pc.children.filter((c) => c.type === 'class_parameter')) {
      // The grammar wraps the keyword in a `binding_pattern_kind` node rather than
      // emitting a bare `val`/`var` token, so testing for the token type matched nothing and
      // every constructor property was dropped — 431 of mockk's 1,084 fields.
      const binding = p.children.find((c) => c.type === 'binding_pattern_kind');
      if (!binding || !/^(val|var)$/.test(binding.text)) continue;
      const name = ktIdent(p.children.find((c) => c.type === 'simple_identifier' || c.type === 'identifier'));
      if (!name) continue;
      const t = p.children.find((c) => c.type === 'user_type' || c.type === 'nullable_type');
      const nd = base(p, {
        node_type: 'FIELD', name, kind: 'constructor_property',
        field_type: t ? t.text : null, summary: `property ${name}`, parent_class: ownerName,
      });
      memberEntries.push({ nodeIndex: nodes.length, line: nd.line, ownerName });
      nodes.push(nd);
    }
  };

  // Declarations only, and only outside function bodies. The previous version selected nodes by
  // `parent.type === 'source_file' || 'class_body'` from a whole-tree descendant scan, which
  // both missed every member of an `enum_class_body` and admitted methods of an anonymous
  // `object : Foo() { }` declared INSIDE a function body. A local `fun` or `val` is not a
  // declaration of a program entity, and neither referee reports one.
  const walkDecls = (parent, ownerName) => {
    for (const node of parent.children) {
      // tree-sitter's error recovery does not discard what it could not fit — it re-parents
      // whole, correctly-parsed declarations underneath an ERROR node. Stopping at ERROR threw
      // those away: exposed's InsertTests.kt has nine error nodes in 854 lines and produced
      // ZERO declarations, because the one at line 44 sits above the file's only class. The
      // grammar's remaining limits here are diverse and unrelated (indexed assignment inside a
      // lambda, a subjectless `when` with a safe-cast guard, `Type<*>::member` references), so
      // recovering generically beats masking each construct — and unlike a mask this cannot
      // fabricate: every node it reaches is one the grammar itself built.
      if (node.type === 'ERROR') {
        if (_errorRatio > 0) walkDecls(node, ownerName);
        continue;
      }
      switch (node.type) {
        case 'class_declaration':
        case 'object_declaration':
        case 'companion_object': {
          const nameNode = node.children.find((c) => c.type === 'type_identifier');
          // A companion object may be written without a name. Its name IS `Companion` in
          // Kotlin — `Foo.Companion` resolves — which is what the compiler and ctags both say.
          const name = node.type === 'companion_object' && !nameNode
            ? 'Companion' : ktIdent(nameNode);
          if (!name) { // an anonymous `object : Foo() { }` declares no type
            const anonBody = bodyOf(node);
            if (anonBody) walkDecls(anonBody, ownerName);
            break;
          }
          const kind = node.type === 'object_declaration' ? 'object'
            : node.type === 'companion_object' ? 'companion_object'
              : ktClassKind(node, nameNode);
          const nd = base(node, {
            node_type: 'CLASS', name, kind, summary: `${kind.replace('_', ' ')} ${name}`,
          });
          // This grammar hangs each supertype off the class as its own `delegation_specifier`;
          // the plural `delegation_specifiers` list the previous version looked for does not
          // exist in this build, so `extends` was never set on any Kotlin node.
          const superNames = node.children
            .filter((c) => c.type === 'delegation_specifier')
            .map((c) => {
              const inv = c.children.find((x) => x.type === 'constructor_invocation'
                || x.type === 'explicit_delegation');
              const ut = (inv || c).children.find((x) => x.type === 'user_type'
                || x.type === 'type_identifier') || (c.type === 'user_type' ? c : null);
              return ut ? ut.text.split('<')[0] : null;
            })
            .filter(Boolean);
          if (superNames.length) {
            nd.extends = superNames[0];
            for (const sn of superNames) {
              inheritanceEdges.push({
                // `toName` is the field the ingest consumer reads
                // (ingest-file-processor.js#478); `targetName` was silently
                // dropped, so Kotlin inheritance never reached the graph.
                fromIndex: nodes.length, toName: sn,
                edgeType: 'EXTENDS', evidenceLine: nd.line,
              });
            }
          }
          if (ownerName) nd.parent_class = ownerName;
          classEntries.push({
            nodeIndex: nodes.length, line: nd.line,
            startIndex: node.startIndex, endIndex: node.endIndex,
          });
          nodes.push(nd);
          emitConstructorProperties(node, name);
          const body = bodyOf(node);
          if (body) walkDecls(body, name);
          break;
        }

        case 'type_alias': {
          const name = ktIdent(node.children.find((c) => c.type === 'type_identifier'));
          if (!name) break;
          const nd = base(node, {
            node_type: 'CLASS', name, kind: 'typealias', summary: `typealias ${name}`,
          });
          classEntries.push({
            nodeIndex: nodes.length, line: nd.line,
            startIndex: node.startIndex, endIndex: node.endIndex,
          });
          nodes.push(nd);
          break;
        }

        case 'enum_entry': {
          const name = ktIdent(node.children.find((c) => c.type === 'simple_identifier' || c.type === 'identifier'));
          if (!name) break;
          const nd = base(node, {
            node_type: 'FIELD', name, kind: 'enum_entry', summary: `enum entry ${name}`,
            ...(ownerName ? { parent_class: ownerName } : {}),
          });
          if (ownerName) memberEntries.push({ nodeIndex: nodes.length, line: nd.line, ownerName });
          nodes.push(nd);
          // An enum entry may carry its own body of overrides.
          const body = bodyOf(node);
          if (body) walkDecls(body, ownerName);
          break;
        }

        case 'function_declaration': {
          const nameNode = node.children.find((c) => c.type === 'simple_identifier' || c.type === 'identifier');
          const name = ktIdent(nameNode);
          if (!name) break;
          const paramsNode = node.children.find((c) => c.type === 'function_value_parameters');
          const directTypes = node.children.filter((c) => c.type === 'user_type' || c.type === 'nullable_type');
          const receiverNode = directTypes.find((c) => c.endIndex <= nameNode.startIndex);
          const retNode = directTypes.find((c) => c.startIndex >= nameNode.endIndex);
          const nd = base(node, {
            node_type: 'METHOD', name, kind: ownerName ? 'method' : 'function',
            summary: `${name}(${paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '') : ''})${retNode ? ': ' + retNode.text : ''}`,
          });
          if (paramsNode) nd.params = paramsNode.text.replace(/^\(|\)$/g, '');
          if (receiverNode) nd.receiverType = receiverNode.text;
          if (retNode) nd.returnType = retNode.text;
          if (ownerName) nd.parent_class = ownerName;
          methodEntries.push({
            nodeIndex: nodes.length, line: nd.line,
            startIndex: node.startIndex, endIndex: node.endIndex,
          });
          if (ownerName) memberEntries.push({ nodeIndex: nodes.length, line: nd.line, ownerName });
          nodes.push(nd);
          // Deliberately NOT descending into the body.
          break;
        }

        case 'property_declaration':
          emitProperty(node, ownerName);
          break;

        default:
          break;
      }
    }
  };
  walkDecls(root, null);

  const enclosingClass = (entry) => classEntries
    .filter((candidate) => candidate.nodeIndex !== entry.nodeIndex
      && candidate.startIndex <= entry.startIndex && candidate.endIndex >= entry.endIndex)
    .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0] || null;

  for (const entry of [...classEntries, ...methodEntries]) {
    const owner = enclosingClass(entry);
    if (owner) structuralEdges.push({
      fromIndex: entry.nodeIndex,
      toIndex: owner.nodeIndex,
      edgeType: 'DEFINED_IN',
      evidenceLine: entry.line ?? null,
    });
  }

  // This extractor never scanned call expressions at all, so
  // every .kt file produced CLASS/METHOD/DEFINED_IN and ZERO call edges — Kotlin call
  // extraction was absent from the shipping path. Purely
  // AST-derived: an earlier rejected fix was a regex scan that missed `new X /*c*/ ()` and emitted
  // CALLS->CLASS, and reading real call_expression nodes avoids both failure modes.
  const kotlinCallee = (callNode) => {
    const first = (callNode.children || [])[0];
    if (!first) return null;
    if (first.type === 'simple_identifier' || first.type === 'identifier') return first.text;
    if (first.type === 'navigation_expression') {
      let found = null;
      (function scan(n) {
        if (n.type === 'simple_identifier' || n.type === 'identifier') found = n.text;
        for (const c of n.children || []) scan(c);
      })(first);
      return found;
    }
    return null;
  };
  const kotlinClassByName = new Map();
  for (const ce of classEntries) {
    const cname = nodes[ce.nodeIndex].name;
    if (!kotlinClassByName.has(cname)) kotlinClassByName.set(cname, ce.nodeIndex);
  }
  // Method names must be scoped to what the CALL SITE could actually reach, not to the
  // whole file. A file-global set lets an unrelated `Formatter.Money()` suppress the real
  // `Invoice.total() -> INSTANTIATES -> Money`, and the residue then resolves by bare name
  // onto that private helper as a 0.90 EXTRACTED CALLS edge — a confidently wrong edge,
  // strictly worse than the missing one it replaced.
  const kotlinOwnerOf = new Map();
  for (const me of methodEntries) {
    const owner = enclosingClass(me);
    kotlinOwnerOf.set(me.nodeIndex, owner ? owner.nodeIndex : null);
  }
  const kotlinMethodNamesByOwner = new Map();
  for (const me of methodEntries) {
    const owner = kotlinOwnerOf.get(me.nodeIndex);
    if (!kotlinMethodNamesByOwner.has(owner)) kotlinMethodNamesByOwner.set(owner, new Set());
    kotlinMethodNamesByOwner.get(owner).add(nodes[me.nodeIndex].name);
  }
  const kotlinTopLevelFns = kotlinMethodNamesByOwner.get(null) || new Set();
  const kotlinCallNodes = root.descendantsOfType('call_expression');
  const kotlinCallsByOwner = groupByInnermost(kotlinCallNodes, methodEntries);
  // Known gap, deliberately not addressed here: a call in a property initialiser
  // (`val repo = Repo()`) sits outside every method span and is not collected at all.
  // Attributing it would mean a CLASS-sourced edge, a different edge shape than this
  // pass emits. It is a false negative, not a wrong edge.
  for (const me of methodEntries) {
    const nd = nodes[me.nodeIndex];
    const ownerIdx = kotlinOwnerOf.get(me.nodeIndex);
    const visibleMethods = kotlinMethodNamesByOwner.get(ownerIdx) || new Set();
    const callExprs = [];
    const seenInstantiations = new Set();
    for (const callNode of kotlinCallsByOwner.get(me) || []) {
      const callee = kotlinCallee(callNode);
      if (!callee) continue;
      // Kotlin has no `new`, so a bare callee naming a same-file CLASS that no method
      // reachable from here shadows is construction. INSTANTIATES, never CALLS->CLASS.
      if (!visibleMethods.has(callee) && !kotlinTopLevelFns.has(callee)) {
        const classIdx = kotlinClassByName.get(callee);
        if (classIdx !== undefined && classIdx !== me.nodeIndex) {
          if (!seenInstantiations.has(classIdx)) {
            seenInstantiations.add(classIdx);
            structuralEdges.push({
              fromIndex: me.nodeIndex,
              toIndex: classIdx,
              edgeType: 'INSTANTIATES',
              resolution: 'same_file',
              evidenceLine: callNode.startPosition.row + 1,
            });
          }
          continue;
        }
      }
      callExprs.push({ callee, line: callNode.startPosition.row + 1 });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }

  // Content-derived side channels — same contract as the regex path (.kt maps to lang 'java').
  const lang = langForFile(filePath) || LANG.JAVA;
  const sourceEntry = classEntries[0] || methodEntries[0] || null;
  const relativeImportEdges = buildRelativeImportEdges(
    content, filePath, lang, sourceEntry ? sourceEntry.nodeIndex : null
  );
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, lang);

  const importFacts = [];
  for (const node of root.descendantsOfType('import_header')) {
    const identifier = node.children.find(c => c.type === 'identifier');
    if (!identifier?.text) continue;
    const module = identifier.text;
    const aliasNode = node.children.find(c => c.type === 'import_alias');
    const alias = aliasNode?.text?.replace(/^as\s+/, '').trim() || null;
    importFacts.push({
      name: module.split('.').pop(),
      module,
      alias,
      line: node.startPosition.row + 1,
    });
  }

  releaseTree(tree);
  nodes.push(...extractRationaleNodes(content, filePath));
  const _result = { nodes, structuralEdges, inheritanceEdges, relativeImportEdges, sqlReferences, configValueRefs, importFacts };
  Object.defineProperty(_result, 'errorRatio', { value: _errorRatio, enumerable: false });
  return _result;
}

// ─── Go tree-sitter extractor ────────────────────────────────────────────────

// Lazy-init the Go parser once at module load; falls back to Go regex if the
// WASM fails to load.
let _goState  = 'pending';   // 'pending' | 'ready' | 'failed'
let _goParser = null;

const _goReady = (async () => {
  try {
    // Uses the shared loader so this plane gets the newer grammar build where one exists,
    // and so which build won is recorded rather than assumed.
    _goParser = await _loadWasmParser('go');
    _goState = 'ready';
  } catch (_) {
    _goState = 'failed';
  }
})();

// The unqualified name a Go embedded field declares. Per the Go spec ("Struct types"), an
// embedded field's name IS the unqualified type name, so `struct{ sync.Mutex }` declares a
// field called `Mutex` and `struct{ *Parent }` one called `Parent`. Both referees agree.
// Go's doc convention is the strongest of any language here: godoc defines a declaration's
// documentation as the run of `//` lines immediately above it, with no blank line between, and
// the whole standard library is written to it. The JSDoc helper cannot be reused — it requires
// `/**`, which Go code effectively never uses.
function _goDocComment(declNode) {
  const lines = [];
  let prev = declNode.previousSibling;
  let expectedRow = declNode.startPosition.row - 1;
  while (prev && prev.type === 'comment' && prev.startPosition.row === expectedRow
         && prev.text.startsWith('//')) {
    lines.unshift(prev.text.replace(/^\/\/\s?/, ''));
    expectedRow = prev.startPosition.row - 1;
    prev = prev.previousSibling;
  }
  if (!lines.length) return null;
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > DOC_MIN_LENGTH ? { text, line: expectedRow + 2 } : null;
}

function _goEmbeddedName(node) {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier': case 'identifier': case 'field_identifier':
      return node.text;
    case 'qualified_type':
      return node.children.filter(c => c.type === 'type_identifier').pop()?.text || null;
    case 'pointer_type': case 'generic_type': case 'parenthesized_type':
      return _goEmbeddedName(node.namedChildren.find(c => c.type !== 'type_arguments'));
    default:
      return null;
  }
}

// The type an embedded field REFERS to, keeping the package qualifier
// (`http.ResponseWriter`, not `ResponseWriter`) so an external embed's EXTENDS
// edge can bind via the `http` import — mirrors _goEmbeddedName, which returns
// the unqualified name the FIELD declaration itself takes (per the Go spec).
function _goEmbeddedTypeRef(node) {
  if (!node) return null;
  switch (node.type) {
    case 'qualified_type':
      return node.text;
    case 'pointer_type': case 'generic_type': case 'parenthesized_type':
      return _goEmbeddedTypeRef(node.namedChildren.find(c => c.type !== 'type_arguments'));
    default:
      return _goEmbeddedName(node);
  }
}

// Extracts CLASS (every named type declaration), FIELD (struct members), METHOD (functions,
// receiver methods, interface method specs), CONSTANT (package-level const/var) nodes and
// import facts from Go source using tree-sitter.
function extractGoTreeSitter(content, filePath) {
  const tree = _goParser.parse(content);
  const root = tree.rootNode;

  const nodes           = [];
  const classEntries    = [];  // { nodeIndex, line, name }
  const fieldEntries    = [];  // { nodeIndex, line, ownerName } — struct fields
  const methodEntries   = [];  // { nodeIndex, line } — standalone funcs (no receiver type match)
  const receiverEntries = [];  // { nodeIndex, line, receiverType } — receiver methods
  const structuralEdges = [];
  const inheritanceEdges = [];
  const docNodes = [];

  const attachDoc = (nd, node) => {
    const doc = _goDocComment(node);
    if (!doc) return nd;
    nd.doc_comment = doc.text;
    docNodes.push(docNodeFor(doc, filePath));
    return nd;
  };

  const emitInterfaceMethods = (body, ownerName, ownerIndex) => {
    // Interface method specs. These were once removed because the ownerless METHOD
    // canonical key made `Finder.Find` and `(*Repo).Find` one row; the key is now
    // owner-qualified, so the two are distinct nodes and the interface's own method
    // set is representable. Go's spec counts them as declarations (method sets), so they are
    // emitted. A `type_elem` (an embedded interface, or a `~int | string` type-set term)
    // declares no method and is not emitted.
    // An embedded interface IS inheritance in Go: the outer interface acquires the embedded
    // one's method set. It declares no METHOD node (which is why the loop below skips it), but
    // it is an edge, and without it `type Codec interface { Encoder; Decoder }` left no link at
    // all. A type-set term (`~int | string`) is a CONSTRAINT, not a method set, so unions are
    // excluded -- the same reading the go/parser referee applies.
    if (Number.isInteger(ownerIndex) && ownerIndex >= 0) {
      // Grammar versions disagree on how an embedded interface is spelled: newer
      // tree-sitter-go wraps it in `type_elem`, older ones put the bare `type_identifier` /
      // `qualified_type` straight into the body. Accept both rather than pinning a grammar.
      // tree-sitter-go emits `constraint_elem` for a bare embedded interface (verified on
      // spf13/viper: `type Codec interface { Encoder; Decoder }` yields two constraint_elem
      // children). `type_elem` is the name other grammar versions use, so both are accepted.
      const EMBED_TYPES = new Set(['constraint_elem', 'type_elem', 'type_identifier',
                                   'qualified_type', 'generic_type', 'pointer_type']);
      for (const te of body.namedChildren.filter(c => EMBED_TYPES.has(c.type))) {
        if (te.children.some(c => c.type === '|')) continue; // type-set union, not embedding
        const inner = (te.type === 'type_elem' || te.type === 'constraint_elem')
          ? (te.namedChildren[0] || te) : te;
        // Keep the qualifier (http.ResponseWriter) so an external embed binds via
        // its import; a bare local embed (Handler) is unchanged.
        const embedded = _goEmbeddedTypeRef(inner);
        if (embedded && embedded !== '_') {
          inheritanceEdges.push({
            fromIndex: ownerIndex, toName: embedded, edgeType: 'EXTENDS',
            evidenceLine: te.startPosition.row + 1,
          });
        }
      }
    }
    for (const spec of body.children.filter(c => c.type === 'method_spec' || c.type === 'method_elem')) {
      const mName = spec.children.find(c => c.type === 'field_identifier' || c.type === 'identifier')?.text;
      if (!mName || mName === '_') continue;
      const mParams = spec.children.find(c => c.type === 'parameter_list');
      const mnd = {
        node_type: 'METHOD', name: mName, confidence_tier: 'EXTRACTED', confidence: 1.0,
        kind: 'method_spec',
        summary: `interface method ${mName}(${mParams ? mParams.text.replace(/^\(|\)$/g, '') : ''})`,
        line: spec.startPosition.row + 1,
        start_line: spec.startPosition.row + 1,
        end_line: spec.endPosition.row + 1,
        _sourceFile: filePath,
        params: mParams ? mParams.text.replace(/^\(|\)$/g, '') : '',
        visibility: mName[0] === mName[0].toUpperCase() ? 'public' : 'private',
      };
      fieldEntries.push({ nodeIndex: nodes.length, line: mnd.line, ownerName });
      nodes.push(mnd);
    }
  };

  const emitStructFields = (body, ownerName, ownerIndex) => {
    const fdl = body.children.find(c => c.type === 'field_declaration_list');
    for (const field of (fdl ? fdl.children : []).filter(c => c.type === 'field_declaration')) {
      const typeNode = field.childForFieldName('type');
      const idents = field.children.filter(c => c.type === 'identifier' || c.type === 'field_identifier');
      // No name at all means an embedded field, which declares the unqualified type name.
      // These were dropped entirely before — 20 of gin's 315 fields, and they are how Go
      // spells inheritance, so the field they declare is exactly the one a reader looks for.
      const names = idents.length ? idents.map(i => i.text) : [_goEmbeddedName(typeNode)];
      for (const fname of names) {
        // The blank identifier is legal for a field (`_ [0]byte` is a standard padding and
        // alignment idiom) but has no stable name to match on, so it is excluded on every
        // side. Only `_` itself — a field named `_internal` is a real, findable declaration,
        // and the old `startsWith('_')` test dropped those too.
        if (!fname || fname === '_') continue;
        // An embedded field IS Go's inheritance: the outer type acquires the embedded type's
        // method set, so changing the embedded type changes the embedder. The FIELD node below
        // records the declaration; without this edge the graph could not answer "what does this
        // type embed" and a blast-radius walk stopped at the struct.
        if (!idents.length && Number.isInteger(ownerIndex) && ownerIndex >= 0) {
          // Edge keeps the qualifier (http.ResponseWriter) to bind an external
          // embed; the FIELD node above takes the unqualified name per the spec.
          inheritanceEdges.push({
            fromIndex: ownerIndex, toName: _goEmbeddedTypeRef(typeNode) || fname, edgeType: 'EXTENDS',
            evidenceLine: field.startPosition.row + 1,
          });
        }
        const fnd = {
          // These were once left as METHOD carrying `member_kind: 'field'`,
          // on the reasoning that METHOD was this graph's only member kind. It is not — six
          // other languages emit FIELD — and the comment there already conceded the cost:
          // typing a struct field METHOD overstates the type's method set, and `r.name()` is
          // a compile error. `member_kind` is kept so anything reading it still works.
          node_type: 'FIELD', name: fname, confidence_tier: 'EXTRACTED', confidence: 1.0,
          member_kind: 'field',
          kind: idents.length ? 'member' : 'embedded',
          field_type: typeNode ? typeNode.text.replace(/\s+/g, ' ') : null,
          summary: `field ${fname}${typeNode ? ': ' + typeNode.text : ''}`,
          line: field.startPosition.row + 1,
          start_line: field.startPosition.row + 1,
          end_line: field.endPosition.row + 1,
          _sourceFile: filePath,
        };
        fieldEntries.push({ nodeIndex: nodes.length, line: fnd.line, ownerName });
        nodes.push(fnd);
      }
    }
  };

  const emitTypeSpec = (spec, isAlias) => {
    const nameNode = spec.children.find(c => c.type === 'type_identifier');
    if (!nameNode || !nameNode.text || nameNode.text === '_') return;
    const name = nameNode.text;
    const body = spec.children.find(c => c.type === 'struct_type' || c.type === 'interface_type');
    // Every named type declaration is a type, not only the two with a body. `type Duration
    // int64`, `type HandlerFunc func(*Ctx) error` and `type H map[string]any` are defined
    // types with their own method sets — dropping them cost 35 of gin's 179 types, and
    // `HandlerFunc` is the central abstraction of that library.
    const kind = isAlias ? 'type_alias'
      : body ? (body.type === 'interface_type' ? 'interface' : 'struct')
        : 'defined_type';
    const nd = {
      node_type: 'CLASS', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
      summary: `${kind.replace('_', ' ')} ${name}`,
      line: spec.startPosition.row + 1,
      start_line: spec.startPosition.row + 1,
      end_line: spec.endPosition.row + 1,
      kind,
    };
    classEntries.push({ nodeIndex: nodes.length, line: nd.line, name });
    // For a single-spec declaration the doc sits above the `type` keyword; inside a
    // parenthesised `type ( ... )` block it sits above the spec itself.
    nodes.push(attachDoc(nd, spec.parent && spec.parent.type === 'type_declaration'
      && spec.parent.namedChildren.length === 1 ? spec.parent : spec));

    if (body && body.type === 'interface_type') emitInterfaceMethods(body, name, nodes.length - 1);
    if (body && body.type === 'struct_type') emitStructFields(body, name, nodes.length - 1);
  };

  const emitValueSpecs = (decl, kind) => {
    const specs = [];
    for (const c of decl.children) {
      if (c.type === 'const_spec' || c.type === 'var_spec') specs.push(c);
      else if (c.type === 'const_spec_list' || c.type === 'var_spec_list') {
        for (const s of c.children) if (s.type === 'const_spec' || s.type === 'var_spec') specs.push(s);
      }
    }
    for (const spec of specs) {
      for (const ident of spec.children.filter(c => c.type === 'identifier')) {
        // `var _ Iface = (*Impl)(nil)` is Go's standard compile-time interface assertion and
        // a single file declares them by the dozen; they share one name and no identity.
        if (!ident.text || ident.text === '_') continue;
        nodes.push({
          node_type: 'CONSTANT', name: ident.text, confidence_tier: 'EXTRACTED', confidence: 1.0,
          kind, summary: ident.text,
          line: spec.startPosition.row + 1,
          start_line: spec.startPosition.row + 1,
          end_line: spec.endPosition.row + 1,
          _sourceFile: filePath,
          visibility: ident.text[0] === ident.text[0].toUpperCase() ? 'public' : 'private',
        });
      }
    }
  };

  const emitFunction = (fn) => {
    const nameNode = fn.children.find(c => c.type === 'identifier');
    if (!nameNode || !nameNode.text || nameNode.text === '_') return;
    const name = nameNode.text;
    const paramsNode = fn.children.find(c => c.type === 'parameter_list');
    const nd = {
      node_type: 'METHOD', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
      kind: 'function',
      summary: `func ${name}(${paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '') : ''})`,
      line: fn.startPosition.row + 1,
      start_line: fn.startPosition.row + 1,
      end_line: fn.endPosition.row + 1,
      _sourceFile: filePath,
      visibility: name[0] === name[0].toUpperCase() ? 'public' : 'private',
    };
    if (paramsNode) nd.params = paramsNode.text.replace(/^\(|\)$/g, '');
    methodEntries.push({ nodeIndex: nodes.length, line: nd.line,
                         startIndex: fn.startIndex, endIndex: fn.endIndex });
    nodes.push(attachDoc(nd, fn));
  };

  const emitMethod = (md) => {
    const nameNode = md.children.find(c => c.type === 'field_identifier');
    if (!nameNode || !nameNode.text || nameNode.text === '_') return;
    const name = nameNode.text;
    // receiver parameter list is the first parameter_list child
    const receiverList = md.children.find(c => c.type === 'parameter_list');
    let receiverType = null;
    if (receiverList) {
      const paramDecl = receiverList.children.find(c => c.type === 'parameter_declaration');
      if (paramDecl) receiverType = _goEmbeddedName(paramDecl.childForFieldName('type'));
    }
    const paramLists = md.children.filter(c => c.type === 'parameter_list');
    const paramsNode = paramLists[1] || null;
    const nd = {
      node_type: 'METHOD', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
      kind: 'method', parent_class: receiverType || null,
      summary: `method ${name}(${paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '') : ''})`,
      line: md.startPosition.row + 1,
      start_line: md.startPosition.row + 1,
      end_line: md.endPosition.row + 1,
      _sourceFile: filePath,
      visibility: name[0] === name[0].toUpperCase() ? 'public' : 'private',
    };
    if (paramsNode) nd.params = paramsNode.text.replace(/^\(|\)$/g, '');
    receiverEntries.push({ nodeIndex: nodes.length, line: nd.line, receiverType,
                           startIndex: md.startIndex, endIndex: md.endIndex });
    nodes.push(attachDoc(nd, md));
  };

  // Package level only. `descendantsOfType` from the root also reached every `type`, `const`
  // and `var` declared INSIDE a function body — a local, not a declaration of a package
  // entity — which fabricated 30 types on gin, almost all of them structs declared inside a
  // table-driven test. Both referees exclude them (ctags emits no tag for a local at all) and
  // so does every other language in this programme.
  //
  // Descending into top-level ERROR nodes was written and then removed on evidence: across the
  // 3,924-file corpus the grammar produces a parse error in 29 files and NOT ONE of them puts
  // a declaration inside a top-level ERROR node — its recovery is local, and the declarations
  // around the bad construct stay siblings at the top level, which is why those 29 files still
  // score 100% recall. Where recovery does fail it fails the other way: an unclosed `(` makes
  // the parser swallow the rest of the file into that function's body, and pulling declarations
  // back out of a body is indistinguishable from re-admitting the locals this loop exists to
  // exclude. An untested branch that never fires is a liability, so it is not carried.
  const walkTop = (parent) => {
    for (const decl of parent.children) {
      switch (decl.type) {
        case 'type_declaration':
          for (const spec of decl.children) {
            if (spec.type === 'type_spec') emitTypeSpec(spec, false);
            else if (spec.type === 'type_alias') emitTypeSpec(spec, true);
          }
          break;
        case 'const_declaration': emitValueSpecs(decl, 'const'); break;
        case 'var_declaration': emitValueSpecs(decl, 'var'); break;
        case 'function_declaration': emitFunction(decl); break;
        case 'method_declaration': emitMethod(decl); break;
        default: break;
      }
    }
  };
  walkTop(root);

  // IMPORT nodes retired — every import
  // becomes a fact on `importFacts`, later attached to the FILE node's
  // properties.imports (facts.js#buildFileScopedIndex already reads this
  // shape) instead of a same-file stub node no cross-file pass could
  // resolve.
  const importFacts = [];
  for (const imp of extractImports(content, LANG.GO)) {
    if (!imp.source) continue;
    const alias = imp.alias || null;
    const name = alias || imp.source.split('/').pop();
    importFacts.push({ name, module: imp.source, alias, line: imp.line });
  }

  // Call sites. This plane produced ZERO of them before: every other tree-sitter plane stashes
  // `callExpressions` on the owning node for ingest.js#resolveCallExpressionEdges to turn into
  // CALLS/HEURISTIC_CALLS, and Go emitted none — so a Go repository ingested with declarations
  // and containment but no call graph at all.
  //
  // The receiver is captured, not dropped: `db.Query(...)` yields receiver `db`, which is what
  // makes the resolver's class-qualified branch reachable. Dropping it took Java's qualified
  // share from 45.3% to 0.
  // Every `pkg.Exported` written anywhere in the file, whether or not it is called.
  //
  // `callExpressions` records `pflag.NewFlagSet(...)` because that is a call. It does NOT record
  // `pflag.ContinueOnError` passed as an argument, `&pflag.Flag{...}` as a composite literal, or
  // `func(f *pflag.Flag)` as a closure parameter — and those are the forms that carry a
  // cross-repository type dependency without ever invoking anything. Cross-repo symbol recall on
  // spf13/viper stalled at 91.7% for exactly this reason; the four remaining misses were all
  // `pflag.Flag` / `pflag.ContinueOnError` inside function bodies.
  //
  // Only the capitalised field is kept: in Go that IS the exported set, so it is the only thing
  // another package can name. Resolution still gates these on the file's own imports, so an
  // unexported or unimported qualifier resolves to nothing.
  const goQualifiedRefs = [];
  {
    const seenRef = new Set();
    // Two grammar productions carry a qualified name in Go and both matter here:
    // `selector_expression` for value positions (`pflag.ContinueOnError`) and `qualified_type`
    // for type positions (`*pflag.Flag`, `&pflag.Flag{}`, `func(f *pflag.Flag)`). Reading only
    // the first left every purely-typed dependency invisible.
    const refNodes = [
      ...root.descendantsOfType('selector_expression'),
      ...root.descendantsOfType('qualified_type'),
    ];
    for (const sel of refNodes) {
      const operand = sel.childForFieldName('operand') || sel.childForFieldName('package');
      const field = sel.childForFieldName('field') || sel.childForFieldName('name');
      if (!operand || !field || operand.type !== 'identifier' && operand.type !== 'package_identifier') continue;
      const pkg = operand.text;
      const name = field.text;
      if (!IDENT_RE.test(pkg) || !GO_EXPORTED_RE.test(name)) continue;
      const key = `${pkg}.${name}`;
      if (seenRef.has(key)) continue;
      seenRef.add(key);
      goQualifiedRefs.push({ pkg, name, line: sel.startPosition.row + 1 });
    }
  }

  const goCallNodes = root.descendantsOfType('call_expression');
  const goEntries = methodEntries.concat(receiverEntries);
  const goCallsByOwner = groupByInnermost(goCallNodes, goEntries);
  for (const entry of goEntries) {
    if (entry.startIndex === undefined) continue;
    const nd = nodes[entry.nodeIndex];
    const callExprs = [];
    const seen = new Set();
    for (const callNode of goCallsByOwner.get(entry) || []) {
      const fnNode = callNode.childForFieldName('function');
      if (!fnNode) continue;
      let callee = null;
      let receiver = null;
      if (fnNode.type === 'identifier') {
        callee = fnNode.text;
      } else if (fnNode.type === 'selector_expression') {
        const field = fnNode.childForFieldName('field');
        const operand = fnNode.childForFieldName('operand');
        if (field) callee = field.text;
        if (operand) receiver = operand.text.replace(/\s+/g, '');
      }
      // A conversion (`[]byte(s)`) and a generic instantiation (`New[T](x)`) are call
      // expressions in the grammar but call no function.
      if (!callee || !IDENT_RE.test(callee)) continue;
      const line = callNode.startPosition.row + 1;
      const key = `${receiver || ''}:${callee}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callExprs.push(receiver ? { callee, receiver, line } : { callee, line });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }

  // DEFINED_IN edges: struct fields → their owning struct (by name)
  const classIndexByName = new Map(classEntries.map(ce => [ce.name, ce.nodeIndex]));
  for (const fe of fieldEntries) {
    const classIdx = classIndexByName.get(fe.ownerName);
    if (classIdx !== undefined) structuralEdges.push({ fromIndex: fe.nodeIndex, toIndex: classIdx, edgeType: 'DEFINED_IN', evidenceLine: fe.line ?? null });
  }

  // DEFINED_IN edges: receiver methods → their receiver type
  for (const re of receiverEntries) {
    if (re.receiverType) {
      const classIdx = classIndexByName.get(re.receiverType);
      if (classIdx !== undefined) structuralEdges.push({ fromIndex: re.nodeIndex, toIndex: classIdx, edgeType: 'DEFINED_IN', evidenceLine: re.line ?? null });
    }
  }

  // IMPORTS-to-stub emission retired —
  // importFacts (collected above) carries the same information to the FILE
  // node's properties.imports instead.
  const sourceEntry = classEntries[0] || methodEntries[0];

  // Content-derived side channels — same contract as the regex path.
  const lang = langForFile(filePath) || LANG.GO;
  const relImportSource = sourceEntry || null;
  const relativeImportEdges = buildRelativeImportEdges(
    content, filePath, lang, relImportSource ? relImportSource.nodeIndex : null
  );
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, lang);

  nodes.push(...docNodes);
  nodes.push(...extractRationaleNodes(content, filePath));

  releaseTree(tree);
  // `qualifiedRefs` is NOT added to this return. All four tree-sitter extractors are held to one
  // six-key shape, and widening a cross-language
  // contract for a fact only the Go walk produces would trade a real invariant for convenience.
  // It is exposed through `extractGoQualifiedRefs` below instead.
  _lastGoQualifiedRefs = goQualifiedRefs;
  return { nodes, structuralEdges, inheritanceEdges, relativeImportEdges, sqlReferences, configValueRefs, importFacts };
}

// ─── PHP tree-sitter extractor ───────────────────────────────────────────────
//
// A line scanner cannot recover four PHP planes: properties, class constants, enum cases and
// promoted constructor properties. Two of the four cannot be done by a line scanner at all — a
// promoted property is a parameter, and a class constant is only distinguishable from a
// file-level one by its enclosing scope.

let _phpState = 'pending';
let _phpParser = null;

const _phpReady = (async () => {
  try {
    _phpParser = await _loadWasmParser('php');
    _phpState = 'ready';
  } catch (_) {
    _phpState = 'failed';
  }
})();

const PHP_TYPE_DECLS = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

// A class body, an enum body, and the body of `new class { ... }`. The last of these has no
// `class_declaration` above it — the grammar hangs a bare `declaration_list` off
// `object_creation_expression` — which is exactly how an anonymous class is recognised.
const PHP_BODY_TYPES = new Set(['declaration_list', 'enum_declaration_list']);

function _phpEnclosingType(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (PHP_TYPE_DECLS[cur.type]) {
      const n = cur.childForFieldName('name');
      return n ? n.text : null;
    }
    if (cur.type === 'object_creation_expression') return null; // anonymous class
  }
  return null;
}

// True when this node is a member of a type body rather than a file-level declaration. The
// grammar uses ONE node type (`const_declaration`) for `const X = 1` at file scope and
// `public const X = 1` inside a class, so only the parent separates a constant from a field.
function _phpInTypeBody(node) {
  return !!(node.parent && PHP_BODY_TYPES.has(node.parent.type));
}

// PHPDoc is `/** ... */` directly above a declaration. Modifiers (`final`, `abstract`,
// `public`, `readonly`) are tokens of the declaration node itself here, not siblings, so the
// simple previous-sibling walk is enough — but attributes (`#[Attribute]`) ARE siblings and
// must be stepped over, and PHP 8 code is full of them.
function _phpDocComment(declNode) {
  let prev = declNode.previousSibling;
  while (prev) {
    if (prev.type === 'attribute_list') { prev = prev.previousSibling; continue; }
    if (prev.type !== 'comment') return null;
    if (!prev.text.startsWith('/**')) { prev = prev.previousSibling; continue; }
    const text = cleanDocText(prev.text);
    return text.length > DOC_MIN_LENGTH ? { text, line: prev.startPosition.row + 1 } : null;
  }
  return null;
}

// PHP 8.4 property hooks: `public string $p { get { return $this->x; } set { ... } }`. The
// grammar build this runtime can load (ABI 13-14) predates them and errors on the hook block,
// which loses the property declaration itself — and under error recovery it read the hook
// body's `$this` as the property name. Replacing the hook block with `;` leaves an ordinary
// typed property the grammar does parse. Newlines are preserved so every other declaration in
// the file keeps its line number.
//
// Same shape as maskPreprocessorDirectives / maskClassExportMacros on the C path: mask,
// re-parse, keep the cleaner parse. Returns null when the file has no hooks, so the common
// case costs one regex test and no second parse.
const PHP_PROPERTY_HOOK_HEAD = new RegExp(
  String.raw`^[ \t]*(?:(?:public|private|protected|static|final|readonly|var)\s+)+` +
  String.raw`(?:\??[\w\\|]+\s+)?\$\w+[ \t]*(?:=[^;{}\n]*)?[ \t]*\{`, 'gm');

function maskPhpPropertyHooks(content) {
  PHP_PROPERTY_HOOK_HEAD.lastIndex = 0;
  if (!PHP_PROPERTY_HOOK_HEAD.test(content)) return null;
  PHP_PROPERTY_HOOK_HEAD.lastIndex = 0;
  const chars = content.split('');
  let m;
  let masked = false;
  while ((m = PHP_PROPERTY_HOOK_HEAD.exec(content)) !== null) {
    const open = m.index + m[0].length - 1;    // the `{`
    let depth = 0;
    let close = -1;
    // String- and comment-aware, like the C brace scanner. Bailing on the first quote was
    // tried and is too blunt: a hook body as ordinary as `return 'original value';` abandoned
    // masking for the whole file, which left one of phpunit's seven hooked properties missing.
    for (let i = open; i < content.length; i++) {
      const ch = content[i];
      if (ch === '/' && content[i + 1] === '/') { i = content.indexOf('\n', i); if (i < 0) return null; continue; }
      if (ch === '#') { i = content.indexOf('\n', i); if (i < 0) return null; continue; }
      if (ch === '/' && content[i + 1] === '*') { i = content.indexOf('*/', i + 2); if (i < 0) return null; i += 1; continue; }
      if (ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < content.length && content[i] !== q) { if (content[i] === '\\') i++; i++; }
        if (i >= content.length) return null;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) return null;
    chars[open] = ';';
    for (let i = open + 1; i <= close; i++) if (chars[i] !== '\n') chars[i] = ' ';
    masked = true;
    PHP_PROPERTY_HOOK_HEAD.lastIndex = close;
  }
  return masked ? chars.join('') : null;
}

function extractPhpTreeSitter(content, filePath) {
  const tree = _phpParser.parse(content);
  const root = tree.rootNode;
  const errorRatio = parseErrorRatio(root, content.length);

  const nodes = [];
  const classEntries = [];
  const memberEntries = [];   // { nodeIndex, line, ownerName }
  const methodEntries = [];   // { nodeIndex, line, startIndex, endIndex }
  const structuralEdges = [];
  const inheritanceEdges = [];
  const docNodes = [];

  // A namespace applies to everything after it until the next one, so declarations are stamped
  // by line the same way the regex path did it — the graph's PHP identity depends on it.
  const namespaces = [];
  for (const ns of root.descendantsOfType('namespace_definition')) {
    const n = ns.childForFieldName('name');
    if (n) namespaces.push({ line: ns.startPosition.row + 1, name: n.text });
  }
  const namespaceAt = (line) => {
    let found = null;
    for (const ns of namespaces) if (ns.line <= line) found = ns.name;
    return found;
  };

  const attachDoc = (nd, node) => {
    const doc = _phpDocComment(node);
    if (!doc) return nd;
    nd.doc_comment = doc.text;
    docNodes.push(docNodeFor(doc, filePath));
    return nd;
  };

  const pushMember = (nd, ownerName, node) => {
    if (ownerName) nd.parent_class = ownerName;
    memberEntries.push({ nodeIndex: nodes.length, line: nd.line, ownerName });
    nodes.push(node ? attachDoc(nd, node) : nd);
  };

  const base = (node, extra) => {
    const line = node.startPosition.row + 1;
    const ns = namespaceAt(line);
    return {
      confidence_tier: 'EXTRACTED', confidence: 1.0, _sourceFile: filePath,
      line, start_line: line, end_line: node.endPosition.row + 1,
      ...(ns ? { namespace: ns } : {}),
      ...extra,
    };
  };

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    for (const c of node.children) stack.push(c);
    const t = node.type;

    if (PHP_TYPE_DECLS[t]) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || !nameNode.text) continue;
      const name = nameNode.text;
      const kind = PHP_TYPE_DECLS[t];
      const nd = base(node, {
        node_type: 'CLASS', name, kind, summary: `${kind} ${name}`,
      });
      classEntries.push({ nodeIndex: nodes.length, line: nd.line, name });
      nodes.push(attachDoc(nd, node));

      // `extends` / `implements`. The grammar models them as clause children rather than a
      // single field, and an interface may extend several parents at once.
      for (const clause of node.children) {
        if (clause.type !== 'base_clause' && clause.type !== 'class_interface_clause') continue;
        for (const ref of clause.namedChildren) {
          const target = ref.text.split('\\').pop();
          if (target) {
            inheritanceEdges.push({
              // `toName` is the field the ingest consumer reads; `targetName`
              // was dropped, so PHP EXTENDS/IMPLEMENTS never reached the graph.
              fromIndex: nodes.length - 1, toName: target,
              edgeType: clause.type === 'base_clause' ? 'EXTENDS' : 'IMPLEMENTS',
              evidenceLine: nd.line,
            });
          }
        }
      }
      continue;
    }

    if (t === 'method_declaration' || t === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || !nameNode.text) continue;
      const name = nameNode.text;
      const params = node.childForFieldName('parameters');
      const owner = t === 'method_declaration' ? _phpEnclosingType(node) : null;
      const nd = base(node, {
        node_type: 'METHOD', name,
        kind: t === 'method_declaration' ? 'method' : 'function',
        params: params ? params.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '',
        summary: `${t === 'method_declaration' ? 'method' : 'function'} ${name}`,
      });
      if (owner) nd.parent_class = owner;
      methodEntries.push({
        nodeIndex: nodes.length, line: nd.line, ownerName: owner,
        startIndex: node.startIndex, endIndex: node.endIndex,
      });
      if (owner) memberEntries.push({ nodeIndex: nodes.length, line: nd.line, ownerName: owner });
      nodes.push(attachDoc(nd, node));

      // A promoted constructor parameter declares a real property and there is no other syntax
      // for it — the same rule the TypeScript plane applies to constructor parameter properties.
      if (params) {
        for (const p of params.namedChildren) {
          if (p.type !== 'property_promotion_parameter') continue;
          // `private &$called` nests the name under a `by_ref` node, so a direct-child search
          // finds nothing and the property vanishes.
          const v = p.descendantsOfType('variable_name')[0];
          const pname = v ? v.text.replace(/^\$/, '') : null;
          if (!pname) continue;
          const tn = p.childForFieldName('type');
          pushMember(base(p, {
            node_type: 'FIELD', name: pname, kind: 'promoted_property',
            field_type: tn ? tn.text : null, summary: `property ${pname}`,
          }), owner);
        }
      }
      continue;
    }

    if (t === 'property_declaration') {
      const owner = _phpEnclosingType(node);
      const tn = node.childForFieldName('type');
      for (const el of node.namedChildren) {
        if (el.type !== 'property_element') continue;
        const v = el.children.find((c) => c.type === 'variable_name');
        const name = v ? v.text.replace(/^\$/, '') : null;
        // `$this` is reserved and can never be a declared property. It appears here only under
        // error recovery: on PHP 8.4 property hooks (`public string $p { get { return
        // $this->p; } }`) this grammar reads the hook body's `$this` as a property element.
        if (!name || name === 'this') continue;
        pushMember(base(el, {
          node_type: 'FIELD', name, kind: 'property',
          field_type: tn ? tn.text : null, summary: `property ${name}`,
        }), owner);
      }
      continue;
    }

    if (t === 'enum_case') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || !nameNode.text) continue;
      pushMember(base(node, {
        node_type: 'FIELD', name: nameNode.text, kind: 'enum_case',
        summary: `case ${nameNode.text}`,
      }), _phpEnclosingType(node));
      continue;
    }

    if (t === 'const_declaration') {
      const inType = _phpInTypeBody(node);
      const owner = inType ? _phpEnclosingType(node) : null;
      for (const el of node.namedChildren) {
        if (el.type !== 'const_element') continue;
        const n = el.children.find((c) => c.type === 'name');
        if (!n || !n.text) continue;
        if (inType) {
          pushMember(base(el, {
            node_type: 'FIELD', name: n.text, kind: 'class_constant', summary: n.text,
          }), owner);
        } else {
          nodes.push(base(el, {
            node_type: 'CONSTANT', name: n.text, kind: 'const', summary: n.text,
          }));
        }
      }
      continue;
    }

    // `define('NAME', value)` is PHP's other way of declaring a global constant. Only a literal
    // first argument is matchable — a computed name has no stable identifier, the same
    // exclusion a computed property name gets in TypeScript.
    if (t === 'function_call_expression') {
      const fn = node.childForFieldName('function');
      // `\define(...)` is the SAME global function — the leading backslash is how a namespaced
      // file reaches the global namespace, and guzzle, phpunit and composer all write it that
      // way. Comparing the raw text missed every one of them.
      if (!fn || fn.text.replace(/^\\/, '').toLowerCase() !== 'define') continue;
      const args = node.childForFieldName('arguments');
      const first = args ? args.namedChildren[0] : null;
      const lit = first && (first.type === 'argument' ? first.namedChildren[0] : first);
      if (!lit || lit.type !== 'string') continue;
      const name = lit.text.replace(/^[bB]?['"]|['"]$/g, '');
      if (!name || /[^\w\\]/.test(name)) continue;
      nodes.push(base(node, {
        node_type: 'CONSTANT', name, kind: 'define', summary: name,
      }));
      continue;
    }
  }

  // Call sites, for ingest.js#resolveCallExpressionEdges. The receiver is kept: it is what
  // makes the resolver's class-qualified branch reachable.
  const callNodes = [];
  // `new Foo(...)` constructs Foo — a call to its constructor, and a common call shape. Captured
  // alongside method/function/scoped calls, with the constructed class's bare name (namespace
  // qualifier stripped) as the callee.
  for (const ty of ['function_call_expression', 'member_call_expression',
                    'nullsafe_member_call_expression', 'scoped_call_expression',
                    'object_creation_expression']) {
    for (const n of root.descendantsOfType(ty)) callNodes.push(n);
  }
  const callsByOwner = groupByInnermost(callNodes, methodEntries);
  for (const me of methodEntries) {
    const nd = nodes[me.nodeIndex];
    const callExprs = [];
    const seen = new Set();
    for (const callNode of callsByOwner.get(me) || []) {
      let callee = null;
      let receiver = null;
      if (callNode.type === 'function_call_expression') {
        const fn = callNode.childForFieldName('function');
        if (fn && (fn.type === 'name' || fn.type === 'qualified_name')) {
          callee = fn.text.split('\\').pop();
        }
      } else if (callNode.type === 'object_creation_expression') {
        // The class being constructed is the first name/qualified_name child (`new Foo` /
        // `new \Ns\Foo`); an anonymous class (`new class {}`) has none and is skipped.
        const cls = (callNode.namedChildren || []).find((c) => c.type === 'name' || c.type === 'qualified_name');
        if (cls) callee = cls.text.split('\\').pop();
      } else {
        const nm = callNode.childForFieldName('name');
        const obj = callNode.childForFieldName('object') || callNode.childForFieldName('scope');
        if (nm) callee = nm.text;
        if (obj) receiver = obj.text.replace(/\s+/g, '');
      }
      if (!callee || !/^\w+$/.test(callee)) continue;
      const line = callNode.startPosition.row + 1;
      const key = `${receiver || ''}:${callee}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callExprs.push(receiver ? { callee, receiver, line } : { callee, line });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }

  const classIndexByName = new Map(classEntries.map((ce) => [ce.name, ce.nodeIndex]));
  for (const me of memberEntries) {
    const classIdx = classIndexByName.get(me.ownerName);
    if (classIdx !== undefined && classIdx !== me.nodeIndex) {
      structuralEdges.push({
        fromIndex: me.nodeIndex, toIndex: classIdx,
        edgeType: 'DEFINED_IN', evidenceLine: me.line ?? null,
      });
    }
  }

  const importFacts = [];
  for (const imp of extractImports(content, LANG.PHP)) {
    if (!imp.source) continue;
    const alias = imp.alias || null;
    importFacts.push({
      name: alias || imp.source.split('\\').pop(), module: imp.source, alias, line: imp.line,
    });
  }

  const lang = langForFile(filePath) || LANG.PHP;
  const relSource = classEntries[0] || methodEntries[0] || null;
  const relativeImportEdges = buildRelativeImportEdges(
    content, filePath, lang, relSource ? relSource.nodeIndex : null
  );
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, lang);

  nodes.push(...docNodes);
  nodes.push(...extractRationaleNodes(content, filePath));

  releaseTree(tree);
  const _result = {
    nodes, structuralEdges, inheritanceEdges, relativeImportEdges,
    sqlReferences, configValueRefs, importFacts,
  };
  Object.defineProperty(_result, 'errorRatio', { value: errorRatio, enumerable: false });
  return _result;
}

// ─── TypeScript tree-sitter extractor ────────────────────────────────────────

let _tstsState = 'pending';
let _tstsParser = null;
// .tsx must be parsed with the JSX-aware grammar. tree-sitter ships TypeScript and TSX as two
// separate languages, and the plain TypeScript grammar produces ERROR nodes over every JSX
// element — silently losing every declaration nested inside one. That is the whole component
// body in a React codebase, so a .tsx file scored as if it were nearly empty.
let _tsxState = 'pending';
let _tsxParser = null;

const _tstsReady = (async () => {
  try {
    _tstsParser = await _loadWasmParser('typescript');
    _tstsState = 'ready';
  } catch (_) {
    _tstsState = 'failed';
  }
})();

const _tsxReady = (async () => {
  try {
    _tsxParser = await _loadWasmParser('tsx');
    _tsxState = 'ready';
  } catch (_) {
    _tsxState = 'failed';
  }
})();

// JavaScript. One grammar for .js/.jsx/.mjs/.cjs — tree-sitter-javascript parses JSX natively,
// unlike tree-sitter-typescript, which needs a separate TSX language.
let _jsState = 'pending';
let _jsParser = null;

const _jsReady = (async () => {
  try {
    _jsParser = await _loadWasmParser('javascript');
    _jsState = 'ready';
  } catch (_) {
    _jsState = 'failed';
  }
})();

// Test/diagnostic hook: resolves once every bespoke tree-sitter grammar has settled
// (ready or failed). Without awaiting this, a short-lived process races wasm init and
// buildAstNodes silently falls back to the regex path.
async function awaitTreeSitterReady() {
  await Promise.all([_ktReady, _goReady, _phpReady, _tstsReady, _tsxReady, _jsReady, _pyReady, _csReady,
    _cReady, _cppReady]);
  return {
    kotlin: _ktState, go: _goState, php: _phpState, typescript: _tstsState, tsx: _tsxState,
    javascript: _jsState, python: _pyState, csharp: _csState,
    c: _cState, cpp: _cppState,
  };
}

// Which wasm build each grammar resolved to, e.g. { typescript: 'vscode', javascript:
// 'tree-sitter-wasms' }. Call after awaitTreeSitterReady().
function treeSitterGrammarSources() {
  return { ..._wasmSourceUsed };
}

// The five named type-introducing declarations. `enum` and `type alias` were absent, which on
// a type-heavy library is most of the type plane: zod declares 918 type aliases and 28 enums
// against 69 classes, so the old set recovered 43% of the types that exist.
const TS_TYPE_DECLS = {
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  type_alias_declaration: 'type_alias',
};

// Every syntactic form that declares a callable. `method_signature` covers both an interface
// method and a class overload signature; `function_signature` covers ambient (`declare`) and
// overload declarations.
const TS_CALLABLE_DECLS = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function_signature',
  method_definition: 'method',
  method_signature: 'method_signature',
  abstract_method_signature: 'abstract_method',
};

const TS_FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const TS_NAME_NODE_TYPES = new Set([
  'identifier', 'property_identifier', 'type_identifier',
  'shorthand_property_identifier', 'private_property_identifier',
  // A numeric property name (`{ 42: string }`) is a stable identifier; a computed one is not.
  'number',
]);

// JavaScript-only. `exports.f = function () {}`, `module.exports.f = fn`,
// `Foo.prototype.bar = fn`, and `app.use = fn` ARE the declaration in CommonJS and
// prototype-era code; nothing else declares those functions.
const JS_ASSIGNED_RECEIVERS = new Set([
  'exports', 'module', 'app', 'proto', 'req', 'res', 'express',
  'application', 'router', 'server', 'client', 'service', 'hub'
]);

function jsAssignedMember(node) {
  const left = node.childForFieldName('left');
  if (!left || left.type !== 'member_expression') return null;
  const prop = left.childForFieldName('property');
  const obj = left.childForFieldName('object');
  if (!prop || !obj) return null;
  if (prop.type !== 'property_identifier' && prop.type !== 'private_property_identifier') return null;
  const name = prop.text;
  if (!name) return null;
  if (obj.type === 'this') return { name, kind: 'this_member' };
  if (obj.type === 'identifier') {
    if (obj.text === 'exports') return { name, kind: 'exports_member' };
    if (/^[A-Z]/.test(obj.text) || JS_ASSIGNED_RECEIVERS.has(obj.text.toLowerCase())) {
      return { name, kind: 'assigned_member', owner: obj.text };
    }
    return null;
  }
  if (obj.type === 'member_expression') {
    const innerObj = obj.childForFieldName('object');
    const innerProp = obj.childForFieldName('property');
    if (!innerObj || !innerProp) return null;
    if (innerObj.type !== 'identifier') return null;
    if (innerObj.text === 'module' && innerProp.text === 'exports') return { name, kind: 'exports_member' };
    if (innerProp.text === 'prototype') return { name, kind: 'prototype_member', owner: innerObj.text };
  }
  return null;
}

function tsDeclName(node) {
  // `name` in TypeScript, `key` on a `pair`, `property` on JavaScript's `field_definition` —
  // the two grammars name that field differently.
  const n = node.childForFieldName('name') || node.childForFieldName('key')
    || node.childForFieldName('property');
  if (!n) return null;
  if (n.type === 'string') {
    const frag = n.children.find((c) => c.type === 'string_fragment');
    return frag ? frag.text : null;
  }
  // A computed name (`[Symbol.iterator]()`) or a destructuring pattern has no stable
  // identifier to key a node on, and emitting one invents a name that is not in the source.
  if (!TS_NAME_NODE_TYPES.has(n.type)) return null;
  return n.text || null;
}

// A decorator sits in one of three places depending on the form: as a child of the declaration
// (`@Component class C {}`), as a preceding sibling inside `export_statement`
// (`@Component export class C {}`), or as a preceding sibling in a `class_body` (method
// decorators). Collecting only children — which is what the old path did for nothing at all —
// misses the exported case, i.e. every Angular component and every Nest controller.
function tsDecorators(node) {
  const out = [];
  for (const c of node.children) if (c.type === 'decorator') out.push(c.text);
  let prev = node.previousSibling;
  while (prev && (prev.type === 'decorator' || prev.type === 'comment')) {
    if (prev.type === 'decorator') out.unshift(prev.text);
    prev = prev.previousSibling;
  }
  // `@Component export class C {}` puts the decorator and the class under one
  // `export_statement`, separated by the `export` keyword token — so the sibling walk above
  // stops on the keyword and finds nothing. That is the exported form, i.e. every Angular
  // component and every Nest controller.
  if (node.parent && node.parent.type === 'export_statement') {
    for (const c of node.parent.children) {
      if (c.type === 'decorator' && !out.includes(c.text)) out.unshift(c.text);
    }
  }
  return out;
}

// A module constant is a top-level binding whose value is not a function — `const MAX = 5`,
// `export const ROUTES = [...]`. It is not a member of a type, so it is not a field, and it is
// not callable, so it is not a method: it needs its own plane. Restricted to the top level
// on purpose — a binding inside a function body is a local, not a declaration.
function tsModuleLevel(node) {
  const decl = node.parent;
  if (!decl || (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration')) return false;
  let holder = decl.parent;
  // `declare const gc: (() => void) | undefined;` is an ambient declaration — the grammar
  // wraps it in `ambient_declaration`, so the binding is a grandchild of `program` and the
  // top-level test failed on every one. tsc counts them (99 of the TypeScript corpus's module
  // constants), and it is how a `.d.ts` and every `declare global` block declares anything.
  // A `namespace`/`declare global` BODY is not unwrapped: a binding there is a member of that
  // namespace, not of the module, and tsc does not report it as a module constant either
  // (zod's `util.objectKeys` and angular's `ngDevMode` were 29 false positives when it was).
  while (holder && (holder.type === 'export_statement' || holder.type === 'ambient_declaration')) {
    holder = holder.parent;
  }
  return !!holder && holder.type === 'program';
}

// ─── Rationale and doc-reference side channel ────────────────────────────────
//
// Two signals that live only in comments and were previously discarded entirely:
//
//   RATIONALE — a `NOTE:`/`WHY:`/`HACK:`/`TODO:`-prefixed comment. It records *why* code is
//               the way it is, which is exactly the knowledge that leaves a company when the
//               author does, and it is nowhere else in the AST.
//   DOC_REF   — an `ADR-0011` / `RFC 793` citation. These are the conventional join points
//               between code and design documents; without them a code-to-ADR edge can never
//               form even when the code cites the ADR by name.
//
// Conservative on purpose: a bare `TODO`
// with no colon, or a reference inside a string literal, is not a declaration of anything.
const RATIONALE_KEYWORDS = ['NOTE', 'IMPORTANT', 'HACK', 'WHY', 'RATIONALE', 'TODO', 'FIXME'];
const RATIONALE_RE = new RegExp(`^\\s*(?://+|/\\*+|\\*+|#+|--)\\s*(${RATIONALE_KEYWORDS.join('|')}):\\s*(.+)$`);
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#|--)/;
const DOC_REF_RE = /\b(ADR[- ]?\d{1,5}|RFC[- ]?\d{1,5})\b/gi;

function extractRationaleNodes(content, filePath) {
  const out = [];
  const seenRefs = new Set();
  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = RATIONALE_RE.exec(line);
    if (m) {
      const text = `${m[1]}: ${m[2]}`.trim().replace(/\*\/\s*$/, '').trim();
      out.push({
        node_type: 'RATIONALE', name: text.slice(0, 120), kind: m[1].toLowerCase(),
        summary: text, confidence_tier: 'EXTRACTED', confidence: 1.0,
        line: i + 1, start_line: i + 1, end_line: i + 1, _sourceFile: filePath,
      });
    }
    if (!COMMENT_LINE_RE.test(line)) continue;
    DOC_REF_RE.lastIndex = 0;
    let ref;
    while ((ref = DOC_REF_RE.exec(line)) !== null) {
      // Normalise `adr 11`, `ADR-0011` and `ADR 11` to one canonical label so the same
      // document is one node rather than three.
      const parts = /^([A-Za-z]+)[- ]?(\d+)$/.exec(ref[1]);
      if (!parts) continue;
      const label = `${parts[1].toUpperCase()}-${parts[2].padStart(4, '0')}`;
      if (seenRefs.has(label)) continue;
      seenRefs.add(label);
      out.push({
        node_type: 'DOC_REF', name: label, kind: parts[1].toUpperCase(),
        summary: label, confidence_tier: 'EXTRACTED', confidence: 1.0,
        line: i + 1, start_line: i + 1, end_line: i + 1, _sourceFile: filePath,
      });
    }
  }
  return out;
}

// The doc comment attached to a declaration: a Python docstring, or a JSDoc `/** ... */` block
// immediately preceding a JS/TS declaration. This is the densest human-written context in a
// codebase and it was being discarded entirely.
//
// Stamped on the owning node AND emitted as its own RATIONALE node. The stamp is what makes it
// usable without a join; the node is what makes the plane countable.
const DOC_MIN_LENGTH = 20;

function cleanDocText(raw) {
  return String(raw || '')
    .replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
    .replace(/^[urbfURBF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '')
    .split('\n').map((l) => l.replace(/^\s*\*ic?\s?/, '').replace(/^\s*\*\s?/, '').trim())
    .join(' ').replace(/\s+/g, ' ').trim();
}

function pyDocstring(declNode) {
  const body = declNode.childForFieldName('body');
  if (!body) return null;
  const first = body.namedChildren[0];
  if (!first || first.type !== 'expression_statement') return null;
  const str = first.namedChildren[0];
  if (!str || (str.type !== 'string' && str.type !== 'concatenated_string')) return null;
  const text = cleanDocText(str.text);
  return text.length > DOC_MIN_LENGTH ? { text, line: first.startPosition.row + 1 } : null;
}

function jsDocComment(declNode) {
  // Walk back through siblings, stepping over the keyword tokens (`export`, `default`,
  // `declare`, `async`) and decorators that sit between a declaration and its JSDoc. An
  // exported declaration's JSDoc is a sibling of the `export_statement`, not of the
  // declaration, so on running out of siblings the search continues from the wrapper — which
  // is the common case in any ESM codebase.
  let cur = declNode;
  for (let hop = 0; hop < 2; hop++) {
    let prev = cur.previousSibling;
    while (prev) {
      if (prev.type === 'comment') {
        if (!prev.text.startsWith('/**')) { prev = prev.previousSibling; continue; }
        const text = cleanDocText(prev.text);
        return text.length > DOC_MIN_LENGTH ? { text, line: prev.startPosition.row + 1 } : null;
      }
      if (prev.type === 'decorator' || !prev.isNamed) { prev = prev.previousSibling; continue; }
      return null;
    }
    if (!cur.parent || cur.parent.type !== 'export_statement') return null;
    cur = cur.parent;
  }
  return null;
}

function docNodeFor(doc, filePath) {
  return {
    node_type: 'RATIONALE', name: doc.text.slice(0, 120), kind: 'docstring',
    summary: doc.text, confidence_tier: 'EXTRACTED', confidence: 1.0,
    line: doc.line, start_line: doc.line, end_line: doc.line, _sourceFile: filePath,
  };
}

function tsParamText(node) {
  const p = node.childForFieldName('parameters') || node.children.find((c) => c.type === 'formal_parameters');
  if (!p) return '';
  return p.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim();
}

// JavaScript has no interface/enum/type-alias/property-signature/parameter-property, and one
// form TypeScript does not need: the member assignment above. Everything else — class bodies,
// object literals, arrow consts, spans, owners, decorators — is the same tree shape, so the
// two languages share one walk rather than two that drift apart.
const JS_TYPE_DECLS = { class_declaration: 'class' };
const JS_CALLABLE_DECLS = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  method_definition: 'method',
};

function extractJavaScriptTreeSitter(content, filePath) {
  return extractTypeScriptTreeSitter(content, filePath, 'javascript');
}

// `javascript-via-ts` parses a JavaScript file with the TypeScript grammar. Flow is a
// different language that ships on the `.js` extension, and the JavaScript grammar errors on
// its type syntax — which truncates the file and loses the plain JavaScript declarations
// underneath it. The TypeScript grammar accepts most Flow annotations (`import type`,
// `?maybe`, `{| exact |}`, annotated parameters), so it recovers those declarations.
//
// It emits the JavaScript declaration set only. A Flow `type X = ...` is not a JavaScript
// declaration, and emitting it would invent nodes that no JavaScript parser agrees exist; the
// TypeScript grammar is used here as a parsing aid, not as a change of language.
function extractJavaScriptViaTsTreeSitter(content, filePath) {
  return extractTypeScriptTreeSitter(content, filePath, 'javascript-via-ts');
}

function extractTypeScriptTreeSitter(content, filePath, variant = 'typescript') {
  const isJs = variant === 'javascript' || variant === 'javascript-via-ts';
  const viaTs = variant === 'javascript-via-ts';
  const parser = viaTs
    ? _tsxParser
    : (isJs ? _jsParser
      : (filePath.toLowerCase().endsWith('.tsx') && _tsxState === 'ready' ? _tsxParser : _tstsParser));
  const TYPE_DECLS = isJs ? JS_TYPE_DECLS : TS_TYPE_DECLS;
  const CALLABLE_DECLS = isJs ? JS_CALLABLE_DECLS : TS_CALLABLE_DECLS;
  const FIELD_DECL = viaTs ? 'public_field_definition' : (isJs ? 'field_definition' : 'public_field_definition');
  const SRC_LANG = isJs ? LANG.JAVASCRIPT : LANG.TYPESCRIPT;
  const tree = parser.parse(content);
  const root = tree.rootNode;
  const parseError = root.hasError;

  const nodes = [];
  const classEntries = [];
  const methodEntries = [];
  const importFacts = [];
  const structuralEdges = [];
  const inheritanceEdges = [];
  const importStatements = root.descendantsOfType('import_statement')
    .map((node) => {
      const sourceNode = node.childForFieldName('source');
      if (!sourceNode) return null;
      const fragment = sourceNode.children.find((child) => child.type === 'string_fragment');
      const source = fragment ? fragment.text : sourceNode.text.replace(/^['"]|['"]$/g, '');
      return source ? { node, source, line: node.startPosition.row + 1 } : null;
    })
    .filter(Boolean);
  const importSources = importStatements.map(({ source, line }) => ({ source, line }));

  const fieldEntries = [];

  const base = (node, extra) => ({
    confidence_tier: 'EXTRACTED',
    confidence: 1.0,
    line: node.startPosition.row + 1,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    extractor_tier: 'treesitter',
    _sourceFile: filePath,
    ...extra,
  });

  const docNodes = [];
  const attachDoc = (nd, node) => {
    const doc = jsDocComment(node);
    if (!doc) return nd;
    nd.docstring = doc.text;
    docNodes.push(docNodeFor(doc, filePath));
    return nd;
  };

  const pushType = (node, name, kind) => {
    const decorators = tsDecorators(node);
    const nd = attachDoc(base(node, {
      node_type: 'CLASS', name, kind, summary: `${kind} ${name}`,
      ...(decorators.length ? { decorators } : {}),
    }), node);
    classEntries.push({
      nodeIndex: nodes.length, line: nd.line, name, kind, tsNode: node,
      startIndex: node.startIndex, endIndex: node.endIndex,
    });
    nodes.push(nd);
  };

  const pushMethod = (node, name, kind, paramsNode) => {
    const params = tsParamText(paramsNode || node);
    const returnNode = node.childForFieldName('return_type')
      || node.children.find((c) => c.type === 'type_annotation');
    const signature = `${name}(${params})`;
    const decorators = tsDecorators(node);
    const nd = attachDoc(base(node, {
      node_type: 'METHOD', name, signature, params, kind,
      summary: `${signature}${returnNode ? `: ${returnNode.text.replace(/^:\s*/, '')}` : ''}`,
      ...(decorators.length ? { decorators } : {}),
    }), node);
    methodEntries.push({
      nodeIndex: nodes.length, line: nd.line, name,
      startIndex: node.startIndex, endIndex: node.endIndex,
      returnType: returnNode ? returnNode.text : null,
    });
    nodes.push(nd);
  };

  const pushField = (node, name, kind, typeText) => {
    const decorators = tsDecorators(node);
    const nd = base(node, {
      node_type: 'FIELD', name, kind,
      summary: typeText ? `${name}: ${typeText}` : name,
      ...(typeText ? { field_type: typeText } : {}),
      ...(decorators.length ? { decorators } : {}),
    });
    fieldEntries.push({
      nodeIndex: nodes.length, line: nd.line, name, tsNode: node,
      startIndex: node.startIndex, endIndex: node.endIndex, fieldType: typeText,
    });
    nodes.push(nd);
  };

  // One walk over the whole tree. The old path restricted every declaration to a parent of
  // program/class_body/statement_block/export_statement, which dropped anything inside a
  // `namespace`, a `declare module`, an object literal, or an ambient block — and dropped
  // class methods whenever the class itself was nested. Depth is not what makes a declaration
  // real, so nothing is filtered on it; what is filtered on is having a stable name.
  const walkStack = [root];
  const seenTypes = new Set();
  while (walkStack.length) {
    const node = walkStack.pop();
    for (const c of node.children) walkStack.push(c);
    const t = node.type;

    if (TYPE_DECLS[t]) {
      const name = tsDeclName(node) || node.children.find((c) => c.type === 'type_identifier' || c.type === 'identifier')?.text;
      if (name && !seenTypes.has(node.startIndex)) {
        seenTypes.add(node.startIndex);
        pushType(node, name, TYPE_DECLS[t]);
      }
      continue;
    }

    if (CALLABLE_DECLS[t]) {
      const name = tsDeclName(node);
      if (name) pushMethod(node, name, CALLABLE_DECLS[t]);
      continue;
    }

    // A NAMED function expression passed as a call ARGUMENT is a declaration. The author named
    // it deliberately -- an anonymous callback stays anonymous -- and in the accessor-helper idiom
    // it is the only place the name appears at all.
    //
    // Measured on expressjs/express: `defineGetter(req, 'protocol', function protocol(){...})`
    // and twelve siblings produced NO node, so `neighbours({symbol:'protocol'})` answered with
    // test/req.protocol.js instead of lib/request.js:297 -- the test file, for a question about
    // the public request API. 16 such declarations on express, 16 on this repository, 0 on got:
    // narrow enough that this cannot flood a graph with callbacks.
    //
    // ARGUMENTS only. `const f = function g(){}` is already emitted as `f` by the declarator
    // branch below, and emitting `g` beside it would double-count one declaration under two names.
    if (isJs && (t === 'function_expression' || t === 'function' || t === 'generator_function')) {
      const parent = node.parent;
      if (parent && parent.type === 'arguments') {
        const name = node.childForFieldName('name');
        const text = name && name.text ? name.text.trim() : '';
        if (text) pushMethod(node, text, 'named_fn_expr_arg');
      }
      continue;
    }

    if (isJs && t === 'assignment_expression') {
      const value = node.childForFieldName('right');
      if (!value || !TS_FUNCTION_VALUES.has(value.type)) continue;
      const m = jsAssignedMember(node);
      if (m) {
        pushMethod(node, m.name, m.kind, value);
        if (m.owner) nodes[nodes.length - 1].parent_class = m.owner;
      }
      continue;
    }

    // A named binding whose VALUE is a function is a method, whatever syntax holds it:
    // `const f = () => {}`, `{ handler: () => {} }`, and the class-property arrow
    // (`onClick = (e) => {}`) that React and Angular use in place of a method. The rule is
    // value-based, never type-based — `c: () => void` in an interface declares a type, not a
    // function, and stays a field.
    if (t === 'variable_declarator' || t === 'pair' || t === FIELD_DECL) {
      const name = tsDeclName(node);
      if (!name) continue;
      const value = node.childForFieldName('value');
      if (value && TS_FUNCTION_VALUES.has(value.type)) {
        pushMethod(node, name, t === FIELD_DECL ? 'class_property_fn'
          : t === 'variable_declarator' ? 'const_fn' : 'object_prop_fn', value);
      } else if (t === 'variable_declarator' && tsModuleLevel(node)) {
        const nd = base(node, { node_type: 'CONSTANT', name, kind: 'module_constant', summary: name });
        nodes.push(nd);
      } else if (t === FIELD_DECL && node.parent && node.parent.type === 'class_body') {
        // A class field only exists inside a class body. The check is a grammar invariant on
        // any valid parse, and it costs nothing there — but under error recovery the parser
        // reinterprets loose statements as `field_definition`, which on Flow-annotated `.js`
        // (not JavaScript, but shipped with the extension) fabricated FIELD nodes named
        // `const`, `function` and `exports`.
        const ann = node.childForFieldName('type');
        pushField(node, name, 'class_property', ann ? ann.text.replace(/^:\s*/, '') : null);
      }
      continue;
    }

    if (isJs) continue; // the remaining forms are TypeScript-only

    if (t === 'property_signature') {
      const name = tsDeclName(node);
      if (name) {
        const ann = node.childForFieldName('type');
        pushField(node, name, 'property_signature', ann ? ann.text.replace(/^:\s*/, '') : null);
      }
      continue;
    }

    if (t === 'enum_body') {
      for (const c of node.namedChildren) {
        if (c.type === 'enum_assignment') {
          const name = tsDeclName(c);
          if (name) pushField(c, name, 'enum_member', null);
        } else if (c.type === 'property_identifier' || c.type === 'identifier') {
          if (c.text) pushField(c, c.text, 'enum_member', null);
        }
      }
      continue;
    }

    // TypeScript parameter properties: `constructor(private readonly repo: Repo)` declares a
    // class field, and there is no other syntax that declares it. Angular and NestJS express
    // essentially all dependency injection this way, so without these the field plane is empty
    // on exactly the dialects that matter most for this language.
    if (t === 'required_parameter' || t === 'optional_parameter') {
      const modified = node.children.some((c) => c.type === 'accessibility_modifier'
        || c.type === 'readonly' || c.type === 'override_modifier');
      if (!modified) continue;
      const owner = node.parent?.parent;
      if (!owner || owner.type !== 'method_definition' || tsDeclName(owner) !== 'constructor') continue;
      const pat = node.childForFieldName('pattern');
      if (!pat || pat.type !== 'identifier') continue;
      const ann = node.childForFieldName('type');
      pushField(node, pat.text, 'parameter_property', ann ? ann.text.replace(/^:\s*/, '') : null);
    }
  }

  // IMPORT nodes retired — every import
  // becomes a fact on `importFacts` instead of a same-file stub node.
  const imports = extractImports(content, SRC_LANG);
  const preciseRelativeTargets = new Set();
  const importFactKeys = new Set();
  const addImportFact = (fact) => {
    const key = `${fact.name}\0${fact.module}\0${fact.alias || ''}\0${fact.line || ''}`;
    if (importFactKeys.has(key)) return;
    importFactKeys.add(key);
    importFacts.push(fact);
  };
  for (const { node, source, line } of importStatements) {
    if (!source.startsWith('.')) continue;
    const specifiers = node.descendantsOfType('import_specifier');
    if (specifiers.length === 0) continue;
    for (const specifier of specifiers) {
      const name = specifier.childForFieldName('name')?.text;
      const alias = specifier.childForFieldName('alias')?.text || null;
      if (name) addImportFact({ name, module: source, alias, line });
    }
    const importClause = node.namedChildren.find((child) => child.type === 'import_clause');
    const hasNonNamedBinding = importClause?.namedChildren.some((child) => child.type !== 'named_imports');
    if (!hasNonNamedBinding) {
      preciseRelativeTargets.add(path.normalize(path.join(path.dirname(filePath), source)));
    }
  }
  for (const imp of imports) {
    if (!imp.source) continue;
    if (imp.source.startsWith('.')) {
      if (Array.isArray(imp.bindings) && imp.bindings.length > 0) {
        for (const binding of imp.bindings) {
          addImportFact({ name: binding.name, module: imp.source, alias: binding.alias, line: imp.line });
        }
        if (imp.kind === 'named' || imp.kind === 'type') {
          preciseRelativeTargets.add(path.normalize(path.join(path.dirname(filePath), imp.source)));
        }
      } else if (imp.kind === 'namespace' && imp.names && imp.names[0]) {
        // `import * as ns from './mod'` binds the whole module to one local name, the same
        // shape as Python's `import a.b as ns`, and is recorded the same way: the module string
        // as the name, the namespace as the alias. A member call `ns.f()` then resolves through
        // the receiver-import rung, which matches the receiver token against `alias`.
        addImportFact({ name: imp.source, module: imp.source, alias: imp.names[0], line: imp.line });
      } else if (imp.kind === 'default' && imp.names && imp.names[0]) {
        // `import f from './mod'` binds the module's default export under a local name. The
        // export's own declared name is not visible here, so the local name is recorded as the
        // symbol; when the two agree (the common `export default function f` case) the bare call
        // binds through import evidence, and when they differ the lookup misses and falls through.
        // The module-only fact is kept beside it: it is the file-level dependency, and the rung
        // that reads a module-only fact as "this file may bind any name declared there".
        addImportFact({ name: imp.names[0], module: imp.source, alias: null, line: imp.line });
        addImportFact({ name: imp.source, module: imp.source, alias: null, line: imp.line });
      } else {
        // A side-effect import — `import "../ajax.js"` — binds no identifier, so the per-binding
        // loop above emitted nothing and the file lost that dependency entirely. It is still a
        // real edge to a real file, and it is recorded the same way a package import is: the
        // module string as its own name. Measured on jquery, where this shape is how the whole
        // module graph is wired.
        addImportFact({ name: imp.source, module: imp.source, alias: null, line: imp.line });
      }
      continue;
    }
    addImportFact({ name: imp.source, module: imp.source, alias: null, line: imp.line });
    // The per-binding explosion above is gated on a RELATIVE specifier,
    // so every non-relative import recorded exactly one fact whose `name` IS the module
    // string. That is right for a genuine npm package — there is no local declaration to
    // find — but it silently defeated the tsconfig-alias and workspace-package tiers, which
    // resolve the module to a real first-party FILE and then look up a symbol name that was
    // never recorded. Measured: `import { formatValue } from '@app/util/format'` resolved the
    // alias correctly to src/utilities/format.ts and then searched it for a declaration named
    // "@app/util/format", missed, and fabricated an external DEPENDENCY node for a first-party
    // module while losing the CALLS edge entirely.
    //
    // The module-named fact above is KEPT (it is what creates the DEPENDENCY node for real
    // packages); these binding facts are ADDITIVE. They carry `firstPartyOnly` so the resolver
    // may satisfy them ONLY from the two proof-grade tiers that resolve a module to an actual
    // in-repo file. Without that flag, `import { Injectable } from '@angular/core'` would newly
    // reach the module-stem tier and could bind to a local `core.ts` declaring `Injectable` —
    // trading this defect for a false-edge defect.
    if (Array.isArray(imp.bindings) && imp.bindings.length > 0) {
      for (const binding of imp.bindings) {
        if (!binding || !binding.name || binding.name === imp.source) continue;
        addImportFact({
          name: binding.name, module: imp.source, alias: binding.alias, line: imp.line,
          firstPartyOnly: true,
        });
      }
    }
  }
  for (const { source, line } of importSources) {
    if (source.startsWith('.') || importFacts.some((fact) => fact.module === source)) continue;
    addImportFact({ name: source, module: source, alias: null, line });
  }
  importFacts.push(...extractReExportFacts(content, SRC_LANG));

  // Span-based innermost containment, the same rule the Java path uses. Owner is stamped on
  // the node as well as emitted as an edge: ingest-helpers#computeMethodOwnerQualifier keys a
  // method's identity on (owner, params), so without an owner every same-named method in a
  // file collapses onto one row via the canonical-key upsert.
  const ownerOf = (entry) => classEntries
    .filter((ce) => ce.startIndex <= entry.startIndex && ce.endIndex >= entry.endIndex)
    .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];

  for (const entry of [...methodEntries, ...fieldEntries]) {
    const enclosing = ownerOf(entry);
    if (!enclosing) continue;
    nodes[entry.nodeIndex].parent_class = enclosing.name;
    structuralEdges.push({
      fromIndex: entry.nodeIndex, toIndex: enclosing.nodeIndex,
      edgeType: 'DEFINED_IN', evidenceLine: entry.line ?? null,
    });
  }

  // EXTENDS / IMPLEMENTS. The regex path emits these for TypeScript; this path emitted none,
  // so every .ts file that reached the tree-sitter plane lost its whole inheritance layer.
  for (const ce of classEntries) {
    const decl = ce.tsNode;
    if (!decl) continue;
    const heritage = decl.children.find((c) => c.type === 'class_heritage');
    const clauses = heritage ? heritage.children : decl.children;
    const superName = (nameNode) => {
      const nn = nameNode && nameNode.type === 'generic_type'
        ? nameNode.childForFieldName('name') : nameNode;
      if (!nn) return null;
      const nm = (nn.type === 'nested_type_identifier' || nn.type === 'member_expression'
        ? nn.text.split('.').pop() : nn.text || '').trim();
      return nm && IDENT_RE.test(nm) ? nm : null;
    };
    for (const clause of clauses) {
      if (clause.type === 'extends_clause' || clause.type === 'implements_clause'
          || clause.type === 'extends_type_clause') {
        // TypeScript grammar: the superclass/interfaces are wrapped in a clause node.
        const edgeType = clause.type === 'implements_clause' ? 'IMPLEMENTS' : 'EXTENDS';
        for (const child of clause.namedChildren) {
          const nm = superName(child);
          if (nm) inheritanceEdges.push({ fromIndex: ce.nodeIndex, toName: nm, edgeType, evidenceLine: ce.line ?? null });
        }
      } else if (heritage && clause.isNamed && clause.type !== 'type_arguments') {
        // JavaScript grammar: class_heritage holds `extends` + the superclass
        // expression directly, with no extends_clause wrapper — so a plain .js
        // `class X extends Y` produced no inheritance edge at all.
        const nm = superName(clause);
        if (nm) inheritanceEdges.push({ fromIndex: ce.nodeIndex, toName: nm, edgeType: 'EXTENDS', evidenceLine: ce.line ?? null });
      }
    }
  }

  // The regex/generic path below (buildAstNodes) scans each method body for
  // call expressions and stashes them on node.callExpressions for
  // ingest.js#resolveCallExpressionEdges (invoked post-write from
  // ingest-post-tail.js) to turn into CALLS/HEURISTIC_CALLS edges — this
  // tree-sitter path never did, so TS/TSX files produced
  // CLASS/METHOD/DEFINED_IN only and ZERO CALLS edges (verified
  // live: a 9-function file with 3 in-body calls to sibling functions produced
  // 0 CALLS in the DB pre-fix). Tree-sitter already knows each method's exact
  // end_line, so this reuses the same body-scan helper the regex path uses,
  // with a precise range instead of that path's line-boundary heuristic.
  const contentLines = content.split('\n');
  const callNodes = root.descendantsOfType('call_expression');
  // `new X()` invokes X's constructor, and the body scan explicitly skipped it (`new` is a
  // CALL_EXPR_KEYWORD and the regex refuses a callee preceded by `new`). Measured on
  // nestjs/nest: 366 of 1 937 recall misses were exactly this shape — both nodes present, no
  // edge. resolveCallExpressionEdges already admits CLASS/ENTITY/INTERFACE as call targets, so
  // the constructed type name resolves without any further change.
  const newNodes = root.descendantsOfType('new_expression');

  // `this.`/`super.` name the caller's own class, which the resolver already prefers by
  // caller-class narrowing; carrying them through would key a lookup on a keyword. Mirrors the
  // regex scanner's chain rule: the LAST identifier before the member being called.
  const receiverName = (node) => {
    if (!node) return null;
    const t = node.type;
    if (t === 'this' || t === 'super' || t === 'this_expression' || t === 'super_expression') return null;
    if (t === 'identifier' || t === 'shorthand_property_identifier') return node.text;
    if (t === 'member_expression') return receiverName(node.childForFieldName('property'))
      || receiverName(node.childForFieldName('object'));
    if (t === 'property_identifier') return node.text;
    if (t === 'parenthesized_expression' || t === 'non_null_expression' || t === 'as_expression') {
      return receiverName(node.namedChildren[0]);
    }
    return null;
  };
  const ctorName = (node) => {
    if (!node) return null;
    if (node.type === 'identifier') return node.text;
    if (node.type === 'member_expression' || node.type === 'nested_identifier') {
      return ctorName(node.childForFieldName('property')) || node.text.split('.').pop();
    }
    if (node.type === 'generic_type') return ctorName(node.childForFieldName('name'));
    return null;
  };
  // ── Intra-procedural type flow (TS/TSX/JS only) ────────────────────────────
  //
  // A call on a local variable — `const pipe = new ValidationPipe(); pipe.transform(x)` — reaches
  // the resolver as receiver `pipe`, which names no declaration, so the resolver falls back to
  // the bare member name and guesses among every `transform` in the branch. Resolving the
  // receiver to its TYPE at extraction time turns that into `ValidationPipe.transform`, which
  // the resolver's class-contextual index answers exactly.
  //
  // Deliberately lightweight: one union-find over identifiers per function scope, fed by
  // declared parameter types, declared variable types, `new X()` initialisers, `as X` casts,
  // calls to functions with a declared return type, and the enclosing class's declared field
  // types. No inference, no cross-function propagation, no type checker.
  const TYPEFLOW_BUILTIN = new Set([
    'string', 'number', 'boolean', 'bigint', 'symbol', 'any', 'unknown', 'never', 'void', 'null',
    'undefined', 'object', 'Object', 'Function', 'Array', 'Promise', 'Map', 'Set', 'WeakMap',
    'WeakSet', 'Date', 'RegExp', 'Error', 'JSON', 'Math', 'this', 'Record', 'Partial', 'Readonly',
    'Required', 'Pick', 'Omit', 'Observable', 'Buffer', 'String', 'Number', 'Boolean',
  ]);
  // `: Promise<ValidationPipe> | undefined` → ValidationPipe. An array or a function type is not
  // a receiver whose members we can bind, so those return null rather than a wrong answer.
  const normalizeTypeName = (raw) => {
    if (!raw) return null;
    let t = String(raw).replace(/^\s*:\s*/, '').trim();
    if (!t || t.includes('=>') || t.startsWith('{') || t.startsWith('[')) return null;
    t = t.split('|').map((x) => x.trim()).filter((x) => x && x !== 'null' && x !== 'undefined')[0];
    if (!t) return null;
    for (let i = 0; i < 4; i++) {
      const m = /^(Promise|Awaited|Observable|Readonly|NonNullable)\s*<([\s\S]+)>$/.exec(t);
      if (!m) break;
      t = m[2].trim();
    }
    if (t.endsWith('[]')) return null;
    t = t.replace(/<[\s\S]*$/, '').trim();
    t = t.split('.').pop().trim();
    if (!IDENT_RE.test(t)) return null;
    if (TYPEFLOW_BUILTIN.has(t)) return null;
    return t;
  };
  const typeOfNode = (node, returnTypeByFn) => {
    if (!node) return null;
    switch (node.type) {
      case 'new_expression':
        return normalizeTypeName(ctorName(node.childForFieldName('constructor')));
      case 'as_expression':
      case 'satisfies_expression': {
        const last = node.namedChildren[node.namedChildren.length - 1];
        return normalizeTypeName(last && last.text);
      }
      case 'await_expression':
      case 'parenthesized_expression':
      case 'non_null_expression':
        return typeOfNode(node.namedChildren[0], returnTypeByFn);
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (!fn) return null;
        const nm = fn.type === 'member_expression'
          ? (fn.childForFieldName('property') || {}).text : fn.text;
        return nm ? normalizeTypeName(returnTypeByFn.get(nm)) : null;
      }
      default:
        return null;
    }
  };
  const returnTypeByFn = new Map();
  for (const me of methodEntries) {
    if (me.returnType && !returnTypeByFn.has(me.name)) returnTypeByFn.set(me.name, me.returnType);
  }
  // Enclosing-class declared field types. `this.deserializer.deserialize()` arrives with receiver
  // `deserializer`, which is a field name, not a type name — the dominant shape in DI code.
  const fieldTypeByClass = new Map();
  for (const fe of fieldEntries) {
    const owner = classEntries
      .filter((ce) => ce.startIndex <= fe.startIndex && ce.endIndex >= fe.endIndex)
      .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
    if (!owner) continue;
    // An untyped field with a constructor initialiser is the commonest DI shape of all:
    // `private static readonly logger = new Logger(X.name)`. Without the initialiser the
    // receiver `logger` names nothing and every same-named member in the branch is a candidate.
    const t = normalizeTypeName(fe.fieldType)
      || typeOfNode(fe.tsNode && fe.tsNode.childForFieldName('value'), returnTypeByFn);
    if (!t) continue;
    if (!fieldTypeByClass.has(owner.nodeIndex)) fieldTypeByClass.set(owner.nodeIndex, new Map());
    const m = fieldTypeByClass.get(owner.nodeIndex);
    if (!m.has(fe.name)) m.set(fe.name, t);
  }
  const paramNodes = root.descendantsOfType(['required_parameter', 'optional_parameter']);
  const varDeclNodes = root.descendantsOfType('variable_declarator');
  const identName = (node) => (node && node.type === 'identifier' ? node.text : null);
  const buildScopeTypes = (me) => {
    const typeOf = new Map();
    const aliasOf = new Map();
    const localNames = new Set();
    const inRange = (n) => n.startIndex >= me.startIndex && n.endIndex <= me.endIndex;
    for (const pn of paramNodes) {
      if (!inRange(pn)) continue;
      const nm = identName(pn.childForFieldName('pattern'));
      if (nm) localNames.add(nm);
      const ty = normalizeTypeName((pn.childForFieldName('type') || {}).text);
      if (nm && ty && !typeOf.has(nm)) typeOf.set(nm, ty);
    }
    for (const vd of varDeclNodes) {
      if (!inRange(vd)) continue;
      const nm = identName(vd.childForFieldName('name'));
      if (!nm) continue;
      // `var isArrayLike = function (obj) {...}` IS a declaration — the extractor mints a METHOD
      // node for it — so a call to it must stay resolvable. Only a binding that holds something
      // other than a function is a local whose call target we do not model. Measured on jquery:
      // treating every local uniformly cost real call recall in exactly this shape.
      const vkind = (vd.childForFieldName('value') || {}).type;
      if (vkind !== 'function_expression' && vkind !== 'arrow_function'
          && vkind !== 'function' && vkind !== 'class' && vkind !== 'class_expression') {
        localNames.add(nm);
      }
      const declared = normalizeTypeName((vd.childForFieldName('type') || {}).text);
      if (declared) { typeOf.set(nm, declared); continue; }
      const value = vd.childForFieldName('value');
      const inferred = typeOfNode(value, returnTypeByFn);
      if (inferred) { typeOf.set(nm, inferred); continue; }
      const alias = identName(value);
      if (alias && alias !== nm) aliasOf.set(nm, alias);
    }
    // Union-find over the alias chains: `let b = a; b.run()` resolves through `a`'s type.
    const resolve = (name) => {
      let cur = name;
      for (let hops = 0; hops < 8; hops++) {
        if (typeOf.has(cur)) return typeOf.get(cur);
        if (!aliasOf.has(cur)) return null;
        cur = aliasOf.get(cur);
      }
      return null;
    };
    const owner = classEntries
      .filter((ce) => ce.startIndex <= me.startIndex && ce.endIndex >= me.endIndex)
      .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
    const fields = owner ? fieldTypeByClass.get(owner.nodeIndex) : null;
    // A function-scope binding shadows a field of the same name.
    const at = (name) => resolve(name) || (fields ? fields.get(name) || null : null);
    // `callback(...)` where `callback` is a parameter of this function calls the value passed in,
    // not some same-named declaration elsewhere in the repository. Measured on nestjs/nest: 41
    // wrong cross-file edges were bare calls to a function-typed parameter. The oracle treats
    // such a target as a `local` symbol, so refusing costs no recall.
    at.isLocalBinding = (name) => typeOf.has(name) || aliasOf.has(name) || localNames.has(name);
    return at;
  };

  const callsByOwner = groupByInnermost(callNodes, methodEntries);
  const newsByOwner = groupByInnermost(newNodes, methodEntries);
  for (const me of methodEntries) {
    const nd = nodes[me.nodeIndex];
    const bodyStartIdx = nd.line; // 0-indexed: body starts at index `line` (= 1-indexed line `line+1`), matching the regex path's convention
    const bodyEndIdx = nd.end_line; // 0-indexed exclusive === 1-indexed inclusive end_line
    // Tree-sitter is the only body scanner here: it enumerates every call site in the range
    // exactly (including tagged templates and optional calls) and carries the receiver
    // (`validationPipe.transform`, not the bare `transform`). Running a second line-regex scan
    // alongside it would record every receiver-qualified call TWICE — once resolvable by class
    // context, once as a bare name that falls through to same-file locality narrowing and binds
    // to the caller's own class (the "same-file self-preference" defect).
    const callExprs = [];
    const seenCalls = new Set();
    const typeAt = buildScopeTypes(me);
    for (const callNode of callsByOwner.get(me) || []) {
      const functionNode = callNode.childForFieldName('function');
      if (!functionNode) continue;
      const isMember = functionNode.type === 'member_expression';
      const calleeNode = isMember ? functionNode.childForFieldName('property') : functionNode;
      // `private_property_identifier` is what tree-sitter calls the property in `this.#lookup()`,
      // and omitting it here dropped the call SITE entirely — not downgraded to heuristic, gone.
      // Measured on expressjs/express + sindresorhus/got: 859 CALLS edges in the graph and ZERO
      // landing on any `#private` method, while `this.#query(...)` and `this.#lookup(...)` are
      // real call sites in got's dns-cache.ts. Private methods are idiomatic modern JS, so
      // blast_radius under-reported every class that uses one. The declaration walker (line ~3844)
      // and the assignment path (line ~3863) already knew this node type; only the call path did not.
      if (!calleeNode || !['identifier', 'property_identifier', 'private_property_identifier'].includes(calleeNode.type)) continue;
      const name = calleeNode.text;
      if (!name) continue;
      if (!isMember && typeAt.isLocalBinding(name)) continue;
      const rawReceiver = isMember ? receiverName(functionNode.childForFieldName('object')) : null;
      const flowed = rawReceiver ? typeAt(rawReceiver) : null;
      const receiver = flowed || rawReceiver;
      const callee = receiver ? `${receiver}.${name}` : name;
      const line = callNode.startPosition.row + 1;
      const key = `${callee}:${line}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      const httpHint = _httpCallHint(callee, name, contentLines[line - 1]);
      callExprs.push({ callee, line,
        ...(receiver ? { receiver, method: name } : {}),
        ...(flowed && flowed !== rawReceiver ? { receiver_expr: rawReceiver, type_flow: true } : {}),
        ...(httpHint || {}) });
    }
    for (const newNode of newsByOwner.get(me) || []) {
      const callee = ctorName(newNode.childForFieldName('constructor'));
      if (!callee || !IDENT_RE.test(callee)) continue;
      const line = newNode.startPosition.row + 1;
      const key = `${callee}:${line}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      callExprs.push({ callee, line, construction: true });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }

  // Content-derived side channels — same contract as the regex path.
  // The relative-import source node mirrors the regex tail's precedence
  // (first CLASS, else first METHOD) and indexes into THIS function's
  // nodes[], so fromIndex is always valid for the returned array.
  const lang = langForFile(filePath) || SRC_LANG;
  const relImportSource = classEntries[0] || methodEntries[0] || null;
  const relativeImportEdges = buildRelativeImportEdges(
    content, filePath, lang, relImportSource ? relImportSource.nodeIndex : null
  ).filter((edge) => !preciseRelativeTargets.has(edge.targetRelPath));
  if (relImportSource) {
    const seenTargets = new Set(relativeImportEdges.map((edge) => edge.targetRelPath));
    for (const { source } of importSources) {
      if (!source.startsWith('./') && !source.startsWith('../')) continue;
      const targetRelPath = path.normalize(path.join(path.dirname(filePath), source));
      if (preciseRelativeTargets.has(targetRelPath)) continue;
      if (seenTargets.has(targetRelPath)) continue;
      seenTargets.add(targetRelPath);
      relativeImportEdges.push({ fromIndex: relImportSource.nodeIndex, targetRelPath });
    }
  }
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, lang);

  nodes.push(...docNodes);
  nodes.push(...extractRationaleNodes(content, filePath));

  // `parseError` is not part of the seven-key contract; it is a non-enumerable diagnostic
  // so buildAstNodes can decide whether to retry a Flow-annotated .js under the
  // TypeScript grammar, without changing the shape every consumer asserts on.
  releaseTree(tree);
  const _result = { nodes, structuralEdges, inheritanceEdges, relativeImportEdges, sqlReferences, configValueRefs, importFacts };
  Object.defineProperty(_result, 'parseError', { value: parseError, enumerable: false });
  return _result;
}

// ─── C# tree-sitter extractor ─────────────────────────────────────────────────

let _csState = 'pending';
let _csParser = null;

const _csReady = (async () => {
  // The ABI-15 build is not a nicety here: the older one fails outright on files large enough
  // to exhaust its parse budget (efcore has a 360KB test file whose parse is 100% error) and on
  // C# 12's `class X : Y;` semicolon body (213 files in that repo alone).
  try {
    _csParser = await _loadWasmParserNext('c_sharp');
    _csState = 'ready';
    return;
  } catch (_) { /* fall through to the shared runtime */ }
  try {
    _csParser = await _loadWasmParser('c_sharp');
    _csState = 'ready';
  } catch (_) {
    _csState = 'failed';
  }
})();

const CS_TYPE_DECLS = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  struct_declaration: 'struct',
  record_declaration: 'record',
  record_struct_declaration: 'record',
  enum_declaration: 'enum',
  delegate_declaration: 'delegate',
};

const CS_CALLABLE_DECLS = {
  method_declaration: 'method',
  constructor_declaration: 'constructor',
  destructor_declaration: 'destructor',
  operator_declaration: 'operator',
  conversion_operator_declaration: 'operator',
  local_function_statement: 'local_function',
};

// C# attributes are `[Attribute(...)]` in an `attribute_list` child of the declaration — the
// same role Java annotations and TypeScript decorators play, and what semantic-typing.js reads
// to type an ASP.NET controller.
function csAttributes(node) {
  return node.children.filter((c) => c.type === 'attribute_list').map((c) => c.text.trim());
}

function csName(node) {
  const n = node.childForFieldName('name');
  return n ? n.text : null;
}

// The bare declared-type name a field's `field_type` text refers to: namespace qualifier,
// generic arguments, nullable `?` and array `[]` markers all stripped, so a field typed
// `IReadOnlyList<Widget>`, `Foo.Bar`, `Svc?` or `Item[]` reduces to `IReadOnlyList` / `Bar` /
// `Svc` / `Item` — the name a CLASS node carries. A container generic (`List`) simply won't
// match an in-repo class, so it resolves to nothing rather than to a wrong target.
function csBareTypeName(text) {
  if (!text) return null;
  const bare = String(text).trim().split('<')[0].replace(/[?\[\]]/g, '').trim().split('.').pop();
  return bare && /^[A-Za-z_@][\w]*$/.test(bare) ? bare : null;
}

// The declared types of a method's parameters and explicitly-typed locals, as [{name, type}] with
// bare type names — the receiver vocabulary for a call inside the method body. Two shapes carry a
// type without any flow analysis: a `parameter` (`FooService svc`) and a `variable_declaration`
// whose `type` is written out (`FooService svc = ...`); a `var` local additionally yields its type
// when the initialiser is a direct `new T(...)`. Anything needing real type inference (a `var`
// bound to a method result, a chained expression) is left out rather than guessed. Consumed by
// resolveViaReceiverType so `svc.DoWork()` binds to the parameter/local's type, not a name match.
function csMethodLocalTypes(methodNode) {
  const out = [];
  const seen = new Set();
  const add = (name, typeText) => {
    if (!name || seen.has(name)) return;
    const type = csBareTypeName(typeText);
    if (!type) return;
    seen.add(name);
    out.push({ name, type });
  };
  const stack = [methodNode];
  while (stack.length) {
    const n = stack.pop();
    for (const c of n.children) stack.push(c);
    if (n.type === 'parameter') {
      const nm = n.childForFieldName('name'); const ty = n.childForFieldName('type');
      if (nm && ty) add(nm.text, ty.text);
    } else if (n.type === 'variable_declaration') {
      const ty = n.childForFieldName('type');
      const typeText = ty ? ty.text : null;
      for (const d of n.namedChildren) {
        if (d.type !== 'variable_declarator') continue;
        const nm = d.childForFieldName('name') || d.children.find((c) => c.type === 'identifier');
        if (!nm) continue;
        if (typeText && typeText !== 'var') { add(nm.text, typeText); continue; }
        // `var x = new Foo(...)` — take the constructed type; skip any other `var` initialiser.
        const val = d.childForFieldName('value') || d.namedChildren.find((c) => c.type.endsWith('expression'));
        const created = val && val.type === 'object_creation_expression' ? val.childForFieldName('type') : null;
        if (created) add(nm.text, created.text);
      }
    }
  }
  return out;
}

function extractCSharpTreeSitter(content, filePath) {
  const tree = _csParser.parse(content);
  const root = tree.rootNode;
  const errorRatio = parseErrorRatio(root, content.length);

  const nodes = [];
  const classEntries = [];
  const memberEntries = [];
  const structuralEdges = [];
  const inheritanceEdges = [];

  const base = (node, extra) => ({
    confidence_tier: 'EXTRACTED',
    confidence: 1.0,
    line: node.startPosition.row + 1,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    extractor_tier: 'treesitter',
    _sourceFile: filePath,
    ...extra,
  });

  const pushMember = (node, nd) => {
    memberEntries.push({
      nodeIndex: nodes.length, line: nd.line, name: nd.name,
      startIndex: node.startIndex, endIndex: node.endIndex,
    });
    nodes.push(nd);
  };

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    for (const c of node.children) stack.push(c);
    const t = node.type;

    if (CS_TYPE_DECLS[t]) {
      const name = csName(node);
      if (!name) continue;
      const attrs = csAttributes(node);
      const nd = base(node, {
        node_type: 'CLASS', name, kind: CS_TYPE_DECLS[t],
        summary: `${CS_TYPE_DECLS[t]} ${name}`,
        ...(attrs.length ? { decorators: attrs } : {}),
      });
      classEntries.push({
        nodeIndex: nodes.length, line: nd.line, name,
        startIndex: node.startIndex, endIndex: node.endIndex,
      });
      const typeIndex = nodes.length;
      nodes.push(nd);

      // `: Base, IFoo` — C# does not distinguish extends from implements syntactically, so
      // every entry is EXTENDS unless it follows the `IName` interface convention. That
      // convention is near-universal in C# and is what the resolver has to work with.
      const bases = node.children.find((c) => c.type === 'base_list');
      const baseNames = [];
      for (const b of (bases ? bases.namedChildren : [])) {
        // A `generic_name` base (`IList<T>`, `Collection<Foo>`) carries its identifier as a plain
        // child, not a `name` field, so read the inner identifier/qualified_name; the `<...>`
        // type_argument_list is dropped. A non-generic base is its own node.
        const raw = (b.type === 'generic_name'
          ? b.namedChildren.find((c) => c.type === 'identifier' || c.type === 'qualified_name')
          : b);
        const toName = (raw && raw.text ? raw.text.split('.').pop() : '').trim();
        if (!toName || !/^[A-Za-z_@][\w]*$/.test(toName)) continue;
        baseNames.push(toName);
        inheritanceEdges.push({
          fromIndex: typeIndex, toName,
          edgeType: /^I[A-Z]/.test(toName) ? 'IMPLEMENTS' : 'EXTENDS',
          evidenceLine: nd.line,
        });
      }
      // Record base type names on the CLASS node so receiver-type call resolution can follow the
      // inheritance chain: a call through a receiver typed `T` whose method is declared on a base
      // of `T` (not `T` itself) resolves to the base's method. resolution/facts.js reads this into
      // classBasesByName; resolve.js#resolveViaReceiverType walks it.
      if (baseNames.length) nd.bases = baseNames;

      // A record's positional parameters declare real members, and there is no other syntax
      // that declares them — the same case as TypeScript's constructor parameter properties.
      if (t === 'record_declaration' || t === 'record_struct_declaration') {
        const plist = node.children.find((c) => c.type === 'parameter_list');
        for (const prm of (plist ? plist.namedChildren : [])) {
          if (prm.type !== 'parameter') continue;
          const pn = prm.childForFieldName('name');
          if (!pn) continue;
          const ptype = prm.childForFieldName('type');
          pushMember(prm, base(prm, {
            node_type: 'FIELD', name: pn.text, kind: 'record_parameter',
            summary: ptype ? `${pn.text}: ${ptype.text}` : pn.text,
            ...(ptype ? { field_type: ptype.text } : {}),
          }));
        }
      }
      continue;
    }

    if (CS_CALLABLE_DECLS[t]) {
      let name = csName(node);
      if (!name && t === 'operator_declaration') {
        const op = node.childForFieldName('operator');
        name = op ? `operator${op.text}` : null;
      }
      if (!name && t === 'conversion_operator_declaration') {
        // A conversion operator is identified by what it converts TO, not by an operator token
        // — `public static explicit operator int(C c)` is `operatorint`. Naming it after the
        // `operator` keyword collapses every conversion in a type onto one name; JToken alone
        // declares 68 of them.
        const target = node.childForFieldName('type')
          || node.namedChildren.find((c) => c.type.endsWith('type') || c.type === 'identifier'
            || c.type === 'nullable_type' || c.type === 'generic_name');
        name = target ? `operator${target.text.replace(/\s+/g, '')}` : null;
      }
      if (!name) continue;
      const plist = node.childForFieldName('parameters')
        || node.children.find((c) => c.type === 'parameter_list');
      const params = plist ? plist.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '';
      const attrs = csAttributes(node);
      const ret = node.childForFieldName('type');
      const localTypes = csMethodLocalTypes(node);
      pushMember(node, base(node, {
        node_type: 'METHOD', name, kind: CS_CALLABLE_DECLS[t],
        signature: `${name}(${params})`, params,
        summary: `${name}(${params})${ret ? `: ${ret.text}` : ''}`,
        ...(attrs.length ? { decorators: attrs } : {}),
        ...(localTypes.length ? { localTypes } : {}),
      }));
      continue;
    }

    if (t === 'field_declaration' || t === 'event_field_declaration') {
      const vd = node.children.find((c) => c.type === 'variable_declaration');
      if (!vd) continue;
      const vtypeNode = vd.childForFieldName('type');
      const attrs = csAttributes(node);
      for (const d of vd.namedChildren) {
        if (d.type !== 'variable_declarator') continue;
        const dn = d.childForFieldName('name') || d.children.find((c) => c.type === 'identifier');
        if (!dn) continue;
        pushMember(node, base(node, {
          node_type: 'FIELD', name: dn.text,
          kind: t === 'event_field_declaration' ? 'event' : 'field',
          summary: vtypeNode ? `${dn.text}: ${vtypeNode.text}` : dn.text,
          ...(vtypeNode ? { field_type: vtypeNode.text } : {}),
          ...(attrs.length ? { decorators: attrs } : {}),
        }));
      }
      continue;
    }

    // A property is ONE member, not a field plus two methods: `{ get; set; }` usually declares
    // no body at all, and treating the accessors as methods would double-count every property
    // in the language.
    if (t === 'property_declaration') {
      const name = csName(node);
      if (!name) continue;
      const ptype = node.childForFieldName('type');
      const attrs = csAttributes(node);
      pushMember(node, base(node, {
        node_type: 'FIELD', name, kind: 'property',
        summary: ptype ? `${name}: ${ptype.text}` : name,
        ...(ptype ? { field_type: ptype.text } : {}),
        ...(attrs.length ? { decorators: attrs } : {}),
      }));
      continue;
    }

    if (t === 'enum_member_declaration') {
      const name = csName(node);
      if (name) pushMember(node, base(node, { node_type: 'FIELD', name, kind: 'enum_member', summary: name }));
    }
  }

  const ownerOf = (entry) => classEntries
    .filter((ce) => ce.startIndex <= entry.startIndex && ce.endIndex >= entry.endIndex)
    .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];

  for (const entry of memberEntries) {
    const enclosing = ownerOf(entry);
    if (!enclosing) continue;
    nodes[entry.nodeIndex].parent_class = enclosing.name;
    structuralEdges.push({
      fromIndex: entry.nodeIndex, toIndex: enclosing.nodeIndex,
      edgeType: 'DEFINED_IN', evidenceLine: entry.line ?? null,
    });
    // Record each field/property's declared type on the owning CLASS node, so a member call
    // through that field (`_svc.DoWork()` where `private FooService _svc;`) resolves to the
    // method on the field's type rather than falling back to a branch-wide name match. Same
    // {name, type} shape base.recordClassField uses for the config-driven extractors, read by
    // resolution/facts.js into classFieldsById and consumed by resolve.js#resolveViaReceiverType.
    const member = nodes[entry.nodeIndex];
    if (member.node_type === 'FIELD' && member.field_type) {
      const typeName = csBareTypeName(member.field_type);
      if (typeName) {
        const classNode = nodes[enclosing.nodeIndex];
        if (!Array.isArray(classNode.fields)) classNode.fields = [];
        if (!classNode.fields.some((f) => f.name === member.name)) {
          classNode.fields.push({ name: member.name, type: typeName });
        }
      }
    }
  }

  const callNodes = root.descendantsOfType('invocation_expression');
  // `new Foo(...)` constructs Foo — a call to its constructor, and the most common call shape in
  // OO C# (object construction). Captured alongside method invocations, with the constructed
  // type's bare name as the callee (generics and namespace qualifier stripped, so `new List<T>()`
  // -> List and `new A.B()` -> B).
  const newNodes = root.descendantsOfType('object_creation_expression');
  const callsByOwner = groupByInnermost(callNodes, memberEntries);
  const newsByOwner = groupByInnermost(newNodes, memberEntries);
  for (const me of memberEntries) {
    const nd = nodes[me.nodeIndex];
    if (nd.node_type !== 'METHOD') continue;
    const callExprs = [];
    const seen = new Set();
    for (const callNode of callsByOwner.get(me) || []) {
      const fn = callNode.childForFieldName('function');
      if (!fn) continue;
      const calleeNode = fn.type === 'member_access_expression' ? fn.childForFieldName('name') : fn;
      if (!calleeNode || (calleeNode.type !== 'identifier' && calleeNode.type !== 'generic_name')) continue;
      const callee = calleeNode.type === 'generic_name'
        ? (calleeNode.childForFieldName('name') || {}).text : calleeNode.text;
      const line = callNode.startPosition.row + 1;
      const key = `${callee}:${line}`;
      if (!callee || seen.has(key)) continue;
      seen.add(key);
      const receiver = fn.type === 'member_access_expression'
        ? (fn.childForFieldName('expression') || {}).text : null;
      callExprs.push(receiver ? { callee, line, receiver } : { callee, line });
    }
    for (const newNode of newsByOwner.get(me) || []) {
      const typeNode = newNode.childForFieldName('type');
      const callee = typeNode ? csBareTypeName(typeNode.text) : null;
      if (!callee) continue;
      const line = newNode.startPosition.row + 1;
      const key = `${callee}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callExprs.push({ callee, line });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }

  const importFacts = [];
  for (const imp of extractImports(content, LANG.CSHARP)) {
    if (!imp.source) continue;
    importFacts.push({ name: imp.source, module: imp.source, alias: null, line: imp.line });
  }

  nodes.push(...extractRationaleNodes(content, filePath));
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, LANG.CSHARP);

  releaseTree(tree);
  const _res = {
    nodes, structuralEdges, inheritanceEdges, relativeImportEdges: [],
    sqlReferences, configValueRefs, importFacts,
  };
  Object.defineProperty(_res, 'errorRatio', { value: errorRatio, enumerable: false });
  return _res;
}

// ─── Python tree-sitter extractor ─────────────────────────────────────────────

let _pyState = 'pending';
let _pyParser = null;

const _pyReady = (async () => {
  try {
    _pyParser = await _loadWasmParser('python');
    _pyState = 'ready';
  } catch (_) {
    _pyState = 'failed';
  }
})();

function pyName(node) {
  const n = node.childForFieldName('name');
  return n && n.type === 'identifier' ? n.text : null;
}

// A `decorated_definition` wraps the decorators and the def/class it applies to, so decorators
// are siblings of neither — they are children of the wrapper.
function pyDecorators(node) {
  const parent = node.parent;
  if (!parent || parent.type !== 'decorated_definition') return [];
  return parent.children.filter((c) => c.type === 'decorator').map((c) => c.text.trim());
}

function extractPythonTreeSitter(content, filePath) {
  const tree = _pyParser.parse(content);
  const root = tree.rootNode;

  const nodes = [];
  const classEntries = [];
  const methodEntries = [];
  const fieldEntries = [];
  const structuralEdges = [];
  const inheritanceEdges = [];

  const enclosingClass = (node) => {
    let cur = node.parent;
    while (cur) {
      if (cur.type === 'class_definition') return cur;
      cur = cur.parent;
    }
    return null;
  };

  // Which plane a binding lands on is decided by SCOPE, not by syntactic nesting. `if`, `try`,
  // `with`, `for` and `while` introduce no scope in Python, so `if TYPE_CHECKING: Alias = ...`
  // and `try: import ujson except ImportError: ujson = None` bind module-level names — the
  // module really does have them. Testing the immediate parent block for `module` instead
  // dropped 398 module constants in this corpus, and they concentrate in settings and
  // compatibility modules, which is where a reader most needs them.
  const PY_SCOPES = new Set(['module', 'class_definition', 'function_definition']);
  const pyScopeOf = (node) => {
    let cur = node.parent;
    while (cur) {
      if (PY_SCOPES.has(cur.type)) return cur;
      cur = cur.parent;
    }
    return null;
  };

  // `a, b = f()` binds two names and `self.x, self.y = 0, 0` declares two attributes. Handling
  // only a bare identifier or attribute target dropped both forms entirely.
  const PY_TARGET_GROUPS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list']);
  const pyTargets = (node) => {
    if (!node) return [];
    if (node.type === 'identifier' || node.type === 'attribute') return [node];
    if (PY_TARGET_GROUPS.has(node.type)) return node.namedChildren.flatMap(pyTargets);
    if (node.type === 'list_splat_pattern' || node.type === 'list_splat') {
      return pyTargets(node.namedChildren[0]);
    }
    return [];
  };

  const base = (node, extra) => ({
    confidence_tier: 'EXTRACTED',
    confidence: 1.0,
    line: node.startPosition.row + 1,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    extractor_tier: 'treesitter',
    _sourceFile: filePath,
    ...extra,
  });

  // Python has no field declaration syntax: the declaration is the first assignment. A class
  // attribute is an assignment in the class body; an instance attribute is `self.x = ...`
  // inside one of the class's own methods, which is how essentially every Python instance
  // attribute is introduced. Both are deduped per (class, name) — one attribute assigned in
  // three methods is one attribute, not three nodes.
  const classAttrKeys = new Set();
  const selfAttrs = new Map();
  const pyDocNodes = [];

  // Module docstring: the first statement of the file.
  const modDoc = pyDocstring({ childForFieldName: () => root });
  if (modDoc) pyDocNodes.push(docNodeFor(modDoc, filePath));

  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    for (const c of node.children) stack.push(c);
    const t = node.type;

    if (t === 'class_definition') {
      const name = pyName(node);
      if (!name) continue;
      const decorators = pyDecorators(node);
      const nd = base(node, {
        node_type: 'CLASS', name, kind: 'class', summary: `class ${name}`,
        ...(decorators.length ? { decorators } : {}),
      });
      const clsDoc = pyDocstring(node);
      if (clsDoc) { nd.docstring = clsDoc.text; pyDocNodes.push(docNodeFor(clsDoc, filePath)); }
      classEntries.push({
        nodeIndex: nodes.length, line: nd.line, name, tsNode: node,
        startIndex: node.startIndex, endIndex: node.endIndex,
      });
      nodes.push(nd);

      const supers = node.childForFieldName('superclasses');
      for (const arg of supers ? supers.namedChildren : []) {
        // Keep the FULL dotted path for an attribute base (click.Group, not
        // Group): dropping the qualifier both loses the import binding and, when
        // the tail equals the subclass name, produces a self-edge. The dotted
        // external_symbol rung in resolveAndWriteEdges binds it via the imported
        // root. The regex allows dots for exactly this.
        const raw = arg.type === 'keyword_argument' ? null : arg.text;
        const toName = (raw || '').trim();
        if (toName && DOTTED_IDENT_RE.test(toName) && toName !== 'object') {
          inheritanceEdges.push({
            fromIndex: nodes.length - 1, toName, edgeType: 'EXTENDS', evidenceLine: nd.line,
          });
        }
      }
      continue;
    }

    if (t === 'function_definition') {
      const name = pyName(node);
      if (!name) continue;
      const paramsNode = node.childForFieldName('parameters');
      const params = paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '';
      const returnNode = node.childForFieldName('return_type');
      const decorators = pyDecorators(node);
      const signature = `${name}(${params})`;
      const nd = base(node, {
        node_type: 'METHOD', name, signature, params, kind: 'function',
        summary: `${signature}${returnNode ? ` -> ${returnNode.text}` : ''}`,
        ...(decorators.length ? { decorators } : {}),
      });
      const fnDoc = pyDocstring(node);
      if (fnDoc) { nd.docstring = fnDoc.text; pyDocNodes.push(docNodeFor(fnDoc, filePath)); }
      methodEntries.push({
        nodeIndex: nodes.length, line: nd.line, name,
        startIndex: node.startIndex, endIndex: node.endIndex,
      });
      nodes.push(nd);
      continue;
    }

    if (t !== 'assignment') continue;
    const left = node.childForFieldName('left');
    if (!left) continue;
    const value = node.childForFieldName('right');

    // The chain `a = b = c` parses as assignment(a, assignment(b, c)); the walk visits both,
    // and pyScopeOf climbs past the intervening `assignment` on its own.
    for (const target of pyTargets(left)) {
      if (target.type === 'identifier') {
        const name = target.text;
        if (!name || name === '_') continue;
        const scope = pyScopeOf(node);
        // A name bound inside a function body is a local, whatever its value — the rule the
        // rest of this block already applies. It sat BELOW the lambda branch, so a local
        // `factory = lambda: "lazy-value"` shipped as a METHOD while a local `factory = 3`
        // correctly shipped as nothing.
        if (!scope || scope.type === 'function_definition') continue;
        // Only a whole-target lambda declares a callable. An element of a tuple unpack has no
        // single value to inspect, so it cannot be one.
        if (left.type === 'identifier' && value && value.type === 'lambda') {
          const lp = value.childForFieldName('parameters');
          const params = lp ? lp.text.replace(/\s+/g, ' ').trim() : '';
          const nd = base(node, {
            node_type: 'METHOD', name, signature: `${name}(${params})`, params,
            kind: 'lambda_fn', summary: `${name}(${params})`,
          });
          methodEntries.push({
            nodeIndex: nodes.length, line: nd.line, name,
            startIndex: node.startIndex, endIndex: node.endIndex,
          });
          nodes.push(nd);
          continue;
        }
        // One node per (scope, name). A module constant bound in both arms of an if/else or a
        // try/except is one declaration — click writes BEFORE_BAR twice and requests writes
        // is_urllib3_1 twice — and the second node is a duplicate a name-keyed lookup then has
        // to disambiguate. Class attributes have been deduped this way since they were
        // written; module constants were not, and shared the same key space all along.
        const key = `${scope.startIndex}\0${name}`;
        if (classAttrKeys.has(key)) continue;
        classAttrKeys.add(key);
        if (scope.type === 'module') {
          // `__all__` is a re-export list, not a constant declaration — both referees skip it,
          // and so must this, or every package `__init__.py` reports a spurious constant.
          if (name !== '__all__') {
            nodes.push(base(node, { node_type: 'CONSTANT', name, kind: 'module_constant', summary: name }));
          }
          continue;
        }
        const ann = left.type === 'identifier' ? node.childForFieldName('type') : null;
        const nd = base(node, {
          node_type: 'FIELD', name, kind: 'class_attribute',
          summary: ann ? `${name}: ${ann.text}` : name,
          ...(ann ? { field_type: ann.text } : {}),
        });
        fieldEntries.push({
          nodeIndex: nodes.length, line: nd.line, name,
          startIndex: node.startIndex, endIndex: node.endIndex,
        });
        nodes.push(nd);
        continue;
      }

      const obj = target.childForFieldName('object');
      const attr = target.childForFieldName('attribute');
      if (!obj || !attr || obj.type !== 'identifier' || obj.text !== 'self') continue;
      const cls = enclosingClass(node);
      if (!cls || !attr.text) continue;
      const key = `${cls.startIndex}\0${attr.text}`;
      if (selfAttrs.has(key) || classAttrKeys.has(key)) continue;
      selfAttrs.set(key, { node, name: attr.text });
    }
  }

  // Emitted after the walk so a class-body attribute always wins over a `self.` one of the
  // same name — the class body is the declaration when both exist.
  for (const [key, { node, name }] of selfAttrs) {
    if (classAttrKeys.has(key)) continue;
    const nd = base(node, { node_type: 'FIELD', name, kind: 'instance_attribute', summary: name });
    fieldEntries.push({
      nodeIndex: nodes.length, line: nd.line, name,
      startIndex: node.startIndex, endIndex: node.endIndex,
    });
    nodes.push(nd);
  }

  const ownerOf = (entry) => classEntries
    .filter((ce) => ce.startIndex <= entry.startIndex && ce.endIndex >= entry.endIndex)
    .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];

  for (const entry of [...methodEntries, ...fieldEntries]) {
    const enclosing = ownerOf(entry);
    if (!enclosing) continue;
    nodes[entry.nodeIndex].parent_class = enclosing.name;
    structuralEdges.push({
      fromIndex: entry.nodeIndex, toIndex: enclosing.nodeIndex,
      edgeType: 'DEFINED_IN', evidenceLine: entry.line ?? null,
    });
  }

  const contentLines = content.split('\n');
  const callNodes = root.descendantsOfType('call');
  const callOwnerIndex = new Map();
  for (const [me, owned] of groupByInnermost(callNodes, methodEntries)) {
    for (const callNode of owned) callOwnerIndex.set(callNode, me.nodeIndex);
  }
  for (const me of methodEntries) {
    const nd = nodes[me.nodeIndex];
    const callExprs = [];
    const seenCalls = new Set();
    for (const callNode of callNodes) {
      if (callOwnerIndex.get(callNode) !== me.nodeIndex) continue;
      const fn = callNode.childForFieldName('function');
      if (!fn) continue;
      const calleeNode = fn.type === 'attribute' ? fn.childForFieldName('attribute') : fn;
      if (!calleeNode || calleeNode.type !== 'identifier') continue;
      const callee = calleeNode.text;
      const line = callNode.startPosition.row + 1;
      const key = `${callee}:${line}`;
      if (!callee || seenCalls.has(key)) continue;
      seenCalls.add(key);
      const receiver = fn.type === 'attribute' ? fn.childForFieldName('object')?.text : null;
      callExprs.push(receiver ? { callee, line, receiver } : { callee, line });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }
  void contentLines;

  const importFacts = [];
  for (const imp of extractImports(content, LANG.PYTHON)) {
    if (!imp.source) continue;
    if (Array.isArray(imp.bindings) && imp.bindings.length > 0) {
      for (const b of imp.bindings) importFacts.push({ name: b.name, module: imp.source, alias: b.alias, line: imp.line });
    } else {
      // `import typing as t` carries its alias on imp.alias; dropping it left `t`
      // unbound, so `class X(t.NamedTuple)` could not resolve its base.
      importFacts.push({ name: imp.source, module: imp.source, alias: imp.alias || null, line: imp.line });
    }
  }

  const relImportSource = classEntries[0] || methodEntries[0] || null;
  const relativeImportEdges = buildRelativeImportEdges(
    content, filePath, LANG.PYTHON, relImportSource ? relImportSource.nodeIndex : null
  );
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, LANG.PYTHON);
  nodes.push(...pyDocNodes);
  nodes.push(...extractRationaleNodes(content, filePath));

  releaseTree(tree);
  return { nodes, structuralEdges, inheritanceEdges, relativeImportEdges, sqlReferences, configValueRefs, importFacts };
}

// ─── C / C++ tree-sitter extractor ────────────────────────────────────────────
//
// Two grammars, one plane. C++ is not a superset of C in either grammar and each errors on
// the other's idioms — measured on this corpus, tree-sitter-c errors on 122 of leveldb's 132
// `.cc`/`.h` files where tree-sitter-cpp errors on 33, and the numbers reverse on curl's `.c`.
// So `.c` is parsed with C, everything else with C++, and a `.h` — which is whichever language
// its project writes — is parsed with C++ and re-parsed with C if C++ errors, keeping the
// cleaner tree. That is the same degraded-parse ladder the JavaScript path uses for Flow.
//
// Two rules that are easy to get wrong:
//
//   • A prototype is a declaration. `int foo(int);` in a header is where a C library's API
//     lives, and a graph that indexes only definitions cannot answer "what does this header
//     expose". A header prototype and its `.c` definition are separate nodes in separate files.
//   • A function POINTER member is a field, not a method. `int (*cb)(void);` wraps its
//     function_declarator inside a parenthesized_declarator; that parenthesis is the only
//     thing distinguishing it from a prototype, and getting it wrong turns every callback
//     table in redis into methods.

let _cState = 'pending';
let _cParser = null;
let _cppState = 'pending';
let _cppParser = null;

const _cReady = (async () => {
  try {
    _cParser = await _loadWasmParser('c');
    _cState = 'ready';
  } catch (_) {
    _cState = 'failed';
  }
})();

const _cppReady = (async () => {
  try {
    _cppParser = await _loadWasmParser('cpp');
    _cppState = 'ready';
  } catch (_) {
    _cppState = 'failed';
  }
})();

const C_TYPE_SPECIFIERS = {
  struct_specifier: 'struct',
  union_specifier: 'union',
  enum_specifier: 'enum',
  class_specifier: 'class',
};

const C_DECLARATOR_CHAIN = new Set([
  'pointer_declarator', 'array_declarator', 'reference_declarator',
  'parenthesized_declarator', 'init_declarator', 'attributed_declarator',
]);

// `primitive_type` belongs here too: the C/C++ grammar lexes a fixed list of standard-library
// typedef spellings (`ssize_t`, `size_t`, `ptrdiff_t`, `intptr_t`, `uintptr_t`, every `intN_t`/
// `uintN_t`, `max_align_t`, ...) as `primitive_type` tokens unconditionally, including when that
// exact spelling sits in DECLARATOR position — i.e. when it is the name being introduced, not a
// type being referenced. `typedef intptr_t ssize_t;` parses with `ssize_t` as the type_definition's
// `declarator` field, but that field's node type is `primitive_type`, not `type_identifier` — so
// it silently failed this name check and the typedef vanished with no error, no matter what line
// it was on. A `primitive_type` only ever reaches this position via a `declarator` field; a real
// type usage occupies the `type` field instead, so there is no ambiguity to trade off.
const C_NAME_NODES = new Set([
  'identifier', 'field_identifier', 'type_identifier', 'destructor_name',
  'operator_name', 'qualified_identifier', 'primitive_type',
]);

// `struct DBImpl::CompactionState` and `struct SkipList<K,C>::Node` define a nested type out
// of line; the declared name is the last component, which is what both referees report.
function cTypeName(node) {
  if (!node) return null;
  if (node.type === 'qualified_identifier' || node.type === 'template_type') {
    const n = node.childForFieldName('name');
    if (n) return cTypeName(n);
    const last = [...node.namedChildren].reverse()
      .find((c) => c.type === 'type_identifier' || c.type === 'identifier');
    return last ? last.text : node.text;
  }
  return node.text;
}

// `class LEVELDB_EXPORT Cache { ... }` — a visibility macro between the keyword and the name —
// defeats the grammar completely: it yields a BODYLESS class_specifier named after the macro,
// a loose identifier holding the real name, and the class body re-read as a function body. The
// class, and every member in it, is lost. leveldb, curl and googletest all write their public
// API this way. Returns {kind, nameNode, bodyNode} when a function_definition has that shape.
function cMacroClassShape(node) {
  const kids = node.namedChildren;
  if (kids.length < 3) return null;
  const spec = kids[0];
  if (!C_TYPE_SPECIFIERS[spec.type] || spec.childForFieldName('body')) return null;
  // A base-class clause lands between the name and the body as a loose ERROR node
  // (`class GTEST_API_ TestSuite : public Base {`), so the pieces are searched for rather than
  // read off fixed positions — requiring them to be adjacent cost googletest 149 prototypes in
  // one header.
  const nameNode = kids.slice(1).find((c) => c.type === 'identifier');
  if (!nameNode) return null;
  const bodyNode = kids.find((c) => c.type === 'compound_statement'
    && c.startIndex > nameNode.startIndex);
  if (!bodyNode) return null;
  return { kind: C_TYPE_SPECIFIERS[spec.type], nameNode, bodyNode };
}

function cDeclaratorName(node) {
  let cur = node;
  for (let i = 0; cur && i < 24; i++) {
    if (C_NAME_NODES.has(cur.type)) {
      if (cur.type === 'qualified_identifier') {
        const inner = cur.childForFieldName('name');
        if (inner) return cDeclaratorName(inner);
        // An unexpanded macro in the type position collapses the return type and the function
        // name into one degenerate `qualified_identifier` — `GTEST_API_ AssertionResult
        // CmpHelperSTREQ(...)` yields the node text `AssertionResult CmpHelperSTREQ`. The
        // declared name is the last component.
        const last = [...cur.namedChildren].reverse()
          .find((c) => C_NAME_NODES.has(c.type) || c.type === 'namespace_identifier');
        if (last) return cDeclaratorName(last);
        const parts = cur.text.split(/[\s:]+/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : cur.text;
      }
      return cur.text;
    }
    let nxt = cur.childForFieldName('declarator');
    if (!nxt) {
      nxt = cur.namedChildren.find((c) => C_DECLARATOR_CHAIN.has(c.type)
        || C_NAME_NODES.has(c.type) || c.type === 'function_declarator');
    }
    cur = nxt;
  }
  return null;
}

function cFunctionDeclarator(node) {
  let cur = node.childForFieldName('declarator');
  if (!cur) {
    cur = node.namedChildren.find((c) => C_DECLARATOR_CHAIN.has(c.type)
      || c.type === 'function_declarator');
  }
  for (let i = 0; cur && i < 24; i++) {
    if (cur.type === 'function_declarator') {
      const inner = cur.childForFieldName('declarator');
      return inner && inner.type === 'parenthesized_declarator' ? null : cur;
    }
    if (cur.type === 'parenthesized_declarator') return null;
    cur = cur.childForFieldName('declarator');
  }
  // The declarator chain breaks whenever an unexpanded macro sits in the type position:
  // `LEVELDB_EXPORT const Comparator* BytewiseComparator();` parses its whole tail as one
  // `qualified_identifier` in one context and as a `pointer_declarator` in another, and the
  // chain walk finds nothing in the first. Fall back to the subtree — still refusing anything
  // inside a parameter list (a function-pointer parameter) or a parenthesized declarator (a
  // function-pointer member).
  for (const fd of node.descendantsOfType('function_declarator')) {
    let bad = false;
    for (let a = fd.parent; a && a !== node; a = a.parent) {
      if (a.type === 'parameter_list' || a.type === 'parenthesized_declarator') { bad = true; break; }
    }
    if (!bad) return fd;
  }
  return null;
}

function cParams(fnDecl) {
  const p = fnDecl ? fnDecl.childForFieldName('parameters') : null;
  return p ? p.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '';
}

// Blank every preprocessor directive, continuations included, preserving line count and
// length. A `#define` body is not C++ and the grammar has no way to know it: nlohmann's
// `#define NLOHMANN_JSON_NAMESPACE_END  } }` closes two braces that were never opened, and
// that one macro puts 74% of its 25,000-line amalgamated header inside an ERROR node.
//
// This is not universally better and is not applied universally — measured, it takes
// json.hpp from 74.1% error to 3.2% and redis's server.h from 0.02% to 7.9%, because
// `#if`-guarded members do carry structure. So the two parses are MERGED rather than chosen
// between, exactly as the C# plane merges its degraded planes: the raw parse contributes the
// macro plane (which vanishes when directives are blanked) and the directive-free parse
// contributes the declarations the braces had swallowed.
function maskPreprocessorDirectives(source) {
  const lines = source.split('\n');
  let continuing = false;
  for (let i = 0; i < lines.length; i++) {
    const isDirective = continuing || /^[ \t]*#/.test(lines[i]);
    const endsWithContinuation = /\\[ \t\r]*$/.test(lines[i]);
    if (isDirective) lines[i] = lines[i].replace(/[^\r]/g, ' ');
    continuing = isDirective && endsWithContinuation;
  }
  return lines.join('\n');
}

// The visibility macro that defeats the grammar (`class GTEST_API_ UnitTest { ... }`) is an
// ordinary identifier, so it can simply be blanked and the file re-parsed — after which the
// class parses natively, with a real `field_declaration_list`, and every constructor,
// destructor, overload and member in it is read by the normal path. That is strictly better
// than recovering members out of the mis-parse: the recovery could not see a destructor at
// all, because in a body the grammar thinks is a function body, `~Foo();` is not a
// declaration. Returns null when the file has no such class.
// `reuseTree` is the tree the caller already has for exactly this content and this parser.
// Without it this function parsed the file a SECOND time purely to locate macro spans, and it
// runs on every C and C++ file — a full redundant parse of the whole corpus. Passing null keeps
// the old behaviour for the one case where the caller's tree came from a different grammar (a
// `.h` where the C parse beat the C++ one).
function maskClassExportMacros(content, parser, reuseTree = null) {
  const tree = reuseTree || parser.parse(content);
  const spans = [];
  for (const fd of tree.rootNode.descendantsOfType('function_definition')) {
    const shape = cMacroClassShape(fd);
    if (!shape) continue;
    const spec = fd.namedChildren[0];
    const macro = spec.namedChildren.find((c) => c.type === 'type_identifier');
    if (macro) spans.push([macro.startIndex, macro.endIndex]);
  }
  if (!reuseTree) releaseTree(tree);
  if (!spans.length) return null;
  const out = content.split('');
  for (const [a, b] of spans) for (let i = a; i < b; i++) out[i] = ' ';
  return out.join('');
}

// `keepTree` hands the caller the parse tree instead of releasing it, so the very next step —
// locating class-export macro spans — does not have to parse the identical bytes again. The
// caller owns the tree and must release it.
function extractCTreeSitter(content, filePath, parser, keepTree = false) {
  const tree = parser.parse(content);
  const root = tree.rootNode;
  const errorRatio = parseErrorRatio(root, content.length);
  // A struct member at FILE scope is impossible, so its presence means the grammar has lost
  // the file's brace structure entirely — which is what an unbalanced `#define` body does to
  // it, with no ERROR node to show for it. libuv's uv.h parses its whole second half as
  // struct members this way, and error ratio alone reports the file as clean.
  const looseFieldCount = root.children.filter((c) => c.type === 'field_declaration').length;

  const nodes = [];
  const typeEntries = [];
  const memberEntries = [];
  const structuralEdges = [];
  const inheritanceEdges = [];

  const base = (node, extra) => ({
    confidence_tier: 'EXTRACTED',
    confidence: 1.0,
    line: node.startPosition.row + 1,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    extractor_tier: 'treesitter',
    _sourceFile: filePath,
    ...extra,
  });

  const pushType = (node, nd) => {
    typeEntries.push({
      nodeIndex: nodes.length, name: nd.name,
      startIndex: node.startIndex, endIndex: node.endIndex,
    });
    nodes.push(nd);
  };

  const pushMember = (node, nd) => {
    memberEntries.push({
      nodeIndex: nodes.length, line: nd.line, name: nd.name,
      startIndex: node.startIndex, endIndex: node.endIndex,
    });
    nodes.push(nd);
  };

  // Pre-pass: recover the macro-shaped class definitions the grammar cannot see, and record
  // their body spans so the members inside them are read as members rather than as locals.
  const macroClassBodies = [];
  for (const fd of root.descendantsOfType('function_definition')) {
    const shape = cMacroClassShape(fd);
    if (!shape) continue;
    macroClassBodies.push({ startIndex: shape.bodyNode.startIndex, endIndex: shape.bodyNode.endIndex, name: shape.nameNode.text });
    pushType(fd, base(fd, {
      node_type: 'CLASS', name: shape.nameNode.text, kind: shape.kind,
      summary: `${shape.kind} ${shape.nameNode.text}`,
    }));
  }
  const inRecoveredClassBody = (node) => macroClassBodies.some(
    (b) => b.startIndex <= node.startIndex && b.endIndex >= node.endIndex);

  // Directly in a recovered class body, or directly under one of its `public:` labels — NOT
  // anywhere inside it. An inline member's own body sits inside the recovered body too, and
  // every call in it would otherwise be recovered as a member declaration.
  const isRecoveredClassMember = (node) => {
    let cur = node.parent;
    if (cur && cur.type === 'labeled_statement') cur = cur.parent;
    return !!cur && cur.type === 'compound_statement' && macroClassBodies.some(
      (b) => b.startIndex === cur.startIndex && b.endIndex === cur.endIndex);
  };

  // A declaration inside a function body is a local, not a declaration of the program — the
  // same rule every other language here applies. It matters more in C++ than anywhere else
  // because `Slice key_sizes(a, b);` is syntactically a function prototype (the most vexing
  // parse) and the grammar reads it as one.
  const inFunctionBody = (node) => {
    for (let cur = node.parent; cur; cur = cur.parent) {
      // A class body reached BEFORE any function body means this is a member declaration,
      // whatever encloses the class. Checking `function_definition` first was wrong and cost
      // nlohmann-json 90% of its member declarations: an export-macro class, or any parse the
      // grammar degrades, nests the whole class inside a function_definition, and every
      // member in it was then discarded as a local.
      if (cur.type === 'field_declaration_list' || C_TYPE_SPECIFIERS[cur.type]) return false;
      if (cur.type === 'compound_statement') return !inRecoveredClassBody(cur);
      if (cur.type === 'function_definition') return true;
    }
    return false;
  };

  // A macro BODY is not a declaration — it is text that becomes one only where the macro is
  // invoked. libuv writes its handle layouts as `#define UV_HANDLE_FIELDS ...` and the fields
  // inside them are not declared anywhere; emitting them put 89 members into uv.h that no
  // referee agrees exist. The macro's own name is still emitted, from the preproc node itself.
  // ...and the ancestry test is not enough. On a body as large as libuv's
  // `#define UV_LOOP_PRIVATE_FIELDS` the grammar abandons the directive and parses its
  // continuation lines as ordinary declarations at file scope, with no preproc ancestor at
  // all — which is where uv.h's 89 phantom struct members came from. So the lines a directive
  // occupies are computed lexically as well, and a declaration on one of them is skipped.
  const directiveLine = (() => {
    const lines = content.split('\n');
    const flags = new Array(lines.length + 2).fill(false);
    let continuing = false;
    for (let i = 0; i < lines.length; i++) {
      const isDirective = continuing || /^[ \t]*#/.test(lines[i]);
      flags[i + 1] = isDirective;
      continuing = isDirective && /\\[ \t\r]*$/.test(lines[i]);
    }
    return flags;
  })();

  // "Is any ancestor a macro definition" is a property of the DESCENT, not of the node, so it is
  // carried down the stack rather than re-derived. Deriving it per node walked the whole ancestor
  // chain through `.parent`, and every one of those crossed the JS/WASM boundary and materialised
  // a node object: on leveldb's db_bench.cc that single predicate was **74.6% of all C/C++
  // extraction time**.
  // O(nodes x depth) becomes O(nodes), with the same answer.
  const isMacroDef = (t) => t === 'preproc_def' || t === 'preproc_function_def';

  const stack = [[root, false]];
  while (stack.length) {
    const [node, ancestorIsMacro] = stack.pop();
    const t = node.type;
    const childInMacro = ancestorIsMacro || isMacroDef(t);
    for (const c of node.children) stack.push([c, childInMacro]);

    if (t === 'function_definition' && cMacroClassShape(node)) continue;
    // Same predicate as before: the node's own line being a directive, or an ancestor being a
    // macro definition. A macro definition node itself is never skipped.
    if (!isMacroDef(t)
        && (directiveLine[node.startPosition.row + 1] || ancestorIsMacro)) continue;

    if (C_TYPE_SPECIFIERS[t]) {
      const body = node.childForFieldName('body');
      const n = node.childForFieldName('name');
      // No body is a forward declaration of an incomplete type, and it is nearly always
      // followed by the real definition — counting both would double one declaration.
      if (!body || !n) continue;
      const typeName = cTypeName(n);
      if (!typeName) continue;
      const nd = base(node, {
        node_type: 'CLASS', name: typeName, kind: C_TYPE_SPECIFIERS[t],
        summary: `${C_TYPE_SPECIFIERS[t]} ${typeName}`,
      });
      const bases = node.namedChildren.find((c) => c.type === 'base_class_clause');
      if (bases) {
        for (const b of bases.namedChildren) {
          if (b.type === 'type_identifier' || b.type === 'qualified_identifier') {
            inheritanceEdges.push({
              fromIndex: nodes.length, toName: b.text, edgeType: 'EXTENDS',
            });
          }
        }
      }
      pushType(node, nd);
      continue;
    }

    if (t === 'type_definition') {
      for (const d of node.childrenForFieldName('declarator')) {
        const nm = cDeclaratorName(d);
        if (nm) pushType(node, base(node, { node_type: 'CLASS', name: nm, kind: 'typedef', summary: `typedef ${nm}` }));
      }
      continue;
    }

    if (t === 'alias_declaration') {
      const n = node.childForFieldName('name');
      if (n) pushType(node, base(node, { node_type: 'CLASS', name: n.text, kind: 'alias', summary: `using ${n.text}` }));
      continue;
    }

    if (t === 'function_definition') {
      const fn = cFunctionDeclarator(node);
      // A function defined THROUGH a macro — `TEST_IMPL(fs_file_noent) { ... }`, which is how
      // libuv declares all 634 of its tests and benchmarks — has no return type and no
      // function_declarator: the grammar reads the macro name as the type and `(name)` as a
      // parenthesized declarator. The declaration is real, and both referees that can see it
      // name it after the macro.
      let nm = fn ? cDeclaratorName(fn) : null;
      if (!nm) {
        const decl = node.childForFieldName('declarator');
        const typeNode = node.childForFieldName('type');
        // The argument may be an identifier (`TEST_IMPL(fs_file_noent)`) or a string
        // (`TEST_CASE("parsing")`, which is how doctest and Catch declare every test), but NOT
        // a number: `JSON_HEDLEY_NON_NULL(3) static void f() { ... }` is an attribute macro in
        // front of a real definition, and reading it as the definition both invents
        // `JSON_HEDLEY_NON_NULL` and loses `f`.
        const macroArgOk = decl && decl.namedChildren.length > 0
          && decl.namedChildren.every((c) => c.type === 'identifier' || c.type === 'string_literal'
            || c.type === 'concatenated_string');
        if (decl && decl.type === 'parenthesized_declarator' && typeNode
            && typeNode.type === 'type_identifier' && macroArgOk) {
          nm = typeNode.text;
        }
      }
      // No C function is named `if` or `switch`. When the grammar's error recovery reads
      // `} else if (cond) {` as a definition — redis's config.c does this 25 times — the name
      // it invents is always a control keyword, so refusing them costs nothing real.
      if (nm && CALL_EXPR_KEYWORDS.has(nm)) nm = null;
      if (nm) {
        const params = cParams(fn);
        pushMember(node, base(node, {
          node_type: 'METHOD', name: nm, params, signature: `${nm}(${params})`,
          kind: 'function_definition', summary: `${nm}(${params})`,
        }));
      }
      continue;
    }

    if (t === 'declaration' || t === 'field_declaration') {
      if (t === 'declaration' && inFunctionBody(node)) continue;
      const fn = cFunctionDeclarator(node);
      if (fn) {
        const nm = cDeclaratorName(fn);
        // A declaration with NO return type is a macro invocation, not a prototype:
        // `NLOHMANN_DEFINE_TYPE_INTRUSIVE(person, name, age);` at class scope is a call, and
        // C++ has no untyped function declaration. The exceptions are a constructor and a
        // destructor, which are named after their class.
        const ownerName = (() => {
          for (let cur = node.parent; cur; cur = cur.parent) {
            if (C_TYPE_SPECIFIERS[cur.type]) {
              const cn = cur.childForFieldName('name');
              return cn ? cTypeName(cn) : null;
            }
            // A macro-recovered class has no class_specifier ancestor — the type node is
            // synthetic — so its constructors have to find their owner through the body span.
            // Without this, `GTEST_API_`-exported classes lost every constructor they declare.
            const rec = macroClassBodies.find(
              (b) => b.startIndex <= cur.startIndex && b.endIndex >= cur.endIndex);
            if (rec) return rec.name;
          }
          return null;
        })();
        // "Untyped" has to mean no type TOKEN, not an unset `type` field: an unexpanded macro
        // in the type position (`CURL_EXTERN CURLcode curl_easy_setopt(...)`) leaves the field
        // unset while the tokens are plainly there, and testing the field alone dropped a
        // quarter of curl's prototypes.
        const TYPEISH = new Set(['type_identifier', 'primitive_type', 'sized_type_specifier',
          'qualified_identifier', 'type_qualifier', 'storage_class_specifier',
          'struct_specifier', 'union_specifier', 'enum_specifier', 'template_type',
          'placeholder_type_specifier', 'virtual', 'virtual_specifier', 'decltype']);
        const untyped = !node.childForFieldName('type')
          && !node.namedChildren.some((c) => c.startIndex < fn.startIndex && TYPEISH.has(c.type));
        if (untyped && nm && nm !== ownerName && !nm.startsWith('~')) continue;
        if (nm) {
          const params = cParams(fn);
          pushMember(node, base(node, {
            node_type: 'METHOD', name: nm, params, signature: `${nm}(${params})`,
            kind: 'function_declaration', summary: `${nm}(${params})`,
          }));
        }
        continue;
      }
      // A file-scope variable is not a declaration under this taxonomy; a struct member is,
      // including one inside a class body the pre-pass recovered.
      if (t !== 'field_declaration' && !isRecoveredClassMember(node)) continue;
      const typeNode = node.childForFieldName('type');
      for (const d of node.childrenForFieldName('declarator')) {
        const nm = cDeclaratorName(d);
        if (!nm) continue;
        pushMember(node, base(node, {
          node_type: 'FIELD', name: nm, kind: 'member',
          summary: typeNode ? `${nm}: ${typeNode.text}` : nm,
          ...(typeNode ? { field_type: typeNode.text } : {}),
        }));
      }
      continue;
    }

    // Inside a class body the grammar mistook for a function body, a constructor reads as an
    // expression statement (`Cache() = default;` is an assignment to a call) and a destructor
    // reads as an ERROR wrapping a function_declarator. Neither is a `declaration`, so both
    // were lost — and a class's constructors are the half of its API a graph most needs.
    // A bare call statement cannot legally occur in a class body, so this is safe here and
    // is not applied anywhere else.
    if ((t === 'ERROR' || t === 'expression_statement') && isRecoveredClassMember(node)) {
      const fd = node.descendantsOfType('function_declarator')[0];
      const nm = fd ? cDeclaratorName(fd) : null;
      if (nm) {
        const params = cParams(fd);
        pushMember(node, base(node, {
          node_type: 'METHOD', name: nm, params, signature: `${nm}(${params})`,
          kind: 'function_declaration', summary: `${nm}(${params})`,
        }));
        continue;
      }
      const call = node.descendantsOfType('call_expression')[0];
      const fnNode = call ? call.childForFieldName('function') : null;
      if (fnNode && (fnNode.type === 'identifier' || fnNode.type === 'destructor_name'
        || fnNode.type === 'field_identifier')) {
        const args = call.childForFieldName('arguments');
        const params = args ? args.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '';
        pushMember(node, base(node, {
          node_type: 'METHOD', name: fnNode.text, params,
          signature: `${fnNode.text}(${params})`,
          kind: 'function_declaration', summary: `${fnNode.text}(${params})`,
        }));
      }
      continue;
    }

    if (t === 'enumerator') {
      const n = node.childForFieldName('name');
      if (n) {
        pushMember(node, base(node, { node_type: 'FIELD', name: n.text, kind: 'enumerator', summary: n.text }));
      }
      continue;
    }

    if (t === 'preproc_def') {
      const n = node.childForFieldName('name');
      if (n) nodes.push(base(node, { node_type: 'CONSTANT', name: n.text, kind: 'macro', summary: n.text }));
      continue;
    }

    if (t === 'preproc_function_def') {
      const n = node.childForFieldName('name');
      if (!n) continue;
      const p = node.childForFieldName('parameters');
      const params = p ? p.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' ').trim() : '';
      nodes.push(base(node, {
        node_type: 'METHOD', name: n.text, params, signature: `${n.text}(${params})`,
        kind: 'function_macro', summary: `${n.text}(${params})`,
      }));
    }
  }

  // Innermost enclosing type by span, the same containment rule the Java and C# planes use.
  const ownerOf = (entry) => typeEntries
    .filter((te) => te.startIndex <= entry.startIndex && te.endIndex >= entry.endIndex)
    .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];

  for (const entry of memberEntries) {
    const enclosing = ownerOf(entry);
    if (!enclosing) continue;
    nodes[entry.nodeIndex].parent_class = enclosing.name;
    structuralEdges.push({
      fromIndex: entry.nodeIndex, toIndex: enclosing.nodeIndex,
      edgeType: 'DEFINED_IN', evidenceLine: entry.line ?? null,
    });
  }

  const callNodes = root.descendantsOfType('call_expression');
  const callsByOwner = groupByInnermost(callNodes, memberEntries);
  for (const me of memberEntries) {
    const nd = nodes[me.nodeIndex];
    if (nd.node_type !== 'METHOD') continue;
    const callExprs = [];
    const seen = new Set();
    for (const callNode of callsByOwner.get(me) || []) {
      const fn = callNode.childForFieldName('function');
      if (!fn) continue;
      let callee = null;
      let receiver = null;
      if (fn.type === 'identifier') {
        callee = fn.text;
      } else if (fn.type === 'field_expression') {
        callee = fn.childForFieldName('field')?.text || null;
        receiver = fn.childForFieldName('argument')?.text || null;
      } else if (fn.type === 'qualified_identifier') {
        callee = fn.childForFieldName('name')?.text || null;
        receiver = fn.childForFieldName('scope')?.text || null;
      }
      if (!callee) continue;
      const line = callNode.startPosition.row + 1;
      const key = `${callee}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callExprs.push(receiver ? { callee, line, receiver } : { callee, line });
    }
    if (callExprs.length > 0) nd.callExpressions = callExprs;
  }

  const importFacts = [];
  for (const inc of root.descendantsOfType('preproc_include')) {
    const p = inc.childForFieldName('path');
    if (!p) continue;
    const mod = p.text.replace(/^[<"]|[>"]$/g, '');
    importFacts.push({ name: mod, module: mod, alias: null, line: inc.startPosition.row + 1 });
  }

  nodes.push(...extractRationaleNodes(content, filePath));

  if (!keepTree) releaseTree(tree);
  return {
    nodes, structuralEdges, inheritanceEdges, relativeImportEdges: [],
    sqlReferences: [], configValueRefs: [], importFacts, errorRatio, looseFieldCount,
    ...(keepTree ? { _tree: tree } : {}),
  };
}

// ─── C / C++ regex scanner (degraded-parse partner only) ──────────────────────
//
// tree-sitter-cpp gives up on real C++ that no amount of pre-masking fixes: a dependent
// typedef (`typedef typename internal::Function<F>::Result Result;`) and a function-pointer
// typedef each put thousands of bytes of gmock-actions.h inside an ERROR node, and nlohmann's
// amalgamated header is 74% error before directives are blanked. This is the same situation
// the C# plane hit on efcore, and the same answer: keep a scanner that keeps finding
// declarations after the grammar has stopped, and MERGE the two planes rather than choosing.
// It never runs on a clean parse.
//
// Brace blocks are classified as type-bodies or function-bodies as they are opened, which is
// what separates a member from a local and a prototype from a call.

const C_RX_KEYWORD = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'do', 'else', 'case',
  'defined', 'static_assert', 'assert', 'typeof', 'alignof', 'decltype', 'noexcept',
  'and', 'or', 'not', 'new', 'delete', 'throw', 'template', 'operator',
]);

const C_RX_BLOCK_INTRO = /\b(class|struct|union|enum|namespace)\b|extern\s*"C(\+\+)?"/;
const C_RX_TYPE_HEAD = /\b(struct|union|enum|class)\s+(?:\[\[[^\]]*\]\]\s*)?(?:[A-Z_][A-Z0-9_]{2,}\s+)?([A-Za-z_]\w*)\b[^;{()]*\{/;
const C_RX_TYPEDEF_SIMPLE = /^\s*typedef\b[^;]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/;
const C_RX_TYPEDEF_FNPTR = /^\s*typedef\b[^;]*\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/;
const C_RX_DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)(\()?/;
// The tail is `;` or `{` but NOT anchored to end-of-line: a one-line definition
// (`int f(void) { return 0; }`) is ordinary in a header, and requiring the brace to close the
// line found none of them. What keeps a call out is the head test and looksLikeParameterList,
// not the tail.
const C_RX_FUNC = /^[\s\S]*?(?:^|[\s*&:>])([A-Za-z_~]\w*)\s*\(([\s\S]*?)\)\s*(?:const\b|volatile\b|noexcept\b|override\b|final\b|throw\s*\([^)]*\)|->[^;{]*|=\s*0|=\s*default|=\s*delete|[A-Z_][A-Z0-9_]*(?:\([^)]*\))?|\s)*[;{]/;
const C_RX_MEMBER = /^\s*(?:(?:static|mutable|const|volatile|constexpr|inline|unsigned|signed|struct|union|enum|typename)\s+)*[A-Za-z_][\w:<>,\s*&]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?::\s*\d+\s*)?(?:=[^;]*)?;\s*$/;

// Comment bodies and string/char literal contents blanked, newlines and length preserved.
// The SQL masker was reused here at first and is wrong for C twice over: it does not know
// `//`, and it treats a leading `#` as a MySQL comment — which blanked every `#define` in the
// file before the scanner could see it.
function maskCNoise(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (src[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch || src[j] === '\n') break;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return out.join('');
}

function extractCRegex(content, filePath) {
  const masked = maskCNoise(content).split('\n');
  const raw = content.split('\n');
  const nodes = [];
  const structuralEdges = [];
  const typeEntries = [];
  const blocks = [];              // { kind: 'type'|'func', name }
  const push = (line, endLine, extra) => {
    nodes.push({
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      line, start_line: line, end_line: endLine,
      extractor_tier: 'regex', _sourceFile: filePath, ...extra,
    });
  };
  const topType = () => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'type') return blocks[i];
    return null;
  };
  const inFunc = () => blocks.some((b) => b.kind === 'func');

  let continuing = false;
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    const isDirective = continuing || /^\s*#/.test(line);
    continuing = isDirective && /\\\s*$/.test(line);
    if (isDirective) {
      const dm = C_RX_DEFINE.exec(line);
      if (dm) {
        push(i + 1, i + 1, dm[2]
          ? { node_type: 'METHOD', name: dm[1], kind: 'function_macro', params: '', signature: `${dm[1]}()`, summary: dm[1] }
          : { node_type: 'CONSTANT', name: dm[1], kind: 'macro', summary: dm[1] });
      }
      continue;
    }

    // Join forward while the parentheses on this logical line are unbalanced, capped so a
    // stray `(` cannot swallow the file.
    let joined = line;
    let last = i;
    for (let k = 0; k < 12; k++) {
      const opens = (joined.match(/\(/g) || []).length;
      const closes = (joined.match(/\)/g) || []).length;
      if (opens <= closes || last + 1 >= masked.length) break;
      last += 1;
      joined += ` ${masked[last]}`;
    }

    // The block stack gates every plane. Dropping the gate was tried, to reach a file whose
    // brace structure is macro-driven (nlohmann opens its namespaces with
    // `NLOHMANN_JSON_NAMESPACE_BEGIN`, so the stack there is meaningless and the scanner
    // contributes almost nothing): it bought 0.8 points of method recall for 9.7 points of
    // precision, 782 fabrications against 189 recoveries. Kept gated.
    const tm = C_RX_TYPE_HEAD.exec(joined);
    if (tm && !inFunc()) {
      const kind = tm[1] === 'class' ? 'class' : tm[1];
      typeEntries.push({ nodeIndex: nodes.length, name: tm[2] });
      push(i + 1, i + 1, { node_type: 'CLASS', name: tm[2], kind, summary: `${kind} ${tm[2]}` });
    } else if (!inFunc()) {
      const fp = C_RX_TYPEDEF_FNPTR.exec(joined) || C_RX_TYPEDEF_SIMPLE.exec(joined);
      if (fp) {
        push(i + 1, i + 1, { node_type: 'CLASS', name: fp[1], kind: 'typedef', summary: `typedef ${fp[1]}` });
      }
    }

    if (!tm) {
      const fm = C_RX_FUNC.exec(joined);
      // `f(void)` is the canonical C prototype and its parameter list is a type with no name,
      // which the shared parameter-list test rejects. Normalised to empty first.
      const paramText = /^\s*void\s*$/.test(fm ? fm[2] : '') ? '' : (fm ? fm[2] : '');
      if (fm && !C_RX_KEYWORD.has(fm[1]) && looksLikeParameterList(paramText) && !inFunc()) {
        const head = joined.slice(0, joined.indexOf(fm[1]));
        // A call has nothing but whitespace, `=`, `return` or an operator in front of it; a
        // declaration has a type. A constructor/destructor inside a class body has neither,
        // which is why the enclosing type's name is accepted as its own head.
        const owner = topType();
        const hasType = /[A-Za-z_>*&\]]\s*$/.test(head)
          || (owner && (fm[1] === owner.name || fm[1] === `~${owner.name}`));
        if (hasType) {
          const params = paramText.replace(/\s+/g, ' ').trim();
          const isDef = /\{\s*$/.test(joined);
          push(i + 1, last + 1, {
            node_type: 'METHOD', name: fm[1], params, signature: `${fm[1]}(${params})`,
            kind: isDef ? 'function_definition' : 'function_declaration',
            summary: `${fm[1]}(${params})`,
            ...(owner ? { parent_class: owner.name } : {}),
          });
        }
      } else if (!inFunc() && topType() && topType().isEnum) {
        // An enumerator is a bare name, optionally `= value`, inside an enum body — it has no
        // type in front of it, so C_RX_MEMBER (which requires one) matched none of them. The
        // regex tier had no enumerator branch at all, so any file whose tree-sitter parse
        // degraded lost every enumerator in it: fmt's `enum class color : uint32_t` is 165
        // named colours, and spdlog vendors the same header — 347 of the held-out C/C++ field
        // plane's 3,097 declarations.
        for (const part of joined.split(',')) {
          const em = /^\s*([A-Za-z_]\w*)\s*(?:=[^,]*)?\s*[,}]?\s*$/.exec(part);
          if (em && !C_RX_KEYWORD.has(em[1])) {
            push(i + 1, i + 1, {
              node_type: 'FIELD', name: em[1], kind: 'enumerator', summary: em[1],
              parent_class: topType().name,
            });
          }
        }
      } else if (!inFunc() && topType()) {
        const mm = C_RX_MEMBER.exec(joined);
        // `typedef` anywhere on the joined line, not just at its start: a typedef wrapped
        // across lines otherwise reads as a member whose name is the type it introduces, which
        // is where uv.h's `ssize_t`, `size_t` and `uv_thread_t` "members" came from.
        if (mm && !C_RX_KEYWORD.has(mm[1]) && !/\btypedef\b/.test(joined)
            && !/^\s*(?:return|using|friend)\b/.test(joined)) {
          push(i + 1, i + 1, {
            node_type: 'FIELD', name: mm[1], kind: 'member', summary: mm[1],
            parent_class: topType().name,
          });
        }
      }
    }

    // Track brace structure over the joined span, then skip the lines it consumed.
    for (let j = i; j <= last; j++) {
      const text = masked[j];
      for (let c = 0; c < text.length; c++) {
        if (text[c] === '{') {
          const head = (j === i ? joined : text).slice(0, c + 1);
          const intro = head.split(/[;}]/).pop() || head;
          blocks.push(C_RX_BLOCK_INTRO.test(intro)
            ? { kind: 'type', name: (tm && j === i) ? tm[2] : (topType() ? topType().name : null),
                isEnum: /\benum\b/.test(intro) }
            : { kind: 'func', name: null });
        } else if (text[c] === '}') {
          blocks.pop();
        }
      }
    }
    i = last;
  }
  void raw;
  void typeEntries;
  return {
    nodes, structuralEdges, inheritanceEdges: [], relativeImportEdges: [],
    sqlReferences: [], configValueRefs: [], importFacts: [], errorRatio: 0, looseFieldCount: 0,
  };
}

// ─── SQL declaration scanner ──────────────────────────────────────────────────
//
// SQL is the only language here with no tree-sitter grammar in our wasm bundle and no
// grammar worth having: tree-sitter-sql reports a parse error over most of the bytes of real
// SQL and finds zero stored procedures in files that contain nothing else. So this is a
// deterministic regex scanner instead.
//
// Three rules carry most of the weight:
//
//   1. Everything is matched against a MASKED copy of the source in which comment bodies and
//      string literals — including PostgreSQL dollar-quoted bodies — are blanked to spaces of
//      the same length. A `CREATE TABLE` written inside a comment or inside an
//      `EXEC('CREATE ...')` string is not a declaration, and this is the whole defence
//      against the fabrication class that cost express 1,661 nodes in JavaScript.
//   2. A routine's body is not searched. `CREATE TABLE #scratch` inside a stored procedure is
//      a local, not schema. In T-SQL the body runs to the next `GO`, because a
//      CREATE PROCEDURE must be the only statement in its batch; in PostgreSQL and MySQL the
//      body is inside a dollar quote or a DELIMITER block and is already masked or contained.
//   3. Objects are deduped per (file, name) and columns per (file, table, name), because a
//      regress script that drops and recreates the same table declares it once.

const SQL_KIND_NODE_TYPE = Object.freeze({
  table: 'DB_TABLE',
  view: 'DB_VIEW',
  materialized_view: 'DB_VIEW',
  type: 'DB_TYPE',
  domain: 'DB_TYPE',
  sequence: 'DB_TYPE',
  trigger: 'DB_TRIGGER',
});

// Clauses inside a CREATE TABLE body that declare a constraint rather than a column.
const SQL_CONSTRAINT_LEADER = /^(?:primary|foreign|unique|constraint|fulltext|spatial|exclude|like|period|partition|clustered|nonclustered|with|inherits|check)\b/i;

// `key` and `index` lead a constraint in MySQL (`KEY (dept_name)`, `INDEX ix (a)`) but are
// ordinary column names in PostgreSQL, where neither word is reserved. Telling them apart
// needs the shape, not the word: a constraint names its columns in parentheses, a column
// declaration is followed by a type. Treating them as constraints unconditionally silently
// dropped every column literally called `key` or `index`.
const SQL_AMBIGUOUS_LEADER = /^(?:key|index)\b\s*(?:[\w$]+\s*)?\(/i;

const SQL_DECL_HEAD = new RegExp(
  '^\\s*CREATE\\s+(?:OR\\s+(?:REPLACE|ALTER)\\s+)?(?:DEFINER\\s*=\\s*\\S+\\s+)?'
  + '(?:(?:GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|VIRTUAL|EXTERNAL|FOREIGN|RECURSIVE|CONSTRAINT|'
  + 'ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+\\w+)\\s+)*'
  + '(MATERIALIZED\\s+VIEW|TABLE|VIEW|FUNCTION|PROCEDURE|PROC|TRIGGER|TYPE|DOMAIN|SEQUENCE)\\b\\s*'
  + '(?:IF\\s+NOT\\s+EXISTS\\s+)?', 'i');

// T-SQL declares the body of a routine with ALTER, not CREATE: the universal idiom creates an
// empty stub inside an `EXEC('CREATE PROCEDURE ...')` string — which the mask correctly
// refuses to read as a declaration — and then ALTERs it. Without this, the First Responder
// Kit and every script written like it score zero.
const SQL_ALTER_ROUTINE = /^\s*ALTER\s+(FUNCTION|PROCEDURE|PROC|TRIGGER)\b\s*/i;

// ...but only when the ALTER carries a body. PostgreSQL uses the same syntax to *modify* an
// existing routine — `ALTER FUNCTION citus.find_groupid_for_node SET SCHEMA citus_internal` —
// and reading those as declarations invented 31 functions on citus alone. The actions below
// are the ones that follow the name (or its parameter list) in a modifying ALTER.
const SQL_ALTER_ROUTINE_ACTION = /^\s*(?:SET|OWNER|RENAME|DEPENDS|NO|RESET|ENABLE|DISABLE|ATTACH|DETACH)\b/i;
// `ALTER MATERIALIZED VIEW <cagg> ADD COLUMN ...` is how a continuous aggregate gains a
// column, and it declares one exactly as ALTER TABLE does.
const SQL_ALTER_TABLE = /^\s*ALTER\s+(?:TABLE|MATERIALIZED\s+VIEW|VIEW|FOREIGN\s+TABLE)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i;

const SQL_PARTITION_OF = /^\s*PARTITION\s+OF\s+(?:"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\]|[\w$@#]+)(?:\s*\.\s*(?:"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\]|[\w$@#]+))*\s*\(/i;

const SQL_NAME = /^\s*((?:"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\]|[\w$@#]+)(?:\s*\.\s*(?:"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\]|[\w$@#]+))*)/;

// The object name as the graph should carry it: quoting removed, schema qualification
// dropped, case preserved. `[dbo].[sp_Blitz]` -> `sp_Blitz`.
function sqlBareName(raw) {
  if (!raw) return null;
  const parts = [];
  let buf = '';
  let quote = null;
  for (const ch of String(raw)) {
    if (quote) {
      if (ch === quote || (quote === '[' && ch === ']')) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') { quote = ch; continue; }
    if (ch === '.') { parts.push(buf); buf = ''; continue; }
    if (/\s/.test(ch)) continue;
    buf += ch;
  }
  parts.push(buf);
  const last = parts[parts.length - 1].trim();
  return last || null;
}

// Blank comment bodies and string literals in place, preserving every byte offset so line
// numbers read off the mask are the source's own.
function maskSqlNoise(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  // Newlines survive blanking. Replacing them with spaces merges lines, which silently
  // shifted every line number after the first multi-line string and — far worse — moved the
  // `GO` batch separators off the start of a line, so 4 of Install-All-Scripts.sql's 32
  // batches disappeared and two stored procedures went with them.
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (src[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '-' && src[i + 1] === '-') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    // MySQL's `#` comment. It cannot be recognised on the bare character: `#tmp` and
    // `##global` are T-SQL temporary-table names, and treating those as comments would erase
    // every temp table in a T-SQL script. A `#` is a comment when it opens the line, or when
    // it stands alone between spaces — `dept_no INT, # FOREIGN KEY (...)`, which is how
    // test-db comments out a constraint and how a column called `#` was being declared.
    if (ch === '#'
        && (/^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i) + 1, i))
            || (/\s/.test(src[i - 1] || '\n') && /\s/.test(src[i + 1] || '\n')))) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '$') {
      const m = /^\$\w*\$/.exec(src.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const j = src.indexOf(tag, i + tag.length);
        // The tags stay visible so the statement splitter still sees a balanced body; only
        // what is between them is blanked.
        blank(i + tag.length, j < 0 ? n : j);
        i = j < 0 ? n : j + tag.length;
        continue;
      }
    }
    // Quoted IDENTIFIERS are code, not prose, so their contents are kept — but they must be
    // stepped over, because a quote inside one (`CREATE TABLE "heap_'tbl"`, of which citus has
    // several) otherwise opens a string literal that swallows the rest of the file.
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n && src[j] !== close) j++;
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === "'") {
      // A doubled quote is how EVERY dialect escapes a quote inside a literal. A backslash
      // escape is MySQL-only, and honouring it here is actively wrong on T-SQL: the literal
      // `''\''` (a doubled quote, a backslash, a doubled quote) ends up read as a closing
      // quote, which flips the mask out of phase for the rest of the file.
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") break;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return out.join('');
}

// Statement boundaries on the masked text. Understands the three separators real SQL files
// use: `;` at paren depth 0, T-SQL's `GO` batch line, and MySQL's `DELIMITER` — which exists
// so a routine body can contain semicolons, and without which every MySQL procedure is
// shredded into fragments.
function sqlStatements(masked) {
  const out = [];
  const n = masked.length;
  let delim = ';';
  let depth = 0;
  let start = 0;
  let i = 0;
  const flush = (end, endedBy) => {
    // `customDelim` records that a non-`;` statement delimiter was in force. It is what tells
    // a MySQL routine — whose whole body is one statement because DELIMITER exists precisely
    // to allow that — apart from a T-SQL routine whose body is split across statements and
    // runs to the next batch separator.
    if (masked.slice(start, end).trim()) out.push({ start, end, endedBy, customDelim: delim !== ';' });
    else if (out.length && endedBy === 'batch') out[out.length - 1].endedBy = 'batch';
    start = end;
  };
  while (i < n) {
    if (i === 0 || masked[i - 1] === '\n') {
      let eol = masked.indexOf('\n', i);
      if (eol < 0) eol = n;
      const line = masked.slice(i, eol).trim();
      const dm = /^DELIMITER\s+(\S+)$/i.exec(line);
      if (dm) {
        flush(i, 'delimiter_change');
        delim = dm[1];
        i = eol + 1;
        start = i;
        continue;
      }
      if (/^GO\s*;?$/i.test(line) || line === '/') {
        flush(i, 'batch');
        i = eol + 1;
        start = i;
        continue;
      }
    }
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && masked.startsWith(delim, i)) {
      flush(i, 'delimiter');
      i += delim.length;
      start = i;
      continue;
    }
    i++;
  }
  flush(n, 'eof');
  return out;
}

// Split a parenthesised body on commas at depth 0, so `DECIMAL(10, 2)` stays one clause.
function sqlSplitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

// A declaration is not always the first thing in its statement, and SQL statements are not
// reliably semicolon-terminated:
//
//   IF (OBJECT_ID('dbo.X') IS NULL) BEGIN CREATE TABLE dbo.X (...) END   -- T-SQL guard
//   IF OBJECT_ID('tempdb..#Config') IS NOT NULL DROP TABLE #Config       -- no terminator,
//   CREATE TABLE #Config ([Name] nvarchar(max), ...)                     -- so one statement
//
// so every CREATE/ALTER in a statement is a candidate, not just the leading one. Requiring the
// statement to *start* with CREATE lost the First Responder Kit 4 of its 10 tables and 199 of
// its 575 columns.
//
// The one thing that must not be read as a declaration is a privilege: `GRANT CREATE TABLE TO
// app` would otherwise declare a table called `TO`. Those are excluded by statement, not by
// looking at the token before the keyword — an allowlist of preceding tokens was tried and is
// too brittle to trust, because it silently dropped the first CREATE of any file whose
// preamble ends in a quoted psql `\set` value.
const SQL_PRIVILEGE_STATEMENT = /^\s*(?:GRANT|REVOKE|DENY)\b/i;

function nextSqlDeclarationKeyword(text, from) {
  const re = /\b(?:CREATE|ALTER)\b/gi;
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

// The first balanced `(...)` group at or after `from`, as offsets into the masked text.
function sqlParenGroup(masked, from, limit) {
  const open = masked.indexOf('(', from);
  if (open < 0 || open >= limit) return null;
  let depth = 0;
  for (let i = open; i < limit; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

function extractSqlDeclarations(content, filePath) {
  const nodes = [];
  const structuralEdges = [];
  const masked = maskSqlNoise(content);
  const statements = sqlStatements(masked);
  const lineOffsets = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineOffsets.push(i + 1);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const seen = new Set();
  const typeIndexByName = new Map();

  const addType = (name, kind, start, end) => {
    const bare = sqlBareName(name);
    if (!bare) return null;
    const key = `t\0${bare.toLowerCase()}`;
    if (seen.has(key)) return typeIndexByName.get(bare.toLowerCase()) ?? null;
    seen.add(key);
    const index = nodes.length;
    nodes.push({
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      node_type: SQL_KIND_NODE_TYPE[kind] || 'DB_TABLE',
      name: bare, kind, summary: `${kind} ${bare}`,
      line: lineAt(start), start_line: lineAt(start), end_line: lineAt(end - 1),
      extractor_tier: 'sql_scanner', _sourceFile: filePath,
    });
    typeIndexByName.set(bare.toLowerCase(), index);
    return index;
  };

  const addMethod = (name, kind, params, start, end) => {
    const bare = sqlBareName(name);
    if (!bare) return;
    const key = `m\0${bare.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push({
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      node_type: 'METHOD', name: bare, kind, params: params || '',
      signature: `${bare}(${params || ''})`, summary: `${kind} ${bare}`,
      line: lineAt(start), start_line: lineAt(start), end_line: lineAt(end - 1),
      extractor_tier: 'sql_scanner', _sourceFile: filePath,
    });
  };

  const addField = (name, owner, kind, fieldType, offset, ownerIndex) => {
    const bare = sqlBareName(name);
    const ownerBare = sqlBareName(owner);
    if (!bare) return;
    const key = `f\0${(ownerBare || '').toLowerCase()}\0${bare.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const index = nodes.length;
    nodes.push({
      confidence_tier: 'EXTRACTED', confidence: 1.0,
      node_type: 'FIELD', name: bare, kind, parent_class: ownerBare,
      summary: fieldType ? `${bare} ${fieldType}` : bare,
      ...(fieldType ? { field_type: fieldType } : {}),
      line: lineAt(offset), start_line: lineAt(offset), end_line: lineAt(offset),
      extractor_tier: 'sql_scanner', _sourceFile: filePath,
    });
    if (ownerIndex !== null && ownerIndex !== undefined) {
      structuralEdges.push({
        fromIndex: index, toIndex: ownerIndex, edgeType: 'DEFINED_IN',
        evidenceLine: lineAt(offset),
      });
    }
  };

  // Read the column clauses of a `(...)` body starting at `from`.
  const readColumns = (owner, ownerIndex, from, limit, kind) => {
    const group = sqlParenGroup(masked, from, limit);
    if (!group) return;
    for (const clause of sqlSplitTopLevel(masked.slice(group.open + 1, group.close))) {
      const trimmed = clause.trim();
      if (!trimmed || SQL_CONSTRAINT_LEADER.test(trimmed) || SQL_AMBIGUOUS_LEADER.test(trimmed)) continue;
      const m = SQL_NAME.exec(clause);
      if (!m) continue;
      const rest = clause.slice(m[0].length).trim();
      const typeMatch = /^([A-Za-z_][\w ]*?)(?:\s*\(|\s|$)/.exec(rest);
      const offset = group.open + 1 + clause.indexOf(m[1]);
      addField(m[1], owner, kind, typeMatch ? typeMatch[1].trim() : null, offset, ownerIndex);
    }
  };

  const hasBatches = statements.some((s) => s.endedBy === 'batch');
  const bodyRunsToBatch = (stmt) => hasBatches && !stmt.customDelim && stmt.endedBy !== 'batch';
  let skippingRoutineBody = false;

  for (const stmt of statements) {
    const text = masked.slice(stmt.start, stmt.end);
    if (skippingRoutineBody) {
      if (stmt.endedBy === 'batch') skippingRoutineBody = false;
      continue;
    }
    if (SQL_PRIVILEGE_STATEMENT.test(text)) continue;

    let cursor = 0;
    while (cursor < text.length) {
      const at = nextSqlDeclarationKeyword(text, cursor);
      if (at < 0) break;
      const slice = text.slice(at);
      const alterRoutine = SQL_ALTER_ROUTINE.exec(slice);
      const head = alterRoutine ? null : SQL_DECL_HEAD.exec(slice);
      const declOffset = stmt.start + at;

      if (!head && !alterRoutine) {
        const alterTable = SQL_ALTER_TABLE.exec(slice);
        if (!alterTable) { cursor = at + 6; continue; }
        const nameMatch = SQL_NAME.exec(slice.slice(alterTable[0].length));
        if (!nameMatch) { cursor = at + 6; continue; }
        const owner = nameMatch[1];
        const ownerIndex = typeIndexByName.get((sqlBareName(owner) || '').toLowerCase()) ?? null;
        const consumedAlter = alterTable[0].length + nameMatch[0].length;
        const tail = slice.slice(consumedAlter);
        const addRe = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/gi;
        let am;
        while ((am = addRe.exec(tail)) !== null) {
          const after = tail.slice(am.index + am[0].length);
          if (SQL_CONSTRAINT_LEADER.test(after.trim())) continue;
          const cm = SQL_NAME.exec(after);
          if (!cm) continue;
          const rest = after.slice(cm[0].length).trim();
          const typeMatch = /^([A-Za-z_][\w ]*?)(?:\s*\(|\s|,|$)/.exec(rest);
          if (!typeMatch) continue;
          addField(cm[1], owner, 'added_column', typeMatch[1].trim(),
                   declOffset + consumedAlter + am.index, ownerIndex);
        }
        cursor = at + consumedAlter;
        continue;
      }

      if (alterRoutine) {
        const afterAlterName = SQL_NAME.exec(slice.slice(alterRoutine[0].length));
        let probe = afterAlterName
          ? slice.slice(alterRoutine[0].length + afterAlterName[0].length) : '';
        const parens = /^\s*\(/.test(probe)
          ? sqlParenGroup(probe, 0, probe.length) : null;
        if (parens) probe = probe.slice(parens.close + 1);
        if (SQL_ALTER_ROUTINE_ACTION.test(probe)) {
          cursor = at + alterRoutine[0].length;
          continue;
        }
      }
      const rawKind = (alterRoutine ? alterRoutine[1] : head[1]).replace(/\s+/g, ' ').toLowerCase();
      const kind = rawKind === 'proc' ? 'procedure'
        : rawKind === 'materialized view' ? 'materialized_view' : rawKind;
      const consumed = alterRoutine ? alterRoutine[0].length : head[0].length;
      const nameMatch = SQL_NAME.exec(slice.slice(consumed));
      if (!nameMatch) { cursor = at + consumed; continue; }
      const name = nameMatch[1];
      const afterName = at + consumed + nameMatch[0].length;

      if (kind === 'function' || kind === 'procedure' || kind === 'trigger') {
        if (kind === 'trigger') {
          addType(name, 'trigger', declOffset, stmt.end);
        } else {
          const group = sqlParenGroup(masked, stmt.start + afterName, stmt.end);
          const params = group
            ? masked.slice(group.open + 1, group.close).replace(/\s+/g, ' ').trim() : '';
          addMethod(name, kind, params, declOffset, stmt.end);
        }
        // Everything after a routine header is its body, which is not searched — so stop
        // scanning this statement, and if the body continues past the statement (T-SQL, where
        // the body's own semicolons split it) skip on to the next batch.
        if (bodyRunsToBatch(stmt)) skippingRoutineBody = true;
        break;
      }

      const ownerIndex = addType(name, kind, declOffset, stmt.end);
      const afterNameText = text.slice(afterName);
      if (kind === 'table' || kind === 'type') {
        // A composite type spells its attributes `CREATE TYPE x AS (f int)`. Without the AS
        // — `CREATE TYPE x (INPUT = f_in, OUTPUT = f_out)` — the parentheses hold a base
        // type's property list, and reading it as columns invents a field per property.
        const compositeAt = kind === 'type' && /^\s*AS\s*\(/i.test(afterNameText);
        const enumAt = kind === 'type' && /^\s*AS\s+ENUM\s*\(/i.test(afterNameText);
        if (enumAt) {
          // Enum labels are string literals, so they are blanked in the mask — they have to be
          // read from the original source.
          const group = sqlParenGroup(masked, stmt.start + afterName, stmt.end);
          if (group) {
            for (const lit of sqlSplitTopLevel(content.slice(group.open + 1, group.close))) {
              const lm = /'((?:[^']|'')*)'/.exec(lit);
              if (lm) addField(lm[1], name, 'enum_label', null, group.open + 1, ownerIndex);
            }
          }
        } else if (kind === 'table' && SQL_PARTITION_OF.test(afterNameText)) {
          // `CREATE TABLE part PARTITION OF parent (key, ts, ...)` restates the parent's
          // columns on the partition, and PostgreSQL records them as the partition's own.
          const pm = SQL_PARTITION_OF.exec(afterNameText);
          readColumns(name, ownerIndex, stmt.start + afterName + pm[0].length - 1, stmt.end, 'column');
        } else if (/^\s*\(/.test(afterNameText) && kind === 'table') {
          // The column list is the parenthesis that comes IMMEDIATELY after the name. Anything
          // else — `CREATE TABLE t AS SELECT ...`, `PARTITION OF p`, `LIKE u`, or a bare
          // `CREATE TYPE x` — declares no columns of its own, and searching further ahead for
          // a `(` would import the next statement's parentheses as this table's columns.
          readColumns(name, ownerIndex, stmt.start + afterName, stmt.end, 'column');
        } else if (compositeAt) {
          readColumns(name, ownerIndex, stmt.start + afterName, stmt.end, 'type_attribute');
        }
      }
      cursor = afterName;
    }
  }

  return {
    nodes, structuralEdges, inheritanceEdges: [], relativeImportEdges: [],
    sqlReferences: [], configValueRefs: [], importFacts: [],
  };
}

// ─── Composite AST node builder ───────────────────────────────────────────────

// Builds EXTRACTED-tier node descriptors and structural edges from source text.
// Returns the seven-key contract, uniform across the regex and tree-sitter paths:
// { nodes, structuralEdges, inheritanceEdges, relativeImportEdges, sqlReferences, configValueRefs, importFacts }.
// structuralEdges: [{ fromIndex, toIndex, edgeType }] — indices into nodes[].
// inheritanceEdges: [{ fromIndex, toName, edgeType }] — toName resolved later by branch lookup.
// relativeImportEdges: [{ fromIndex, targetRelPath }] — JS/TS DEPENDS_ON, resolved post-loop.
// sqlReferences: [{ entityName, operation, line }] — SQL/JPQL entity refs for READS/WRITES_TABLE.
// configValueRefs: [{ configKey, line }] — env/config refs for USES_CONFIG.
// importFacts: [{ name, module, alias, line }] — attached to the FILE node's
//   properties.imports by ingest-file-processor.js; no node/edge of its own.
// Types that carry no structural information as a REFERENCES target: an edge to
// `String` or `Integer` is noise on every codebase, and
// annotation names are already covered by DECORATED_BY so they must not be double-counted here.
const NON_REFERENCEABLE_TYPES = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short', 'Character', 'Object',
  'Number', 'Void', 'Class', 'Enum', 'Record', 'List', 'Map', 'Set', 'Collection', 'Iterable',
  'Optional', 'Stream', 'Array', 'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'Comparable',
  'Exception', 'RuntimeException', 'Throwable', 'Error', 'Override', 'Deprecated', 'SafeVarargs',
  'SuppressWarnings', 'FunctionalInterface',
  // The list above is Java-shaped, and `referencedTypeNames` keys on "starts
  // with a capital" — which in Python matches the LITERALS. django-machina's
  // resolver log named `REFERENCES None ×27` and `REFERENCES True ×6` among its
  // top unresolved edges: not near-misses, just noise the filter never covered.
  // Python literals, typing-module generics and the ubiquitous ABCs:
  'None', 'True', 'False', 'Any', 'Dict', 'Tuple', 'Type', 'Union', 'Callable', 'Iterator',
  'Sequence', 'Mapping', 'Text', 'Self', 'Literal', 'Final', 'ClassVar', 'Annotated',
  'Awaitable', 'Coroutine', 'Generator', 'AnyStr', 'NoReturn', 'TypeVar', 'Protocol',
  // TypeScript/JS structural types that appear in annotations everywhere.
  'Promise', 'Record', 'Partial', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
  'ReadonlyArray', 'Date', 'RegExp', 'Function', 'Symbol', 'BigInt', 'JSON', 'Math',
]);

function buildAstNodes(content, filePath, parserPath = filePath, opts = {}) {
  const ext  = path.extname(parserPath).toLowerCase();
  const lang = EXT_TO_AST_LANG[ext];
  if (!lang) return { nodes: [], structuralEdges: [], inheritanceEdges: [], relativeImportEdges: [], sqlReferences: [], configValueRefs: [], importFacts: [] };

  // The three bespoke planes fall back to the regex
  // scanner whenever their wasm parser has not settled. Only the TypeScript extractor stamped
  // a plane marker, so for Kotlin and Go a fallback was invisible in the graph. Every bespoke
  // result is now labelled with the plane
  // that actually produced it, read off which branch ran, so "zero regex-plane fallback where a
  // grammar exists" is a checkable claim rather than an assumption.
  // The regex scanner is the fallback for every bespoke plane, and an untested fallback is a
  // real risk — it is what runs if a wasm grammar fails to load. AST_FORCE_REGEX=1 makes it
  // reachable on demand, so the fallback can be benchmarked instead of assumed.
  const _forceRegex = process.env.AST_FORCE_REGEX === '1' || opts.forceRegex === true;

  const _stampPlane = (result, tier) => {
    for (const nd of result?.nodes || []) {
      if (nd.extractor_tier === undefined) nd.extractor_tier = tier;
    }
    // Every language funnels through here before returning, so this is the one place that can give
    // Ruby/PHP/Rust/Go/C#/Swift/C/C++/Python the same outbound-HTTP-call capture the JS/TS/Java
    // paths already have. Additive and idempotent (dedupes on target+line), so it is safe to run
    // even for the languages whose AST hint already populated these.
    if (result?.nodes?.length) augmentHttpCallsAcrossLanguages(result.nodes, content);
    return result;
  };

  // C / C++. `.c` goes to the C grammar and everything else to C++; a `.h` is whichever
  // language its project writes, so it is parsed as C++ and re-parsed as C when C++ errors,
  // keeping the cleaner tree.
  const _cExt = ext === '.c' || ext === '.h' || ext === '.cpp' || ext === '.cc'
    || ext === '.cxx' || ext === '.hpp' || ext === '.hh' || ext === '.hxx';
  if (!_forceRegex && _cExt && (_cState === 'ready' || _cppState === 'ready')) {
    try {
      if (ext === '.c' && _cState === 'ready') {
        const raw = extractCTreeSitter(content, filePath, _cParser);
        if (!(raw.errorRatio > 0) && !raw.looseFieldCount) return _stampPlane(raw, 'treesitter');
        const clean = extractCTreeSitter(
          maskPreprocessorDirectives(content), filePath, _cParser);
        if (raw.looseFieldCount > 0 && clean.looseFieldCount === 0) {
          return _stampPlane(mergeDegradedPlanes(clean, {
            ...raw,
            nodes: (raw.nodes || []).filter(
              (n) => n.node_type === 'CONSTANT' || n.kind === 'function_macro'),
          }), 'treesitter');
        }
        return _stampPlane(clean.errorRatio < raw.errorRatio
          ? mergeDegradedPlanes(raw, clean) : raw, 'treesitter');
      }
      const cppOk = _cppState === 'ready';
      const activeParser = cppOk ? _cppParser : _cParser;
      // The tree is kept so the macro-span scan below can reuse it. Every C and C++ file used to
      // be parsed twice over identical bytes for that scan alone.
      let primary = extractCTreeSitter(content, filePath, activeParser, true);
      let primaryParser = activeParser;
      // A `.h` is whichever language its project writes; keep the cleaner of the two parses.
      if (ext === '.h' && primary.errorRatio > 0 && _cState === 'ready' && cppOk) {
        const viaC = extractCTreeSitter(content, filePath, _cParser, true);
        if (viaC.errorRatio < primary.errorRatio) {
          releaseTree(primary._tree);
          primary = viaC;
          primaryParser = _cParser;
        } else {
          releaseTree(viaC._tree);
        }
      }
      // Reuse the tree only when it came from the parser the mask is defined against. When the
      // `.h` retry above swapped in a C parse, the mask still has to be taken from a C++ one —
      // preserving exactly what this did before the tree was threaded through.
      const demacroed = maskClassExportMacros(
        content, activeParser, primaryParser === activeParser ? primary._tree : null);
      releaseTree(primary._tree);
      delete primary._tree;
      if (demacroed !== null) {
        const viaDemacro = extractCTreeSitter(demacroed, filePath, activeParser);
        if (viaDemacro.errorRatio <= primary.errorRatio) primary = viaDemacro;
      }
      const degraded = (r) => (r.errorRatio > 0 ? r.errorRatio : 0) + (r.looseFieldCount > 0 ? 1 : 0);
      if (!degraded(primary)) return _stampPlane(primary, 'treesitter');
      const viaNoDirectives = extractCTreeSitter(
        maskPreprocessorDirectives(content), filePath, activeParser);
      if (primary.looseFieldCount > 0 && viaNoDirectives.looseFieldCount === 0) {
        return _stampPlane(mergeDegradedPlanes(viaNoDirectives, {
          ...primary,
          nodes: (primary.nodes || []).filter(
            (n) => n.node_type === 'CONSTANT' || n.kind === 'function_macro'),
        }), 'treesitter');
      }
      // Wherever the grammar has given up, the regex scanner keeps finding declarations.
      // Merged, never chosen: the two fail in different directions, and the grammar plane is
      // the only one with reliable containment and spans.
      // Only where the grammar is BADLY degraded. Merging the scanner into a nearly-clean
      // parse trades a little recall for more noise than it recovers — measured on leveldb,
      // whose files sit at a fraction of a percent error: field precision fell 99.2% -> 96.9%
      // for no recall gain. Above the threshold the trade reverses sharply.
      const REGEX_MERGE_ERROR_FLOOR = 0.02;
      const withRegex = (res) => (res.errorRatio > REGEX_MERGE_ERROR_FLOOR
        ? mergeDegradedPlanes(res, extractCRegex(content, filePath)) : res);
      if (!(viaNoDirectives.errorRatio < primary.errorRatio)) {
        return _stampPlane(withRegex(primary), 'treesitter');
      }
      // When blanking the directives turns a wreck into a clean parse — nlohmann's amalgamated
      // header goes from 74.1% error to 3.2% — the raw parse's declarations are error-recovery
      // debris and unioning them adds far more noise than they recover. Keep only the macro
      // plane from it, which is the one thing the directive-free parse cannot have. Below that
      // margin the two parses are both partial and the union is the better answer, which is
      // the same call the C# plane makes on a degraded parse.
      if (viaNoDirectives.errorRatio * 4 < primary.errorRatio) {
        const macroOnly = {
          ...primary,
          nodes: (primary.nodes || []).filter(
            (n) => n.node_type === 'CONSTANT' || n.kind === 'function_macro'),
        };
        return _stampPlane(mergeDegradedPlanes(withRegex(viaNoDirectives), macroOnly), 'treesitter');
      }
      return _stampPlane(mergeDegradedPlanes(withRegex(primary), viaNoDirectives), 'treesitter');
    } catch (_) { /* fall through */ }
  }

  // SQL has its own scanner and none of the class/method machinery below applies to it.
  // AST_FORCE_REGEX does not divert it: the scanner IS the only plane, so there is no
  // fallback to keep testable.
  if (ext === '.sql') {
    try { return _stampPlane(extractSqlDeclarations(content, filePath), 'sql_scanner'); } catch (_) {
      return { nodes: [], structuralEdges: [], inheritanceEdges: [], relativeImportEdges: [], sqlReferences: [], configValueRefs: [], importFacts: [] };
    }
  }

  // Kotlin: use tree-sitter when parser is ready; fall back to Java regex otherwise.
  if (!_forceRegex && (ext === '.kt' || ext === '.kts') && _ktState === 'ready') {
    try {
      const primary = extractKotlinTreeSitter(content, filePath);
      if (!primary.errorRatio) return _stampPlane(primary, 'treesitter');
      const masked = maskKotlinModernSyntax(content);
      if (masked !== null) {
        const viaMask = extractKotlinTreeSitter(masked, filePath);
        if (viaMask.errorRatio < primary.errorRatio) {
          return _stampPlane(mergeDegradedPlanes(viaMask, primary), 'treesitter');
        }
      }
      return _stampPlane(primary, 'treesitter');
    } catch (_) {}
  }

  // Go: use tree-sitter when parser is ready; fall back to Go regex otherwise.
  if (!_forceRegex && ext === '.go' && _goState === 'ready') {
    try { return _stampPlane(extractGoTreeSitter(content, filePath), 'treesitter'); } catch (_) {}
  }

  // PHP: tree-sitter when the parser is ready; the line scanner remains the fallback.
  if (!_forceRegex && ext === '.php' && _phpState === 'ready') {
    try {
      const primary = extractPhpTreeSitter(content, filePath);
      if (!primary.errorRatio) return _stampPlane(primary, 'treesitter');
      const masked = maskPhpPropertyHooks(content);
      if (masked !== null) {
        const viaMask = extractPhpTreeSitter(masked, filePath);
        if (viaMask.errorRatio < primary.errorRatio) {
          return _stampPlane(mergeDegradedPlanes(viaMask, primary), 'treesitter');
        }
      }
      return _stampPlane(primary, 'treesitter');
    } catch (_) {}
  }

  // TypeScript: tree-sitter for syntax structure; regex remains explicit fallback. .tsx is
  // gated on the TSX grammar specifically — falling back to the plain TypeScript grammar
  // there is not a degraded parse, it is a wrong one.
  const _tsPlain = ext === '.ts' || ext === '.mts' || ext === '.cts';
  if (!_forceRegex && ((_tsPlain && _tstsState === 'ready') || (ext === '.tsx' && _tsxState === 'ready'))) {
    try { return _stampPlane(extractTypeScriptTreeSitter(content, filePath), 'treesitter'); } catch (_) {}
  }

  // JavaScript. `.vue` also maps to the javascript language but is a single-file component,
  // not a JavaScript program, so it stays on the regex scanner.
  const _jsPlain = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';
  if (!_forceRegex && _jsPlain && _jsState === 'ready') {
    try {
      const primary = extractJavaScriptTreeSitter(content, filePath);
      if (!primary.parseError || _tsxState !== 'ready') return _stampPlane(primary, 'treesitter');
      // Flow ships on the `.js` extension but is a different language, and the JavaScript
      // grammar errors on its type syntax — truncating the file and losing the plain
      // JavaScript declarations underneath. The TypeScript grammar accepts most Flow
      // annotations, so retry there and keep the result only if it parses cleanly.
      const viaTs = extractJavaScriptViaTsTreeSitter(content, filePath);
      return _stampPlane(viaTs.parseError ? primary : viaTs, 'treesitter');
    } catch (_) {}
  }

  // Python.
  const _pyPlain = ext === '.py' || ext === '.pyi';
  if (!_forceRegex && _pyPlain && _pyState === 'ready') {
    try { return _stampPlane(extractPythonTreeSitter(content, filePath), 'treesitter'); } catch (_) {}
  }

  // C#. A grammar that returns NOTHING for a file with content has not parsed it — the C#
  // grammar build fails outright on `class X : Y;` (C# 12's semicolon body) and on files large
  // enough to exhaust its parse budget, 360KB in efcore's case. Falling through to the regex
  // scanner there recovers most of the declarations instead of none, which is only safe now
  // that the return-type defect above is fixed.
  if (!_forceRegex && ext === '.cs' && _csState === 'ready') {
    try {
      // When the parse is clean, use it. When it is not, neither "always fall back" nor "never
      // fall back" is right: a root-spanning ERROR sometimes leaves a perfectly usable subtree
      // (a 58KB file still yielding 78 declarations) and sometimes leaves nothing usable (a
      // 146KB file yielding 5). Both were measured on efcore, and each rule alone lost on the
      // other case. So on a degraded parse, run the regex scanner too and keep whichever plane
      // actually recovered more declarations — decided per file, from evidence, not by a
      // threshold guessed in advance.
      const res = extractCSharpTreeSitter(content, filePath);
      if (!(res.errorRatio > 0)) return _stampPlane(res, 'treesitter');
      // On a degraded parse, MERGE rather than choose. Choosing loses whichever plane the
      // other one beats on count, and the two fail in different directions: tree-sitter keeps
      // a partial but well-typed result (it is the only plane with a C# field plane at all),
      // while the regex scanner keeps finding methods long after the grammar has given up.
      // Measured on efcore: choosing by node count cost 1,395 fields on the files it sent to
      // regex; merging keeps both.
      const viaRegex = buildAstNodes(content, filePath, parserPath, { forceRegex: true });
      return _stampPlane(mergeDegradedPlanes(res, viaRegex), 'treesitter');
    } catch (_) {}
  }

  const _bespokeRegexFallback = (ext === '.kt' || ext === '.kts' || ext === '.go' || ext === '.php' || _tsPlain || ext === '.tsx' || _jsPlain || _pyPlain || ext === '.cs');

  const nodes = [];
  const classEntries  = [];
  const methodEntries = [];
  const importFacts = [];
  const sourceLines = content.split('\n');
  const phpNamespaces = lang === LANG.PHP
    ? sourceLines.flatMap((line, index) => {
      const match = line.match(/^\s*namespace\s+([A-Za-z_][\w\\]*)\s*(?:;|\{)/);
      return match ? [{ line: index + 1, name: match[1] }] : [];
    })
    : [];
  const phpNamespaceAt = (lineNumber) => {
    let namespace = null;
    for (const declaration of phpNamespaces) {
      if (declaration.line >= lineNumber) break;
      namespace = declaration.name;
    }
    return namespace;
  };
  const pythonIndentAt = (lineNumber) => (sourceLines[lineNumber - 1]?.match(/^\s*/)?.[0].length || 0);
  const pythonBlockEndLine = (lineNumber, indent) => {
    let end = lineNumber;
    for (let i = lineNumber; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const lineIndent = line.match(/^\s*/)?.[0].length || 0;
      if (lineIndent <= indent) break;
      end = i + 1;
    }
    return end;
  };
  // Brace-language block end. Was Rust-only; every brace language needs the same scan and
  // Java was the one the corpus is built on, so it shipped with end_line permanently null on
  // 100% of its nodes (measured 636/636 on spring-petclinic-rest). A naive depth counter is
  // not good enough here — a `{` inside a string, char literal, comment, or Java text block
  // silently shifts every subsequent span, which is worse than no span at all. Rust raw
  // strings and Java/Kotlin text blocks are both handled so one scanner serves all of them.
  const NESTING_BLOCK_COMMENTS = new Set([LANG.RUST, LANG.KOTLIN, LANG.SCALA, LANG.SWIFT]);
  // A `{` inside a still-open parameter list is an annotation array value, not the body brace:
  //   public void legacyCompatOutputsSameJsonAsRtaf(
  //       @TestParameter({
  //           "IDENTITY", ... })
  //       FieldNamingPolicy p) {
  // The scan latched onto the `{` on the @TestParameter line and closed the method eight lines
  // early, so the locals below the real body brace sat outside every method span and the FIELD
  // plane read them as class state. Java only — the other brace languages belong to other
  // slices and each needs its own measurement before its spans move.
  const _skipParenBraces = lang === LANG.JAVA;
  const braceBlockEndLine = (lineNumber) => {
    let depth = 0;
    let parenDepth = 0;
    let opened = false;
    let blockCommentDepth = 0;
    let inString = false;
    let escaped = false;
    let rawStringHashes = null;
    let inTextBlock = false;
    for (let i = lineNumber - 1; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        const next = line[j + 1];
        if (inTextBlock) {
          if (line.startsWith('"""', j)) { inTextBlock = false; j += 2; }
          continue;
        }
        if (rawStringHashes !== null) {
          const closing = `"${'#'.repeat(rawStringHashes)}`;
          if (line.startsWith(closing, j)) {
            rawStringHashes = null;
            j += closing.length - 1;
          }
          continue;
        }
        if (blockCommentDepth > 0) {
          // Block comments nest in Rust, Kotlin, Scala and Swift; they do NOT nest in C, C++,
          // C#, Java, JavaScript, TypeScript, Go, PHP or Dart, where `/*` inside a comment is
          // just text. Counting it as a nested opener meant a comment that never closed, and
          // with it a class whose end_line was null and therefore no fields at all. jackson-
          // databind writes every section banner as four `/*` lines and one `*/`:
          //     /*
          //     /*******************
          //     /* General coercions
          //     /*******************
          //      */
          // That cost 4,478 of its 8,564 fields — and it was invisible on the seven Java repos
          // this plane was built against, which is exactly what a held-out corpus is for.
          if (NESTING_BLOCK_COMMENTS.has(lang) && ch === '/' && next === '*') {
            blockCommentDepth++; j++;
          } else if (ch === '*' && next === '/') { blockCommentDepth--; j++; }
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '/' && next === '*') { blockCommentDepth++; j++; continue; }
        if (ch === '/' && next === '/') break;
        const rawString = line.slice(j).match(/^(?:br|r)(#*)"/);
        if (rawString) {
          rawStringHashes = rawString[1].length;
          j += rawString[0].length - 1;
          continue;
        }
        if (line.startsWith('"""', j)) { inTextBlock = true; j += 2; continue; }
        if (ch === '"') { inString = true; continue; }
        if (ch === "'") {
          let charEnd = j + 1;
          let charEscaped = false;
          for (; charEnd < line.length; charEnd++) {
            if (charEscaped) { charEscaped = false; continue; }
            if (line[charEnd] === '\\') { charEscaped = true; continue; }
            if (line[charEnd] === "'") break;
          }
          if (charEnd < line.length) { j = charEnd; continue; }
        }
        if (_skipParenBraces && !opened) {
          if (ch === '(') { parenDepth++; continue; }
          if (ch === ')') { if (parenDepth > 0) parenDepth--; continue; }
          if (parenDepth > 0 && (ch === '{' || ch === '}')) continue;
        }
        if (ch === '{') { opened = true; depth++; }
        if (ch === '}' && opened) {
          depth--;
          if (depth === 0) return i + 1;
        }
        // The statement ends where the `;` actually is, not where the declaration started.
        // `T deserialize(...)\n    throws JsonParseException;` was reported as ending on its
        // first line, leaving the `throws` continuation outside every method span.
        if (ch === ';' && !opened) return i + 1;
      }
    }
    return null;
  };

  // One entry point for "where does the block opened at this line end", so CLASS and METHOD
  // spans can never disagree about the same construct. Ruby stays null: `end` matching needs
  // statement-position keyword tracking (modifier `if`, single-line `do`) that a line scanner
  // gets wrong more often than it gets right, and a wrong span is worse than an absent one.
  const INDENT_SCOPED = new Set([LANG.PYTHON]);
  const NO_BLOCK_SCAN = new Set([LANG.RUBY]);
  const blockEndLine = (lineNumber, indent) => {
    if (!lineNumber) return null;
    if (NO_BLOCK_SCAN.has(lang)) return null;
    if (INDENT_SCOPED.has(lang)) return pythonBlockEndLine(lineNumber, indent ?? pythonIndentAt(lineNumber));
    return braceBlockEndLine(lineNumber);
  };

  // A Java declaration begins at its first annotation, not at its signature — `@Override` and
  // `@GetMapping("/owners")` are part of the declaration, and tree-sitter's modifiers node
  // includes them. Anchoring at the signature put start_line 1-4 lines late on every annotated
  // member. Only contiguous annotation-only lines are absorbed: a blank line or a javadoc block
  // stops the walk, because those are not part of the declaration.
  // Declared here, above the class loop that uses it — that loop swallows errors in a bare
  // `catch (_)`, so a TDZ miss shows up as "every class silently vanished", not as a stack.
  // A declaration STARTS at its modifier list, and in Java the modifier list includes the
  // annotations. That is what tree-sitter's `method_declaration` spans, what Roslyn's `Span`
  // spans for C#, and what `getStart()` gives for a decorated TypeScript member — so it is the
  // convention the whole benchmark's truth is written in.
  //
  // The first version of this required the annotation to be the entire line AND its argument
  // list to contain no `)`: `/^@\w+(?:\([^)]*\))?$/`. Any nested paren defeated it, including
  // one inside a string — guava's `@InlineMe(replacement = "this.convert(a)")` — and the walk
  // stopped there, leaving the node anchored on the signature while truth anchored three lines
  // up. 660 of the 749 Java line-accuracy misses on the held-out corpus were this one regex.
  //
  // String and char literals are blanked before counting parens, so a `"("` inside a message
  // cannot unbalance the scan. An annotation whose argument list wraps across lines is followed
  // upward until its opener is found.
  const _noLiterals = (s) => s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
  const declStartLine = (line) => {
    let start = line;
    let depth = 0;
    for (let d = line - 2; d >= 0; d--) {
      const dl = sourceLines[d].trim();
      if (!dl) break;
      const bare = _noLiterals(dl);
      const delta = (bare.match(/\)/g) || []).length - (bare.match(/\(/g) || []).length;
      if (depth > 0) {
        // Inside a wrapped annotation argument list: keep climbing until it balances.
        depth += delta;
        if (depth <= 0 && dl.startsWith('@')) { start = d + 1; depth = 0; }
        else if (depth < 0) depth = 0;
        continue;
      }
      if (dl.startsWith('@')) {
        depth = delta;
        if (depth <= 0) { start = d + 1; depth = 0; }
        continue;
      }
      if (delta > 0) { depth = delta; continue; }
      break;
    }
    return start;
  };

  try {
    for (const cls of extractClasses(content, lang)) {
      if (!cls.name) continue;
      const nodeType = lang === LANG.JAVA
        && Array.isArray(cls.decorators)
        && cls.decorators.some((decorator) => /^@Entity\b/.test(decorator))
        ? 'ENTITY'
        : 'CLASS';
      const nd = {
        node_type: nodeType, name: cls.name,
        // A factory-assigned class is a class by convention, inferred from an
        // assignment shape — not something the grammar declares as one.
        confidence_tier: cls.factoryAssigned ? 'INFERRED' : 'EXTRACTED',
        confidence: cls.factoryAssigned ? 0.9 : 1.0,
        summary: cls.factoryAssigned
          ? `${cls.name} (constructed by a factory call)${cls.extends ? ` from ${cls.extends}` : ''}`
          : `${cls.kind || 'class'} ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ''}`,
        line: cls.line, kind: cls.kind,
        start_line: cls.line,
        end_line: null,
      };
      nd.end_line = blockEndLine(cls.line, lang === LANG.PYTHON ? pythonIndentAt(cls.line) : null);
      if (lang === LANG.JAVA) nd.start_line = declStartLine(cls.line);
      if (cls.extends)     nd.extends    = cls.extends;
      if (cls.implements)  nd.implements = cls.implements;
      if (cls.visibility)  nd.visibility = cls.visibility;
      if (cls.decorators)  nd.decorators = cls.decorators;
      const phpNamespace = lang === LANG.PHP ? phpNamespaceAt(cls.line) : null;
      if (phpNamespace) nd.namespace = phpNamespace;
      const indent = lang === LANG.PYTHON ? pythonIndentAt(cls.line) : null;
      classEntries.push({
        nodeIndex: nodes.length,
        line: cls.line,
        indent,
        blockEndLine: nd.end_line,
      });
      nodes.push(nd);
    }
  } catch (_) {}

  // Java declares method scopes that are not `class X` declarations: enum constant bodies
  // (`IDENTITY() { ... }` inside an enum) and anonymous classes (`new RowMapper<>() { ... }`).
  // Neither was extracted, so every method inside them was attributed to the enclosing type —
  // all seven per-constant overrides of FieldNamingPolicy.translateName collapsed onto one
  // canonical_key and six were discarded by the ON CONFLICT upsert. Measured on gson: 147 of
  // 3286 methods (4.5%) silently lost, and they are the polymorphic implementations, i.e. the
  // ones a reader most needs. Enum bodies are named by their constant rather than Java's
  // positional `Outer$1` so the key survives reordering of unrelated constants.
  if (lang === LANG.JAVA) {
    const innermostClassAt = (lineNo) => classEntries
      .filter((e) => e.blockEndLine != null && e.line <= lineNo && lineNo <= e.blockEndLine)
      .sort((a, b) => (a.blockEndLine - a.line) - (b.blockEndLine - b.line))[0] || null;
    const enumRanges = classEntries
      .filter((e) => nodes[e.nodeIndex].kind === 'enum' && e.blockEndLine != null)
      .map((e) => ({ name: nodes[e.nodeIndex].name, start: e.line, end: e.blockEndLine }));

    // `[^;{]*\)` is a gate, not a balanced read: it stops at the FIRST `)` that lets the rest
    // match, so `try (ZipFile z = new ZipFile(getResourceFile("x"))) {` reads as an anonymous
    // ZipFile subclass. The phantom class then spans the rest of the method, and because the
    // FIELD plane treats a class opened after a method as a real nested class, every local
    // below it shipped as class state. Confirmed on gson's ParseBenchmark.
    const ANON_NEW_HEAD = /\bnew\s+([\w.]+)\s*(?:<[^>]*>)?\s*\(/;
    const matchAnonNew = (line) => {
      const head = ANON_NEW_HEAD.exec(line);
      if (!head) return null;
      const openAt = head.index + head[0].length - 1;
      if (readBalancedParens(line, openAt) === null) return null;
      let depth = 0;
      let close = -1;
      for (let k = openAt; k < line.length; k++) {
        if (line[k] === '(') depth++;
        else if (line[k] === ')' && --depth === 0) { close = k; break; }
      }
      return /^\s*\{\s*$/.test(line.slice(close + 1)) ? head : null;
    };
    const ENUM_CONST = /^\s*([A-Z][A-Z0-9_]*)\s*(?:\([^;{]*\))?\s*\{\s*$/;
    const anonOrdinalByOwner = new Map();
    const derivedScopes = [];

    for (let i = 0; i < sourceLines.length; i++) {
      const raw = sourceLines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      const lineNo = i + 1;

      let scopeName = null;
      const owningEnum = enumRanges.find((r) => lineNo > r.start && lineNo <= r.end);
      const anon = matchAnonNew(raw);
      if (anon) {
        const outer = innermostClassAt(lineNo);
        const outerName = outer ? nodes[outer.nodeIndex].name : path.basename(filePath, path.extname(filePath));
        const next = (anonOrdinalByOwner.get(outerName) || 0) + 1;
        anonOrdinalByOwner.set(outerName, next);
        scopeName = `${outerName}$${next}`;
      } else if (owningEnum) {
        const constMatch = ENUM_CONST.exec(raw);
        if (constMatch && lineNo !== owningEnum.start) scopeName = `${owningEnum.name}.${constMatch[1]}`;
      }
      if (!scopeName) continue;

      const endLine = braceBlockEndLine(lineNo);
      if (endLine == null || endLine <= lineNo) continue;
      derivedScopes.push({ name: scopeName, line: lineNo, endLine, anonymous: Boolean(anon), base: anon ? anon[1] : null });
    }

    for (const scope of derivedScopes) {
      const nd = {
        node_type: 'CLASS', name: scope.name,
        // Inferred: the grammar never names these scopes. The name is ours, so the tier says so.
        confidence_tier: 'INFERRED', confidence: 0.9,
        summary: scope.anonymous
          ? `anonymous ${scope.base} implementation`
          : `enum constant body ${scope.name}`,
        line: scope.line, kind: scope.anonymous ? 'anonymous_class' : 'enum_constant',
        start_line: scope.line, end_line: scope.endLine,
      };
      if (scope.base) nd.extends = scope.base;
      classEntries.push({ nodeIndex: nodes.length, line: scope.line, indent: null, blockEndLine: scope.endLine });
      nodes.push(nd);
    }
  }

  const innermostClassEntryAt = (lineNo) => classEntries
    .filter((e) => e.blockEndLine != null && e.line <= lineNo && lineNo <= e.blockEndLine)
    .sort((a, b) => (a.blockEndLine - a.line) - (b.blockEndLine - b.line))[0] || null;

  try {
    for (const fn of extractFunctions(content, lang)) {
      if (!fn.name) continue;
      if (fn.isCtorCandidate) {
        const owner = innermostClassEntryAt(fn.line);
        if (!owner || nodes[owner.nodeIndex].name !== fn.name) continue;
      }
      // An annotation element (`boolean serialize() default true;` inside `@interface Expose`)
      // has a method shape but is an attribute declaration, not a callable method — tree-sitter
      // models it as annotation_type_element_declaration. Emitting it as METHOD was 9 of gson's
      // false positives.
      if (lang === LANG.JAVA) {
        const owner = innermostClassEntryAt(fn.line);
        if (owner && nodes[owner.nodeIndex].kind === 'annotation') continue;
      }
      const nd = {
        node_type: 'METHOD', name: fn.name, confidence_tier: 'EXTRACTED', confidence: 1.0,
        summary: `${fn.isAsync ? 'async ' : ''}${fn.name}(${fn.params || ''})${fn.returnType ? ': ' + fn.returnType : ''}`,
        line: fn.line,
        start_line: fn.line,
        end_line: null,
        _sourceFile: filePath,
      };
      nd.end_line = blockEndLine(fn.line, lang === LANG.PYTHON ? pythonIndentAt(fn.line) : null);
      // The body scan stays anchored on the signature; only the reported start moves back.
      if (lang === LANG.JAVA) nd.start_line = declStartLine(fn.line);
      if (fn.params !== undefined) nd.params     = fn.params;
      if (fn.returnType)           nd.returnType = fn.returnType;
      if (fn.isAsync)              nd.isAsync    = true;
      if (fn.isStatic)             nd.isStatic   = true;
      if (fn.visibility)           nd.visibility = fn.visibility;
      if (fn.receiver)             nd.receiver   = fn.receiver;
      if (fn.decorators)           nd.decorators = fn.decorators;
      const phpNamespace = lang === LANG.PHP ? phpNamespaceAt(fn.line) : null;
      if (phpNamespace)            nd.namespace  = phpNamespace;
      methodEntries.push({
        nodeIndex: nodes.length,
        line: fn.line,
        indent: lang === LANG.PYTHON ? pythonIndentAt(fn.line) : null,
      });
      nodes.push(nd);
    }
  } catch (_) {}

  // IMPORT nodes retired — every import
  // becomes a fact on `importFacts` instead of a same-file stub node.
  try {
    for (const imp of extractImports(content, lang)) {
      if (!imp.source || (imp.source.startsWith('.') && lang !== LANG.PYTHON)) continue;
      if (imp.kind === 'require_relative') continue;
      if (imp.kind === 'include') {
        const targetName = imp.source.split('::').pop();
        if (classEntries.some((entry) => nodes[entry.nodeIndex].name === targetName)) continue;
      }
      if (/^(?:crate|super|self)::/.test(imp.source)) continue;
      if (lang === LANG.PYTHON && Array.isArray(imp.bindings)) {
        for (const binding of imp.bindings) {
          importFacts.push({ name: binding.name, module: imp.source, alias: binding.alias, line: imp.line ?? null });
        }
        continue;
      }
      // buildImportInfo already split a plain class import into {name: simple class name,
      // module: package, alias: name} for LANG.JAVA — using imp.source for both name and module
      // below would stamp the whole FQCN as the module, which still happens to prefix-match in
      // cross-repo-edge-resolver.js's matchProvider(), but as `name` it can never equal a
      // declared class's simple name, and as a derived alias
      // (`imp.alias || module.split('/').pop()`) it can never equal a call's receiver either —
      // silently breaking cross-repo symbol/qualified-call resolution for every Java import.
      if (lang === LANG.JAVA && imp.name) {
        importFacts.push({ name: imp.name, module: imp.module ?? null, alias: imp.alias ?? null, line: imp.line ?? null });
        continue;
      }
      importFacts.push({ name: imp.source, module: imp.source, alias: null, line: imp.line ?? null });
      if (lang === LANG.PYTHON && imp.alias) {
        importFacts[importFacts.length - 1].alias = imp.alias;
      }
    }
    importFacts.push(...extractReExportFacts(content, lang));
  } catch (_) {}

  // DEFINED_IN: each METHOD → the last CLASS declared at or before its line.
  // Go is excluded — Go methods are declared outside the struct body; receiver-based
  // lookup (below) handles Go instead.
  const structuralEdges = [];

  // Java FIELD plane. Fields were not extracted at all — `private String city;` produced no
  // node, so the graph had methods and classes but no data model. That costs three things at
  // once: the JPA mapping (`@Column`, `@Id`, `@ManyToOne`) is invisible, a class's state has no
  // representation to retrieve, and the field-name → declared-type map that call resolution
  // needs to turn `visitRepository.findById(...)` into an exact target does not exist.
  // A field is a declaration inside a class body and outside every method body — both spans
  // are known now, which is what makes this separable from local variables by construction
  // rather than by guessing.
  // Extended to C#. C# field syntax is the same shape — `[modifiers] Type name;`
  // — and the plane is only reached there when the grammar has given up on a file, which is
  // exactly where losing every field hurts most: 1,315 of efcore's fields were in files the C#
  // grammar could not parse. Properties (`public int X { get; set; }`) are included by allowing
  // `{` and `=>` as terminators; a method cannot match, because it has `(` where this requires
  // a terminator.
  if ((lang === LANG.JAVA || lang === LANG.CSHARP) && classEntries.length > 0) {
    const _isCs = lang === LANG.CSHARP;
    const FIELD_RE = new RegExp(
      '^\\s*(?:(public|private|protected' + (_isCs ? '|internal' : '') + ')\\s+)?'
      + (_isCs
        ? '((?:(?:static|readonly|const|volatile|override|virtual|abstract|sealed|new|extern|unsafe|required|partial|protected|internal)\\s+)*)'
        : '((?:(?:static|final|transient|volatile)\\s+)*)')
      // C# nullable annotations are part of the type: `decimal?`, `string?`, `string[]?`.
      // Without them the pattern silently skips every nullable field, which in modern C# is a
      // large fraction of them.
      + '([A-Za-z_$][\\w.$]*(?:\\s*<[^;=]*>)?' + (_isCs ? '\\??' : '')
      + '(?:\\s*\\[\\s*\\])*' + (_isCs ? '\\??' : '') + ')\\s+'
      // Terminator is `;` OR `=`. Requiring `;` on the declaration line missed every field
      // whose initializer wraps — `private static final Excluder CUSTOM_EXCLUDER =\n  ...;` —
      // which is 108 of gson's 1,075 fields, and the norm for adapter/constant declarations.
      // A method cannot match here: it has `(` where this requires `;` or `=`.
      // `,` joins a multi-declarator statement: `volatile long q8, q9, q10;` declares eight
      // fields, and requiring `;` or `=` matched none of them at all. rxjava pads cache lines
      // this way and guava declares coordinate pairs the same; 1,555 of the held-out corpus's
      // fields, against a handful on the development repos.
      + '([a-zA-Z_$][\\w$]*)\\s*(?:;|,|=' + (_isCs ? '|\\{|=>' : '') + ')'
    );
    // C# convention puts an expression-bodied property's `=>` on the NEXT line:
    //   protected override string StoreName
    //       => "ComplexTypesTrackingTest";
    // The declaration line then ends right after the name. Accepting a bare end-of-line is
    // only safe when the following non-blank line opens a body, because `Type name` alone on a
    // line is also what a wrapped parameter list looks like. efcore: 619 properties.
    const FIELD_HEAD_RE = _isCs ? new RegExp(
      '^\\s*(?:(public|private|protected|internal)\\s+)?'
      + '((?:(?:static|readonly|const|volatile|override|virtual|abstract|sealed|new|extern|unsafe|required|partial|protected|internal)\\s+)*)'
      + '([A-Za-z_$][\\w.$]*(?:\\s*<[^;=]*>)?\\??(?:\\s*\\[\\s*\\])*\\??)\\s+'
      + '([a-zA-Z_$][\\w$]*)\\s*$'
    ) : null;
    const _bodyOpensNext = (idx) => {
      for (let j = idx + 1; j < Math.min(sourceLines.length, idx + 3); j++) {
        const t = sourceLines[j].trim();
        if (!t) continue;
        return t.startsWith('=>') || t === '{';
      }
      return false;
    };
    const classSpans = classEntries.filter((e) => e.blockEndLine != null);
    const methodSpans = methodEntries
      .map((e) => ({ start: e.line, end: nodes[e.nodeIndex].end_line ?? e.line }))
      .filter((s) => s.end >= s.start);

    // Static and instance initializer blocks hold executable code but are not methods, so
    // without them every local declared in a `static { ... }` block reads as class state —
    // 639 of netty's false-positive fields, and netty leans on static blocks heavily.
    // They are added to the same span list as methods so the "class nested inside an
    // executable body still has real fields" rule applies to them identically.
    // A type whose header wraps puts its OWN opening brace on a line by itself:
    //     public abstract class NumericNode
    //         extends ValueNode
    //     {
    // That line matches the initializer pattern exactly, so the class body was registered as
    // an executable span and every field in the class read as a local. It is the dominant
    // brace style in jackson-databind, guava and rxjava, and it cost 5,846 of the held-out
    // corpus's 36,440 fields while the seven development repos — all same-line-brace — showed
    // nothing. Each type's own opening brace is found once and excluded.
    const fieldArgList = _isCs ? null : argListContinuationMask(sourceLines, lang);
    const classOpenBraces = new Set();
    for (const c of classSpans) {
      for (let i = c.line - 1; i < Math.min(c.blockEndLine, sourceLines.length); i++) {
        const idx = sourceLines[i].indexOf('{');
        if (idx >= 0) { classOpenBraces.add(i + 1); break; }
      }
    }
    for (let i = 0; i < sourceLines.length; i++) {
      const lineNo = i + 1;
      if (!/^\s*(?:static\s*)?\{\s*$/.test(sourceLines[i])) continue;
      if (classOpenBraces.has(lineNo)) continue;
      if (!classSpans.some((c) => c.line < lineNo && lineNo <= c.blockEndLine)) continue;
      if (methodSpans.some((s) => lineNo >= s.start && lineNo <= s.end)) continue;
      const end = braceBlockEndLine(lineNo);
      if (end != null && end > lineNo) methodSpans.push({ start: lineNo, end });
    }

    // A field initialised with a BLOCK lambda holds executable code at class level:
    //   public static final Function<Option, String> COMPLEX_DEPRECATED_FORMAT = o -> {
    //       final StringBuilder sb = new StringBuilder(...);
    // Every local in that block sat outside all three span kinds above, so it read as class
    // state — 8 of commons-cli's phantom fields. Same treatment as an initializer block: the
    // span is executable, so the locals in it are locals.
    if (!_isCs) {
      for (let i = 0; i < sourceLines.length; i++) {
        const lineNo = i + 1;
        if (!/->\s*\{\s*$/.test(sourceLines[i])) continue;
        if (methodSpans.some((s) => lineNo >= s.start && lineNo <= s.end)) continue;
        const end = braceBlockEndLine(lineNo);
        // From the NEXT line: this line declares the field, and only the block below it is
        // executable. Spanning it too deleted the field the lambda is assigned to.
        if (end != null && end > lineNo + 1) methodSpans.push({ start: lineNo + 1, end });
      }
    }

    for (let i = 0; i < sourceLines.length; i++) {
      const lineNo = i + 1;
      const raw = sourceLines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')
        || trimmed.startsWith('/*')) continue;
      // A field never begins inside an unclosed `(`. gson wraps a record header over its
      // components — `private record RecordWithPrimitives(\n  String aString,\n  byte aByte,`
      // — and each component line matched the field shape exactly.
      if (fieldArgList && fieldArgList[i]) continue;
      // Being inside a method span does not by itself make this a local variable: a local or
      // anonymous class declared in a method body has real fields, and they sit inside that
      // method's span too. What separates them is nesting order — if the innermost class
      // containing this line was itself opened after the innermost method, the line is in the
      // class's body, not the method's. gson has 123 such fields.
      const innerMethod = methodSpans
        .filter((s) => lineNo >= s.start && lineNo <= s.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (innerMethod) {
        const innerClass = classSpans
          .filter((c) => c.line < lineNo && lineNo <= c.blockEndLine)
          .sort((a, b) => (a.blockEndLine - a.line) - (b.blockEndLine - b.line))[0];
        if (!innerClass || innerClass.line <= innerMethod.start) continue;
      }

      // `@Autowired private Foo foo;` puts the annotation and the declaration on one line.
      // Strip leading annotations and match against what remains, keeping them as decorators.
      const inlineDecorators = [];
      let declPart = trimmed;
      for (;;) {
        const lead = /^@([\w.]+)(\([^)]*\))?\s*/.exec(declPart);
        if (!lead) break;
        inlineDecorators.push(lead[0].trim());
        declPart = declPart.slice(lead[0].length);
      }
      if (!declPart) continue;

      const owner = classSpans
        .filter((c) => c.line < lineNo && lineNo <= c.blockEndLine)
        .sort((a, b) => (a.blockEndLine - a.line) - (b.blockEndLine - b.line))[0];
      if (!owner) continue;

      // A field declaration wraps between its type and its name exactly as a method signature
      // does — `private static final com.google.protobuf.Descriptors.Descriptor\n    name;` —
      // and the scan reads one line, so neither half matched. protobuf's Java gencode declares
      // every descriptor this way. Joined only when this line cannot terminate a statement and
      // the next one is a bare name followed by `;` or `=`, which no expression continuation is.
      // The reported line stays the head, which is where both referees anchor it.
      if (!_isCs && !/[;={}()]/.test(declPart)) {
        for (let j = i + 1; j < Math.min(sourceLines.length, i + 3); j++) {
          const nxt = sourceLines[j].trim();
          if (!nxt) continue;
          if (/^[a-zA-Z_$][\w$]*\s*(?:\[\s*\])*\s*[;=,]/.test(nxt)) declPart = `${declPart} ${nxt}`;
          break;
        }
      }
      let m = FIELD_RE.exec(declPart);
      if (!m && FIELD_HEAD_RE && _bodyOpensNext(i)) m = FIELD_HEAD_RE.exec(declPart);
      if (!m) continue;
      const rawType = m[3].replace(/\s+/g, '');
      const fieldName = m[4];
      // `return x;`/`throw e;` cannot appear at class-body level, but a bare `Foo bar;` and a
      // control keyword share a shape, so refuse the keywords outright rather than rely on it.
      if (JAVA_MODIFIER_KEYWORDS.has(rawType) || CALL_EXPR_KEYWORDS.has(rawType)
        || JAVA_NON_TYPE_KEYWORDS.has(rawType)) continue;

      // Only a line that is ENTIRELY an annotation belongs to this field. Requiring that
      // stops the previous field's own `@Autowired private Foo foo;` line from being read as
      // this one's decorator.
      const decorators = [];
      for (let d = i - 1; d >= 0; d--) {
        const dl = sourceLines[d].trim();
        if (/^@\w+(?:\([^)]*\))?$/.test(dl)) { decorators.unshift(dl); continue; }
        if (dl === '' || dl.startsWith('//') || dl.startsWith('*')) continue;
        break;
      }
      decorators.push(...inlineDecorators);

      const modifiers = m[2] || '';
      // `private int a, b, c;` declares three fields of one type. Only the first name was ever
      // read. Additional declarators are collected at bracket depth 0 so an initializer
      // containing a comma (`int[] a = {1, 2}, b;`, `Map<K, V> m;`) cannot introduce one.
      const names = [fieldName];
      {
        let rest = declPart.slice(m.index + m[0].length - 1);
        let depth = 0;
        let seg = '';
        const segments = [];
        for (let c = 0; c < rest.length; c++) {
          const ch = rest[c];
          if ('([{<'.includes(ch)) depth++;
          else if (')]}>'.includes(ch)) depth--;
          if (ch === ';' && depth <= 0) break;
          if (ch === ',' && depth <= 0) { segments.push(seg); seg = ''; continue; }
          seg += ch;
        }
        segments.push(seg);
        for (const part of segments.slice(1)) {
          const nm = /^\s*([a-zA-Z_$][\w$]*)\s*(?:\[\s*\])*\s*(?:=|$)/.exec(part);
          if (nm && !JAVA_MODIFIER_KEYWORDS.has(nm[1]) && !CALL_EXPR_KEYWORDS.has(nm[1])) {
            names.push(nm[1]);
          }
        }
      }
      for (const declaredName of names) {
      const nd = {
        node_type: 'FIELD', name: declaredName,
        confidence_tier: 'EXTRACTED', confidence: 1.0,
        summary: `${rawType} ${declaredName}`,
        line: lineNo, start_line: lineNo, end_line: lineNo,
        field_type: rawType.replace(/<.*>/, ''),
        parent_class: nodes[owner.nodeIndex].name,
        _sourceFile: filePath,
      };
      if (m[1]) nd.visibility = m[1];
      if (/\bstatic\b/.test(modifiers)) nd.isStatic = true;
      if (/\bfinal\b/.test(modifiers)) nd.isFinal = true;
      if (decorators.length) nd.decorators = decorators;
      structuralEdges.push({ fromIndex: nodes.length, toIndex: owner.nodeIndex, edgeType: 'DEFINED_IN', evidenceLine: lineNo });
      nodes.push(nd);
      }
    }
  }

  // Java enum constants. JLS §8.9.3 makes each one an implicitly public static final field of
  // the enum type, and `getDeclaredFields()` returns them — which is why the Roslyn, tsc and
  // ext/ast referees all put their language's equivalent on the field plane. We emitted only
  // the ones carrying a class body (those become scopes above, on the type plane); the other
  // 1,885 in the Java corpus produced no node at all, so `Status.ACTIVE` was unresolvable.
  // They cannot come from FIELD_RE: an enum
  // constant has no declared type, and `RED, GREEN, BLUE;` declares three of them on one line.
  if (lang === LANG.JAVA && classEntries.some((e) => nodes[e.nodeIndex].kind === 'enum')) {
    // A `{`, `,` or `;` inside a string, char literal, comment or text block ends the constant
    // list early or late; blanking non-code first is what makes the scan below a scan rather
    // than a guess. Offsets are preserved so reported lines stay true.
    const codeOnly = [];
    let inBlockComment = false; let inString = false; let inChar = false;
    let inTextBlock = false; let escaped = false;
    for (const line of sourceLines) {
      let buf = '';
      for (let j = 0; j < line.length; j++) {
        const ch = line[j]; const next = line[j + 1];
        if (inTextBlock) {
          if (line.startsWith('"""', j)) { inTextBlock = false; buf += '   '; j += 2; } else buf += ' ';
          continue;
        }
        if (inBlockComment) {
          if (ch === '*' && next === '/') { inBlockComment = false; buf += '  '; j++; } else buf += ' ';
          continue;
        }
        if (inString || inChar) {
          buf += ' ';
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (inString && ch === '"') inString = false;
          if (inChar && ch === "'") inChar = false;
          continue;
        }
        if (ch === '/' && next === '*') { inBlockComment = true; buf += '  '; j++; continue; }
        if (ch === '/' && next === '/') { buf += ' '.repeat(line.length - j); break; }
        if (line.startsWith('"""', j)) { inTextBlock = true; buf += '   '; j += 2; continue; }
        if (ch === '"') { inString = true; buf += ' '; continue; }
        if (ch === "'") { inChar = true; buf += ' '; continue; }
        buf += ch;
      }
      codeOnly.push(buf);
    }

    for (const entry of classEntries) {
      const owner = nodes[entry.nodeIndex];
      if (!owner || owner.kind !== 'enum' || entry.blockEndLine == null) continue;

      // Anchor past the enum's own name so an inline `@SuppressWarnings({"x"}) public enum E {`
      // does not open the body at the annotation's brace.
      const declLine = codeOnly[entry.line - 1] || '';
      const kw = new RegExp(`\\benum\\s+${owner.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(declLine);
      let row = entry.line - 1;
      let colFrom = kw ? kw.index + kw[0].length : 0;
      let open = -1;
      for (; row < Math.min(entry.blockEndLine, codeOnly.length); row++) {
        const idx = codeOnly[row].indexOf('{', row === entry.line - 1 ? colFrom : 0);
        if (idx >= 0) { open = idx; break; }
      }
      if (open < 0) continue;

      const chars = []; const lineOf = [];
      for (let r = row; r < Math.min(entry.blockEndLine, codeOnly.length); r++) {
        const s = codeOnly[r];
        for (let c = r === row ? open + 1 : 0; c < s.length; c++) { chars.push(s[c]); lineOf.push(r + 1); }
        chars.push('\n'); lineOf.push(r + 1);
      }

      let p = 0;
      const skipWs = () => { while (p < chars.length && /\s/.test(chars[p])) p++; };
      const skipBalanced = (o, c) => {
        let d = 0;
        for (; p < chars.length; p++) {
          if (chars[p] === o) d++;
          else if (chars[p] === c) { d--; if (d === 0) { p++; return true; } }
        }
        return false;
      };
      for (;;) {
        skipWs();
        while (p < chars.length && chars[p] === '@') {
          p++;
          while (p < chars.length && /[\w.]/.test(chars[p])) p++;
          skipWs();
          if (chars[p] === '(' && !skipBalanced('(', ')')) { p = chars.length; break; }
          skipWs();
        }
        if (p >= chars.length || !/[A-Za-z_$]/.test(chars[p])) break;
        const from = p;
        while (p < chars.length && /[\w$]/.test(chars[p])) p++;
        const name = chars.slice(from, p).join('');
        const line = lineOf[from];
        skipWs();
        if (chars[p] === '(' && !skipBalanced('(', ')')) break;
        skipWs();
        if (chars[p] === '{' && !skipBalanced('{', '}')) break;
        skipWs();
        // Accept only on a real separator. Without this the scan reads the first token of a
        // constant-less enum's body (`private static final Foo x;` → `private`) as a constant.
        const term = chars[p];
        if (term !== ',' && term !== ';' && term !== '}') break;
        structuralEdges.push({ fromIndex: nodes.length, toIndex: entry.nodeIndex, edgeType: 'DEFINED_IN', evidenceLine: line });
        nodes.push({
          node_type: 'FIELD', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
          kind: 'enum_constant', summary: `enum constant ${owner.name}.${name}`,
          field_type: owner.name, parent_class: owner.name,
          visibility: 'public', isStatic: true, isFinal: true,
          line, start_line: line, end_line: line,
          _sourceFile: filePath,
        });
        if (term !== ',') break;
        p++;
      }
    }
  }

  if (lang !== LANG.GO && classEntries.length > 0 && methodEntries.length > 0) {
    const sortedClasses = [...classEntries].sort((a, b) => a.line - b.line);
    const rustImplRanges = lang === LANG.RUST
      ? sourceLines.flatMap((line, index) => {
        const match = line.match(/^\s*(?:unsafe\s+)?impl(?:\s+[^\s{]+\s+for)?\s+([\w:]+)(?:<[^>]+>)?\s*\{/);
        if (!match) return [];
        const endLine = braceBlockEndLine(index + 1);
        return endLine == null ? [] : [{ typeName: match[1].split('::').pop(), line: index + 1, endLine }];
      })
      : [];
    for (const method of methodEntries) {
      let containingClass = null;
      if (lang === LANG.PYTHON) {
        const candidates = sortedClasses.filter((cls) => (
          cls.line < method.line
          && cls.indent < method.indent
          && method.line <= cls.blockEndLine
        ));
        containingClass = candidates.sort((a, b) => b.indent - a.indent || b.line - a.line)[0] || null;
      } else if (lang === LANG.RUST) {
        const declarationOwner = sortedClasses
          .filter((cls) => cls.line < method.line && cls.blockEndLine != null && method.line <= cls.blockEndLine)
          .sort((a, b) => (a.blockEndLine - a.line) - (b.blockEndLine - b.line))[0] || null;
        const implOwner = rustImplRanges
          .filter((range) => range.line < method.line && method.line <= range.endLine)
          .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0] || null;
        containingClass = declarationOwner;
        if (!containingClass && implOwner) {
          containingClass = sortedClasses.find((cls) => nodes[cls.nodeIndex].name === implOwner.typeName) || null;
        }
      } else {
        // Innermost class whose span actually contains the method. The previous rule was
        // "last class declared above the method", which has no notion of a class ending — so
        // in a file with an inner class, or two top-level types, every method after the first
        // class closed was still attributed to it. Spans exist for brace languages now, so
        // prefer real containment and keep the positional rule only where they do not.
        const spanned = sortedClasses.filter((cls) => (
          cls.blockEndLine != null && cls.line <= method.line && method.line <= cls.blockEndLine
        ));
        if (spanned.length) {
          containingClass = spanned.sort((a, b) => (a.blockEndLine - a.line) - (b.blockEndLine - b.line))[0];
        } else {
          for (const cls of sortedClasses) {
            if (cls.line <= method.line) containingClass = cls;
            else break;
          }
        }
      }
      if (containingClass) {
        nodes[method.nodeIndex].parent_class = nodes[containingClass.nodeIndex].name;
        structuralEdges.push({ fromIndex: method.nodeIndex, toIndex: containingClass.nodeIndex, edgeType: 'DEFINED_IN', evidenceLine: method.line ?? null });
      }
    }
  }

  // Go: DEFINED_IN via receiver field — Go methods are declared outside the struct body
  // (func (s *Server) Handle() {}) so line-containment never fires. Use the receiver
  // field captured by buildFuncInfo() to link each method to its struct.
  if (lang === LANG.GO && classEntries.length > 0 && methodEntries.length > 0) {
    const goClassByName = new Map(
      classEntries.map(ce => [nodes[ce.nodeIndex].name, ce])
    );
    for (const me of methodEntries) {
      const recv = nodes[me.nodeIndex].receiver;
      if (!recv) continue;
      // receiver is stored as "varName TypeName" (e.g. "s Server" or "c *Client")
      // extract the type name (second token) and strip pointer prefix
      const parts = recv.trim().split(/\s+/);
      const rawType = parts[parts.length - 1];
      const structName = rawType.replace(/^\*/, '').trim();
      const matchedClass = goClassByName.get(structName);
      if (matchedClass) {
        structuralEdges.push({
          fromIndex: me.nodeIndex,
          toIndex: matchedClass.nodeIndex,
          edgeType: 'DEFINED_IN',
          evidenceLine: me.line ?? null,
        });
      }
    }
  }

  // EXTENDS / IMPLEMENTS: collected by name; resolved after all files are processed.
  const inheritanceEdges = [];

  /**
   * Annotation/decorator names on a node, normalised to a resolvable target.
   *
   * `extractClasses` stores raw source lines (`@Table(name = "owners")`, `@Autowired`,
   * `@app.route("/x")`), so this strips the `@` and any argument list.
   *
   * Two shapes, because the languages genuinely differ:
   *
   * **Java/Kotlin/C#** — an annotation is a TYPE, conventionally capitalised, and the import is
   * `import jakarta.persistence.Entity`, so the resolvable key is the SIMPLE name (`Entity`).
   * Lowercase is refused: a lowercase Java annotation essentially does not exist, and matching one
   * would only bind noise.
   *
   * **Python/JS/TS/Ruby** — a decorator is normally a FUNCTION and snake_case, and it is qualified
   * at the use site (`@register.filter`, `@pytest.fixture`). Applying the capitalisation rule here
   * dropped 100% of them: django-machina has 158 decorators and not one starts with a capital, so
   * this emitted 0. The DOTTED form is kept, because the resolver's
   * external-import rung binds `register.filter` through the root `register` — the simple name
   * `filter` would bind to nothing, or worse, to some unrelated local `filter`.
   *
   * These are the cross-cutting facts a Django graph is otherwise missing entirely: `@receiver` is
   * a signal handler, `@register.filter` is a template tag, `@login_required` is an auth boundary.
   */
  // Kotlin is absent because EXT_TO_AST_LANG maps `.kt`/`.kts` onto `java` —
  // the annotation convention is the same there anyway.
  const DECORATOR_SIMPLE_NAME_LANGS = new Set([LANG.JAVA, LANG.CSHARP]);
  function decoratorTargets(nd) {
    const raw = Array.isArray(nd?.decorators) ? nd.decorators : [];
    const useSimpleName = DECORATOR_SIMPLE_NAME_LANGS.has(lang);
    const out = [];
    const seen = new Set();
    for (const d of raw) {
      const m = /^@\s*([A-Za-z_$][\w$.]*)/.exec(String(d).trim());
      if (!m) continue;
      const target = useSimpleName ? m[1].split('.').pop() : m[1];
      if (!target) continue;
      if (useSimpleName && !/^[A-Z]/.test(target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
    return out;
  }
  for (const ce of classEntries) {
    const nd = nodes[ce.nodeIndex];
    if (nd.extends) {
      const targetName = nd.extends.replace(/<.*>/, '').trim();
      if (targetName) inheritanceEdges.push({ fromIndex: ce.nodeIndex, toName: targetName, edgeType: 'EXTENDS', evidenceLine: ce.line ?? null });
    }
    if (Array.isArray(nd.implements)) {
      for (const iface of nd.implements) {
        const targetName = iface.replace(/<.*>/, '').trim();
        if (targetName) inheritanceEdges.push({ fromIndex: ce.nodeIndex, toName: targetName, edgeType: 'IMPLEMENTS', evidenceLine: ce.line ?? null });
      }
    }

    // DECORATED_BY — annotations/decorators as first-class edges.
    //
    // The decorators were already being collected here (`extractClasses` walks the lines above a
    // class declaration) and then dropped on the floor, on the grounds that DECORATED_BY was
    // "outside the closed EDGE_TYPES vocabulary" — a constraint that has since expired:
    // DECORATED_BY is in graph-vocabulary.js and ingest-post-tail.js already runs a
    // resolveDecoratedByEdges pass. Nobody revisited the decision.
    //
    // On a Spring codebase this is not decoration, it is the architecture: @Entity is what makes a
    // class a table, @RestController what makes it an endpoint, @Transactional what marks a
    // transaction boundary. Emitted by NAME into the same deferred bucket EXTENDS/IMPLEMENTS use,
    // so an annotation declared in another file resolves through the existing branch-wide pass and
    // an unresolvable one is refused rather than guessed.
    for (const ann of decoratorTargets(nd)) {
      inheritanceEdges.push({
        fromIndex: ce.nodeIndex, toName: ann, edgeType: 'DECORATED_BY', evidenceLine: ce.line ?? null,
      });
    }
  }

  /**
   * Types named in a method's parameter list, including generic arguments.
   *
   * `params` is the raw source slice — e.g.
   * `"OwnerRepository owners, List<Pet> pets, @Valid Pet pet"` — so this pulls every capitalised
   * identifier out of it and unwraps generics: `List<Pet>` yields both `List` (dropped as a builtin)
   * and `Pet` (kept).
   *
   * Builtins and single-letter type parameters are refused: an edge to `String`
   * or `T` is noise, not structure. Parameter NAMES
   * are excluded by the same capitalisation rule that keeps Java's convention readable.
   */
  function referencedTypeNames(paramsText) {
    if (!paramsText || typeof paramsText !== 'string') return [];
    const out = [];
    const seen = new Set();
    for (const m of String(paramsText).matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
      const name = m[1];
      if (name.length < 2) continue;               // `T`, `K`, `V` — type parameters
      if (NON_REFERENCEABLE_TYPES.has(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }

  for (const me of methodEntries) {
    const nd = nodes[me.nodeIndex];
    // Parameter types and the return type are the same relation here. `returnType` is
    // already captured by buildFuncInfo for every language whose pattern has a return group.
    for (const t of referencedTypeNames([nd?.params, nd?.returnType].filter(Boolean).join(' '))) {
      inheritanceEdges.push({
        fromIndex: me.nodeIndex, toName: t, edgeType: 'REFERENCES', evidenceLine: me.line ?? null,
      });
    }
  }

  // Declared FIELD types.
  //
  // koragraph creates no FIELD nodes, so there is nothing to hang a type off; the edge therefore runs
  // class → REFERENCES → FieldType. `extractInjectedDependencies`
  // already scans field declarations but only keeps DI-annotated ones (23 DEPENDS_ON edges) — this
  // covers the rest: `private LocalDate birthDate;`, `private PetType type;`, `private Set<Visit> visits;`.
  //
  // Attribution is by line range: a field belongs to the nearest class declared above it. That is
  // exact for one-class-per-file Java (all 49 petclinic files) and degrades to the enclosing outer
  // class for nested types, which is the conservative direction.
  if (lang === LANG.JAVA || lang === LANG.KOTLIN) {
    const sortedClasses = classEntries
      .filter((ce) => Number.isFinite(ce.line))
      .sort((a, b) => a.line - b.line);
    if (sortedClasses.length) {
      const srcLines = toLines(content);
      // `private final Foo bar;` / `protected Set<Visit> visits = ...;` — a modifier, a type, a
      // name, then `;` or `=`. Requires a modifier so locals and statements inside method bodies
      // are not mistaken for fields.
      const FIELD_DECL = /^\s*(?:public|private|protected)\s+(?:static\s+|final\s+|transient\s+|volatile\s+)*([A-Z][\w.<>,\s\[\]]*?)\s+[a-z_$][\w$]*\s*(?:=|;)/;
      for (let i = 0; i < srcLines.length; i += 1) {
        const m = FIELD_DECL.exec(srcLines[i]);
        if (!m) continue;
        let owner = null;
        for (const ce of sortedClasses) {
          if (ce.line <= i + 1) owner = ce; else break;
        }
        if (!owner) continue;
        for (const t of referencedTypeNames(m[1])) {
          inheritanceEdges.push({
            fromIndex: owner.nodeIndex, toName: t, edgeType: 'REFERENCES', evidenceLine: i + 1,
          });
        }
      }
    }
  }

  // Method-level annotations. Class-level annotations alone are not enough;
  // the rest sit on methods, which is where a Spring codebase keeps its routing and transaction
  // semantics (@GetMapping, @PostMapping, @Transactional, @Valid, @Test). extractFunctions already
  // collects these into the same `decorators` field, so this is the identical emission over the
  // method entries.
  for (const me of methodEntries) {
    const nd = nodes[me.nodeIndex];
    for (const ann of decoratorTargets(nd)) {
      inheritanceEdges.push({
        fromIndex: me.nodeIndex, toName: ann, edgeType: 'DECORATED_BY', evidenceLine: me.line ?? null,
      });
    }
  }

  // Rust: impl Trait for Struct → IMPLEMENTS inheritanceEdge
  // Rust expresses interface implementation via `impl Trait for Struct {}` blocks.
  // CLASS_PATTERNS for Rust match struct/enum/trait but not impl blocks, so we scan here.
  if (lang === LANG.RUST) {
    const implForRe = /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:unsafe\s+)?impl\s+([\w:]+(?:<[^>]+>)?)\s+for\s+(\w+)/gm;
    let im;
    // Comment-stripped, not raw `content` — this regex is anchored to line-start (`^...impl`) and
    // has no brace/body check, so a commented-out `// impl Foo for Bar` reads as a live trait
    // implementation and writes an IMPLEMENTS edge nothing in the code actually declares. Length
    // and newlines are unchanged by stripping, so `im.index`-based line math below still lines up.
    const implForScanText = stripComments(content, lang);
    while ((im = implForRe.exec(implForScanText)) !== null) {
      const traitName = im[1].split('::').pop().replace(/<.*>/, '').trim();
      const structName = im[2].trim();
      if (traitName && structName) {
        // Regex match, no AST node at hand — derive the line from the match offset
        // rather than leave it null when it's this cheap to compute.
        const evidenceLine = implForScanText.slice(0, im.index).split('\n').length;
        inheritanceEdges.push({ fromName: structName, toName: traitName, edgeType: 'IMPLEMENTS', evidenceLine });
      }
    }
  }

  // Ruby: include/extend/prepend Module → IMPLEMENTS inheritanceEdges
  // Ruby uses `include Module`, `extend Module`, `prepend Module` inside class bodies
  // to mix in behavior. CLASS_PATTERNS only match class/module declarations, so we
  // scan each class body here to pick up mixin statements.
  if (lang === LANG.RUBY && classEntries.length > 0) {
    const lines = content.split('\n');
    const mixinRe = /^\s+(?:include|extend|prepend)\s+([\w:]+)/;
    for (let ci = 0; ci < classEntries.length; ci++) {
      const classLine = classEntries[ci].line - 1; // 0-indexed
      const nextClassLine = ci + 1 < classEntries.length
        ? classEntries[ci + 1].line - 1
        : lines.length;
      const fromId = classEntries[ci].nodeIndex;
      for (let li = classLine; li < nextClassLine; li++) {
        const m = lines[li] && lines[li].match(mixinRe);
        if (m) {
          // strip module path prefix (Devise::Authenticatable → Authenticatable)
          const moduleName = m[1].split('::').pop();
          if (moduleName) {
            inheritanceEdges.push({ fromIndex: fromId, toName: moduleName, edgeType: 'IMPLEMENTS', evidenceLine: li + 1 });
          }
        }
      }
    }
  }

  // IMPORTS-to-stub emission retired —
  // importFacts (collected above) carries the same information to the FILE
  // node's properties.imports instead.

  // CALL EXPRESSIONS: scan each method's body for callee names.
  // Body range = declaration line + 1 → next class/method declaration line - 1.
  // Results stored on the node so ingest.js can persist them in properties JSONB
  // and a later pass can resolve them into CALLS edges.
  try {
    if (methodEntries.length > 0) {
      const lines = content.split('\n');
      const allBoundaryLines = [
        ...classEntries.map(e => nodes[e.nodeIndex].line),
        ...methodEntries.map(e => nodes[e.nodeIndex].line),
      ].sort((a, b) => a - b);
      allBoundaryLines.push(lines.length + 2); // sentinel

      for (const method of methodEntries) {
        const methodLine = nodes[method.nodeIndex].line; // 1-indexed
        // 0-indexed: body starts at index methodLine (= line methodLine+1 in 1-indexed)
        const bodyStartIdx = methodLine;
        // next boundary (1-indexed) → scan up to but not including that line
        const nextBoundary = allBoundaryLines.find(b => b > methodLine) || lines.length + 2;
        const bodyEndIdx = lang === LANG.PYTHON
          ? pythonBlockEndLine(methodLine, method.indent)
          : nextBoundary - 1;
        let callExprs = extractCallExpressionsFromBody(lines, bodyStartIdx, bodyEndIdx,
          { maskLiterals: lang === LANG.TYPESCRIPT || lang === LANG.JAVASCRIPT });
        if (lang === LANG.PYTHON) {
          callExprs = callExprs.filter((entry) => !/^\s*(?:async\s+)?def\s+/.test(lines[entry.line - 1] || ''));
        }
        if (callExprs.length > 0) {
          nodes[method.nodeIndex].callExpressions = callExprs;
        }
      }
    }
  } catch (_) {}

  // DEPENDS_ON: Java/C# @Autowired/@Inject / NestJS TypeScript constructor injection (GQ-7a / GQH-7a/7b/7c)
  // Attribute each injected type to the class declared before that line.
  // Go uses name-based attribution (dep.structName → classEntry.name) because NewXxx functions
  // are free functions not enclosed in the struct body — line-containment is unreliable for Go.
  try {
    if (classEntries.length > 0 && (lang === LANG.JAVA || lang === LANG.CSHARP || lang === LANG.TYPESCRIPT || lang === LANG.PYTHON || lang === LANG.GO)) {
      const injected = extractInjectedDependencies(content, lang);
      if (injected.length > 0) {
        const sortedClasses = [...classEntries].sort((a, b) => a.line - b.line);
        if (lang === LANG.GO) {
          // Build name→nodeIndex map for Go struct lookup by NewXxx suffix
          const goClassByName = new Map(
            classEntries.map(ce => [nodes[ce.nodeIndex].name, ce.nodeIndex])
          );
          for (const dep of injected) {
            // dep.structName is the suffix of NewXxx (e.g. "UserService" from "NewUserService")
            const targetNodeIndex = dep.structName ? goClassByName.get(dep.structName) : undefined;
            if (targetNodeIndex !== undefined) {
              inheritanceEdges.push({ fromIndex: targetNodeIndex, toName: dep.fieldType, edgeType: 'DEPENDS_ON', evidenceLine: dep.line ?? null });
            }
            // If structName doesn't match any known struct, drop — no false attribution.
          }
        } else {
          for (const dep of injected) {
            let containingClass = sortedClasses[0];
            for (const cls of sortedClasses) {
              if (cls.line <= dep.line) containingClass = cls;
              else break;
            }
            inheritanceEdges.push({ fromIndex: containingClass.nodeIndex, toName: dep.fieldType, edgeType: 'DEPENDS_ON', evidenceLine: dep.line ?? null });
          }
        }
      }
    }
  } catch (_) {}

  // DEPENDS_ON: JS/TS relative imports (GQ-7b) — resolved against file paths after all files
  const relImportSource = classEntries.length > 0 ? classEntries[0]
    : methodEntries.length > 0 ? methodEntries[0]
    : null;
  const relativeImportEdges = buildRelativeImportEdges(
    content, filePath, lang, relImportSource ? relImportSource.nodeIndex : null
  );

  // SQL/JPQL table/entity references (GQ-8) → READS_TABLE/WRITES_TABLE, and
  // config/env-var references (GQ-6a) → USES_CONFIG. Both resolved post-loop.
  const { sqlReferences, configValueRefs } = buildContentSideChannels(content, lang);

  // Label the regex plane too, so a silent fallback for a language that HAS a
  // grammar is visible in the graph instead of only inferable from missing detail.
  if (_bespokeRegexFallback) for (const nd of nodes) if (nd.extractor_tier === undefined) nd.extractor_tier = 'regex';
  // Separate statement rather than another term in `_bespokeRegexFallback` above, which several
  // concurrent routing changes are contending for. `.rb`/`.rs` reach this scanner only when
  // extractPortedTreeSitter declined (grammar failed to load) or when a caller went straight to
  // buildAstNodes; either way the scanner really is what produced these nodes, and until this
  // stamp existed both languages shipped `extractor_tier: undefined`, so the codebase's own
  // first diagnostic — "regex dominating means a broken tree-sitter setup" — could never fire
  // on them.
  if (ext === '.rb' || ext === '.rs') for (const nd of nodes) if (nd.extractor_tier === undefined) nd.extractor_tier = 'regex';

  // Java has no tree-sitter branch, so it is absent from the list above and every Java node
  // shipped with extractor_tier undefined — on the language the whole corpus is built on. The
  // tier is the only signal a consumer has for how a node was produced, and `undefined` reads
  // as a defect rather than as the answer. `.kt`/`.kts` also map to lang java but are already
  // stamped above, so this only reaches `.java`.
  if (lang === LANG.JAVA) for (const nd of nodes) if (nd.extractor_tier === undefined) nd.extractor_tier = 'regex';

  return { nodes, structuralEdges, inheritanceEdges, relativeImportEdges, sqlReferences, configValueRefs, importFacts };
}

// GQ-6a: extract env-var / config-key references per language.
// Returns [{ configKey, line }], deduplicated by configKey.
function extractConfigValueRefs(content, lang) {
  const lines = content.split('\n');
  const seen = new Set();
  const refs = [];

  function add(key, lineNum) {
    if (key && !seen.has(key)) {
      seen.add(key);
      refs.push({ configKey: key, line: lineNum });
    }
  }

  if (lang === 'java') {
    // Spring @Value("${key}") and @Value("${key:default}")
    const valueAnnotation = /@Value\s*\(\s*["']\$\{([^}:]+)[^}]*\}["']/g;
    // `lines.indexOf(line)` (what this loop used) returns the FIRST index of an
    // identical line, so every ref on a repeated line was stamped with the
    // wrong line number — and `_sourceNodeForReference` picks the owning METHOD
    // by line span, so a wrong number silently attaches the edge to the wrong
    // method. forEach's index is the actual line.
    lines.forEach((line, i) => {
      let m;
      while ((m = valueAnnotation.exec(line)) !== null) add(m[1], i + 1);
      valueAnnotation.lastIndex = 0;
      // System.getenv("KEY")
      const getenv = /System\.getenv\s*\(\s*["']([^"']+)["']/g;
      while ((m = getenv.exec(line)) !== null) add(m[1], i + 1);
      getenv.lastIndex = 0;
      // Spring's `Environment#getProperty("key")`
      // ("env.getProperty(\"k\")"). Matched on the METHOD name only (not a
      // specific receiver identifier — Spring commonly injects it as `env`,
      // but also `environment`/`this.env`), same "string-literal match only,
      // unique-or-refuse against a real CONFIG_VALUE node" safety net every
      // other pattern here relies on — a false-positive method name never
      // produces an edge unless its literal argument happens to also be a
      // real CONFIG_VALUE key.
      const envGetProperty = /\bgetProperty\s*\(\s*["']([^"']+)["']/g;
      while ((m = envGetProperty.exec(line)) !== null) add(m[1], i + 1);
      // MessageSource#getMessage("key", ...) — the i18n counterpart of the
      // patterns above. The message catalogues are CONFIG_VALUE nodes like any
      // other key/value bundle, and without this the only thing in a Spring
      // repo that names them is a template.
      const msgSource = /\bgetMessage\s*\(\s*["']([^"']+)["']/g;
      while ((m = msgSource.exec(line)) !== null) add(m[1], i + 1);
    });
  } else if (lang === 'python') {
    // os.environ["KEY"], os.environ['KEY'], os.getenv("KEY"), os.environ.get("KEY")
    const py = /os\.environ(?:\.get)?\s*\[\s*['"]([^'"]+)['"]\s*\]|os\.getenv\s*\(\s*['"]([^'"]+)['"]\)|os\.environ\.get\s*\(\s*['"]([^'"]+)['"]/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = py.exec(line)) !== null) add(m[1] || m[2] || m[3], i + 1);
    });
    // Django-style
    // `settings.KEY` attribute access.
    // Restricted to the literal `settings` identifier and an ALL-CAPS
    // attribute (Django's own convention, e.g. `settings.DEBUG`) to keep
    // this from matching arbitrary `<anything>.settings.<anything>` noise —
    // still only ever produces an edge on an exact CONFIG_VALUE.name match
    // (unique-or-refuse), same safety net as every other pattern here.
    const djSettings = /\bsettings\.([A-Z][A-Z0-9_]*)\b/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = djSettings.exec(line)) !== null) add(m[1], i + 1);
    });
    // gettext: _("Topics"), gettext_lazy("Topics"), ugettext("Topics"). The
    // msgid IS the key in a .po catalogue (contract-config.js#parsePoFile), so
    // these bind Python source straight to the locale files — the same bridge
    // @Value/getMessage give Java. Only an exact match against a real
    // CONFIG_VALUE name ever becomes an edge, so a `_()` that is not a
    // translation call produces nothing.
    const gettext = /\b(?:_|u?gettext(?:_lazy|_noop)?|pgettext(?:_lazy)?)\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?['"]([^'"]{2,})['"]\s*[,)]/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = gettext.exec(line)) !== null) add(m[1], i + 1);
    });
  } else if (lang === 'typescript' || lang === 'javascript') {
    // process.env.KEY, process.env["KEY"], process.env['KEY']
    const env = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([^'"]+)['"]\])/g;
    // configService.get("key") or configService.get<T>("key")
    const cfg = /configService\.get(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = env.exec(line)) !== null) add(m[1] || m[2], i + 1);
      while ((m = cfg.exec(line)) !== null) add(m[1], i + 1);
    });
  } else if (lang === 'go') {
    // os.Getenv("KEY"), viper.GetString("key"), viper.GetInt("key"), etc.
    const go = /os\.Getenv\s*\(\s*"([^"]+)"\)|viper\.Get\w+\s*\(\s*"([^"]+)"/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = go.exec(line)) !== null) add(m[1] || m[2], i + 1);
    });
  } else if (lang === 'ruby') {
    // ENV['KEY'], ENV["KEY"], ENV.fetch('KEY')
    const rb = /ENV\s*\[\s*['"]([^'"]+)['"]\s*\]|ENV\.fetch\s*\(\s*['"]([^'"]+)['"]/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = rb.exec(line)) !== null) add(m[1] || m[2], i + 1);
    });
  } else if (lang === 'php') {
    // env('KEY'), $_ENV['KEY'], $_ENV["KEY"]
    const php = /env\s*\(\s*['"]([^'"]+)['"]\)|\$_ENV\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = php.exec(line)) !== null) add(m[1] || m[2], i + 1);
    });
  } else if (lang === 'csharp') {
    // Configuration["Key"], _config["Key"], Environment.GetEnvironmentVariable("KEY")
    const cs = /(?:Configuration|_config)\s*\[\s*"([^"]+)"\s*\]|Environment\.GetEnvironmentVariable\s*\(\s*"([^"]+)"/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = cs.exec(line)) !== null) add(m[1] || m[2], i + 1);
    });
  } else if (lang === 'dart') {
    // String.fromEnvironment('KEY'), bool.fromEnvironment('KEY')
    const dart = /(?:String|bool|int)\.fromEnvironment\s*\(\s*['"]([^'"]+)['"]/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = dart.exec(line)) !== null) add(m[1], i + 1);
    });
  }

  return refs;
}

// ─── Generic tree-sitter symbol extractor ─────────────────────────────────────
//
// Runs on files not handled by the primary extractor, so grammars already on disk in
// node_modules/tree-sitter-wasms/out/ don't go unused. Keyed by extension, one
// generic pass per language using node-type heuristics instead of a bespoke
// per-language extractor. Emits CLASS for type-like declarations and METHOD
// for function-like declarations, both confidence_tier:'EXTRACTED' with real
// line spans.

const EXT_TO_GRAMMAR = Object.freeze({
  '.rs': 'rust',
  '.scala': 'scala',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.c': 'c', '.h': 'c',
  '.cs': 'c_sharp',
  '.swift': 'swift',
  '.ex': 'elixir', '.exs': 'elixir',
  '.lua': 'lua',
  '.php': 'php',
  '.rb': 'ruby',
  '.py': 'python',
  '.java': 'java',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  // .jsx re-pointed from 'javascript' to 'tsx': the tsx grammar is a superset of javascript's and
  // additionally parses JSX-with-types syntax .jsx files never use but never
  // conflict with either. This is safe ONLY because GENERIC_LANG_CONFIG.tsx
  // (below) exists — without it .jsx would parse to 0 nodes.
  '.jsx': 'tsx',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.vue': 'vue',
  '.dart': 'dart',
  '.sh': 'bash', '.bash': 'bash',
  '.zig': 'zig',
  '.m': 'objc', '.mm': 'objc',
  // These three grammars were vendored but unmapped, so a .sol/.ml/.res file
  // matched no extension here, was excluded from SUPPORTED_GRAMMAR_EXTS, and
  // therefore never reached the generic tier at all (ingest.js's
  // genericAstFiles filter gates on that Set) — zero nodes on every engine.
  // '.mli' is deliberately absent: OCaml interface files need the separate
  // ocaml_interface grammar, which is not vendored.
  '.sol': 'solidity',
  '.ml': 'ocaml',
  '.res': 'rescript',
});

/** Extensions the generic tree-sitter path can attempt (exported, used by coverage-audit.js). */
const SUPPORTED_GRAMMAR_EXTS = new Set(Object.keys(EXT_TO_GRAMMAR));

// ─── Vue single-file components ──────────────────────────────────────────────
//
// `.vue` has no grammar of its own: extractors/vue.js masks every non-`<script>`
// region to blank spaces (preserving newlines so line numbers stay true) and runs
// the masked source through the tree-sitter walk in extractors/base.js. The regex
// scanner below is measurably worse on the same files — a `function`/`class`
// literal inside a `<template>` string attribute makes it drop the real methods
// (measured: 1 node vs 0 on a template-trap fixture, and it misses `<script setup>`
// declarations and TS generics entirely) — so `.vue` routes here and nowhere else.
const vueExtractor = require('./extractors/vue.js');

// Adapts extractors/vue.js's base.js-contract result ({ nodes, edges: [{from,to,
// edge_type,resolution}] }) into the seven-key shape ingest-file-processor.js
// already knows how to write (structuralEdges: [{fromIndex,toIndex,edgeType}]
// indices into nodes[]). `resolution` is provenance, not consumed by the
// structural-edge writer.
//
// `unresolvedCalls` ({fromIndex, calleeName}) are walkGeneric's deferred
// cross-file call markers. ingest-file-processor.js#commitExtractedNodes converts
// fromIndex -> the written node id and queues it in pending.pendingEdges,
// mirroring how inheritanceEdges' {fromIndex, toName} are already handled, so
// resolveAndWriteEdges' module-stem pass gets a shot at it once the branch-wide
// fileIndex/symbolIndex exist.
//
// `inheritanceEdges` carries `result.unresolvedInheritance` — a supertype name
// walkGeneric could NOT resolve to a same-file `classByName` entry. A same-file
// supertype is already index-resolved by the extractor itself (`ctx.addEdge`,
// integer from/to) and flows through `structuralEdges` like any other edge, so
// it never reaches this bucket. `confidenceTier: 'INFERRED'` because this is the
// same fuzzy branch-wide name resolver the regex/tree-sitter plane uses for ALL
// its EXTENDS/IMPLEMENTS edges at `EXTRACTED` (~27.2% precision) — a name-guessed
// edge must not be stamped the top tier.
//
// `relativeImportEdges` stays `[]`: `EDGE_TYPES` is frozen to IMPORTS/CALLS/
// DEFINED_IN/EXTENDS/IMPLEMENTS/COUPLED_WITH/READS_TABLE/WRITES_TABLE, so there
// is no `DEPENDS_ON` for this plane to emit. TS/JS's import facts +
// registerImportFact already cover the equivalent ground.
function _adaptVueResult(result, filePath, content) {
  const nodes = (result.nodes || []).map((n) => ({
    ...n,
    _sourceFile: n._sourceFile || filePath,
  }));
  const structuralEdges = (result.edges || [])
    .filter((e) => Number.isInteger(e.from) && Number.isInteger(e.to))
    .map((e) => ({
      fromIndex: e.from, toIndex: e.to, edgeType: e.edge_type, resolution: e.resolution,
      // base.js#addEdge (:530-531) has always
      // carried evidence_line — this adapter dropped it on the floor. Preserve, don't
      // fabricate: absent/undefined becomes null, never a guessed line number.
      evidenceLine: e.evidence_line ?? null,
      // The intended callee name (present
      // on CALLS edges resolveCall could name; absent/null on DEFINED_IN/
      // IMPORTS/EXTENDS, which have no "callee") — ingest.js's writers persist
      // this as properties.called_name.
      calleeName: e.calleeName ?? null,
    }));
  const unresolvedCalls = (result.unresolvedCalls || [])
    .filter((c) => Number.isInteger(c.from) && c.calleeName)
    .map((c) => ({
      fromIndex: c.from, calleeName: c.calleeName,
      // base.js#walkCalls (:707) already provides `line`; this adapter dropped it too.
      // `receiverName` is forward-only (populated on the base.js side later) —
      // undefined today, so this is a no-op until then, not a fabricated value.
      line: c.line ?? null, receiverName: c.receiverName ?? null,
      // Forward-only,
      // like receiverName above — 'CALLS' for every language until
      // typescript.js's instantiationNodeTypes starts emitting 'INSTANTIATES'.
      edgeType: c.edgeType || 'CALLS',
    }));
  const inheritanceEdges = (result.unresolvedInheritance || [])
    .filter((u) => Number.isInteger(u.from) && u.toName && u.edge_type)
    .map((u) => ({ fromIndex: u.from, toName: u.toName, edgeType: u.edge_type, confidenceTier: 'INFERRED' }));
  // A declared
  // field's type name base.js#walkGeneric could not resolve same-file
  // walkGeneric's deferred path — carried through as its own bucket, never
  // folded into `inheritanceEdges`: REFERENCES has no heuristic variant, so it
  // must resolve via import evidence ONLY
  // (ingest.js#resolveTypeReferenceEdges) and refuse otherwise, never fall into
  // the branch-wide name-matching cascade `inheritanceEdges`
  // (EXTENDS/IMPLEMENTS/DEPENDS_ON) or `pendingEdges` (CALLS) both use.
  const typeReferences = (result.unresolvedTypeReferences || [])
    .filter((u) => Number.isInteger(u.from) && u.toName)
    .map((u) => ({ fromIndex: u.from, toName: u.toName, line: u.line ?? null }));
  // `sqlReferences`/`configValueRefs` are pure content-regex side channels
  // (buildContentSideChannels, above) — they need no AST/node-index information
  // at all, only `content`+`lang`. A file whose extension has no `langForFile`
  // entry degrades to empty arrays, never throws.
  const lang = content ? langForFile(filePath) : null;
  const { sqlReferences, configValueRefs } = lang
    ? buildContentSideChannels(content, lang)
    : { sqlReferences: [], configValueRefs: [] };
  // `importFacts` (base.js#registerImportFact, {name,module,alias,line}[], no
  // node-index remap needed) MUST be forwarded: ingest.js's
  // `coveredFilesForFileNode` loop sources FILE.properties.imports from
  // ingest-file-processor.js's `astResult.importFacts`, and dropping it here
  // leaves facts.js#buildFileScopedIndex's importsByFile empty, which silently
  // disables every import-evidence-tiered resolver (CALLS tier 3,
  // resolveViaReceiverImport/Type tiers 3/4/6, resolveDecoratedByEdges tier 3)
  // for this file.
  return {
    nodes, structuralEdges, inheritanceEdges,
    relativeImportEdges: [], sqlReferences, configValueRefs,
    unresolvedCalls,
    typeReferences,
    importFacts: result.importFacts || [],
    // File-level,
    // no node-index remap needed — same shape as importFacts above.
    reExports: result.reExportFacts || [],
  };
}

// The `.vue` entry point (ingest-file-processor.js#extractIngestFile). Async —
// unlike buildAstNodes, which must stay synchronous (it has ~150 synchronous
// call sites in existing tests/scripts). Falls back to the regex scanner when
// the SFC walk yields nothing or throws, so a Vue file is never worse off than
// it was before this route existed.
async function extractVueSfc(content, filePath) {
  try {
    const result = await vueExtractor.extractFile(filePath, content);
    if (!result || !result.nodes || !result.nodes.length) {
      // A PURE-BARREL file (only `export {x} from './y'` re-exports, no
      // CLASS/METHOD-worthy declaration) produces zero nodes, so this guard
      // falls back wholesale — which would throw `result.reExportFacts` away
      // with it, even though base.js#addReExportFact needs no node index at
      // all (same "file-level, not node-level" shape as importFacts). Losing
      // RE_EXPORTS for precisely that file shape defeats the point. The regex
      // scanner's own return never sets a `reExports` key, so this is a pure
      // addition, not an override.
      const scanned = buildAstNodes(content, filePath, filePath);
      if (result && result.reExportFacts && result.reExportFacts.length) {
        scanned.reExports = result.reExportFacts;
      }
      return scanned;
    }
    return _adaptVueResult(result, filePath, content);
  } catch (_) {
    return buildAstNodes(content, filePath, filePath);
  }
}

// `.rb`/`.rs` reach buildAstNodes' line scanner because they have no bespoke tree-sitter branch
// there, and the scanner cannot see a call: measured on sinatra+rack+ripgrep+serde it produced
// 0 CALLS edges against 4,856 from the tree-sitter walk, and 86.9%/96.4% declaration recall
// against 99.9%/99.7%. Async for the same reason extractVueSfc is — buildAstNodes has ~150
// synchronous call sites and must stay synchronous. Falls back to the scanner only when the
// grammar failed to load, so a wasm problem degrades rather than empties the file.
const _PORTED_EXTRACTORS = {
  '.rb': require('./extractors/ruby.js'),
  '.rs': require('./extractors/rust.js'),
};

async function extractPortedTreeSitter(content, filePath) {
  const mod = _PORTED_EXTRACTORS[path.extname(filePath).toLowerCase()];
  if (!mod) return buildAstNodes(content, filePath, filePath);
  try {
    if (await mod.ready() !== 'ready') return buildAstNodes(content, filePath, filePath);
    const adapted = _adaptVueResult(await mod.extractFile(filePath, content), filePath, content);
    for (const nd of adapted.nodes) if (nd.extractor_tier === undefined) nd.extractor_tier = 'treesitter';
    return adapted;
  } catch (_) {
    return buildAstNodes(content, filePath, filePath);
  }
}

// Per-grammar node-type names for "class-like" and "function-like" top-level
// declarations, verified against each WASM grammar's actual parse tree.
const GENERIC_LANG_CONFIG = Object.freeze({
  rust:    { classTypes: ['struct_item', 'trait_item', 'enum_item', 'impl_item'], funcTypes: ['function_item', 'function_signature_item'] },
  scala:   { classTypes: ['class_definition', 'object_definition', 'trait_definition'], funcTypes: ['function_definition', 'function_declaration'] },
  cpp:     { classTypes: ['class_specifier', 'struct_specifier'], funcTypes: ['function_definition'] },
  c:       { classTypes: ['struct_specifier'], funcTypes: ['function_definition'] },
  c_sharp: { classTypes: ['class_declaration', 'struct_declaration', 'interface_declaration'], funcTypes: ['method_declaration'] },
  swift:   { classTypes: ['class_declaration', 'struct_declaration', 'protocol_declaration'], funcTypes: ['function_declaration', 'protocol_function_declaration'] },
  // `local_function_definition_statement` (the `local function f() end` form)
  // is deliberately NOT added here despite being the correct node type for
  // this grammar. tree-sitter-lua.wasm only parses correctly on the FIRST
  // tree-sitter parse in a process — after any other parse, `local function`
  // stops being recognised and the PRECEDING function's span silently
  // absorbs it (`M.total` measured at 11-13 alone, 11-17 in every later
  // parse). Adding the type would therefore only
  // fire in whichever run happened to hit Lua first, making output depend on
  // file ordering. See scripts/fanout-gate.js's parked-language ledger.
  lua:     { classTypes: [], funcTypes: ['function_definition_statement'] },
  // Verified against tree-sitter-solidity.wasm. contract/
  // interface/library/struct all expose a `name` field; constructor_definition
  // does NOT and so is absent here — the generic walk drops an unnamed node,
  // and unlike extractors/solidity.js this tier has no hook to supply a name.
  // ocaml/rescript get no entry on purpose: their function and VALUE bindings
  // share one node type (`let_binding`), and this tier cannot tell them apart,
  // so every constant would be emitted as a METHOD.
  solidity: { classTypes: ['contract_declaration', 'interface_declaration', 'library_declaration', 'struct_declaration'], funcTypes: ['function_definition', 'modifier_definition'] },
  php:     { classTypes: ['class_declaration', 'interface_declaration', 'trait_declaration'], funcTypes: ['method_declaration', 'function_definition'] },
  ruby:    { classTypes: ['class', 'module'], funcTypes: ['method', 'singleton_method'] },
  python:  { classTypes: ['class_definition'], funcTypes: ['function_definition'] },
  java:    { classTypes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'], funcTypes: ['method_declaration', 'constructor_declaration'] },
  // Arrow-function consts (`const foo = () => {}`) are not covered: funcTypes are matched by
  // node_type alone, and `variable_declarator` also matches plain value assignments — capturing
  // just the arrow-function subset would need a value-type check, a new abstraction this
  // mechanism doesn't have. named function/class/method forms only.
  javascript: { classTypes: ['class_declaration'], funcTypes: ['function_declaration', 'generator_function_declaration', 'method_definition'] },
  // Verified against tree-sitter-tsx.wasm's actual parse tree (not
  // assumed from javascript's): class_declaration, function_declaration,
  // generator_function_declaration and method_definition all use the identical
  // node-type names in the tsx grammar. Required in the same commit as the
  // '.jsx'/'.tsx' -> 'tsx' re-point in EXT_TO_GRAMMAR — without
  // this entry both extensions would parse to 0 nodes/0 spans on the legacy path.
  tsx: { classTypes: ['class_declaration'], funcTypes: ['function_declaration', 'generator_function_declaration', 'method_definition'] },
});

// grammar name -> { state: 'ready'|'failed', parser }, lazily populated per grammar on first use.
const _genericParserCache = {};

// The cache was only written AFTER the await, so at
// INGEST_CONCURRENCY=8 every one of eight files of the same generic language saw an empty
// cache and started its own wasm Language.load + Parser construction. The in-flight promise is
// cached instead, so concurrent callers share one load and the Nth caller cannot race ahead of
// the first one's result.
const _genericParserLoads = new Map();

async function _loadGenericParser(grammar) {
  const cached = _genericParserCache[grammar];
  if (cached) return cached.state === 'ready' ? cached.parser : null;
  let inFlight = _genericParserLoads.get(grammar);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const Parser = await _tsInitPromise;
        const wasmPath = _wasmPath('tree-sitter-wasms', 'out/tree-sitter-%s.wasm', grammar);
        if (!wasmPath) throw new Error(`tree-sitter-wasms not resolvable for ${grammar}`);
        const lang = await Parser.Language.load(wasmPath);
        const p = new Parser();
        p.setLanguage(lang);
        _genericParserCache[grammar] = { state: 'ready', parser: p };
        return p;
      } catch (_) {
        _genericParserCache[grammar] = { state: 'failed', parser: null };
        return null;
      } finally {
        _genericParserLoads.delete(grammar);
      }
    })();
    _genericParserLoads.set(grammar, inFlight);
  }
  return inFlight;
}

const _GENERIC_IDENT_TYPES = ['identifier', 'type_identifier', 'field_identifier', 'name', 'constant', 'simple_identifier', 'variable'];

// Resolves a declaration node's name across grammars that expose a 'name'
// field directly (most), grammars that nest the name behind a 'declarator'
// chain (C/C++ function_definition), and grammars with neither (Lua) where
// the identifier is simply a direct child.
function _genericNodeName(n) {
  const nameField = n.childForFieldName && n.childForFieldName('name');
  if (nameField) return nameField.text;

  let decl = n.childForFieldName && n.childForFieldName('declarator');
  let depth = 0;
  while (decl && depth < 6) {
    if (_GENERIC_IDENT_TYPES.includes(decl.type)) return decl.text;
    const nf = decl.childForFieldName && decl.childForFieldName('name');
    if (nf) return nf.text;
    const inner = decl.childForFieldName && decl.childForFieldName('declarator');
    if (!inner) break;
    decl = inner;
    depth++;
  }

  for (const c of n.children || []) {
    if (_GENERIC_IDENT_TYPES.includes(c.type)) return c.text;
  }
  return null;
}

function _genericSwiftDeclarationKind(node) {
  if (node.type === 'protocol_declaration') return 'protocol';
  const keyword = (node.children || []).find((child) =>
    ['class', 'struct', 'enum', 'extension', 'actor'].includes(child.type)
  );
  return keyword?.type || null;
}

function _genericSwiftInheritedName(specifier) {
  const inherited = specifier.childForFieldName && specifier.childForFieldName('inherits_from');
  if (!inherited) return null;
  const direct = _genericNodeName(inherited);
  if (direct) return direct;
  const identifier = inherited.descendantsOfType?.('type_identifier')?.[0];
  return identifier?.text || null;
}

function _genericScalaDeclarationKind(node) {
  if (node.type === 'trait_definition') return 'trait';
  if (node.type === 'object_definition') return 'object';
  return (node.children || []).some((child) => child.type === 'case') ? 'case_class' : 'class';
}

// Languages whose extractors/<lang>.js walk supersedes the config-driven generic walk below —
// a dedicated grammar walk resolves names and edges the node-type heuristics cannot (e.g. a
// constructor, or events/errors/enums, or a shell function).
//
// The generic tier stays the fallback: a grammar that fails to load leaves the extractor
// returning zero nodes, and returning null from the adapter drops through to it rather than
// writing an empty file.
const PORTED_GENERIC_EXTRACTORS = Object.freeze({
  elixir: () => require('./extractors/elixir.js'),
  solidity: () => require('./extractors/solidity.js'),
  bash: () => require('./extractors/bash.js'),
  // These four are in SUPPORTED_GRAMMAR_EXTS and have working extractor modules, but were in
  // neither this table nor GENERIC_LANG_CONFIG, so the inline walker ran with no config and
  // returned zero nodes — the modules were dead code on the ingest path while passing their own
  // unit tests. Called directly they extract fine (zig 2, objc 3, ocaml 2,
  // rescript 2 on a one-file fixture); through `koragraph ingest` all four produced NOTHING.
  zig: () => require('./extractors/zig.js'),
  objc: () => require('./extractors/objc.js'),
  ocaml: () => require('./extractors/ocaml.js'),
  rescript: () => require('./extractors/rescript.js'),
  // Same story as the four above: extractors/swift.js is a full tree-sitter walk (types, methods,
  // stored + computed properties, inheritance) but was wired into neither this table nor the
  // generic config, so the inline walker ran without it and emitted no property/field nodes.
  swift: () => require('./extractors/swift.js'),
});

// extractors/base.js's contract ({nodes, edges:[{from,to,edge_type}]}) adapted to the three-key
// shape ingest.js's generic-AST pass writes. `unresolvedCalls`/`unresolvedInheritance` are carried
// through under the names ingest-file-processor.js already uses so that pass can queue them for
// branch-wide resolution the same way the extractable tier does.
async function _portedGenericResult(grammar, filePath, content) {
  try {
    const mod = PORTED_GENERIC_EXTRACTORS[grammar]();
    const result = await mod.extractFile(filePath, content);
    // A file with no declaration but a real `source`/`import` line still has facts worth keeping,
    // and for elixir/bash there is no GENERIC_LANG_CONFIG entry to fall through TO — falling
    // through on an empty node list threw those import facts away for nothing.
    if (!result || (!(result.nodes || []).length && !(result.importFacts || []).length)) return null;
    const structuralEdges = (result.edges || [])
      .filter((e) => Number.isInteger(e.from) && Number.isInteger(e.to))
      .map((e) => ({
        fromIndex: e.from, toIndex: e.to, edgeType: e.edge_type, resolution: e.resolution,
        evidenceLine: e.evidence_line ?? null, calleeName: e.calleeName ?? null,
      }));
    return {
      nodes: result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath, extractor_tier: 'treesitter' })),
      structuralEdges,
      importFacts: result.importFacts || [],
      // Carry the content side-channels the ported extractor computed (base.js#walkGeneric) so a
      // Ruby/Rust/Swift/Scala service's `SELECT … FROM orders` reaches the READS_TABLE resolver —
      // without this the ported adapter silently dropped them and shared-DB coupling was invisible
      // for every generic-grammar language.
      sqlReferences: result.sqlReferences || [],
      configValueRefs: result.configValueRefs || [],
      unresolvedCalls: (result.unresolvedCalls || [])
        .filter((c) => Number.isInteger(c.from) && c.calleeName)
        .map((c) => ({ fromIndex: c.from, calleeName: c.calleeName, line: c.line ?? null, edgeType: c.edgeType || 'CALLS' })),
      inheritanceEdges: (result.unresolvedInheritance || [])
        .filter((u) => Number.isInteger(u.from) && u.toName && u.edge_type)
        .map((u) => ({ fromIndex: u.from, toName: u.toName, edgeType: u.edge_type, confidenceTier: 'INFERRED' })),
    };
  } catch (_) {
    return null;
  }
}

// Generic symbol extractor result for any SUPPORTED_GRAMMAR_EXTS file. C/C++
// additionally carries declaration ownership and quoted-include facts; other
// languages retain the nodes-only result. It never throws on unsupported
// extensions, unloadable grammars, or parse failure.
async function buildGenericAstResult(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  let grammar = EXT_TO_GRAMMAR[ext];
  if (ext === '.h' && typeof content === 'string' && /@(?:interface|protocol|implementation|property)\b|NSObject\b/.test(content)) {
    grammar = 'objc';
  }
  if (!grammar) return { nodes: [], structuralEdges: [], importFacts: [] };

  if (PORTED_GENERIC_EXTRACTORS[grammar]) {
    const ported = await _portedGenericResult(grammar, filePath, content);
    if (ported) return ported;
  }

  const config = GENERIC_LANG_CONFIG[grammar];
  if (!config) return { nodes: [], structuralEdges: [], importFacts: [] };

  try {
    const parser = await _loadGenericParser(grammar);
    if (!parser) return { nodes: [], structuralEdges: [], importFacts: [] };

    const tree = parser.parse(content);
    const root = tree.rootNode;
    const nodes = [];
    const structuralEdges = [];
    const importFacts = [];
    const classEntries = [];
    const deferredSwiftExtensions = [];
    const swiftPrimaryNames = grammar === 'swift'
      ? new Set([
        ...root.descendantsOfType('class_declaration'),
        ...root.descendantsOfType('protocol_declaration'),
      ].filter((node) => _genericSwiftDeclarationKind(node) !== 'extension')
        .map((node) => _genericNodeName(node))
        .filter(Boolean))
      : null;

    for (const t of config.classTypes) {
      for (const n of root.descendantsOfType(t)) {
        const name = _genericNodeName(n);
        if (!name) continue;
        const kind = grammar === 'swift'
          ? _genericSwiftDeclarationKind(n)
          : grammar === 'scala'
            ? _genericScalaDeclarationKind(n)
            : null;
        if (kind === 'extension' && swiftPrimaryNames.has(name)) {
          deferredSwiftExtensions.push({ node: n, name, kind });
          continue;
        }
        const nodeIndex = nodes.length;
        nodes.push({
          node_type: 'CLASS', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
          summary: `${kind || t.replace(/_.*$/, '')} ${name}`,
          line: n.startPosition.row + 1,
          start_line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1,
          _sourceFile: filePath,
          ...(kind ? { kind } : {}),
        });
        classEntries.push({ node: n, nodeIndex, name, kind });
      }
    }

    for (const extension of deferredSwiftExtensions) {
      const target = classEntries.find((entry) => entry.name === extension.name && entry.kind !== 'extension');
      if (target) classEntries.push({ ...extension, nodeIndex: target.nodeIndex });
    }

    for (const t of config.funcTypes) {
      for (const n of root.descendantsOfType(t)) {
        const name = _genericNodeName(n);
        if (!name) continue;
        const nodeIndex = nodes.length;
        nodes.push({
          node_type: 'METHOD', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
          summary: `${name}()`,
          line: n.startPosition.row + 1,
          start_line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1,
          _sourceFile: filePath,
        });
        if (grammar === 'c' || grammar === 'cpp' || grammar === 'swift' || grammar === 'scala') {
          const owner = classEntries
            .filter((entry) => entry.node.startIndex <= n.startIndex && entry.node.endIndex >= n.endIndex)
            .sort((a, b) => (a.node.endIndex - a.node.startIndex) - (b.node.endIndex - b.node.startIndex))[0];
          if (owner) {
            structuralEdges.push({ fromIndex: nodeIndex, toIndex: owner.nodeIndex, edgeType: 'DEFINED_IN', resolution: 'same_file' });
          }
        }
      }
    }

    if (grammar === 'swift') {
      const classByName = new Map(classEntries.map((entry) => [entry.name, entry]));
      for (const entry of classEntries) {
        for (const specifier of entry.node.children || []) {
          if (specifier.type !== 'inheritance_specifier') continue;
          const inheritedName = _genericSwiftInheritedName(specifier);
          const target = inheritedName ? classByName.get(inheritedName) : null;
          if (!target || target.nodeIndex === entry.nodeIndex) continue;
          const edgeType = entry.kind === 'protocol' || target.kind !== 'protocol'
            ? 'EXTENDS'
            : 'IMPLEMENTS';
          structuralEdges.push({
            fromIndex: entry.nodeIndex,
            toIndex: target.nodeIndex,
            edgeType,
            resolution: 'same_file',
          });
        }
      }
    }

    if (grammar === 'scala') {
      const classByName = new Map(classEntries.map((entry) => [entry.name, entry]));
      for (const entry of classEntries) {
        const inherited = entry.node.childForFieldName && entry.node.childForFieldName('extend');
        const inheritedName = inherited ? _genericNodeName(inherited) : null;
        const target = inheritedName ? classByName.get(inheritedName) : null;
        if (!target || target.nodeIndex === entry.nodeIndex) continue;
        structuralEdges.push({
          fromIndex: entry.nodeIndex,
          toIndex: target.nodeIndex,
          edgeType: 'EXTENDS',
          resolution: 'same_file',
        });
      }
    }

    if (grammar === 'c' || grammar === 'cpp') {
      // Two C++ overloads declared in one class, and their
      // two out-of-class `Shape::area` definitions, all reduced to ownerless same-name METHOD
      // nodes. The independent CST oracle says this file holds exactly TWO entities: per the
      // C++ ODR a declaration and its out-of-class definition ARE one function, while the two
      // overloads are not. Supplying the parameter text and the qualified-name owner makes the
      // identity key produce exactly that — decl and def collapse, overloads stay apart.
      // Scoped to this grammar: no other language in this walk needs or gets it.
      const cppDeclaratorFacts = new Map();
      for (const declarator of root.descendantsOfType('function_declarator')) {
        const paramsNode = declarator.childForFieldName && declarator.childForFieldName('parameters');
        const inner = declarator.childForFieldName && declarator.childForFieldName('declarator');
        let ownerName = null;
        if (inner && inner.type === 'qualified_identifier') {
          const scope = inner.childForFieldName && inner.childForFieldName('scope');
          if (scope && scope.text) ownerName = scope.text;
        }
        let host = declarator.parent;
        while (host && host !== root
          && host.type !== 'function_definition'
          && host.type !== 'declaration'
          && host.type !== 'field_declaration') host = host.parent;
        if (!host || host === root) continue;
        cppDeclaratorFacts.set(host.startPosition.row + 1, {
          params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '') : '',
          ownerName,
        });
      }
      for (const declarator of root.descendantsOfType('function_declarator')) {
        let declaration = declarator.parent;
        let insideDefinition = false;
        while (declaration && declaration !== root) {
          if (declaration.type === 'function_definition') {
            insideDefinition = true;
            break;
          }
          if (declaration.type === 'declaration' || declaration.type === 'field_declaration') break;
          declaration = declaration.parent;
        }
        if (insideDefinition || !declaration || declaration === root) continue;
        const name = _genericNodeName(declarator);
        if (!name) continue;
        const nodeIndex = nodes.length;
        nodes.push({
          node_type: 'METHOD', name, confidence_tier: 'EXTRACTED', confidence: 1.0,
          summary: `${name}()`,
          line: declaration.startPosition.row + 1,
          start_line: declaration.startPosition.row + 1,
          end_line: declaration.endPosition.row + 1,
          _sourceFile: filePath,
        });
        const owner = classEntries
          .filter((entry) => entry.node.startIndex <= declaration.startIndex && entry.node.endIndex >= declaration.endIndex)
          .sort((a, b) => (a.node.endIndex - a.node.startIndex) - (b.node.endIndex - b.node.startIndex))[0];
        if (owner) {
          structuralEdges.push({ fromIndex: nodeIndex, toIndex: owner.nodeIndex, edgeType: 'DEFINED_IN', resolution: 'same_file' });
        }
      }

      for (const nd of nodes) {
        if (nd.node_type !== 'METHOD') continue;
        const facts = cppDeclaratorFacts.get(nd.start_line);
        if (!facts) continue;
        if (nd.params === undefined) nd.params = facts.params;
        if (facts.ownerName && nd._owner === undefined) nd._owner = facts.ownerName;
      }

      for (const include of root.descendantsOfType('preproc_include')) {
        const match = /^\s*#\s*include\s*"([^"]+)"/.exec(include.text);
        if (!match) continue;
        const rawModule = match[1];
        const module = rawModule.startsWith('.') ? rawModule : `./${rawModule}`;
        const name = path.posix.normalize(path.posix.join(path.posix.dirname(filePath.replace(/\\/g, '/')), module));
        importFacts.push({ name, module, alias: null, line: include.startPosition.row + 1 });
      }
    }

    releaseTree(tree);
    return { nodes, structuralEdges, importFacts };
  } catch (_) {
    return { nodes: [], structuralEdges: [], importFacts: [] };
  }
}

async function buildGenericAstNodes(filePath, content) {
  return (await buildGenericAstResult(filePath, content)).nodes;
}

// Span-only harvest: same tree-sitter parse as
// buildGenericAstNodes, but keyed for lookup ("CLASS:Name" / "METHOD:Name")
// rather than emitted as nodes — used to fill in a missing end_line on nodes
// that came from the regex/AST tiers, never to invent new nodes.
// Unlike buildGenericAstNodes (called only for `!isExtractable` files by the
// ingest generic-AST pass), this runs on ANY file whose extension has a
// grammar, including extractable ones, since span-filling is orthogonal to
// which tier produced the node's name/summary.
async function harvestSpans(filePath, content) {
  const spans = new Map();
  const ext = path.extname(filePath).toLowerCase();
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return spans;

  const config = GENERIC_LANG_CONFIG[grammar];
  if (!config) return spans;

  try {
    const parser = await _loadGenericParser(grammar);
    if (!parser) return spans;

    const tree = parser.parse(content);
    const root = tree.rootNode;

    // Keeping only the FIRST declaration per name meant two
    // same-named declarations in one file shared one span. The second node kept its own
    // start_line but inherited the first's end_line, producing impossible spans observed
    // live (`add` start 8 end 6, `run` start 8 end 4). Every occurrence is recorded now and
    // _fillMissingSpans selects by start_line.
    const push = (key, n) => {
      const entry = { start_line: n.startPosition.row + 1, end_line: n.endPosition.row + 1 };
      const existing = spans.get(key);
      if (existing) existing.push(entry);
      else spans.set(key, [entry]);
    };

    for (const t of config.classTypes) {
      for (const n of root.descendantsOfType(t)) {
        const name = _genericNodeName(n);
        if (name) push(`CLASS:${name}`, n);
      }
    }

    for (const t of config.funcTypes) {
      for (const n of root.descendantsOfType(t)) {
        const name = _genericNodeName(n);
        if (name) push(`METHOD:${name}`, n);
      }
    }

    return spans;
  } catch (_) {
    return spans;
  }
}

// Qualified `pkg.Exported` references from the most recent Go parse — every one written anywhere
// in the file whether or not it is called.
//
// Why it exists: `callExpressions` records `pflag.NewFlagSet(...)` because that is a call, but not
// `pflag.ContinueOnError` passed as an argument, `&pflag.Flag{}` as a composite literal, or
// `func(f *pflag.Flag)` as a closure parameter — and those carry a cross-repository dependency on
// another module's exported type without invoking anything. Cross-repo symbol recall on
// spf13/viper stalled at 91.7% for exactly these four forms.
function extractGoQualifiedRefs(content, filePath) {
  buildAstNodes(content, filePath);
  return _lastGoQualifiedRefs;
}

module.exports = {
  extractGoQualifiedRefs,
  extractClasses,
  extractFunctions,
  // Exported for its regression test. The dedupe between the grammar walk and the regex scanner
  // is only reachable through a file whose parse degrades, which is not something a reduced
  // fixture can be relied on to trigger.
  mergeDegradedPlanes,
  extractImports,
  extractExports,
  buildAstNodes,
  extractTypeScriptTreeSitter,
  extractJavaScriptTreeSitter,
  extractJavaScriptViaTsTreeSitter,
  extractRationaleNodes,
  treeSitterGrammarSources,
  extractPythonTreeSitter,
  extractCSharpTreeSitter,
  looksLikeParameterList,
  extractKotlinTreeSitter,
  extractGoTreeSitter,
  extractPhpTreeSitter,
  awaitTreeSitterReady,
  EXT_TO_AST_LANG,
  extractInjectedDependencies,
  extractReExportFacts,
  stripComments,
  extractSqlReferences,
  extractSqlDeclarations,
  extractCRegex,
  extractCTreeSitter,
  maskSqlNoise,
  sqlStatements,
  extractConfigValueRefs,
  buildGenericAstNodes,
  buildGenericAstResult,
  SUPPORTED_GRAMMAR_EXTS,
  harvestSpans,
  EXT_TO_GRAMMAR,
  extractVueSfc,
  extractPortedTreeSitter,
  tsInitPromise,
  tsNextInitPromise,
  wasmPath: _wasmPath,
};
