/**
 * Unit tests for lib/dependency-manager.cjs — DependencyManager module.
 *
 * Covers FR-005 (addDependency append, no-op on duplicate), FR-006 (DFS cycle detection),
 * FR-007 (ERR_DEP_NOT_FOUND when depId absent), FR-008 (removeDependency, no-op when absent),
 * FR-009 (intra-tag only — cross-tag treated as ERR_DEP_NOT_FOUND), and
 * ERR_TAG_NOT_FOUND when tag does not exist.
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths so the
 * real .taskmaster/ is NEVER touched during testing.
 *
 * Run:  node test/dependency-manager.test.cjs
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

let depManager;
test('dependency-manager module imports without throwing', () => {
  depManager = require('../lib/dependency-manager.cjs');
});

// ---------------------------------------------------------------------------
// Helper — each test gets its own isolated tmp directory so no shared state
// leaks between tests.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dep-manager-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Write a minimal tasks.json with a given tag and task list.
 * @param {string} tasksFile - destination path
 * @param {string} tag       - tag namespace name
 * @param {Array}  tasks     - task objects to populate
 */
function seedTasksFile(tasksFile, tag, tasks) {
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  const data = {
    [tag]: { tasks, metadata: {} },
  };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// TC-007 — addDependency happy path
// task "1" and "2" exist in the same tag; addDependency("1", "2", tag) must
// append "2" to task "1".dependencies[] and write atomically. (FR-005)
// ---------------------------------------------------------------------------

test('addDependency happy path: appends depId to task.dependencies and writes atomically', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-a';

  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one', dependencies: [], status: 'pending', subtasks: [] },
    { id: '2', title: 'Task two', dependencies: [], status: 'pending', subtasks: [] },
  ]);

  depManager.addDependency('1', '2', tag, _paths);

  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task1 = data[tag].tasks.find((t) => t.id === '1');
  assert.ok(task1, 'task "1" must exist in the written file');
  assert.deepEqual(task1.dependencies, ['2'], 'task "1".dependencies must be ["2"] after addDependency');
});

// ---------------------------------------------------------------------------
// TC-008 — addDependency duplicate no-op
// "2" is already in task "1".dependencies; calling addDependency("1","2",tag)
// again must not create a duplicate. (FR-005)
// ---------------------------------------------------------------------------

test('addDependency is a no-op when depId is already in task.dependencies', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-a';

  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one', dependencies: ['2'], status: 'pending', subtasks: [] },
    { id: '2', title: 'Task two', dependencies: [],  status: 'pending', subtasks: [] },
  ]);

  depManager.addDependency('1', '2', tag, _paths);

  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task1 = data[tag].tasks.find((t) => t.id === '1');
  assert.deepEqual(task1.dependencies, ['2'],
    'dependencies must still be ["2"] — no duplicate after second addDependency call');
});

// ---------------------------------------------------------------------------
// TC-010 — Direct cycle detection: A→B already exists; adding B→A throws ERR_DEP_CYCLE
// task "1".dependencies = ["2"] (1 depends on 2); addDependency("2","1",tag)
// would create 2→1 and close the loop 1→2→1. (FR-006)
// ---------------------------------------------------------------------------

test('addDependency throws ERR_DEP_CYCLE for a direct cycle (A depends on B, B depends on A)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-cycle';

  // task "1" already depends on task "2"
  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one', dependencies: ['2'], status: 'pending', subtasks: [] },
    { id: '2', title: 'Task two', dependencies: [],    status: 'pending', subtasks: [] },
  ]);

  let thrown;
  try {
    depManager.addDependency('2', '1', tag, _paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'addDependency must throw when a direct cycle would be created');
  assert.equal(thrown.code, 'ERR_DEP_CYCLE',
    'error .code must be ERR_DEP_CYCLE for a direct cycle');
});

// ---------------------------------------------------------------------------
// TC-011 — Indirect cycle detection: A→B, B→C exist; adding C→A throws ERR_DEP_CYCLE
// task "1".deps=["2"], task "2".deps=["3"]; addDependency("3","1",tag) would
// create a cycle 1→2→3→1. (FR-006)
// ---------------------------------------------------------------------------

test('addDependency throws ERR_DEP_CYCLE for an indirect cycle (A→B→C, C→A)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-indirect';

  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one',   dependencies: ['2'], status: 'pending', subtasks: [] },
    { id: '2', title: 'Task two',   dependencies: ['3'], status: 'pending', subtasks: [] },
    { id: '3', title: 'Task three', dependencies: [],    status: 'pending', subtasks: [] },
  ]);

  let thrown;
  try {
    depManager.addDependency('3', '1', tag, _paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'addDependency must throw when an indirect cycle would be created');
  assert.equal(thrown.code, 'ERR_DEP_CYCLE',
    'error .code must be ERR_DEP_CYCLE for an indirect cycle');
});

// ---------------------------------------------------------------------------
// TC-009 — addDependency: depId does not exist in the tag → ERR_DEP_NOT_FOUND (FR-007)
// ---------------------------------------------------------------------------

test('addDependency throws ERR_DEP_NOT_FOUND when depId does not exist in the tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-a';

  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one', dependencies: [], status: 'pending', subtasks: [] },
  ]);

  let thrown;
  try {
    depManager.addDependency('1', '999', tag, _paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'addDependency must throw when depId does not exist in the tag');
  assert.equal(thrown.code, 'ERR_DEP_NOT_FOUND',
    'error .code must be ERR_DEP_NOT_FOUND when depId is missing from the tag');
});

// ---------------------------------------------------------------------------
// ERR_TAG_NOT_FOUND — addDependency called with a tag that does not exist
// in tasks.json → must throw ERR_TAG_NOT_FOUND (FR-004, SD §12.2)
// ---------------------------------------------------------------------------

test('addDependency throws ERR_TAG_NOT_FOUND when the tag does not exist in tasks.json', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // tasks.json does not exist at all → no tag exists

  let thrown;
  try {
    depManager.addDependency('1', '2', 'ghost-tag', _paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'addDependency must throw when the tag does not exist');
  assert.equal(thrown.code, 'ERR_TAG_NOT_FOUND',
    'error .code must be ERR_TAG_NOT_FOUND when the tag is absent from tasks.json');
});

// ---------------------------------------------------------------------------
// TC-012 — removeDependency: depId is present → removes it and writes atomically (FR-008)
// ---------------------------------------------------------------------------

test('removeDependency removes depId from task.dependencies when present', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-remove';

  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one', dependencies: ['2'], status: 'pending', subtasks: [] },
    { id: '2', title: 'Task two', dependencies: [],   status: 'pending', subtasks: [] },
  ]);

  depManager.removeDependency('1', '2', tag, _paths);

  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task1 = data[tag].tasks.find((t) => t.id === '1');
  assert.ok(task1, 'task "1" must exist after removeDependency');
  assert.deepEqual(task1.dependencies, [],
    'task "1".dependencies must be [] after removing "2"');
});

// ---------------------------------------------------------------------------
// TC-013 — removeDependency no-op: depId not in task.dependencies → no error, file unchanged (FR-008)
// ---------------------------------------------------------------------------

test('removeDependency is a no-op and does not throw when depId is absent from dependencies', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'feat-noop';

  seedTasksFile(_paths.tasksFile, tag, [
    { id: '1', title: 'Task one', dependencies: ['3'], status: 'pending', subtasks: [] },
  ]);

  assert.doesNotThrow(
    () => depManager.removeDependency('1', '999', tag, _paths),
    'removeDependency must not throw when depId is not in the dependencies array'
  );

  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task1 = data[tag].tasks.find((t) => t.id === '1');
  assert.deepEqual(task1.dependencies, ['3'],
    'dependencies must remain unchanged when depId was not in the list');
});

// ---------------------------------------------------------------------------
// TC-014 — Cross-tag dependency rejected as ERR_DEP_NOT_FOUND (FR-009)
//
// task "1" exists only in "tag-a"; task "2" exists only in "tag-b".
// addDependency("1", "2", "tag-a") must throw ERR_DEP_NOT_FOUND because
// "2" is not in tasks.json["tag-a"].tasks at all — intra-tag only (FR-009).
// A task from a different tag is treated as nonexistent in the current tag.
// ---------------------------------------------------------------------------

test('TC-014 cross-tag dependency rejected with ERR_DEP_NOT_FOUND (intra-tag only, FR-009)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Seed tasks.json with two separate tag namespaces.
  // task "1" is in "tag-a"; task "2" is in "tag-b" — NOT in "tag-a".
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  const tasksData = {
    'tag-a': {
      tasks: [
        { id: '1', title: 'Task in A', dependencies: [], status: 'pending', subtasks: [] },
      ],
      metadata: {},
    },
    'tag-b': {
      tasks: [
        { id: '2', title: 'Task in B', dependencies: [], status: 'pending', subtasks: [] },
      ],
      metadata: {},
    },
  };
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(tasksData, null, 2), 'utf8');

  // Attempt to add cross-tag dependency: task "1" (in tag-a) depends on task "2" (only in tag-b).
  let thrown;
  try {
    depManager.addDependency('1', '2', 'tag-a', _paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'addDependency must throw for a cross-tag depId');
  assert.equal(thrown.code, 'ERR_DEP_NOT_FOUND',
    'error .code must be ERR_DEP_NOT_FOUND — task "2" is not in tag-a (cross-tag dep rejected)');

  // Verify that neither tag's data was mutated (no side effect on failure).
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task1 = stored['tag-a'].tasks.find((t) => t.id === '1');
  assert.deepEqual(task1.dependencies, [],
    'task "1" in tag-a must still have empty dependencies after rejected cross-tag dep attempt');
});

// ---------------------------------------------------------------------------
// Sequential-ops integrity: multiple addDependency calls in a row accumulate
// correctly — no corruption, no lost deps, no duplicate ids. (FR-005, NFR-004)
//
// Add deps "2" through "6" to task "1" sequentially; verify the final
// dependencies list contains exactly ["2","3","4","5","6"] in order.
// ---------------------------------------------------------------------------

test('sequential addDependency calls accumulate dependencies correctly without corruption', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'seq-tag';

  // Seed: task "1" with no deps; tasks "2" through "6" as potential deps.
  const tasks = [{ id: '1', title: 'Main task', dependencies: [], status: 'pending', subtasks: [] }];
  for (let i = 2; i <= 6; i++) {
    tasks.push({ id: String(i), title: `Dep task ${i}`, dependencies: [], status: 'pending', subtasks: [] });
  }
  seedTasksFile(_paths.tasksFile, tag, tasks);

  // Add deps one at a time — each call must read the latest state and append.
  for (let i = 2; i <= 6; i++) {
    depManager.addDependency('1', String(i), tag, _paths);
  }

  // Verify the final state: task "1".dependencies must be exactly ["2","3","4","5","6"].
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task1 = stored[tag].tasks.find((t) => t.id === '1');
  assert.ok(task1, 'task "1" must exist after sequential adds');
  assert.equal(task1.dependencies.length, 5,
    'task "1" must have exactly 5 dependencies after 5 sequential addDependency calls');
  for (let i = 2; i <= 6; i++) {
    assert.ok(task1.dependencies.includes(String(i)),
      `task "1".dependencies must include "${i}" after sequential addDependency`);
  }
});

// ---------------------------------------------------------------------------
// Long dependency chain (100+ nodes) — cycle detection is correct and fast
// (FR-006, SD §6 D2 iterative DFS, NFR-001 < 50ms per op)
//
// Build a linear chain: task 1 → 2 → 3 → ... → 100.
// Then attempt addDependency("1", "100", tag) — this would close the cycle
// 1→2→...→100→1 and must throw ERR_DEP_CYCLE.
//
// This validates: (a) DFS traverses the full chain correctly, (b) correct cycle
// detection on a 100-node graph, and (c) the op completes in reasonable time.
// ---------------------------------------------------------------------------

test('cycle detection is correct on a 100-node dependency chain (long chain, FR-006)', () => {
  const CHAIN_LEN = 100;
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'chain-tag';

  // Build 100 tasks; tasks[i] initially has no deps — we add them via addDependency.
  const tasks = [];
  for (let i = 1; i <= CHAIN_LEN; i++) {
    tasks.push({
      id: String(i),
      title: `Chain task ${i}`,
      dependencies: [],
      status: 'pending',
      subtasks: [],
    });
  }
  seedTasksFile(_paths.tasksFile, tag, tasks);

  // Build the linear chain: 2→3, 3→4, ..., 99→100 (task i depends on i+1).
  // This creates: task 2 must wait for task 3, task 3 must wait for task 4, etc.
  for (let i = 2; i < CHAIN_LEN; i++) {
    depManager.addDependency(String(i), String(i + 1), tag, _paths);
  }
  // Also add 1→2: task 1 depends on task 2 (so 1→2→3→...→100).
  depManager.addDependency('1', '2', tag, _paths);

  // Now attempt addDependency("100", "1", tag): task 100 depends on task 1.
  // This would create the cycle 1→2→3→...→100→1 and MUST throw ERR_DEP_CYCLE.
  const t0 = Date.now();
  let thrown;
  try {
    depManager.addDependency('100', '1', tag, _paths);
  } catch (e) {
    thrown = e;
  }
  const elapsed = Date.now() - t0;

  assert.ok(thrown,
    'addDependency must throw ERR_DEP_CYCLE when closing a 100-node cycle');
  assert.equal(thrown.code, 'ERR_DEP_CYCLE',
    'error .code must be ERR_DEP_CYCLE for 100-node chain cycle attempt');
  assert.ok(elapsed < 200,
    `cycle detection on 100-node chain must complete in < 200ms; took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Long dependency chain — valid dependency on 100-node chain succeeds
// (FR-005, FR-006 — no cycle, DFS traverses full chain and finds no taskId)
//
// Same 100-node linear chain, but add a valid dep from a new node (101)
// that does not close a cycle — must succeed without error.
// ---------------------------------------------------------------------------

test('addDependency succeeds on a 100-node chain when no cycle would be created (FR-005)', () => {
  const CHAIN_LEN = 100;
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const tag = 'valid-chain-tag';

  // Build 101 tasks: tasks 1..100 form the chain; task 101 is standalone.
  const tasks = [];
  for (let i = 1; i <= CHAIN_LEN + 1; i++) {
    tasks.push({
      id: String(i),
      title: `Chain task ${i}`,
      dependencies: [],
      status: 'pending',
      subtasks: [],
    });
  }
  seedTasksFile(_paths.tasksFile, tag, tasks);

  // Build chain: 1→2→3→...→100.
  for (let i = 1; i < CHAIN_LEN; i++) {
    depManager.addDependency(String(i), String(i + 1), tag, _paths);
  }

  // addDependency("101", "100", tag): task 101 depends on task 100.
  // DFS from "100" through the full chain finds {100,99,...,1} but never "101".
  // → no cycle; must succeed.
  assert.doesNotThrow(
    () => depManager.addDependency('101', '100', tag, _paths),
    'addDependency must succeed when adding a dep at the end of a 100-node chain (no cycle)'
  );

  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const task101 = stored[tag].tasks.find((t) => t.id === '101');
  assert.ok(task101, 'task "101" must exist after addDependency');
  assert.deepEqual(task101.dependencies, ['100'],
    'task "101" must have ["100"] as its dependency after successful add');
});
