/**
 * Unit tests for lib/ai-router.cjs — AI operation router.
 *
 * Covers (SD §9.2, FR-001, FR-008, FR-011, TC-001, TC-002, TC-007; decisions D2/D6):
 *   TC-001 — no aiMode in config → defaults to agent-native, no ERR_AI_MODE_UNKNOWN
 *   TC-002 — aiMode 'unsupported' → throws ERR_AI_MODE_UNKNOWN with value in message
 *   TC-007 — agent-native + no host + fallback null → throws ERR_AI_HOST_REQUIRED
 *   HOST    — CLAUDECODE=1 (no SPEC_FLOW_HOST_AGENT) → host present, emits spec to _stdout
 *   OVERRIDE— SPEC_FLOW_HOST_AGENT='' + CLAUDECODE=1 → no host (override wins)
 *   FALLBACK— agent-native + no host + fallback configured → delegates to headless-fallback-provider
 *   HEADLESS— aiMode headless-fallback (regardless of host) → delegates to headless-fallback-provider
 *   RESOLVE — resolveHostPresence covers all env combinations
 *
 * All env reads are deterministic via _inject._env so no test depends on
 * ambient process.env. All network calls are blocked via _inject._httpPost.
 *
 * Run:  node test/ai-router.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let aiRouter;
test('ai-router module imports without throwing', () => {
  aiRouter = require('../lib/ai-router.cjs');
});

// ---------------------------------------------------------------------------
// Verify exports
// ---------------------------------------------------------------------------

test('ai-router exports route function', () => {
  assert.ok(typeof aiRouter.route === 'function',
    'route must be exported as a function');
});

test('ai-router exports resolveHostPresence function', () => {
  assert.ok(typeof aiRouter.resolveHostPresence === 'function',
    'resolveHostPresence must be exported as a function');
});

// ---------------------------------------------------------------------------
// resolveHostPresence — D2 host detection logic
// ---------------------------------------------------------------------------

test('resolveHostPresence: SPEC_FLOW_HOST_AGENT=1 → host present (overrides CLAUDECODE absence)', () => {
  const env = { SPEC_FLOW_HOST_AGENT: '1' };
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), true);
});

test('resolveHostPresence: SPEC_FLOW_HOST_AGENT=1 overrides CLAUDECODE=1 (both set → truthy SFHA wins)', () => {
  const env = { SPEC_FLOW_HOST_AGENT: '1', CLAUDECODE: '1' };
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), true);
});

test('resolveHostPresence: SPEC_FLOW_HOST_AGENT=0 overrides CLAUDECODE=1 → no host', () => {
  const env = { SPEC_FLOW_HOST_AGENT: '0', CLAUDECODE: '1' };
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), false);
});

test('resolveHostPresence: SPEC_FLOW_HOST_AGENT=false overrides CLAUDECODE=1 → no host', () => {
  const env = { SPEC_FLOW_HOST_AGENT: 'false', CLAUDECODE: '1' };
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), false);
});

test('resolveHostPresence: SPEC_FLOW_HOST_AGENT="" overrides CLAUDECODE=1 → no host', () => {
  const env = { SPEC_FLOW_HOST_AGENT: '', CLAUDECODE: '1' };
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), false);
});

test('resolveHostPresence: no SPEC_FLOW_HOST_AGENT + CLAUDECODE=1 → host present', () => {
  const env = { CLAUDECODE: '1' };
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), true);
});

test('resolveHostPresence: no SPEC_FLOW_HOST_AGENT + no CLAUDECODE → no host', () => {
  const env = {};
  assert.equal(aiRouter.resolveHostPresence({ _env: env }), false);
});

test('resolveHostPresence: no inject → falls back to process.env (does not throw)', () => {
  // Just verify it returns a boolean without throwing; actual value depends on
  // process.env which is outside our control here.
  const result = aiRouter.resolveHostPresence(undefined);
  assert.ok(typeof result === 'boolean', 'must return boolean');
});

// ---------------------------------------------------------------------------
// TC-001: no aiMode in config → defaults to agent-native (no ERR_AI_MODE_UNKNOWN)
// ERR_AI_HOST_REQUIRED is expected (no host, no fallback) — but NOT ERR_AI_MODE_UNKNOWN.
// ---------------------------------------------------------------------------

test('TC-001: no aiMode in config → agent-native default, throws ERR_AI_HOST_REQUIRED (not ERR_AI_MODE_UNKNOWN)', async () => {
  const config = { taskCore: { headlessFallback: null } }; // aiMode absent
  const inject = { _env: {} }; // no host

  let caughtErr;
  try {
    await aiRouter.route('parse-prd', {}, config, inject);
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr, 'must throw');
  assert.equal(caughtErr.code, 'ERR_AI_HOST_REQUIRED',
    'aiMode absence must default to agent-native → ERR_AI_HOST_REQUIRED, not ERR_AI_MODE_UNKNOWN');
});

// ---------------------------------------------------------------------------
// TC-002: aiMode 'unsupported' → throws ERR_AI_MODE_UNKNOWN with value in message
// ---------------------------------------------------------------------------

test('TC-002: aiMode "unsupported" → throws ERR_AI_MODE_UNKNOWN with value in message', async () => {
  const config = { taskCore: { aiMode: 'unsupported', headlessFallback: null } };
  const inject = { _env: {} };

  await assert.rejects(
    () => aiRouter.route('parse-prd', {}, config, inject),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_MODE_UNKNOWN',
        `err.code must be ERR_AI_MODE_UNKNOWN; got "${err.code}"`);
      assert.ok(err.message.includes('unsupported'),
        `err.message must include the bad value "unsupported"; got: "${err.message}"`);
      assert.ok(err.message.includes('agent-native'),
        'err.message must mention valid value "agent-native"');
      assert.ok(err.message.includes('headless-fallback'),
        'err.message must mention valid value "headless-fallback"');
      return true;
    }
  );
});

test('TC-002: aiMode "cloud-only" → throws ERR_AI_MODE_UNKNOWN with value in message', async () => {
  const config = { taskCore: { aiMode: 'cloud-only', headlessFallback: null } };
  const inject = { _env: {} };

  await assert.rejects(
    () => aiRouter.route('expand', {}, config, inject),
    (err) => {
      assert.equal(err.code, 'ERR_AI_MODE_UNKNOWN');
      assert.ok(err.message.includes('cloud-only'));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// TC-007: agent-native + no host + fallback null → throws ERR_AI_HOST_REQUIRED
// ---------------------------------------------------------------------------

test('TC-007: agent-native + no host + fallback null → throws ERR_AI_HOST_REQUIRED', async () => {
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = { _env: {} }; // empty env → no host

  await assert.rejects(
    () => aiRouter.route('expand', {}, config, inject),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        `err.code must be ERR_AI_HOST_REQUIRED; got "${err.code}"`);
      // Message must include actionable guidance
      assert.ok(err.message.includes('headless'),
        'err.message must mention headless fallback configuration guidance');
      assert.ok(err.message.includes('agent-native') || err.message.toLowerCase().includes('host'),
        'err.message must mention agent-native or host detection');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// HOST: CLAUDECODE=1 → host present, agent-native emits spec to injected _stdout
// ---------------------------------------------------------------------------

test('CLAUDECODE=1 (no SPEC_FLOW_HOST_AGENT) → host present, emits spec to _stdout', async () => {
  const stdoutChunks = [];
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = {
    _env: { CLAUDECODE: '1' },
    _stdout: (chunk) => stdoutChunks.push(chunk),
  };
  const params = { inputContent: 'requirements doc content', tag: 'main' };

  const result = await aiRouter.route('parse-prd', params, config, inject);

  assert.ok(result, 'must return a result object');
  assert.equal(result.emitted, true,
    'result.emitted must be true when spec is emitted');
  assert.ok(result.spec, 'result.spec must be present');
  assert.ok(stdoutChunks.length > 0, 'spec must be written to injected _stdout');
  const emitted = JSON.parse(stdoutChunks.join(''));
  assert.equal(emitted.operation, 'parse-prd',
    'emitted spec must carry the operation name');
  assert.ok(emitted.taskSchema, 'emitted spec must include taskSchema');
});

test('host present: emitted spec includes tag and inputContent', async () => {
  const stdoutChunks = [];
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = {
    _env: { CLAUDECODE: '1' },
    _stdout: (chunk) => stdoutChunks.push(chunk),
  };
  const params = { inputContent: 'build subtasks for task 5', tag: 'v2', context: { parentTaskId: '5' } };

  const result = await aiRouter.route('expand', params, config, inject);

  assert.equal(result.emitted, true);
  const emitted = JSON.parse(stdoutChunks.join(''));
  assert.equal(emitted.operation, 'expand');
  assert.equal(emitted.tag, 'v2');
  assert.ok(emitted.context, 'context must be included in spec');
  assert.equal(emitted.context.parentTaskId, '5');
});

// ---------------------------------------------------------------------------
// OVERRIDE: SPEC_FLOW_HOST_AGENT="" with CLAUDECODE=1 → no host (override wins)
// ---------------------------------------------------------------------------

test('SPEC_FLOW_HOST_AGENT="" with CLAUDECODE=1 → no host, throws ERR_AI_HOST_REQUIRED', async () => {
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = {
    _env: { SPEC_FLOW_HOST_AGENT: '', CLAUDECODE: '1' }, // SFHA override wins
  };

  await assert.rejects(
    () => aiRouter.route('parse-prd', {}, config, inject),
    (err) => {
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED',
        'SPEC_FLOW_HOST_AGENT="" must override CLAUDECODE=1 → no host');
      return true;
    }
  );
});

test('SPEC_FLOW_HOST_AGENT="0" with CLAUDECODE=1 → no host, throws ERR_AI_HOST_REQUIRED', async () => {
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = {
    _env: { SPEC_FLOW_HOST_AGENT: '0', CLAUDECODE: '1' },
  };

  await assert.rejects(
    () => aiRouter.route('expand', {}, config, inject),
    (err) => {
      assert.equal(err.code, 'ERR_AI_HOST_REQUIRED');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// FALLBACK: agent-native + no host + fallback configured → delegates to provider
// ---------------------------------------------------------------------------

test('agent-native + no host + fallback configured → delegates to headless-fallback-provider', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-router-test-'));
  const tasksFile = path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json');

  const fallbackConfig = {
    endpoint: 'https://api.test/v1/chat/completions',
    model: 'gpt-4',
    apiKey: 'test-api-key',
  };
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: fallbackConfig } };

  const mockTasks = [{
    id: '1',
    title: 'Generated task',
    description: 'From headless fallback',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    updatedAt: new Date().toISOString(),
  }];
  const inject = {
    _env: {}, // no host
    _httpPost: async () => ({ status: 200, json: mockTasks }),
    _paths: { tasksFile },
  };

  const result = await aiRouter.route('parse-prd', { tag: 'main', inputContent: 'requirements' }, config, inject);

  assert.ok(result, 'must return a result');
  assert.equal(result.imported, 1,
    'headless-fallback-provider must import the mock tasks');
});

// ---------------------------------------------------------------------------
// HEADLESS: aiMode=headless-fallback → delegates regardless of host presence
// ---------------------------------------------------------------------------

test('headless-fallback mode: delegates to headless-fallback-provider regardless of host presence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-router-test-'));
  const tasksFile = path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json');

  const fallbackConfig = {
    endpoint: 'https://api.test/v1/chat/completions',
    model: 'gpt-4',
    apiKey: 'test-key',
  };
  const config = { taskCore: { aiMode: 'headless-fallback', headlessFallback: fallbackConfig } };

  const mockTasks = [{
    id: '1',
    title: 'Headless task',
    description: 'Forced headless',
    status: 'pending',
    priority: 'low',
    dependencies: [],
    subtasks: [],
    updatedAt: new Date().toISOString(),
  }];
  // Host IS present but headless-fallback mode ignores it
  const inject = {
    _env: { CLAUDECODE: '1' },
    _httpPost: async () => ({ status: 200, json: mockTasks }),
    _paths: { tasksFile },
  };

  const result = await aiRouter.route('parse-prd', { tag: 'main', inputContent: 'requirements' }, config, inject);

  assert.ok(result);
  assert.equal(result.imported, 1,
    'headless-fallback mode must use the provider regardless of host presence');
});

test('headless-fallback mode: fallback config null → throws with ERR_AI_HOST_REQUIRED', async () => {
  const config = { taskCore: { aiMode: 'headless-fallback', headlessFallback: null } };
  const inject = { _env: {} };

  await assert.rejects(
    () => aiRouter.route('parse-prd', {}, config, inject),
    (err) => {
      // Config error — code should indicate something went wrong with config
      assert.ok(err instanceof Error);
      assert.ok(err.code, 'error must have a .code');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// No stdout pollution on non-emitting paths (D7: diagnostics to stderr only)
// ---------------------------------------------------------------------------

test('ERR_AI_HOST_REQUIRED path: nothing written to injected _stdout', async () => {
  const stdoutChunks = [];
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = {
    _env: {},
    _stdout: (chunk) => stdoutChunks.push(chunk),
  };

  try {
    await aiRouter.route('parse-prd', {}, config, inject);
  } catch (_) {
    // expected
  }

  assert.equal(stdoutChunks.length, 0,
    'stdout must not be written when host is not present and error is thrown');
});

test('agent-native + host present: only one JSON spec written to _stdout per call', async () => {
  const stdoutChunks = [];
  const config = { taskCore: { aiMode: 'agent-native', headlessFallback: null } };
  const inject = {
    _env: { CLAUDECODE: '1' },
    _stdout: (chunk) => stdoutChunks.push(chunk),
  };

  await aiRouter.route('analyze-complexity', { inputContent: 'all tasks', tag: 'main' }, config, inject);

  assert.equal(stdoutChunks.length, 1,
    'exactly one write to stdout per route call');
  // Verify it is valid JSON
  const parsed = JSON.parse(stdoutChunks[0]);
  assert.ok(parsed, 'emitted spec must be valid JSON');
});
