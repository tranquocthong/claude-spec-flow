/**
 * Unit tests for lib/ai-config.cjs — loadConfig() for taskCore aiMode + headlessFallback.
 *
 * Covers FR-001, FR-009, FR-010 (SD §9.2 config loader):
 *   (1) Missing config file → defaults: aiMode 'agent-native', headlessFallback null
 *   (2) Config with only aiMode set → headlessFallback defaults to null
 *   (3) Fallback fully configured (endpoint, model, apiKey) → returned as-is (valid)
 *   (4) Incomplete fallback (missing apiKey) → throws Error with .code === 'ERR_CONFIG_INVALID'
 *   (5) Config with taskCore absent → defaults applied (aiMode 'agent-native', headlessFallback null)
 *   (6) aiMode present with non-standard string → passed through (enum check belongs to AIRouter)
 *   (7) headlessFallback = null explicitly → accepted (null disables fallback)
 *   (8) Incomplete fallback (missing endpoint) → throws ERR_CONFIG_INVALID
 *   (9) Incomplete fallback (missing model) → throws ERR_CONFIG_INVALID
 *
 * Each test uses os.mkdtemp isolation via _inject._configFile — the REAL repo's
 * .spec-flow/config.json is never touched during testing.
 *
 * Run:  node test/ai-config.test.cjs
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

let loadConfig;
test('ai-config module imports without throwing', () => {
  ({ loadConfig } = require('../lib/ai-config.cjs'));
  assert.equal(typeof loadConfig, 'function', 'loadConfig must be exported as a function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated temp directory and return a path to a config file inside it.
 * The file is NOT created yet — the caller decides whether to write it.
 *
 * @returns {{ tmpDir: string, configFile: string }}
 */
function makeTmpConfig() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-config-test-'));
  const configFile = path.join(tmpDir, 'config.json');
  return { tmpDir, configFile };
}

/**
 * Write a JSON object to the given path.
 *
 * @param {string} filePath
 * @param {object} data
 */
function writeConfig(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// (1) Missing config file → defaults: aiMode 'agent-native', headlessFallback null
// ---------------------------------------------------------------------------

test('(1) missing config file → returns default aiMode "agent-native" and headlessFallback null', () => {
  const { configFile } = makeTmpConfig();
  // Do NOT create the file — it must be absent

  const result = loadConfig({ _configFile: configFile });

  assert.ok(result !== null && typeof result === 'object', 'result must be an object');
  assert.ok(result.taskCore !== null && typeof result.taskCore === 'object',
    'result.taskCore must be an object');
  assert.equal(result.taskCore.aiMode, 'agent-native',
    'aiMode must default to "agent-native" when file is missing');
  assert.equal(result.taskCore.headlessFallback, null,
    'headlessFallback must default to null when file is missing');
});

// ---------------------------------------------------------------------------
// (2) Config with only aiMode set → headlessFallback defaults to null
// ---------------------------------------------------------------------------

test('(2) config with only aiMode set → headlessFallback defaults to null', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'headless',
    },
  });

  const result = loadConfig({ _configFile: configFile });

  assert.equal(result.taskCore.aiMode, 'headless',
    'aiMode from config must be preserved');
  assert.equal(result.taskCore.headlessFallback, null,
    'headlessFallback must default to null when absent from config');
});

// ---------------------------------------------------------------------------
// (3) Fallback fully configured (endpoint, model, apiKey) → returned as-is
// ---------------------------------------------------------------------------

test('(3) fully configured headlessFallback → returned without error', () => {
  const { configFile } = makeTmpConfig();
  const fallback = {
    endpoint: 'https://api.example.com/v1',
    model: 'gpt-4o',
    apiKey: 'sk-test-abc123',
  };
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'headless',
      headlessFallback: fallback,
    },
  });

  const result = loadConfig({ _configFile: configFile });

  assert.equal(result.taskCore.aiMode, 'headless', 'aiMode must be preserved');
  assert.deepEqual(result.taskCore.headlessFallback, fallback,
    'fully configured headlessFallback must be returned as-is');
});

// ---------------------------------------------------------------------------
// (4) Incomplete fallback (missing apiKey) → throws ERR_CONFIG_INVALID
// ---------------------------------------------------------------------------

test('(4) headlessFallback missing apiKey → throws Error with .code === "ERR_CONFIG_INVALID"', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'headless',
      headlessFallback: {
        endpoint: 'https://api.example.com/v1',
        model: 'gpt-4o',
        // apiKey intentionally omitted
      },
    },
  });

  assert.throws(
    () => loadConfig({ _configFile: configFile }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_CONFIG_INVALID',
        `error.code must be ERR_CONFIG_INVALID; got: "${err.code}"`);
      assert.ok(
        typeof err.message === 'string' && err.message.length > 0,
        'error.message must be a non-empty string'
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (5) Config with taskCore absent → defaults applied
// ---------------------------------------------------------------------------

test('(5) config file exists but has no taskCore key → defaults applied', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    project: 'spec-flow',
    stack: 'node',
    // taskCore intentionally absent
  });

  const result = loadConfig({ _configFile: configFile });

  assert.ok(result.taskCore !== null && typeof result.taskCore === 'object',
    'taskCore must be defaulted when absent from config');
  assert.equal(result.taskCore.aiMode, 'agent-native',
    'aiMode must default to "agent-native" when taskCore is absent');
  assert.equal(result.taskCore.headlessFallback, null,
    'headlessFallback must default to null when taskCore is absent');
});

// ---------------------------------------------------------------------------
// (6) aiMode present with non-standard string → passed through (enum check
//     belongs to AIRouter, not loadConfig — per SD §9.2 BL-01 / TC-002)
// ---------------------------------------------------------------------------

test('(6) unknown aiMode string → passed through without error (enum check belongs to AIRouter)', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'some-future-mode',
    },
  });

  // loadConfig must NOT throw on an unknown aiMode — AIRouter.route validates the enum
  let result;
  assert.doesNotThrow(
    () => { result = loadConfig({ _configFile: configFile }); },
    'loadConfig must not throw on an unknown aiMode string'
  );
  assert.equal(result.taskCore.aiMode, 'some-future-mode',
    'unknown aiMode must be passed through unchanged');
});

// ---------------------------------------------------------------------------
// (7) headlessFallback = null explicitly → accepted (disables fallback)
// ---------------------------------------------------------------------------

test('(7) headlessFallback explicitly null → accepted without error', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'agent-native',
      headlessFallback: null,
    },
  });

  let result;
  assert.doesNotThrow(
    () => { result = loadConfig({ _configFile: configFile }); },
    'explicit null headlessFallback must not throw'
  );
  assert.equal(result.taskCore.headlessFallback, null,
    'explicit null headlessFallback must be returned as null');
});

// ---------------------------------------------------------------------------
// (8) Incomplete fallback (missing endpoint) → throws ERR_CONFIG_INVALID
// ---------------------------------------------------------------------------

test('(8) headlessFallback missing endpoint → throws Error with .code === "ERR_CONFIG_INVALID"', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'headless',
      headlessFallback: {
        // endpoint intentionally omitted
        model: 'gpt-4o',
        apiKey: 'sk-test-abc123',
      },
    },
  });

  assert.throws(
    () => loadConfig({ _configFile: configFile }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_CONFIG_INVALID',
        `error.code must be ERR_CONFIG_INVALID; got: "${err.code}"`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (9) Incomplete fallback (missing model) → throws ERR_CONFIG_INVALID
// ---------------------------------------------------------------------------

test('(9) headlessFallback missing model → throws Error with .code === "ERR_CONFIG_INVALID"', () => {
  const { configFile } = makeTmpConfig();
  writeConfig(configFile, {
    taskCore: {
      aiMode: 'headless',
      headlessFallback: {
        endpoint: 'https://api.example.com/v1',
        // model intentionally omitted
        apiKey: 'sk-test-abc123',
      },
    },
  });

  assert.throws(
    () => loadConfig({ _configFile: configFile }),
    (err) => {
      assert.ok(err instanceof Error, 'must be an Error instance');
      assert.equal(err.code, 'ERR_CONFIG_INVALID',
        `error.code must be ERR_CONFIG_INVALID; got: "${err.code}"`);
      return true;
    }
  );
});
