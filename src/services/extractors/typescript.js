'use strict';

// TypeScript/TSX. One LanguageConfig (`CONFIG`, below) is shared by both
// grammars; this module loads BOTH grammars (`typescript` for .ts/.mts/.cts,
// `tsx` for .tsx/.jsx) rather than the single grammar other Tier 2 extractors
// load. `.jsx` is registered to this module (ast-extractor.js EXT_TO_SLUG)
// using the tsx grammar.
//
// Deliberately NOT extracted:
//   - `export_statement` is NOT in `importTypes`. walkGeneric's import-type
//     branch returns immediately without walking the node's children
//     (extractors/base.js) — correct for `import_statement` (never wraps a
//     class/function), but `export_statement` ALSO wraps a plain declaration
//     export (`export class Foo {}`, `export function bar(){}`), whose child
//     class_declaration/function_declaration would be silently lost if
//     export_statement were an import type. Instead `_extraWalkTs` (below)
//     inspects every export_statement: with a `source` field (a re-export,
//     `export {x} from './y'` / `export * from './y'` / `export * as ns from
//     './y'`) it registers IMPORT nodes as `_importTs` would; without one (a
//     plain declaration export) normal recursion — which runs after
//     extraWalkFn — picks up the wrapped declaration.
//   - `new_expression` (`new Foo()`) is wired as a call site — base.js's
//     per-callType `calleeFieldByType` resolves its callee (the `constructor`
//     field, not `function`). Persisted as INSTANTIATES, not CALLS
//     (`instantiationNodeTypes`).
//   - `member_expression`'s `object` field (the receiver, e.g. `mod` in
//     `mod.thing()`) resolves a CALLS edge only when the receiver is a
//     same-file import alias. `this.method()` calls do not resolve — same
//     refuse-to-guess choice as java.js's bare `object` field and python.js's
//     `self.method()`.
//   - Arrow-function class fields (`onClick = () => {}`) are NOT extracted as
//     METHOD nodes: `functionTypes` matches a node's own `type` directly and
//     has no "look inside this class field's value" mode; it does not include
//     `arrow_function`.
//   - TS namespace/module containers (`namespace Foo { ... }` /
//     `module Foo { ... }`, tree-sitter's `internal_module`) are not treated as
//     a DEFINED_IN-style grouping container. Declarations nested inside one are
//     still extracted as top-level CLASS/METHOD/IMPORT, just not linked to the
//     namespace itself, which is not a node in the closed contract.
//
// Module-level const/arrow extraction (see base.js's `registerCallableBody`/
// `registeredCallableIds` for the body-walk half), scoped to
// `lexical_declaration` (`const`/`let`) only:
//   - `const f = () => {}` / `const f = function(){}` (module-level only) ->
//     METHOD node `f()`, registered as a same-file callable, body walkable.
//   - `const X = {...}` / `= [...]` / `= call()` / `= new Foo()` (module-level
//     only) -> CLASS node `X` (bare label, no parens) — the closed
//     CLASS/METHOD/IMPORT vocabulary's only bare-label node type; node only,
//     no body walk.
//   - Scope guard: ONLY emitted for module-level declarations
//     (`node.parent.type === 'program'`, or `'export_statement'` whose own
//     parent is `'program'`). A `const` inside a function/block is never
//     emitted here — its calls are still reached via the enclosing function's
//     body walk; emitting a bare-named node for it would collide as a god-node.
//   - Constructor parameter-property shorthand (`constructor(private x:
//     string)`, TS-only sugar that implicitly declares a class field),
//     `this.foo = value` assignment tracking, decorator edges
//     (`@Component`, `@Injectable`, ...), dynamic `import('./x')` call
//     recognition, and every indirect-callback/dispatch-table/
//     assignment/return-reference site are dropped: each feeds a
//     reference-edge context outside this codebase's closed `EDGE_TYPES`
//     vocabulary (`extractors/base.js`), or exists solely to feed
//     cross-reference resolution this module does not attempt.

const base = require('./base');

const CONFIG = base.LanguageConfig({
  classTypes: new Set([
    'class_declaration',
    'abstract_class_declaration', // TS abstract class
    'interface_declaration',      // parity with Java/C#
    'enum_declaration',           // named enums
    'type_alias_declaration',     // named type aliases
  ]),
  functionTypes: new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'method_signature']),
  importTypes: new Set(['import_statement']),
  // `new_expression` joins callTypes now that base.js supports a per-callType
  // calleeField (calleeFieldByType, below): `new Foo()` / `new ns.Foo()`
  // expose the callee under a `constructor` field, `new Foo<T>()`'s type
  // arguments live on a separate `type_arguments` field walkGeneric never
  // reads, so no special-casing is needed there.
  callTypes: new Set(['call_expression', 'new_expression']),
  callFunctionField: 'function',
  calleeFieldByType: new Map([['new_expression', 'constructor']]),
  instantiationNodeTypes: new Set(['new_expression']),
  callAccessorNodeTypes: new Set(['member_expression']),
  callAccessorField: 'property',
  callAccessorObjectField: 'object',
  // `this.x()` / `super.x()` receivers resolve tier-1 same-class before
  // falling to the bare-name plane.
  selfTokens: new Set(['this', 'super']),
  functionBoundaryTypes: new Set(['function_declaration', 'generator_function_declaration', 'arrow_function', 'method_definition']),
  importHandler: _importTs,
  extraWalkFn: _extraWalkTs,
  // tree-sitter-typescript's `parameters` field resolves to formal_parameters,
  // whose entries are required_parameter/optional_parameter (each exposing the
  // binding under a `pattern` field — paramEntryName's field list already tries
  // it). `async` is a literal direct child when present. Decorators are NOT
  // wrapped or field-attached to the method_definition at all — they are its
  // own immediate PRECEDING siblings inside class_body (`@Input() name: string;
  // @deco async doThing(){}` parses decorator as a sibling node right before
  // the method_definition, not a child of it) — the one language in this port
  // needing decoratorSiblingScan rather than a container/parent-wrap.
  paramEntryTypes: new Set(['required_parameter', 'optional_parameter']),
  asyncMarkerText: 'async',
  decoratorNodeTypes: new Set(['decorator']),
  decoratorSiblingScan: true,
  // Same grammar family as javascript.js — same node types.
  branchNodeTypes: new Set(['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression']),
  logicalOperatorField: 'operator',
  logicalOperatorTokens: new Set(['&&', '||']),
});

// Reads a tree-sitter `string` node's text with its quote characters
// stripped, preferring the grammar's own `string_fragment` child (present on
// every non-empty string literal) over a manual quote-trim so a literal
// containing an escaped matching quote is not mis-stripped.
function _modulePathText(stringNode) {
  const frag = (stringNode.children || []).find((c) => c.type === 'string_fragment');
  if (frag) return base._readText(frag);
  return base._readText(stringNode).replace(/^['"`]|['"`]$/g, '');
}

// Handles the `import_statement` forms only
// (export_statement re-exports are handled by _extraWalkTs below, since
// export_statement is deliberately not in CONFIG.importTypes — see the
// file-header divergence note). tree-sitter-typescript's parse tree:
//   `import Foo from './foo'`        -> import_clause > identifier (default)
//   `import * as ns from './ns'`     -> import_clause > namespace_import > identifier
//   `import { a, b as bb } from './m'` -> import_clause > named_imports > import_specifier(s)
//   `import './x'`                   -> no import_clause at all (side-effect)
//   `import x = require('./m')`      -> import_require_clause (TS import-equals form)
// There is no meaningful "imported symbol name" for a default or namespace
// import — the module path itself is the closest analogue (mirroring the
// pre-fan-out bespoke extractTypeScriptTreeSitter's own choice to name IMPORT
// nodes after the module specifier) — while the local binding becomes the
// `alias` walkGeneric's same-file CALLS resolution keys on
// (`importedAliases`/`importByAlias`). Named imports are the one form with a
// real external symbol name, so those use the imported name itself.
// See javascript.js's identical comment — `module` is always `modulePath`
// here too.
function _importTs(node, source, ctx) {
  const out = [];
  const reqClause = (node.children || []).find((c) => c.type === 'import_require_clause');
  if (reqClause) {
    const idNode = (reqClause.children || []).find((c) => c.type === 'identifier');
    const strNode = (reqClause.children || []).find((c) => c.type === 'string');
    const modulePath = strNode ? _modulePathText(strNode) : null;
    if (modulePath) out.push({ name: modulePath, alias: idNode ? base._readText(idNode) : undefined, module: modulePath });
    return out;
  }

  const sourceNode = node.childForFieldName('source');
  const modulePath = sourceNode ? _modulePathText(sourceNode) : null;
  const clause = (node.children || []).find((c) => c.type === 'import_clause');
  if (!clause) {
    if (modulePath) out.push({ name: modulePath, module: modulePath }); // side-effect import: import './x';
    return out;
  }

  for (const child of clause.children || []) {
    if (child.type === 'identifier') {
      if (modulePath) out.push({ name: modulePath, alias: base._readText(child), module: modulePath });
    } else if (child.type === 'namespace_import') {
      const idNode = (child.children || []).find((c) => c.type === 'identifier');
      if (modulePath && idNode) out.push({ name: modulePath, alias: base._readText(idNode), module: modulePath });
    } else if (child.type === 'named_imports') {
      for (const spec of child.children || []) {
        if (spec.type !== 'import_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        if (!nameNode) continue;
        out.push({
          name: base._readText(nameNode),
          alias: aliasNode ? base._readText(aliasNode) : undefined,
          module: modulePath || undefined,
        });
      }
    }
  }
  return out;
}

// Handles export_statement re-exports (`export {x} from './y'`, `export *
// from './y'`, `export * as ns from './y'`) by registering the same import
// facts an equivalent `import` would — via base.js's shared
// `registerImportFact`, never a base.js edit elsewhere. A plain declaration
// export (`export class Foo {}`) has no `source` field and this function does
// nothing for it — normal recursion (which walkGeneric always runs after
// extraWalkFn, per its own control flow) picks up the wrapped
// class_declaration/function_declaration/etc. as CLASS/METHOD exactly as if
// `export` were not present.
// `function` is kept even
// though live tree-sitter-typescript parses never emit a bare `function` node
// type (anonymous function expressions parse as `function_expression`); it is
// kept in the set as a harmless superset.
const _FUNCTION_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
// The object/array/factory literal branch.
// `as_expression` (`x as Foo`) is TS-only; harmless to include in a shared
// constant even where a grammar never produces it.
const _CONST_VALUE_TYPES = new Set(['object', 'array', 'as_expression', 'call_expression', 'new_expression']);

// `base.detectAsync` just needs asyncMarkerText — a full LanguageConfig is
// overkill for this one field.
const _ASYNC_MARKER_CONFIG = { asyncMarkerText: 'async' };
// arrow_function's `parameters` field is ONLY present when the param list is
// parenthesized (`(a, b) =>`); a single bare param (`a => a+1`) has no
// wrapping formal_parameters node at all — the identifier sits as a direct
// child instead (`a => b`'s arrow_function children are [identifier('a'), '=>',
// identifier('b')] — the FIRST direct identifier child is always the parameter,
// since it precedes both the arrow token and the body textually).
function _extractValueArgs(valueNode) {
  const paramsNode = valueNode.childForFieldName('parameters');
  if (paramsNode) {
    // Same required_parameter/optional_parameter shape as method_definition —
    // arrow_function reuses the identical formal_parameters grammar rule,
    // unlike plain JS's flat identifier/assignment_pattern/rest_pattern shape
    // javascript.js's copy of this helper uses.
    return base.extractArgs(paramsNode, new Set(['required_parameter', 'optional_parameter']));
  }
  if (valueNode.type !== 'arrow_function') return [];
  const bare = (valueNode.children || []).find((c) => c.type === 'identifier');
  return bare ? [base._readText(bare)] : [];
}

// The module-level scope guard.
function _isModuleLevel(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'program') return true;
  return parent.type === 'export_statement' && !!parent.parent && parent.parent.type === 'program';
}

// See the file-header divergence note above. Handles every
// `variable_declarator` inside a module-level `lexical_declaration`
// (`const`/`let`); nested/block-scoped declarations are refused by
// `_isModuleLevel` (the scope guard the god-node fix documents).
function _handleModuleLevelConst(node, source, ctx) {
  if (!_isModuleLevel(node)) return;
  for (const child of node.children || []) {
    if (child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');
    // `nameNode.type !== 'identifier'` covers destructuring targets
    // (`const { a } = foo()`, `const [a, b] = pair()`) — a bare
    // `child_by_field_name("name")` + `_read_text` would stringify the whole
    // pattern (`"{ loadFoundation }"`, `"[a, b]"`) into a garbage node name;
    // there is no single bound identifier to name a node after, so these are
    // refused rather than silently emitting a malformed symbol.
    if (!nameNode || nameNode.type !== 'identifier' || !valueNode) continue;
    const name = base._readText(nameNode);
    if (!name) continue;

    if (_FUNCTION_VALUE_TYPES.has(valueNode.type)) {
      // `const f = () => {}` / `= function(){}` — callable, mirrors the
      // functionTypes branch in base.js's own walk(): register as a same-file
      // callable and make its body walkable (registerCallableBody, which also
      // marks the arrow/function-expression node itself as "already going to be
      // visited," so walkCalls' boundary-skip does not re-walk it a second time
      // under the wrong caller).
      const idx = ctx.addNode({
        node_type: 'METHOD', name,
        summary: `${name}()`,
        start_line: ctx.line(child), end_line: ctx.endLine(child),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
        // This METHOD population (an arrow/function-expression bound to a
        // module-level const) never reaches base.js's own walk()#functionTypes
        // branch — it is created here, in an extraWalkFn, before walkGeneric's
        // normal recursion even sees `valueNode`. Wired separately so its
        // `args` are not silently dropped. No class_context (module-level, no
        // owning CLASS) or decorators (arrow/function-expression values don't
        // carry them in this grammar).
        args: _extractValueArgs(valueNode),
        ...(base.detectAsync(valueNode, _ASYNC_MARKER_CONFIG) ? { is_async: true } : {}),
        // Same rationale as the args/is_async wiring above this
        // METHOD-creation site — CONFIG is this module's own top-level const,
        // in scope by closure.
        cyclomatic_complexity: base.computeCyclomatic(valueNode.childForFieldName('body'), CONFIG),
      });
      if (!ctx.methodByName.has(name)) ctx.methodByName.set(name, idx);
      const bodyNode = valueNode.childForFieldName('body');
      if (bodyNode) ctx.registerCallableBody(idx, bodyNode, valueNode);
    } else if (_CONST_VALUE_TYPES.has(valueNode.type)) {
      // `const X = {...}` / `= [...]` / `= call()` / `= new Foo()` — node
      // only, bare label, not callable (neither registered as
      // callable nor body-walked). Guard against `classByName` already holding
      // this name: validateOutput throws on a same-file duplicate CLASS, and an
      // extractor authoring bug should fail loudly rather than this call site
      // papering over it — but a same-named const cannot coexist with a
      // same-named class in valid JS/TS source (redeclaration error), so this
      // is defensive, not a reachable path in practice.
      if (ctx.classByName.has(name)) continue;
      const idx = ctx.addNode({
        node_type: 'CLASS', name,
        summary: name,
        start_line: ctx.line(child), end_line: ctx.endLine(child),
        confidence_tier: 'EXTRACTED', confidence: 1.0,
      });
      ctx.classByName.set(name, idx);
    }
  }
}

// Base type name of a TS type node, mirroring java.js's `_typeIdentifierNames`
// for this grammar's shapes: `type_identifier` is the base case;
// `nested_type_identifier` (`NS.FooService`) takes its LAST `type_identifier`
// child (the actual class, not the namespace qualifier — same convention
// java.js's `scoped_type_identifier` handling uses); `generic_type`
// (`Array<FooService>`) recurses into its own first child only, skipping
// `type_arguments` entirely (same "no flow analysis, base type only" scope
// java.js's `Comparable<Widget>` handling documents — `Array<FooService>`
// base-types to "Array", not "FooService"). Every other shape
// (union/intersection/literal/predefined types, `Foo[]`, ...) refuses (null)
// rather than guessing at a single class name it does not have.
function _tsTypeBaseName(node) {
  if (!node) return null;
  if (node.type === 'type_identifier') return base._readText(node);
  if (node.type === 'nested_type_identifier') {
    const last = [...(node.children || [])].reverse().find((c) => c.type === 'type_identifier');
    return last ? base._readText(last) : null;
  }
  if (node.type === 'generic_type') {
    const nameNode = node.childForFieldName('name');
    const baseNode = nameNode
      || (node.children || []).find((c) => c.type === 'type_identifier' || c.type === 'nested_type_identifier');
    return baseNode ? _tsTypeBaseName(baseNode) : null;
  }
  return null;
}

// `type_annotation`'s one named child (after the anonymous `:`) is the
// actual type node — `namedChildCount === 1` for every non-empty annotation.
function _tsFieldTypeName(typeAnnotationNode) {
  if (!typeAnnotationNode || typeAnnotationNode.namedChildCount < 1) return null;
  return _tsTypeBaseName(typeAnnotationNode.namedChild(0));
}

// Walks up from a `public_field_definition`/`required_parameter` to the
// nearest enclosing `class_declaration`/`abstract_class_declaration` and
// resolves it to its already-registered CLASS index via `ctx.classByName` —
// mirrors java.js's `_javaFieldOwnerClassIdx`.
function _tsFieldOwnerClassIdx(node, ctx) {
  let owner = node.parent;
  while (owner && owner.type !== 'class_declaration' && owner.type !== 'abstract_class_declaration') {
    owner = owner.parent;
  }
  if (!owner) return undefined;
  const nameNode = owner.childForFieldName('name');
  if (!nameNode) return undefined;
  return ctx.classByName.get(base._readText(nameNode));
}

// Two field shapes in tree-sitter-typescript:
//   - `public_field_definition` (`private readonly svc: FooService;`) —
//     `name` (property_identifier) + `type` (type_annotation) fields,
//     regardless of accessibility modifier (or lack of one — a plain
//     `svc: FooService;` is captured the same way).
//   - `required_parameter`/`optional_parameter` inside a constructor's
//     `formal_parameters` (`constructor(private readonly svc: FooService)`)
//     — TS parameter-property sugar that implicitly declares a class field.
//     A parameter property carries an `accessibility_modifier` child
//     (public/private/protected) and/or a bare `readonly` token child;
//     a PLAIN typed parameter (`plain: string`) has neither and is correctly
//     NOT captured as a field (it never becomes one).
function _captureTsField(node, ctx) {
  if (node.type === 'public_field_definition') {
    const nameNode = node.childForFieldName('name');
    const typeAnn = node.childForFieldName('type');
    if (!nameNode || !typeAnn) return;
    const typeName = _tsFieldTypeName(typeAnn);
    if (!typeName) return;
    const classIdx = _tsFieldOwnerClassIdx(node, ctx);
    base.recordClassField(ctx, classIdx, base._readText(nameNode), typeName);
    return;
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    const isParameterProperty = (node.children || [])
      .some((c) => c.type === 'accessibility_modifier' || c.type === 'readonly');
    if (!isParameterProperty) return;
    const patternNode = node.childForFieldName('pattern');
    const typeAnn = node.childForFieldName('type');
    if (!patternNode || patternNode.type !== 'identifier' || !typeAnn) return;
    const typeName = _tsFieldTypeName(typeAnn);
    if (!typeName) return;
    const classIdx = _tsFieldOwnerClassIdx(node, ctx);
    base.recordClassField(ctx, classIdx, base._readText(patternNode), typeName);
  }
}

// A JSX tag reference is REFERENCES evidence when (and only when) the tag name
// starts with an uppercase letter, the JSX/React convention distinguishing a
// user component (`<Foo/>`) from a native DOM element (`<div/>`) — a lowercase
// tag has no CLASS/METHOD node to reference at all, so filtering here (rather
// than letting every `<div>` reach resolveTypeReferenceEdges and refuse for
// lack of import evidence) is a precision guard, not a behavior difference.
// `Baz.Qux` (member_expression) namespace-qualified tags take the LEFTMOST
// identifier (the imported binding). In tree-sitter-tsx both
// `jsx_opening_element` and `jsx_self_closing_element` expose a `name` field,
// `identifier` or `member_expression`.
function _jsxComponentName(nameNode) {
  if (!nameNode) return null;
  if (nameNode.type === 'identifier') {
    const text = base._readText(nameNode);
    return /^[A-Z]/.test(text) ? text : null;
  }
  if (nameNode.type === 'member_expression') {
    let cur = nameNode;
    while (cur && cur.type === 'member_expression') {
      const obj = cur.childForFieldName('object');
      if (!obj) return null;
      cur = obj;
    }
    if (cur && cur.type === 'identifier') {
      const text = base._readText(cur);
      return /^[A-Z]/.test(text) ? text : null;
    }
  }
  return null;
}

// Walks up from a JSX tag to the nearest enclosing callable this port
// already registered (a named function_declaration/method_definition, OR a
// module-level `const Foo = () => ...` METHOD population, both keyed in
// `ctx.methodByName`) or class (ctx.classByName) to anchor the REFERENCES
// edge on. No flow analysis, no synthetic node — a JSX tag with no resolvable
// enclosing callable (e.g. a bare top-level `<Foo/>` outside any function)
// is refused, not guessed at (same "refuse to guess" shape as
// _tsFieldOwnerClassIdx returning undefined). Deliberately independent of
// base.js#walk's own parentClassIdx threading — that only tracks the
// enclosing CLASS, not the enclosing METHOD/const-arrow, and widening
// walk()'s own signature for this one caller is out of scope.
function _tsEnclosingCallableIdx(node, ctx) {
  let owner = node.parent;
  while (owner) {
    if (owner.type === 'function_declaration' || owner.type === 'method_definition' || owner.type === 'variable_declarator') {
      const nameNode = owner.childForFieldName('name');
      const name = nameNode ? base._readText(nameNode) : null;
      if (name && ctx.methodByName.has(name)) return ctx.methodByName.get(name);
    } else if (owner.type === 'class_declaration' || owner.type === 'abstract_class_declaration') {
      const nameNode = owner.childForFieldName('name');
      const name = nameNode ? base._readText(nameNode) : null;
      if (name && ctx.classByName.has(name)) return ctx.classByName.get(name);
    }
    owner = owner.parent;
  }
  return undefined;
}

function _emitJsxComponentReference(node, ctx) {
  const nameNode = node.childForFieldName('name');
  const componentName = _jsxComponentName(nameNode);
  if (!componentName) return;
  const fromIdx = _tsEnclosingCallableIdx(node, ctx);
  if (fromIdx === undefined) return;
  const targetIdx = ctx.classByName.get(componentName) ?? ctx.methodByName.get(componentName);
  if (targetIdx !== undefined && targetIdx !== fromIdx) {
    ctx.addEdge(fromIdx, targetIdx, 'REFERENCES', 'same_file', ctx.line(node));
  } else if (targetIdx === undefined) {
    ctx.addTypeReference(fromIdx, componentName, ctx.line(node));
  }
}

function _extraWalkTs(node, source, ctx) {
  _captureTsField(node, ctx);
  if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
    _emitJsxComponentReference(node, ctx);
  }
  if (node.type === 'lexical_declaration') {
    _handleModuleLevelConst(node, source, ctx);
    return;
  }
  if (node.type !== 'export_statement') return;
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return; // plain declaration export — let normal recursion handle it
  const modulePath = _modulePathText(sourceNode);
  if (!modulePath) return;

  const clause = (node.children || []).find((c) => c.type === 'export_clause');
  const imported = [];
  if (clause) {
    for (const spec of clause.children || []) {
      if (spec.type !== 'export_specifier') continue;
      const nameNode = spec.childForFieldName('name');
      if (nameNode) imported.push({ name: base._readText(nameNode), module: modulePath });
    }
  } else {
    // `export * from './x'` or `export * as ns from './x'` — no individual
    // symbol names to recover; register the module itself, mirroring
    // python.js's wildcard-import handling.
    imported.push({ name: modulePath, module: modulePath });
  }

  // registerImportFact (base.js) records the import — same dedup contract
  // (ctx.importedAliases), no node created.
  for (const im of imported) {
    base.registerImportFact(ctx, { name: im.name, alias: im.alias, module: im.module, line: ctx.line(node) });
  }

  // The re-export itself is FILE-to-FILE evidence (RE_EXPORTS) — additive to
  // the import-fact registration above, not a replacement (import facts still
  // feed import-evidence resolution for CALLS/REFERENCES/etc; RE_EXPORTS is a
  // distinct, directly-persisted structural edge, resolved at ingest time —
  // see ingest.js#resolveReExportEdges).
  ctx.addReExportFact(modulePath, ctx.line(node));
}

let _tsParserState = 'pending'; // 'pending' | 'ready' | 'failed'
let _tsxParserState = 'pending';
let _tsParser = null;
let _tsxParser = null;
let _parserReadyPromise = null;

// Unlike every other Tier 2 extractor (one grammar), TypeScript must load
// TWO: `typescript` for .ts/.mts/.cts, `tsx` for .tsx/.jsx (tree-sitter's TSX
// grammar is JSX-aware; parsing a .tsx file with the plain typescript grammar
// silently fails on JSX expressions). Both load through base.js's shared, memoized
// loadGrammar so web-tree-sitter's Parser.init() still only runs once per
// process (extractors/go.js's identical comment).
function _ensureParserReady() {
  if (!_parserReadyPromise) {
    _parserReadyPromise = (async () => {
      try {
        _tsParser = await base.loadGrammar('typescript');
        _tsParserState = 'ready';
      } catch (_) {
        _tsParserState = 'failed';
      }
      try {
        _tsxParser = await base.loadGrammar('tsx');
        _tsxParserState = 'ready';
      } catch (_) {
        _tsxParserState = 'failed';
      }
    })();
  }
  return _parserReadyPromise;
}

function _isTsxLike(filePath) {
  const p = String(filePath || '').toLowerCase();
  return p.endsWith('.tsx') || p.endsWith('.jsx');
}

function extract(tree, content, filePath) {
  const result = base.walkGeneric(tree, content, CONFIG);
  result.nodes = result.nodes.map((n) => ({ ...n, _sourceFile: n._sourceFile || filePath }));
  return result;
}

async function extractFile(filePath, content) {
  await _ensureParserReady();
  const useTsx = _isTsxLike(filePath);
  const parser = useTsx ? _tsxParser : _tsParser;
  const state = useTsx ? _tsxParserState : _tsParserState;
  if (state !== 'ready') {
    return { nodes: [], edges: [] };
  }
  const tree = parser.parse(content);
  return extract(tree, content, filePath);
}

async function ready() {
  await _ensureParserReady();
  return (_tsParserState === 'ready' && _tsxParserState === 'ready') ? 'ready' : 'failed';
}

module.exports = { extract, extractFile, ready, CONFIG };
