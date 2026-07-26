/**
 * Unit tests for lib/task-importer.cjs — TaskImporter module.
 *
 * Covers:
 *   TC-004: 3 valid tasks → tasks.json[tag].tasks has 3 entries, all status 'pending'.
 *   TC-005: task with status 'in-progress' → normalization forces status to 'pending'.
 *   TC-006: batch with one task missing 'title' → throws ERR_AI_SCHEMA_INVALID AND
 *           tasks.json is byte-identical before and after (reject-entire-batch, D3).
 *   TC-011: imported tasks retain all required schema fields.
 *   tag validation: non-empty string required, throw on falsy tag.
 *   importSubtasks: happy path, subtask ids follow <parent>.<n> pattern.
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths so the
 * real .taskmaster/ is NEVER touched during testing.
 *
 * Run: node test/task-importer.test.cjs
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

let taskImporter;
test('task-importer module imports without throwing', () => {
  taskImporter = require('../lib/task-importer.cjs');
});

// ---------------------------------------------------------------------------
// Helper utilities — each test gets its own isolated tmp directory.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-importer-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
  };
}

/**
 * Build a fully valid task object satisfying validateTaskSchema requirements.
 * All required fields: id, title, description, status, priority, dependencies,
 * subtasks, updatedAt.
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

// ---------------------------------------------------------------------------
// TC-004: 3 valid tasks → tasks.json[tag].tasks has 3 entries, all 'pending'
// (FR-003, FR-004 — importTasks writes batch to the tag namespace)
// ---------------------------------------------------------------------------

test('importTasks writes 3 valid tasks to the tag namespace with status pending (TC-004)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const tasks = [
    makeValidTask({ id: '1', title: 'Task one' }),
    makeValidTask({ id: '2', title: 'Task two' }),
    makeValidTask({ id: '3', title: 'Task three' }),
  ];

  const result = taskImporter.importTasks('feat-tc004', tasks, undefined, _paths);

  assert.equal(result.imported, 3, 'importTasks must return { imported: 3 }');

  // Verify on-disk content
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const tagData = stored['feat-tc004'];
  assert.ok(tagData, 'Tag namespace must exist in tasks.json');
  assert.ok(Array.isArray(tagData.tasks), 'tag.tasks must be an array');
  assert.equal(tagData.tasks.length, 3, 'tasks.json[tag].tasks must have 3 entries');

  // All statuses must be 'pending' after normalization
  for (const t of tagData.tasks) {
    assert.equal(t.status, 'pending',
      `Task ${t.id} status must be 'pending' after import`);
  }
});

// ---------------------------------------------------------------------------
// TC-005: task with status 'in-progress' → normalized to 'pending'
// (D4/BL-05 — forceStatus normalization)
// ---------------------------------------------------------------------------

test('importTasks normalizes task status in-progress to pending (TC-005)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Status 'in-progress' must be accepted (it is a valid status for schema validation)
  // but normalized to 'pending' on import.
  const tasks = [
    makeValidTask({ id: '1', title: 'In-progress task', status: 'in-progress' }),
  ];

  taskImporter.importTasks('feat-tc005', tasks, undefined, _paths);

  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedTask = stored['feat-tc005'].tasks[0];
  assert.equal(storedTask.status, 'pending',
    'Status in-progress must be normalized to pending on import (TC-005)');
});

// ---------------------------------------------------------------------------
// TC-006: batch with one invalid task → throws ERR_AI_SCHEMA_INVALID AND
//         tasks.json is byte-identical before and after (reject-entire-batch, D3)
// ---------------------------------------------------------------------------

test('importTasks rejects entire batch when one task is invalid, tasks.json unchanged (TC-006)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Pre-populate tasks.json so we can compare bytes before/after
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  const initialContent = JSON.stringify({ 'feat-tc006': { tasks: [], metadata: {} } }, null, 2);
  fs.writeFileSync(_paths.tasksFile, initialContent, 'utf8');

  // Read exact bytes before the failed import attempt
  const bytesBefore = fs.readFileSync(_paths.tasksFile);

  // Batch: task 1 valid, task 2 missing 'title' (required field)
  const tasks = [
    makeValidTask({ id: '1', title: 'Valid task' }),
    { id: '2', description: 'No title field', status: 'pending', priority: 'medium',
      dependencies: [], subtasks: [], updatedAt: '2026-07-26T00:00:00.000Z' },
  ];

  let thrown;
  try {
    taskImporter.importTasks('feat-tc006', tasks, undefined, _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'importTasks must throw when any task is invalid');
  assert.equal(thrown.code, 'ERR_AI_SCHEMA_INVALID',
    'thrown error .code must be ERR_AI_SCHEMA_INVALID');
  assert.ok(thrown.message.includes('2') || thrown.message.includes('title'),
    'error message must reference the offending task id or field');

  // Byte-identical check — file must be unchanged (TC-006 D3 reject-entire-batch)
  const bytesAfter = fs.readFileSync(_paths.tasksFile);
  assert.equal(
    Buffer.compare(bytesBefore, bytesAfter),
    0,
    'tasks.json must be byte-identical before and after a rejected batch (TC-006)'
  );
});

// ---------------------------------------------------------------------------
// TC-011: imported tasks retain all required schema fields
// (FR-012 — schema-conforming tasks survive round-trip)
// ---------------------------------------------------------------------------

test('importTasks retains all required schema fields on imported tasks (TC-011)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const task = makeValidTask({
    id: '7',
    title: 'Schema field retention test',
    description: 'Ensure all fields are retained.',
    priority: 'high',
    dependencies: ['2', '3'],
    subtasks: [],
    updatedAt: '2026-01-15T12:00:00.000Z',
    details: 'Extended details.',
    testStrategy: 'Run all unit tests.',
  });

  taskImporter.importTasks('feat-tc011', [task], undefined, _paths);

  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedTask = stored['feat-tc011'].tasks[0];

  // All required schema fields must be present and match (except status, which is normalized)
  assert.equal(storedTask.id, '7', 'id must be retained');
  assert.equal(storedTask.title, 'Schema field retention test', 'title must be retained');
  assert.equal(storedTask.description, 'Ensure all fields are retained.', 'description must be retained');
  assert.equal(storedTask.priority, 'high', 'priority must be retained');
  assert.deepEqual(storedTask.dependencies, ['2', '3'], 'dependencies must be retained');
  assert.deepEqual(storedTask.subtasks, [], 'subtasks must be retained');
  assert.equal(storedTask.updatedAt, '2026-01-15T12:00:00.000Z', 'updatedAt must be retained');
  assert.equal(storedTask.details, 'Extended details.', 'optional details must be retained');
  assert.equal(storedTask.testStrategy, 'Run all unit tests.', 'optional testStrategy must be retained');
  // Status is normalized to pending by importTasks
  assert.equal(storedTask.status, 'pending', 'status must be normalized to pending');
});

// ---------------------------------------------------------------------------
// Tag validation: non-empty string required
// ---------------------------------------------------------------------------

test('importTasks throws when tag is empty string', () => {
  let thrown;
  try {
    taskImporter.importTasks('', [], undefined, {});
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'importTasks must throw when tag is empty string');
});

test('importTasks throws when tag is null', () => {
  let thrown;
  try {
    taskImporter.importTasks(null, [], undefined, {});
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'importTasks must throw when tag is null');
});

// ---------------------------------------------------------------------------
// importSubtasks happy path: subtask ids follow <parent>.<n> pattern
// (FR-003, FR-012 — delegates to addSubtask)
// ---------------------------------------------------------------------------

test('importSubtasks adds subtasks with hierarchical ids <parent>.<n>', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // First, import a parent task so the tag and parent exist
  const parentTask = makeValidTask({ id: '1', title: 'Parent task' });
  taskImporter.importTasks('feat-subtasks', [parentTask], undefined, _paths);

  // Now import two subtasks
  const subtasks = [
    { title: 'Subtask A', description: 'Desc A' },
    { title: 'Subtask B', description: 'Desc B' },
  ];
  taskImporter.importSubtasks('feat-subtasks', '1', subtasks, _paths);

  // Verify on-disk ids
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedParent = stored['feat-subtasks'].tasks.find((t) => t.id === '1');
  assert.ok(storedParent, 'Parent task must exist in tasks.json');
  assert.equal(storedParent.subtasks.length, 2,
    'Parent must have 2 subtasks after importSubtasks');
  assert.equal(storedParent.subtasks[0].id, '1.1',
    'First subtask id must be "1.1"');
  assert.equal(storedParent.subtasks[1].id, '1.2',
    'Second subtask id must be "1.2"');
});

// ---------------------------------------------------------------------------
// importSubtasks rejects entire batch when any subtask is invalid
// ---------------------------------------------------------------------------

test('importSubtasks throws ERR_AI_SCHEMA_INVALID when a subtask has no title', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Set up tag with parent task
  const parentTask = makeValidTask({ id: '5', title: 'Parent for bad subtask' });
  taskImporter.importTasks('feat-bad-sub', [parentTask], undefined, _paths);

  // Subtask 1 valid, subtask 2 missing title (empty string fails minLength check)
  const subtasks = [
    { title: 'Good subtask' },
    { title: '' }, // empty title — invalid
  ];

  let thrown;
  try {
    taskImporter.importSubtasks('feat-bad-sub', '5', subtasks, _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'importSubtasks must throw when any subtask is invalid');
  assert.equal(thrown.code, 'ERR_AI_SCHEMA_INVALID',
    'thrown error .code must be ERR_AI_SCHEMA_INVALID for invalid subtask batch');

  // Confirm no subtasks were written (reject-entire-batch)
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedParent = stored['feat-bad-sub'].tasks.find((t) => t.id === '5');
  assert.equal(storedParent.subtasks.length, 0,
    'No subtasks must be written when the batch is rejected (reject-entire-batch)');
});

// ---------------------------------------------------------------------------
// importTasks with custom forceStatus option
// ---------------------------------------------------------------------------

test('importTasks respects custom forceStatus option (e.g. deferred)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const tasks = [
    makeValidTask({ id: '1', title: 'Force deferred', status: 'pending' }),
  ];

  taskImporter.importTasks('feat-force-status', tasks, { forceStatus: 'deferred' }, _paths);

  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedTask = stored['feat-force-status'].tasks[0];
  assert.equal(storedTask.status, 'deferred',
    'importTasks must apply custom forceStatus when provided');
});

// ---------------------------------------------------------------------------
// importTasks into an already-existing tag replaces tasks (not appends)
// ---------------------------------------------------------------------------

test('importTasks into existing tag replaces tasks array (not appends)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // First import
  taskImporter.importTasks('feat-replace',
    [makeValidTask({ id: '1', title: 'Original' })], undefined, _paths);

  // Second import — should replace, not append
  taskImporter.importTasks('feat-replace',
    [makeValidTask({ id: '10', title: 'Replacement A' }),
     makeValidTask({ id: '11', title: 'Replacement B' })], undefined, _paths);

  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  assert.equal(stored['feat-replace'].tasks.length, 2,
    'Second importTasks must replace the tasks array, not append');
  assert.equal(stored['feat-replace'].tasks[0].id, '10',
    'First task after replace must be "10"');
});
