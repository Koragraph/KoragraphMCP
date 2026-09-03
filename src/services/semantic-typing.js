'use strict';

// Deterministic semantic role typing from framework annotations.
//
// The AST plane already stores every annotation verbatim on CLASS and METHOD nodes
// (properties.decorators — collectDecorators in extractors/base.js, buildClassInfo /
// buildFuncInfo in ast-extractor.js). This module reads them to derive SERVICE, REPOSITORY,
// ENDPOINT and TEST role nodes deterministically, from facts sitting in the source as
// literal text.
//
// Shape contract: role nodes are emitted ALONGSIDE the CLASS node, not by retyping it.
// Retyping would change the CLASS node's canonical_key and orphan every
// CONTAINS/DEFINED_IN edge already pointing at it.

const path = require('path');

// ─── annotation helpers ───────────────────────────────────────────────────────

// A decorator is stored as its full source text: '@RequestMapping("api")',
// '@PreAuthorize("hasRole(@roles.OWNER_ADMIN)")'. Match on the NAME only, anchored, so
// @RequestMapping never matches @RequestMappingHandler.
// Three syntaxes, one parser. Java/Kotlin/TS/Python write `@Name(...)`; C# and PHP 8 write
// `[Name(...)]`, and csharp.js stores the inner `attribute` node, so the text can arrive with
// or without its brackets. Anchoring on `@` alone silently excluded every C# codebase.
function annotationName(decorator) {
  const m = /^[@[]?\s*([\w.]+)/.exec(String(decorator || '').trim());
  return m ? m[1].split('.').pop() : null;
}

function annotationNames(node) {
  const decorators = (node && node.decorators) || [];
  return decorators.map(annotationName).filter(Boolean);
}

function findAnnotation(node, name) {
  for (const d of (node && node.decorators) || []) {
    if (annotationName(d) === name) return String(d);
  }
  return null;
}

function hasAnnotation(node, ...names) {
  const present = new Set(annotationNames(node));
  return names.some((n) => present.has(n));
}

// First string literal inside an annotation's argument list:
//   @RequestMapping("api")                     -> 'api'
//   @GetMapping(value = "/owners/{id}")        -> '/owners/{id}'
//   @Controller('cats')                        -> 'cats'
//   @GetMapping                                -> null  (no args at all)
function annotationArgString(decorator) {
  if (!decorator) return null;
  const open = decorator.indexOf('(');
  if (open === -1) return null;
  const m = /["'`]([^"'`]*)["'`]/.exec(decorator.slice(open));
  return m ? m[1] : null;
}

function joinRoute(base, leaf) {
  const b = String(base || '').trim();
  const l = String(leaf || '').trim();
  const parts = [b, l]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}

// ─── rule tables ──────────────────────────────────────────────────────────────

// Java / Spring class-level role annotations → node_type of the emitted role node.
const JAVA_CLASS_ROLES = [
  { annotations: ['Service'], nodeType: 'SERVICE' },
  { annotations: ['Repository'], nodeType: 'REPOSITORY' },
  { annotations: ['Mapper'], nodeType: 'UTILITY', role: 'mapper' },
  { annotations: ['Configuration'], nodeType: 'CONFIG_CLASS' },
];

// TypeScript decorators. @Injectable is Angular's service marker AND Nest's; the file's
// other decorators disambiguate, so this table is consulted after that check.
const TS_CLASS_ROLES = [
  { annotations: ['Component'], nodeType: 'ANGULAR_COMPONENT' },
  { annotations: ['NgModule'], nodeType: 'MODULE' },
  { annotations: ['Directive'], nodeType: 'ANGULAR_COMPONENT', role: 'directive' },
  { annotations: ['Pipe'], nodeType: 'UTILITY', role: 'pipe' },
];

// Interface-name conventions. Only consulted when no annotation matched, and only for
// interfaces — a CLASS named FooService without @Service is a guess too far.
const ANNOTATION_LANGS = new Set(['java', 'kotlin', 'csharp']);
const CONVENTION_LANGS = new Set(['java', 'kotlin', 'csharp']);

const CONVENTION_SUFFIX_ROLES = [
  { suffix: 'Repository', nodeType: 'REPOSITORY', allowClass: false },
  { suffix: 'Service', nodeType: 'SERVICE', allowClass: false },
];

const SPRING_METHOD_VERBS = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

const NEST_METHOD_VERBS = {
  Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', All: 'ANY',
};

const CSHARP_METHOD_VERBS = {
  HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH',
};

// Authorize covers ASP.NET; the rest are Spring / JSR-250.
const AUTH_ANNOTATIONS = ['PreAuthorize', 'Secured', 'RolesAllowed', 'PostAuthorize', 'DenyAll', 'Authorize'];

const TEST_ANNOTATIONS = [
  // JVM
  'SpringBootTest', 'WebMvcTest', 'DataJpaTest', 'ExtendWith', 'RunWith',
  // .NET — xUnit / NUnit / MSTest
  'Fact', 'Theory', 'Test', 'TestFixture', 'TestClass', 'TestMethod',
];

// Python route decorators: @app.get("/x"), @router.post("/x"), @bp.route("/x", methods=[...])
const PY_ROUTE_RE = /^@(\w+)\.(get|post|put|delete|patch|route)\s*\(/i;

// ─── test detection ───────────────────────────────────────────────────────────

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)|(\.|_)(test|spec)\.[\w]+$|Tests?\.java$|Test\.kt$/i;

function looksLikeTestFile(relPath) {
  return TEST_PATH_RE.test(relPath || '');
}

// ─── derivation ───────────────────────────────────────────────────────────────

function classOwnerIndex(astNodes, structuralEdges) {
  const owner = new Map();
  for (const e of structuralEdges || []) {
    if (e.edgeType !== 'DEFINED_IN') continue;
    const t = astNodes[e.toIndex];
    if (t && (t.node_type === 'CLASS' || t.node_type === 'ENTITY')) owner.set(e.fromIndex, e.toIndex);
  }
  return owner;
}

// Spring's class-level @RequestMapping is the route prefix every method mapping hangs off.
function springBasePath(classNode) {
  const rm = findAnnotation(classNode, 'RequestMapping');
  return rm ? (annotationArgString(rm) || '') : '';
}

function nestBasePath(classNode) {
  const c = findAnnotation(classNode, 'Controller');
  return c ? (annotationArgString(c) || '') : '';
}

// ASP.NET's [Route("api/[controller]")] contains a literal token the framework substitutes
// with the controller's name minus its "Controller" suffix. Leaving it unexpanded would name
// the endpoint "GET /api/[controller]/{id}", which matches no real request path.
function csharpBasePath(classNode) {
  const r = findAnnotation(classNode, 'Route');
  const raw = r ? (annotationArgString(r) || '') : '';
  if (!raw.includes('[controller]') || !classNode || !classNode.name) return raw;
  return raw.replace(/\[controller\]/g, classNode.name.replace(/Controller$/, ''));
}

function authEvidence(node) {
  for (const name of AUTH_ANNOTATIONS) {
    const a = findAnnotation(node, name);
    if (a) return a;
  }
  return null;
}

/**
 * Derives semantic role nodes and edges from annotations already present on astNodes.
 * Pure: does not mutate astNodes. Returns nodes to append and index-based edges, using the
 * same {fromIndex,toIndex,edgeType} shape buildAstNodes emits, with indices valid against
 * astNodes.concat(result.nodes).
 */
const JS_LANGS = new Set(['javascript', 'typescript']);

function deriveSemanticNodes(astNodes, { structuralEdges = [], relPath = '', lang = null, source = null } = {}) {
  if (!Array.isArray(astNodes) || astNodes.length === 0) return { nodes: [], edges: [] };

  const out = [];
  const edges = [];
  const owner = classOwnerIndex(astNodes, structuralEdges);
  const isTestFile = looksLikeTestFile(relPath);
  const base = astNodes.length;
  const idxOf = (n) => base + out.indexOf(n);

  const push = (node, fromAstIndex, edgeType) => {
    // Inherit the declaration's span so the role node is inspectable — it points at the
    // same lines the annotation was read from.
    const src = fromAstIndex !== null && fromAstIndex !== undefined ? astNodes[fromAstIndex] : null;
    if (src) {
      node.start_line = src.start_line ?? src.line ?? null;
      node.end_line = src.end_line ?? null;
    }
    out.push(node);
    if (fromAstIndex !== null && fromAstIndex !== undefined) {
      edges.push({ fromIndex: idxOf(node), toIndex: fromAstIndex, edgeType, resolution: 'same_file' });
    }
    return node;
  };

  const mkNode = (nodeType, name, summary, extra = {}) => ({
    node_type: nodeType,
    name,
    summary,
    // EXTRACTED: the annotation is literal text in the file. This is the same tier the AST
    // plane claims for a declaration it read directly, and it is the whole point — these
    // facts stop being a model's guess.
    confidence_tier: 'EXTRACTED',
    confidence: 1.0,
    extraction_source_hint: 'ast_semantic',
    ...extra,
  });

  // Detect the TypeScript flavour once per file: Nest controllers and Angular components
  // both decorate with @Injectable, and only the sibling decorators tell them apart.
  const tsIsNest = astNodes.some((n) => n.node_type === 'CLASS' && hasAnnotation(n, 'Controller'));

  for (let i = 0; i < astNodes.length; i++) {
    const node = astNodes[i];
    if (!node || !node.name) continue;

    // ── class-level roles ────────────────────────────────────────────────────
    if (node.node_type === 'CLASS' || node.node_type === 'ENTITY') {
      if (isTestFile || hasAnnotation(node, ...TEST_ANNOTATIONS)) {
        push(mkNode('TEST', node.name, `Test suite ${node.name}`, {
          test_framework: hasAnnotation(node, 'SpringBootTest') ? 'spring-boot-test' : null,
        }), i, 'TESTS');
        continue;
      }

      const table = ANNOTATION_LANGS.has(lang) ? JAVA_CLASS_ROLES : TS_CLASS_ROLES;
      let matched = false;
      for (const rule of table) {
        if (!hasAnnotation(node, ...rule.annotations)) continue;
        push(mkNode(rule.nodeType, node.name, `${rule.role || rule.nodeType.toLowerCase()} ${node.name}`,
          rule.role ? { role: rule.role } : {}), i, 'CONTAINS');
        matched = true;
        break;
      }

      // Convention rule, INFERRED tier. The annotation pass finds only annotated classes;
      // an unannotated `*Repository` PORT INTERFACE (OwnerRepository, PetRepository, …) that
      // an annotated impl implements is still the repository in the hexagonal sense. Naming
      // is weaker evidence than an annotation, so these are written INFERRED, not EXTRACTED —
      // the tier is the honesty.
      if (!matched && CONVENTION_LANGS.has(lang)) {
        const conv = CONVENTION_SUFFIX_ROLES.find(
          (r) => node.name.endsWith(r.suffix) && (node.kind === 'interface' || r.allowClass));
        if (conv && !isTestFile) {
          const roleNode = mkNode(conv.nodeType, node.name, `${conv.nodeType.toLowerCase()} interface ${node.name}`,
            { role_evidence: 'name_convention' });
          roleNode.confidence_tier = 'INFERRED';
          roleNode.confidence = 0.8;
          push(roleNode, i, 'CONTAINS');
        }
      }

      // @Injectable: Angular service unless the file is a Nest controller module.
      if (!matched && hasAnnotation(node, 'Injectable')) {
        push(mkNode(tsIsNest ? 'SERVICE' : 'ANGULAR_SERVICE', node.name,
          `injectable service ${node.name}`), i, 'CONTAINS');
      }
      continue;
    }

    // ── method-level routes and auth ─────────────────────────────────────────
    if (node.node_type !== 'METHOD') continue;

    const ownerIdx = owner.get(i);
    const ownerClass = ownerIdx !== undefined ? astNodes[ownerIdx] : null;

    // Spring
    for (const [anno, verb] of Object.entries(SPRING_METHOD_VERBS)) {
      const decorator = findAnnotation(node, anno);
      if (!decorator) continue;
      const route = joinRoute(springBasePath(ownerClass), annotationArgString(decorator) || '');
      push(mkNode('ENDPOINT', `${verb} ${route}`, `${verb} ${route} handled by ${node.name}`, {
        http_method: verb, route, handler: node.name,
        controller: ownerClass ? ownerClass.name : null,
      }), i, 'HANDLED_BY');
      break;
    }

    // Spring's bare @RequestMapping on a method carries its verb in a `method =` argument.
    const methodRequestMapping = findAnnotation(node, 'RequestMapping');
    if (methodRequestMapping && ownerClass) {
      const verbMatch = /RequestMethod\.(\w+)/.exec(methodRequestMapping);
      const verb = verbMatch ? verbMatch[1].toUpperCase() : 'ANY';
      const route = joinRoute(springBasePath(ownerClass), annotationArgString(methodRequestMapping) || '');
      push(mkNode('ENDPOINT', `${verb} ${route}`, `${verb} ${route} handled by ${node.name}`, {
        http_method: verb, route, handler: node.name, controller: ownerClass.name,
      }), i, 'HANDLED_BY');
    }

    // NestJS
    if (tsIsNest) {
      for (const [anno, verb] of Object.entries(NEST_METHOD_VERBS)) {
        const decorator = findAnnotation(node, anno);
        if (!decorator) continue;
        const route = joinRoute(nestBasePath(ownerClass), annotationArgString(decorator) || '');
        push(mkNode('ENDPOINT', `${verb} ${route}`, `${verb} ${route} handled by ${node.name}`, {
          http_method: verb, route, handler: node.name,
          controller: ownerClass ? ownerClass.name : null,
        }), i, 'HANDLED_BY');
        break;
      }
    }

    // ASP.NET Core
    if (lang === 'csharp') {
      for (const [anno, verb] of Object.entries(CSHARP_METHOD_VERBS)) {
        const decorator = findAnnotation(node, anno);
        if (!decorator) continue;
        const route = joinRoute(csharpBasePath(ownerClass), annotationArgString(decorator) || '');
        push(mkNode('ENDPOINT', `${verb} ${route}`, `${verb} ${route} handled by ${node.name}`, {
          http_method: verb, route, handler: node.name,
          controller: ownerClass ? ownerClass.name : null,
        }), i, 'HANDLED_BY');
        break;
      }
    }

    // Python web frameworks
    if (lang === 'python') {
      for (const d of node.decorators || []) {
        const m = PY_ROUTE_RE.exec(String(d).trim());
        if (!m) continue;
        const route = annotationArgString(String(d)) || '/';
        let verb = m[2].toUpperCase();
        if (verb === 'ROUTE') {
          const methods = /methods\s*=\s*\[([^\]]*)\]/i.exec(String(d));
          verb = methods ? (/["'](\w+)["']/.exec(methods[1]) || [, 'GET'])[1].toUpperCase() : 'GET';
        }
        push(mkNode('ENDPOINT', `${verb} ${route}`, `${verb} ${route} handled by ${node.name}`, {
          http_method: verb, route, handler: node.name,
        }), i, 'HANDLED_BY');
        break;
      }
    }
  }

  // ── JS/TS call-expression routes (Express / Koa-router / Fastify) ──────────
  // These frameworks register a route with a function call, `app.get('/x', handler)`, not a method
  // decorator, so the astNode loop above never sees them. framework-routes.js reads the raw source
  // and returns the routes; here each becomes an ENDPOINT node, wired to its handler declaration by
  // name (same file) exactly as the decorator routes are — HANDLED_BY. A route whose handler is
  // inline, or defined in another file, is still recorded, just without the edge.
  if (source && JS_LANGS.has(lang) && !isTestFile) {
    const { detectJsRoutes } = require('./framework-routes');
    const declByName = new Map();
    for (let i = 0; i < astNodes.length; i++) {
      const n = astNodes[i];
      if (n && n.name && (n.node_type === 'FUNCTION' || n.node_type === 'METHOD') && !declByName.has(n.name)) {
        declByName.set(n.name, i);
      }
    }
    const seen = new Set();
    for (const r of detectJsRoutes(source)) {
      const key = `${r.verb} ${r.route}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const handlerIdx = r.handler !== null && r.handler !== undefined ? declByName.get(r.handler) : undefined;
      const node = mkNode('ENDPOINT', key,
        `${r.verb} ${r.route} handled by ${r.handler || 'an inline handler'}`,
        { http_method: r.verb, route: r.route, handler: r.handler || null, framework: 'js_router' });
      push(node, handlerIdx !== undefined ? handlerIdx : null, 'HANDLED_BY');
    }
  }

  // ── auth: a property on the method node, plus its evidence ─────────────────
  // Emitted as a patch list rather than a node — "this handler is role-guarded" is an
  // attribute of the handler, not an AUTH_PROTECTED_BY edge to a role string that resolves
  // to nothing in the graph.
  const patches = [];
  for (let i = 0; i < astNodes.length; i++) {
    const evidence = authEvidence(astNodes[i]);
    if (evidence) patches.push({ index: i, auth_annotation: evidence });
  }

  return { nodes: out, edges, patches };
}

module.exports = {
  deriveSemanticNodes,
  annotationName,
  annotationNames,
  annotationArgString,
  hasAnnotation,
  findAnnotation,
  joinRoute,
  looksLikeTestFile,
};
