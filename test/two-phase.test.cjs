/**
 * Unit tests for lib/two-phase.cjs — Two-phase orchestrator-side protocol helper.
 *
 * Covers (SD §10.2 Process Flow, decision D1):
 *   (1) Full parse-prd flow: mock generate returns 3 valid tasks
 *       → runAgentNativeOp returns { imported: 3 }; tasks.json has 3 pending tasks.
 *   (2) Spec check: Phase 1 produces a GenerationSpec with operation='parse-prd'
 *       and the SD file content as inputContent (assert the spec generate received).
 *   (3) Phase 3 failure: generate returns a schema-invalid task (missing title)
 *       → runAgentNativeOp throws / surfaces ERR_AI_SCHEMA_INVALID; tasks.json unchanged.
 *   (4) Expand flow: seed a parent task, mock generate returns subtasks,
 *       assert import path is exercised (spec.operation='expand', { imported: 2 }).
 *   (5) Custom runCli injection: deps.runCli can be overridden (verifies DI contract).
 *
 * Each test uses its own os.mkdtemp isolation with injected _paths and a real
 * temp config.json + SD file. The real .taskmaster/ and .spec-flow/ are NEVER
 * touched during testing.
 *
 * Run: node test/two-phase.test.cjs
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

let runAgentNativeOp;
test('two-phase module imports without throwing', () => {
  ({ runAgentNativeOp } = require('../lib/two-phase.cjs'));
  assert.equal(typeof runAgentNativeOp, 'function',
    'runAgentNativeOp must be exported as an async function');
});

// ---------------------------------------------------------------------------
// Helpers — each test gets its own isolated tmp directory
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'two-phase-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
    configFile: path.join(tmpDir, '.spec-flow', 'config.json'),
  };
}

/**
 * Write a minimal .spec-flow/config.json that sets engine=native + aiMode=agent-native.
 * This is required so engine-router and ai-hybrid route correctly in Phase 1.
 */
function writeConfig(configFile) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({ taskCore: { engine: 'native', aiMode: 'agent-native' } }, null, 2),
    'utf8'
  );
}

/**
 * Write a requirements / SD document to a temp file and return its path.
 * parse-prd reads this file via fs.readFileSync, so it must exist on disk.
 */
function writeSDFile(tmpDir, content) {
  const sdPath = path.join(tmpDir, 'sd.md');
  fs.writeFileSync(sdPath, content, 'utf8');
  return sdPath;
}

/**
 * Build a fully valid task object satisfying validateTaskSchema requirements.
 * Required fields: id, title, description, status, priority, dependencies, subtasks, updatedAt.
 */
function makeValidTask(overrides) {
  return Object.assign(
    {
      id: '1',
      title: 'Task title',
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
 * Read tasks for a given tag from the injected _paths.tasksFile.
 */
function readStoredTasks(tasksFile, tag) {
  const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  return data[tag] ? data[tag].tasks : [];
}

// ---------------------------------------------------------------------------
// (1) Full parse-prd flow: 3 valid tasks → { imported: 3 }, tasks.json correct
// ---------------------------------------------------------------------------

test('(1) parse-prd: generate returns 3 valid tasks → { imported: 3 } and tasks.json has 3 pending', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeConfig(_paths.configFile);

  const sdContent = '# Requirements\n- Feature A\n- Feature B\n- Feature C\n';
  const sdPath = writeSDFile(tmpDir, sdContent);

  const tasks = [
    makeValidTask({ id: '1', title: 'Implement Feature A' }),
    makeValidTask({ id: '2', title: 'Implement Feature B' }),
    makeValidTask({ id: '3', title: 'Implement Feature C' }),
  ];

  const generate = async (_spec) => tasks;

  const result = await runAgentNativeOp(
    'parse-prd',
    { tag: 'feat-prd', input: sdPath },
    { generate, _paths }
  );

  assert.equal(result.imported, 3,
    'runAgentNativeOp must return { imported: 3 } for a 3-task batch');

  const stored = readStoredTasks(_paths.tasksFile, 'feat-prd');
  assert.equal(stored.length, 3, 'tasks.json must contain 3 tasks for the tag');

  for (const t of stored) {
    assert.equal(t.status, 'pending',
      `task ${t.id} status must be "pending" after import (normalization)`);
  }
});

// ---------------------------------------------------------------------------
// (2) Spec check: Phase 1 produces GenerationSpec with correct shape
// ---------------------------------------------------------------------------

test('(2) parse-prd: GenerationSpec passed to generate has operation="parse-prd" and SD content as inputContent', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeConfig(_paths.configFile);

  const sdContent = '# SD Content for spec verification\nFR-001: do the thing.\n';
  const sdPath = writeSDFile(tmpDir, sdContent);

  let receivedSpec = null;
  const generate = async (spec) => {
    receivedSpec = spec;
    return [makeValidTask({ id: '1', title: 'Task from spec check' })];
  };

  await runAgentNativeOp(
    'parse-prd',
    { tag: 'feat-speccheck', input: sdPath },
    { generate, _paths }
  );

  assert.ok(receivedSpec !== null, 'generate must have been called with the GenerationSpec');
  assert.equal(receivedSpec.operation, 'parse-prd',
    'spec.operation must be "parse-prd"');
  assert.equal(receivedSpec.inputContent, sdContent,
    'spec.inputContent must equal the full content of the SD file passed as --input');
  assert.equal(receivedSpec.tag, 'feat-speccheck',
    'spec.tag must match the params.tag provided to runAgentNativeOp');
  assert.ok(receivedSpec.taskSchema,
    'spec.taskSchema must be present (AgentNativeDriver embeds it for the LLM)');
  assert.ok(receivedSpec.instructions,
    'spec.instructions must be present (AgentNativeDriver includes op-specific instructions)');
});

// ---------------------------------------------------------------------------
// (3) Phase 3 failure: schema-invalid task → throws with ERR_AI_SCHEMA_INVALID,
//     tasks.json must be byte-identical before and after (reject-entire-batch, D3)
// ---------------------------------------------------------------------------

test('(3) Phase 3 failure: generate returns invalid task (no title) → throws ERR_AI_SCHEMA_INVALID, tasks.json unchanged', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeConfig(_paths.configFile);

  // Pre-populate tasks.json so we can verify byte identity after the failed import.
  const dir = path.dirname(_paths.tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const initial = { 'feat-fail': { tasks: [makeValidTask({ id: '99', title: 'Original task' })], metadata: {} } };
  const initialJson = JSON.stringify(initial, null, 2);
  fs.writeFileSync(_paths.tasksFile, initialJson, 'utf8');

  const sdContent = '# SD for failure scenario\n';
  const sdPath = writeSDFile(tmpDir, sdContent);

  // generate returns a task missing the required 'title' field → schema-invalid
  const generate = async () => [
    {
      id: '1',
      description: 'No title here — this will fail schema validation',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      subtasks: [],
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
  ];

  let thrown = null;
  try {
    await runAgentNativeOp(
      'parse-prd',
      { tag: 'feat-fail', input: sdPath },
      { generate, _paths }
    );
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown !== null, 'runAgentNativeOp must throw when Phase 3 receives schema-invalid tasks');
  assert.ok(
    thrown.message.includes('ERR_AI_SCHEMA_INVALID') || thrown.code === 'ERR_AI_SCHEMA_INVALID',
    `error must surface ERR_AI_SCHEMA_INVALID; got message="${thrown.message}" code="${thrown.code}"`
  );

  // tasks.json must be byte-identical to what it was before (reject-entire-batch, D3)
  const afterJson = fs.readFileSync(_paths.tasksFile, 'utf8');
  assert.equal(afterJson, initialJson,
    'tasks.json must be byte-identical after a rejected Phase 3 batch (ERR_AI_SCHEMA_INVALID)');
});

// ---------------------------------------------------------------------------
// (4) Expand flow: seed parent task, generate returns subtasks, import exercised
// ---------------------------------------------------------------------------

test('(4) expand: seed parent task, generate returns 2 tasks → spec.operation="expand", { imported: 2 }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeConfig(_paths.configFile);

  // Seed tasks.json with a parent task so _handleExpand can read it in Phase 1.
  const dir = path.dirname(_paths.tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const parentTask = makeValidTask({ id: '1', title: 'Parent task to expand' });
  const seedData = { 'feat-expand': { tasks: [parentTask], metadata: {} } };
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(seedData, null, 2), 'utf8');

  let receivedSpec = null;
  const generate = async (spec) => {
    receivedSpec = spec;
    return [
      makeValidTask({ id: '1', title: 'Subtask A from expand' }),
      makeValidTask({ id: '2', title: 'Subtask B from expand' }),
    ];
  };

  const result = await runAgentNativeOp(
    'expand',
    { tag: 'feat-expand', id: '1' },
    { generate, _paths }
  );

  assert.ok(result, 'runAgentNativeOp must return a result for expand');
  assert.equal(result.imported, 2, 'expand must return { imported: 2 } for 2 generated tasks');

  assert.ok(receivedSpec !== null, 'generate must have been called with the expand GenerationSpec');
  assert.equal(receivedSpec.operation, 'expand',
    'spec.operation must be "expand" for the expand op');
  assert.ok(receivedSpec.context && receivedSpec.context.parentTaskId === '1',
    'spec.context.parentTaskId must be "1" (the seeded parent task id)');
});

// ---------------------------------------------------------------------------
// (5) Custom runCli injection: deps.runCli defaults to cli-dispatcher when absent
// ---------------------------------------------------------------------------

test('(5) deps.runCli defaults to cli-dispatcher.runCli when not provided', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeConfig(_paths.configFile);

  const sdContent = '# Minimal SD\n';
  const sdPath = writeSDFile(tmpDir, sdContent);

  // No deps.runCli — helper must use the real cli-dispatcher internally.
  const generate = async () => [makeValidTask({ id: '1', title: 'Auto-cli task' })];

  const result = await runAgentNativeOp(
    'parse-prd',
    { tag: 'feat-autocli', input: sdPath },
    { generate, _paths }
  );

  assert.equal(result.imported, 1,
    'runAgentNativeOp must work with the default cli-dispatcher when deps.runCli is absent');
});
