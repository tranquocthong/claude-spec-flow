/**
 * Unit tests for lib/engine-router.cjs — config-driven engine dispatch.
 *
 * Covers FR-016 (read config once per invocation), FR-017 (fail-open / legacy
 * mode), FR-018 (native CRUD routing), FR-019 (invocation context logging).
 *
 * Test strategy cases (from task spec):
 *   (a) config missing → ERR_LEGACY_MODE
 *   (b) engine=legacy → ERR_LEGACY_MODE for all ops
 *   (c) engine=native + CRUD op → calls native fn and propagates result
 *   (d) engine=native + AI op with ai-hybrid missing → ERR_AI_HOST_REQUIRED
 *   (e) native error (ERR_TASK_NOT_FOUND) wrapped as {error:{code,message}}
 *   (f) invocation context logged before error propagation
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths and
 * _configFile so the real .taskmaster/ and .spec-flow/ are NEVER touched.
 *
 * Run:  node test/engine-router.test.cjs
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

let engineRouter;
test('engine-router module imports without throwing', () => {
  engineRouter = require('../lib/engine-router.cjs');
});

// ---------------------------------------------------------------------------
// Helper — each test gets its own isolated tmp directory so no shared state
// leaks between tests.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-router-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Write a .spec-flow/config.json in the given dir and return the path.
 * If engineValue is undefined, writes config WITHOUT taskCore.engine set.
 * If engineValue is null, writes config WITHOUT taskCore key at all.
 */
function makeConfigFile(tmpDir, engineValue) {
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  let config;
  if (engineValue === null) {
    // no taskCore key at all
    config = { project: 'test' };
  } else if (engineValue === undefined) {
    // taskCore exists but no engine field
    config = { taskCore: {} };
  } else {
    config = { taskCore: { engine: engineValue } };
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  return configFile;
}

/**
 * Seed tasks.json with a single tag containing one task.
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

// ---------------------------------------------------------------------------
// (a) config missing → ERR_LEGACY_MODE (FR-017)
// When .spec-flow/config.json does not exist, the router must fall back to
// legacy mode and return { error: { code: 'ERR_LEGACY_MODE', ... } }.
// ---------------------------------------------------------------------------

test('(a) config missing: routeToEngine returns ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // Do NOT create any config file — simulate missing .spec-flow/config.json
  const _configFile = path.join(tmpDir, '.spec-flow', 'config.json');

  const result = await engineRouter.routeToEngine('get_tasks', { tag: 'main', _paths, _configFile });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE',
    'error.code must be ERR_LEGACY_MODE when config is missing');
  assert.ok(typeof result.error.message === 'string',
    'error.message must be a string');
});

// ---------------------------------------------------------------------------
// (a2) config present but taskCore.engine absent → ERR_LEGACY_MODE (FR-017)
// ---------------------------------------------------------------------------

test('(a2) taskCore.engine absent in config: routeToEngine returns ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // engine=null means taskCore key is absent
  const _configFile = makeConfigFile(tmpDir, null);

  const result = await engineRouter.routeToEngine('get_tasks', { tag: 'main', _paths, _configFile });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE',
    'error.code must be ERR_LEGACY_MODE when taskCore.engine is absent');
});

// ---------------------------------------------------------------------------
// (b) engine=legacy → ERR_LEGACY_MODE for all ops (FR-017 fail-open)
// Explicit engine='legacy' setting must return the ERR_LEGACY_MODE envelope
// for every operation type (CRUD and AI alike).
// ---------------------------------------------------------------------------

test('(b) engine=legacy: CRUD op returns ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const result = await engineRouter.routeToEngine('get_tasks', { tag: 'main', _paths, _configFile });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE',
    'error.code must be ERR_LEGACY_MODE when engine=legacy');
});

test('(b) engine=legacy: AI op also returns ERR_LEGACY_MODE', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const result = await engineRouter.routeToEngine('expand', { tag: 'main', _paths, _configFile });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_LEGACY_MODE',
    'AI ops with engine=legacy must also return ERR_LEGACY_MODE (fail-open)');
});

// ---------------------------------------------------------------------------
// (c) engine=native + CRUD op → calls native fn and propagates result (FR-018)
// Use 'get_tasks' which maps to listTasks(tag, opts, _paths).
// Seed a task and verify the router returns it via the native listTasks path.
// ---------------------------------------------------------------------------

test('(c) engine=native + get_tasks: calls listTasks and returns task list', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Seed one task in the 'main' tag
  seedTask(_paths.tasksFile, 'main', {
    id: '1',
    title: 'Seeded task',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    description: '',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await engineRouter.routeToEngine('get_tasks', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok(Array.isArray(result.tasks), 'result.tasks must be an array');
  assert.equal(result.tasks.length, 1, 'must return exactly the one seeded task');
  assert.equal(result.tasks[0].title, 'Seeded task', 'task title must match seeded value');
});

test('(c) engine=native + add_task: calls addTask and returns new task', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await engineRouter.routeToEngine('add_task', {
    tag: 'main',
    title: 'New task via router',
    description: 'Router dispatched',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.equal(result.title, 'New task via router', 'returned task title must match');
  assert.equal(result.id, '1', 'first task in new tag must have id=1');
});

test('(c) engine=native + set_task_status: calls setStatus and returns updated task', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', {
    id: '1',
    title: 'Task to update',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    description: '',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await engineRouter.routeToEngine('set_task_status', {
    taskId: '1',
    status: 'done',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.equal(result.status, 'done', 'task status must be updated to done');
});

test('(c) engine=native + next_task: calls nextTask and returns task object', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', {
    id: '1',
    title: 'Next eligible task',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    description: '',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await engineRouter.routeToEngine('next_task', {
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.ok(result.task, 'result.task must be present');
  assert.equal(result.task.title, 'Next eligible task', 'task title must match');
});

test('(c) engine=native + get_task: calls getTask and returns single task', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', {
    id: '42',
    title: 'Specific task',
    status: 'in-progress',
    priority: 'high',
    dependencies: [],
    subtasks: [],
    description: '',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await engineRouter.routeToEngine('get_task', {
    id: '42',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.equal(result.id, '42', 'returned task id must be 42');
  assert.equal(result.title, 'Specific task', 'title must match');
});

test('(c) engine=native + update-task: calls updateTask and returns updated task', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', {
    id: '5',
    title: 'Updateable task',
    status: 'pending',
    priority: 'low',
    dependencies: [],
    subtasks: [],
    description: 'original',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await engineRouter.routeToEngine('update-task', {
    id: '5',
    tag: 'main',
    description: 'updated description',
    _paths,
    _configFile,
  });

  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);
  assert.equal(result.description, 'updated description', 'description must be updated');
});

test('(c) engine=native + use-tag: calls useTag and creates tag namespace', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await engineRouter.routeToEngine('use-tag', {
    tag: 'new-feature',
    _paths,
    _configFile,
  });

  // use-tag returns void from the native fn; router should return { ok: true } or similar
  assert.ok(!result.error, `must not have error; got: ${JSON.stringify(result.error)}`);

  // Verify the tag namespace was actually created
  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  assert.ok(data['new-feature'], 'tasks.json must have the new-feature namespace');
});

// ---------------------------------------------------------------------------
// (d) engine=native + AI op → ERR_AI_HOST_REQUIRED
// The router lazy-requires ai-hybrid.cjs which delegates to AIRouter.
// Since CLAUDECODE may be set in this environment (agent session), we must
// force no-host by passing _inject._env={} through the args — engine-router
// forwards the entire args object to aiHybrid.dispatch, which passes _inject
// to AIRouter.route. Without _inject._env, the ambient CLAUDECODE=1 would
// cause the agent-native path to run (emitting a spec) instead of throwing.
// The config file sets only engine=native; ai-config defaults aiMode to
// 'agent-native' with headlessFallback:null → ERR_AI_HOST_REQUIRED.
// ---------------------------------------------------------------------------

test('(d) engine=native + AI op (expand): returns ERR_AI_HOST_REQUIRED (forced no-host env)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Force no-host via _inject._env={} so AIRouter sees no CLAUDECODE/SPEC_FLOW_HOST_AGENT.
  const result = await engineRouter.routeToEngine('expand', {
    tag: 'main',
    taskId: '1',
    _paths,
    _configFile,
    _inject: { _env: {} },
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_AI_HOST_REQUIRED',
    'error.code must be ERR_AI_HOST_REQUIRED when no host is present and no fallback');
});

test('(d) engine=native + AI op (parse-prd): returns ERR_AI_HOST_REQUIRED (forced no-host env)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = await engineRouter.routeToEngine('parse-prd', {
    tag: 'main',
    _paths,
    _configFile,
    _inject: { _env: {} },
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_AI_HOST_REQUIRED',
    'parse-prd with no host and no fallback must return ERR_AI_HOST_REQUIRED');
});

// ---------------------------------------------------------------------------
// (e) native error (ERR_TASK_NOT_FOUND) wrapped as {error:{code,message}}
// When the native core throws an Error with a .code, the router must catch it
// and wrap it into { error: { code: err.code, message: err.message } }.
// ---------------------------------------------------------------------------

test('(e) native ERR_TASK_NOT_FOUND error is wrapped in {error:{code,message}}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // tasks.json is empty — task id 999 does not exist → ERR_TASK_NOT_FOUND
  const data = { main: { tasks: [], metadata: {} } };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const result = await engineRouter.routeToEngine('set_task_status', {
    taskId: '999',
    status: 'done',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_TASK_NOT_FOUND',
    'error.code must be ERR_TASK_NOT_FOUND — native error code must be preserved');
  assert.ok(typeof result.error.message === 'string' && result.error.message.length > 0,
    'error.message must be a non-empty string');
});

test('(e) native ERR_INVALID_STATUS error is wrapped in {error:{code,message}}', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  seedTask(_paths.tasksFile, 'main', {
    id: '1',
    title: 'A task',
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    description: '',
    details: '',
    testStrategy: '',
    updatedAt: new Date().toISOString(),
  });

  const result = await engineRouter.routeToEngine('set_task_status', {
    taskId: '1',
    status: 'invalid-status-xyz',
    tag: 'main',
    _paths,
    _configFile,
  });

  assert.ok(result && result.error, 'result must have an error field');
  assert.equal(result.error.code, 'ERR_INVALID_STATUS',
    'error.code must be ERR_INVALID_STATUS — native error code must be preserved');
});

// ---------------------------------------------------------------------------
// (f) invocation context logged before error propagation (FR-018, FR-019)
// The router must log the operation name (and taskId/tag when present) before
// propagating any error. We capture console.warn/error via monkey-patching.
// ---------------------------------------------------------------------------

test('(f) invocation context (operation name + tag) is logged before error propagation', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');

  // Empty tag — will trigger ERR_TASK_NOT_FOUND
  const data = { main: { tasks: [], metadata: {} } };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const loggedMessages = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => loggedMessages.push(args.join(' '));
  console.warn = (...args) => loggedMessages.push(args.join(' '));
  console.error = (...args) => loggedMessages.push(args.join(' '));

  try {
    await engineRouter.routeToEngine('set_task_status', {
      taskId: '999',
      status: 'done',
      tag: 'main',
      _paths,
      _configFile,
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }

  const allLogged = loggedMessages.join('\n');
  assert.ok(
    allLogged.includes('set_task_status'),
    `log output must contain the operation name "set_task_status"; got: ${allLogged}`
  );
});

test('(f) invocation log goes to stderr, NOT stdout (agent-native D7 stdout stays clean)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const _configFile = makeConfigFile(tmpDir, 'native');
  const data = { main: { tasks: [{ id: '1', title: 't', description: 'd', status: 'pending', priority: 'high', dependencies: [], subtasks: [], updatedAt: '2026-01-01T00:00:00.000Z' }], metadata: {} } };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(data, null, 2), 'utf8');

  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { stdoutChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { stderrChunks.push(String(c)); return true; };
  try {
    await engineRouter.routeToEngine('get_tasks', { tag: 'main', _paths, _configFile });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.ok(!stdoutChunks.join('').includes('[engine-router]'), 'the [engine-router] invocation log must NOT appear on stdout');
  assert.ok(stderrChunks.join('').includes('[engine-router]'), 'the invocation log must be written to stderr');
});

test('(f) config-missing warning is logged (operation=get_task, no config file)', async () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // No config file created — deliberate
  const _configFile = path.join(tmpDir, '.spec-flow', 'config.json');

  const loggedMessages = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...args) => loggedMessages.push(args.join(' '));
  console.log = (...args) => loggedMessages.push(args.join(' '));

  try {
    await engineRouter.routeToEngine('get_task', {
      id: '1',
      tag: 'main',
      _paths,
      _configFile,
    });
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }

  const allLogged = loggedMessages.join('\n');
  assert.ok(
    allLogged.toLowerCase().includes('legacy') || allLogged.includes('taskCore.engine'),
    `warning log must mention "legacy" or "taskCore.engine"; got: ${allLogged}`
  );
});
