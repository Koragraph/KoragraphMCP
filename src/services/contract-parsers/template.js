'use strict';

// Deterministic (zero-token) reader for server-side view templates.
//
// Templates were the largest structural hole in the graph. Measured on
// spring-petclinic branch 11708: 480 of 1185 nodes were CONFIG_VALUE message
// keys sitting in ten 53-node islands — a message catalogue's FILE node and its
// 52 keys, connected to nothing. 43% of the graph was unreachable from any
// controller, because the only thing in the repository that names those keys is
// a Thymeleaf template, and templates were never read. django-machina shows the
// same shape: 428 CONFIG_VALUE outside the largest component, 75 unread .html.
//
// Three facts are worth reading out of a template, all of them links the rest
// of the graph cannot supply:
//   messageKeys  — the i18n keys it renders           -> USES_CONFIG
//   templateRefs — the templates it extends/includes  -> REFERENCES
//   urlRefs      — the routes it links to             -> REFERENCES
//
// Everything here is regex over markup. No parser, no LLM, no network.

const TEMPLATE_EXTS = new Set(['.html', '.htm', '.jsp', '.jinja', '.jinja2', '.j2', '.twig', '.erb', '.vm', '.mustache', '.hbs']);

// A template is any file with a template extension that also lives under a
// directory a framework treats as a view root. The directory requirement is
// what keeps documentation HTML, coverage reports and vendored widgets out.
const VIEW_ROOT_RE = /(?:^|\/)(templates?|views?|jsp|WEB-INF)\//i;

function isTemplateFile(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  if (!TEMPLATE_EXTS.has(filePath.slice(dot).toLowerCase())) return false;
  return VIEW_ROOT_RE.test(filePath);
}

// The logical name a controller uses to select this template: the path below
// the last view-root directory, without its extension. `src/main/resources/
// templates/owners/findOwners.html` -> `owners/findOwners`, which is exactly
// the string `OwnerController#processFindForm` returns.
function viewNameFor(filePath) {
  const m = /(?:^|\/)(?:templates?|views?|jsp)\/(.+)$/i.exec(filePath);
  const tail = m ? m[1] : filePath;
  return tail.replace(/\.[A-Za-z0-9]+$/, '');
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

function pushUnique(out, seen, value, line) {
  if (!value) return;
  const key = value;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ value, line });
}

// Message/i18n keys.
//   Thymeleaf   th:text="#{owner.firstName}"   /  [[#{key}]]
//   JSP/JSTL    <fmt:message key="label.foo"/>
//   Django      {% trans "Topics" %} / {% translate "Topics" %}
//   Jinja/gettext  {{ _('Topics') }}
//   Rails/ERB   t('activerecord.errors.x')  /  I18n.t("x")
const MESSAGE_PATTERNS = [
  /#\{\s*([A-Za-z_][\w.\-]*)\s*[}(]/g,
  /<fmt:message[^>]*\bkey\s*=\s*["']([^"']+)["']/gi,
  /\{%\s*(?:trans|translate)\s+["']([^"']+)["']/g,
  /\{\{\s*_\(\s*["']([^"']+)["']\s*\)/g,
  /\bI18n\.t\(\s*["']([^"']+)["']/g,
  /(?:^|[^\w.])t\(\s*["']([^"']+)["']\s*\)/g,
];

// Template-to-template references.
//   Thymeleaf   th:replace="~{fragments/layout :: layout(...)}"  / th:insert / th:include
//   Django/Jinja {% extends "base.html" %} / {% include "x.html" %}
//   JSP         <jsp:include page="/WEB-INF/x.jsp"/> / <%@ include file="x.jsp" %>
//   ERB         render 'shared/header'
const TEMPLATE_REF_PATTERNS = [
  /\bth:(?:replace|insert|include)\s*=\s*["']\s*~?\{?\s*([^"'\s:}]+)/gi,
  /\{%\s*(?:extends|include)\s+["']([^"']+)["']/g,
  /<jsp:include[^>]*\bpage\s*=\s*["']([^"']+)["']/gi,
  /<%@\s*include\s+file\s*=\s*["']([^"']+)["']/gi,
  /\brender\s+["']([\w/\-]+)["']/g,
];

// Routes the template links to.
//   Thymeleaf   th:action="@{/owners}" / th:href="@{/vets.html}"
//   Django      {% url 'forum:forum' ... %}
const URL_REF_PATTERNS = [
  /\bth:(?:action|href|src)\s*=\s*["']\s*@\{([^}"']+)\}/gi,
  /\{%\s*url\s+["']([^"']+)["']/g,
];

// A reference computed at render time (`th:insert="${template}"`, a
// same-file fragment selector `~{::menuItem}`, a URL with an interpolated
// segment) names nothing this pass can bind. Refusing it is the difference
// between an edge and a fabricated one.
function isStaticRef(value) {
  if (!value) return false;
  if (value.includes('$') || value.includes('#{') || value.includes('__')) return false;
  if (value.startsWith('::') || value.startsWith('{') || value.startsWith('~')) return false;
  return /[A-Za-z0-9]/.test(value);
}

function collect(content, patterns, filter) {
  const out = [];
  const seen = new Set();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const value = m[1] && m[1].trim();
      if (!filter || filter(value)) pushUnique(out, seen, value, lineOf(content, m.index));
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
  return out;
}

/**
 * parseTemplate(content) -> { messageKeys, templateRefs, urlRefs }
 * Each entry is { value, line }. Never throws; returns empty arrays on junk.
 */
function parseTemplate(content) {
  if (!content || typeof content !== 'string') {
    return { messageKeys: [], templateRefs: [], urlRefs: [] };
  }
  return {
    messageKeys: collect(content, MESSAGE_PATTERNS),
    templateRefs: collect(content, TEMPLATE_REF_PATTERNS, isStaticRef),
    urlRefs: collect(content, URL_REF_PATTERNS, isStaticRef),
  };
}

module.exports = { parseTemplate, isTemplateFile, viewNameFor, TEMPLATE_EXTS };
