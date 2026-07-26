/**
 * Unit tests for lib/agent-native-driver.cjs — GenerationSpec builder.
 *
 * Covers:
 *   TC-003: parse-prd spec has all required fields (operation, tag, inputContent,
 *           taskSchema, expectedOutput, instructions); taskSchema is TASK_SCHEMA object.
 *   TC-010: expand spec has operation='expand', context.parentTaskId,
 *           context.existingSubtaskIds.
 *   Each of the 4 ops produces operation-specific instructions (unique per op).
 *   TC-012: no network — generateSpec is synchronous; does not involve any
 *           http/https/fetch module.
 *
 * Run:  node test/agent-native-driver.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let driver;
test('agent-native-driver module imports without throwing', () => {
  driver = require('../lib/agent-native-driver.cjs');
});

// ---------------------------------------------------------------------------
// Verify exports
// ---------------------------------------------------------------------------

test('agent-native-driver exports generateSpec function', () => {
  assert.equal(typeof driver.generateSpec, 'function',
    'generateSpec must be exported as a function');
});

// ---------------------------------------------------------------------------
// TC-003: parse-prd spec — all required fields present; taskSchema is TASK_SCHEMA
// ---------------------------------------------------------------------------

test('TC-003: parse-prd spec contains all required fields', () => {
  const { TASK_SCHEMA } = require('../lib/task-schema.cjs');
  const spec = driver.generateSpec('parse-prd', 'SD content here', 'main', undefined);

  assert.equal(spec.operation, 'parse-prd', 'operation must be "parse-prd"');
  assert.equal(spec.tag, 'main', 'tag must match the provided tag');
  assert.equal(spec.inputContent, 'SD content here', 'inputContent must match the provided string');
  assert.ok(spec.taskSchema, 'taskSchema must be present');
  assert.deepEqual(spec.taskSchema, TASK_SCHEMA,
    'taskSchema must be the TASK_SCHEMA object from task-schema.cjs');
  assert.ok(spec.expectedOutput, 'expectedOutput must be present');
  assert.equal(typeof spec.expectedOutput.description, 'string',
    'expectedOutput.description must be a string');
  assert.ok(spec.expectedOutput.description.length > 0,
    'expectedOutput.description must be non-empty');
  assert.equal(spec.expectedOutput.type, 'array',
    'expectedOutput.type must be "array"');
  assert.equal(typeof spec.instructions, 'string',
    'instructions must be a string');
  assert.ok(spec.instructions.length > 0, 'instructions must be non-empty');
});

test('TC-003: parse-prd spec does not include context when context is undefined', () => {
  const spec = driver.generateSpec('parse-prd', 'SD content', 'main', undefined);
  assert.equal(spec.context, undefined,
    'context must not be present when not provided');
});

// ---------------------------------------------------------------------------
// TC-010: expand spec — operation='expand', context.parentTaskId,
//         context.existingSubtaskIds
// ---------------------------------------------------------------------------

test('TC-010: expand spec has operation="expand"', () => {
  const spec = driver.generateSpec('expand', 'task details', 'main',
    { parentTaskId: '5', existingSubtaskIds: ['5.1', '5.2'] });
  assert.equal(spec.operation, 'expand', 'operation must be "expand"');
});

test('TC-010: expand spec carries context.parentTaskId', () => {
  const spec = driver.generateSpec('expand', 'task details', 'main',
    { parentTaskId: '5', existingSubtaskIds: ['5.1', '5.2'] });
  assert.ok(spec.context, 'context must be present for expand');
  assert.equal(spec.context.parentTaskId, '5',
    'context.parentTaskId must match the provided value');
});

test('TC-010: expand spec carries context.existingSubtaskIds', () => {
  const spec = driver.generateSpec('expand', 'task details', 'main',
    { parentTaskId: '5', existingSubtaskIds: ['5.1', '5.2'] });
  assert.ok(Array.isArray(spec.context.existingSubtaskIds),
    'context.existingSubtaskIds must be an array');
  assert.deepEqual(spec.context.existingSubtaskIds, ['5.1', '5.2'],
    'context.existingSubtaskIds must match the provided value');
});

test('TC-010: expand spec also carries existingTaskIds when provided in context', () => {
  const spec = driver.generateSpec('expand', 'task details', 'main',
    { parentTaskId: '3', existingSubtaskIds: [], existingTaskIds: ['1', '2', '3'] });
  assert.deepEqual(spec.context.existingTaskIds, ['1', '2', '3'],
    'context.existingTaskIds must be forwarded when present');
});

// ---------------------------------------------------------------------------
// Operation-specific instructions — each op must produce distinct instructions
// ---------------------------------------------------------------------------

test('parse-prd instructions mention generating tasks from inputContent', () => {
  const spec = driver.generateSpec('parse-prd', 'requirements doc', 'main', undefined);
  const lower = spec.instructions.toLowerCase();
  assert.ok(
    lower.includes('task') || lower.includes('parse') || lower.includes('generat'),
    `parse-prd instructions must mention tasks/parse/generat; got: "${spec.instructions}"`
  );
});

test('expand instructions mention subtasks and parentTaskId', () => {
  const spec = driver.generateSpec('expand', 'parent task details', 'main',
    { parentTaskId: '7', existingSubtaskIds: [] });
  const lower = spec.instructions.toLowerCase();
  assert.ok(
    lower.includes('subtask') || lower.includes('expand') || lower.includes('child'),
    `expand instructions must mention subtask/expand/child; got: "${spec.instructions}"`
  );
});

test('analyze-complexity instructions mention complexity and recommendedSubtasks', () => {
  const spec = driver.generateSpec('analyze-complexity', 'task list json', 'main', undefined);
  const lower = spec.instructions.toLowerCase();
  assert.ok(
    lower.includes('complex') || lower.includes('recommend'),
    `analyze-complexity instructions must mention complexity/recommend; got: "${spec.instructions}"`
  );
});

test('research instructions mention research and query', () => {
  const spec = driver.generateSpec('research', 'what is TDD?', 'main', undefined);
  const lower = spec.instructions.toLowerCase();
  assert.ok(
    lower.includes('research') || lower.includes('query') || lower.includes('result'),
    `research instructions must mention research/query/result; got: "${spec.instructions}"`
  );
});

test('each op produces distinct instructions (no shared template)', () => {
  const ops = ['parse-prd', 'expand', 'analyze-complexity', 'research'];
  const contexts = {
    'parse-prd': undefined,
    'expand': { parentTaskId: '1', existingSubtaskIds: [] },
    'analyze-complexity': undefined,
    'research': undefined,
  };
  const specs = ops.map((op) =>
    driver.generateSpec(op, 'input', 'main', contexts[op])
  );
  const instructionSet = new Set(specs.map((s) => s.instructions));
  assert.equal(instructionSet.size, 4,
    'all 4 operations must produce distinct instructions strings');
});

// ---------------------------------------------------------------------------
// TC-012: no network — generateSpec is synchronous; must NOT return a Promise
// ---------------------------------------------------------------------------

test('TC-012: generateSpec is synchronous — returns a plain object, not a Promise', () => {
  const result = driver.generateSpec('parse-prd', 'content', 'main', undefined);
  // A Promise has a .then function; a plain object does not
  assert.ok(result !== null && typeof result === 'object',
    'generateSpec must return an object');
  assert.equal(typeof result.then, 'undefined',
    'generateSpec must not return a Promise (no .then property)');
});

test('TC-012: generateSpec does not require http or https modules (no network client)', () => {
  // Read the source to verify no http/https/fetch is required
  const fs = require('node:fs');
  const src = fs.readFileSync(
    require('node:path').resolve(__dirname, '../lib/agent-native-driver.cjs'),
    'utf8'
  );
  assert.ok(!src.includes("require('http')") && !src.includes('require("http")'),
    'agent-native-driver.cjs must not require http');
  assert.ok(!src.includes("require('https')") && !src.includes('require("https")'),
    'agent-native-driver.cjs must not require https');
  assert.ok(!src.includes('fetch('),
    'agent-native-driver.cjs must not use fetch()');
});

// ---------------------------------------------------------------------------
// context is included in spec only when provided
// ---------------------------------------------------------------------------

test('context is present in spec when provided for any operation', () => {
  const ctx = { parentTaskId: '2', existingSubtaskIds: [] };
  const spec = driver.generateSpec('expand', 'details', 'main', ctx);
  assert.ok(spec.context, 'context must be set when provided');
  assert.deepEqual(spec.context, ctx, 'context must match the provided value exactly');
});

test('context is absent from spec when not provided (undefined)', () => {
  const spec = driver.generateSpec('parse-prd', 'content', 'main', undefined);
  // context must NOT be present (either undefined or missing key)
  assert.ok(
    !Object.prototype.hasOwnProperty.call(spec, 'context') || spec.context === undefined,
    'spec must not carry context when it was not provided'
  );
});

test('context is absent from spec when not provided (no arg)', () => {
  const spec = driver.generateSpec('analyze-complexity', 'content', 'main');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(spec, 'context') || spec.context === undefined,
    'spec must not carry context when called without context arg'
  );
});

// ---------------------------------------------------------------------------
// Tag is forwarded correctly
// ---------------------------------------------------------------------------

test('tag is forwarded correctly into the spec', () => {
  const spec = driver.generateSpec('parse-prd', 'content', 'sprint-2', undefined);
  assert.equal(spec.tag, 'sprint-2', 'tag must equal the provided tag value');
});

// ---------------------------------------------------------------------------
// expectedOutput.type is always 'array' for all operations
// ---------------------------------------------------------------------------

test('expectedOutput.type is "array" for all 4 operations', () => {
  const ops = ['parse-prd', 'expand', 'analyze-complexity', 'research'];
  const contexts = {
    'parse-prd': undefined,
    'expand': { parentTaskId: '1', existingSubtaskIds: [] },
    'analyze-complexity': undefined,
    'research': undefined,
  };
  for (const op of ops) {
    const spec = driver.generateSpec(op, 'input', 'main', contexts[op]);
    assert.equal(spec.expectedOutput.type, 'array',
      `expectedOutput.type must be "array" for op "${op}"`);
  }
});
