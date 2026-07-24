/**
 * Unit tests for lib/cli-dispatcher.cjs — CLI subcommand dispatcher.
 *
 * Covers SD §9.3 CLI Subcommand Contract cases:
 *   (a) use-tag <tagName>: writes state.json + exits 0
 *   (b) parse-prd missing --input: exits 1 with usage message on stderr
 *   (c) init --yes: idempotent (exits 0 on first and second call)
 *   (d) update-task --id --prompt: calls updateTask and exits 0
 *   (e) AI op with engine=native: prints ERR_AI_HOST_REQUIRED to stderr, exits 1
 *   (f) models (any flags): exits 0 always (no-op shim)
 *   (g) native error ERR_TASK_NOT_FOUND: printed to stderr, exits 1
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths and
 * _configFile so the real .taskmaster/ and .spec-flow/ are NEVER touched.
 *
 * Run:  node test/cli-dispatcher.test.cjs
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

let runCli;
test('cli-dispatcher module imports without throwing', () => {
  ({ runCli } = require('../lib/cli-dispatcher.cjs'));
  assert.equal(typeof runCli, 'function', 'runCli must be a function');
});

// ---------------------------------------------------------------------------
// Helpers — each test gets its own isolated tmp directory
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dispatcher-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Write a .spec-flow/config.json with the given engine value and return its path.
 */
function makeConfigFile(tmpDir, engineValue) {
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  const config = { taskCore: { engine: engineValue } };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  return configFile;
}

/**
 * Seed tasks.json with a single tag containing one task.
 */
function seedTask(tasksFile, tag, task) {
  const dir = path.dirname(tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const data = {};
  data[tag] = { tasks: [task], metadata: {} };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
  return task;
}

// ---------------------------------------------------------------------------
// (a) use-tag <tagName>: writes state.json + exits 0
// ---------------------------------------------------------------------------

test('(a) use-tag feat-x: writes currentTag to state.json and exits 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['use-tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 0, 'use-tag must exit 0');
  // Verify state.json was actually written with the correct currentTag
  const state = JSON.parse(fs.readFileSync(_paths.stateFile, 'utf8'));
  assert.equal(state.currentTag, 'feat-x', 'state.json must record currentTag=feat-x');
});

test('(a) use-tag missing tagName: exits 1 with usage message on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['use-tag'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'use-tag with missing tagName must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must contain usage info');
});

// ---------------------------------------------------------------------------
// (b) parse-prd missing --input: exits 1 with usage message on stderr
// ---------------------------------------------------------------------------

test('(b) parse-prd missing --input: exits 1 with usage on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // --tag is present but --input is missing
  const result = await runCli(['parse-prd', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'missing --input must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must be non-empty');
  assert.ok(
    result.stderr.toLowerCase().includes('input') || result.stderr.toLowerCase().includes('usage'),
    `stderr must mention "input" or "usage"; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (c) init --yes: idempotent — exits 0 on first and second invocation
// ---------------------------------------------------------------------------

test('(c) init --yes: exits 0 on first call', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['init', '--yes'], { _configFile, _paths });

  assert.equal(result.exitCode, 0, 'init --yes must exit 0 on first call');
});

test('(c) init --yes: exits 0 on second call (idempotent)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // First init
  await runCli(['init', '--yes'], { _configFile, _paths });
  // Second init — must also succeed
  const result2 = await runCli(['init', '--yes'], { _configFile, _paths });

  assert.equal(result2.exitCode, 0, 'second init call must also exit 0 (idempotent)');
});

// ---------------------------------------------------------------------------
// (d) update-task --id --tag --prompt: calls updateTask and exits 0
// ---------------------------------------------------------------------------

test('(d) update-task --id --tag --prompt: updates task notes and exits 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'feat-x', {
    id: '1',
    title: 'Task for update',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    description: 'original',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await runCli(
    ['update-task', '--id', '1', '--tag', 'feat-x', '--prompt', 'new notes here'],
    { _configFile, _paths }
  );

  assert.equal(result.exitCode, 0, 'update-task with valid args must exit 0');
  // Verify the task was updated in tasks.json
  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task = data['feat-x'].tasks.find((t) => t.id === '1');
  assert.ok(task, 'task must still exist in tasks.json');
  assert.equal(task.notes, 'new notes here', 'task.notes must be set to --prompt value');
});

test('(d) update-task missing --id: exits 1 with usage on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['update-task', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'missing --id must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must contain usage info');
});

// ---------------------------------------------------------------------------
// (e) AI op with engine=native: prints ERR_AI_HOST_REQUIRED to stderr, exits 1
// ---------------------------------------------------------------------------

test('(e) parse-prd with engine=native: ERR_AI_HOST_REQUIRED on stderr and exits 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(
    ['parse-prd', '--input', 'spec.md', '--tag', 'feat-x'],
    { _configFile, _paths }
  );

  assert.equal(result.exitCode, 1, 'AI op must exit 1 when ai-hybrid is absent');
  assert.ok(
    result.stderr.includes('ERR_AI_HOST_REQUIRED'),
    `stderr must contain ERR_AI_HOST_REQUIRED; got: ${result.stderr}`
  );
});

test('(e) analyze-complexity with engine=native: ERR_AI_HOST_REQUIRED on stderr and exits 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['analyze-complexity', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'AI op must exit 1');
  assert.ok(
    result.stderr.includes('ERR_AI_HOST_REQUIRED'),
    `stderr must contain ERR_AI_HOST_REQUIRED; got: ${result.stderr}`
  );
});

test('(e) expand missing --id: exits 1 with usage on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['expand', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'expand missing --id must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must contain error info');
});

test('(e) expand with engine=native: ERR_AI_HOST_REQUIRED on stderr and exits 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['expand', '--id', '1', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'AI op must exit 1');
  assert.ok(
    result.stderr.includes('ERR_AI_HOST_REQUIRED'),
    `stderr must contain ERR_AI_HOST_REQUIRED; got: ${result.stderr}`
  );
});

test('(e) research with engine=native: ERR_AI_HOST_REQUIRED on stderr and exits 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['research', 'how to do X', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'AI op must exit 1');
  assert.ok(
    result.stderr.includes('ERR_AI_HOST_REQUIRED'),
    `stderr must contain ERR_AI_HOST_REQUIRED; got: ${result.stderr}`
  );
});

test('(e) update with engine=native: ERR_AI_HOST_REQUIRED on stderr and exits 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['update', '--from', '1', '--tag', 'feat-x'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'AI op must exit 1');
  assert.ok(
    result.stderr.includes('ERR_AI_HOST_REQUIRED'),
    `stderr must contain ERR_AI_HOST_REQUIRED; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (f) models (any flags): exits 0 always (no-op shim, TODO task-5)
// ---------------------------------------------------------------------------

test('(f) models --set-main <model>: exits 0 (no-op)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(
    ['models', '--set-main', 'claude-3-5-sonnet'],
    { _configFile, _paths }
  );

  assert.equal(result.exitCode, 0, 'models must exit 0 always (no-op)');
});

test('(f) models --set-research <model>: exits 0 (no-op)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(
    ['models', '--set-research', 'perplexity-sonar'],
    { _configFile, _paths }
  );

  assert.equal(result.exitCode, 0, 'models must exit 0 always');
});

test('(f) models --claude-code: exits 0 (no-op)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['models', '--claude-code'], { _configFile, _paths });

  assert.equal(result.exitCode, 0, 'models with --claude-code must exit 0');
});

test('(f) models with no flags: exits 0 (no-op)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['models'], { _configFile, _paths });

  assert.equal(result.exitCode, 0, 'models with no flags must exit 0');
});

// ---------------------------------------------------------------------------
// (g) native error ERR_TASK_NOT_FOUND: printed to stderr, exits 1
// ---------------------------------------------------------------------------

test('(g) update-task nonexistent id: ERR_TASK_NOT_FOUND on stderr and exits 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Seed an empty tag so update-task can proceed to the native core
  const dir = path.dirname(_paths.tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const data = { 'feat-x': { tasks: [], metadata: {} } };
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const result = await runCli(
    ['update-task', '--id', '999', '--tag', 'feat-x'],
    { _configFile, _paths }
  );

  assert.equal(result.exitCode, 1, 'missing task must exit 1');
  assert.ok(
    result.stderr.includes('ERR_TASK_NOT_FOUND'),
    `stderr must contain ERR_TASK_NOT_FOUND; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (h) unknown subcommand: exits 1 with helpful message
// ---------------------------------------------------------------------------

test('(h) unknown subcommand: exits 1 with error on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(['unknown-cmd'], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'unknown subcommand must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must contain error info');
});

test('(h) no subcommand: exits 1 with usage on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli([], { _configFile, _paths });

  assert.equal(result.exitCode, 1, 'no subcommand must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must contain usage info');
});
