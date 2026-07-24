/**
 * mcp-error-wrapper.cjs — canonical MCP error envelope formatter.
 *
 * Single source of truth for the { error: { code, message } } envelope shape
 * used by both engine-router and mcp-server (FR-018, FR-019, SD §12.2, D5).
 *
 * Design decisions:
 *   - Error codes are the stable wire contract — wrapError passes them through
 *     unchanged (D5: no translation, no renaming).
 *   - An error object with no .code property → 'ERR_UNKNOWN' fallback.
 *   - A missing or empty .message → 'Unknown error' default.
 *   - Accepts both Error instances and plain objects with code/message props.
 *   - Zero external dependencies; pure CommonJS.
 *
 * Public exports:
 *   wrapError(err) → { error: { code: string, message: string } }
 */
'use strict';

/**
 * Wrap an error object into the canonical MCP error envelope.
 *
 * Accepts any object that may carry a .code and/or .message property —
 * typically a thrown Error or a plain {code, message} object.
 *
 * SD §12.2 domain codes passed through unchanged (D5):
 *   ERR_TASK_NOT_FOUND, ERR_INVALID_STATUS, ERR_TAG_NOT_FOUND,
 *   ERR_DEP_CYCLE, ERR_DEP_NOT_FOUND, ERR_AI_HOST_REQUIRED
 *
 * @param {Error|{code?: string, message?: string}} err - error to wrap
 * @returns {{ error: { code: string, message: string } }}
 */
function wrapError(err) {
  const code = (err && err.code) || 'ERR_UNKNOWN';
  const message = (err && err.message) || 'Unknown error';
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { wrapError };
