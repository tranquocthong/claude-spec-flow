/**
 * Unit tests for lib/task-schema.cjs — Task JSON schema + hand-rolled validator.
 *
 * Covers: TASK_SCHEMA export shape, validateTaskSchema() behaviour for valid
 * and invalid tasks. Mirrors the conventions used by task-core.test.cjs:
 * node:test + node:assert/strict, no external dependencies.
 *
 * Run:  node test/task-schema.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import
// ---------------------------------------------------------------------------

let taskSchema;
test('task-schema module imports without throwing', () => {
  taskSchema = require('../lib/task-schema.cjs');
});

// ---------------------------------------------------------------------------
// TASK_SCHEMA export — must be a plain object describing the Task shape
// ---------------------------------------------------------------------------

test('TASK_SCHEMA is exported as an object', () => {
  assert.ok(taskSchema.TASK_SCHEMA && typeof taskSchema.TASK_SCHEMA === 'object',
    'TASK_SCHEMA must be an exported object');
});

test('TASK_SCHEMA lists id as a required field', () => {
  assert.ok(
    Array.isArray(taskSchema.TASK_SCHEMA.required) &&
    taskSchema.TASK_SCHEMA.required.includes('id'),
    'TASK_SCHEMA.required must include id'
  );
});

test('TASK_SCHEMA lists title as a required field', () => {
  assert.ok(
    Array.isArray(taskSchema.TASK_SCHEMA.required) &&
    taskSchema.TASK_SCHEMA.required.includes('title'),
    'TASK_SCHEMA.required must include title'
  );
});

test('TASK_SCHEMA lists status enum values matching VALID_STATUSES', () => {
  const { VALID_STATUSES } = require('../lib/task-core.cjs');
  const statusEnum = taskSchema.TASK_SCHEMA.properties.status.enum;
  assert.deepEqual(statusEnum, VALID_STATUSES,
    'TASK_SCHEMA status enum must match VALID_STATUSES from task-core');
});

test('TASK_SCHEMA lists priority enum values matching VALID_PRIORITIES', () => {
  const { VALID_PRIORITIES } = require('../lib/task-core.cjs');
  const priorityEnum = taskSchema.TASK_SCHEMA.properties.priority.enum;
  assert.deepEqual(priorityEnum, VALID_PRIORITIES,
    'TASK_SCHEMA priority enum must match VALID_PRIORITIES from task-core');
});

// ---------------------------------------------------------------------------
// validateTaskSchema export
// ---------------------------------------------------------------------------

test('validateTaskSchema is exported as a function', () => {
  assert.equal(typeof taskSchema.validateTaskSchema, 'function',
    'validateTaskSchema must be a function');
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid task object
// ---------------------------------------------------------------------------

function validTask() {
  return {
    id: '1',
    title: 'Implement something',
    description: 'A description',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TC-006: valid task → { valid: true, errors: [] }
// ---------------------------------------------------------------------------

test('valid task returns { valid: true, errors: [] }', () => {
  const result = taskSchema.validateTaskSchema(validTask());
  assert.equal(result.valid, true, 'valid task must return valid: true');
  assert.deepEqual(result.errors, [], 'valid task must return empty errors array');
});

// ---------------------------------------------------------------------------
// Missing required fields
// ---------------------------------------------------------------------------

test('missing title field returns invalid with a title error', () => {
  const task = validTask();
  delete task.title;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false, 'missing title must be invalid');
  const titleError = result.errors.find((e) => e.field === 'title');
  assert.ok(titleError, 'errors must contain an entry with field: "title"');
  assert.ok(typeof titleError.reason === 'string' && titleError.reason.length > 0,
    'title error must have a non-empty reason string');
});

test('missing id field returns invalid with an id error', () => {
  const task = validTask();
  delete task.id;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'id'));
});

test('missing description field returns invalid with a description error', () => {
  const task = validTask();
  delete task.description;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'description'));
});

test('missing status field returns invalid with a status error', () => {
  const task = validTask();
  delete task.status;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'status'));
});

test('missing priority field returns invalid with a priority error', () => {
  const task = validTask();
  delete task.priority;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'priority'));
});

test('missing dependencies field returns invalid with a dependencies error', () => {
  const task = validTask();
  delete task.dependencies;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'dependencies'));
});

test('missing subtasks field returns invalid with a subtasks error', () => {
  const task = validTask();
  delete task.subtasks;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'subtasks'));
});

test('missing updatedAt field returns invalid with an updatedAt error', () => {
  const task = validTask();
  delete task.updatedAt;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'updatedAt'));
});

// ---------------------------------------------------------------------------
// Wrong types
// ---------------------------------------------------------------------------

test('title as a number (wrong type) returns invalid', () => {
  const task = validTask();
  task.title = 123;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'title'),
    'errors must contain an entry with field: "title" for wrong type');
});

test('empty string title returns invalid', () => {
  const task = validTask();
  task.title = '   ';
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'title'));
});

test('id as a number (wrong type) returns invalid', () => {
  const task = validTask();
  task.id = 1; // must be string
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'id'));
});

test('dependencies as a non-array returns invalid', () => {
  const task = validTask();
  task.dependencies = 'none';
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'dependencies'));
});

test('subtasks as a non-array returns invalid', () => {
  const task = validTask();
  task.subtasks = null;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'subtasks'));
});

// ---------------------------------------------------------------------------
// Invalid enum values
// ---------------------------------------------------------------------------

test('invalid status value returns invalid', () => {
  const task = validTask();
  task.status = 'wip'; // not in VALID_STATUSES
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'status'),
    'errors must contain an entry with field: "status"');
});

test('invalid priority value returns invalid', () => {
  const task = validTask();
  task.priority = 'urgent'; // not in VALID_PRIORITIES
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'priority'));
});

// ---------------------------------------------------------------------------
// TC-011: all valid status values are accepted
// ---------------------------------------------------------------------------

test('all VALID_STATUSES values are accepted by validateTaskSchema', () => {
  const { VALID_STATUSES } = require('../lib/task-core.cjs');
  for (const status of VALID_STATUSES) {
    const task = validTask();
    task.status = status;
    const result = taskSchema.validateTaskSchema(task);
    assert.equal(result.valid, true,
      `status "${status}" must be valid but got errors: ${JSON.stringify(result.errors)}`);
  }
});

test('all VALID_PRIORITIES values are accepted by validateTaskSchema', () => {
  const { VALID_PRIORITIES } = require('../lib/task-core.cjs');
  for (const priority of VALID_PRIORITIES) {
    const task = validTask();
    task.priority = priority;
    const result = taskSchema.validateTaskSchema(task);
    assert.equal(result.valid, true,
      `priority "${priority}" must be valid but got errors: ${JSON.stringify(result.errors)}`);
  }
});

// ---------------------------------------------------------------------------
// Optional fields: details and testStrategy
// ---------------------------------------------------------------------------

test('optional details field is allowed when present as a string', () => {
  const task = validTask();
  task.details = 'Some implementation details';
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, true, 'details as a string must be valid');
  assert.deepEqual(result.errors, []);
});

test('optional testStrategy field is allowed when present as a string', () => {
  const task = validTask();
  task.testStrategy = 'Run unit tests';
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, true, 'testStrategy as a string must be valid');
  assert.deepEqual(result.errors, []);
});

test('optional details and testStrategy fields are allowed when absent', () => {
  const task = validTask();
  // Neither details nor testStrategy set — they are optional
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, true, 'task without optional fields must be valid');
  assert.deepEqual(result.errors, []);
});

test('details as a non-string when present returns invalid', () => {
  const task = validTask();
  task.details = 42;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'details'),
    'errors must contain an entry with field: "details"');
});

test('testStrategy as a non-string when present returns invalid', () => {
  const task = validTask();
  task.testStrategy = [];
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.find((e) => e.field === 'testStrategy'),
    'errors must contain an entry with field: "testStrategy"');
});

// ---------------------------------------------------------------------------
// Error accumulation: multiple failures collected in one pass (not short-circuit)
// ---------------------------------------------------------------------------

test('multiple invalid fields produce multiple errors (no short-circuit)', () => {
  const task = validTask();
  delete task.title;
  delete task.description;
  task.status = 'bogus';
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3,
    `expected at least 3 errors but got ${result.errors.length}: ${JSON.stringify(result.errors)}`);
  assert.ok(result.errors.find((e) => e.field === 'title'));
  assert.ok(result.errors.find((e) => e.field === 'description'));
  assert.ok(result.errors.find((e) => e.field === 'status'));
});

// ---------------------------------------------------------------------------
// Error entry shape: each error must carry { field, reason }
// ---------------------------------------------------------------------------

test('each error entry carries both field and reason strings', () => {
  const task = validTask();
  delete task.title;
  const result = taskSchema.validateTaskSchema(task);
  assert.equal(result.valid, false);
  for (const err of result.errors) {
    assert.equal(typeof err.field, 'string', 'error.field must be a string');
    assert.equal(typeof err.reason, 'string', 'error.reason must be a string');
    assert.ok(err.field.length > 0, 'error.field must not be empty');
    assert.ok(err.reason.length > 0, 'error.reason must not be empty');
  }
});
