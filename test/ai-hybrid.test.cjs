/**
 * Unit tests for lib/ai-hybrid.cjs — AI op stub that returns ERR_AI_HOST_REQUIRED.
 *
 * Covers (SD §6.3 D4, contract-shim task 4):
 *   (1) Missing required args: _validateArgs throws "Missing required arg: <name>"
 *       Tested directly on _validateArgs (not through executeAiOp) because the
 *       stub always throws ERR_AI_HOST_REQUIRED first (host unavailable), making
 *       the arg-validation path unreachable through executeAiOp in sub 3/5.
 *   (2) Each AI op with valid args but host unavailable → throws Error with
 *       .code === 'ERR_AI_HOST_REQUIRED'
 *   (3) Thrown error carries .code so the engine-router _wrapError can preserve it
 *
 * Note on engine-router integration (from task spec):
 *   The engine-router calls aiHybrid.dispatch(operation, safeArgs) and passes
 *   the full MCP args object (may not contain all AI-op-specific required args).
 *   Because hostAvailable = false, executeAiOp always throws ERR_AI_HOST_REQUIRED
 *   before arg validation — this is intentional so all engine-router AI-op tests
 *   continue to yield ERR_AI_HOST_REQUIRED (the "both paths must still yield
 *   ERR_AI_HOST_REQUIRED" requirement from the task spec).
 *
 * Run:  node test/ai-hybrid.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let aiHybrid;
test('ai-hybrid module imports without throwing', () => {
  aiHybrid = require('../lib/ai-hybrid.cjs');
});

// ---------------------------------------------------------------------------
// Verify exports
// ---------------------------------------------------------------------------

test('ai-hybrid exports executeAiOp function', () => {
  assert.ok(typeof aiHybrid.executeAiOp === 'function',
    'executeAiOp must be exported as a function');
});

test('ai-hybrid exports dispatch function (alias used by engine-router)', () => {
  assert.ok(typeof aiHybrid.dispatch === 'function',
    'dispatch must be exported as a function (engine-router calls aiHybrid.dispatch)');
});

test('ai-hybrid exports _validateArgs helper for direct testing', () => {
  assert.ok(typeof aiHybrid._validateArgs === 'function',
    '_validateArgs must be exported for direct unit testing');
});

// ---------------------------------------------------------------------------
// (1) Missing required args validation — tested via _validateArgs directly
//
// Because hostAvailable = false, executeAiOp always throws ERR_AI_HOST_REQUIRED
// before reaching arg validation. We test _validateArgs directly to cover the
// validation logic that sub 4/5 will exercise when hostAvailable = true.
// ---------------------------------------------------------------------------

test('(1) _validateArgs: parse-prd without args.input throws "Missing required arg: input"', () => {
  assert.throws(
    () => aiHybrid._validateArgs('parse-prd', {}),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.ok(
        err.message.includes('Missing required arg') && err.message.includes('input'),
        `message must mention "Missing required arg" and "input"; got: "${err.message}"`
      );
      return true;
    }
  );
});

test('(1) _validateArgs: expand without args.id throws "Missing required arg: id"', () => {
  assert.throws(
    () => aiHybrid._validateArgs('expand', {}),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.ok(
        err.message.includes('Missing required arg') && err.message.includes('id'),
        `message must mention "Missing required arg" and "id"; got: "${err.message}"`
      );
      return true;
    }
  );
});

test('(1) _validateArgs: update without args.from throws "Missing required arg: from"', () => {
  assert.throws(
    () => aiHybrid._validateArgs('update', {}),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.ok(
        err.message.includes('Missing required arg') && err.message.includes('from'),
        `message must mention "Missing required arg" and "from"; got: "${err.message}"`
      );
      return true;
    }
  );
});

test('(1) _validateArgs: research without args.query throws "Missing required arg: query"', () => {
  assert.throws(
    () => aiHybrid._validateArgs('research', {}),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.ok(
        err.message.includes('Missing required arg') && err.message.includes('query'),
        `message must mention "Missing required arg" and "query"; got: "${err.message}"`
      );
      return true;
    }
  );
});

test('(1) _validateArgs: analyze-complexity has no required arg — does not throw', () => {
  // analyze-complexity has no required argument; _validateArgs must not throw
  assert.doesNotThrow(
    () => aiHybrid._validateArgs('analyze-complexity', {}),
    'analyze-complexity has no required arg and must not throw from _validateArgs'
  );
});

test('(1) _validateArgs: parse-prd with input present does not throw', () => {
  assert.doesNotThrow(
    () => aiHybrid._validateArgs('parse-prd', { input: 'requirements.md' }),
    'parse-prd with input present must not throw from _validateArgs'
  );
});

test('(1) _validateArgs: expand with id present does not throw', () => {
  assert.doesNotThrow(
    () => aiHybrid._validateArgs('expand', { id: '1' }),
    'expand with id present must not throw from _validateArgs'
  );
});

// ---------------------------------------------------------------------------
// (2) Each AI op with valid args but host unavailable → ERR_AI_HOST_REQUIRED
// ---------------------------------------------------------------------------

test('(2) parse-prd with valid args throws Error with .code === "ERR_AI_HOST_REQUIRED"', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('parse-prd', { input: 'requirements.md' }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `error.code must be ERR_AI_HOST_REQUIRED; got: "${err.code}"`);
      assert.ok(typeof err.message === 'string' && err.message.length > 0,
        'error.message must be a non-empty string');
      return true;
    }
  );
});

test('(2) expand with valid args throws Error with .code === "ERR_AI_HOST_REQUIRED"', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('expand', { id: '1' }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `error.code must be ERR_AI_HOST_REQUIRED; got: "${err.code}"`);
      return true;
    }
  );
});

test('(2) update with valid args throws Error with .code === "ERR_AI_HOST_REQUIRED"', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('update', { from: 'context.md' }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `error.code must be ERR_AI_HOST_REQUIRED; got: "${err.code}"`);
      return true;
    }
  );
});

test('(2) research with valid args throws Error with .code === "ERR_AI_HOST_REQUIRED"', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('research', { query: 'what is TDD?' }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `error.code must be ERR_AI_HOST_REQUIRED; got: "${err.code}"`);
      return true;
    }
  );
});

test('(2) analyze-complexity (no required args) throws Error with .code === "ERR_AI_HOST_REQUIRED"', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('analyze-complexity', {}),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `error.code must be ERR_AI_HOST_REQUIRED; got: "${err.code}"`);
      return true;
    }
  );
});

// Host-unavailable path applies even when required args are missing (host check
// precedes arg validation). Engine-router (d) tests rely on this behavior.
test('(2) expand without required id arg still throws ERR_AI_HOST_REQUIRED (host check precedes arg validation)', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('expand', { tag: 'main', taskId: '1' }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        'host unavailable check must fire before arg validation');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (3) Error carries .code so engine-router _wrapError can preserve it
// ---------------------------------------------------------------------------

test('(3) thrown ERR_AI_HOST_REQUIRED error has both .code and .message set', async () => {
  let caughtErr;
  try {
    await aiHybrid.executeAiOp('expand', { id: '42' });
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr, 'error must have been thrown');
  assert.equal(caughtErr.code, 'ERR_AI_HOST_REQUIRED',
    '.code must be ERR_AI_HOST_REQUIRED');
  assert.ok(typeof caughtErr.message === 'string' && caughtErr.message.length > 0,
    '.message must be a non-empty string');
  assert.ok(caughtErr instanceof Error, 'must be a native Error instance');
});

test('(3) dispatch alias produces same ERR_AI_HOST_REQUIRED error as executeAiOp', async () => {
  let caughtErr;
  try {
    await aiHybrid.dispatch('expand', { id: '42' });
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr, 'error must have been thrown');
  assert.equal(caughtErr.code, 'ERR_AI_HOST_REQUIRED',
    'dispatch alias must propagate the same ERR_AI_HOST_REQUIRED code');
});
