// openapi.js — deterministic (zero-token) OpenAPI/Swagger parser. Detects an OpenAPI/Swagger
// document (top-level `openapi:`/`swagger:` key), parses YAML or JSON, and emits
// one ENDPOINT descriptor per paths.<path>.<method>. Never throws: non-OpenAPI
// documents, plain YAML (e.g. k8s manifests), and parse errors all return [].

'use strict';

const yaml = require('js-yaml');

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function loadDoc(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  } catch (_) {
    // fall through to YAML — some JSON-looking content is actually YAML flow style
  }
  try {
    return yaml.load(trimmed);
  } catch (_) {
    return null;
  }
}

// isOpenApiDoc(doc) -> boolean — the detection marker: a top-level `openapi` or
// `swagger` key. Plain YAML (k8s manifests, CI config, etc.) never has these.
function isOpenApiDoc(doc) {
  return !!doc && typeof doc === 'object' && (typeof doc.openapi === 'string' || typeof doc.swagger === 'string');
}

// parseOpenApi(content) -> [{ name: "METHOD /path", method, path, confidence_tier }]
// Zero-token, deterministic. Returns [] on non-OpenAPI content or parse failure.
function parseOpenApi(content) {
  const doc = loadDoc(content);
  if (!isOpenApiDoc(doc) || !doc.paths || typeof doc.paths !== 'object') return [];

  const endpoints = [];
  for (const [routePath, methods] of Object.entries(doc.paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, operation] of Object.entries(methods)) {
      const verb = method.toLowerCase();
      if (!HTTP_METHODS.has(verb) || operation === null || operation === undefined) continue;
      endpoints.push({
        node_type: 'ENDPOINT',
        name: `${verb.toUpperCase()} ${routePath}`,
        method: verb.toUpperCase(),
        path: routePath,
        confidence_tier: 'EXTRACTED',
      });
    }
  }
  return endpoints;
}

module.exports = { parseOpenApi, isOpenApiDoc };
