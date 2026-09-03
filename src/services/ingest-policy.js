'use strict';

const yaml = require('js-yaml');

const fs = require('fs');
const path = require('path');

// The one definition of the oversize threshold. ingest.js, ingest-file-processor.js,
// ingest-scope.js and vcs/local-provider.js all read it from here — three of them used to
// restate it, and the provider's copy was not even configurable, so raising the limit made the
// walker admit files the provider then refused to read.
//
// KORAGRAPH_MAX_FILE_BYTES is the documented name.
const DEFAULT_MAX_BYTES = (() => {
  if (process.env.KORAGRAPH_MAX_FILE_BYTES) return parseInt(process.env.KORAGRAPH_MAX_FILE_BYTES, 10);
  return 200000;
})();

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif',
  '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.avi', '.mov', '.mkv', '.flv', '.wav', '.ogg', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.jar', '.war', '.ear',
  '.lock', '.sum',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.pyc', '.pyo',
  '.db', '.sqlite', '.sqlite3',
  '.DS_Store',
]);

const GENERATED_FILE_RE = /\.(?:g|freezed|pb|pbenum|pbgrpc|pbserver)\.\w+$|\.generated\.\w+$|\.min\.(?:js|css)$/;
const STORY_FILE_RE = /\.stories\.[jt]sx?$/;
const E2E_FILE_RE = /\.e2e\.[jt]sx?$/;

// Three-way split of what would otherwise be one monolithic SKIP_DIRS:
//   (i)   never-walk        — `.git` only; the one on-disk thing with no manifest representation.
//   (ii)  vendored/generated — walked at directory level only; ONE subtree manifest row per tree
//         (reason `vendored_tree`), never exploded into per-file rows.
//   (iii) editor metadata   — `.idea`/`.vscode` are walked and recorded per-file (reason
//         `editor_metadata`), same exemption class as `ignored_pattern` — never floored as content.
// `fixtures`, `stubs`, `__mocks__` are REMOVED from skipping entirely — first-party project
// content at any depth, now flows through classify → extract → floor like any other directory.
const NEVER_WALK_DIRS = new Set(['.git']);

const VENDORED_DIRS = new Set([
  'node_modules', 'vendor', '__pycache__', '.next', 'dist', 'build',
  'target', '.gradle', 'coverage', '.nyc_output', '.dart_tool', '.pub-cache',
]);

const EDITOR_METADATA_DIRS = new Set(['.idea', '.vscode']);

// Dot-dirs are walked by default; `.git` is excepted via NEVER_WALK_DIRS.
const ALLOWED_DOT_DIRS = new Set(['.github']);

const TEST_DIRS = new Set(['test', 'tests', 'spec', '__tests__', 'e2e', 'e2e-test']);
const TEST_SOURCE_EXTS = new Set([
  '.java', '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.rb', '.go',
  '.cs', '.php', '.kt', '.kts', '.scala', '.swift', '.dart',
]);

const TOOLING_CONFIG_RE = /^(?:jest|vitest|webpack|vite|rollup|babel|eslint|prettier|tailwind|postcss|karma|cypress|playwright)\.config\.[jt]sx?$|^\.eslintrc\.[jt]sx?$|^\.babelrc\.[jt]sx?$|^next\.config\.[jt]sx?$/;

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  include: null,
  exclude: [],
  generated: { policy: 'skip' },
  test: { policy: 'index_source' },
  story: { policy: 'skip' },
  size: { max_bytes: DEFAULT_MAX_BYTES, oversize: 'chunk' },
  languages: null,
  artifacts: [],
  branch_role: null,
  secrets: [],
  ignorePatterns: [],
});

const SKIP_REASONS = Object.freeze({
  BINARY: 'binary',
  GENERATED: 'generated',
  STORY: 'story',
  E2E: 'e2e',
  SKIP_DIR: 'skip_dir',
  DOT_DIR: 'dot_dir',
  IGNORE_PATTERN: 'ignore_pattern',
  EXCLUDE_GLOB: 'exclude_glob',
  NOT_IN_INCLUDE: 'not_in_include',
  TOOLING_CONFIG: 'tooling_config',
  TEST_NON_SOURCE: 'test_non_source',
  SECRET: 'secret',
  OVERSIZE: 'oversize',
  UNREADABLE: 'unreadable',
  // Additive reasons — never rename existing values above, dashboards read them.
  VENDORED_TREE: 'vendored_tree',
  EDITOR_METADATA: 'editor_metadata',
  SYMLINK: 'symlink',
  SPECIAL_FILE: 'special_file',
  UNREADABLE_DIR: 'unreadable_dir',
  GIT_SUBMODULE: 'git_submodule',
  NESTED_CHECKOUT: 'nested_checkout',
  LFS_POINTER: 'lfs_pointer',
  EMPTY: 'empty',
});

function globToRegex(glob) {
  let pattern = glob;
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);
  pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  pattern = pattern.replace(/\*\*/g, '<<DOUBLESTAR>>');
  pattern = pattern.replace(/\*/g, '[^/]*');
  pattern = pattern.replace(/\?/g, '[^/]');
  pattern = pattern.replace(/<<DOUBLESTAR>>/g, '.*');
  if (!pattern.startsWith('/') && !pattern.startsWith('.*')) {
    pattern = '(?:^|/)' + pattern;
  } else if (pattern.startsWith('/')) {
    pattern = '^' + pattern.slice(1);
  }
  if (dirOnly) {
    pattern = pattern + '(?:/|$)';
  } else {
    pattern = pattern + '(?:$|/)';
  }
  return new RegExp(pattern);
}

const IGNORE_FILE = '.koragraphignore';
const POLICY_FILE = '.koragraph.yml';

function resolveConfigFile(repoPath, name) {
  const current = path.join(repoPath, name);
  if (fs.existsSync(current)) return current;
  return null;
}

// `.env` is deliberately exempt: it is gitignored in almost every repository, and it is also the
// entry point of the config/infra plane (.env -> compose -> code). Honouring git here without this
// exemption would delete that plane's input on nearly every real install.
const GIT_IGNORE_EXEMPT = /(^|\/)\.env(\.|$)/;

// Ask git rather than parse .gitignore. The loader below drops `!` lines, so a second hand-rolled
// gitignore reader would read `*` + `!src/` as "exclude the whole repository" — the failure is
// total and silent. `git ls-files` applies git's own semantics, including negation and nested
// .gitignore files, in one call, and `--directory` collapses a fully-ignored tree to one entry.
//
// Already-ignored content (build artifacts, model checkpoints) can add gigabytes of walked
// and read bytes for a handful of nodes; honouring .gitignore here cuts peak RSS accordingly.
function gitIgnoredPatterns(repoPath) {
  if (String(process.env.KORAGRAPH_RESPECT_GITIGNORE || 'on').toLowerCase() === 'off') return [];
  let out;
  try {
    out = require('child_process').execFileSync(
      'git',
      ['-C', repoPath, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (_) {
    return [];                                    // not a git repo, or no git — fall back silently
  }
  const patterns = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (!line || GIT_IGNORE_EXEMPT.test(line)) continue;
    const body = line.endsWith('/') ? line.slice(0, -1) : line;
    const esc = body.replace(/[.*+^${}()|[\]\\?]/g, '\\$&');
    patterns.push(new RegExp(`^${esc}(?:/|$)`));
  }
  return patterns;
}

function loadIgnorePatterns(repoPath) {
  const fromGit = gitIgnoredPatterns(repoPath);
  const ignoreFile = resolveConfigFile(repoPath, IGNORE_FILE);
  if (!ignoreFile) return fromGit;
  let content;
  try {
    content = fs.readFileSync(ignoreFile, 'utf8');
  } catch (_) {
    return fromGit;
  }
  const patterns = [...fromGit];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    patterns.push(globToRegex(line));
  }
  return patterns;
}

// js-yaml, not a hand-rolled subset. The subset parser this replaces understood block sequences
// of plain scalars and nothing else, so a `secrets:` list of mappings — the documented shape —
// came back as an array of strings, `normalizeSecretRules` dropped every non-object, and the
// user's secret rules were silently discarded. `exclude: ["a","b"]` flow sequences degraded the
// same way, to one string. Silently, in both cases: no warning, no error, the files just got
// ingested. js-yaml was already a direct dependency used by contract-config.js and three
// contract-parsers, so this also removes a second way to parse YAML in this tree.
function parsePolicyYml(content) {
  if (!content || typeof content !== 'string') return {};
  try {
    const doc = yaml.load(content);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch (err) {
    console.warn(`[ingest-policy] ${POLICY_FILE} is not valid YAML and was ignored: ${err.message}`);
    return {};
  }
}

function normalizePolicySection(raw, defaults) {
  if (!raw || typeof raw !== 'object') return { ...defaults };
  return { ...defaults, ...raw };
}

function normalizeSecretRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      pattern: entry.pattern || entry.path || '',
      action: entry.action || 'skip',
    }))
    .filter((entry) => entry.pattern);
}

function normalizePolicy(raw = {}, ignorePatterns = []) {
  const generated = normalizePolicySection(raw.generated, DEFAULT_POLICY.generated);
  const test = normalizePolicySection(raw.test, DEFAULT_POLICY.test);
  const story = normalizePolicySection(raw.story, DEFAULT_POLICY.story);
  const size = normalizePolicySection(raw.size, DEFAULT_POLICY.size);

  const include = Array.isArray(raw.include)
    ? raw.include.map((g) => globToRegex(g))
    : null;
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude.map((g) => globToRegex(g))
    : [];

  const secrets = normalizeSecretRules(raw.secrets || raw.secret_classifications);

  return {
    version: raw.version || DEFAULT_POLICY.version,
    include,
    exclude,
    generated,
    test,
    story,
    size: {
      max_bytes: Number(size.max_bytes) > 0 ? Number(size.max_bytes) : DEFAULT_MAX_BYTES,
      oversize: size.oversize === 'skip' ? 'skip' : 'chunk',
    },
    languages: Array.isArray(raw.languages) ? raw.languages.map(String) : null,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(String) : [],
    branch_role: raw.branch_role || null,
    secrets: secrets.map((rule) => ({ ...rule, regex: globToRegex(rule.pattern) })),
    ignorePatterns,
  };
}

function loadIngestPolicy(repoPath) {
  const ignorePatterns = loadIgnorePatterns(repoPath);
  const policyFile = resolveConfigFile(repoPath, POLICY_FILE);
  if (!policyFile) {
    return normalizePolicy({}, ignorePatterns);
  }

  let content;
  try {
    content = fs.readFileSync(policyFile, 'utf8');
  } catch (_) {
    return normalizePolicy({}, ignorePatterns);
  }

  return normalizePolicy(parsePolicyYml(content), ignorePatterns);
}

function detectClassifiableContent(content) {
  if (!content || typeof content !== 'string') return false;
  const head = content.slice(0, 8000);
  if (/^\s*(?:package|import)\s+[\w.]+/m.test(head)) return true;
  if (/\b(?:class|interface|enum)\s+\w+/.test(head)) return true;
  if (/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\b/.test(head)) return true;
  if (/^\s*(?:async\s+)?def\s+\w+/m.test(head)) return true;
  if (/func\s+\w+\s*\(/.test(head)) return true;
  return false;
}

function matchesAnyPattern(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const sample = buf.length > 8000 ? buf.subarray(0, 8000) : buf;
  if (sample.includes(0)) return true;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    const isPrintable = (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!isPrintable) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.3;
}

function evaluateFilePath(filePath, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  const fileSizeBytes = options.fileSizeBytes;
  const maxFileBytes = options.maxFileBytes ?? policy.size?.max_bytes ?? DEFAULT_MAX_BYTES;

  if (!filePath || typeof filePath !== 'string') {
    return { decision: 'skip', reason: SKIP_REASONS.UNREADABLE };
  }

  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  if (BINARY_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(basename)) {
    return { decision: 'skip', reason: SKIP_REASONS.BINARY };
  }

  if (policy.generated?.policy !== 'index' && GENERATED_FILE_RE.test(filePath)) {
    return { decision: 'skip', reason: SKIP_REASONS.GENERATED };
  }

  if (policy.story?.policy !== 'index' && STORY_FILE_RE.test(filePath)) {
    return { decision: 'skip', reason: SKIP_REASONS.STORY };
  }

  if (E2E_FILE_RE.test(filePath)) {
    return { decision: 'skip', reason: SKIP_REASONS.E2E };
  }

  // ENG0b A5 parity: full walk and per-file (incremental) evaluation must agree on the same
  // three-way split — `.git` never-walk, vendored trees, editor metadata — dot-dirs and
  // fixtures/stubs/__mocks__ are no longer skipped at all (see NEVER_WALK_DIRS/VENDORED_DIRS
  // above).
  const segments = filePath.split('/');
  for (const seg of segments.slice(0, -1)) {
    if (NEVER_WALK_DIRS.has(seg)) {
      return { decision: 'skip', reason: SKIP_REASONS.SKIP_DIR, detail: seg };
    }
    if (VENDORED_DIRS.has(seg)) {
      return { decision: 'skip', reason: SKIP_REASONS.VENDORED_TREE, detail: seg };
    }
    if (EDITOR_METADATA_DIRS.has(seg)) {
      return { decision: 'skip', reason: SKIP_REASONS.EDITOR_METADATA, detail: seg };
    }
  }

  for (const rule of policy.secrets || []) {
    if (rule.regex?.test(filePath)) {
      return { decision: 'skip', reason: SKIP_REASONS.SECRET, detail: rule.pattern };
    }
  }

  for (const pattern of policy.ignorePatterns || []) {
    if (pattern.test(filePath)) {
      return { decision: 'skip', reason: SKIP_REASONS.IGNORE_PATTERN };
    }
  }

  if (policy.include && !matchesAnyPattern(filePath, policy.include)) {
    return { decision: 'skip', reason: SKIP_REASONS.NOT_IN_INCLUDE };
  }

  if (policy.exclude?.length && matchesAnyPattern(filePath, policy.exclude)) {
    return { decision: 'skip', reason: SKIP_REASONS.EXCLUDE_GLOB };
  }

  if (TOOLING_CONFIG_RE.test(basename)) {
    return { decision: 'skip', reason: SKIP_REASONS.TOOLING_CONFIG };
  }

  const inTestDir = segments.some((seg) => TEST_DIRS.has(seg));
  if (inTestDir && policy.test?.policy !== 'index_all') {
    if (!TEST_SOURCE_EXTS.has(ext)) {
      return { decision: 'skip', reason: SKIP_REASONS.TEST_NON_SOURCE };
    }
  }

  if (fileSizeBytes !== undefined && fileSizeBytes > maxFileBytes) {
    if (policy.size?.oversize === 'chunk') {
      return { decision: 'chunk', reason: null, maxFileBytes };
    }
    return { decision: 'skip', reason: SKIP_REASONS.OVERSIZE, detail: String(fileSizeBytes) };
  }

  return { decision: 'process', reason: null };
}

function chunkTextByLines(content, maxBytes, options = {}) {
  if (!content) return [];
  const limit = maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(content, 'utf8') <= limit) {
    return [{ content, startLine: 1, endLine: content.split('\n').length, chunkIndex: 0, chunkTotal: 1 }];
  }

  const lines = content.split('\n');
  const chunks = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length) {
      const lineBytes = Buffer.byteLength(lines[end], 'utf8') + (end > start ? 1 : 0);
      if (size + lineBytes > limit && end > start) break;
      size += lineBytes;
      end += 1;
      if (size >= limit) break;
    }
    if (end === start) end = start + 1;

    const slice = lines.slice(start, end).join('\n');
    chunks.push({
      content: slice,
      startLine: start + 1,
      endLine: end,
      chunkIndex: chunks.length,
      chunkTotal: null,
    });
    start = end;
  }

  const total = chunks.length;
  return chunks.map((chunk) => ({ ...chunk, chunkTotal: total }));
}

// Directory-level stat-only pass used to size a vendored subtree without exploding it into
// per-file manifest rows (a 100k-file node_modules must produce ONE row, not 100k).
function statSubtree(dir) {
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(path.join(d, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount++;
      try {
        totalBytes += fs.statSync(path.join(d, entry.name)).size;
      } catch (_) { /* ignore */ }
    }
  }
  return { fileCount, totalBytes };
}

// E1 — parse `.gitmodules` (root only) so every declared submodule gets a subtree row
// (reason `git_submodule`) whether or not it is initialized on disk.
function loadGitSubmodules(repoPath) {
  const gmFile = path.join(repoPath, '.gitmodules');
  if (!fs.existsSync(gmFile)) return [];
  let content;
  try {
    content = fs.readFileSync(gmFile, 'utf8');
  } catch (_) {
    return [];
  }
  const submodules = [];
  let current = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1], path: null, url: null };
      submodules.push(current);
      continue;
    }
    if (!current) continue;
    const pathMatch = line.match(/^path\s*=\s*(.+)$/);
    if (pathMatch) current.path = pathMatch[1].trim();
    const urlMatch = line.match(/^url\s*=\s*(.+)$/);
    if (urlMatch) current.url = urlMatch[1].trim();
  }
  return submodules.filter((s) => s.path);
}

// A directory carrying a `.git` entry is a different repository's working tree, and its contents
// belong to that repository's graph, not this one. The entry is a DIRECTORY for a clone and a FILE
// for a linked worktree or an initialised submodule — checking only for a directory is what let
// `koragraph ingest .` on this checkout index five agent worktrees, 2,624 duplicate files against
// 625 real ones, before it reached a line of first-party source.
function isSeparateCheckout(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function walkRepoWithPolicy(repoPath, options = {}) {
  const policy = options.policy || loadIngestPolicy(repoPath);
  const subdir = options.subdir || null;
  const startDir = subdir ? path.join(repoPath, subdir) : repoPath;
  const relPrefix = subdir ? subdir.replace(/\\/g, '/').replace(/\/$/, '') + '/' : '';

  const files = [];
  const skipped = [];
  const seenRel = new Set();
  const declaredSubmodules = new Set(
    loadGitSubmodules(repoPath).map((s) => s.path.replace(/\\/g, '/').replace(/\/$/, '')),
  );

  const recordSkip = (rel, reason, extra = {}) => {
    if (seenRel.has(rel)) return;
    seenRel.add(rel);
    skipped.push({ path: rel, reason, ...extra });
  };

  function walk(dir, relBase = '', inTestDir = false) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      // A4 — unreadable directory: recorded as a subtree row, never a silent drop.
      const relPath = relPrefix + relBase;
      if (relBase) recordSkip(relPath, SKIP_REASONS.UNREADABLE_DIR);
      return;
    }

    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const relPath = relPrefix + rel;

      // A3 — symlinks and other non-regular entries are recorded, never silently dropped,
      // and never followed (loop safety).
      if (entry.isSymbolicLink()) {
        let detail = null;
        try {
          detail = fs.readlinkSync(path.join(dir, entry.name));
        } catch (_) { /* ignore */ }
        recordSkip(relPath, SKIP_REASONS.SYMLINK, { detail });
        continue;
      }

      if (entry.isDirectory()) {
        // A1(i) — `.git` is the only thing on disk with no manifest representation.
        if (NEVER_WALK_DIRS.has(entry.name)) continue;

        // A1(ii) — vendored/generated trees: one subtree row, not a per-file explosion.
        if (VENDORED_DIRS.has(entry.name)) {
          const { fileCount, totalBytes } = statSubtree(path.join(dir, entry.name));
          recordSkip(relPath, SKIP_REASONS.VENDORED_TREE, {
            file_count: fileCount,
            total_bytes: totalBytes,
            bytes: totalBytes,
          });
          continue;
        }

        if (isSeparateCheckout(path.join(dir, entry.name))) {
          const { fileCount, totalBytes } = statSubtree(path.join(dir, entry.name));
          const declared = declaredSubmodules.has(relPath);
          recordSkip(relPath, declared ? SKIP_REASONS.GIT_SUBMODULE : SKIP_REASONS.NESTED_CHECKOUT, {
            file_count: fileCount,
            total_bytes: totalBytes,
            bytes: totalBytes,
          });
          if (!declared) {
            console.warn(`[ingest-policy] ${relPath} is a separate git checkout — skipped ${fileCount} file(s)`);
          }
          continue;
        }

        // A1(iii) + A2 — fixtures/stubs/__mocks__ and dot-dirs (.devcontainer,.mvn, etc.)
        // are normal content now; only.idea/.vscode get the editor-metadata exemption, and
        // that is applied per-file below (not a directory-level skip).
        walk(path.join(dir, entry.name), rel, inTestDir || TEST_DIRS.has(entry.name));
        continue;
      }

      if (!entry.isFile()) {
        // Non-regular, non-symlink entries: FIFOs, sockets, block/char devices.
        recordSkip(relPath, SKIP_REASONS.SPECIAL_FILE);
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(path.join(dir, entry.name));
      } catch (_) {
        recordSkip(relPath, SKIP_REASONS.UNREADABLE);
        continue;
      }

      const evaluation = evaluateFilePath(relPath, {
        policy,
        fileSizeBytes: stat.size,
      });

      if (evaluation.decision === 'skip') {
        recordSkip(relPath, evaluation.reason, {
          bytes: stat.size,
          detail: evaluation.detail || null,
        });
        continue;
      }

      files.push({
        rel: relPath,
        full: path.join(dir, entry.name),
        sizeBytes: stat.size,
        chunked: evaluation.decision === 'chunk',
        maxFileBytes: evaluation.maxFileBytes || policy.size.max_bytes,
      });
    }
  }

  walk(startDir);

  // E1 — submodules recorded whether or not initialized, root walk only.
  if (!subdir) {
    for (const sub of loadGitSubmodules(repoPath)) {
      const relPath = sub.path.replace(/\\/g, '/').replace(/\/$/, '');
      recordSkip(relPath, SKIP_REASONS.GIT_SUBMODULE, { detail: sub.url || null });
    }
  }

  return { files, skipped, policy };
}

function buildPolicyCoverageManifest({ files = [], skipped = [], policy = null } = {}) {
  const byReason = {};
  for (const entry of skipped) {
    const key = entry.reason || 'unknown';
    byReason[key] = (byReason[key] || 0) + 1;
  }

  const chunked = files.filter((f) => f.chunked).length;

  return {
    schema_version: 'koragraph.coverage_manifest.v1',
    files_discovered: files.length + skipped.length,
    files_included: files.length,
    files_skipped: skipped.length,
    files_chunked: chunked,
    skip_reasons: byReason,
    skipped_files: skipped.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
      bytes: entry.bytes ?? null,
      detail: entry.detail ?? null,
      tier: 'record_only',
    })),
    included_files: files.map((f) => ({
      path: f.rel,
      bytes: f.sizeBytes ?? null,
      chunked: !!f.chunked,
      tier: 'pending',
    })),
    policy: policy ? {
      version: policy.version,
      max_bytes: policy.size?.max_bytes,
      oversize: policy.size?.oversize,
      branch_role: policy.branch_role,
      languages: policy.languages,
      artifacts: policy.artifacts,
    } : null,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_POLICY,
  SKIP_REASONS,
  NEVER_WALK_DIRS,
  VENDORED_DIRS,
  EDITOR_METADATA_DIRS,
  parsePolicyYml,
  loadIngestPolicy,
  IGNORE_FILE,
  POLICY_FILE,
  loadIgnorePatterns,
  globToRegex,
  normalizePolicy,
  evaluateFilePath,
  looksBinary,
  detectClassifiableContent,
  chunkTextByLines,
  walkRepoWithPolicy,
  buildPolicyCoverageManifest,
  loadGitSubmodules,
};
