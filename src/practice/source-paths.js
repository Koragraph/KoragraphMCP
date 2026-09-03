'use strict';

// Shared by the history seeder and the live fail→fix capture, and dependency-free on purpose:
// fail-fix.js runs on the SessionEnd hook path, and seed.js requires resolve.js, which opens
// graph.db. Requiring seed.js from the hook path would fail the transitive require-graph test and,
// worse, block the user's editor behind an ingest write transaction.

const SOURCE_EXTS = new Set([
  '.java', '.py', '.pyi', '.go', '.rb', '.rs', '.php', '.cs', '.dart', '.lua', '.sql',
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue',
  '.kt', '.kts', '.scala', '.swift', '.ex', '.exs',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
  '.sh', '.bash', '.zig', '.m', '.mm', '.sol', '.ml', '.res',
]);

function isSourcePath(filePath) {
  const base = String(filePath || '').split('/').pop();
  // `path.extname('.env')` is '' — a leading dot makes the whole name the basename — so `.env`,
  // `.envrc` and `.gitignore` fall out here rather than needing a rule of their own.
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_EXTS.has(base.slice(dot).toLowerCase());
}

module.exports = { SOURCE_EXTS, isSourcePath };
