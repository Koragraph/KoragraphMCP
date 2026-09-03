'use strict';

const path = require('path');
const {
  evaluateFilePath,
  DEFAULT_POLICY,
  DEFAULT_MAX_BYTES,
  loadIgnorePatterns,
  globToRegex,
} = require('./ingest-policy');

// Determines which files ingest processes: scope rules, file size, binary detection, and the
// repository's own ignore file.

// The oversize threshold is ingest-policy.js's DEFAULT_MAX_BYTES, not a second parse of the same
// environment variable, so the two cannot disagree.
const MAX_FILE_BYTES = DEFAULT_MAX_BYTES;

/** File extensions that are always binary / non-extractable. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif',
  '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.avi', '.mov', '.mkv', '.flv', '.wav', '.ogg', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.jar', '.war', '.ear',
  '.lock', '.sum',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.pyc', '.pyo',
  '.db', '.sqlite', '.sqlite3',
  '.DS_Store',
]);

/** Generated file patterns to skip. */
const GENERATED_FILE_RE = /\.(g|freezed|pb|pbenum|pbgrpc|pbserver)\.\w+$|\.generated\.\w+$|\.min\.(js|css)$/;

/** Storybook and browser-e2e scenario files — not indexed (unlike .test/.spec source). */
const NON_INDEXABLE_TEST_ARTIFACT_RE = /\.(?:stories|e2e)\.[jt]sx?$/;

// test/, tests/, spec/, __tests__ are descended during walkRepo and source-extension-gated
//. shouldProcess must NOT skip them here or test files will be silently excluded
// before reaching the classifier. Only skip pure-noise dirs that have no source value.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', '__pycache__', '.next', 'dist', 'build',
  'target', '.gradle', 'coverage', '.nyc_output', '.idea', '.vscode',
  '__mocks__', 'fixtures', 'stubs', '.dart_tool', '.pub-cache',
]);

// ─── Scope presets ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ScopePreset
 * @property {string}   name        - Preset name
 * @property {string}   description - Human-readable description
 * @property {RegExp[]} patterns    - File path patterns that match this scope
 */

const SCOPE_PRESETS = Object.freeze({
  /** Process all extractable files (default). */
  FULL: {
    name: 'FULL',
    description: 'Process all extractable source files',
    patterns: null, // null = no path filter, accept everything
  },
  /** Controllers/routers/endpoints only. */
  CONTROLLERS_ONLY: {
    name: 'CONTROLLERS_ONLY',
    description: 'Process only controller/router/endpoint files',
    patterns: [
      /controller\//i,
      /controllers\//i,
      /routes?\//i,
      /routers?\//i,
      /endpoints?\//i,
      /Controllers\//,
      /\.controller\.[jt]s$/,
      /\.routes?\.[jt]s$/,
    ],
  },
  /** Service/business-logic layer only. */
  SERVICES_ONLY: {
    name: 'SERVICES_ONLY',
    description: 'Process only service/business-logic files',
    patterns: [
      /services?\//i,
      /Service\//,
      /\.service\.[jt]s$/,
      /usecase\//i,
      /usecases?\//i,
      /process\//i,
      /impl\//i,
    ],
  },
  /** API surface: controllers + services + models (no config, no utils). */
  API_SURFACE: {
    name: 'API_SURFACE',
    description: 'Process controllers, services, and model files',
    patterns: [
      // Controllers
      /controller\//i,
      /controllers\//i,
      /routes?\//i,
      /routers?\//i,
      /Controllers\//,
      /\.controller\.[jt]s$/,
      // Services
      /services?\//i,
      /Service\//,
      /\.service\.[jt]s$/,
      /usecase\//i,
      /process\//i,
      /impl\//i,
      // Models / entities
      /models?\//i,
      /entities?\//i,
      /entity\//i,
      /schemas?\//i,
      /domain\//i,
      /dto\//i,
      /DTOs?\//,
      /\.model\.[jt]s$/,
      /\.entity\.[jt]s$/,
      // Repository / data access
      /repository\//i,
      /repositories\//i,
      /Res?pository\//,
      /\.repository\.[jt]s$/,
    ],
  },
});

// ─── Main decision function ───────────────────────────────────────────────────

/**
 * Determine whether a file should be processed during ingest.
 *
 * Evaluation order:
 *  1. Binary extension → skip
 *  2. Generated file → skip
 *  4. File inside a skipped directory → skip
 *  5. ignore-file patterns → skip if matched
 *  6. File size → skip if over limit
 *  7. Scope preset filter → skip if scope has patterns and file doesn't match any
 *  8. Accept
 *
 * @param {string} filePath       - Relative file path (e.g. "src/main/java/com/example/Foo.java")
 * @param {string} [fileType]     - Classified file type from classifier.js (optional; not used for binary check)
 * @param {Object} [options]      - Options
 * @param {string} [options.scope='FULL'] - Scope preset name
 * @param {RegExp[]} [options.ignorePatterns] - Patterns from loadIgnorePatterns()
 * @param {number} [options.fileSizeBytes]    - Actual file size (if known)
 * @param {number} [options.maxFileBytes]     - Override MAX_FILE_BYTES
 * @returns {boolean}
 */
function shouldProcess(filePath, fileType, options = {}) {
  if (!filePath || typeof filePath !== 'string') return false;

  const {
    scope = 'FULL',
    ignorePatterns = [],
    fileSizeBytes,
    maxFileBytes = MAX_FILE_BYTES,
    policy,
  } = options;

  const evaluation = evaluateFilePath(filePath, {
    policy: policy || {
      ...DEFAULT_POLICY,
      ignorePatterns,
      // This used to hardcode 'skip', diverging from DEFAULT_POLICY.size.oversize ('chunk') in
      // ingest-policy.js. Read the policy default instead of restating a different one.
      size: { max_bytes: maxFileBytes, oversize: DEFAULT_POLICY.size.oversize },
    },
    fileSizeBytes,
    maxFileBytes,
  });

  if (evaluation.decision === 'skip') return false;
  if (evaluation.decision === 'chunk') return true;

  const preset = SCOPE_PRESETS[scope] || SCOPE_PRESETS.FULL;
  if (preset.patterns) {
    const matchesScope = preset.patterns.some((p) => p.test(filePath));
    if (!matchesScope) return false;
  }

  return true;
}

module.exports = {
  shouldProcess,
  loadIgnorePatterns,
  globToRegex,
  SCOPE_PRESETS,
  BINARY_EXTENSIONS,
  GENERATED_FILE_RE,
  NON_INDEXABLE_TEST_ARTIFACT_RE,
};
