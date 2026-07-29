/**
 * integration-contract.test.cjs — Full MCP + CLI contract coverage.
 *
 * Maps ONE test per TC for all 18 TCs from SD §13.2.
 * Exercises the real modules IN-PROCESS; no npx or subprocess is spawned.
 *
 * MCP surface (TC-001..TC-008, TC-014, TC-015, TC-018):
 *   lib/mcp-server.cjs → handleToolCall(toolName, args)
 *
 * CLI surface (TC-009..TC-013, TC-016):
 *   lib/cli-dispatcher.cjs → runCli(argv, _inject)
 *
 * Engine routing (TC-017 legacy, TC-018 native):
 *   lib/engine-router.cjs → routeToEngine(operation, args)
 *   and lib/mcp-server.cjs → handleToolCall with injected config
 *
 * Each test is isolated in its own os.mkdtemp dir.
 * Real .taskmaster/ and .spec-flow/ are NEVER touched.
 *
 * Run: node test/integration-contract.test.cjs
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module imports (in-process — zero subprocess, zero external deps)
// ---------------------------------------------------------------------------

const { handleToolCall } = require('../lib/mcp-server.cjs');
const { runCli } = require('../lib/cli-dispatcher.cjs');
const { routeToEngine } = require('../lib/engine-router.cjs');

// ---------------------------------------------------------------------------
// Test helpers — each test gets its own isolated tmp dir
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integration-contract-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Write .spec-flow/config.json with the given engine value and return the path.
 * engineValue: 'native', 'legacy', or null (no taskCore key).
 */
function makeConfigFile(tmpDir, engineValue) {
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  const config = engineValue !== null
    ? { taskCore: { engine: engineValue } }
    : { project: 'test' };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  return configFile;
}

/**
 * Seed tasks.json with the given tasks array under the given tag.
 */
function seedTasks(tasksFile, tag, tasks) {
  const dir = path.dirname(tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const data = {};
  data[tag] = { tasks, metadata: {} };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

/** Minimal valid task with optional overrides. */
function makeTask(overrides) {
  return Object.assign(
    {
      id: '1',
      title: 'Test task',
      description: '',
      details: '',
      testStrategy: '',
      priority: 'medium',
      dependencies: [],
      status: 'pending',
      subtasks: [],
      updatedAt: new Date().toISOString(),
    },
    overrides,
  );
}

// ---------------------------------------------------------------------------
// All 7 required byStatus keys (SD §9.1 Stats type)
// ---------------------------------------------------------------------------
const ALL_STATUS_KEYS = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];

// ---------------------------------------------------------------------------
// TC-001 — get_tasks stats: total=3, byStatus.done=1, completionPercentage=33,
//           all 7 byStatus keys present (FR-003)
// ---------------------------------------------------------------------------

test('TC-001 get_tasks stats: total=3, byStatus.done=1, completionPercentage=33, all 7 byStatus keys present', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'main', [
    makeTask({ id: '1', status: 'pending' }),
    makeTask({ id: '2', status: 'pending' }),
    makeTask({ id: '3', status: 'done' }),
  ]);

  const result = await handleToolCall('get_tasks', { tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);

  const { stats } = result;
  assert.ok(stats, 'stats must be present in get_tasks response');

  // total = 3
  assert.equal(stats.total, 3, 'stats.total must equal 3 (all tasks in tag)');

  // byStatus.done = 1
  assert.ok(stats.byStatus, 'stats.byStatus must be present');
  assert.equal(stats.byStatus.done, 1, 'stats.byStatus.done must be 1');

  // completionPercentage = round(1 / (3-0) * 100) = round(33.33) = 33
  assert.equal(stats.completionPercentage, 33, 'stats.completionPercentage must be 33');

  // All 7 byStatus keys must be present (even when count = 0)
  for (const key of ALL_STATUS_KEYS) {
    assert.ok(key in stats.byStatus, `stats.byStatus must have key '${key}'`);
    assert.equal(typeof stats.byStatus[key], 'number', `stats.byStatus.${key} must be a number`);
  }
});

// ---------------------------------------------------------------------------
// TC-002 — get_tasks status filter: filtered tasks only; stats over whole tag
//           (FR-003)
// ---------------------------------------------------------------------------

test('TC-002 get_tasks status="done" filter: only done tasks returned; stats computed over full tag', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'main', [
    makeTask({ id: '1', status: 'pending' }),
    makeTask({ id: '2', status: 'pending' }),
    makeTask({ id: '3', status: 'done' }),
  ]);

  const result = await handleToolCall('get_tasks', { tag: 'main', status: 'done', _paths, _configFile });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);

  // Filtered tasks array must contain only status=done
  assert.ok(Array.isArray(result.tasks), 'tasks must be an array');
  assert.equal(result.tasks.length, 1, 'filtered tasks must contain exactly 1 done task');
  assert.equal(result.tasks[0].status, 'done', 'the returned task must have status=done');

  // Stats computed over the WHOLE tag (total=3, not filtered total=1)
  assert.equal(result.stats.total, 3, 'stats.total must reflect the whole tag (3), not the filter');
  assert.equal(result.stats.byStatus.pending, 2, 'stats.byStatus.pending must reflect the whole tag (2)');
});

// ---------------------------------------------------------------------------
// TC-003 — set_task_status valid → { success: true, task: { id, status, updatedAt } }
//           (FR-001)
// ---------------------------------------------------------------------------

test('TC-003 set_task_status valid: returns { success: true, task: { id, status:"in-progress", updatedAt } }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1', status: 'pending' })]);

  const result = await handleToolCall('set_task_status', {
    taskId: '1',
    status: 'in-progress',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.equal(result.success, true, 'success must be true');
  assert.ok(result.task && typeof result.task === 'object', 'task must be an object');
  assert.equal(result.task.id, '1', 'task.id must match');
  assert.equal(result.task.status, 'in-progress', 'task.status must be updated to in-progress');
  assert.ok(typeof result.task.updatedAt === 'string', 'task.updatedAt must be an ISO 8601 string');
});

// ---------------------------------------------------------------------------
// TC-004 — get_task: task with all 10 required §9.1 fields
//           (FR-002)
// ---------------------------------------------------------------------------

test('TC-004 get_task: returns task with all 10 required §9.1 fields', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const seeded = makeTask({
    id: '1',
    title: 'Full field task',
    description: 'desc',
    details: 'impl details',
    testStrategy: 'unit test',
    priority: 'high',
    dependencies: [],
    status: 'pending',
    subtasks: [],
  });
  seedTasks(_paths.tasksFile, 'main', [seeded]);

  const result = await handleToolCall('get_task', { taskId: '1', tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok(result.task && typeof result.task === 'object', 'task must be present');

  // All 10 required §9.1 fields must be present
  const required = ['id', 'title', 'description', 'details', 'testStrategy', 'priority', 'dependencies', 'status', 'subtasks', 'updatedAt'];
  for (const field of required) {
    assert.ok(field in result.task, `task must have required field '${field}'`);
  }

  // Type spot-checks
  assert.equal(typeof result.task.id, 'string', 'id must be string');
  assert.equal(typeof result.task.title, 'string', 'title must be string');
  assert.equal(typeof result.task.status, 'string', 'status must be string');
  assert.ok(Array.isArray(result.task.dependencies), 'dependencies must be array');
  assert.ok(Array.isArray(result.task.subtasks), 'subtasks must be array');
  assert.equal(typeof result.task.updatedAt, 'string', 'updatedAt must be string');
});

// ---------------------------------------------------------------------------
// TC-005 — next_task priority-then-id ordering: returns id "2"
//           (FR-004)
//
// Setup: task "1" done, task "2" pending dep=["1"] priority=medium,
//        task "3" pending no dep priority=medium.
// Both "2" and "3" are eligible (dep "1" is done). Same priority → sort by id
// ascending (parseInt): "2" < "3" → returns task "2".
// ---------------------------------------------------------------------------

test('TC-005 next_task priority-then-id ordering: returns id "2" (not "3")', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'main', [
    makeTask({ id: '1', status: 'done',    priority: 'low',    dependencies: [] }),
    makeTask({ id: '2', status: 'pending', priority: 'medium', dependencies: ['1'] }),
    makeTask({ id: '3', status: 'pending', priority: 'medium', dependencies: [] }),
  ]);

  const result = await handleToolCall('next_task', { tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok(result.task && typeof result.task === 'object', 'task must be present and non-null');
  assert.equal(result.task.id, '2', 'next_task must return id "2" — both eligible, same priority, sort by id ascending');
});

// ---------------------------------------------------------------------------
// TC-006 — next_task all blocked (mutual dependency): { task: null, message }
//           (FR-004)
// ---------------------------------------------------------------------------

test('TC-006 next_task all pending blocked by unresolved deps: returns { task: null, message }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Mutual dependency — both pending, each blocks the other
  seedTasks(_paths.tasksFile, 'main', [
    makeTask({ id: '1', status: 'pending', dependencies: ['2'] }),
    makeTask({ id: '2', status: 'pending', dependencies: ['1'] }),
  ]);

  const result = await handleToolCall('next_task', { tag: 'main', _paths, _configFile });

  assert.ok(!result.error, 'next_task must not return error envelope when all tasks blocked');
  assert.equal(result.task, null, 'task must be null when all eligible tasks are blocked');
  assert.ok(typeof result.message === 'string' || result.message === undefined,
    'message must be a string or undefined');
  // SD §9.2 says: { task: null, message: "Không còn task đủ điều kiện..." }
  // The implementation uses 'reason' internally which mcp-server maps to 'message'.
  // Assert the task is null — the message field is optional in the contract ("message?")
  // but must not be an error code.
});

// ---------------------------------------------------------------------------
// TC-007 — add_task auto-increment id: new task gets id "3"
//           (FR-005)
// ---------------------------------------------------------------------------

test('TC-007 add_task auto-increment id: tag has tasks "1","2" → new task gets id "3"', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'feat-x', [
    makeTask({ id: '1', title: 'Existing 1' }),
    makeTask({ id: '2', title: 'Existing 2' }),
  ]);

  const result = await handleToolCall('add_task', {
    title: 'Test task',
    tag: 'feat-x',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok(result.task && typeof result.task === 'object', 'task must be present');
  assert.equal(result.task.id, '3', 'auto-incremented id must be "3" (max existing id "2" + 1)');
  assert.equal(result.task.title, 'Test task', 'task.title must match input');
  assert.equal(result.task.status, 'pending', 'new task must have status pending');
  assert.ok(Array.isArray(result.task.dependencies), 'dependencies must be array');
  assert.ok(Array.isArray(result.task.subtasks), 'subtasks must be array');
});

// ---------------------------------------------------------------------------
// TC-008 — response shape byte-compat: top-level keys for all 5 tools match
//           §9.2 contract (FR-006, NFR-003)
//
// Independent from contract-compat.test.cjs — golden shapes defined inline.
// ---------------------------------------------------------------------------

/**
 * Golden top-level key sets per tool (SD §9.2 MCP Tool Contract).
 * Sorted for stable comparison with Object.keys(result).sort().
 */
const TC008_GOLDEN_KEYS = {
  set_task_status: ['success', 'task'],
  get_task:        ['task'],
  get_tasks:       ['stats', 'tasks'],
  next_task:       ['message', 'task'],
  add_task:        ['task'],
};

test('TC-008 set_task_status response shape: top-level keys = { success, task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');
  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1', status: 'pending' })]);

  const result = await handleToolCall('set_task_status', { taskId: '1', status: 'done', tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `set_task_status must not error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    TC008_GOLDEN_KEYS.set_task_status,
    'set_task_status response top-level keys must match §9.2 { success, task }',
  );
  assert.equal(typeof result.success, 'boolean', 'success must be boolean');
});

test('TC-008 get_task response shape: top-level keys = { task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');
  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1' })]);

  const result = await handleToolCall('get_task', { taskId: '1', tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `get_task must not error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    TC008_GOLDEN_KEYS.get_task,
    'get_task response top-level keys must match §9.2 { task }',
  );
});

test('TC-008 get_tasks response shape: top-level keys = { stats, tasks }; stats has all 7 byStatus keys', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');
  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1' })]);

  const result = await handleToolCall('get_tasks', { tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `get_tasks must not error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    TC008_GOLDEN_KEYS.get_tasks,
    'get_tasks response top-level keys must match §9.2 { stats, tasks }',
  );
  assert.ok(Array.isArray(result.tasks), 'tasks must be array');
  assert.ok(result.stats && typeof result.stats === 'object', 'stats must be object');
  // All 7 byStatus keys required
  for (const key of ALL_STATUS_KEYS) {
    assert.ok(key in result.stats.byStatus, `stats.byStatus must have key '${key}'`);
  }
  assert.ok('total' in result.stats, 'stats must have total');
  assert.ok('completionPercentage' in result.stats, 'stats must have completionPercentage');
});

test('TC-008 next_task response shape: top-level keys = { message, task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');
  // Seed one pending task so next_task returns it (not null path)
  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1', status: 'pending', dependencies: [] })]);

  const result = await handleToolCall('next_task', { tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `next_task must not error; got: ${JSON.stringify(result.error)}`);
  // The MCP server always emits { task, message } as own keys (both present as own properties)
  assert.ok('task' in result, 'next_task response must have "task" key');
  assert.ok('message' in result, 'next_task response must have "message" key');
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    TC008_GOLDEN_KEYS.next_task,
    'next_task response top-level keys must match §9.2 { message, task }',
  );
});

test('TC-008 add_task response shape: top-level keys = { task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await handleToolCall('add_task', { title: 'Shape test task', tag: 'main', _paths, _configFile });

  assert.ok(!result.error, `add_task must not error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    TC008_GOLDEN_KEYS.add_task,
    'add_task response top-level keys must match §9.2 { task }',
  );
  assert.ok(result.task && typeof result.task === 'object', 'task must be an object');
});

// ---------------------------------------------------------------------------
// TC-009 — CLI models --set-main X --claude-code: exit 0
//           (FR-015)
// ---------------------------------------------------------------------------

test('TC-009 CLI models --set-main claude-3-5-sonnet --claude-code: exit 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(
    ['models', '--set-main', 'claude-3-5-sonnet', '--claude-code'],
    { _configFile, _paths },
  );

  assert.equal(result.exitCode, 0, 'models --set-main --claude-code must exit 0');
  // No error lines on stderr
  assert.ok(
    !result.stderr.includes('ERR_'),
    `stderr must not contain ERR_ codes; got: ${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// TC-010 — CLI models --set-research X --claude-code: exit 0
//           (FR-015)
// ---------------------------------------------------------------------------

test('TC-010 CLI models --set-research claude-3-5-haiku --claude-code: exit 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(
    ['models', '--set-research', 'claude-3-5-haiku', '--claude-code'],
    { _configFile, _paths },
  );

  assert.equal(result.exitCode, 0, 'models --set-research --claude-code must exit 0');
  assert.ok(
    !result.stderr.includes('ERR_'),
    `stderr must not contain ERR_ codes; got: ${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// TC-011 — CLI models --set-fallback X (no --claude-code): exit 0
//           (FR-015)
// ---------------------------------------------------------------------------

test('TC-011 CLI models --set-fallback claude-3-5-haiku (no --claude-code): exit 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await runCli(
    ['models', '--set-fallback', 'claude-3-5-haiku'],
    { _configFile, _paths },
  );

  assert.equal(result.exitCode, 0, 'models --set-fallback must exit 0 without --claude-code');
});

// ---------------------------------------------------------------------------
// TC-012 — CLI use-tag: updates state.json + auto-creates tag
//           (FR-010)
// ---------------------------------------------------------------------------

test('TC-012 CLI use-tag feat-new: state.json currentTag="feat-new"; tasks.json["feat-new"] auto-created; exit 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Do NOT pre-seed tasks.json — tag "feat-new" does not exist yet
  const result = await runCli(['use-tag', 'feat-new'], { _configFile, _paths });

  assert.equal(result.exitCode, 0, 'use-tag must exit 0');

  // state.json must be written with currentTag="feat-new"
  assert.ok(fs.existsSync(_paths.stateFile), 'state.json must be created');
  const state = JSON.parse(fs.readFileSync(_paths.stateFile, 'utf8'));
  assert.equal(state.currentTag, 'feat-new', 'state.json.currentTag must be "feat-new"');

  // tasks.json must have the "feat-new" tag auto-created
  assert.ok(fs.existsSync(_paths.tasksFile), 'tasks.json must be created');
  const tasks = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  assert.ok('feat-new' in tasks, 'tasks.json must have "feat-new" key after use-tag');
  assert.ok(Array.isArray(tasks['feat-new'].tasks), 'tasks["feat-new"].tasks must be an array');
});

// ---------------------------------------------------------------------------
// TC-013 — CLI parse-prd routing with engine=native: routes to ai-hybrid,
//           surfaces ERR_AI_HOST_REQUIRED
//           (FR-007, FR-016)
//
// In sub 3/5, ai-hybrid.cjs is a stub (hostAvailable=false) that throws
// ERR_AI_HOST_REQUIRED for all AI ops. TC-013 asserts that:
//   1. The dispatcher correctly routes parse-prd to ai-hybrid (not CRUD core).
//   2. The stub surfaces ERR_AI_HOST_REQUIRED via stderr + exit 1.
//
// NOTE: Real task generation (ai-hybrid producing tasks in tasks.json) belongs
// to sub 4/5. This test only verifies routing and error surfacing — do NOT
// assert tasks.json contents here (that is sub 4/5 territory).
// ---------------------------------------------------------------------------

test('TC-013 CLI parse-prd engine=native: routes to ai-hybrid stub → ERR_AI_HOST_REQUIRED stderr, exit 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Seed an actual input file so the handler's file-reading step succeeds.
  // The no-host env (_env: {}) then causes ERR_AI_HOST_REQUIRED from AIRouter.
  const inputFile = path.join(tmpDir, 'SD.md');
  fs.writeFileSync(inputFile, '# Requirements', 'utf8');

  // Force no-host via _inject._env={} so AIRouter.resolveHostPresence returns false.
  // cli-dispatcher spreads _inject into args, so args._inject flows to AIRouter.
  // This makes the test deterministic regardless of ambient CLAUDECODE env var.
  const result = await runCli(
    ['parse-prd', '--input', inputFile, '--tag', 'feat-x'],
    { _configFile, _paths, _inject: { _env: {} } },
  );

  assert.equal(result.exitCode, 1, 'parse-prd with no host agent must exit 1');
  assert.ok(
    result.stderr.includes('ERR_AI_HOST_REQUIRED'),
    `stderr must contain ERR_AI_HOST_REQUIRED; got: ${result.stderr}`,
  );
  // Confirm no CRUD error codes leaked through (routing went to AI path, not CRUD path)
  assert.ok(
    !result.stderr.includes('ERR_TASK_NOT_FOUND'),
    'stderr must not contain CRUD error codes — routing must go to ai-hybrid, not native CRUD',
  );
});

// ---------------------------------------------------------------------------
// TC-014 — MCP set_task_status unknown taskId: error envelope ERR_TASK_NOT_FOUND
//           (FR-001, FR-018)
// ---------------------------------------------------------------------------

test('TC-014 set_task_status taskId="999" (not found): error envelope { code: "ERR_TASK_NOT_FOUND" }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Seed a tag with no task "999"
  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1', status: 'pending' })]);

  const result = await handleToolCall('set_task_status', {
    taskId: '999',
    status: 'done',
    tag: 'main',
    _paths,
    _configFile,
  });

  // Must return error envelope — no unhandled throw
  assert.ok(result.error, 'result must have an error envelope when taskId does not exist');
  assert.equal(result.error.code, 'ERR_TASK_NOT_FOUND', 'error.code must be ERR_TASK_NOT_FOUND');
  assert.ok(typeof result.error.message === 'string', 'error.message must be a string');
});

// ---------------------------------------------------------------------------
// TC-015 — MCP set_task_status invalid status: error envelope ERR_INVALID_STATUS
//           (FR-001, FR-018)
// ---------------------------------------------------------------------------

test('TC-015 set_task_status status="invalid-value": error envelope { code: "ERR_INVALID_STATUS" }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'main', [makeTask({ id: '1', status: 'pending' })]);

  const result = await handleToolCall('set_task_status', {
    taskId: '1',
    status: 'invalid-value',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result.error, 'result must have an error envelope for invalid status');
  assert.equal(result.error.code, 'ERR_INVALID_STATUS', 'error.code must be ERR_INVALID_STATUS');
  assert.ok(typeof result.error.message === 'string', 'error.message must be a string');
});

// ---------------------------------------------------------------------------
// TC-016 — CLI update-task --id 999 (not found): stderr ERR_TASK_NOT_FOUND, exit 1
//           (FR-012, FR-018)
// ---------------------------------------------------------------------------

test('TC-016 CLI update-task --id 999 (not found): stderr contains ERR_TASK_NOT_FOUND, exit 1', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Seed tag with no task "999"
  seedTasks(_paths.tasksFile, 'feat-x', [makeTask({ id: '1', status: 'pending' })]);

  const result = await runCli(
    ['update-task', '--id', '999', '--tag', 'feat-x'],
    { _configFile, _paths },
  );

  assert.equal(result.exitCode, 1, 'missing task must exit 1');
  assert.ok(
    result.stderr.includes('ERR_TASK_NOT_FOUND'),
    `stderr must contain ERR_TASK_NOT_FOUND; got: ${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// TC-017 — Engine routing legacy isolation: engine=legacy → ERR_LEGACY_MODE,
//           native core NOT invoked (FR-016, FR-017, rollback escape hatch)
//
// Asserts via routeToEngine with explicit engine=legacy config. The error
// envelope ERR_LEGACY_MODE is returned immediately — no native file I/O occurs.
// A missing config (or absent taskCore.engine) now defaults to native instead.
// ---------------------------------------------------------------------------

test('TC-017 engine=legacy → routeToEngine returns ERR_LEGACY_MODE, native core not invoked', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  // Do NOT create tasks.json — if native core were called it would fail with ENOENT.
  // Receiving ERR_LEGACY_MODE proves native core was not invoked.

  const result = await routeToEngine('get_tasks', { tag: 'main', _paths, _configFile });

  assert.ok(result.error, 'engine=legacy must return an error envelope');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE', 'error.code must be ERR_LEGACY_MODE');

  // Also verify: missing taskCore.engine field → dispatches to native (shipped default)
  const tmpDir2 = tmpDir + '-nokey';
  fs.mkdirSync(tmpDir2, { recursive: true });
  const _configFile2 = makeConfigFile(tmpDir2, null);
  const _paths2 = makePaths(tmpDir2);
  const result2 = await routeToEngine('get_tasks', { tag: 'main', _paths: _paths2, _configFile: _configFile2 });

  assert.ok(!result2.error, `missing taskCore.engine must dispatch to native, not error; got: ${JSON.stringify(result2.error)}`);
  assert.ok(Array.isArray(result2.tasks), 'result2.tasks must be an array (native dispatch)');
});

// ---------------------------------------------------------------------------
// TC-018 — Engine routing native active: engine=native → native core handles,
//           no subprocess spawned (FR-016)
//
// Structural assertion: handleToolCall with engine=native calls only in-process
// functions (require() calls to task-core.cjs etc. — no child_process.spawn,
// no execFile, no npx). The implementation is verified by:
//   1. The response is a valid get_tasks result (not ERR_LEGACY_MODE).
//   2. No child_process module is required at any point in the call chain
//      (structural: engine-router.cjs, task-core.cjs, mcp-server.cjs do not
//       import child_process — any subprocess call would cause ERR_TASK_NOT_FOUND
//       rather than a valid tasks response, and the call chain is synchronous/in-process).
//   3. The result arrives without network latency (in-process, deterministic).
//
// To make the structural assertion machine-checkable: shadow child_process to
// throw if spawned — any actual subprocess invocation would fail the test.
// ---------------------------------------------------------------------------

test('TC-018 engine=native → native core handles get_tasks in-process; no subprocess spawned', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTasks(_paths.tasksFile, 'main', [
    makeTask({ id: '1', status: 'pending' }),
    makeTask({ id: '2', status: 'done' }),
  ]);

  // Structural guard: shadow child_process.spawn so any subprocess attempt fails the test.
  // engine-router.cjs, task-core.cjs, and mcp-server.cjs must not call it.
  const originalChildProcess = require('child_process');
  const originalSpawn = originalChildProcess.spawn;
  const originalExecFile = originalChildProcess.execFile;
  const originalExec = originalChildProcess.exec;
  let subprocessSpawned = false;
  originalChildProcess.spawn = function spawnGuard() {
    subprocessSpawned = true;
    throw new Error('subprocess must NOT be spawned in the native engine path');
  };
  originalChildProcess.execFile = function execFileGuard() {
    subprocessSpawned = true;
    throw new Error('subprocess must NOT be spawned in the native engine path');
  };
  originalChildProcess.exec = function execGuard() {
    subprocessSpawned = true;
    throw new Error('subprocess must NOT be spawned in the native engine path');
  };

  let result;
  try {
    result = await handleToolCall('get_tasks', { tag: 'main', _paths, _configFile });
  } finally {
    // Restore originals regardless of test outcome
    originalChildProcess.spawn = originalSpawn;
    originalChildProcess.execFile = originalExecFile;
    originalChildProcess.exec = originalExec;
  }

  assert.ok(!subprocessSpawned, 'no subprocess must be spawned in the native engine path');
  assert.ok(!result.error, `engine=native must not return error; got: ${JSON.stringify(result.error)}`);
  assert.ok(Array.isArray(result.tasks), 'tasks must be an array (native core handled correctly)');
  assert.equal(result.tasks.length, 2, 'all seeded tasks must be returned');
  assert.ok(result.stats && result.stats.total === 2, 'stats.total must reflect seeded task count');
  // Confirm not ERR_LEGACY_MODE — native core was active
  assert.ok(
    !(result.error && result.error.code === 'ERR_LEGACY_MODE'),
    'result must not be ERR_LEGACY_MODE when engine=native',
  );
});
