/**
 * Unit tests for lib/expand-hook.cjs — ExpandHook thin gateway module.
 *
 * Covers:
 *   FR-012: expand() — valid array of subtasks delegated to SubtaskManager, ids derived
 *   FR-013: expand() — append mode: index continues from existing subtask count
 *   ERR_INVALID_SUBTASKS — thrown when subtasksInput is not an Array or element lacks title
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths so the
 * real .taskmaster/ is NEVER touched during testing.
 *
 * Run: node test/expand-hook.test.cjs
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

let expandHook;
test('expand-hook module imports without throwing', () => {
  const mod = require('../lib/expand-hook.cjs');
  expandHook = mod.expandHook;
  assert.equal(typeof expandHook, 'function', 'expandHook must be exported as a function');
});

// ---------------------------------------------------------------------------
// Helper — each test gets its own isolated tmp directory so no shared state
// leaks between tests.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'expand-hook-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
  };
}

/**
 * Write a tasks.json with the given tag namespace containing the given tasks array.
 */
function writeTasksFile(tasksFile, tag, tasks) {
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  const data = {
    [tag]: { tasks, metadata: {} },
  };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Test 1: Valid array of 2 subtasks creates both with ids parentId.1 / parentId.2
// (FR-012, TC-019 — expand fresh task, no existing subtasks)
// ---------------------------------------------------------------------------

test('expandHook creates both subtasks with hierarchical ids "5.1" and "5.2"', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '5',
    title: 'Parent Task',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'feat-x', [parentTask]);

  const result = expandHook('5', [
    { title: 'First subtask' },
    { title: 'Second subtask' },
  ], 'feat-x', _paths);

  assert.equal(Array.isArray(result), true, 'expandHook must return an array');
  assert.equal(result.length, 2, 'result must contain exactly 2 created subtasks');
  assert.equal(result[0].id, '5.1', 'First created subtask must have id "5.1"');
  assert.equal(result[1].id, '5.2', 'Second created subtask must have id "5.2"');
  assert.equal(result[0].title, 'First subtask', 'First subtask title must match');
  assert.equal(result[1].title, 'Second subtask', 'Second subtask title must match');
});

// ---------------------------------------------------------------------------
// Test 2: Subtasks are persisted to disk (hermetic I/O check)
// ---------------------------------------------------------------------------

test('expandHook persists both subtasks to disk (hermetic atomic write confirmation)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '7',
    title: 'Persisted parent',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'persist-tag', [parentTask]);

  expandHook('7', [
    { title: 'Sub A', description: 'desc A' },
    { title: 'Sub B' },
  ], 'persist-tag', _paths);

  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedParent = stored['persist-tag'].tasks.find((t) => t.id === '7');
  assert.ok(storedParent, 'Parent task must exist in stored file');
  assert.equal(storedParent.subtasks.length, 2,
    'Parent must have exactly 2 subtasks after expandHook');
  assert.equal(storedParent.subtasks[0].id, '7.1',
    'First stored subtask id must be "7.1"');
  assert.equal(storedParent.subtasks[1].id, '7.2',
    'Second stored subtask id must be "7.2"');
});

// ---------------------------------------------------------------------------
// Test 3: Non-array input throws ERR_INVALID_SUBTASKS
// (ERR_INVALID_SUBTASKS — subtasksInput not an Array)
// ---------------------------------------------------------------------------

test('expandHook throws ERR_INVALID_SUBTASKS when subtasksInput is not an Array', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  writeTasksFile(_paths.tasksFile, 'feat-x', [
    { id: '1', title: 'Parent', status: 'pending', dependencies: [], subtasks: [] },
  ]);

  const invalidInputs = [
    null,
    undefined,
    'not-an-array',
    42,
    { title: 'object, not array' },
  ];

  for (const input of invalidInputs) {
    let thrown;
    try {
      expandHook('1', input, 'feat-x', _paths);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown,
      `expandHook must throw for non-array input: ${JSON.stringify(input)}`);
    assert.equal(thrown.code, 'ERR_INVALID_SUBTASKS',
      `error .code must be ERR_INVALID_SUBTASKS for input: ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Element missing title throws ERR_INVALID_SUBTASKS
// (ERR_INVALID_SUBTASKS — element does not have non-empty title)
// ---------------------------------------------------------------------------

test('expandHook throws ERR_INVALID_SUBTASKS when an element is missing a non-empty title', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  writeTasksFile(_paths.tasksFile, 'feat-y', [
    { id: '2', title: 'Parent', status: 'pending', dependencies: [], subtasks: [] },
  ]);

  const badElementCases = [
    [{ title: '' }],                // empty string title
    [{ title: '   ' }],            // whitespace-only title
    [{}],                           // missing title entirely
    [{ title: 123 }],              // title not a string
    [{ title: 'Valid' }, {}],      // second element missing title
    [null],                         // element is null
  ];

  for (const input of badElementCases) {
    let thrown;
    try {
      expandHook('2', input, 'feat-y', _paths);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown,
      `expandHook must throw for bad element input: ${JSON.stringify(input)}`);
    assert.equal(thrown.code, 'ERR_INVALID_SUBTASKS',
      `error .code must be ERR_INVALID_SUBTASKS for bad element: ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// Test 5: Empty array → no-op, returns []
// (task instruction: empty array → no-op)
// ---------------------------------------------------------------------------

test('expandHook returns empty array and makes no writes for empty subtasksInput', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '3',
    title: 'Parent',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'feat-z', [parentTask]);

  const mtimeBefore = fs.statSync(_paths.tasksFile).mtimeMs;
  const result = expandHook('3', [], 'feat-z', _paths);
  const mtimeAfter = fs.statSync(_paths.tasksFile).mtimeMs;

  assert.deepEqual(result, [], 'expandHook must return [] for empty input');
  assert.equal(mtimeBefore, mtimeAfter, 'tasks.json must not be modified for empty input');
});

// ---------------------------------------------------------------------------
// Test 6: Append mode — index continues from existing subtasks (FR-013, TC-020)
// ---------------------------------------------------------------------------

test('expandHook appends subtasks continuing from existing subtask index (FR-013)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '5',
    title: 'Parent with existing subtask',
    status: 'pending',
    dependencies: [],
    subtasks: [{ id: '5.1', title: 'Existing subtask', status: 'done' }],
  };
  writeTasksFile(_paths.tasksFile, 'feat-x', [parentTask]);

  const result = expandHook('5', [{ title: 'New subtask C' }], 'feat-x', _paths);

  assert.equal(result.length, 1, 'result must contain 1 newly created subtask');
  assert.equal(result[0].id, '5.2',
    'New subtask must have id "5.2" (continuing from existing "5.1")');

  // Confirm existing subtask 5.1 is preserved
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedParent = stored['feat-x'].tasks.find((t) => t.id === '5');
  assert.equal(storedParent.subtasks.length, 2,
    'Parent must have 2 subtasks total (existing + new)');
  assert.equal(storedParent.subtasks[0].id, '5.1',
    'Original subtask "5.1" must not be removed (no overwrite)');
  assert.equal(storedParent.subtasks[1].id, '5.2',
    'New subtask must be appended as "5.2"');
});

// ---------------------------------------------------------------------------
// Test 7: expandHook propagates ERR_TAG_NOT_FOUND when tag does not exist
// (FR-012, SD §9.1 expand Errors — ERR_TAG_NOT_FOUND propagated from SubtaskManager)
// ---------------------------------------------------------------------------

test('expandHook propagates ERR_TAG_NOT_FOUND when the tag does not exist in tasks.json', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // tasks.json has "existing-tag" but NOT "ghost-tag".
  writeTasksFile(_paths.tasksFile, 'existing-tag', [
    { id: '1', title: 'Task', status: 'pending', dependencies: [], subtasks: [] },
  ]);

  let thrown;
  try {
    expandHook('1', [{ title: 'Subtask' }], 'ghost-tag', _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'expandHook must throw when the tag does not exist');
  assert.equal(thrown.code, 'ERR_TAG_NOT_FOUND',
    'error .code must be ERR_TAG_NOT_FOUND (propagated from SubtaskManager)');
});

// ---------------------------------------------------------------------------
// Test 8: expandHook propagates ERR_TASK_NOT_FOUND when parent task is absent
// (FR-012, SD §9.1 expand Errors — ERR_TASK_NOT_FOUND propagated from SubtaskManager)
// ---------------------------------------------------------------------------

test('expandHook propagates ERR_TASK_NOT_FOUND when the parent task does not exist in tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Tag "feat-z" exists but does NOT contain task "99".
  writeTasksFile(_paths.tasksFile, 'feat-z', [
    { id: '1', title: 'Other task', status: 'pending', dependencies: [], subtasks: [] },
  ]);

  let thrown;
  try {
    expandHook('99', [{ title: 'Orphan subtask' }], 'feat-z', _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'expandHook must throw when the parent task does not exist in the tag');
  assert.equal(thrown.code, 'ERR_TASK_NOT_FOUND',
    'error .code must be ERR_TASK_NOT_FOUND (propagated from SubtaskManager)');
});
