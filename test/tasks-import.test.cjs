/**
 * Unit tests for the `tasks-import` subcommand in lib/cli-dispatcher.cjs.
 *
 * Covers FR-012 (agent-native import protocol, Phase 3):
 *   (a) Import from --file: 3-task valid array → tasks written, {imported:3}, exit 0.
 *   (b) Import via _inject._stdin: same result using stdin injection (no real stdin block).
 *   (c) Schema-invalid batch: one task missing title → exit 1, stderr contains
 *       ERR_AI_SCHEMA_INVALID, tasks.json byte-identical before and after (reject-entire-batch).
 *   (d) Status normalization: input status 'done' → stored 'pending' (D4, FR-004).
 *   (e) Non-array JSON → exit 1, stderr contains clear error message.
 *   (f) Invalid JSON → exit 1, stderr contains clear error message.
 *   (g) Missing --tag → exit 1 with usage.
 *
 * Each test uses mkdtemp isolation + injected _paths; never touches real .taskmaster/.
 *
 * Run: node test/tasks-import.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module import — RED phase: handler is not registered yet → subcommand will
// be unknown and return ERR_UNKNOWN_SUBCOMMAND / exit 1.
// ---------------------------------------------------------------------------

let runCli;
test('cli-dispatcher module imports without throwing', () => {
  ({ runCli } = require('../lib/cli-dispatcher.cjs'));
  assert.equal(typeof runCli, 'function', 'runCli must be a function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-import-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Build a fully valid task object satisfying validateTaskSchema requirements.
 */
function makeValidTask(overrides) {
  return Object.assign(
    {
      id: '1',
      title: 'Test task title',
      description: 'A test task description.',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      subtasks: [],
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    overrides
  );
}

/**
 * Write a task JSON file to a temp path and return the file path.
 */
function writeTaskFile(tmpDir, tasks) {
  const filePath = path.join(tmpDir, 'tasks.json');
  fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2), 'utf8');
  return filePath;
}

/**
 * Read the tasks for a given tag from the tasks.json in the injected _paths.
 */
function readStoredTasks(tasksFile, tag) {
  const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  return data[tag] ? data[tag].tasks : [];
}

// ---------------------------------------------------------------------------
// (a) Import from --file: 3 valid tasks → {imported:3}, exit 0
// ---------------------------------------------------------------------------

test('(a) tasks-import --file with 3 valid tasks: exits 0 and reports {imported:3}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const tasks = [
    makeValidTask({ id: '1', title: 'Task alpha' }),
    makeValidTask({ id: '2', title: 'Task beta' }),
    makeValidTask({ id: '3', title: 'Task gamma' }),
  ];
  const filePath = writeTaskFile(tmpDir, tasks);

  const result = await runCli(
    ['tasks-import', '--tag', 'feat', '--file', filePath],
    { _paths }
  );

  assert.equal(result.exitCode, 0, 'must exit 0 on valid import');
  assert.equal(result.stderr, '', 'stderr must be empty on success');

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.imported, 3, 'stdout must report imported:3');

  const stored = readStoredTasks(_paths.tasksFile, 'feat');
  assert.equal(stored.length, 3, 'tasks.json must have 3 tasks for the tag');
});

// ---------------------------------------------------------------------------
// (b) Import via _inject._stdin: same result without blocking on real stdin
// ---------------------------------------------------------------------------

test('(b) tasks-import via _inject._stdin: exits 0 and reports {imported:2}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const tasks = [
    makeValidTask({ id: '10', title: 'Stdin task one' }),
    makeValidTask({ id: '11', title: 'Stdin task two' }),
  ];
  const stdinContent = JSON.stringify(tasks);

  const result = await runCli(
    ['tasks-import', '--tag', 'feat'],
    { _paths, _stdin: stdinContent }
  );

  assert.equal(result.exitCode, 0, 'must exit 0 when using stdin injection');
  assert.equal(result.stderr, '', 'stderr must be empty');

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.imported, 2, 'stdout must report imported:2');

  const stored = readStoredTasks(_paths.tasksFile, 'feat');
  assert.equal(stored.length, 2, 'tasks.json must have 2 tasks for the tag');
});

// ---------------------------------------------------------------------------
// (c) Schema-invalid batch: tasks.json must be unchanged (reject-entire-batch)
// ---------------------------------------------------------------------------

test('(c) schema-invalid batch: exit 1, stderr has ERR_AI_SCHEMA_INVALID, file unchanged', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Pre-populate tasks.json with existing content so we can verify it's unchanged.
  const dir = path.dirname(_paths.tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const original = { feat: { tasks: [makeValidTask({ id: '99', title: 'Original' })], metadata: {} } };
  const originalJson = JSON.stringify(original, null, 2);
  fs.writeFileSync(_paths.tasksFile, originalJson, 'utf8');

  // One valid task + one missing 'title' → entire batch must be rejected.
  const tasks = [
    makeValidTask({ id: '1', title: 'Valid task' }),
    { id: '2', description: 'No title here', status: 'pending', priority: 'medium',
      dependencies: [], subtasks: [], updatedAt: '2026-07-26T00:00:00.000Z' },
  ];
  const stdinContent = JSON.stringify(tasks);

  const result = await runCli(
    ['tasks-import', '--tag', 'feat'],
    { _paths, _stdin: stdinContent }
  );

  assert.equal(result.exitCode, 1, 'must exit 1 for schema-invalid batch');
  assert.ok(
    result.stderr.includes('ERR_AI_SCHEMA_INVALID'),
    `stderr must contain ERR_AI_SCHEMA_INVALID; got: ${result.stderr}`
  );
  // Hint line for schema errors
  assert.ok(
    result.stderr.toLowerCase().includes('fix') || result.stderr.toLowerCase().includes('retry'),
    `stderr must contain a hint to fix and retry; got: ${result.stderr}`
  );

  // tasks.json must be byte-identical to the original (reject-entire-batch, D3)
  const afterJson = fs.readFileSync(_paths.tasksFile, 'utf8');
  assert.equal(afterJson, originalJson, 'tasks.json must be byte-identical after rejected batch');
});

// ---------------------------------------------------------------------------
// (d) Status normalization: input status 'done' → stored 'pending'
// ---------------------------------------------------------------------------

test('(d) status normalization: input status "done" is stored as "pending"', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const tasks = [
    makeValidTask({ id: '5', title: 'Was done', status: 'done' }),
    makeValidTask({ id: '6', title: 'Was in-progress', status: 'in-progress' }),
  ];
  const stdinContent = JSON.stringify(tasks);

  const result = await runCli(
    ['tasks-import', '--tag', 'feat'],
    { _paths, _stdin: stdinContent }
  );

  assert.equal(result.exitCode, 0, 'must exit 0 after normalization');

  const stored = readStoredTasks(_paths.tasksFile, 'feat');
  assert.equal(stored.length, 2, 'must have 2 stored tasks');
  for (const t of stored) {
    assert.equal(t.status, 'pending', `task ${t.id} status must be normalized to 'pending'`);
  }
});

// ---------------------------------------------------------------------------
// (e) Non-array JSON → exit 1
// ---------------------------------------------------------------------------

test('(e) non-array JSON input: exit 1 with clear error on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const result = await runCli(
    ['tasks-import', '--tag', 'feat'],
    { _paths, _stdin: JSON.stringify({ not: 'an array' }) }
  );

  assert.equal(result.exitCode, 1, 'non-array must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must be non-empty');
  assert.ok(
    result.stderr.toLowerCase().includes('array'),
    `stderr must mention "array"; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (f) Invalid JSON → exit 1
// ---------------------------------------------------------------------------

test('(f) invalid JSON input: exit 1 with clear error on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const result = await runCli(
    ['tasks-import', '--tag', 'feat'],
    { _paths, _stdin: 'this is not json {{' }
  );

  assert.equal(result.exitCode, 1, 'invalid JSON must exit 1');
  assert.ok(result.stderr.length > 0, 'stderr must be non-empty');
  assert.ok(
    result.stderr.toLowerCase().includes('array'),
    `stderr must mention "array"; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// (g) Missing --tag → exit 1 with usage
// ---------------------------------------------------------------------------

test('(g) missing --tag: exit 1 with usage message on stderr', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const result = await runCli(
    ['tasks-import', '--file', '/any/path'],
    { _paths }
  );

  assert.equal(result.exitCode, 1, 'missing --tag must exit 1');
  assert.ok(
    result.stderr.toLowerCase().includes('tag') || result.stderr.toLowerCase().includes('usage'),
    `stderr must mention "tag" or "usage"; got: ${result.stderr}`
  );
});
