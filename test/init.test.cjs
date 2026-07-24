/**
 * Unit tests for lib/init.cjs — idempotent .taskmaster/ scaffold.
 *
 * Covers FR-014 / TC-012 (SD §9.3 init subcommand contract):
 *   (1) init --yes in an empty dir: creates .taskmaster/ with tasks/tasks.json,
 *       state.json, config.json, and exits 0.
 *   (2) second init --yes in same dir: stdout = "Already initialized", exits 0 (idempotent).
 *   (3) init WITHOUT --yes: also exits 0 (--yes only means non-interactive).
 *   (4) directory layout: .taskmaster/tasks/ and .taskmaster/reports/ subdirs exist.
 *
 * Each test uses its own os.mkdtemp-isolated directory — the REAL repo is never
 * touched (no file is written outside the test tmp dir).
 *
 * Run:  node test/init.test.cjs
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

let runInit;
test('init module imports without throwing', () => {
  ({ runInit } = require('../lib/init.cjs'));
  assert.equal(typeof runInit, 'function', 'runInit must be a function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
}

// ---------------------------------------------------------------------------
// (1) init --yes in empty dir: creates .taskmaster/ structure, exits 0
// ---------------------------------------------------------------------------

test('(1) init --yes in empty dir: creates .taskmaster/ files and exits 0', async () => {
  const tmpDir = makeTmpDir();

  const result = await runInit({ yes: true }, { _baseDir: tmpDir });

  assert.equal(result.exitCode, 0, 'init --yes must exit 0');
  assert.ok(
    typeof result.stdout === 'string' && result.stdout.length > 0,
    'stdout must be non-empty'
  );

  const tasksFile = path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json');
  const stateFile = path.join(tmpDir, '.taskmaster', 'state.json');
  const configFile = path.join(tmpDir, '.taskmaster', 'config.json');

  assert.ok(fs.existsSync(tasksFile), 'tasks/tasks.json must be created');
  assert.ok(fs.existsSync(stateFile), 'state.json must be created');
  assert.ok(fs.existsSync(configFile), 'config.json must be created');

  // Verify file contents are valid JSON
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.deepEqual(tasks, {}, 'tasks.json must be {}');

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(state, {}, 'state.json must be {}');

  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(config, { models: {} }, 'config.json must be {"models":{}}');
});

// ---------------------------------------------------------------------------
// (2) second init --yes same dir: "Already initialized" + exits 0 (idempotent)
// ---------------------------------------------------------------------------

test('(2) second init --yes: stdout contains "Already initialized", exits 0', async () => {
  const tmpDir = makeTmpDir();

  // First call — initialize
  await runInit({ yes: true }, { _baseDir: tmpDir });

  // Second call — must be idempotent
  const result = await runInit({ yes: true }, { _baseDir: tmpDir });

  assert.equal(result.exitCode, 0, 'second init must exit 0 (idempotent)');
  assert.ok(
    result.stdout.includes('Already initialized'),
    `stdout must contain "Already initialized"; got: ${result.stdout}`
  );
});

// ---------------------------------------------------------------------------
// (3) init WITHOUT --yes: exits 0 (non-interactive flag is optional)
// ---------------------------------------------------------------------------

test('(3) init without --yes: exits 0', async () => {
  const tmpDir = makeTmpDir();

  const result = await runInit({}, { _baseDir: tmpDir });

  assert.equal(result.exitCode, 0, 'init without --yes must exit 0');
  assert.equal(result.stderr, '', 'stderr must be empty on success');
});

// ---------------------------------------------------------------------------
// (4) directory layout: tasks/ and reports/ subdirs exist after init
// ---------------------------------------------------------------------------

test('(4) directory layout: .taskmaster/tasks/ and .taskmaster/reports/ subdirs exist', async () => {
  const tmpDir = makeTmpDir();

  await runInit({ yes: true }, { _baseDir: tmpDir });

  const tasksSubdir = path.join(tmpDir, '.taskmaster', 'tasks');
  const reportsSubdir = path.join(tmpDir, '.taskmaster', 'reports');

  assert.ok(
    fs.existsSync(tasksSubdir) && fs.statSync(tasksSubdir).isDirectory(),
    '.taskmaster/tasks/ must be a directory'
  );
  assert.ok(
    fs.existsSync(reportsSubdir) && fs.statSync(reportsSubdir).isDirectory(),
    '.taskmaster/reports/ must be a directory'
  );
});

// ---------------------------------------------------------------------------
// (5) init --yes via _paths.baseDir injection (alternate inject form)
// ---------------------------------------------------------------------------

test('(5) _paths.baseDir injection: creates .taskmaster/ and exits 0', async () => {
  const tmpDir = makeTmpDir();

  const result = await runInit({ yes: true }, { _paths: { baseDir: tmpDir } });

  assert.equal(result.exitCode, 0, 'init via _paths.baseDir must exit 0');

  const tasksFile = path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json');
  assert.ok(fs.existsSync(tasksFile), 'tasks.json must be created via _paths.baseDir');
});
