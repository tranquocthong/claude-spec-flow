/**
 * contract-compat.test.cjs — TC-008: MCP response shape contract compatibility.
 *
 * Asserts the native MCP server's response SHAPES for all 5 tools are
 * byte-compatible with the task-master-ai@0.43.1 contract as frozen in
 * SD §9.1 (Shared Type Definitions) and §9.2 (MCP Tool Contract).
 *
 * Design decision: the native server is invoked IN-PROCESS (no subprocess)
 * via handleToolCall() from lib/mcp-server.cjs. The frozen §9.1/§9.2 spec
 * text is used as the golden reference — NOT a live-spawned npx legacy server.
 * Rationale: zero-dep repo has no MCP SDK; npx would be slow/flaky and the
 * architecture (dependency-free in-process JSON-RPC handler) is not
 * handshake-compatible with the SDK stdio server anyway (SD §6.2).
 *
 * FR-006, NFR-001, NFR-003.
 *
 * Run: node test/contract-compat.test.cjs
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// In-process import — no subprocess, no MCP SDK, no network (NFR-003)
// ---------------------------------------------------------------------------
const { handleToolCall } = require('../lib/mcp-server.cjs');

// ---------------------------------------------------------------------------
// extractKeys: recursive key+type extractor (zero external deps — no lodash)
//
// Maps each value to its JavaScript typeof string or to a nested structure:
//   null      → 'null'
//   undefined → 'undefined'
//   array     → 'array'    (element shapes are NOT inspected — only existence)
//   object    → { key: extractKeys(value), ... }  (keys sorted for stable comparison)
//   primitive → typeof value  ('string', 'number', 'boolean')
//
// Used for exact structural comparison of the stats object (§9.1 Stats type)
// and for spot-checking top-level response envelopes.
// ---------------------------------------------------------------------------
function extractKeys(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (Array.isArray(val)) return 'array';
  if (typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val).sort()) {
      out[k] = extractKeys(val[k]);
    }
    return out;
  }
  return typeof val; // 'string', 'number', 'boolean'
}

// ---------------------------------------------------------------------------
// Golden shapes — frozen from SD §9.1 and §9.2
// ---------------------------------------------------------------------------

/**
 * Required top-level fields per tool response (SD §9.2 MCP Tool Contract).
 * Used with Object.keys(result).sort() for exact envelope key assertion.
 *
 * next_task: the shaper always emits { task, message } even when message is
 * undefined, so both are always present as own keys.
 */
const GOLDEN_RESPONSE_KEYS = {
  set_task_status: ['success', 'task'],          // { success: boolean, task: Task }
  get_task:        ['task'],                     // { task: Task }
  get_tasks:       ['stats', 'tasks'],           // { tasks: Task[], stats: Stats }
  next_task:       ['message', 'task'],          // { task: Task|null, message?: string }
  add_task:        ['task'],                     // { task: Task }
};

/**
 * Stats golden structure — exact match from SD §9.1 Stats type.
 * All 7 byStatus keys must be present (even when count=0), plus total and
 * completionPercentage. Derived via extractKeys for consistent comparison.
 */
const GOLDEN_STATS = extractKeys({
  byStatus: {
    // all 7 required status keys (SD §9.1) — order irrelevant; extractKeys sorts
    blocked:     0,
    cancelled:   0,
    deferred:    0,
    done:        0,
    'in-progress': 0,
    pending:     0,
    review:      0,
  },
  completionPercentage: 0,
  total:               0,
});

/**
 * Required task fields from SD §9.1 Task type (required — not optional).
 * Stored as a Set for fast subset checks in assertTaskShape().
 *
 * Note: SD §9.1 also lists optional fields (complexity?, recommendedSubtasks?,
 * expansionPrompt?). The native next_task implementation ADDITIONALLY adds
 * completionPercentage to the returned task (from subtask-manager computeCompletion).
 * These extra/optional fields are not a contract violation — callers only read
 * the fields they need. assertTaskShape() does a SUBSET check: all required
 * fields must be present; extra fields are allowed.
 */
const REQUIRED_TASK_FIELDS = new Set([
  'id', 'title', 'description', 'details', 'testStrategy',
  'priority', 'dependencies', 'status', 'subtasks', 'updatedAt',
]);

// ---------------------------------------------------------------------------
// Test helpers — isolation via os.mkdtemp (same pattern as mcp-server.test.cjs)
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'contract-compat-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

function makeConfigFile(tmpDir) {
  const dir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ taskCore: { engine: 'native' } }), 'utf8');
  return file;
}

/**
 * Seed tasks.json with 3 tasks: 2 pending + 1 done (as required by TC-008 setup).
 *
 * Layout:
 *   id=1 pending priority=medium dep=[3]    — eligible only after task 3 is done
 *   id=2 pending priority=high   dep=[]     — immediately eligible (no deps)
 *   id=3 done    priority=low    dep=[]     — already done
 *
 * next_task ordering: task 2 (high, eligible) sorts before task 1 (medium, also
 * eligible because dep 3 is done). So next_task → task 2.
 */
function seedThreeTasks(tasksFile) {
  const dir = path.dirname(tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const data = {
    main: {
      tasks: [
        {
          id: '1',
          title: 'Pending with dependency',
          description: 'Depends on task 3',
          details: '',
          testStrategy: '',
          priority: 'medium',
          dependencies: ['3'],
          status: 'pending',
          subtasks: [],
          updatedAt: now,
        },
        {
          id: '2',
          title: 'Pending no dependency',
          description: 'No deps, high priority',
          details: '',
          testStrategy: '',
          priority: 'high',
          dependencies: [],
          status: 'pending',
          subtasks: [],
          updatedAt: now,
        },
        {
          id: '3',
          title: 'Done task',
          description: 'Already completed',
          details: '',
          testStrategy: '',
          priority: 'low',
          dependencies: [],
          status: 'done',
          subtasks: [],
          updatedAt: now,
        },
      ],
      metadata: {},
    },
  };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Assert that `task` contains all required §9.1 fields with correct base types.
 * Extra fields (e.g. completionPercentage added by next_task) are allowed —
 * this is a SUBSET check, not an exact key match, because contract compatibility
 * means "nothing required is missing", not "nothing extra is present".
 *
 * @param {*}      task  - value to inspect
 * @param {string} label - test description prefix for assertion messages
 */
function assertTaskShape(task, label) {
  assert.ok(
    task !== null && typeof task === 'object' && !Array.isArray(task),
    `${label}: must be a non-null plain object`,
  );
  for (const field of REQUIRED_TASK_FIELDS) {
    assert.ok(
      field in task,
      `${label}: missing required §9.1 field '${field}' — got keys: ${Object.keys(task).sort().join(', ')}`,
    );
  }
  // Type spot-checks for critical fields
  assert.equal(typeof task.id,          'string',  `${label}.id must be string`);
  assert.equal(typeof task.title,       'string',  `${label}.title must be string`);
  assert.equal(typeof task.status,      'string',  `${label}.status must be string`);
  assert.equal(typeof task.priority,    'string',  `${label}.priority must be string`);
  assert.equal(typeof task.updatedAt,   'string',  `${label}.updatedAt must be ISO 8601 string`);
  assert.ok(Array.isArray(task.dependencies), `${label}.dependencies must be array`);
  assert.ok(Array.isArray(task.subtasks),     `${label}.subtasks must be array`);
}

// ===========================================================================
// TC-008: set_task_status — { success: boolean, task: Task }
// ===========================================================================

test('TC-008 set_task_status: response top-level keys match §9.2 { success, task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('set_task_status', {
    taskId: '2', status: 'in-progress', tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `set_task_status must not return error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    GOLDEN_RESPONSE_KEYS.set_task_status,
    'set_task_status response must have exactly top-level keys { success, task } per §9.2',
  );
});

test('TC-008 set_task_status: success is boolean and task has all required §9.1 fields', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('set_task_status', {
    taskId: '1', status: 'done', tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected; got: ${JSON.stringify(result.error)}`);
  assert.equal(typeof result.success, 'boolean', 'set_task_status.success must be boolean (§9.2)');
  assert.equal(result.success, true, 'set_task_status.success must be true on successful update');
  assertTaskShape(result.task, 'set_task_status.task');
  assert.equal(result.task.status, 'done', 'task.status must reflect the new status value');
});

// ===========================================================================
// TC-008: get_task — { task: Task }
// ===========================================================================

test('TC-008 get_task: response top-level keys match §9.2 { task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('get_task', {
    taskId: '3', tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `get_task must not return error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    GOLDEN_RESPONSE_KEYS.get_task,
    'get_task response must have exactly top-level key { task } per §9.2',
  );
});

test('TC-008 get_task: task object has all required §9.1 fields', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('get_task', {
    taskId: '3', tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected; got: ${JSON.stringify(result.error)}`);
  assertTaskShape(result.task, 'get_task.task');
  assert.equal(result.task.id, '3', 'task.id must match the requested taskId');
  assert.equal(result.task.status, 'done', 'task.status must match stored value');
});

// ===========================================================================
// TC-008: get_tasks — { tasks: Task[], stats: Stats }
// ===========================================================================

test('TC-008 get_tasks: response top-level keys match §9.2 { tasks, stats }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('get_tasks', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `get_tasks must not return error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    GOLDEN_RESPONSE_KEYS.get_tasks,
    'get_tasks response must have exactly top-level keys { stats, tasks } per §9.2',
  );
  assert.ok(Array.isArray(result.tasks), 'get_tasks.tasks must be an array');
});

test('TC-008 get_tasks: stats structure matches §9.1 Stats type exactly (extractKeys + deepStrictEqual)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('get_tasks', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected; got: ${JSON.stringify(result.error)}`);
  // Exact structural comparison: key names + types must match §9.1 Stats type golden.
  // GOLDEN_STATS = { byStatus: { 7 keys all 'number' }, completionPercentage: 'number', total: 'number' }
  assert.deepStrictEqual(
    extractKeys(result.stats),
    GOLDEN_STATS,
    `stats structure must exactly match §9.1 Stats type; got extractKeys: ${JSON.stringify(extractKeys(result.stats))}`,
  );
});

test('TC-008 get_tasks: all 7 byStatus keys present even when count is 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('get_tasks', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected; got: ${JSON.stringify(result.error)}`);
  const { stats } = result;
  assert.ok(stats && typeof stats === 'object', 'stats must be an object');

  // Mandatory: all 7 keys defined in §9.1 Stats.byStatus must be present
  const SEVEN_STATUS_KEYS = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of SEVEN_STATUS_KEYS) {
    assert.ok(
      key in stats.byStatus,
      `stats.byStatus must have key "${key}" (must be 0 when no tasks have that status, not absent)`,
    );
    assert.equal(
      typeof stats.byStatus[key],
      'number',
      `stats.byStatus["${key}"] must be a number`,
    );
  }

  // Verify computed values for seeded data: 2 pending + 1 done
  assert.equal(stats.total, 3, 'stats.total must be 3 (2 pending + 1 done)');
  assert.equal(stats.byStatus.pending,      2, 'byStatus.pending must be 2');
  assert.equal(stats.byStatus.done,         1, 'byStatus.done must be 1');
  assert.equal(stats.byStatus['in-progress'], 0, 'byStatus["in-progress"] must be 0 (not seeded)');
  assert.equal(stats.byStatus.blocked,      0, 'byStatus.blocked must be 0 (not seeded)');
  assert.equal(stats.byStatus.deferred,     0, 'byStatus.deferred must be 0 (not seeded)');
  assert.equal(stats.byStatus.cancelled,    0, 'byStatus.cancelled must be 0 (not seeded)');
  assert.equal(stats.byStatus.review,       0, 'byStatus.review must be 0 (not seeded)');
  assert.ok('completionPercentage' in stats, 'stats must have completionPercentage');
  assert.equal(typeof stats.completionPercentage, 'number', 'completionPercentage must be a number');
});

test('TC-008 get_tasks: tasks array contains task objects with all required §9.1 fields', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('get_tasks', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected; got: ${JSON.stringify(result.error)}`);
  assert.ok(Array.isArray(result.tasks), 'tasks must be an array');
  assert.equal(result.tasks.length, 3, 'must return all 3 seeded tasks');
  for (const task of result.tasks) {
    assertTaskShape(task, `get_tasks.tasks[id=${task.id}]`);
  }
});

test('TC-008 get_tasks: byStatus all 7 keys present when tag is empty (all counts are 0)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  // Empty tag — no tasks
  const dir = path.dirname(_paths.tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify({ main: { tasks: [], metadata: {} } }), 'utf8');

  const result = await handleToolCall('get_tasks', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected for empty tag; got: ${JSON.stringify(result.error)}`);
  const SEVEN_STATUS_KEYS = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of SEVEN_STATUS_KEYS) {
    assert.ok(
      key in result.stats.byStatus,
      `byStatus must have key "${key}" even when 0; got: ${JSON.stringify(result.stats.byStatus)}`,
    );
    assert.equal(result.stats.byStatus[key], 0, `byStatus["${key}"] must be 0 for empty tag`);
  }
  assert.equal(result.stats.total, 0, 'total must be 0 for empty tag');
  assert.equal(result.stats.completionPercentage, 0, 'completionPercentage must be 0 for empty tag');
});

// ===========================================================================
// TC-008: next_task — { task: Task|null, message?: string }
// ===========================================================================

test('TC-008 next_task: response has "task" key; task has all required §9.1 fields when eligible', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('next_task', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `next_task must not return error envelope; got: ${JSON.stringify(result.error)}`);
  assert.ok('task' in result, 'next_task response must have "task" key per §9.2');
  assert.ok(result.task !== null, 'task must not be null — there is an eligible pending task');
  assertTaskShape(result.task, 'next_task.task');
});

test('TC-008 next_task: returns highest-priority eligible task (task 2, high priority, no deps)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('next_task', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected`);
  // Eligible: task 2 (high, no deps) and task 1 (medium, dep=3 which is done).
  // Task 2 wins on priority (high > medium).
  assert.equal(
    result.task.id, '2',
    'next_task must return task 2 (high priority, no deps) per §9.2 ordering rule',
  );
});

test('TC-008 next_task: response keys { task, message? } present (§9.2 shape)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('next_task', {
    tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `no error expected`);
  // §9.2: { task: Task|null, message?: string }
  // Implementation always emits message (as undefined when task found) — both keys present.
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    GOLDEN_RESPONSE_KEYS.next_task,
    'next_task response must have keys { message, task } per §9.2 (message present even if undefined)',
  );
  // When a task is found, message must be undefined (not an error string)
  assert.equal(
    result.message, undefined,
    'next_task.message must be undefined when a task is returned (not a warning string)',
  );
});

test('TC-008 next_task: { task: null, message: string } when no eligible task exists', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);

  // All tasks done — no pending tasks remain
  const now = new Date().toISOString();
  const data = {
    main: {
      tasks: [
        { id: '1', title: 'Done A', description: '', details: '', testStrategy: '',
          priority: 'medium', dependencies: [], status: 'done', subtasks: [], updatedAt: now },
        { id: '2', title: 'Done B', description: '', details: '', testStrategy: '',
          priority: 'high', dependencies: [], status: 'done', subtasks: [], updatedAt: now },
      ],
      metadata: {},
    },
  };
  const dir = path.dirname(_paths.tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const result = await handleToolCall('next_task', {
    tag: 'main', _paths, _configFile,
  });

  // §9.2: "khi không còn task đủ điều kiện, trả { task: null, message: '<lý do>' } (không throw)"
  assert.ok(
    !result.error,
    'next_task must NOT use error envelope for "no eligible task" case per §9.2 — got error',
  );
  assert.ok('task' in result, 'response must have "task" key');
  assert.equal(result.task, null, 'task must be null when no eligible task');
  assert.ok('message' in result, 'response must have "message" key per §9.2');
  assert.equal(typeof result.message, 'string', 'message must be a non-empty string');
  assert.ok(result.message.length > 0, 'message must be non-empty (explain why no task)');
});

// ===========================================================================
// TC-008: add_task — { task: Task }
// ===========================================================================

test('TC-008 add_task: response top-level keys match §9.2 { task }', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('add_task', {
    title: 'Contract compat test task', tag: 'main', _paths, _configFile,
  });

  assert.ok(!result.error, `add_task must not return error; got: ${JSON.stringify(result.error)}`);
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    GOLDEN_RESPONSE_KEYS.add_task,
    'add_task response must have exactly top-level key { task } per §9.2',
  );
});

test('TC-008 add_task: task object has all required §9.1 fields with auto-assigned id', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir);
  seedThreeTasks(_paths.tasksFile);

  const result = await handleToolCall('add_task', {
    title: 'New contract task',
    description: 'Verifying full field set',
    priority: 'high',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `no error expected; got: ${JSON.stringify(result.error)}`);
  assertTaskShape(result.task, 'add_task.task');
  // Auto-assigned id: 3 tasks already in tag (ids 1,2,3) → next id must be '4' (§9.2 FR-005)
  assert.equal(result.task.id, '4', 'add_task must auto-assign id=4 (max existing id=3, next=4)');
  assert.equal(result.task.status, 'pending', 'newly added task must have status=pending');
  assert.equal(result.task.title, 'New contract task', 'task.title must match the provided title');
  assert.deepStrictEqual(result.task.dependencies, [], 'task.dependencies must be [] when not specified');
  assert.deepStrictEqual(result.task.subtasks, [], 'task.subtasks must be [] for a new task');
  // updatedAt must be a valid ISO 8601 timestamp
  assert.ok(
    !isNaN(Date.parse(result.task.updatedAt)),
    `task.updatedAt must be a parseable ISO 8601 string; got: ${result.task.updatedAt}`,
  );
});
