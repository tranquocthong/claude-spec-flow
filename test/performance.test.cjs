/**
 * Performance and reliability tests for the native task manager tags/deps modules.
 *
 * Covers:
 *   NFR-001 (latency): p95 < 50 ms per op for useTag, addDependency, removeDependency,
 *             addSubtask, expandHook on a 50-task tag (100 iterations each op).
 *   NFR-002 (zero-network): verified by design — regex-scan the four lib source files
 *             for any network module require() or network API usage (fetch, http.request,
 *             etc.). No runtime interceptor needed; the absence is structural.
 *   Reliability: 200 sequential addSubtask calls on one parent produce correctly-
 *             incrementing hierarchical ids with no id reuse or file corruption.
 *
 * Each benchmark/test creates its own mkdtemp tmp dir with injected _paths so the
 * real .taskmaster/ is NEVER touched during testing.
 *
 * Run (standalone):   node test/performance.test.cjs
 * Run (full suite):   for f in test/*.test.cjs; do node "$f" || exit 1; done
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('node:perf_hooks');

// ---------------------------------------------------------------------------
// Module imports — these must already exist (GREEN-only test file, no RED phase;
// performance/reliability verification over existing production modules).
// ---------------------------------------------------------------------------

const { useTag } = require('../lib/tag-manager.cjs');
const { addDependency, removeDependency } = require('../lib/dependency-manager.cjs');
const { addSubtask } = require('../lib/subtask-manager.cjs');
const { expandHook } = require('../lib/expand-hook.cjs');

// ---------------------------------------------------------------------------
// Shared helpers — mirror the convention from tag-manager.test.cjs et al.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

/**
 * Write tasks.json with a single tag namespace containing the provided tasks array.
 * Mirrors the helper used in subtask-manager.test.cjs and expand-hook.test.cjs.
 */
function writeTasksFile(tasksFile, tag, tasks) {
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  const data = { [tag]: { tasks, metadata: {} } };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Build an array of 50 minimal task objects, ids "1" through "50".
 * Used to seed the tag namespace for each benchmark.
 */
function make50Tasks() {
  const tasks = [];
  for (let i = 1; i <= 50; i++) {
    tasks.push({
      id: String(i),
      title: `Task ${i}`,
      status: 'pending',
      dependencies: [],
      subtasks: [],
    });
  }
  return tasks;
}

/**
 * Compute p95 (95th-percentile) of a numeric array.
 * The array is sorted ascending; p95 is the value at the 95th percentile index.
 */
function computeP95(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

const ITERATIONS = 100;
const P95_THRESHOLD_MS = 50; // NFR-001: < 50 ms

// ---------------------------------------------------------------------------
// NFR-001 — Latency benchmarks (100 iterations per op, p95 < 50 ms)
// ---------------------------------------------------------------------------

test('NFR-001 latency: useTag p95 < 50ms over 100 iterations on 50-task tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Warm-up run (not timed) — prime module caches and OS file-buffer paths.
  useTag('perf-warmup', _paths);

  const timings = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Alternate between two tag names so each call writes an updated currentTag
    // to state.json and conditionally checks/creates the namespace in tasks.json.
    const tag = i % 2 === 0 ? 'perf-tag-a' : 'perf-tag-b';
    const t0 = performance.now();
    useTag(tag, _paths);
    timings.push(performance.now() - t0);
  }

  const p95 = computeP95(timings);
  console.log(`  useTag p95: ${p95.toFixed(2)} ms`);
  assert.ok(
    p95 < P95_THRESHOLD_MS,
    `useTag p95 (${p95.toFixed(2)} ms) must be < ${P95_THRESHOLD_MS} ms [NFR-001]`
  );
});

test('NFR-001 latency: addDependency p95 < 50ms over 100 iterations on 50-task tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeTasksFile(_paths.tasksFile, 'perf-tag', make50Tasks());

  // Warm-up: add dep '1' -> '2' once so the tag and tasks are in OS page cache.
  addDependency('1', '2', 'perf-tag', _paths);

  const timings = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Subsequent calls are no-op for the dep append (already present), but the full
    // read → validate tag → validate dep existence → DFS → check dup → atomic write
    // cycle still executes, providing a realistic hot-path benchmark (FR-005).
    const t0 = performance.now();
    addDependency('1', '2', 'perf-tag', _paths);
    timings.push(performance.now() - t0);
  }

  const p95 = computeP95(timings);
  console.log(`  addDependency p95: ${p95.toFixed(2)} ms`);
  assert.ok(
    p95 < P95_THRESHOLD_MS,
    `addDependency p95 (${p95.toFixed(2)} ms) must be < ${P95_THRESHOLD_MS} ms [NFR-001]`
  );
});

test('NFR-001 latency: removeDependency p95 < 50ms over 100 iterations on 50-task tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeTasksFile(_paths.tasksFile, 'perf-tag', make50Tasks());

  // Seed dep '1' -> '3' so the first remove is a real filter; subsequent calls are
  // no-op (dep absent), but still execute validate → read → filter → atomic write (FR-008).
  addDependency('1', '3', 'perf-tag', _paths);

  // Warm-up (removes the dep once; all benchmark iterations are the no-op path).
  removeDependency('1', '3', 'perf-tag', _paths);

  const timings = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    removeDependency('1', '3', 'perf-tag', _paths);
    timings.push(performance.now() - t0);
  }

  const p95 = computeP95(timings);
  console.log(`  removeDependency p95: ${p95.toFixed(2)} ms`);
  assert.ok(
    p95 < P95_THRESHOLD_MS,
    `removeDependency p95 (${p95.toFixed(2)} ms) must be < ${P95_THRESHOLD_MS} ms [NFR-001]`
  );
});

test('NFR-001 latency: addSubtask p95 < 50ms over 100 iterations on 50-task tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeTasksFile(_paths.tasksFile, 'perf-tag', make50Tasks());

  // Warm-up: add one subtask to task '1'.
  addSubtask('1', { title: 'Warmup subtask' }, 'perf-tag', _paths);

  const timings = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Each call genuinely appends a new subtask; the file grows slightly each iteration,
    // providing a realistic stress on the JSON parse/stringify/write path (FR-010).
    const t0 = performance.now();
    addSubtask('1', { title: `Bench subtask ${i}` }, 'perf-tag', _paths);
    timings.push(performance.now() - t0);
  }

  const p95 = computeP95(timings);
  console.log(`  addSubtask p95: ${p95.toFixed(2)} ms`);
  assert.ok(
    p95 < P95_THRESHOLD_MS,
    `addSubtask p95 (${p95.toFixed(2)} ms) must be < ${P95_THRESHOLD_MS} ms [NFR-001]`
  );
});

test('NFR-001 latency: expandHook p95 < 50ms over 100 iterations on 50-task tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  writeTasksFile(_paths.tasksFile, 'perf-tag', make50Tasks());

  // Warm-up: expand one subtask into task '2'.
  expandHook('2', [{ title: 'Warmup expand' }], 'perf-tag', _paths);

  const timings = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Single-element array each call; appends to task '2'.subtasks (FR-012, FR-013).
    const t0 = performance.now();
    expandHook('2', [{ title: `Expand bench ${i}` }], 'perf-tag', _paths);
    timings.push(performance.now() - t0);
  }

  const p95 = computeP95(timings);
  console.log(`  expandHook p95: ${p95.toFixed(2)} ms`);
  assert.ok(
    p95 < P95_THRESHOLD_MS,
    `expandHook p95 (${p95.toFixed(2)} ms) must be < ${P95_THRESHOLD_MS} ms [NFR-001]`
  );
});

// ---------------------------------------------------------------------------
// NFR-002 — Zero-network: verify by design via source-code scan
//
// No runtime network interceptor (no nock, no http.Server mock) is needed.
// Reading the source files and regex-scanning for forbidden patterns proves
// the absence of network calls deterministically and without external deps.
// ---------------------------------------------------------------------------

const LIB_FILES = [
  path.join(__dirname, '..', 'lib', 'tag-manager.cjs'),
  path.join(__dirname, '..', 'lib', 'dependency-manager.cjs'),
  path.join(__dirname, '..', 'lib', 'subtask-manager.cjs'),
  path.join(__dirname, '..', 'lib', 'expand-hook.cjs'),
];

/**
 * Matches: require('http'), require("https"), require(`net`), require('dgram'), require('tls')
 * Covers both the built-in and the node:-prefixed variants.
 */
const NETWORK_REQUIRE_RE =
  /require\s*\(\s*['"`](?:node:)?(?:http|https|net|dgram|tls)['"`]\s*\)/;

/**
 * Matches: fetch(   http.request(   https.request(
 * (common network call patterns that do not require a module import)
 */
const NETWORK_USAGE_RE = /\bfetch\s*\(|https?\.request\s*\(/;

test('NFR-002 zero-network: lib source files contain no network module require()', () => {
  for (const filePath of LIB_FILES) {
    const relPath = path.relative(path.join(__dirname, '..'), filePath);
    const src = fs.readFileSync(filePath, 'utf8');

    assert.ok(
      !NETWORK_REQUIRE_RE.test(src),
      `${relPath} must not require any network module ` +
        '(http|https|net|dgram|tls) [NFR-002 zero-network]'
    );
  }
});

test('NFR-002 zero-network: lib source files contain no fetch() or http(s).request() calls', () => {
  for (const filePath of LIB_FILES) {
    const relPath = path.relative(path.join(__dirname, '..'), filePath);
    const src = fs.readFileSync(filePath, 'utf8');

    assert.ok(
      !NETWORK_USAGE_RE.test(src),
      `${relPath} must not use fetch() or http(s).request() [NFR-002 zero-network]`
    );
  }
});

// ---------------------------------------------------------------------------
// Reliability — 200 sequential addSubtask calls with correctly-incrementing ids
//
// Verifies that repeated writes to the same parent do not corrupt the subtask
// array, skip ids, or produce duplicate ids (NFR-004 atomic write guarantee).
// ---------------------------------------------------------------------------

test('Reliability: 200 sequential addSubtask calls produce correctly-incrementing ids with no corruption', () => {
  const REPEAT = 200;
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  const parentTask = {
    id: '10',
    title: 'Reliability parent',
    status: 'pending',
    dependencies: [],
    subtasks: [],
  };
  writeTasksFile(_paths.tasksFile, 'reliability-tag', [parentTask]);

  // Each call must return the next sequential id; assert inline so the first
  // violation surfaces immediately with a clear iteration number.
  for (let i = 1; i <= REPEAT; i++) {
    const created = addSubtask('10', { title: `Subtask ${i}` }, 'reliability-tag', _paths);
    assert.equal(
      created.id,
      `10.${i}`,
      `Iteration ${i}: returned subtask id must be "10.${i}", got "${created.id}"`
    );
  }

  // Final state check: read from disk and verify the full subtask array is intact
  // and in order (confirms no corruption from the atomic write chain).
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const storedParent = stored['reliability-tag'].tasks.find((t) => String(t.id) === '10');
  assert.ok(storedParent, 'Parent task "10" must be present in the stored file');

  assert.equal(
    storedParent.subtasks.length,
    REPEAT,
    `Stored parent must have exactly ${REPEAT} subtasks; found ${storedParent.subtasks.length}`
  );

  for (let i = 0; i < REPEAT; i++) {
    assert.equal(
      storedParent.subtasks[i].id,
      `10.${i + 1}`,
      `Stored subtask[${i}].id must be "10.${i + 1}" — no corruption, no id reuse`
    );
  }
});
