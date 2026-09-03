'use strict';

const pool = require('../db/pool');

const MAX_SUMMARY_CHARS = 500;

/**
 * Derive a compact file summary from extracted nodes without calling an LLM.
 * Used as the deterministic fallback when LLM summary generation is disabled
 * or when the file has enough node-level signal.
 *
 * @param {{ path: string, fileType?: string }} file
 * @param {Array<{ node_type?: string, name?: string, summary?: string }>} nodes
 * @returns {{ text: string, source: 'nodes'|'heuristic' }}
 */
function deriveFileSummaryFromNodes(file, nodes) {
  if (!nodes || nodes.length === 0) {
    const base = file.path ? file.path.split('/').pop() : 'Unknown file';
    return { text: `Source file: ${base}`, source: 'heuristic' };
  }

  const topNodes = nodes.slice(0, 6);
  const parts = [];

  for (const nd of topNodes) {
    if (nd.summary && nd.summary.trim()) {
      parts.push(nd.summary.trim().slice(0, 120));
    } else if (nd.name && nd.node_type) {
      parts.push(`${nd.node_type} ${nd.name}`);
    }
  }

  if (parts.length === 0) {
    const names = topNodes.map(n => n.name).filter(Boolean).join(', ');
    const base = file.path ? file.path.split('/').pop() : 'Unknown file';
    return { text: names ? `Contains: ${names}` : `Source file: ${base}`, source: 'heuristic' };
  }

  const text = parts.join('. ').slice(0, MAX_SUMMARY_CHARS);
  return { text, source: 'nodes' };
}

/**
 * Generate a compact file summary. Uses node-derived summary as primary
 * (deterministic, zero LLM cost); falls back to heuristic from path/fileType.
 * LLM generation is not called here to keep ingest cost bounded —
 * callers may wire an optional LLM summarizer later.
 *
 * @param {object} opts
 * @param {number}  opts.fileId
 * @param {string}  opts.filePath
 * @param {string}  [opts.fileType]
 * @param {string}  [opts.content]       - raw file content (unused in this impl, reserved)
 * @param {Array}   [opts.nodes]         - nodes already extracted from this file
 * @param {number}  [opts.maxChars]
 * @returns {Promise<{ text: string, source: 'llm'|'nodes'|'heuristic' }>}
 */
async function generateFileSummary({ fileId, filePath, fileType, nodes = [], maxChars = MAX_SUMMARY_CHARS }) {
  const derived = deriveFileSummaryFromNodes({ path: filePath, fileType }, nodes);
  const text = derived.text.slice(0, maxChars);
  return { text, source: derived.source };
}

/**
 * Write a file summary to files.
 *
 * @param {object} opts
 * @param {number} opts.fileId
 * @param {string} opts.summary
 * @param {string} opts.summarySource  - 'llm'|'nodes'|'heuristic'
 * @param {string} [opts.summaryModel] - only set when source is 'llm'
 */
async function writeFileSummary({ fileId, summary, summarySource, summaryModel = null, summaryGenerationId = null }) {
  await pool.query(
    `UPDATE files
     SET summary               = $2,
         summary_generated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         summary_source        = $3,
         summary_model         = $4,
         summary_generation_id = COALESCE($5, summary_generation_id)
     WHERE id = $1`,
    [fileId, summary, summarySource, summaryModel, summaryGenerationId]
  );
}

/**
 * Upsert a file summary: write only if the file has no summary yet,
 * or if forceful re-generation is requested.
 *
 * @param {object} opts - same as generateFileSummary + writeFileSummary
 * @param {boolean} [opts.force] - overwrite even if summary already exists
 */
async function upsertFileSummary({ fileId, filePath, fileType, nodes, maxChars, force = false, summaryGenerationId = null }) {
  if (!force) {
    const { rows } = await pool.query(
      `SELECT 1 FROM files WHERE id = $1 AND summary IS NOT NULL LIMIT 1`,
      [fileId]
    );
    if (rows.length > 0) return;
  }

  const { text, source } = await generateFileSummary({ fileId, filePath, fileType, nodes, maxChars });
  await writeFileSummary({ fileId, summary: text, summarySource: source, summaryGenerationId });
}

module.exports = { generateFileSummary, deriveFileSummaryFromNodes, writeFileSummary, upsertFileSummary };
