/**
 * Unit tests for lib/models-shim.cjs — models no-op shim.
 *
 * Covers FR-015 (SD §9.3 models subcommand contract, decision D2):
 *   (1) --set-main X --claude-code → exit 0 + logs to stderr
 *   (2) --set-research X --claude-code → exit 0
 *   (3) --set-fallback X (no --claude-code) → exit 0
 *   (4) NO flags → exit 0
 *   (5) config.json exists → models.main/research/fallback written correctly
 *   (6) config.json missing → no error, exit 0
 *   (7) 20 sequential invocations all exit 0 (dance stability)
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _configFile
 * so the real .taskmaster/config.json is NEVER touched.
 *
 * Run:  node test/models-shim.test.cjs
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

let runModels;
test('models-shim module imports without throwing', () => {
  ({ runModels } = require('../lib/models-shim.cjs'));
  assert.equal(typeof runModels, 'function', 'runModels must be a function');
});

// ---------------------------------------------------------------------------
// Helpers — each test gets its own isolated tmp directory
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'models-shim-test-'));
}

/**
 * Write a .taskmaster/config.json in the given dir and return the path.
 * content is the JS object to serialize.
 */
function makeTaskmasterConfig(tmpDir, content) {
  const configDir = path.join(tmpDir, '.taskmaster');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(content, null, 2), 'utf8');
  return configFile;
}

// ---------------------------------------------------------------------------
// (1) --set-main X --claude-code → exit 0 + logs to stderr
// ---------------------------------------------------------------------------

test('(1) --set-main X --claude-code: exits 0 and logs to stderr', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels(
    ['--set-main', 'claude-3-5-sonnet', '--claude-code'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, '--set-main --claude-code must exit 0');
  assert.ok(
    typeof result.stderr === 'string' && result.stderr.length > 0,
    'stderr must be non-empty (log output expected)'
  );
  assert.ok(
    result.stderr.includes('models shim: no-op'),
    `stderr must contain "models shim: no-op"; got: ${result.stderr}`
  );
  assert.ok(
    result.stderr.includes('--set-main'),
    `stderr must mention --set-main; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (2) --set-research X --claude-code → exit 0
// ---------------------------------------------------------------------------

test('(2) --set-research X --claude-code: exits 0', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels(
    ['--set-research', 'perplexity-sonar', '--claude-code'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, '--set-research --claude-code must exit 0');
  assert.ok(
    result.stderr.includes('--set-research'),
    `stderr must mention --set-research; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (3) --set-fallback X (no --claude-code) → exit 0
// ---------------------------------------------------------------------------

test('(3) --set-fallback X without --claude-code: exits 0', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels(
    ['--set-fallback', 'claude-haiku'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, '--set-fallback must exit 0');
  assert.ok(
    result.stderr.includes('--set-fallback'),
    `stderr must mention --set-fallback; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (4) NO flags → exit 0
// ---------------------------------------------------------------------------

test('(4) no flags: exits 0', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels([], { _configFile: configFile });

  assert.equal(result.exitCode, 0, 'no-flag invocation must exit 0');
  assert.ok(
    typeof result.stdout === 'string',
    'stdout must be a string'
  );
  assert.ok(
    typeof result.stderr === 'string',
    'stderr must be a string'
  );
});

// ---------------------------------------------------------------------------
// (5) config.json exists → models.main/research/fallback written correctly
// ---------------------------------------------------------------------------

test('(5) config.json exists: --set-main updates models.main', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {}, global: { logLevel: 'info' } });

  const result = await runModels(
    ['--set-main', 'claude-3-opus'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, 'must exit 0');
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.models.main, 'claude-3-opus', 'models.main must be set');
  // Other fields must be preserved
  assert.equal(written.global.logLevel, 'info', 'other config fields must be preserved');
});

test('(5) config.json exists: --set-research updates models.research', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels(
    ['--set-research', 'perplexity-sonar-pro'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, 'must exit 0');
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.models.research, 'perplexity-sonar-pro', 'models.research must be set');
});

test('(5) config.json exists: --set-fallback updates models.fallback', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels(
    ['--set-fallback', 'claude-haiku-3-5'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, 'must exit 0');
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.models.fallback, 'claude-haiku-3-5', 'models.fallback must be set');
});

test('(5) config.json exists: all three --set-* flags write all three fields', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const result = await runModels(
    ['--set-main', 'main-model', '--set-research', 'research-model', '--set-fallback', 'fallback-model'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, 'must exit 0');
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.models.main, 'main-model', 'models.main must be set');
  assert.equal(written.models.research, 'research-model', 'models.research must be set');
  assert.equal(written.models.fallback, 'fallback-model', 'models.fallback must be set');
});

test('(5) config.json exists: no models key initially — creates it', async () => {
  const tmpDir = makeTmpDir();
  // Config with no models key
  const configFile = makeTaskmasterConfig(tmpDir, { global: { logLevel: 'debug' } });

  const result = await runModels(
    ['--set-main', 'my-main'],
    { _configFile: configFile }
  );

  assert.equal(result.exitCode, 0, 'must exit 0');
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.models.main, 'my-main', 'models.main must be created');
  assert.equal(written.global.logLevel, 'debug', 'other fields must be preserved');
});

// ---------------------------------------------------------------------------
// (6) config.json missing → no error, exit 0
// ---------------------------------------------------------------------------

test('(6) config.json missing: silently skips, exits 0', async () => {
  const tmpDir = makeTmpDir();
  // Point to a non-existent file
  const configFile = path.join(tmpDir, 'does-not-exist', 'config.json');

  let result;
  try {
    result = await runModels(
      ['--set-main', 'some-model'],
      { _configFile: configFile }
    );
  } catch (err) {
    assert.fail(`runModels must never throw; got error: ${err.message}`);
  }

  assert.equal(result.exitCode, 0, 'missing config must exit 0 (no error)');
});

test('(6) no _inject at all: exits 0 (default config path, which does not exist in test)', async () => {
  // No inject — will use default .taskmaster/config.json relative to cwd.
  // In the worktree, this file may or may not exist, but either way must exit 0.
  const result = await runModels(['--set-main', 'some-model']);
  assert.equal(result.exitCode, 0, 'no inject must still exit 0');
});

// ---------------------------------------------------------------------------
// (7) 20 sequential invocations all exit 0 (dance stability)
// ---------------------------------------------------------------------------

test('(7) 20 sequential invocations (dance stability): all exit 0', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTaskmasterConfig(tmpDir, { models: {} });

  const argSets = [
    ['--set-main', 'claude-3-5-sonnet', '--claude-code'],
    ['--set-research', 'perplexity-sonar', '--claude-code'],
    ['--set-fallback', 'claude-haiku', '--claude-code'],
    [],
    ['--set-main', 'model-a'],
    ['--set-research', 'model-b'],
    ['--set-fallback', 'model-c'],
    ['--claude-code'],
    ['--set-main', 'model-d', '--set-research', 'model-e'],
    ['--set-main', 'x', '--set-research', 'y', '--set-fallback', 'z', '--claude-code'],
    ['--set-main', 'claude-3-5-sonnet', '--claude-code'],
    ['--set-research', 'perplexity-sonar', '--claude-code'],
    ['--set-fallback', 'claude-haiku'],
    [],
    ['--set-main', 'model-f'],
    ['--set-research', 'model-g'],
    ['--set-fallback', 'model-h'],
    ['--claude-code'],
    ['--set-main', 'final-main', '--set-fallback', 'final-fallback'],
    ['--set-main', 'last', '--set-research', 'last-r', '--set-fallback', 'last-f'],
  ];

  assert.equal(argSets.length, 20, 'must have 20 arg sets');

  for (let i = 0; i < argSets.length; i++) {
    const result = await runModels(argSets[i], { _configFile: configFile });
    assert.equal(
      result.exitCode,
      0,
      `invocation ${i + 1}/20 must exit 0; got exitCode=${result.exitCode}, stderr=${result.stderr}`
    );
  }

  // Final state check: last writes should be persisted
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.models.main, 'last', 'models.main must be last written value');
  assert.equal(written.models.research, 'last-r', 'models.research must be last written value');
  assert.equal(written.models.fallback, 'last-f', 'models.fallback must be last written value');
});
