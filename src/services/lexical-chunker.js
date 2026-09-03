// Deterministic line-window chunker + code-aware search_text expansions for the lexical channel.
// Pure functions, no I/O.
//
// Line slicing MUST match getSourceExcerpt's convention exactly (source-excerpts.js):
// 1-based inclusive start/end, sliced as lines.slice(startLine - 1, endLine).join('\n').
// An off-by-one here produces citations that point at the wrong lines.

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
// Split camelCase / PascalCase boundaries: lower->Upper, or Upper+lower->Upper run.
const CAMEL_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

const MAX_SEARCH_TEXT_BYTES = 512 * 1024;
const MAX_TOKEN_BYTES = 2000;

/**
 * Split a file's text into deterministic, overlapping 1-based inclusive line windows.
 *
 * Returns a plain array of chunks (so callers can call array methods directly, matching
 * this plan's PROOF harness), with a non-enumerable-adjacent `truncated` boolean property
 * attached to the array itself for the maxChunks guard.
 *
 * @param {string} content
 * @param {{chunkLines?: number, overlapLines?: number, maxChunks?: number}} [opts]
 * @returns {Array<{chunk_index:number,start_line:number,end_line:number,chunk_text:string}> & {truncated: boolean}}
 */
function chunkFileText(content, { chunkLines = 60, overlapLines = 15, maxChunks = 400 } = {}) {
  const lines = content == null ? [] : content.split(/\r?\n/);
  const totalLines = lines.length;
  const stride = Math.max(1, chunkLines - overlapLines);

  const chunks = [];
  let truncated = false;

  if (totalLines > 0) {
    let chunkIndex = 0;
    let startLine = 1;

    while (startLine <= totalLines) {
      if (chunks.length >= maxChunks) {
        truncated = true;
        break;
      }

      const endLine = Math.min(startLine + chunkLines - 1, totalLines);
      const chunkText = lines.slice(startLine - 1, endLine).join('\n');

      chunks.push({
        chunk_index: chunkIndex,
        start_line: startLine,
        end_line: endLine,
        chunk_text: chunkText,
      });

      chunkIndex++;

      if (endLine >= totalLines) break;
      startLine += stride;
    }
  }

  chunks.truncated = truncated;
  return chunks;
}

/**
 * camelCase / PascalCase split: getPetById -> ['get', 'Pet', 'By', 'Id'].
 * @param {string} token
 * @returns {string[]}
 */
function camelSplit(token) {
  return token.split(CAMEL_BOUNDARY_RE).filter(Boolean);
}

/**
 * Build the query/index-side search_text expansions for a body of text.
 * Emits ONLY the two expansions below — never a copy of the original text
 * (the generated index already covers chunk_text; re-including the original
 * inside search_text would index it twice).
 *
 *   1. camelCase split: getPetById -> "get Pet By Id"
 *   2. dot/slash split: PetTypeFormatter.java -> "PetTypeFormatter java"
 *      (replaces [./\:] with spaces so Postgres's default parser, which
 *      collapses dotted/slashed identifiers into one host/url/file lexeme,
 *      still sees the bare identifier)
 *
 * Explicitly does NOT expand snake_case — Postgres's default parser already
 * splits on `_` for free (ts_debug('simple','pet_type') -> asciiword pet / asciiword type).
 *
 * @param {string} chunkText
 * @returns {{searchText: string, droppedTokens: number, truncated: boolean}}
 */
function buildSearchText(chunkText) {
  const text = chunkText || '';

  const camelParts = [];
  let droppedTokens = 0;

  // Drop any identifier over MAX_TOKEN_BYTES from BOTH expansions in one pass: it must not
  // survive into the camelCase legs, and it must not survive unsplit into the dot/slash leg
  // either, or the same oversize lexeme just reappears there.
  const filteredText = text.replace(IDENTIFIER_RE, (token) => {
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      droppedTokens++;
      return ' ';
    }
    const parts = camelSplit(token);
    if (parts.length > 1) {
      for (const part of parts) camelParts.push(part);
    }
    return token;
  });

  const dotSlashText = filteredText.replace(/[./\\:]/g, ' ');

  const pieces = [];
  if (camelParts.length) pieces.push(camelParts.join(' '));
  if (dotSlashText.trim()) pieces.push(dotSlashText);

  let searchText = pieces.join(' ');
  let truncated = false;

  if (Buffer.byteLength(searchText, 'utf8') > MAX_SEARCH_TEXT_BYTES) {
    truncated = true;
    // Buffer.subarray can cut mid-codepoint; Node's utf8 decode then replaces the
    // truncated trailing bytes with U+FFFD (3 bytes), which can land the *decoded*
    // string BACK OVER the byte cap (measured: a 512 KB cut landed at 524,289 bytes,
    // one over). Re-check after decode and shed trailing chars until back under budget —
    // never silently exceed the cap this plan measures storage projections against.
    const buf = Buffer.from(searchText, 'utf8').subarray(0, MAX_SEARCH_TEXT_BYTES);
    searchText = buf.toString('utf8');
    while (Buffer.byteLength(searchText, 'utf8') > MAX_SEARCH_TEXT_BYTES) {
      searchText = searchText.slice(0, -1);
    }
  }

  return { searchText, droppedTokens, truncated };
}

module.exports = {
  chunkFileText,
  buildSearchText,
  camelSplit,
  MAX_SEARCH_TEXT_BYTES,
  MAX_TOKEN_BYTES,
};
