/**
 * Unit tests for lib/ai-hybrid.cjs — AI op dispatcher that delegates to AIRouter.
 *
 * Covers (SD §6.3 D4, sub 4/5 dispatch):
 *   (1) Missing required args: _validateArgs throws "Missing required arg: <name>"
 *       Tested directly on _validateArgs because it is a utility kept for
 *       backward compatibility; dispatch itself does not call it (AIRouter handles
 *       routing without arg pre-validation).
 *   (2) Each AI op with forced no-host + no-fallback → throws ERR_AI_HOST_REQUIRED.
 *       Tests pass _inject._env={} so resolveHostPresence returns false regardless
 *       of the ambient CLAUDECODE env var. _configFile points to a non-existent
 *       path so ai-config defaults to { aiMode:'agent-native', headlessFallback:null }.
 *   (3) Thrown error carries .code so engine-router _wrapError can preserve it.
 *   (4) NEW — agent-native + host present → dispatch returns { emitted:true, spec }.
 *       Host is injected via _inject._env so no real ambient env dependency.
 *
 * Note on env determinism (Part C requirement):
 *   This session runs with CLAUDECODE=1, so any test that calls dispatch WITHOUT
 *   controlling env would take the agent-native path instead of throwing
 *   ERR_AI_HOST_REQUIRED. All (2)/(3) tests below force no-host via _inject._env={}.
 *
 * Run:  node test/ai-hybrid.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import
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
// _validateArgs is a utility kept for backward compatibility.
// dispatch itself does not call _validateArgs — AIRouter handles routing
// without pre-validation. These tests cover the utility in isolation.
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
// (2) Each AI op with forced no-host + no-fallback → ERR_AI_HOST_REQUIRED
//
// _inject._env={} forces resolveHostPresence() to return false (no host).
// _configFile points to a non-existent path → ai-config defaults:
//   { taskCore: { aiMode: 'agent-native', headlessFallback: null } }
// This combination guarantees ERR_AI_HOST_REQUIRED regardless of CLAUDECODE.
// ---------------------------------------------------------------------------

const NO_HOST_INJECT = {
  _configFile: '/nonexistent/path/for-test/config.json',
  _inject: { _env: {} },
};

test('(2) parse-prd with valid args throws Error with .code === "ERR_AI_HOST_REQUIRED"', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('parse-prd', {
      input: 'requirements.md',
      ...NO_HOST_INJECT,
    }),
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
    () => aiHybrid.executeAiOp('expand', {
      id: '1',
      ...NO_HOST_INJECT,
    }),
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
    () => aiHybrid.executeAiOp('update', {
      from: 'context.md',
      ...NO_HOST_INJECT,
    }),
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
    () => aiHybrid.executeAiOp('research', {
      query: 'what is TDD?',
      ...NO_HOST_INJECT,
    }),
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
    () => aiHybrid.executeAiOp('analyze-complexity', {
      ...NO_HOST_INJECT,
    }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `error.code must be ERR_AI_HOST_REQUIRED; got: "${err.code}"`);
      return true;
    }
  );
});

test('(2) expand without required id arg still throws ERR_AI_HOST_REQUIRED (no-host check precedes any validation)', async () => {
  await assert.rejects(
    () => aiHybrid.executeAiOp('expand', {
      tag: 'main',
      taskId: '1',
      ...NO_HOST_INJECT,
    }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        'no-host check must fire before any arg validation');
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
    await aiHybrid.executeAiOp('expand', {
      id: '42',
      ...NO_HOST_INJECT,
    });
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
    await aiHybrid.dispatch('expand', {
      id: '42',
      ...NO_HOST_INJECT,
    });
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr, 'error must have been thrown');
  assert.equal(caughtErr.code, 'ERR_AI_HOST_REQUIRED',
    'dispatch alias must propagate the same ERR_AI_HOST_REQUIRED code');
});

// ---------------------------------------------------------------------------
// (4) NEW — agent-native + host present → dispatch emits spec, returns {emitted:true}
//
// Injects CLAUDECODE=1 via _inject._env and captures _stdout output.
// Verifies the new real behavior of dispatch when the host IS present.
// ---------------------------------------------------------------------------

test('(4) dispatch: agent-native + CLAUDECODE=1 → emits spec to _stdout, returns {emitted:true, spec}', async () => {
  const stdoutChunks = [];
  const result = await aiHybrid.dispatch('parse-prd', {
    inputContent: 'requirements document content',
    tag: 'main',
    _configFile: '/nonexistent/path/for-test/config.json', // → defaults (agent-native, null fallback)
    _inject: {
      _env: { CLAUDECODE: '1' }, // host present
      _stdout: (chunk) => stdoutChunks.push(chunk),
    },
  });

  assert.ok(result, 'dispatch must return a result object');
  assert.equal(result.emitted, true,
    'result.emitted must be true when agent-native emits the spec');
  assert.ok(result.spec, 'result.spec must be the generated spec object');
  assert.ok(stdoutChunks.length > 0, 'spec must be written to the injected _stdout');
  const emitted = JSON.parse(stdoutChunks.join(''));
  assert.equal(emitted.operation, 'parse-prd',
    'emitted spec must carry the operation name');
  assert.ok(emitted.taskSchema, 'emitted spec must include taskSchema');
});

test('(4) executeAiOp alias: agent-native + host present → same behavior as dispatch', async () => {
  const stdoutChunks = [];
  const result = await aiHybrid.executeAiOp('expand', {
    inputContent: 'task to expand',
    tag: 'v2',
    context: { parentTaskId: '5' },
    _configFile: '/nonexistent/path/for-test/config.json',
    _inject: {
      _env: { CLAUDECODE: '1' },
      _stdout: (chunk) => stdoutChunks.push(chunk),
    },
  });

  assert.equal(result.emitted, true);
  const emitted = JSON.parse(stdoutChunks.join(''));
  assert.equal(emitted.operation, 'expand');
  assert.equal(emitted.tag, 'v2');
});
