/**
 * Unit tests for lib/task-core.cjs — the native task storage + CRUD module.
 * Tests run directly against the module (not via CLI). Use a throwaway tmp dir
 * for any file-system operations so the real .taskmaster/ is never touched.
 *
 * Run:  node test/task-core.test.cjs   (or: node --test test/task-core.test.cjs)
 *
 * Task #1 scope: module structure + exports (constants + function skeletons).
 * Task #2 scope: _readTasksFile / _writeTasksFileAtomic helpers + TASKS_FILE constant.
 * Tasks #3–#8 add the behaviour tests (addTask, getTask, listTasks, etc.).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Module import — must not throw (RED: module does not exist yet → will fail)
// ---------------------------------------------------------------------------

let taskCore;
test('task-core module imports without throwing', () => {
  taskCore = require('../lib/task-core.cjs');
});

// ---------------------------------------------------------------------------
// Constants — VALID_STATUSES and VALID_PRIORITIES must be exported with the
// exact values mandated by SD §7.1 and FR-008/FR-009.
// ---------------------------------------------------------------------------

test('VALID_STATUSES is exported as an array', () => {
  assert.ok(Array.isArray(taskCore.VALID_STATUSES), 'VALID_STATUSES must be an array');
});

test('VALID_STATUSES contains exactly the 7 expected values', () => {
  const expected = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  assert.deepEqual(taskCore.VALID_STATUSES, expected);
});

test('VALID_PRIORITIES is exported as an array', () => {
  assert.ok(Array.isArray(taskCore.VALID_PRIORITIES), 'VALID_PRIORITIES must be an array');
});

test('VALID_PRIORITIES contains exactly the 3 expected values in priority order', () => {
  const expected = ['high', 'medium', 'low'];
  assert.deepEqual(taskCore.VALID_PRIORITIES, expected);
});

// ---------------------------------------------------------------------------
// Function exports — all 6 public functions must be exported and be functions.
// SD §9.2 API surface: addTask, getTask, listTasks, setStatus, nextTask, updateTask.
// ---------------------------------------------------------------------------

test('addTask is exported as a function', () => {
  assert.equal(typeof taskCore.addTask, 'function', 'addTask must be a function');
});

test('getTask is exported as a function', () => {
  assert.equal(typeof taskCore.getTask, 'function', 'getTask must be a function');
});

test('listTasks is exported as a function', () => {
  assert.equal(typeof taskCore.listTasks, 'function', 'listTasks must be a function');
});

test('setStatus is exported as a function', () => {
  assert.equal(typeof taskCore.setStatus, 'function', 'setStatus must be a function');
});

test('nextTask is exported as a function', () => {
  assert.equal(typeof taskCore.nextTask, 'function', 'nextTask must be a function');
});

test('updateTask is exported as a function', () => {
  assert.equal(typeof taskCore.updateTask, 'function', 'updateTask must be a function');
});

// ---------------------------------------------------------------------------
// Task #2 — _readTasksFile and _writeTasksFileAtomic internal helpers (FR-002)
//
// A unique tmp directory is created once for this test run so no test touches
// the project's real .taskmaster/ tree.
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t2-'));

test('_readTasksFile returns {} for a non-existent file', () => {
  const result = taskCore._readTasksFile(path.join(tmpDir, 'no-such-file.json'));
  assert.deepStrictEqual(result, {});
});

test('_writeTasksFileAtomic then _readTasksFile roundtrip preserves structure', () => {
  const filePath = path.join(tmpDir, 'roundtrip.json');
  const data = {
    master: { tasks: [{ id: '1', title: 'Test task', status: 'pending' }], metadata: {} },
  };
  taskCore._writeTasksFileAtomic(filePath, data);
  const result = taskCore._readTasksFile(filePath);
  assert.deepStrictEqual(result, data);
});

test('_writeTasksFileAtomic leaves original file unchanged when renameSync throws', () => {
  const filePath = path.join(tmpDir, 'atomic-safety.json');
  const originalData = { safe: true, version: 1 };
  // Establish a known-good original file on disk.
  fs.writeFileSync(filePath, JSON.stringify(originalData), 'utf8');

  // Monkeypatch the shared fs module object — CommonJS require cache means the
  // patched reference is visible inside task-core.cjs as well (same object).
  const origRename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error('simulated rename failure'), { code: 'EXDEV' });
  };

  try {
    taskCore._writeTasksFileAtomic(filePath, { modified: true });
  } catch (_) {
    // expected — _writeTasksFileAtomic must propagate the rename error
  } finally {
    fs.renameSync = origRename;
  }

  // The original file must be byte-identical to what we wrote before the failed attempt.
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(onDisk, originalData, 'original file must be unchanged after a failed atomic write');
});

test('_writeTasksFileAtomic writes file with 2-space JSON indentation', () => {
  const filePath = path.join(tmpDir, 'indent-check.json');
  taskCore._writeTasksFileAtomic(filePath, { key: 'value', nested: { x: 1 } });
  const raw = fs.readFileSync(filePath, 'utf8');
  // JSON.stringify(data, null, 2) produces `  "key": "value"` on line 2.
  assert.ok(
    raw.includes('  "key": "value"'),
    'written file must use 2-space JSON indentation'
  );
});

// ---------------------------------------------------------------------------
// Task #3 — _getCurrentTag helper and STATE_FILE constant (FR-004, SD §6 D7)
//
// _getCurrentTag reads .taskmaster/state.json and extracts the currentTag field.
// It never throws: returns null for missing file, absent field, or malformed JSON.
// A separate tmp dir is created so these tests never touch the project state.json.
// ---------------------------------------------------------------------------

const t3TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t3-'));

test('STATE_FILE constant is exported and equals .taskmaster/state.json', () => {
  assert.equal(taskCore.STATE_FILE, path.join('.taskmaster', 'state.json'));
});

test('_getCurrentTag is exported as a function', () => {
  assert.equal(typeof taskCore._getCurrentTag, 'function');
});

test('_getCurrentTag returns the tag string when state.json has currentTag', () => {
  const stateFile = path.join(t3TmpDir, 'state-with-tag.json');
  fs.writeFileSync(stateFile, JSON.stringify({ currentTag: 'feature-x', other: 'data' }), 'utf8');
  const result = taskCore._getCurrentTag(stateFile);
  assert.equal(result, 'feature-x', '_getCurrentTag must return the currentTag string');
});

test('_getCurrentTag returns null when state.json does not exist', () => {
  const stateFile = path.join(t3TmpDir, 'no-such-state.json');
  const result = taskCore._getCurrentTag(stateFile);
  assert.equal(result, null, '_getCurrentTag must return null for a missing file');
});

test('_getCurrentTag returns null when state.json has no currentTag field', () => {
  const stateFile = path.join(t3TmpDir, 'state-no-tag.json');
  fs.writeFileSync(stateFile, JSON.stringify({ someOtherField: 'value' }), 'utf8');
  const result = taskCore._getCurrentTag(stateFile);
  assert.equal(result, null, '_getCurrentTag must return null when currentTag field is absent');
});

test('_getCurrentTag returns null and does not throw for malformed JSON', () => {
  const stateFile = path.join(t3TmpDir, 'state-malformed.json');
  fs.writeFileSync(stateFile, '{ currentTag: not-valid-json !!!', 'utf8');
  let result;
  assert.doesNotThrow(() => {
    result = taskCore._getCurrentTag(stateFile);
  }, '_getCurrentTag must not throw on malformed JSON');
  assert.equal(result, null, '_getCurrentTag must return null for malformed JSON');
});

// ---------------------------------------------------------------------------
// Task #4 — addTask with auto-increment id (FR-003, FR-004)
//
// Each test uses its own unique tasksFile so no state leaks between tests.
// All addTask calls pass a `_paths` object (third arg) for test isolation:
//   { tasksFile: <tmp path>, stateFile: <tmp or nonexistent path> }
// Tests verify BOTH the returned task object AND the written file content,
// ensuring that path injection is actually honoured (not that addTask just
// returns a computed object without writing to the right place).
// ---------------------------------------------------------------------------

const t4TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t4-'));

function t4TasksFile(suffix) {
  return path.join(t4TmpDir, `tasks-${suffix}.json`);
}
function t4StateFile(suffix) {
  return path.join(t4TmpDir, `state-${suffix}.json`);
}

// TC-001 / TC-002: first task gets id='1', second gets id='2' (FR-003)
test('addTask assigns id="1" to first task and id="2" to second in same tag', () => {
  const tasksFile = t4TasksFile('id-increment');
  const paths = { tasksFile, stateFile: t4StateFile('id-increment-unused') };

  const t1 = taskCore.addTask('feat-x', { title: 'Task One' }, paths);
  assert.equal(t1.id, '1', 'first task must have id="1"');

  const t2 = taskCore.addTask('feat-x', { title: 'Task Two' }, paths);
  assert.equal(t2.id, '2', 'second task must have id="2"');

  // Verify the write actually landed in the TEMP file, not the real .taskmaster/
  const written = taskCore._readTasksFile(tasksFile);
  assert.ok(written['feat-x'], 'tag "feat-x" must exist in the temp tasks file');
  assert.equal(written['feat-x'].tasks.length, 2, 'two tasks must be in the temp file');
  assert.equal(written['feat-x'].tasks[0].id, '1');
  assert.equal(written['feat-x'].tasks[1].id, '2');
});

// TC-003: when tag is undefined, addTask resolves it from state.json (FR-004)
test('addTask uses currentTag from state.json when tag arg is undefined', () => {
  const tasksFile = t4TasksFile('default-tag');
  const stateFile = t4StateFile('default-tag');
  fs.writeFileSync(stateFile, JSON.stringify({ currentTag: 'feat-default' }), 'utf8');
  const paths = { tasksFile, stateFile };

  const task = taskCore.addTask(undefined, { title: 'Default Tag Task' }, paths);
  assert.equal(task.id, '1', 'created task must have id="1"');

  // The task must be stored under 'feat-default', not under any other tag
  const written = taskCore._readTasksFile(tasksFile);
  assert.ok(written['feat-default'], 'tag "feat-default" must exist in temp file');
  assert.equal(written['feat-default'].tasks.length, 1);
  assert.equal(written['feat-default'].tasks[0].id, '1');
});

// explicit tag must win over state.json currentTag (FR-003, FR-004 boundary)
test('addTask uses explicit tag even when state.json has a different currentTag', () => {
  const tasksFile = t4TasksFile('explicit-tag');
  const stateFile = t4StateFile('explicit-tag');
  fs.writeFileSync(stateFile, JSON.stringify({ currentTag: 'feat-from-state' }), 'utf8');
  const paths = { tasksFile, stateFile };

  taskCore.addTask('feat-explicit', { title: 'Explicit Tag Task' }, paths);

  const written = taskCore._readTasksFile(tasksFile);
  assert.ok(written['feat-explicit'], 'explicit tag must be used when provided');
  assert.ok(!written['feat-from-state'], 'state.json tag must NOT be used when an explicit tag is given');
});

// TC: no tag + no state.json → throw ERR_NO_TAG (FR-004)
test('addTask throws ERR_NO_TAG when tag is undefined and state.json does not exist', () => {
  const tasksFile = t4TasksFile('no-tag');
  // stateFile path does not exist on disk
  const paths = { tasksFile, stateFile: path.join(t4TmpDir, 'nonexistent-state.json') };

  let thrown;
  try {
    taskCore.addTask(undefined, { title: 'Should Not Exist' }, paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw when no tag and no state.json');
  assert.equal(thrown.code, 'ERR_NO_TAG', 'error .code must be ERR_NO_TAG');
});

// TC: returned task has correct auto-fields: status, dependencies, subtasks, updatedAt (FR-003)
test('addTask task has status="pending", dependencies=[], subtasks=[], and ISO updatedAt', () => {
  const tasksFile = t4TasksFile('auto-fields');
  const paths = { tasksFile, stateFile: t4StateFile('auto-fields-unused') };

  const task = taskCore.addTask('feat-y', { title: 'Auto Fields Task' }, paths);
  assert.equal(task.status, 'pending', 'status must be "pending"');
  assert.deepEqual(task.dependencies, [], 'dependencies must be []');
  assert.deepEqual(task.subtasks, [], 'subtasks must be []');
  assert.equal(typeof task.updatedAt, 'string', 'updatedAt must be a string');
  assert.ok(!isNaN(new Date(task.updatedAt).getTime()), 'updatedAt must be a valid ISO date');

  // verify the write hit the temp file (not the global tasks.json)
  const written = taskCore._readTasksFile(tasksFile);
  assert.ok(written['feat-y'], 'task must be persisted to the temp file under feat-y');
});

// TC: priority defaults to 'medium' when not specified (FR-003)
test('addTask defaults priority to "medium" when priority field is absent', () => {
  const tasksFile = t4TasksFile('priority-default');
  const paths = { tasksFile, stateFile: t4StateFile('priority-default-unused') };

  const task = taskCore.addTask('feat-z', { title: 'No Priority' }, paths);
  assert.equal(task.priority, 'medium', 'priority must default to "medium"');

  // confirm file was written to temp location
  const written = taskCore._readTasksFile(tasksFile);
  assert.ok(written['feat-z'], 'task must be in temp tasks file');
});

// TC: empty title string must throw ERR_INVALID_TITLE (FR-003 title required)
test('addTask throws ERR_INVALID_TITLE when title is an empty string', () => {
  const tasksFile = t4TasksFile('empty-title');
  const paths = { tasksFile, stateFile: t4StateFile('empty-title-unused') };

  let thrown;
  try {
    taskCore.addTask('feat-x', { title: '' }, paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw for empty title');
  assert.equal(thrown.code, 'ERR_INVALID_TITLE', 'error .code must be ERR_INVALID_TITLE');
});

// TC: missing title field must throw ERR_INVALID_TITLE
test('addTask throws ERR_INVALID_TITLE when title field is missing', () => {
  const tasksFile = t4TasksFile('missing-title');
  const paths = { tasksFile, stateFile: t4StateFile('missing-title-unused') };

  let thrown;
  try {
    taskCore.addTask('feat-x', {}, paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw when title is missing');
  assert.equal(thrown.code, 'ERR_INVALID_TITLE', 'error .code must be ERR_INVALID_TITLE');
});

// ---------------------------------------------------------------------------
// Task #5 — getTask and listTasks with stats (FR-005, FR-006, FR-007)
//
// Each test writes a known task set to an isolated temp file and passes the
// path via the optional `_paths` argument so the real .taskmaster/ is never
// touched. Tests cover all 8 acceptance criteria in the task description.
// ---------------------------------------------------------------------------

const t5TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t5-'));

function t5File(suffix) {
  return path.join(t5TmpDir, `tasks-${suffix}.json`);
}

/** Build a minimal tag-keyed tasks.json data object for a single tag. */
function makeTagData(tasks) {
  return { 'test-tag': { tasks, metadata: {} } };
}

/** Build a minimal task object with only the schema-defined fields. */
function makeTask(id, status, priority) {
  return {
    id: String(id),
    title: `Task ${id}`,
    description: '',
    details: '',
    testStrategy: '',
    priority: priority || 'medium',
    dependencies: [],
    status,
    subtasks: [],
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

// TC-004: getTask returns the task object for an existing id (FR-005)
test('getTask returns the task object for an existing id', () => {
  const tasksFile = t5File('get-existing');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'pending'),
    makeTask('2', 'done', 'high'),
  ]));

  const result = taskCore.getTask('test-tag', '1', { tasksFile });
  assert.ok(result, 'getTask must return a task object for id="1"');
  assert.equal(result.id, '1', 'returned task must have id="1"');
  assert.equal(result.title, 'Task 1', 'returned task must have the correct title');
});

// TC-005: getTask returns null for an id that does not exist (FR-005)
test('getTask returns null for an id that does not exist in the tag', () => {
  const tasksFile = t5File('get-missing-id');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([makeTask('1', 'pending')]));

  const result = taskCore.getTask('test-tag', '999', { tasksFile });
  assert.strictEqual(result, null, 'getTask must return null for a missing id');
});

// getTask: returns null when the tag itself does not exist in the file (FR-005)
test('getTask returns null when the tag does not exist', () => {
  const tasksFile = t5File('get-no-tag');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([]));

  const result = taskCore.getTask('no-such-tag', '1', { tasksFile });
  assert.strictEqual(result, null, 'getTask must return null when the tag is absent');
});

// getTask: never throws — missing id must return null, not throw (FR-005)
test('getTask does not throw for a missing id', () => {
  const tasksFile = t5File('get-no-throw');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([]));

  assert.doesNotThrow(
    () => taskCore.getTask('test-tag', '999', { tasksFile }),
    'getTask must not throw for a missing id'
  );
});

// getTask: id comparison is tolerant of number vs string (task spec constraint)
test('getTask finds the task when id is passed as a number instead of a string', () => {
  const tasksFile = t5File('get-id-number');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([makeTask('3', 'pending', 'low')]));

  const result = taskCore.getTask('test-tag', 3, { tasksFile }); // numeric, not string
  assert.ok(result, 'getTask must find the task when id is passed as a number');
  assert.equal(result.id, '3', 'returned task id must equal "3"');
});

// TC-006: listTasks returns all tasks with no status filter (FR-006)
test('listTasks returns all tasks in the tag when no status filter is given', () => {
  const tasksFile = t5File('list-all');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'pending'),
    makeTask('2', 'in-progress', 'high'),
    makeTask('3', 'done', 'low'),
  ]));

  const result = taskCore.listTasks('test-tag', {}, { tasksFile });
  assert.ok(result && Array.isArray(result.tasks), 'listTasks must return { tasks: [...] }');
  assert.equal(result.tasks.length, 3, 'must return all 3 tasks with no filter');
});

// TC-007: listTasks filters to a single status (FR-006)
test('listTasks returns only pending tasks when status="pending"', () => {
  const tasksFile = t5File('list-single-status');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'pending'),
    makeTask('2', 'pending'),
    makeTask('3', 'done'),
  ]));

  const result = taskCore.listTasks('test-tag', { status: 'pending' }, { tasksFile });
  assert.equal(result.tasks.length, 2, 'must return only the 2 pending tasks');
  assert.ok(result.tasks.every((t) => t.status === 'pending'), 'every returned task must be pending');
});

// TC-008: listTasks filters by comma-separated statuses (FR-006)
test('listTasks returns tasks matching either status in a comma-separated filter', () => {
  const tasksFile = t5File('list-multi-status');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'pending'),
    makeTask('2', 'in-progress', 'high'),
    makeTask('3', 'done', 'low'),
  ]));

  const result = taskCore.listTasks('test-tag', { status: 'pending,in-progress' }, { tasksFile });
  assert.equal(result.tasks.length, 2, 'must return 2 tasks (pending + in-progress)');
  const statuses = result.tasks.map((t) => t.status);
  assert.ok(statuses.includes('pending'), 'pending task must be included');
  assert.ok(statuses.includes('in-progress'), 'in-progress task must be included');
  assert.ok(!statuses.includes('done'), 'done task must not be included');
});

// TC-009: completionPercentage = round(2/(4-1)*100) = 67 for 2 done, 1 pending, 1 cancelled (FR-007)
test('listTasks stats.completionPercentage is 67 for 2 done, 1 pending, 1 cancelled', () => {
  const tasksFile = t5File('stats-67');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'done'),
    makeTask('2', 'done'),
    makeTask('3', 'pending'),
    makeTask('4', 'cancelled'),
  ]));

  const { stats } = taskCore.listTasks('test-tag', {}, { tasksFile });
  // completionPercentage = Math.round(2 / (4 - 1) * 100) = Math.round(66.67) = 67
  assert.equal(stats.completionPercentage, 67, 'completionPercentage must be 67');
  assert.equal(stats.done, 2);
  assert.equal(stats.pending, 1);
  assert.equal(stats.cancelled, 1);
});

// TC-009 variant: zero non-cancelled → completionPercentage = 0 (FR-007)
test('listTasks stats.completionPercentage is 0 when all tasks are cancelled', () => {
  const tasksFile = t5File('stats-all-cancelled');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'cancelled'),
    makeTask('2', 'cancelled'),
  ]));

  const { stats } = taskCore.listTasks('test-tag', {}, { tasksFile });
  assert.equal(stats.completionPercentage, 0, 'completionPercentage must be 0 when denominator is 0');
});

// TC-009 variant: empty tag → completionPercentage = 0 (FR-007)
test('listTasks stats.completionPercentage is 0 for an empty tag', () => {
  const tasksFile = t5File('stats-empty-tag');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([]));

  const { stats } = taskCore.listTasks('test-tag', {}, { tasksFile });
  assert.equal(stats.completionPercentage, 0, 'completionPercentage must be 0 for an empty tag');
});

// Stats shape: all 7 status keys + completionPercentage must be present (FR-007, SD §7.2)
test('listTasks stats object has all 7 status keys and completionPercentage', () => {
  const tasksFile = t5File('stats-shape');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([]));

  const { stats } = taskCore.listTasks('test-tag', {}, { tasksFile });
  const requiredKeys = [
    'pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review',
    'completionPercentage',
  ];
  for (const key of requiredKeys) {
    assert.ok(key in stats, `stats must have key "${key}"`);
  }
});

// TC-007 extended: stats are computed on the FULL tag even when a status filter is applied (FR-007)
test('listTasks stats reflect the full tag even when a status filter narrows the task list', () => {
  const tasksFile = t5File('stats-full-tag');
  taskCore._writeTasksFileAtomic(tasksFile, makeTagData([
    makeTask('1', 'pending'),
    makeTask('2', 'done'),
    makeTask('3', 'done'),
  ]));

  // Filter to only pending — stats must still count the 2 done tasks
  const { tasks: filtered, stats } = taskCore.listTasks('test-tag', { status: 'pending' }, { tasksFile });
  assert.equal(filtered.length, 1, 'filtered list must have 1 pending task');
  assert.equal(stats.done, 2, 'stats.done must reflect the full tag (2 done tasks)');
  assert.equal(stats.pending, 1, 'stats.pending must reflect the full tag (1 pending task)');
  // completionPercentage = Math.round(2/3 * 100) = 67
  assert.equal(stats.completionPercentage, 67, 'completionPercentage must be computed on the full unfiltered tag');
});

// ---------------------------------------------------------------------------
// Task #6 — setStatus with validation and path injection (FR-008, FR-009, FR-010)
//
// All setStatus calls pass a `_paths` object (fourth arg) for test isolation.
// Tests verify that:
//   1. Valid status change updates the task's status and updatedAt in the file.
//   2. All 7 valid status values are accepted without throwing.
//   3. Invalid status → throws Error with .code === 'ERR_INVALID_STATUS'.
//   4. Non-existent id → throws Error with .code === 'ERR_TASK_NOT_FOUND'.
//   5. Both error paths leave the file byte-unchanged (validate/lookup before write).
//   6. Subtask id '1.2' updates the correct subtask (and returns the parent task).
//   7. Error messages include the offending value or id.
// ---------------------------------------------------------------------------

const t6TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t6-'));

function t6File(suffix) {
  return path.join(t6TmpDir, `tasks-${suffix}.json`);
}

/** Build a tag-keyed data object containing a single tag with the given tasks. */
function makeT6TagData(tasks) {
  return { 'main': { tasks, metadata: {} } };
}

/** Build a minimal top-level task for setStatus tests. */
function makeT6Task(id, status, subtasks) {
  return {
    id: String(id),
    title: `Task ${id}`,
    description: '',
    details: '',
    testStrategy: '',
    priority: 'medium',
    dependencies: [],
    status,
    subtasks: subtasks || [],
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

// TC-010: setStatus happy path — updates status and updatedAt, writes file (FR-008)
test('setStatus updates task status and updatedAt and persists to the temp file', () => {
  const tasksFile = t6File('happy-path');
  taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([makeT6Task('1', 'pending')]));

  const before = new Date();
  const result = taskCore.setStatus('main', '1', 'in-progress', { tasksFile });
  const after = new Date();

  assert.ok(result, 'setStatus must return the updated task');
  assert.equal(result.status, 'in-progress', 'returned task must have status="in-progress"');
  assert.ok(typeof result.updatedAt === 'string', 'updatedAt must be a string');
  const updatedTime = new Date(result.updatedAt).getTime();
  assert.ok(updatedTime >= before.getTime() && updatedTime <= after.getTime(),
    'updatedAt must be a fresh ISO timestamp within the test window');

  // Confirm the change was persisted to the temp file
  const written = taskCore._readTasksFile(tasksFile);
  const onDisk = written['main'].tasks[0];
  assert.equal(onDisk.status, 'in-progress', 'persisted task must have status="in-progress"');
  assert.equal(onDisk.updatedAt, result.updatedAt, 'persisted updatedAt must match returned value');
});

// TC-011: all 7 valid status values are accepted without throwing (FR-008)
test('setStatus accepts all 7 valid status values without throwing', () => {
  const validStatuses = taskCore.VALID_STATUSES;

  for (const status of validStatuses) {
    const tasksFile = t6File(`valid-status-${status}`);
    taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([makeT6Task('1', 'pending')]));

    let thrown = null;
    try {
      taskCore.setStatus('main', '1', status, { tasksFile });
    } catch (e) {
      thrown = e;
    }
    assert.equal(thrown, null, `setStatus must not throw for valid status="${status}"`);
  }
});

// TC-012: invalid status → throw ERR_INVALID_STATUS (FR-009)
test('setStatus throws ERR_INVALID_STATUS for an unrecognised status value', () => {
  const tasksFile = t6File('invalid-status');
  taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([makeT6Task('1', 'pending')]));

  let thrown = null;
  try {
    taskCore.setStatus('main', '1', 'unknown', { tasksFile });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'setStatus must throw for an invalid status');
  assert.equal(thrown.code, 'ERR_INVALID_STATUS', 'error .code must be ERR_INVALID_STATUS');
});

// TC-013: non-existent id → throw ERR_TASK_NOT_FOUND (FR-010)
test('setStatus throws ERR_TASK_NOT_FOUND for an id that does not exist in the tag', () => {
  const tasksFile = t6File('not-found');
  taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([makeT6Task('1', 'pending')]));

  let thrown = null;
  try {
    taskCore.setStatus('main', '999', 'done', { tasksFile });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'setStatus must throw for a non-existent id');
  assert.equal(thrown.code, 'ERR_TASK_NOT_FOUND', 'error .code must be ERR_TASK_NOT_FOUND');
});

// Error path: ERR_INVALID_STATUS must leave the file byte-unchanged (FR-009)
test('setStatus ERR_INVALID_STATUS leaves the tasks file byte-unchanged', () => {
  const tasksFile = t6File('invalid-status-no-write');
  const originalData = makeT6TagData([makeT6Task('1', 'pending')]);
  taskCore._writeTasksFileAtomic(tasksFile, originalData);
  const originalBytes = fs.readFileSync(tasksFile, 'utf8');

  try {
    taskCore.setStatus('main', '1', 'bad-status', { tasksFile });
  } catch (_) {
    // expected
  }

  const afterBytes = fs.readFileSync(tasksFile, 'utf8');
  assert.equal(afterBytes, originalBytes, 'file must be byte-unchanged after ERR_INVALID_STATUS');
});

// Error path: ERR_TASK_NOT_FOUND must leave the file byte-unchanged (FR-010)
test('setStatus ERR_TASK_NOT_FOUND leaves the tasks file byte-unchanged', () => {
  const tasksFile = t6File('not-found-no-write');
  const originalData = makeT6TagData([makeT6Task('1', 'pending')]);
  taskCore._writeTasksFileAtomic(tasksFile, originalData);
  const originalBytes = fs.readFileSync(tasksFile, 'utf8');

  try {
    taskCore.setStatus('main', '999', 'done', { tasksFile });
  } catch (_) {
    // expected
  }

  const afterBytes = fs.readFileSync(tasksFile, 'utf8');
  assert.equal(afterBytes, originalBytes, 'file must be byte-unchanged after ERR_TASK_NOT_FOUND');
});

// Subtask id '1.2': setStatus updates the subtask and returns the parent task (FR-008)
test('setStatus with subtask id "1.2" updates the subtask status and returns the parent task', () => {
  const tasksFile = t6File('subtask-update');
  const taskWithSubtasks = makeT6Task('1', 'in-progress', [
    { id: '1', title: 'Subtask 1', status: 'pending', updatedAt: '2026-07-24T00:00:00.000Z' },
    { id: '2', title: 'Subtask 2', status: 'pending', updatedAt: '2026-07-24T00:00:00.000Z' },
  ]);
  taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([taskWithSubtasks]));

  const result = taskCore.setStatus('main', '1.2', 'done', { tasksFile });

  // setStatus with a subtask id must return the PARENT task (per spec: return the updated subtask's parent)
  assert.ok(result, 'setStatus must return a task object');
  assert.equal(result.id, '1', 'returned object must be the parent task (id="1")');

  // The subtask (id='2') must have its status updated
  const written = taskCore._readTasksFile(tasksFile);
  const parentOnDisk = written['main'].tasks[0];
  const subtaskOnDisk = parentOnDisk.subtasks.find((s) => String(s.id) === '2');
  assert.ok(subtaskOnDisk, 'subtask with id="2" must exist in the persisted data');
  assert.equal(subtaskOnDisk.status, 'done', 'subtask status must be "done" after setStatus');
  // The other subtask must be untouched
  const otherSubtask = parentOnDisk.subtasks.find((s) => String(s.id) === '1');
  assert.equal(otherSubtask.status, 'pending', 'untouched subtask must remain "pending"');
});

// Error messages include the offending value (FR-009, FR-010, SD §12.2)
test('ERR_INVALID_STATUS error message includes the bad status value', () => {
  const tasksFile = t6File('err-msg-invalid-status');
  taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([makeT6Task('1', 'pending')]));

  let thrown = null;
  try {
    taskCore.setStatus('main', '1', 'foobar', { tasksFile });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw');
  assert.ok(
    thrown.message.includes('foobar'),
    `error message must include the bad value "foobar"; got: "${thrown.message}"`
  );
});

test('ERR_TASK_NOT_FOUND error message includes the missing id', () => {
  const tasksFile = t6File('err-msg-not-found');
  taskCore._writeTasksFileAtomic(tasksFile, makeT6TagData([makeT6Task('1', 'pending')]));

  let thrown = null;
  try {
    taskCore.setStatus('main', '42', 'done', { tasksFile });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw');
  assert.ok(
    thrown.message.includes('42'),
    `error message must include the missing id "42"; got: "${thrown.message}"`
  );
});

// ---------------------------------------------------------------------------
// Task #7 — nextTask dependency-aware (FR-011, FR-012, FR-016)
//
// nextTask must accept an optional _paths object (second arg) to allow tests
// to supply a temp tasksFile so the real .taskmaster/ is never touched.
//
// TC-014: satisfied deps → task returned
// TC-015: unsatisfied dep (not done) → task skipped; unblocked task returned
// (fail-safe): missing dep id → treated as not-done → task blocked
// TC-016: priority ordering — high before medium before low
// (id tiebreaker): same priority → lowest numeric id wins
// TC-017: all pending blocked → {task:null, reason} — reason mentions "blocked"
// TC-018: no pending tasks → {task:null, reason} — reason mentions "pending", not "blocked"
// (never throws): empty tag and missing tag must not throw
// ---------------------------------------------------------------------------

const t7TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t7-'));

function t7File(suffix) {
  return path.join(t7TmpDir, `tasks-${suffix}.json`);
}

function makeT7TagData(tasks) {
  return { 'ntag': { tasks, metadata: {} } };
}

function makeT7Task(id, status, priority, deps) {
  return {
    id: String(id),
    title: `Task ${id}`,
    description: '',
    details: '',
    testStrategy: '',
    priority: priority || 'medium',
    dependencies: deps || [],
    status,
    subtasks: [],
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

// TC-014: task with all deps done is returned (FR-011)
test('nextTask returns the eligible task when all its dependencies are done', () => {
  const tasksFile = t7File('deps-satisfied');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('1', 'done', 'medium', []),
    makeT7Task('2', 'pending', 'medium', ['1']),
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result && result.task, 'nextTask must return a task when all deps are done');
  assert.equal(result.task.id, '2', 'must return task "2" whose dep "1" is done');
});

// TC-015: dep not done → task skipped; task with no deps returned instead (FR-011)
test('nextTask skips a pending task whose dependency is not done and returns an unblocked one', () => {
  const tasksFile = t7File('dep-not-done');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('1', 'pending', 'medium', []),     // eligible — no deps
    makeT7Task('2', 'pending', 'medium', ['1']), // blocked — dep '1' is pending, not done
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result && result.task, 'nextTask must return the unblocked task');
  assert.equal(result.task.id, '1', 'must return task "1" (no deps); blocked task "2" must be skipped');
});

// Fail-safe: a dep id that does not exist in the tag treats the task as blocked (SD §6 D6, FR-016)
test('nextTask treats a missing dep id as blocking — the task is skipped (fail-safe)', () => {
  const tasksFile = t7File('missing-dep');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('1', 'pending', 'medium', ['99']), // dep '99' does not exist → blocked
    makeT7Task('2', 'pending', 'medium', []),      // eligible
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result && result.task, 'nextTask must return the unblocked task "2"');
  assert.equal(result.task.id, '2', 'task with a missing dep must be skipped; task "2" returned');
});

// TC-016: priority ordering — high before medium before low (FR-011)
test('nextTask returns the highest-priority eligible task first', () => {
  const tasksFile = t7File('priority-order');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('1', 'pending', 'low', []),
    makeT7Task('2', 'pending', 'medium', []),
    makeT7Task('3', 'pending', 'high', []),
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result && result.task, 'nextTask must return a task');
  assert.equal(result.task.id, '3', 'must return the high-priority task "3" first');
});

// Id tiebreaker: same priority → lowest numeric id wins (FR-011, SD §10.2 step 5)
test('nextTask uses ascending numeric id as tiebreaker within the same priority', () => {
  const tasksFile = t7File('id-tiebreaker');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('3', 'pending', 'medium', []),
    makeT7Task('1', 'pending', 'medium', []),
    makeT7Task('2', 'pending', 'medium', []),
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result && result.task, 'nextTask must return a task');
  assert.equal(result.task.id, '1', 'must return task "1" (lowest id among equal-priority tasks)');
});

// TC-017: all pending blocked → {task:null, reason} — reason distinguishes from TC-018 (FR-012)
test('nextTask returns {task:null} with a blocked-dep reason when all pending tasks are blocked', () => {
  const tasksFile = t7File('all-blocked');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('1', 'pending', 'medium', ['2']), // dep '2' is pending — not done
    makeT7Task('2', 'pending', 'medium', ['1']), // dep '1' is pending — not done
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result, 'nextTask must return an object');
  assert.strictEqual(result.task, null, 'task must be null when all pending tasks are blocked');
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0,
    'reason must be a non-empty string');
  // Reason MUST mention "block" to distinguish this case from "no pending remaining"
  assert.ok(
    result.reason.toLowerCase().includes('block'),
    `TC-017 reason must mention "block" (not confuse with no-pending case); got: "${result.reason}"`
  );
});

// TC-018: no pending tasks → {task:null, reason} — reason mentions "pending", not "blocked" (FR-012)
test('nextTask returns {task:null} with a no-pending reason when no pending tasks exist', () => {
  const tasksFile = t7File('no-pending');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([
    makeT7Task('1', 'done', 'medium', []),
    makeT7Task('2', 'cancelled', 'medium', []),
  ]));

  const result = taskCore.nextTask('ntag', { tasksFile });
  assert.ok(result, 'nextTask must return an object');
  assert.strictEqual(result.task, null, 'task must be null when no pending tasks exist');
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0,
    'reason must be a non-empty string');
  // Reason MUST mention "pending" and MUST NOT mention "block" — distinguishes from TC-017
  assert.ok(
    result.reason.toLowerCase().includes('pending'),
    `TC-018 reason must mention "pending"; got: "${result.reason}"`
  );
  assert.ok(
    !result.reason.toLowerCase().includes('block'),
    `TC-018 reason must NOT mention "block" (that is the TC-017 reason); got: "${result.reason}"`
  );
});

// Never throws — empty tag and missing tag must not throw (SD §6 D5, FR-012)
test('nextTask never throws for an empty tag or a tag that does not exist in the file', () => {
  const tasksFile = t7File('never-throws');
  taskCore._writeTasksFileAtomic(tasksFile, makeT7TagData([]));

  assert.doesNotThrow(
    () => taskCore.nextTask('ntag', { tasksFile }),
    'nextTask must not throw for an empty tag'
  );
  assert.doesNotThrow(
    () => taskCore.nextTask('missing-tag', { tasksFile }),
    'nextTask must not throw when the tag does not exist in the file'
  );
});

// ---------------------------------------------------------------------------
// Task #8 — updateTask: field updates with path injection (FR-013, FR-014)
//
// updateTask(tag, id, fields, _paths?) must:
//   - accept a _paths object for test isolation (tasksFile override)
//   - update only the keys present in fields: description, details, notes
//   - leave all other task fields unchanged
//   - ignore extra keys in fields that are not description/details/notes
//   - preserve unknown pre-existing fields already on the stored task object
//   - always refresh updatedAt (even for empty fields no-op)
//   - throw ERR_TASK_NOT_FOUND without writing when id is not found
//   - write atomically via _writeTasksFileAtomic
//
// All tests use an isolated tmp dir so the real .taskmaster/ is never touched.
// ---------------------------------------------------------------------------

const t8TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t8-'));

function t8File(suffix) {
  return path.join(t8TmpDir, `tasks-${suffix}.json`);
}

function makeT8TagData(tasks) {
  return { 'utag': { tasks, metadata: {} } };
}

function makeT8Task(id, overrides) {
  return Object.assign(
    {
      id: String(id),
      title: `Task ${id}`,
      description: 'original description',
      details: 'original details',
      testStrategy: '',
      priority: 'medium',
      dependencies: [],
      status: 'pending',
      subtasks: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    overrides || {}
  );
}

// TC-019 variant 1: update description only — other fields unchanged (FR-013)
test('updateTask updates description only; other fields remain unchanged', () => {
  const tasksFile = t8File('desc-only');
  const initialTask = makeT8Task('1');
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([initialTask]));

  const result = taskCore.updateTask('utag', '1', { description: 'new desc' }, { tasksFile });

  assert.ok(result, 'updateTask must return the updated task');
  assert.equal(result.description, 'new desc', 'description must be updated');
  // details must be untouched
  assert.equal(result.details, 'original details', 'details must remain unchanged');
  // other fields must be untouched
  assert.equal(result.title, 'Task 1', 'title must remain unchanged');
  assert.equal(result.status, 'pending', 'status must remain unchanged');
  assert.equal(result.priority, 'medium', 'priority must remain unchanged');

  // confirm file was written to the temp location
  const onDisk = taskCore._readTasksFile(tasksFile)['utag'].tasks[0];
  assert.equal(onDisk.description, 'new desc', 'persisted description must be updated');
  assert.equal(onDisk.details, 'original details', 'persisted details must be unchanged');
});

// TC-019 variant 2: update description + details together (FR-013)
test('updateTask updates description and details together when both are in fields', () => {
  const tasksFile = t8File('desc-and-details');
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([makeT8Task('1')]));

  const result = taskCore.updateTask(
    'utag', '1',
    { description: 'updated desc', details: 'updated details' },
    { tasksFile }
  );

  assert.equal(result.description, 'updated desc', 'description must be updated');
  assert.equal(result.details, 'updated details', 'details must be updated');

  const onDisk = taskCore._readTasksFile(tasksFile)['utag'].tasks[0];
  assert.equal(onDisk.description, 'updated desc', 'persisted description must match');
  assert.equal(onDisk.details, 'updated details', 'persisted details must match');
});

// TC-020: non-existent id → ERR_TASK_NOT_FOUND, no write (FR-013, SD §12.2)
test('updateTask throws ERR_TASK_NOT_FOUND for an id that does not exist', () => {
  const tasksFile = t8File('not-found');
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([makeT8Task('1')]));
  const originalBytes = fs.readFileSync(tasksFile, 'utf8');

  let thrown = null;
  try {
    taskCore.updateTask('utag', '999', { description: 'x' }, { tasksFile });
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'updateTask must throw for a non-existent id');
  assert.equal(thrown.code, 'ERR_TASK_NOT_FOUND', 'error .code must be ERR_TASK_NOT_FOUND');

  // file must be byte-unchanged (no write on error path)
  const afterBytes = fs.readFileSync(tasksFile, 'utf8');
  assert.equal(afterBytes, originalBytes, 'file must be byte-unchanged after ERR_TASK_NOT_FOUND');
});

// updatedAt refresh: always bumped, even for a no-op (empty fields) (FR-013)
test('updateTask refreshes updatedAt even when fields is empty (no-op)', () => {
  const tasksFile = t8File('updatedAt-noop');
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([makeT8Task('1')]));
  const originalUpdatedAt = '2026-01-01T00:00:00.000Z';

  const before = new Date();
  const result = taskCore.updateTask('utag', '1', {}, { tasksFile });
  const after = new Date();

  assert.ok(result, 'updateTask must return the updated task');
  const resultTime = new Date(result.updatedAt).getTime();
  assert.ok(
    resultTime >= before.getTime() && resultTime <= after.getTime(),
    'updatedAt must be a fresh ISO timestamp within the test window'
  );
  assert.notEqual(result.updatedAt, originalUpdatedAt, 'updatedAt must differ from the original value');

  // persisted updatedAt must also be refreshed
  const onDisk = taskCore._readTasksFile(tasksFile)['utag'].tasks[0];
  assert.equal(onDisk.updatedAt, result.updatedAt, 'persisted updatedAt must match the returned value');
});

// fields not included in the update remain as-is (FR-014, task #8 constraint)
test('updateTask leaves fields absent from the update object unchanged', () => {
  const tasksFile = t8File('absent-fields');
  const task = makeT8Task('1', { notes: 'existing notes' });
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([task]));

  // update only description; notes and details must survive
  const result = taskCore.updateTask('utag', '1', { description: 'changed' }, { tasksFile });

  assert.equal(result.details, 'original details', 'details must be unchanged when not in fields');
  // notes was set on the original task and must survive the partial update
  assert.equal(result.notes, 'existing notes', 'notes must be unchanged when not in fields');
  assert.equal(result.description, 'changed', 'description must be updated');
});

// UNKNOWN pre-existing fields preserved (pass-through, FR-014 backward-compat)
test('updateTask preserves unknown fields already present on the stored task', () => {
  const tasksFile = t8File('unknown-fields');
  // Simulate a task written by task-master-ai@0.43.1 with extra fields we don't know about
  const task = makeT8Task('1', {
    customFieldFromOldVersion: 'keep-me',
    anotherUnknownField: 42,
  });
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([task]));

  const result = taskCore.updateTask('utag', '1', { description: 'updated' }, { tasksFile });

  // Unknown fields must survive the update (pass-through, no stripping)
  assert.equal(result.customFieldFromOldVersion, 'keep-me',
    'unknown field "customFieldFromOldVersion" must be preserved after update');
  assert.equal(result.anotherUnknownField, 42,
    'unknown numeric field "anotherUnknownField" must be preserved after update');
  assert.equal(result.description, 'updated', 'description must be updated');

  // Also verify on disk
  const onDisk = taskCore._readTasksFile(tasksFile)['utag'].tasks[0];
  assert.equal(onDisk.customFieldFromOldVersion, 'keep-me', 'unknown field must be preserved on disk');
});

// empty fields object = no-op on data, but updatedAt is still bumped and file written (FR-013)
test('updateTask with empty fields writes file with only updatedAt changed', () => {
  const tasksFile = t8File('empty-fields-write');
  taskCore._writeTasksFileAtomic(tasksFile, makeT8TagData([makeT8Task('1')]));

  const result = taskCore.updateTask('utag', '1', {}, { tasksFile });

  // description and details must be the originals
  assert.equal(result.description, 'original description', 'description must be unchanged');
  assert.equal(result.details, 'original details', 'details must be unchanged');
  // but the file was written (updatedAt changed)
  const onDisk = taskCore._readTasksFile(tasksFile)['utag'].tasks[0];
  assert.equal(onDisk.description, 'original description', 'persisted description must be original');
  assert.equal(onDisk.updatedAt, result.updatedAt, 'persisted updatedAt must match returned');
  assert.notEqual(onDisk.updatedAt, '2026-01-01T00:00:00.000Z', 'updatedAt must have been bumped');
});

// ---------------------------------------------------------------------------
// Task #10 — TC-022: Backward compatibility with task-master-ai@0.43.1 schema
// (FR-015, FR-014, NFR-003)
//
// Simulates a tasks.json file written by task-master-ai@0.43.1. That tool may
// write fields beyond the core schema: complexity, recommendedSubtasks,
// expansionPrompt, and others. The task description also uses
// `taskmaster-model-override` as a canonical tag generated by 0.43.1.
//
// Assertions:
//   1. listTasks reads the file without error; stats computed correctly.
//   2. setStatus on a task updates status but preserves ALL extra fields on disk.
//   3. updateTask on a task updates description but preserves ALL extra fields.
//   4. addTask in the same tag adds a new task; existing tasks' extra fields survive.
//   5. nextTask reads the file without error and returns the correct eligible task.
//   6. getTask finds a task by id; extra fields are present on the returned object.
// ---------------------------------------------------------------------------

const t10TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t10-'));

function t10File(suffix) {
  return path.join(t10TmpDir, `tasks-${suffix}.json`);
}

/**
 * Build a tasks.json data object that mimics task-master-ai@0.43.1 output:
 * - Two tags: 'taskmaster-model-override' (0.43.1's own management tag) and
 *   'native-task-manager-storage-core' (a real feature tag from the project).
 * - Tasks include ALL standard schema fields PLUS the extra fields 0.43.1 adds
 *   via the `expand` command: complexity, recommendedSubtasks, expansionPrompt.
 */
function make043Fixture() {
  return {
    'taskmaster-model-override': {
      tasks: [
        {
          id: '1',
          title: 'Set provider override',
          description: 'Override the LLM provider for this session',
          details: 'Use the model-override mechanism to pin a specific provider.',
          testStrategy: 'Manual: verify provider is overridden.',
          priority: 'high',
          dependencies: [],
          status: 'done',
          subtasks: [],
          complexity: 2,
          recommendedSubtasks: 0,
          expansionPrompt: 'Expand into sub-steps for provider override flow.',
          updatedAt: '2026-07-24T00:00:00.000Z',
        },
        {
          id: '2',
          title: 'Validate model response',
          description: 'Ensure the overridden model responds correctly.',
          details: 'Send a test prompt; check the response format.',
          testStrategy: 'Unit test the response shape.',
          priority: 'medium',
          dependencies: ['1'],
          status: 'pending',
          subtasks: [],
          complexity: 3,
          recommendedSubtasks: 2,
          expansionPrompt: 'Break into: send prompt, validate shape, report result.',
          updatedAt: '2026-07-24T01:00:00.000Z',
        },
      ],
      metadata: {
        version: '1.0.0',
        lastModified: '2026-07-24T01:00:00.000Z',
        taskCount: 2,
        completedCount: 1,
        tags: ['taskmaster-model-override'],
      },
    },
    'native-task-manager-storage-core': {
      tasks: [
        {
          id: '1',
          title: 'Create task-core module structure',
          description: 'Set up the core storage module with CommonJS exports.',
          details: 'Create lib/task-core.cjs following the existing patterns.',
          testStrategy: 'Unit test: module imports without throwing.',
          priority: 'high',
          dependencies: [],
          status: 'done',
          subtasks: [],
          complexity: 5,
          recommendedSubtasks: 3,
          expansionPrompt: 'Break into: scaffold, exports, constants, tests.',
          updatedAt: '2026-07-24T03:00:00.000Z',
        },
        {
          id: '2',
          title: 'Implement atomic file read/write',
          description: 'Build internal helpers for atomic JSON file operations.',
          details: 'Write-temp-then-rename pattern for crash safety.',
          testStrategy: 'Mock renameSync; verify original file intact on failure.',
          priority: 'high',
          dependencies: ['1'],
          status: 'pending',
          subtasks: [
            {
              id: '1',
              title: 'Write _readTasksFile helper',
              status: 'done',
              updatedAt: '2026-07-24T02:00:00.000Z',
            },
            {
              id: '2',
              title: 'Write _writeTasksFileAtomic helper',
              status: 'pending',
              updatedAt: '2026-07-24T02:00:00.000Z',
            },
          ],
          complexity: 7,
          recommendedSubtasks: 2,
          expansionPrompt: 'Break into: read helper, write helper, atomic rename test.',
          updatedAt: '2026-07-24T02:00:00.000Z',
        },
      ],
      metadata: {
        version: '1.0.0',
        lastModified: '2026-07-24T03:00:00.000Z',
        taskCount: 2,
        completedCount: 1,
        tags: ['native-task-manager-storage-core'],
      },
    },
  };
}

// TC-022a: listTasks on a 0.43.1 file reads without error; stats are correct (FR-015, FR-007)
test('TC-022: listTasks reads a task-master-ai@0.43.1 file without error and computes stats correctly', () => {
  const tasksFile = t10File('compat-list');
  taskCore._writeTasksFileAtomic(tasksFile, make043Fixture());

  // The taskmaster-model-override tag has 1 done, 1 pending
  const result = taskCore.listTasks('taskmaster-model-override', {}, { tasksFile });

  assert.ok(result && Array.isArray(result.tasks), 'listTasks must return { tasks: [...] }');
  assert.equal(result.tasks.length, 2, 'must return both tasks');
  assert.ok(result.stats, 'stats must be present');
  assert.equal(result.stats.done, 1, 'stats.done must be 1');
  assert.equal(result.stats.pending, 1, 'stats.pending must be 1');
  // completionPercentage = Math.round(1 / (2 - 0) * 100) = 50
  assert.equal(result.stats.completionPercentage, 50, 'completionPercentage must be 50 (1 done / 2 total)');
  // Extra fields must be present on the returned task objects
  const task2 = result.tasks.find((t) => t.id === '2');
  assert.ok(task2, 'task with id="2" must be returned');
  assert.equal(task2.complexity, 3, 'complexity field from 0.43.1 must be present in listTasks result');
  assert.equal(task2.recommendedSubtasks, 2, 'recommendedSubtasks field from 0.43.1 must be present');
  assert.equal(typeof task2.expansionPrompt, 'string', 'expansionPrompt field from 0.43.1 must be present');
});

// TC-022b: setStatus on a 0.43.1 file preserves ALL extra fields on the task and other tasks (FR-014, FR-015)
test('TC-022: setStatus on a 0.43.1 file preserves extra fields (complexity, recommendedSubtasks, expansionPrompt)', () => {
  const tasksFile = t10File('compat-setstatus');
  taskCore._writeTasksFileAtomic(tasksFile, make043Fixture());

  // Change task '2' from pending to in-progress in 'taskmaster-model-override'
  const result = taskCore.setStatus('taskmaster-model-override', '2', 'in-progress', { tasksFile });

  assert.equal(result.status, 'in-progress', 'status must be updated');

  // Read back from disk and verify every extra field survives the atomic write
  const onDisk = taskCore._readTasksFile(tasksFile);
  const t2 = onDisk['taskmaster-model-override'].tasks.find((t) => t.id === '2');
  assert.ok(t2, 'task "2" must be present after setStatus');
  assert.equal(t2.status, 'in-progress', 'status must be persisted');
  assert.equal(t2.complexity, 3, 'complexity must be preserved after setStatus');
  assert.equal(t2.recommendedSubtasks, 2, 'recommendedSubtasks must be preserved after setStatus');
  assert.ok(t2.expansionPrompt && t2.expansionPrompt.length > 0, 'expansionPrompt must be preserved after setStatus');

  // The UNTOUCHED task (id='1') must also be unchanged
  const t1 = onDisk['taskmaster-model-override'].tasks.find((t) => t.id === '1');
  assert.equal(t1.complexity, 2, 'complexity on untouched task must be unchanged');
  assert.equal(t1.status, 'done', 'status on untouched task must remain done');

  // The OTHER tag must be entirely untouched
  const otherTag = onDisk['native-task-manager-storage-core'];
  assert.ok(otherTag, 'other tag must be preserved');
  assert.equal(otherTag.tasks.length, 2, 'other tag must have 2 tasks');
  assert.equal(otherTag.tasks[0].complexity, 5, 'other tag extra fields must be preserved');
});

// TC-022c: updateTask on a 0.43.1 file preserves ALL extra fields (FR-014, FR-015)
test('TC-022: updateTask on a 0.43.1 file preserves extra fields and metadata', () => {
  const tasksFile = t10File('compat-updatetask');
  taskCore._writeTasksFileAtomic(tasksFile, make043Fixture());

  // Update task '1' description in 'native-task-manager-storage-core'
  const result = taskCore.updateTask(
    'native-task-manager-storage-core', '1',
    { description: 'Updated description for backward-compat test' },
    { tasksFile }
  );

  assert.equal(result.description, 'Updated description for backward-compat test', 'description must be updated');

  // All extra fields must survive the atomic rewrite
  const onDisk = taskCore._readTasksFile(tasksFile);
  const t1 = onDisk['native-task-manager-storage-core'].tasks.find((t) => t.id === '1');
  assert.equal(t1.complexity, 5, 'complexity must be preserved after updateTask');
  assert.equal(t1.recommendedSubtasks, 3, 'recommendedSubtasks must be preserved after updateTask');
  assert.ok(t1.expansionPrompt && t1.expansionPrompt.length > 0, 'expansionPrompt must be preserved after updateTask');

  // Verify both tags are preserved in the file (schema not collapsed)
  assert.ok(onDisk['taskmaster-model-override'], 'taskmaster-model-override tag must be preserved');
  assert.ok(onDisk['native-task-manager-storage-core'], 'native-task-manager-storage-core tag must be preserved');

  // Tag metadata must be preserved
  const metadata = onDisk['native-task-manager-storage-core'].metadata;
  assert.ok(metadata, 'metadata object must be preserved');
  assert.equal(metadata.version, '1.0.0', 'metadata.version must be preserved');
});

// TC-022d: addTask in a 0.43.1 file adds a new task without disturbing existing tasks' extra fields (FR-014, FR-015)
test('TC-022: addTask in a 0.43.1 file preserves extra fields on existing tasks', () => {
  const tasksFile = t10File('compat-addtask');
  const stateFile = t10File('compat-state');
  taskCore._writeTasksFileAtomic(tasksFile, make043Fixture());

  const newTask = taskCore.addTask(
    'native-task-manager-storage-core',
    { title: 'New task after compat load', priority: 'low' },
    { tasksFile, stateFile }
  );

  assert.ok(newTask, 'addTask must return the new task');
  assert.equal(newTask.id, '3', 'new task must have id="3" (auto-increment after existing 1,2)');

  // Existing tasks' extra fields must survive
  const onDisk = taskCore._readTasksFile(tasksFile);
  const existingTasks = onDisk['native-task-manager-storage-core'].tasks;
  const t1 = existingTasks.find((t) => t.id === '1');
  const t2 = existingTasks.find((t) => t.id === '2');
  assert.equal(t1.complexity, 5, 'existing task 1 complexity must be preserved after addTask');
  assert.equal(t2.complexity, 7, 'existing task 2 complexity must be preserved after addTask');
  assert.equal(t2.subtasks.length, 2, 'existing task 2 subtasks must be preserved after addTask');
  assert.equal(existingTasks.length, 3, 'tag must now have 3 tasks');
});

// TC-022e: nextTask on a 0.43.1 file returns the correct eligible task (FR-011, FR-015)
test('TC-022: nextTask on a 0.43.1 file returns the eligible task without error', () => {
  const tasksFile = t10File('compat-nexttask');
  taskCore._writeTasksFileAtomic(tasksFile, make043Fixture());

  // In 'taskmaster-model-override': task '1' is done, task '2' is pending with dep=['1']
  // nextTask must return task '2' since its dep '1' is done
  const result = taskCore.nextTask('taskmaster-model-override', { tasksFile });

  assert.ok(result && result.task, 'nextTask must return an eligible task from the 0.43.1 file');
  assert.equal(result.task.id, '2', 'must return task "2" whose dep "1" is done');
  // Extra fields must be present on the returned task
  assert.equal(result.task.complexity, 3, 'complexity must be present on the task returned by nextTask');
});

// TC-022f: getTask on a 0.43.1 file returns the task with all extra fields intact (FR-005, FR-015)
test('TC-022: getTask on a 0.43.1 file returns task with extra fields from 0.43.1', () => {
  const tasksFile = t10File('compat-gettask');
  taskCore._writeTasksFileAtomic(tasksFile, make043Fixture());

  const task = taskCore.getTask('native-task-manager-storage-core', '2', { tasksFile });

  assert.ok(task, 'getTask must return the task from the 0.43.1 file');
  assert.equal(task.id, '2', 'must return task with id="2"');
  assert.equal(task.complexity, 7, 'complexity from 0.43.1 must be present on getTask result');
  assert.equal(task.recommendedSubtasks, 2, 'recommendedSubtasks from 0.43.1 must be present');
  assert.ok(typeof task.expansionPrompt === 'string', 'expansionPrompt from 0.43.1 must be present');
  // Subtasks must be intact
  assert.ok(Array.isArray(task.subtasks) && task.subtasks.length === 2, 'subtasks must be preserved');
});

// ---------------------------------------------------------------------------
// Task #10 — TC-023: addTask does not write extra/unknown fields (FR-014)
//
// When `fields` contains keys not in the schema (id, title, description,
// details, testStrategy, priority, dependencies, status, subtasks, updatedAt),
// those extra keys must NOT appear in the task written to tasks.json.
// This prevents storage layer pollution when callers pass through rich objects.
// ---------------------------------------------------------------------------

const t10bTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-core-t10b-'));

function t10bFile(suffix) {
  return path.join(t10bTmpDir, `tasks-${suffix}.json`);
}

/** Schema field names for a task written by addTask (SD §7.1, FR-003). */
const SCHEMA_TASK_FIELDS = new Set([
  'id', 'title', 'description', 'details', 'testStrategy',
  'priority', 'dependencies', 'status', 'subtasks', 'updatedAt',
]);

// TC-023: addTask does not persist unknown keys from the fields argument (FR-014)
test('TC-023: addTask does not write unknown fields from the fields argument to tasks.json', () => {
  const tasksFile = t10bFile('no-extra-fields');
  const paths = { tasksFile, stateFile: t10bFile('state-unused') };

  // Pass extra unknown fields in the fields argument; they must be silently dropped.
  taskCore.addTask('feat-x', {
    title: 'Schema-clean task',
    description: 'Should only have schema fields',
    complexity: 99,           // extra — must NOT appear in output
    recommendedSubtasks: 5,   // extra — must NOT appear in output
    expansionPrompt: 'foo',   // extra — must NOT appear in output
    internalMeta: { a: 1 },   // extra — must NOT appear in output
  }, paths);

  const onDisk = taskCore._readTasksFile(tasksFile);
  const task = onDisk['feat-x'].tasks[0];
  assert.ok(task, 'task must be written');

  // Verify no keys outside SCHEMA_TASK_FIELDS are present
  const writtenKeys = Object.keys(task);
  for (const key of writtenKeys) {
    assert.ok(
      SCHEMA_TASK_FIELDS.has(key),
      `unexpected field "${key}" written to tasks.json by addTask — only schema fields are allowed`
    );
  }

  // Verify all schema fields ARE present
  for (const key of SCHEMA_TASK_FIELDS) {
    assert.ok(key in task, `schema field "${key}" must be present in the written task`);
  }
});

// TC-023 variant: addTask with only the required title field writes exactly the schema fields (FR-003, FR-014)
test('TC-023: addTask with only required title field writes exactly the schema fields and no more', () => {
  const tasksFile = t10bFile('minimal-fields');
  const paths = { tasksFile, stateFile: t10bFile('state-minimal-unused') };

  taskCore.addTask('feat-minimal', { title: 'Minimal task' }, paths);

  const onDisk = taskCore._readTasksFile(tasksFile);
  const task = onDisk['feat-minimal'].tasks[0];
  assert.ok(task, 'task must be written');

  const writtenKeys = Object.keys(task);
  assert.equal(writtenKeys.length, SCHEMA_TASK_FIELDS.size,
    `task must have exactly ${SCHEMA_TASK_FIELDS.size} fields; got: ${writtenKeys.join(', ')}`);
  for (const key of writtenKeys) {
    assert.ok(SCHEMA_TASK_FIELDS.has(key), `unexpected field "${key}" in minimal addTask output`);
  }
});

// ---------------------------------------------------------------------------
// Task #10 — Additional edge cases
// ---------------------------------------------------------------------------

// Edge: _readTasksFile with malformed JSON throws SyntaxError (FR-002)
// The implementation intentionally propagates SyntaxError for corrupt tasks.json
// so the caller detects corruption immediately rather than silently discarding data.
test('_readTasksFile throws SyntaxError for a file with malformed JSON content', () => {
  const malformedPath = path.join(t10bTmpDir, 'malformed.json');
  fs.writeFileSync(malformedPath, '{ not: valid json !!!', 'utf8');

  assert.throws(
    () => taskCore._readTasksFile(malformedPath),
    (e) => e instanceof SyntaxError,
    '_readTasksFile must throw SyntaxError for malformed JSON (corrupt tasks.json must surface)'
  );
});

// Edge: addTask with empty string tag is treated the same as no tag (FR-004)
// Empty string is falsy in JS; addTask falls through to state.json lookup,
// then throws ERR_NO_TAG when state.json is absent — same as undefined tag.
test('addTask with empty string tag throws ERR_NO_TAG when state.json is absent (FR-004)', () => {
  const tasksFile = t10bFile('empty-tag-str');
  const paths = { tasksFile, stateFile: path.join(t10bTmpDir, 'nonexistent-state-2.json') };

  let thrown;
  try {
    taskCore.addTask('', { title: 'Empty tag task' }, paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw when tag is empty string and state.json is absent');
  assert.equal(thrown.code, 'ERR_NO_TAG', '.code must be ERR_NO_TAG');
});

// Edge: listTasks on a tag that does not exist in the file returns empty tasks + zero stats (FR-006)
test('listTasks returns empty tasks array and zero stats for a tag that does not exist', () => {
  const tasksFile = t10bFile('missing-tag-list');
  taskCore._writeTasksFileAtomic(tasksFile, { 'some-other-tag': { tasks: [], metadata: {} } });

  const result = taskCore.listTasks('nonexistent-tag', {}, { tasksFile });
  assert.ok(result && Array.isArray(result.tasks), 'must return { tasks: [...] }');
  assert.equal(result.tasks.length, 0, 'tasks must be empty for a nonexistent tag');
  assert.equal(result.stats.completionPercentage, 0, 'completionPercentage must be 0');
  for (const s of taskCore.VALID_STATUSES) {
    assert.equal(result.stats[s], 0, `stats.${s} must be 0 for a nonexistent tag`);
  }
});

// Edge: task with some optional fields missing from the file is read correctly (FR-001)
// Simulates a minimally-written task (e.g., from an old version or manual edit).
test('getTask handles a task with missing optional fields without throwing', () => {
  const tasksFile = t10bFile('minimal-task');
  // Minimal task: only id and title, no other fields
  const minimalData = {
    'min-tag': {
      tasks: [{ id: '1', title: 'Minimal', status: 'pending' }],
      metadata: {},
    },
  };
  taskCore._writeTasksFileAtomic(tasksFile, minimalData);

  let result;
  assert.doesNotThrow(
    () => { result = taskCore.getTask('min-tag', '1', { tasksFile }); },
    'getTask must not throw for a task with missing optional fields'
  );
  assert.ok(result, 'must return the task');
  assert.equal(result.id, '1');
  assert.equal(result.title, 'Minimal');
});

// Edge: nextTask handles tasks with missing optional fields (dependencies absent) (FR-011, FR-016)
test('nextTask handles tasks with missing dependencies field without throwing', () => {
  const tasksFile = t10bFile('missing-deps-field');
  // Task has no dependencies field at all
  const data = {
    'dep-tag': {
      tasks: [{ id: '1', title: 'No deps field', status: 'pending', priority: 'medium' }],
      metadata: {},
    },
  };
  taskCore._writeTasksFileAtomic(tasksFile, data);

  let result;
  assert.doesNotThrow(
    () => { result = taskCore.nextTask('dep-tag', { tasksFile }); },
    'nextTask must not throw when a task has no dependencies field'
  );
  // Task with no dependencies field should be treated as eligible (empty deps = no blockers)
  assert.ok(result && result.task, 'task with absent dependencies field must be eligible');
  assert.equal(result.task.id, '1');
});

// Edge: id as number vs string — setStatus accepts numeric id (FR-008)
test('setStatus finds the task when id is passed as a number instead of a string', () => {
  const tasksFile = t10bFile('setstatus-num-id');
  taskCore._writeTasksFileAtomic(tasksFile, {
    'num-tag': {
      tasks: [
        {
          id: '5', title: 'Task 5', description: '', details: '', testStrategy: '',
          priority: 'medium', dependencies: [], status: 'pending', subtasks: [],
          updatedAt: '2026-07-24T00:00:00.000Z',
        },
      ],
      metadata: {},
    },
  });

  let result;
  assert.doesNotThrow(
    () => { result = taskCore.setStatus('num-tag', 5, 'done', { tasksFile }); },
    'setStatus must not throw when id is a number'
  );
  assert.equal(result.status, 'done', 'task must be updated to done when id is numeric');
});

// Edge: updateTask with id as number (FR-013)
test('updateTask finds the task when id is passed as a number instead of a string', () => {
  const tasksFile = t10bFile('updatetask-num-id');
  taskCore._writeTasksFileAtomic(tasksFile, {
    'num-tag2': {
      tasks: [
        {
          id: '3', title: 'Task 3', description: 'original', details: '', testStrategy: '',
          priority: 'medium', dependencies: [], status: 'pending', subtasks: [],
          updatedAt: '2026-07-24T00:00:00.000Z',
        },
      ],
      metadata: {},
    },
  });

  let result;
  assert.doesNotThrow(
    () => { result = taskCore.updateTask('num-tag2', 3, { description: 'updated' }, { tasksFile }); },
    'updateTask must not throw when id is a number'
  );
  assert.equal(result.description, 'updated', 'task description must be updated when id is numeric');
});
