/**
 * Unit tests for lib/mcp-error-wrapper.cjs — canonical MCP error envelope formatter.
 *
 * Covers SD §12.2, FR-018, FR-019, decision D5:
 *   (1) Error with .code passes the code through unchanged
 *   (2) Error with no .code → ERR_UNKNOWN
 *   (3) All six SD §12.2 domain codes are propagated unchanged
 *   (4) message defaults to 'Unknown error' when absent
 *   (5) Return shape is always { error: { code, message } }
 *
 * Run:  node test/mcp-error-wrapper.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let wrapError;
test('mcp-error-wrapper module imports without throwing', () => {
  ({ wrapError } = require('../lib/mcp-error-wrapper.cjs'));
  assert.equal(typeof wrapError, 'function', 'wrapError must be a function');
});

// ---------------------------------------------------------------------------
// (1) Error with .code passes the code through unchanged (D5 — no translation)
// ---------------------------------------------------------------------------

test('(1) Error with code ERR_TASK_NOT_FOUND wraps to correct envelope shape', () => {
  const err = new Error('Task 1 not found');
  err.code = 'ERR_TASK_NOT_FOUND';
  const result = wrapError(err);
  assert.deepEqual(result, {
    error: { code: 'ERR_TASK_NOT_FOUND', message: 'Task 1 not found' },
  });
});

test('(1) wrapError returns { error: { code, message } } shape for any Error', () => {
  const err = new Error('something bad');
  err.code = 'ERR_INVALID_STATUS';
  const result = wrapError(err);
  assert.ok(result && typeof result === 'object', 'result must be an object');
  assert.ok(result.error && typeof result.error === 'object', 'result.error must be an object');
  assert.equal(typeof result.error.code, 'string', 'error.code must be a string');
  assert.equal(typeof result.error.message, 'string', 'error.message must be a string');
});

// ---------------------------------------------------------------------------
// (2) Error with no .code → ERR_UNKNOWN (fallback)
// ---------------------------------------------------------------------------

test('(2) Error with no .code falls back to ERR_UNKNOWN', () => {
  const err = new Error('something went wrong');
  // deliberately no err.code set
  const result = wrapError(err);
  assert.equal(result.error.code, 'ERR_UNKNOWN',
    'missing .code must fall back to ERR_UNKNOWN');
  assert.equal(result.error.message, 'something went wrong',
    'message must be preserved from the Error');
});

test('(2) plain object with no .code also falls back to ERR_UNKNOWN', () => {
  const result = wrapError({ message: 'no code here' });
  assert.equal(result.error.code, 'ERR_UNKNOWN',
    'missing .code on plain object must fall back to ERR_UNKNOWN');
});

// ---------------------------------------------------------------------------
// (3) All six SD §12.2 domain codes are passed through unchanged (D5)
// ---------------------------------------------------------------------------

test('(3) all six SD §12.2 domain codes are propagated unchanged by wrapError', () => {
  const domainCodes = [
    'ERR_TASK_NOT_FOUND',
    'ERR_INVALID_STATUS',
    'ERR_TAG_NOT_FOUND',
    'ERR_DEP_CYCLE',
    'ERR_DEP_NOT_FOUND',
    'ERR_AI_HOST_REQUIRED',
  ];

  for (const code of domainCodes) {
    const err = Object.assign(new Error(`test error for ${code}`), { code });
    const result = wrapError(err);
    assert.equal(result.error.code, code,
      `code ${code} must be passed through unchanged — D5 no translation`);
    assert.ok(typeof result.error.message === 'string' && result.error.message.length > 0,
      `error.message must be a non-empty string for code ${code}`);
  }
});

// ---------------------------------------------------------------------------
// (4) message defaults to 'Unknown error' when absent
// ---------------------------------------------------------------------------

test('(4) message defaults to "Unknown error" when err.message is absent', () => {
  const err = { code: 'ERR_TASK_NOT_FOUND' }; // plain object, no .message
  const result = wrapError(err);
  assert.equal(result.error.message, 'Unknown error',
    'missing .message must default to "Unknown error"');
  assert.equal(result.error.code, 'ERR_TASK_NOT_FOUND',
    'code must still be preserved even when message defaults');
});

test('(4) message defaults to "Unknown error" when err.message is empty string', () => {
  const err = { code: 'ERR_UNKNOWN', message: '' };
  const result = wrapError(err);
  assert.equal(result.error.message, 'Unknown error',
    'empty string .message must default to "Unknown error"');
});

// ---------------------------------------------------------------------------
// (5) Double-check: no extra properties leaked into the error envelope
// ---------------------------------------------------------------------------

test('(5) error envelope has exactly two keys: code and message', () => {
  const err = new Error('precise shape');
  err.code = 'ERR_DEP_CYCLE';
  const result = wrapError(err);
  const envelopeKeys = Object.keys(result);
  assert.deepEqual(envelopeKeys, ['error'], 'top-level must have exactly one key: error');
  const errorKeys = Object.keys(result.error).sort();
  assert.deepEqual(errorKeys, ['code', 'message'],
    'result.error must have exactly two keys: code and message');
});
