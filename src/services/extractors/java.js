'use strict';

// Unlike extractors/go.js (a self-contained module), Java has no bespoke
// extractor — `extract_java` runs `_extract_generic(path, _JAVA_CONFIG)`,
// driven by the shared `_extract_generic` core in extractors/base.js's
// `walkGeneric`. This file supplies only Java's own pieces: `_JAVA_CONFIG` as
// a base.js `LanguageConfig`, and the import handler `_import_java`.
//
// Behavioural notes (nothing is silently dropped):
//   - object_creation_expression ("new Foo()") is wired as an INSTANTIATES
//     call site via walkGeneric's per-callType `calleeFieldByType` override.
//     The `type` field is a bare `type_identifier` for the simple case
//     (`new Foo()` -> "Foo", resolves same-file against classByName), but a
//     `generic_type` for a parameterized constructor
//     (`new ArrayList<String>()` -> whole text "ArrayList<String>", unlike
//     typescript.js's `new_expression` where type arguments sit on a SEPARATE
//     field the callee text never includes) or a `scoped_type_identifier` for
//     a qualified one (`new Outer.Inner()` -> "Outer.Inner") — both push
//     unresolvedCalls residue with a compound calleeName that can never
//     same-file-match a bare class name (never a SILENT drop — just an
//     unresolvable one for the qualified/generic cases). The common
//     simple-constructor case is the real fix; the compound-name residue is
//     not further pursued here (would need per-node-type nested-field
//     extraction, a broader base.js change).
//   - method_invocation's `object` field (the receiver, e.g. `foo` in
//     `foo.bar()`) is not consulted. tree-sitter-java exposes `object` and
//     `name` as sibling fields on the call node itself — unlike Go's
//     selector_expression or JS's member_expression, there is no nested
//     accessor node for walkGeneric's callAccessorNodeTypes mechanism to
//     match against. Calls resolve on bare method name only (methodByName),
//     same as every other config-driven language's fallback branch.
//   - `_java_type_parameters_in_scope`/`_java_collect_type_refs`/
//     `_java_receiver_type_name`/`_java_method_receiver_types` (the
//     receiver-typing machinery) are not ported: they exist solely
//     to feed receiver-aware call resolution, which is not
//     attempted (see above). Nothing in the CLASS/METHOD/IMPORT contract
//     needs them.
//   - `_java_annotation_names` is not ported — it feeds
//     decorator/annotation edges, which are outside the closed edge_type
//     vocabulary (extractors/base.js EDGE_TYPES).
//   - `_java_extra_walk` is not ported for the same reason: its outputs
//     (annotation/decorator edges) fall outside the closed contract.
//
// `_JAVA_CONFIG` has no `extra_walk`. koragraph's separate legacy (non-ported)
// regex-based class parser (ast-extractor.js) does emit EXTENDS/IMPLEMENTS,
// generically, off
// `nd.extends`/`nd.implements` regex captures, and routes ALL of it —
// same-file or not — through the name-matching `inheritanceEdges` bucket at
// `EXTRACTED` confidence. This file adds a Java `extraWalkFn` so the port does
// strictly better: a same-file supertype resolves to an exact node index
// (`structuralEdges`, `same_file`, unambiguous) and only a name the file
// cannot resolve locally falls back to the fuzzy branch-wide bucket, tagged
// `INFERRED` — never legacy's inflated `EXTRACTED` for a guess.

const base = require('./base');

// java.lang/java.util/java.util.stream/java.util.function/
// java.util.concurrent/java.time/java.io/java.nio.file/java.math builtins. A
// field DECLARED with one of these types (`private String name;`) is never
// evidence of a REFERENCES edge to a user CLASS — there is no CLASS node for
// `java.lang.String` in this graph, and even if some project defined its own
// class named `Optional` this set intentionally still refuses it.
const _JAVA_BUILTIN_TYPES = new Set([
  'Object', 'String', 'CharSequence', 'StringBuilder', 'StringBuffer',
  'Number', 'Byte', 'Short', 'Integer', 'Long', 'Float', 'Double',
  'Boolean', 'Character', 'Void', 'Class', 'Enum', 'Record', 'Math',
  'System', 'Thread', 'Runnable', 'Comparable', 'Iterable', 'Cloneable',
  'AutoCloseable', 'Appendable', 'Readable', 'Process', 'ProcessBuilder',
  'Runtime', 'Package', 'ThreadLocal', 'InheritableThreadLocal',
  'Throwable', 'Exception', 'RuntimeException', 'Error',
  'IllegalArgumentException', 'IllegalStateException', 'NullPointerException',
  'IndexOutOfBoundsException', 'ArrayIndexOutOfBoundsException',
  'ClassCastException', 'NumberFormatException', 'ArithmeticException',
  'UnsupportedOperationException', 'InterruptedException',
  'CloneNotSupportedException', 'SecurityException', 'StackOverflowError',
  'OutOfMemoryError', 'AssertionError',
  'Collection', 'List', 'ArrayList', 'LinkedList', 'Vector', 'Stack',
  'Set', 'HashSet', 'LinkedHashSet', 'TreeSet', 'SortedSet', 'NavigableSet',
  'EnumSet', 'Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'SortedMap',
  'NavigableMap', 'Hashtable', 'EnumMap', 'Properties', 'Queue', 'Deque',
  'ArrayDeque', 'PriorityQueue', 'Iterator', 'ListIterator', 'Comparator',
  'Optional', 'OptionalInt', 'OptionalLong', 'OptionalDouble', 'Collections',
  'Arrays', 'Objects', 'Date', 'Calendar', 'Random', 'UUID', 'Scanner',
  'StringJoiner', 'StringTokenizer', 'BitSet', 'Spliterator', 'Locale',
  'NoSuchElementException', 'ConcurrentModificationException',
  'Stream', 'IntStream', 'LongStream', 'DoubleStream', 'Collector',
  'Collectors',
  'Function', 'BiFunction', 'Consumer', 'BiConsumer', 'Supplier',
  'Predicate', 'BiPredicate', 'UnaryOperator', 'BinaryOperator',
  'IntFunction', 'ToIntFunction', 'ToLongFunction', 'ToDoubleFunction',
  'Callable', 'Future', 'CompletableFuture', 'CompletionStage', 'Executor',
  'ExecutorService', 'Executors', 'ScheduledExecutorService', 'TimeUnit',
  'ConcurrentHashMap', 'ConcurrentMap', 'CopyOnWriteArrayList',
  'BlockingQueue', 'CountDownLatch', 'Semaphore', 'CyclicBarrier',
  'AtomicInteger', 'AtomicLong', 'AtomicBoolean', 'AtomicReference',
  'Instant', 'Duration', 'Period', 'LocalDate', 'LocalTime', 'LocalDateTime',
  'ZonedDateTime', 'OffsetDateTime', 'ZoneId', 'ZoneOffset', 'DayOfWeek',
  'Month', 'Year', 'Clock', 'DateTimeFormatter',
  'IOException', 'UncheckedIOException', 'FileNotFoundException', 'File',
  'InputStream', 'OutputStream', 'Reader', 'Writer', 'BufferedReader',
  'BufferedWriter', 'InputStreamReader', 'OutputStreamWriter', 'FileReader',
  'FileWriter', 'PrintStream', 'PrintWriter', 'ByteArrayInputStream',
  'ByteArrayOutputStream', 'Serializable', 'Closeable', 'Path', 'Paths',
  'Files',
  'BigDecimal', 'BigInteger',
]);

// Exclude single-letter/T-style type parameters. A real class name is never a
// bare single letter or a single letter followed by a digit (T, K, V, E, R,
// T1, T2, ...) by Java convention; this is a simplification, not a full
// scope-scan of the enclosing declaration's `type_parameters`.
const _JAVA_TYPE_PARAM_RE = /^[A-Z][0-9]?$/;

function _isReferenceableJavaType(typeName) {
  if (!typeName) return false;
  if (_JAVA_BUILTIN_TYPES.has(typeName)) return false;
  if (_JAVA_TYPE_PARAM_RE.test(typeName)) return false;
  return true;
}

const CONFIG = base.LanguageConfig({
  classTypes: new Set([
    'class_declaration', 'interface_declaration', 'record_declaration',
    'enum_declaration', 'annotation_type_declaration',
  ]),
  functionTypes: new Set(['method_declaration', 'constructor_declaration']),
  importTypes: new Set(['import_declaration']),
  // object_creation_expression — see the file header for the
  // calleeFieldByType/instantiation wiring and its documented generic/
  // qualified-name residue limitation. explicit_constructor_invocation
  // (`super(...)`/`this(...)` as the FIRST statement of a constructor body — a
  // totally separate node type from both method_invocation and
  // object_creation_expression) has its callee in a `constructor` field
  // holding a dedicated `super`/`this` keyword-typed node (same per-callType-
  // field shape as object_creation_expression's `type` field above), wired the
  // same way. calleeName ends up literally "super"/"this" (not a real symbol
  // name — resolving to the actual parent/same-class constructor needs
  // class-hierarchy knowledge this detection-only pass doesn't have), so this
  // always defers to unresolvedCalls rather than matching a real target — the
  // same imprecise-but-present-residue shape as the qualified/generic
  // constructor case above, not a silent drop.
  callTypes: new Set(['method_invocation', 'object_creation_expression', 'explicit_constructor_invocation']),
  callFunctionField: 'name',
  calleeFieldByType: new Map([
    ['object_creation_expression', 'type'],
    ['explicit_constructor_invocation', 'constructor'],
  ]),
  instantiationNodeTypes: new Set(['object_creation_expression']),
  // tree-sitter-java's method_invocation exposes `object` and `name` as two
  // SIBLING fields on the SAME node (`svc.doWork()` -> object="svc"(identifier),
  // name="doWork"; `this.svc.doWork()` -> object="this.svc"(field_access); a
  // receiverless `plain()` -> object=null, unaffected) — base.js's
  // callObjectField hook reads it directly off the call node itself rather than
  // expecting it nested under `callFunctionField` the way JS/TS's
  // member_expression wrapping does. This does not resolve the receiver by
  // itself — it only stops discarding it, so the receiver-import and
  // receiver-type resolvers (resolve.js) get a shot at `svc`/`this.svc` instead
  // of Java calls falling straight to a bare-name-only same-file guess that
  // ignored the receiver entirely.
  callObjectField: 'object',
  functionBoundaryTypes: new Set(['method_declaration', 'constructor_declaration']),
  importHandler: _importJava,
  extraWalkFn: _extraWalkJava,
  // tree-sitter-java exposes `parameters` on both method_declaration and
  // constructor_declaration (-> formal_parameters, entries formal_parameter/
  // spread_parameter for varargs `int... a`). Annotations (`@Deprecated`,
  // `@SuppressWarnings("x")`) are children of a `modifiers` node that is itself
  // a plain (unnamed-field) direct child of the function node, alongside
  // `public`/`static`/etc. — no async keyword in Java, so asyncMarkerText
  // stays unset.
  paramEntryTypes: new Set(['formal_parameter', 'spread_parameter']),
  decoratorNodeTypes: new Set(['marker_annotation', 'annotation']),
  decoratorContainerTypes: new Set(['modifiers']),
  // switch_label wraps BOTH `case N` and `default` (a `default` child
  // distinguishes it, same shape as C's case_statement) — excluded via
  // branchArmDefaultTypes.
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_label', 'catch_clause', 'ternary_expression']),
  branchArmDefaultTypes: new Set(['switch_label']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// tree-sitter-java field shapes: `class_declaration`'s `superclass` field
// wraps `extends Bar` (a `superclass` node containing a `type_identifier`);
// its `interfaces` field wraps `implements Baz, Qux` (a `super_interfaces`
// node containing a `type_list` of one or more `type_identifier`/
// `scoped_type_identifier`/`generic_type` children). `interface_declaration`
// extending other interfaces has no field name — tree-sitter-java exposes it
// as a plain `extends_interfaces` child, found positionally. Recurses through
// `generic_type`/`scoped_type_identifier` wrappers to the base name only —
// this port's contract carries no type-argument metadata (same choice
// csharp.js's `_readCsharpTypeName` makes).
//
// `scoped_type_identifier` (a fully-qualified type, e.g. `java.io.Serializable`)
// has NO field names at all (`childForFieldName` returns undefined for every
// candidate tried) and is left-nested:
// `scoped_type_identifier("java.io.Serializable")` ->
// `[scoped_type_identifier("java.io"), '.', type_identifier("Serializable")]`.
// The last-segment name is therefore the LAST `type_identifier` child at
// THIS level, not a recursive walk of the whole subtree — recursing would
// also collect "java"/"io" from the nested qualifier and return the wrong
// (first, package-segment) name for a single-supertype slot.
//
// `generic_type` (e.g. `Comparable<Widget>`) is `[type_identifier|
// scoped_type_identifier, type_arguments]`. Only the FIRST child is the base
// type; `type_arguments` must be skipped explicitly, not
// walked, or `Comparable<Widget>` yields two supertypes ("Comparable" AND
// "Widget") instead of one. This is why `walk` below dispatches per-child-type
// rather than blindly recursing into every child.
function _typeIdentifierNames(node) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'type_identifier') { out.push(base._readText(n)); return; }
    if (n.type === 'scoped_type_identifier') {
      const lastSeg = [...(n.children || [])].reverse().find((c) => c.type === 'type_identifier');
      out.push(lastSeg ? base._readText(lastSeg) : base._readText(n));
      return;
    }
    if (n.type === 'generic_type') {
      const baseNode = (n.children || []).find(
        (c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier'
      );
      if (baseNode) walk(baseNode);
      return;
    }
    if (n.type === 'type_arguments') return;
    for (const child of n.children || []) walk(child);
  })(node);
  return out;
}

// Same-file supertype -> index-resolved `EXTENDS`/`IMPLEMENTS` (exact,
// `same_file`). A name this file cannot resolve (genuinely cross-file, or a
// JDK/library type with no CLASS node at all) is handed to
// `ctx.addUnresolvedInheritance` instead of being silently dropped — the
// branch-wide name resolver gets the same shot at it legacy always takes,
// but tagged `INFERRED`, not legacy's `EXTRACTED`.
function _emitInheritance(ctx, fromIdx, name, edgeType) {
  const targetIdx = ctx.classByName.get(name);
  if (targetIdx !== undefined && targetIdx !== fromIdx) {
    ctx.addEdge(fromIdx, targetIdx, edgeType, 'same_file', undefined);
  } else {
    ctx.addUnresolvedInheritance(fromIdx, name, edgeType);
  }
}

// Captures declared field types onto the owning CLASS node's `fields` property
// (`[{name, type}]`) — the typed-field receiver-inference resolver
// (resolve.js#resolveViaReceiverType) reads this to resolve `svc.doWork()`
// where `svc` is a declared field, not an import alias. tree-sitter-java's
// `field_declaration` has a `type` field (base type via `_typeIdentifierNames`,
// same helper `_extraWalkJava`'s inheritance handling already uses — a generic
// field's type argument, e.g. `List<FooService>`, base-types to "List", the
// declared "no flow analysis" scope) and one or more `variable_declarator`
// children (comma-separated fields sharing one type), each carrying its own
// `name` field. `field_declaration` only ever appears as a class/interface/
// enum MEMBER in tree-sitter-java's grammar — never inside a method body
// (locals use `local_variable_declaration` instead) — so no method-body guard
// is needed here.
function _javaFieldOwnerClassIdx(node, ctx) {
  let owner = node.parent;
  while (owner && owner.type !== 'class_declaration' && owner.type !== 'interface_declaration'
    && owner.type !== 'enum_declaration' && owner.type !== 'record_declaration') {
    owner = owner.parent;
  }
  if (!owner) return undefined;
  const nameNode = owner.childForFieldName('name');
  if (!nameNode) return undefined;
  return ctx.classByName.get(base._readText(nameNode));
}

// A declared field's type is REFERENCES evidence — mirrors `_emitInheritance`'s
// own two-path shape exactly (same-file resolves to an exact index right here,
// `same_file` resolution; anything else is deferred, never guessed at
// branch-wide by name). Builtin/type-parameter noise is filtered by
// `_isReferenceableJavaType` before either path runs, so neither the same-file
// nor the deferred bucket ever carries `String`/`List`/`T`.
function _emitFieldTypeReference(ctx, classIdx, typeName, node) {
  if (!_isReferenceableJavaType(typeName)) return;
  const targetIdx = ctx.classByName.get(typeName);
  if (targetIdx !== undefined && targetIdx !== classIdx) {
    ctx.addEdge(classIdx, targetIdx, 'REFERENCES', 'same_file', ctx.line(node));
  } else if (targetIdx === undefined) {
    ctx.addTypeReference(classIdx, typeName, ctx.line(node));
  }
}

function _captureJavaField(node, ctx) {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = _typeIdentifierNames(typeNode)[0];
  if (!typeName) return;
  const classIdx = _javaFieldOwnerClassIdx(node, ctx);
  if (classIdx === undefined) return;
  _emitFieldTypeReference(ctx, classIdx, typeName, node);
  for (const decl of (node.children || []).filter((c) => c.type === 'variable_declarator')) {
    const nameNode = decl.childForFieldName('name');
    const fieldName = nameNode ? base._readText(nameNode) : null;
    if (!fieldName) continue;
    base.recordClassField(ctx, classIdx, fieldName, typeName);
  }
}

function _extraWalkJava(node, source, ctx) {
  const t = node.type;
  if (t === 'field_declaration') {
    _captureJavaField(node, ctx);
    return;
  }
  if (t === 'class_declaration' || t === 'enum_declaration' || t === 'record_declaration') {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const classIdx = ctx.classByName.get(base._readText(nameNode));
    if (classIdx === undefined) return;
    const superclassNode = node.childForFieldName('superclass');
    if (superclassNode) {
      for (const baseName of _typeIdentifierNames(superclassNode)) {
        _emitInheritance(ctx, classIdx, baseName, 'EXTENDS');
      }
    }
    const interfacesNode = node.childForFieldName('interfaces');
    if (interfacesNode) {
      for (const ifaceName of _typeIdentifierNames(interfacesNode)) {
        _emitInheritance(ctx, classIdx, ifaceName, 'IMPLEMENTS');
      }
    }
  } else if (t === 'interface_declaration') {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const classIdx = ctx.classByName.get(base._readText(nameNode));
    if (classIdx === undefined) return;
    const extendsNode = (node.children || []).find((c) => c.type === 'extends_interfaces');
    if (extendsNode) {
      for (const baseName of _typeIdentifierNames(extendsNode)) {
        _emitInheritance(ctx, classIdx, baseName, 'EXTENDS');
      }
    }
  }
}

// Walks the
// scoped_identifier/identifier chain of an import_declaration and returns
// the last dotted segment as the imported module name (the class name for
// `import a.b.Foo;`, the package's last segment for a wildcard
// `import a.b.*;` since tree-sitter-java's `asterisk` is a separate sibling
// node, not part of the identifier chain).
function _importJava(node) {
  function walkScoped(n) {
    const parts = [];
    let cur = n;
    while (cur) {
      if (cur.type === 'scoped_identifier') {
        const nameNode = cur.childForFieldName('name');
        if (nameNode) parts.push(base._readText(nameNode));
        cur = cur.childForFieldName('scope');
      } else if (cur.type === 'identifier') {
        parts.push(base._readText(cur));
        break;
      } else {
        break;
      }
    }
    parts.reverse();
    return parts.join('.');
  }

  const out = [];
  for (const child of node.children || []) {
    if (child.type === 'scoped_identifier' || child.type === 'identifier') {
      const pathStr = walkScoped(child);
      if (!pathStr) continue;
      const segs = pathStr.split('.').filter(Boolean);
      if (!segs.length) continue;
      let nameIdx = segs.length - 1;
      let moduleName = segs[nameIdx].replace(/\*/g, '');
      if (!moduleName && segs.length > 1) { nameIdx = segs.length - 2; moduleName = segs[nameIdx]; }
      if (moduleName) {
        const pkgSegs = segs.slice(0, nameIdx);
        out.push({ name: moduleName, module: pkgSegs.length ? pkgSegs.join('.') : undefined });
      }
    }
  }
  return out;
}

let _parserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _parser = null;
let _parserReadyPromise = null;

// See extractors/go.js's identical comment: web-tree-sitter's Parser.init()
// must run exactly once per process, so this loads through base.js's shared
// grammar loader, and lazily (not a top-level IIFE) to avoid racing the
// require-cycle back into ast-extractor.js's not-yet-populated exports.
function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _parser = await base.loadGrammar('java');
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
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  if (_parserState !== 'ready') {
    return { nodes: [], edges: [] };
  }
  const tree = _parser.parse(content);
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return _parserState;
}

module.exports = { extract, extractFile, ready, CONFIG };