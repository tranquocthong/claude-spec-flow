/**
 * test/cutover-monitor.test.cjs — Post-cutover monitoring suite (C-6, FR-007).
 *
 * Covers:
 *   (a) monitorFeature on a healthy native engine → { feature, ok: true, checks }
 *   (b) monitorFeature with _inject._simulateMissingTool → { ok: false } with failing check surfaced
 *   (c) summarize over a mixed result set → correct total/passed/failed, allGreen false
 *   (d) summarize over all-passing results → allGreen true
 *   (e) summarize.failures lists the feature name and failedChecks names
 *   (f) summarize over empty array → { total: 0, passed: 0, failed: 0, allGreen: true, failures: [] }
 *   (g) module exports monitorFeature and summarize functions
 *
 * Tests use node:test + node:assert/strict, os.mkdtemp isolation.
 * The real .taskmaster/ and .spec-flow/ are NEVER touched.
 *
 * Run: node test/cutover-monitor.test.cjs
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

let monitorFeature;
let summarize;
test('cutover-monitor module imports without throwing', () => {
  ({ monitorFeature, summarize } = require('../lib/cutover-monitor.cjs'));
  assert.equal(typeof monitorFeature, 'function', 'monitorFeature must be a function');
  assert.equal(typeof summarize, 'function', 'summarize must be a function');
});

// ---------------------------------------------------------------------------
// Helpers — same isolation pattern as doctor-contract.test.cjs
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-monitor-test-'));
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
// (a) monitorFeature on a healthy native engine → { ok: true }
// ---------------------------------------------------------------------------

test('(a) monitorFeature returns { feature, ok: true, checks } on healthy engine', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await monitorFeature('my-feature', { _paths, _configFile });

  assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
  assert.equal(result.feature, 'my-feature', 'result.feature must be the feature name passed in');
  assert.equal(result.ok, true, `ok must be true on healthy engine; checks: ${JSON.stringify(result.checks)}`);
  assert.ok(Array.isArray(result.checks), 'result.checks must be an array');
  assert.ok(result.checks.length >= 5, `must have at least 5 checks; got ${result.checks.length}`);
});

test('(a) every check in monitorFeature result is "pass" on healthy engine', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await monitorFeature('healthy-feature', { _paths, _configFile });

  for (const check of result.checks) {
    assert.equal(
      check.status, 'pass',
      `check '${check.name}' must be pass; detail: ${check.detail}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) monitorFeature with _simulateMissingTool → { ok: false } with failing check
// ---------------------------------------------------------------------------

test('(b) monitorFeature with _simulateMissingTool=next_task → { ok: false }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await monitorFeature('bad-feature', {
    _paths,
    _configFile,
    _simulateMissingTool: 'next_task',
  });

  assert.equal(result.feature, 'bad-feature', 'result.feature must match');
  assert.equal(result.ok, false, 'ok must be false when a tool is simulated missing');
});

test('(b) monitorFeature with _simulateMissingTool → failing check is surfaced in result.checks', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  const result = await monitorFeature('bad-feature', {
    _paths,
    _configFile,
    _simulateMissingTool: 'next_task',
  });

  const failedChecks = result.checks.filter((c) => c.status === 'fail');
  assert.ok(failedChecks.length > 0, 'must have at least one failing check');

  const mcpFail = failedChecks.find((c) => c.name.includes('mcp') || c.name.includes('tool-surface'));
  assert.ok(mcpFail, 'the failing check must be the mcp-tool-surface check');
  assert.ok(
    mcpFail.detail.includes('next_task'),
    `failing check detail must mention next_task; got: ${mcpFail.detail}`,
  );
});

// ---------------------------------------------------------------------------
// (c) summarize over a mixed result set → correct totals, allGreen false
// ---------------------------------------------------------------------------

test('(c) summarize over mixed results → correct total/passed/failed, allGreen false', () => {
  const results = [
    {
      feature: 'feat-a',
      ok: true,
      checks: [
        { name: 'mcp-tool-surface', status: 'pass', detail: 'ok' },
        { name: 'cli-subcommands', status: 'pass', detail: 'ok' },
      ],
    },
    {
      feature: 'feat-b',
      ok: false,
      checks: [
        { name: 'mcp-tool-surface', status: 'fail', detail: 'tools missing: next_task' },
        { name: 'cli-subcommands', status: 'pass', detail: 'ok' },
      ],
    },
  ];

  const summary = summarize(results);

  assert.equal(summary.total, 2, 'total must be 2');
  assert.equal(summary.passed, 1, 'passed must be 1');
  assert.equal(summary.failed, 1, 'failed must be 1');
  assert.equal(summary.allGreen, false, 'allGreen must be false when any feature failed');
});

// ---------------------------------------------------------------------------
// (d) summarize over all-passing results → allGreen true
// ---------------------------------------------------------------------------

test('(d) summarize over all-passing results → allGreen true', () => {
  const results = [
    {
      feature: 'feat-x',
      ok: true,
      checks: [{ name: 'mcp-tool-surface', status: 'pass', detail: 'ok' }],
    },
    {
      feature: 'feat-y',
      ok: true,
      checks: [{ name: 'cli-subcommands', status: 'pass', detail: 'ok' }],
    },
  ];

  const summary = summarize(results);

  assert.equal(summary.total, 2, 'total must be 2');
  assert.equal(summary.passed, 2, 'passed must be 2');
  assert.equal(summary.failed, 0, 'failed must be 0');
  assert.equal(summary.allGreen, true, 'allGreen must be true when all features passed');
  assert.deepEqual(summary.failures, [], 'failures must be empty array when allGreen');
});

// ---------------------------------------------------------------------------
// (e) summarize.failures lists feature name and failedChecks names
// ---------------------------------------------------------------------------

test('(e) summarize.failures lists feature name and failedChecks check names', () => {
  const results = [
    {
      feature: 'feat-ok',
      ok: true,
      checks: [
        { name: 'mcp-tool-surface', status: 'pass', detail: 'ok' },
        { name: 'cli-subcommands', status: 'pass', detail: 'ok' },
      ],
    },
    {
      feature: 'feat-broken',
      ok: false,
      checks: [
        { name: 'mcp-tool-surface', status: 'fail', detail: 'tools missing: get_task' },
        { name: 'cli-subcommands', status: 'pass', detail: 'ok' },
        { name: 'models-shim', status: 'fail', detail: 'exited with code 1' },
      ],
    },
  ];

  const summary = summarize(results);

  assert.equal(summary.failures.length, 1, 'failures must have 1 entry for the failed feature');
  const failure = summary.failures[0];
  assert.equal(failure.feature, 'feat-broken', 'failure.feature must be the failed feature name');
  assert.ok(Array.isArray(failure.failedChecks), 'failedChecks must be an array');
  assert.ok(failure.failedChecks.includes('mcp-tool-surface'), 'failedChecks must include mcp-tool-surface');
  assert.ok(failure.failedChecks.includes('models-shim'), 'failedChecks must include models-shim');
  assert.ok(!failure.failedChecks.includes('cli-subcommands'), 'cli-subcommands must NOT be in failedChecks (it passed)');
});

test('(e) summarize.failures is empty array when no features failed', () => {
  const results = [
    {
      feature: 'feat-a',
      ok: true,
      checks: [{ name: 'mcp-tool-surface', status: 'pass', detail: 'ok' }],
    },
  ];

  const summary = summarize(results);

  assert.deepEqual(summary.failures, [], 'failures must be [] when no features failed');
});

// ---------------------------------------------------------------------------
// (f) summarize over empty array
// ---------------------------------------------------------------------------

test('(f) summarize over empty array → { total: 0, passed: 0, failed: 0, allGreen: true, failures: [] }', () => {
  const summary = summarize([]);

  assert.equal(summary.total, 0, 'total must be 0 for empty input');
  assert.equal(summary.passed, 0, 'passed must be 0 for empty input');
  assert.equal(summary.failed, 0, 'failed must be 0 for empty input');
  assert.equal(summary.allGreen, true, 'allGreen must be true for empty input (vacuously true)');
  assert.deepEqual(summary.failures, [], 'failures must be [] for empty input');
});

// ---------------------------------------------------------------------------
// (g) module exports monitorFeature and summarize — already checked at top but explicit here
// ---------------------------------------------------------------------------

test('(g) monitorFeature passes _inject through to runContractCheck (result has checks array)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  // Passing _inject with valid paths means runContractCheck receives isolation — result must have checks
  const result = await monitorFeature('inject-test', { _paths, _configFile });

  assert.ok(Array.isArray(result.checks), 'checks must be an array when _inject is passed through');
  assert.ok(result.checks.length > 0, 'checks must be non-empty when _inject is passed through');

  // Verify each check has the expected shape from runContractCheck
  for (const check of result.checks) {
    assert.ok(typeof check.name === 'string', `check.name must be a string; got ${typeof check.name}`);
    assert.ok(
      check.status === 'pass' || check.status === 'fail',
      `check.status must be 'pass' or 'fail'; got ${check.status}`,
    );
    assert.ok(typeof check.detail === 'string', `check.detail must be a string; got ${typeof check.detail}`);
  }
});
