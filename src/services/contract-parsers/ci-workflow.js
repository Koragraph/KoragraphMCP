// ci-workflow.js — deterministic (zero-token) reader for CI pipeline definitions.
//
// The third file in the config/infra plane, after `compose.js` and `env-file.js`, and the one
// that answers a question neither of them can: **which of these repositories are built, tested
// and shipped together, and on what.** A compose file describes the topology a developer runs
// locally; a CI workflow describes the topology the project actually treats as one unit.
//
// WHAT IS WORTH READING OUT OF A PIPELINE
// ---------------------------------------
//   secretRefs   `${{ secrets.NPM_TOKEN }}`. The single best CI join. Two repositories whose
//                workflows name the same secret share a credential, and that is a real coupling
//                no other plane can see. A secret name is also the DEPLOY-TIME definition site
//                for an `.env` key of the same name — the missing half of `env-file.js`.
//   envKeys      the same key namespace `env-file.js` produces, at file and job scope.
//   refs         a job `env:` pointing at a database, and — structurally identical to a compose
//                service — a `services:` container block. Canonicalised by resource-ref.js, so a
//                workflow's throwaway Postgres joins to the compose file's real one.
//   buildTargets `working-directory`, a `paths:` trigger filter, a docker build context. These
//                are the same three signals `compose.js` emits as repoHints, and they answer
//                "which repository does this job belong to" in a monorepo or a workspace.
//   actions      `uses: actions/checkout@v4`. A declared dependency at pipeline grain.
//   runs         the commands. What a reader means by "how is this built".
//
// SYSTEMS
// -------
// GitHub Actions, GitLab CI and CircleCI — the three that are YAML and that this ICP meets.
// Jenkins is Groovy and needs a different parser entirely; Azure Pipelines, Drone, Travis and
// Buildkite are YAML and would each be a small addition, deliberately not made until something
// asks for them. An unrecognised path returns null, the same "not mine" signal `manifest.js` uses.
//
// SECRET VALUES CANNOT APPEAR IN A CI FILE — a `${{ secrets.X }}` is a NAME, and the name is the
// join key. But a workflow routinely inlines a throwaway credential for its own test database
// (`POSTGRES_PASSWORD: postgres`), so every literal still goes through resource-ref.js's
// redaction on the same terms as a committed `.env.example`.

'use strict';

const path = require('path');
const yaml = require('js-yaml');
const { redactValue, referenceFrom } = require('./resource-ref');
const { parseImageRef, parsePortString } = require('./compose');

const GITHUB_WORKFLOW_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
const GITLAB_CI_RE = /(^|\/)\.gitlab-ci\.ya?ml$/i;
const GITLAB_INCLUDE_RE = /(^|\/)\.gitlab\/(?:ci|ci-templates)\/[^/]+\.ya?ml$/i;
const CIRCLECI_RE = /(^|\/)\.circleci\/config\.ya?ml$/i;

function ciSystemFor(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (GITHUB_WORKFLOW_RE.test(p)) return 'github_actions';
  if (GITLAB_CI_RE.test(p) || GITLAB_INCLUDE_RE.test(p)) return 'gitlab_ci';
  if (CIRCLECI_RE.test(p)) return 'circleci';
  return null;
}

function isCiWorkflowPath(relPath) {
  return ciSystemFor(relPath) !== null;
}

const MAX_RUNS_PER_JOB = 100;
const MAX_COMMAND_CHARS = 2000;

function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function asText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join('\n');
  return null;
}

// ─── Expression and variable references ──────────────────────────────────────
//
// GitHub's `${{ }}` contexts are documented and closed: `secrets`, `vars`, `env`, `inputs`,
// `matrix`, `needs`, `github`, `job`, `steps`, `runner`, `strategy`. Only the first four name
// something a second repository could also name, so only those are collected.
const GH_EXPR_RE = /\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g;
const GH_COLLECTED_CONTEXTS = new Set(['secrets', 'vars', 'env', 'inputs']);

// GitLab and CircleCI have no expression syntax — a variable is a shell variable. `$VAR` and
// `${VAR}`, excluding `$$` and positional `$1`.
const SHELL_VAR_RE = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g;

function lineOf(content, needle) {
  const idx = content.indexOf(needle);
  if (idx === -1) return null;
  return content.slice(0, idx).split('\n').length;
}

function collectReferences(system, content) {
  const secretRefs = new Map();
  const varRefs = new Map();
  const lines = content.split(/\r\n|\r|\n/);

  const note = (map, name, context, lineNo) => {
    if (!map.has(name)) map.set(name, { name, context, line: lineNo });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (system === 'github_actions') {
      GH_EXPR_RE.lastIndex = 0;
      let m;
      while ((m = GH_EXPR_RE.exec(line)) !== null) {
        const [, context, name] = m;
        if (!GH_COLLECTED_CONTEXTS.has(context)) continue;
        if (context === 'secrets') note(secretRefs, name, 'secrets', i + 1);
        else note(varRefs, name, context, i + 1);
      }
      continue;
    }
    SHELL_VAR_RE.lastIndex = 0;
    let m;
    while ((m = SHELL_VAR_RE.exec(line)) !== null) {
      const name = m[1] || m[2];
      if (!name) continue;
      // `CI_*` on GitLab and `CIRCLE_*` on CircleCI are the runner's own built-ins, not something
      // the project declares — they would join every repo on earth to every other.
      if (/^(CI|CIRCLE|GITHUB|RUNNER)_/.test(name) || name === 'CI') continue;
      note(varRefs, name, 'shell', i + 1);
    }
  }
  return { secretRefs: [...secretRefs.values()], varRefs: [...varRefs.values()] };
}

// ─── Env blocks ───────────────────────────────────────────────────────────────

function parseEnvBlock(raw, content) {
  const out = [];
  if (!raw) return out;
  const push = (key, value) => {
    const text = value === null || value === undefined ? null : String(value);
    if (text === null) { out.push({ key, value: null, redacted: false, ref: null, line: lineOf(content, `${key}:`) }); return; }
    const red = redactValue(key, text);
    const isExpression = text.includes('${{');
    const ref = !isExpression && (!red.redacted || red.reason === 'userinfo')
      ? referenceFrom(key, red.value, {})
      : null;
    out.push({
      key,
      value: red.value,
      redacted: red.redacted,
      expression: isExpression,
      ref,
      line: lineOf(content, `${key}:`),
    });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq === -1) push(item.trim(), null);
      else push(item.slice(0, eq).trim(), item.slice(eq + 1));
    }
    return out;
  }
  if (typeof raw === 'object') for (const [key, value] of Object.entries(raw)) push(key, value);
  return out;
}

// A GitHub Actions / GitLab `services:` block is the same object a compose service is — an image,
// an env block, a port list — so it is read with the same primitives rather than a parallel path.
function parseServiceContainers(raw, content) {
  const out = [];
  if (!raw) return out;
  const add = (name, spec) => {
    const cfg = spec && typeof spec === 'object' ? spec : {};
    // GitHub keys a service by its alias and names the image under `image`. GitLab's list form
    // does the opposite — `name` IS the image and `alias` is the hostname — so a reader that only
    // knows `image` loses every GitLab service container.
    const image = typeof spec === 'string' ? spec
      : (typeof cfg.image === 'string' ? cfg.image : (typeof cfg.name === 'string' ? cfg.name : null));
    const env = parseEnvBlock(cfg.env || cfg.variables, content);
    out.push({
      name: name || (parseImageRef(image) || {}).repository || null,
      image,
      imageRef: parseImageRef(image),
      ports: asArray(cfg.ports).flatMap((p) => (typeof p === 'object' ? [] : parsePortString(p))),
      env,
      refs: env.map((e) => e.ref).filter(Boolean),
    });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') add(null, item);
      else if (item && typeof item === 'object') add(item.alias || null, item);
    }
    return out;
  }
  if (typeof raw === 'object') for (const [name, spec] of Object.entries(raw)) add(name, spec);
  return out;
}

const USES_RE = /^([^@\s]+)(?:@(.+))?$/;

function parseSteps(raw, content, defaultWorkingDirectory) {
  const actions = [];
  const runs = [];
  for (const step of asArray(raw)) {
    if (typeof step === 'string') {
      if (runs.length < MAX_RUNS_PER_JOB) {
        runs.push({ name: null, command: step.slice(0, MAX_COMMAND_CHARS), workingDirectory: defaultWorkingDirectory, line: lineOf(content, step.split('\n')[0]) });
      }
      continue;
    }
    if (!step || typeof step !== 'object') continue;
    if (typeof step.uses === 'string') {
      const m = USES_RE.exec(step.uses.trim());
      if (m) actions.push({ name: m[1], version: m[2] || null, line: lineOf(content, step.uses) });
    }
    const command = asText(step.run);
    if (command !== null && runs.length < MAX_RUNS_PER_JOB) {
      runs.push({
        name: typeof step.name === 'string' ? step.name : null,
        command: command.slice(0, MAX_COMMAND_CHARS),
        workingDirectory: step['working-directory'] || defaultWorkingDirectory || null,
        line: lineOf(content, command.split('\n')[0]),
      });
    }
  }
  return { actions, runs };
}

// ─── Build targets ────────────────────────────────────────────────────────────
//
// The same three signals `compose.js#repoHintsFor` emits, for the same reason: the resolver, not
// this parser, decides which repository a job belongs to. A `working-directory` and a `paths:`
// filter are far stronger evidence than a job id, and all three are labelled so a resolver can
// weight them.
function buildTargetsFor(job, pathFilters) {
  const targets = [];
  const seen = new Set();
  const add = (kind, value) => {
    const cleaned = String(value || '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!cleaned || cleaned === '.' || seen.has(`${kind}|${cleaned}`)) return;
    seen.add(`${kind}|${cleaned}`);
    targets.push({ kind, value: cleaned });
  };
  if (job.workingDirectory) add('working_directory', job.workingDirectory);
  for (const run of job.runs) if (run.workingDirectory) add('working_directory', run.workingDirectory);
  for (const filter of pathFilters) {
    // `src/**` names a directory; `**/*.md` names a file type and nothing else.
    const dir = filter.replace(/\/\*\*.*$/, '').replace(/\/\*.*$/, '');
    if (dir && !dir.includes('*')) add('path_filter', dir);
  }
  for (const run of job.runs) {
    for (const m of run.command.matchAll(/docker\s+build[^\n]*?(?:-f\s+(\S+))?\s+(\.\/?[\w./-]*)\s*$/gm)) {
      if (m[2]) add('docker_build_context', m[2]);
    }
  }
  return targets;
}

// ─── Per-system readers ───────────────────────────────────────────────────────

function githubTriggers(on) {
  if (!on) return { triggers: [], pathFilters: [] };
  if (typeof on === 'string') return { triggers: [on], pathFilters: [] };
  if (Array.isArray(on)) return { triggers: on.filter((t) => typeof t === 'string'), pathFilters: [] };
  const triggers = Object.keys(on);
  const pathFilters = [];
  for (const cfg of Object.values(on)) {
    if (!cfg || typeof cfg !== 'object') continue;
    for (const p of [...asArray(cfg.paths), ...asArray(cfg['paths-ignore'])]) {
      if (typeof p === 'string') pathFilters.push(p);
    }
  }
  return { triggers, pathFilters };
}

function readGithub(doc, content) {
  const { triggers, pathFilters } = githubTriggers(doc.on ?? doc.true);
  const fileEnv = parseEnvBlock(doc.env, content);
  const jobs = [];
  for (const [id, raw] of Object.entries(doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {})) {
    const spec = raw && typeof raw === 'object' ? raw : {};
    const defaultWd = spec.defaults && spec.defaults.run ? spec.defaults.run['working-directory'] : null;
    const { actions, runs } = parseSteps(spec.steps, content, defaultWd || null);
    const jobPathFilters = [];
    const job = {
      id,
      name: typeof spec.name === 'string' ? spec.name : null,
      line: lineOf(content, `  ${id}:`),
      runsOn: typeof spec['runs-on'] === 'string' ? spec['runs-on'] : (Array.isArray(spec['runs-on']) ? spec['runs-on'].join(',') : null),
      workingDirectory: defaultWd || null,
      needs: asArray(spec.needs).filter((n) => typeof n === 'string'),
      environment: typeof spec.environment === 'string' ? spec.environment : (spec.environment && spec.environment.name) || null,
      // `uses:` at job level is a reusable workflow — a genuine cross-repo link when it points at
      // `owner/repo/.github/workflows/x.yml@ref`.
      reusableWorkflow: typeof spec.uses === 'string' ? spec.uses : null,
      env: parseEnvBlock(spec.env, content),
      serviceContainers: parseServiceContainers(spec.services, content),
      actions,
      runs,
      buildTargets: [],
    };
    job.buildTargets = buildTargetsFor(job, [...pathFilters, ...jobPathFilters]);
    jobs.push(job);
  }
  return { name: typeof doc.name === 'string' ? doc.name : null, triggers, pathFilters, fileEnv, jobs };
}

const GITLAB_RESERVED = new Set([
  'stages', 'variables', 'default', 'include', 'workflow', 'image', 'services',
  'before_script', 'after_script', 'cache', 'pages',
]);

function readGitlab(doc, content) {
  const fileEnv = parseEnvBlock(doc.variables, content);
  const pathFilters = [];
  const jobs = [];
  for (const [id, raw] of Object.entries(doc)) {
    if (GITLAB_RESERVED.has(id) || id.startsWith('.')) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const script = [...asArray(raw.before_script), ...asArray(raw.script), ...asArray(raw.after_script)]
      .filter((s) => typeof s === 'string');
    for (const rule of asArray(raw.rules)) {
      if (rule && typeof rule === 'object') for (const c of asArray(rule.changes)) if (typeof c === 'string') pathFilters.push(c);
    }
    for (const c of asArray(raw.only && raw.only.changes)) if (typeof c === 'string') pathFilters.push(c);
    const image = typeof raw.image === 'string' ? raw.image : (raw.image && raw.image.name) || null;
    const job = {
      id,
      name: typeof raw.stage === 'string' ? raw.stage : null,
      line: lineOf(content, `${id}:`),
      runsOn: image,
      workingDirectory: null,
      needs: asArray(raw.needs).map((n) => (typeof n === 'string' ? n : n && n.job)).filter(Boolean),
      environment: typeof raw.environment === 'string' ? raw.environment : (raw.environment && raw.environment.name) || null,
      reusableWorkflow: null,
      env: parseEnvBlock(raw.variables, content),
      serviceContainers: parseServiceContainers(raw.services, content),
      actions: image ? [{ name: image, version: null, line: lineOf(content, image) }] : [],
      runs: script.slice(0, MAX_RUNS_PER_JOB).map((command) => ({
        name: null, command: command.slice(0, MAX_COMMAND_CHARS), workingDirectory: null, line: lineOf(content, command.split('\n')[0]),
      })),
      buildTargets: [],
    };
    job.buildTargets = buildTargetsFor(job, pathFilters);
    jobs.push(job);
  }
  return { name: null, triggers: doc.workflow ? ['workflow'] : [], pathFilters, fileEnv, jobs };
}

function readCircleci(doc, content) {
  const fileEnv = parseEnvBlock(doc.environment, content);
  const jobs = [];
  for (const [id, raw] of Object.entries(doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {})) {
    const spec = raw && typeof raw === 'object' ? raw : {};
    const dockerImages = asArray(spec.docker).filter((d) => d && typeof d === 'object');
    const { actions, runs } = parseSteps(spec.steps, content, spec.working_directory || null);
    // CircleCI's `docker:` list is executor-first, then service containers.
    const serviceContainers = dockerImages.slice(1).map((d) => {
      const env = parseEnvBlock(d.environment, content);
      return {
        name: (parseImageRef(d.image) || {}).repository || null,
        image: d.image || null,
        imageRef: parseImageRef(d.image),
        ports: [],
        env,
        refs: env.map((e) => e.ref).filter(Boolean),
      };
    });
    const job = {
      id,
      name: null,
      line: lineOf(content, `  ${id}:`),
      runsOn: dockerImages[0] ? dockerImages[0].image : (spec.machine ? 'machine' : null),
      workingDirectory: spec.working_directory || null,
      needs: [],
      environment: null,
      reusableWorkflow: null,
      env: parseEnvBlock(spec.environment, content),
      serviceContainers,
      actions,
      runs,
      buildTargets: [],
    };
    job.buildTargets = buildTargetsFor(job, []);
    jobs.push(job);
  }
  return { name: null, triggers: doc.workflows ? ['workflow'] : [], pathFilters: [], fileEnv, jobs };
}

// Degraded pass, for a workflow no YAML parser accepts.
//
// This is not defensive padding — it is the `sql-ddl.js` precedent, and it has the same kind of
// measured justification. `~/koragraph/.github/workflows/ci.yml`, a real 227-line workflow, is
// invalid YAML: several `run: |` blocks embed `<<'EOF'` heredocs whose bodies sit at column 0
// (deliberately, per a comment there — leading spaces would change a fixture's file hash), which
// terminates the block scalar and breaks the document. js-yaml rejects it outright, and with it
// every secret name, env key and command in the file.
//
// Those three planes do not need the document. A `${{ secrets.X }}` and a `KEY: value` are
// line-local facts, so they are read line by line and the result is flagged `degraded: true`
// with no jobs. Structure is lost; the join keys are not.
const DEGRADED_ENV_RE = /^\s+([A-Z][A-Z0-9_]{2,}):\s*(\S.*?)\s*$/;

function parseDegraded(system, relPath, content) {
  const { secretRefs, varRefs } = collectReferences(system, content);
  const envEntries = [];
  const lines = content.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = DEGRADED_ENV_RE.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2].replace(/^["']|["']$/g, '');
    const red = redactValue(key, rawValue);
    const isExpression = rawValue.includes('${{');
    envEntries.push({
      key,
      value: red.value,
      redacted: red.redacted,
      expression: isExpression,
      ref: !isExpression && (!red.redacted || red.reason === 'userinfo') ? referenceFrom(key, red.value, {}) : null,
      line: i + 1,
    });
  }
  if (!envEntries.length && !secretRefs.length && !varRefs.length) return null;
  return {
    kind: 'ci',
    system,
    file: relPath || null,
    degraded: true,
    name: null,
    triggers: [],
    pathFilters: [],
    env: envEntries,
    jobs: [],
    envKeys: [...new Set(envEntries.map((e) => e.key))],
    secretRefs,
    varRefs,
    refs: envEntries.map((e) => e.ref).filter(Boolean).map((r) => ({ ...r, scope: 'file' })),
  };
}

/**
 * parseCiWorkflow(relPath, content) -> CI facts | null
 *
 * `null` for a path this parser does not own and for a document that yields nothing at all — the
 * same "not mine" signal `manifest.js` and `compose.js` use. Never throws. A file whose YAML does
 * not parse falls through to `parseDegraded` and comes back with `degraded: true`.
 */
function parseCiWorkflow(relPath, content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const system = ciSystemFor(relPath);
  if (!system) return null;

  try {
    let doc = null;
    try {
      doc = yaml.load(content, { json: true });
    } catch (_) {
      return parseDegraded(system, relPath, content);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;

    let read;
    if (system === 'github_actions') read = readGithub(doc, content);
    else if (system === 'gitlab_ci') read = readGitlab(doc, content);
    else read = readCircleci(doc, content);
    if (!read.jobs.length) return parseDegraded(system, relPath, content);

    const { secretRefs, varRefs } = collectReferences(system, content);

    const envKeys = [...new Set([
      ...read.fileEnv.map((e) => e.key),
      ...read.jobs.flatMap((j) => j.env.map((e) => e.key)),
      ...read.jobs.flatMap((j) => j.serviceContainers.flatMap((s) => s.env.map((e) => e.key))),
    ])];

    const refs = [];
    const seen = new Set();
    const addRefs = (list, scope) => {
      for (const ref of list) {
        if (!ref) continue;
        const key = `${scope}|${ref.canonical || ref.weakKey}|${ref.key || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ ...ref, scope });
      }
    };
    addRefs(read.fileEnv.map((e) => e.ref), 'file');
    for (const job of read.jobs) {
      addRefs(job.env.map((e) => e.ref), job.id);
      for (const container of job.serviceContainers) addRefs(container.refs, job.id);
    }

    return {
      kind: 'ci',
      system,
      file: relPath || null,
      degraded: false,
      name: read.name,
      triggers: read.triggers,
      pathFilters: [...new Set(read.pathFilters)],
      env: read.fileEnv,
      jobs: read.jobs,
      envKeys,
      secretRefs,
      varRefs,
      refs,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { parseCiWorkflow, isCiWorkflowPath, ciSystemFor };
