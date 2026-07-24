/**
 * Unit tests for lib/subtask-manager.cjs — SubtaskManager module.
 *
 * Covers:
 *   FR-010: addSubtask — hierarchical id derivation, status default, incoming id ignored,
 *           parent-not-found error.
 *   FR-011: computeCompletion — pure function with / without subtasks.
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths so the
 * real .taskmaster/ is NEVER touched during testing.
 *
 * Run: node test/subtask-manager.test.cjs
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

let subtaskManager;
test('subtask-manager module imports without throwing', () => {
  subtaskManager = require('../lib/subtask-manager.cjs');
});

// ---------------------------------------------------------------------------
// Helper — each test gets its own isolated tmp directory so no shared state
// leaks between tests.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'subtask-manager-test-'));
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
// Test 1: addSubtask creates the first subtask with id '<parentId>.1'
// (FR-010, TC-015 — id phân cấp đầu tiên)
// ---------------------------------------------------------------------------

test('addSubtask creates first subtask with hierarchical id "1.1"', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '1',
    title: 'Parent Task',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'feat-x', [parentTask]);

  const created = subtaskManager.addSubtask('1', { title: 'First subtask' }, 'feat-x', _paths);

  assert.equal(created.id, '1.1', 'First subtask id must be "1.1"');
});

// ---------------------------------------------------------------------------
// Test 2: addSubtask creates a second subtask with id '<parentId>.2'
// (FR-010, TC-016 — index tiếp theo)
// ---------------------------------------------------------------------------

test('addSubtask creates second subtask with id "1.2" when one subtask already exists', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '1',
    title: 'Parent Task',
    status: 'pending',
    dependencies: [],
    subtasks: [{ id: '1.1', title: 'Existing subtask', status: 'pending' }],
  };
  writeTasksFile(_paths.tasksFile, 'feat-x', [parentTask]);

  const created = subtaskManager.addSubtask('1', { title: 'Second subtask' }, 'feat-x', _paths);

  assert.equal(created.id, '1.2', 'Second subtask id must be "1.2"');
});

// ---------------------------------------------------------------------------
// Test 3: addSubtask defaults status to 'pending' when subtaskData.status is absent
// (FR-010, SD §9.1 addSubtask behavior step 3)
// ---------------------------------------------------------------------------

test('addSubtask defaults subtask status to "pending" when not specified', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '2',
    title: 'Parent',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'feat-y', [parentTask]);

  const created = subtaskManager.addSubtask('2', { title: 'No status subtask' }, 'feat-y', _paths);

  assert.equal(created.status, 'pending', 'Subtask status must default to "pending"');
});

// ---------------------------------------------------------------------------
// Test 4: addSubtask ignores any incoming id field in subtaskData
// (FR-010, SD §9.1 addSubtask — "Field `id` bị bỏ qua nếu có")
// ---------------------------------------------------------------------------

test('addSubtask ignores incoming id field and derives id from parent and count', () => {
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

  // Pass an explicit id in subtaskData — it must be ignored
  const created = subtaskManager.addSubtask(
    '3',
    { id: '999', title: 'Incoming id ignored' },
    'feat-z',
    _paths
  );

  assert.equal(created.id, '3.1',
    'Subtask id must be derived as "3.1", not the incoming "999"');
});

// ---------------------------------------------------------------------------
// Test 5: addSubtask throws ERR_TASK_NOT_FOUND when parent task does not exist
// (FR-010, SD §9.1 addSubtask Errors — ERR_TASK_NOT_FOUND)
// ---------------------------------------------------------------------------

test('addSubtask throws ERR_TASK_NOT_FOUND when parent task does not exist in tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Tag exists but task "99" does not
  writeTasksFile(_paths.tasksFile, 'feat-x', [
    { id: '1', title: 'Exists', status: 'pending', dependencies: [], subtasks: [] },
  ]);

  let thrown;
  try {
    subtaskManager.addSubtask('99', { title: 'Orphan' }, 'feat-x', _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'addSubtask must throw when parent task does not exist');
  assert.equal(thrown.code, 'ERR_TASK_NOT_FOUND',
    'error .code must be ERR_TASK_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Test 6: computeCompletion returns correct percentage with mixed subtask statuses
// (FR-011, TC-017 — 1 done + 1 pending → 50%)
// ---------------------------------------------------------------------------

test('computeCompletion returns 50 when one of two subtasks is done', () => {
  const task = {
    id: '1',
    status: 'pending',
    subtasks: [
      { id: '1.1', status: 'done' },
      { id: '1.2', status: 'pending' },
    ],
  };

  const result = subtaskManager.computeCompletion(task);

  assert.equal(result, 50, 'computeCompletion must return 50 for 1 done / 2 total');
});

// ---------------------------------------------------------------------------
// Test 7: computeCompletion returns 0 when task has no subtasks and status is not done
// (FR-011, TC-018 partial — status != 'done' → 0)
// ---------------------------------------------------------------------------

test('computeCompletion returns 0 when task has no subtasks and status is not done', () => {
  const task = {
    id: '2',
    status: 'pending',
    subtasks: [],
  };

  const result = subtaskManager.computeCompletion(task);

  assert.equal(result, 0,
    'computeCompletion must return 0 when there are no subtasks and task is not done');
});

// ---------------------------------------------------------------------------
// Test 8: computeCompletion returns 100 when task has no subtasks and status is 'done'
// (FR-011, TC-018 — status='done', subtasks=[] → 100)
// ---------------------------------------------------------------------------

test('computeCompletion returns 100 when task has no subtasks and status is "done"', () => {
  const task = {
    id: '3',
    status: 'done',
    subtasks: [],
  };

  const result = subtaskManager.computeCompletion(task);

  assert.equal(result, 100,
    'computeCompletion must return 100 when task is done and has no subtasks');
});

// ---------------------------------------------------------------------------
// Test 9: addSubtask persists subtask to disk (hermetic I/O check)
// Reads tasks.json back and confirms the subtask was actually written.
// ---------------------------------------------------------------------------

test('addSubtask persists subtask to disk (hermetic atomic write confirmation)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '5',
    title: 'Persisted parent',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'persist-tag', [parentTask]);

  subtaskManager.addSubtask('5', { title: 'Persisted sub', description: 'desc' }, 'persist-tag', _paths);

  // Read back from disk — should have the new subtask
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedParent = stored['persist-tag'].tasks.find((t) => t.id === '5');
  assert.ok(storedParent, 'Parent task must exist in stored file');
  assert.equal(storedParent.subtasks.length, 1, 'Parent must have exactly 1 subtask after addSubtask');
  assert.equal(storedParent.subtasks[0].id, '5.1', 'Stored subtask id must be "5.1"');
  assert.equal(storedParent.subtasks[0].title, 'Persisted sub', 'Stored subtask title must match');
});

// ---------------------------------------------------------------------------
// Test 10: computeCompletion returns 100 when all subtasks are done
// ---------------------------------------------------------------------------

test('computeCompletion returns 100 when all subtasks are done', () => {
  const task = {
    id: '4',
    status: 'in-progress',
    subtasks: [
      { id: '4.1', status: 'done' },
      { id: '4.2', status: 'done' },
      { id: '4.3', status: 'done' },
    ],
  };

  const result = subtaskManager.computeCompletion(task);

  assert.equal(result, 100, 'computeCompletion must return 100 when all subtasks are done');
});

// ---------------------------------------------------------------------------
// Test 11: addSubtask throws ERR_TAG_NOT_FOUND when the tag does not exist
// (FR-010, SD §9.1 addSubtask Errors — ERR_TAG_NOT_FOUND)
//
// addSubtask is a read op with respect to the tag namespace — it must throw
// ERR_TAG_NOT_FOUND when the tag is absent (same as other read ops, SD §6 D3).
// ---------------------------------------------------------------------------

test('addSubtask throws ERR_TAG_NOT_FOUND when the tag does not exist in tasks.json', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Write tasks.json with a different tag — "ghost-tag" is absent.
  writeTasksFile(_paths.tasksFile, 'existing-tag', [
    { id: '1', title: 'Existing task', status: 'pending', dependencies: [], subtasks: [] },
  ]);

  let thrown;
  try {
    subtaskManager.addSubtask('1', { title: 'Subtask' }, 'ghost-tag', _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'addSubtask must throw when the tag does not exist');
  assert.equal(thrown.code, 'ERR_TAG_NOT_FOUND',
    'error .code must be ERR_TAG_NOT_FOUND when the tag is absent from tasks.json');
});

// ---------------------------------------------------------------------------
// Test 12: computeCompletion returns 0 when all subtasks are pending
// (FR-011 — 0 done / N total → 0%)
// ---------------------------------------------------------------------------

test('computeCompletion returns 0 when no subtasks are done (all pending)', () => {
  const task = {
    id: '6',
    status: 'in-progress',
    subtasks: [
      { id: '6.1', status: 'pending' },
      { id: '6.2', status: 'pending' },
      { id: '6.3', status: 'in-progress' },
    ],
  };

  const result = subtaskManager.computeCompletion(task);

  assert.equal(result, 0,
    'computeCompletion must return 0 when all subtasks are pending or in-progress (none done)');
});

// ---------------------------------------------------------------------------
// Test 13: computeCompletion with partial done subtasks rounds correctly
// (FR-011 — Math.round: 1 done / 3 total = 33.33% → rounds to 33)
// ---------------------------------------------------------------------------

test('computeCompletion rounds correctly: 1 done of 3 subtasks → 33', () => {
  const task = {
    id: '7',
    status: 'in-progress',
    subtasks: [
      { id: '7.1', status: 'done' },
      { id: '7.2', status: 'pending' },
      { id: '7.3', status: 'pending' },
    ],
  };

  const result = subtaskManager.computeCompletion(task);

  assert.equal(result, 33,
    'computeCompletion must return 33 for 1 done / 3 total (Math.round(33.33) = 33)');
});
