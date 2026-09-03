'use strict';
const path = require('path');

// Extension -> language name. A generic mapper the ingest path needs.
const EXT_LANG = {
  '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
  '.py': 'python', '.rb': 'ruby', '.php': 'php', '.go': 'go', '.rs': 'rust',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.cs': 'csharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.swift': 'swift', '.m': 'objc', '.mm': 'objc', '.ex': 'elixir', '.exs': 'elixir',
  '.zig': 'zig', '.vue': 'vue', '.dart': 'dart',
};

function langFor(relPath) {
  return EXT_LANG[path.extname(relPath || '').toLowerCase()] || null;
}

module.exports = { EXT_LANG, langFor };
