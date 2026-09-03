'use strict';

const { handleMessage, jsonRpcError, RPC } = require('./protocol');

// MCP stdio framing: one JSON-RPC message per line on stdout, nothing else. An editor launches
// this server as a child process, so stdio is the whole transport — and nothing may throw past
// this boundary, because a thrown error here is a dead session rather than a failed request.

const MAX_LINE_BYTES = 8 * 1024 * 1024;

function createStdioServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const deps = options.deps || {};
  let buffer = '';
  let closed = false;
  const inflight = new Set();

  function write(message) {
    if (closed || message == null) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  async function dispatch(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      write(jsonRpcError(null, RPC.PARSE_ERROR, 'Parse error: not valid JSON'));
      return;
    }
    // A batch is a JSON-RPC 2.0 array and its reply is a SINGLE array of the responses, not one
    // line per element. An empty array is itself an Invalid Request; a batch of pure notifications
    // yields an empty response set and so writes nothing, both per spec.
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        write(jsonRpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: empty batch'));
        return;
      }
      const responses = [];
      for (const message of parsed) {
        try {
          const r = await handleMessage(message, deps);
          if (r != null) responses.push(r);
        } catch (err) {
          responses.push(jsonRpcError(message?.id ?? null, RPC.INTERNAL_ERROR, err?.message || 'Internal error'));
        }
      }
      if (responses.length) write(responses);
      return;
    }
    try {
      write(await handleMessage(parsed, deps));
    } catch (err) {
      write(jsonRpcError(parsed?.id ?? null, RPC.INTERNAL_ERROR, err?.message || 'Internal error'));
    }
  }

  function onData(chunk) {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      write(jsonRpcError(null, RPC.INVALID_REQUEST, 'Request exceeded the maximum message size'));
      return;
    }
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const job = dispatch(line).finally(() => inflight.delete(job));
        inflight.add(job);
      }
      idx = buffer.indexOf('\n');
    }
  }

  function start() {
    input.setEncoding('utf8');
    input.on('data', onData);
    // stdin ending means no MORE requests, not that outstanding ones are abandoned. Marking the
    // stream closed here dropped every reply whose handler had not yet resolved — which is every
    // reply, when the input is a pipe or a file rather than a live editor.
    input.on('end', () => {
      Promise.allSettled([...inflight]).then(() => {
        closed = true;
        if (typeof options.onClose === 'function') options.onClose();
      });
    });
    input.resume();
    return { stop };
  }

  async function stop() {
    closed = true;
    input.off('data', onData);
    await Promise.allSettled([...inflight]);
  }

  return { start, stop, dispatch, write };
}

module.exports = { createStdioServer, MAX_LINE_BYTES };
