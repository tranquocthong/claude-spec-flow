/**
 * Unit tests for lib/tasks-json-schema.cjs — shared tasks.json schema validator.
 *
 * Validates that a parsed (or JSON-string) tasks.json conforms to the
 * tag-keyed shared schema both engines use: { [tag]: { tasks: Task[], metadata: object } }
 *
 * Covers:
 *   TC-004 — a legacy-shaped tasks.json (tag -> {tasks:[3 valid tasks], metadata:{}})
 *             validates OK.
 *   TC-010-style — a tasks.json with multiple tags + tasks stays valid
 *                  (data-integrity / read-after-rollback guarantee).
 *   Invalid cases — tag entry missing tasks array → error; a task missing a
 *                   required field → error carrying tag+taskId; malformed JSON
 *                   string → throw.
 *   assertTasksJsonValid — throws ERR_TASKS_JSON_INVALID on invalid input.
 *
 * Run:  node test/tasks-json-schema.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import — RED: module does not exist yet, this import will throw
// ---------------------------------------------------------------------------

let mod;
test('tasks-json-schema module imports without throwing', () => {
  mod = require('../lib/tasks-json-schema.cjs');
});

// ---------------------------------------------------------------------------
// Export shape
// ---------------------------------------------------------------------------

test('validateTasksJson is exported as a function', () => {
  assert.equal(typeof mod.validateTasksJson, 'function',
    'validateTasksJson must be a function');
});

test('assertTasksJsonValid is exported as a function', () => {
  assert.equal(typeof mod.assertTasksJsonValid, 'function',
    'assertTasksJsonValid must be a function');
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid task object
// ---------------------------------------------------------------------------

function validTask(id) {
  return {
    id: String(id),
    title: 'Task ' + id,
    description: 'Description for task ' + id,
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TC-004: legacy-shaped tasks.json (single tag, 3 valid tasks, metadata:{})
// validates OK
// ---------------------------------------------------------------------------

test('TC-004: single tag with 3 valid tasks and empty metadata passes validation', () => {
  const input = {
    master: {
      tasks: [validTask('1'), validTask('2'), validTask('3')],
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, true,
    'single tag with 3 valid tasks must be valid; errors: ' + JSON.stringify(result.errors));
  assert.deepEqual(result.errors, [],
    'errors must be empty for a valid tasks.json');
});

// ---------------------------------------------------------------------------
// TC-010-style: multiple tags + tasks stays valid (data-integrity /
// read-after-rollback guarantee, D3)
// ---------------------------------------------------------------------------

test('TC-010: multiple tags with valid tasks all pass validation', () => {
  const input = {
    master: {
      tasks: [validTask('1'), validTask('2')],
      metadata: { created: '2026-01-01T00:00:00.000Z' },
    },
    'feature-x': {
      tasks: [validTask('1')],
      metadata: {},
    },
    hotfix: {
      tasks: [],
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, true,
    'multiple tags must all be valid; errors: ' + JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// JSON string input: valid JSON string is parsed and validated
// ---------------------------------------------------------------------------

test('a valid JSON string is accepted and parsed correctly', () => {
  const input = JSON.stringify({
    master: {
      tasks: [validTask('1')],
      metadata: {},
    },
  });
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, true,
    'valid JSON string must parse and validate successfully');
});

// ---------------------------------------------------------------------------
// Malformed JSON string: must throw a clear error (not return invalid)
// ---------------------------------------------------------------------------

test('a malformed JSON string throws an error with a clear message', () => {
  assert.throws(
    () => mod.validateTasksJson('{not valid json'),
    (err) => {
      assert.ok(err instanceof Error,
        'thrown value must be an Error instance');
      assert.ok(
        typeof err.message === 'string' && err.message.length > 0,
        'error must have a non-empty message'
      );
      return true;
    },
    'malformed JSON string must throw'
  );
});

// ---------------------------------------------------------------------------
// Top-level must be an object
// ---------------------------------------------------------------------------

test('non-object top level (array) returns invalid', () => {
  const result = mod.validateTasksJson([]);
  assert.equal(result.valid, false, 'array at top level must be invalid');
  assert.ok(result.errors.length > 0, 'must have at least one error');
});

test('null input returns invalid', () => {
  const result = mod.validateTasksJson(null);
  assert.equal(result.valid, false, 'null input must be invalid');
  assert.ok(result.errors.length > 0, 'must have at least one error');
});

// ---------------------------------------------------------------------------
// Tag entry missing tasks array → error with tag in error object
// ---------------------------------------------------------------------------

test('tag entry missing tasks array returns invalid with tag in the error', () => {
  const input = {
    master: {
      metadata: {},
      // tasks is absent
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false,
    'missing tasks array must make validation fail');
  const err = result.errors.find((e) => e.tag === 'master');
  assert.ok(err, 'error must carry the tag name "master"');
  assert.ok(typeof err.reason === 'string' && err.reason.length > 0,
    'error must have a non-empty reason');
});

test('tag entry with tasks as non-array (object) returns invalid', () => {
  const input = {
    master: {
      tasks: { '1': validTask('1') },  // object instead of array
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false, 'non-array tasks must be invalid');
  assert.ok(result.errors.find((e) => e.tag === 'master'),
    'error must carry tag "master"');
});

test('tag entry with null tasks returns invalid', () => {
  const input = {
    master: {
      tasks: null,
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false, 'null tasks must be invalid');
});

// ---------------------------------------------------------------------------
// metadata must be an object when present
// ---------------------------------------------------------------------------

test('tag entry with metadata as a string returns invalid', () => {
  const input = {
    master: {
      tasks: [validTask('1')],
      metadata: 'bad',
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false, 'string metadata must be invalid');
  assert.ok(result.errors.find((e) => e.tag === 'master'),
    'error must carry tag "master"');
});

// ---------------------------------------------------------------------------
// Task missing a required field → error carrying tag + taskId
// ---------------------------------------------------------------------------

test('task missing required title field: error carries tag and taskId', () => {
  const bad = validTask('42');
  delete bad.title;
  const input = {
    master: {
      tasks: [bad],
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false,
    'task with missing title must make the whole document invalid');
  const err = result.errors.find((e) => e.tag === 'master');
  assert.ok(err, 'error must carry tag "master"');
  assert.equal(err.taskId, '42',
    'error must carry taskId "42"');
  assert.ok(err.field === 'title' || err.reason.includes('title'),
    'error must reference the "title" field');
});

test('task missing required status field: error carries tag and taskId', () => {
  const bad = validTask('5');
  delete bad.status;
  const input = {
    'feature-branch': {
      tasks: [bad],
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false);
  const err = result.errors.find((e) => e.tag === 'feature-branch' && e.taskId === '5');
  assert.ok(err, 'error must carry tag "feature-branch" and taskId "5"');
});

// ---------------------------------------------------------------------------
// Error accumulation: ALL problems collected, not short-circuited
// ---------------------------------------------------------------------------

test('multiple invalid tags produce errors for all of them (no short-circuit)', () => {
  const input = {
    tag1: {
      tasks: null,
      metadata: {},
    },
    tag2: {
      // tasks missing entirely
      metadata: {},
    },
    tag3: {
      tasks: [validTask('1')],
      metadata: 'wrong',
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false);
  const tags = result.errors.map((e) => e.tag);
  assert.ok(tags.includes('tag1'), 'must have error for tag1');
  assert.ok(tags.includes('tag2'), 'must have error for tag2');
  assert.ok(tags.includes('tag3'), 'must have error for tag3');
});

test('multiple invalid tasks in one tag produce errors for each (no short-circuit)', () => {
  const bad1 = validTask('1');
  delete bad1.title;
  const bad2 = validTask('2');
  delete bad2.status;
  const input = {
    master: {
      tasks: [bad1, bad2],
      metadata: {},
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, false);
  const taskIds = result.errors.map((e) => e.taskId);
  assert.ok(taskIds.includes('1'), 'must have error for taskId "1"');
  assert.ok(taskIds.includes('2'), 'must have error for taskId "2"');
});

// ---------------------------------------------------------------------------
// assertTasksJsonValid — convenience throw-on-invalid
// ---------------------------------------------------------------------------

test('assertTasksJsonValid does not throw for a valid tasks.json', () => {
  const input = {
    master: {
      tasks: [validTask('1')],
      metadata: {},
    },
  };
  assert.doesNotThrow(
    () => mod.assertTasksJsonValid(input),
    'assertTasksJsonValid must not throw for valid input'
  );
});

test('assertTasksJsonValid throws an Error with code ERR_TASKS_JSON_INVALID for invalid input', () => {
  const input = {
    master: {
      tasks: null,  // invalid
      metadata: {},
    },
  };
  assert.throws(
    () => mod.assertTasksJsonValid(input),
    (err) => {
      assert.ok(err instanceof Error, 'thrown value must be an Error instance');
      assert.equal(err.code, 'ERR_TASKS_JSON_INVALID',
        'error.code must be ERR_TASKS_JSON_INVALID');
      return true;
    },
    'assertTasksJsonValid must throw for invalid input'
  );
});

test('assertTasksJsonValid error message contains the number of errors', () => {
  const bad = validTask('1');
  delete bad.title;
  delete bad.status;
  const input = {
    master: {
      tasks: [bad],
      metadata: {},
    },
  };
  let caught;
  try {
    mod.assertTasksJsonValid(input);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, 'must throw');
  assert.equal(caught.code, 'ERR_TASKS_JSON_INVALID');
  assert.ok(typeof caught.message === 'string' && caught.message.length > 0,
    'error message must be a non-empty string');
});

// ---------------------------------------------------------------------------
// Empty tasks.json (empty object) is valid (no tags = no tasks = OK)
// ---------------------------------------------------------------------------

test('empty object (no tags) is valid — no tasks to fail', () => {
  const result = mod.validateTasksJson({});
  assert.equal(result.valid, true, 'empty object with no tags must be valid');
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Tag entry with no metadata key at all is still valid (metadata is optional)
// ---------------------------------------------------------------------------

test('tag entry without metadata key is valid when tasks array is present', () => {
  const input = {
    master: {
      tasks: [validTask('1')],
      // no metadata key
    },
  };
  const result = mod.validateTasksJson(input);
  assert.equal(result.valid, true,
    'absent metadata key must still be valid (metadata is optional)');
});
