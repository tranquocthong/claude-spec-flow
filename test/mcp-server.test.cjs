/**
 * Unit tests for lib/mcp-server.cjs — MCP server entry point.
 *
 * Covers FR-001..FR-006 (5 MCP tools, correct param schemas, response shapes
 * byte-compatible with task-master-ai@0.43.1).
 *
 * Test strategy cases:
 *   (a) 5 tools registered with correct names
 *   (b) each tool has correct required params in registry schema
 *   (c) tools/call for each tool returns correct response shape (happy path, engine=native)
 *   (d) get_tasks stats carries all 7 byStatus keys + completionPercentage + total
 *   (e) next_task with no eligible tasks → { task: null, message: string }
 *   (f) engine=legacy → error envelope carrying ERR_LEGACY_MODE
 *   (g) unknown tool → error envelope (ERR_UNKNOWN_TOOL)
 *   (h) missing required param → error envelope (ERR_MISSING_PARAM)
 *   (i) JSON-RPC 2.0 handler: tools/call dispatches correctly
 *   (j) JSON-RPC 2.0 handler: unknown method → error with code -32601
 *
 * Each test uses its own os.mkdtemp-isolated tmp dir with injected _paths and
 * _configFile so the real .taskmaster/ and .spec-flow/ are NEVER touched.
 *
 * Run:  node test/mcp-server.test.cjs
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

let mcpServer;
test('mcp-server module imports without throwing', () => {
  mcpServer = require('../lib/mcp-server.cjs');
});

// ---------------------------------------------------------------------------
// Helper — each test gets its own isolated tmp directory so no shared state
// leaks between tests.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Write a .spec-flow/config.json in the given tmp dir and return the path.
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
 * Seed tasks.json with a single task in the given tag.
 * Returns the task object seeded.
 */
function seedTask(tasksFile, tag, task) {
  const dir = path.dirname(tasksFile);
  fs.mkdirSync(dir, { recursive: true });
  const data = {};
  data[tag] = { tasks: [task], metadata: {} };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
  return task;
}

// Minimal task object matching schema
function makeTask(overrides) {
  return Object.assign({
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
  }, overrides);
}

// ---------------------------------------------------------------------------
// (a) 5 tools registered with correct names (FR-006)
// ---------------------------------------------------------------------------

test('(a) TOOL_REGISTRY contains exactly 5 tools with correct names', () => {
  const registry = mcpServer.TOOL_REGISTRY;
  assert.ok(registry, 'TOOL_REGISTRY must be exported');
  assert.ok(registry.set_task_status, 'set_task_status must be registered');
  assert.ok(registry.get_task, 'get_task must be registered');
  assert.ok(registry.get_tasks, 'get_tasks must be registered');
  assert.ok(registry.next_task, 'next_task must be registered');
  assert.ok(registry.add_task, 'add_task must be registered');
  const keys = Object.keys(registry);
  assert.equal(keys.length, 5, `registry must have exactly 5 tools; got: ${keys.join(', ')}`);
});

// ---------------------------------------------------------------------------
// (b) each tool has correct required params in registry schema (FR-001..FR-005)
// ---------------------------------------------------------------------------

test('(b) set_task_status: required params are [taskId, status]', () => {
  const def = mcpServer.TOOL_REGISTRY.set_task_status;
  assert.ok(Array.isArray(def.required), 'required must be an array');
  assert.ok(def.required.includes('taskId'), 'taskId must be required');
  assert.ok(def.required.includes('status'), 'status must be required');
});

test('(b) get_task: required params are [taskId]', () => {
  const def = mcpServer.TOOL_REGISTRY.get_task;
  assert.ok(Array.isArray(def.required), 'required must be an array');
  assert.ok(def.required.includes('taskId'), 'taskId must be required');
  assert.equal(def.required.length, 1, 'get_task must have exactly 1 required param');
});

test('(b) get_tasks: no required params (all optional)', () => {
  const def = mcpServer.TOOL_REGISTRY.get_tasks;
  assert.ok(Array.isArray(def.required), 'required must be an array');
  assert.equal(def.required.length, 0, 'get_tasks must have no required params');
});

test('(b) next_task: no required params (all optional)', () => {
  const def = mcpServer.TOOL_REGISTRY.next_task;
  assert.ok(Array.isArray(def.required), 'required must be an array');
  assert.equal(def.required.length, 0, 'next_task must have no required params');
});

test('(b) add_task: required params are [title]', () => {
  const def = mcpServer.TOOL_REGISTRY.add_task;
  assert.ok(Array.isArray(def.required), 'required must be an array');
  assert.ok(def.required.includes('title'), 'title must be required');
  assert.equal(def.required.length, 1, 'add_task must have exactly 1 required param');
});

// ---------------------------------------------------------------------------
// (c) tools/call for each tool returns correct response shape (FR-001..FR-005)
// Happy path: engine=native with seeded task data.
// ---------------------------------------------------------------------------

test('(c) set_task_status returns {success: boolean, task: object}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', makeTask({ id: '1', status: 'pending' }));

  const result = await mcpServer.handleToolCall('set_task_status', {
    taskId: '1',
    status: 'done',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok('success' in result, 'result must have a "success" key');
  assert.equal(typeof result.success, 'boolean', 'success must be boolean');
  assert.ok('task' in result, 'result must have a "task" key');
  assert.ok(result.task && typeof result.task === 'object', 'task must be an object');
  assert.equal(result.task.status, 'done', 'task.status must be updated to done');
});

test('(c) get_task returns {task: object}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', makeTask({ id: '7', title: 'Specific task' }));

  const result = await mcpServer.handleToolCall('get_task', {
    taskId: '7',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok('task' in result, 'result must have a "task" key');
  assert.ok(result.task && typeof result.task === 'object', 'task must be an object');
  assert.equal(result.task.id, '7', 'task.id must match requested id');
  assert.equal(result.task.title, 'Specific task', 'task.title must match');
});

test('(c) get_tasks returns {tasks: array, stats: object}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', makeTask({ id: '1', title: 'Task A' }));

  const result = await mcpServer.handleToolCall('get_tasks', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok('tasks' in result, 'result must have a "tasks" key');
  assert.ok(Array.isArray(result.tasks), 'tasks must be an array');
  assert.equal(result.tasks.length, 1, 'must return exactly the one seeded task');
  assert.ok('stats' in result, 'result must have a "stats" key');
});

test('(c) next_task returns {task: object} when eligible task exists', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', makeTask({ id: '1', status: 'pending', dependencies: [] }));

  const result = await mcpServer.handleToolCall('next_task', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok('task' in result, 'result must have a "task" key');
  assert.ok(result.task && typeof result.task === 'object', 'task must be an object');
  assert.equal(result.task.id, '1', 'returned task must be the seeded task');
});

test('(c) add_task returns {task: object} with auto-assigned id', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await mcpServer.handleToolCall('add_task', {
    title: 'New task via MCP',
    description: 'Created via MCP shim',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok('task' in result, 'result must have a "task" key');
  assert.ok(result.task && typeof result.task === 'object', 'task must be an object');
  assert.equal(result.task.title, 'New task via MCP', 'task.title must match');
  assert.ok(result.task.id, 'task must have an auto-assigned id');
});

// ---------------------------------------------------------------------------
// (d) get_tasks stats carries all 7 byStatus keys + completionPercentage + total (FR-003)
// ---------------------------------------------------------------------------

test('(d) get_tasks stats has all 7 byStatus keys and completionPercentage', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Seed tasks with different statuses to verify all 7 keys are present even when 0
  const data = {
    main: {
      tasks: [
        makeTask({ id: '1', status: 'done' }),
        makeTask({ id: '2', status: 'pending' }),
      ],
      metadata: {},
    },
  };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const result = await mcpServer.handleToolCall('get_tasks', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  const stats = result.stats;
  assert.ok(stats, 'stats must be present');

  // Must have total count
  assert.ok('total' in stats, 'stats must have a "total" key');
  assert.equal(stats.total, 2, 'total must equal number of tasks');

  // Must have byStatus with all 7 keys
  assert.ok(stats.byStatus && typeof stats.byStatus === 'object', 'stats.byStatus must be an object');
  const REQUIRED_KEYS = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in stats.byStatus,
      `stats.byStatus must have key "${key}"; got: ${JSON.stringify(stats.byStatus)}`);
    assert.equal(typeof stats.byStatus[key], 'number',
      `stats.byStatus["${key}"] must be a number`);
  }

  // Verify counts
  assert.equal(stats.byStatus.done, 1, 'byStatus.done must be 1');
  assert.equal(stats.byStatus.pending, 1, 'byStatus.pending must be 1');
  assert.equal(stats.byStatus['in-progress'], 0, 'byStatus["in-progress"] must be 0 (not seeded)');

  // Must have completionPercentage
  assert.ok('completionPercentage' in stats, 'stats must have completionPercentage');
  assert.equal(typeof stats.completionPercentage, 'number', 'completionPercentage must be a number');
});

test('(d) get_tasks stats byStatus all 7 keys present even when all are 0', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Empty tag — no tasks at all
  const data = { main: { tasks: [], metadata: {} } };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const result = await mcpServer.handleToolCall('get_tasks', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  const stats = result.stats;
  const REQUIRED_KEYS = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in stats.byStatus,
      `stats.byStatus must have key "${key}" even when 0; got: ${JSON.stringify(stats.byStatus)}`);
    assert.equal(stats.byStatus[key], 0, `stats.byStatus["${key}"] must be 0`);
  }
  assert.equal(stats.total, 0, 'total must be 0 when no tasks');
  assert.equal(stats.completionPercentage, 0, 'completionPercentage must be 0 when no tasks');
});

// ---------------------------------------------------------------------------
// (e) next_task with no eligible tasks returns { task: null, message: string } (FR-004)
// ---------------------------------------------------------------------------

test('(e) next_task with no pending tasks returns {task: null, message: string}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // All tasks done — no pending ones
  const data = {
    main: {
      tasks: [makeTask({ id: '1', status: 'done' })],
      metadata: {},
    },
  };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const result = await mcpServer.handleToolCall('next_task', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `next_task must not use error envelope for "no task" case; got: ${JSON.stringify(result)}`);
  assert.ok('task' in result, 'result must have a "task" key');
  assert.equal(result.task, null, 'task must be null when no eligible task');
  assert.ok('message' in result, 'result must have a "message" key');
  assert.ok(typeof result.message === 'string' && result.message.length > 0,
    `message must be a non-empty string; got: ${JSON.stringify(result.message)}`);
});

// ---------------------------------------------------------------------------
// (f) engine=legacy → error envelope carrying ERR_LEGACY_MODE (FR-016, FR-017)
// ---------------------------------------------------------------------------

test('(f) engine=legacy: any tool call returns error envelope with ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const result = await mcpServer.handleToolCall('get_tasks', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field for legacy mode');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE',
    'error.code must be ERR_LEGACY_MODE when engine=legacy');
  assert.ok(typeof result.error.message === 'string', 'error.message must be a string');
});

test('(f) engine=legacy: set_task_status also returns ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const result = await mcpServer.handleToolCall('set_task_status', {
    taskId: '1',
    status: 'done',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE',
    'error.code must be ERR_LEGACY_MODE when engine=legacy');
});

// ---------------------------------------------------------------------------
// (g) unknown tool → error envelope (ERR_UNKNOWN_TOOL)
// ---------------------------------------------------------------------------

test('(g) unknown tool name returns error envelope with ERR_UNKNOWN_TOOL', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await mcpServer.handleToolCall('nonexistent_tool', {
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_UNKNOWN_TOOL',
    'error.code must be ERR_UNKNOWN_TOOL for unknown tool');
  assert.ok(typeof result.error.message === 'string', 'error.message must be a string');
});

// ---------------------------------------------------------------------------
// (h) missing required param → error envelope (ERR_MISSING_PARAM)
// ---------------------------------------------------------------------------

test('(h) set_task_status: missing taskId returns ERR_MISSING_PARAM', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await mcpServer.handleToolCall('set_task_status', {
    // taskId deliberately omitted
    status: 'done',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_MISSING_PARAM',
    'error.code must be ERR_MISSING_PARAM when required param is missing');
  assert.ok(result.error.message.includes('taskId'),
    `error.message must mention the missing param "taskId"; got: ${result.error.message}`);
});

test('(h) add_task: missing title returns ERR_MISSING_PARAM', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await mcpServer.handleToolCall('add_task', {
    // title deliberately omitted
    description: 'No title here',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_MISSING_PARAM',
    'error.code must be ERR_MISSING_PARAM when title is missing');
  assert.ok(result.error.message.includes('title'),
    `error.message must mention "title"; got: ${result.error.message}`);
});

test('(h) get_task: missing taskId returns ERR_MISSING_PARAM', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await mcpServer.handleToolCall('get_task', {
    // taskId deliberately omitted
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_MISSING_PARAM',
    'error.code must be ERR_MISSING_PARAM when taskId is missing');
});

// ---------------------------------------------------------------------------
// (i) JSON-RPC 2.0 handler: tools/call dispatches correctly (FR-001..FR-005)
// ---------------------------------------------------------------------------

test('(i) handleJsonRpcRequest: tools/call with valid args returns result envelope', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const data = { main: { tasks: [], metadata: {} } };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const response = await mcpServer.handleJsonRpcRequest({
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/call',
    params: {
      name: 'get_tasks',
      arguments: { tag: 'main', _paths, _configFile },
    },
  });

  assert.equal(response.jsonrpc, '2.0', 'jsonrpc version must be "2.0"');
  assert.equal(response.id, 42, 'id must be echoed back');
  assert.ok(response.result, 'response must have result key');
  assert.ok(Array.isArray(response.result.tasks), 'result.tasks must be an array');
  assert.ok(!response.error, 'response must not have error key on success');
});

test('(i) handleJsonRpcRequest: tools/call propagates error envelope for ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const response = await mcpServer.handleJsonRpcRequest({
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: {
      name: 'get_tasks',
      arguments: { tag: 'main', _paths, _configFile },
    },
  });

  assert.equal(response.jsonrpc, '2.0', 'jsonrpc version must be "2.0"');
  assert.equal(response.id, 99, 'id must be echoed back');
  // Error from tool call should be in response.error
  assert.ok(response.error, 'response must have error key when tool returns error');
  assert.equal(response.error.code, 'ERR_LEGACY_MODE',
    'error.code must be ERR_LEGACY_MODE');
});

// ---------------------------------------------------------------------------
// (j) JSON-RPC 2.0 handler: unknown method → error with code -32601 (method not found)
// ---------------------------------------------------------------------------

test('(j) handleJsonRpcRequest: unknown method returns JSON-RPC method-not-found error', async () => {
  const response = await mcpServer.handleJsonRpcRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'unknown/method',
    params: {},
  });

  assert.equal(response.jsonrpc, '2.0', 'jsonrpc version must be "2.0"');
  assert.equal(response.id, 1, 'id must be echoed back');
  assert.ok(response.error, 'response must have error key for unknown method');
  assert.equal(response.error.code, -32601,
    'error.code must be -32601 (Method not found) per JSON-RPC 2.0 spec');
});
