#!/usr/bin/env node
/**
 * bin/mcp-server.js — stdio transport for the spec-flow MCP server.
 *
 * Reads line-delimited JSON-RPC 2.0 requests from stdin, dispatches each to
 * lib/mcp-server.cjs, writes JSON-RPC 2.0 response objects to stdout.
 *
 * ALL logic lives in lib/mcp-server.cjs; this file is the transport wire only.
 * No business logic, no direct file I/O here.
 *
 * Protocol: newline-delimited JSON (one JSON object per line on both stdin and stdout).
 * This is the de facto stdio transport used by Claude's MCP client.
 *
 * Note: this is a dependency-free implementation (pure Node.js stdio) — no
 * @modelcontextprotocol/sdk is used. SD §6.2 names "MCP SDK" as an aspirational
 * Pass-2 note; the repo's zero-dependency / no-package.json constraint takes
 * precedence (task-1 architecture decision).
 */
'use strict';

const { handleJsonRpcRequest } = require('../lib/mcp-server.cjs');

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  // Split on newlines; keep any incomplete trailing line in buffer
  const lines = buffer.split('\n');
  buffer = lines.pop(); // last element is the (possibly empty) incomplete fragment
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      _handleLine(trimmed);
    }
  }
});

process.stdin.on('end', () => {
  // Process any remaining buffered content when stdin closes
  const trimmed = buffer.trim();
  if (trimmed) {
    _handleLine(trimmed);
  }
});

/**
 * Parse a single JSON line, dispatch to handleJsonRpcRequest, and write the response.
 * Errors at the parse or transport layer are returned as JSON-RPC parse-error responses.
 *
 * @param {string} line - raw JSON text (already trimmed)
 */
function _handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    const errResponse = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error: invalid JSON',
      },
    };
    process.stdout.write(JSON.stringify(errResponse) + '\n');
    return;
  }

  handleJsonRpcRequest(request)
    .then((response) => {
      process.stdout.write(JSON.stringify(response) + '\n');
    })
    .catch((err) => {
      // Defensive: handleJsonRpcRequest should not throw, but guard at the transport boundary
      const errResponse = {
        jsonrpc: '2.0',
        id: (request && request.id !== undefined) ? request.id : null,
        error: {
          code: -32603,
          message: `Internal error: ${err.message || String(err)}`,
        },
      };
      process.stdout.write(JSON.stringify(errResponse) + '\n');
    });
}
