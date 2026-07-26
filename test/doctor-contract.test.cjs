/**
 * test/doctor-contract.test.cjs — TC-008 and TC-009: post-flip contract checker.
 *
 * TC-008: healthy native engine → runContractCheck returns { ok: true },
 *         every check 'pass', covering all 5 §9.4 categories.
 *
 * TC-009: _simulateMissingTool: 'next_task' → { ok: false }, the
 *         mcp-tool-surface check is 'fail' and mentions the missing tool;
 *         all other checks remain 'pass'.
 *
 * Each test uses os.mkdtemp isolation; the real .taskmaster/ and .spec-flow/
 * are NEVER touched.
 *
 * Run: node test/doctor-contract.test.cjs
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

let runContractCheck;
test('doctor-contract module imports without throwing', () => {
  ({ runContractCheck } = require('../lib/doctor-contract.cjs'));
  assert.equal(typeof runContractCheck, 'function', 'runContractCheck must be a function');
});

// ---------------------------------------------------------------------------
// Helpers — same isolation pattern as mcp-server.test.cjs
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-contract-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

function makeConfigFile(tmpDir) {
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ taskCore: { engine: 'native' } }), 'utf8');
  return configFile;
}

// ---------------------------------------------------------------------------
// TC-008: healthy native engine — all checks pass
// ---------------------------------------------------------------------------

test('TC-008: healthy native engine returns { ok: true }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
  assert.equal(result.ok, true, `ok must be true when all checks pass; checks: ${JSON.stringify(result.checks)}`);
});

test('TC-008: every check is "pass" on healthy engine', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  assert.ok(Array.isArray(result.checks), 'checks must be an array');

  for (const check of result.checks) {
    assert.equal(
      check.status, 'pass',
      `check '${check.name}' must be pass; detail: ${check.detail}`,
    );
  }
});

test('TC-008: result.checks has at least 5 entries covering the 5 §9.4 categories', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  assert.ok(result.checks.length >= 5, `must have at least 5 checks; got ${result.checks.length}`);

  // Each check entry has the required shape: { name: string, status: 'pass'|'fail', detail: string }
  for (const check of result.checks) {
    assert.equal(typeof check.name, 'string', 'check.name must be a string');
    assert.ok(
      check.status === 'pass' || check.status === 'fail',
      `check.status must be "pass" or "fail"; got ${JSON.stringify(check.status)}`,
    );
    assert.equal(typeof check.detail, 'string', 'check.detail must be a string');
  }
});

test('TC-008: mcp-tool-surface check passes (5 tools registered and callable)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  const mcpCheck = result.checks.find((c) => c.name.includes('mcp') || c.name.includes('tool-surface'));
  assert.ok(mcpCheck, 'must have an mcp-tool-surface check; names: ' + result.checks.map((c) => c.name).join(', '));
  assert.equal(mcpCheck.status, 'pass', `mcp-tool-surface must pass; detail: ${mcpCheck.detail}`);
});

test('TC-008: cli-subcommands check passes (all 10 subcommands registered)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  const cliCheck = result.checks.find((c) => c.name.includes('cli') || c.name.includes('subcommand'));
  assert.ok(cliCheck, 'must have a cli-subcommands check; names: ' + result.checks.map((c) => c.name).join(', '));
  assert.equal(cliCheck.status, 'pass', `cli-subcommands must pass; detail: ${cliCheck.detail}`);
});

test('TC-008: models-shim check passes (models --set-main sonnet --claude-code exits 0)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  const modelsCheck = result.checks.find((c) => c.name.includes('models'));
  assert.ok(modelsCheck, 'must have a models-shim check; names: ' + result.checks.map((c) => c.name).join(', '));
  assert.equal(modelsCheck.status, 'pass', `models-shim must pass; detail: ${modelsCheck.detail}`);
});

test('TC-008: tasks-json-round-trip check passes (add task then read back, schema valid)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  const roundTripCheck = result.checks.find(
    (c) => c.name.includes('round-trip') || c.name.includes('roundtrip'),
  );
  assert.ok(
    roundTripCheck,
    'must have a tasks-json-round-trip check; names: ' + result.checks.map((c) => c.name).join(', '),
  );
  assert.equal(roundTripCheck.status, 'pass', `round-trip must pass; detail: ${roundTripCheck.detail}`);
});

test('TC-008: response-shapes check passes (get_tasks has { tasks, stats } with all 7 byStatus keys)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile });

  const shapesCheck = result.checks.find(
    (c) => c.name.includes('response') || c.name.includes('shape'),
  );
  assert.ok(
    shapesCheck,
    'must have a response-shapes check; names: ' + result.checks.map((c) => c.name).join(', '),
  );
  assert.equal(shapesCheck.status, 'pass', `response-shapes must pass; detail: ${shapesCheck.detail}`);
});

// ---------------------------------------------------------------------------
// TC-009: _simulateMissingTool → ok=false, mcp-tool-surface check fails
// ---------------------------------------------------------------------------

test('TC-009: _simulateMissingTool=next_task → { ok: false }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile, _simulateMissingTool: 'next_task' });

  assert.equal(result.ok, false, 'ok must be false when a tool is simulated-missing');
});

test('TC-009: _simulateMissingTool=next_task → mcp-tool-surface check is "fail" with next_task in detail', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile, _simulateMissingTool: 'next_task' });

  const mcpCheck = result.checks.find((c) => c.name.includes('mcp') || c.name.includes('tool-surface'));
  assert.ok(mcpCheck, 'must have an mcp-tool-surface check');
  assert.equal(mcpCheck.status, 'fail', `mcp-tool-surface must be fail when next_task is simulated missing`);
  assert.ok(
    mcpCheck.detail.includes('next_task'),
    `detail must mention the missing tool "next_task"; got: ${mcpCheck.detail}`,
  );
});

test('TC-009: _simulateMissingTool=next_task → non-mcp checks still pass', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile, _simulateMissingTool: 'next_task' });

  const mcpCheck = result.checks.find((c) => c.name.includes('mcp') || c.name.includes('tool-surface'));
  const otherChecks = result.checks.filter((c) => c !== mcpCheck);

  assert.ok(otherChecks.length > 0, 'must have non-mcp checks');
  for (const check of otherChecks) {
    assert.equal(
      check.status, 'pass',
      `non-mcp check '${check.name}' must still pass when next_task is simulated missing; detail: ${check.detail}`,
    );
  }
});

test('TC-009: _simulateMissingTool=set_task_status → mcp check fails mentioning set_task_status', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await runContractCheck({ _paths, _configFile, _simulateMissingTool: 'set_task_status' });

  assert.equal(result.ok, false, 'ok must be false');

  const mcpCheck = result.checks.find((c) => c.name.includes('mcp') || c.name.includes('tool-surface'));
  assert.ok(mcpCheck, 'must have an mcp-tool-surface check');
  assert.equal(mcpCheck.status, 'fail', 'mcp check must be fail');
  assert.ok(
    mcpCheck.detail.includes('set_task_status'),
    `detail must mention set_task_status; got: ${mcpCheck.detail}`,
  );
});
