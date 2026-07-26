/**
 * equivalence-verify.cjs — equivalence verifier for the native task engine (FR-005, D4).
 *
 * Go/no-go release gate (SD C-2 runbook step): proves the native engine produces
 * semantically equivalent tasks.json output to the legacy engine for a deterministic
 * op sequence, BEFORE any engine flip.
 *
 * Approach — golden-based semantic equivalence (offline):
 *   D3 guarantees legacy and native share the SAME tasks.json schema, so the legacy
 *   side is represented as a GOLDEN semantic projection (expected id/deps/status result
 *   of the op sequence). The verifier runs the same sequence through the NATIVE engine
 *   and compares its semantic projection to the golden.  No network calls, no npx.
 *
 * Public API:
 *   runOpSequence(_paths)            → SemanticProjection
 *   semanticDiff(golden, actual)     → string[]
 *   verifyEquivalence(_paths, goldenOverride?, actualOverride?) → { equivalent, diff }
 *   LEGACY_GOLDEN                    → SemanticProjection (exported constant)
 *
 * CLI runner (require.main === module):
 *   Runs verifyEquivalence, prints diff to stderr, exits 0 on equivalent else 1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Load task-core for the native engine (no network, no subprocess)
// ---------------------------------------------------------------------------
const taskCore = require('./task-core.cjs');
const { addTask, setStatus, nextTask, listTasks, _readTasksFile, _writeTasksFileAtomic } = taskCore;

// ---------------------------------------------------------------------------
// LEGACY_GOLDEN — canonical expected result of the deterministic op sequence.
//
// Represents the shared-schema expectation that BOTH legacy and native engines
// must produce for the following op sequence (SD C-2 / TC-005):
//   addTask('test', { title: 'Task 1' })              → id '1', no deps
//   addTask('test', { title: 'Task 2' })              → id '2', dep on '1'
//   addTask('test', { title: 'Task 3' })              → id '3', no deps
//   setStatus('test', '1', 'done')
//   nextTask('test')                                  → task '2' (lowest eligible pending)
//   listTasks('test', { status: 'pending' })          → tasks '2', '3'
//
// Projection fields (non-semantic fields like updatedAt/titles excluded):
//   tagSnapshot    — { id, dependencies, status }[] sorted by numeric id
//   nextTaskId     — string id returned by nextTask, or null
//   pendingTaskIds — string[] ids from listTasks(pending), in result order
//
// D3: legacy and native share the same schema, so this is the ground truth
// both engines must satisfy. If native produces a different value, it is a
// real engine defect — do NOT adjust the golden to hide it.
// ---------------------------------------------------------------------------
const LEGACY_GOLDEN = {
  tagSnapshot: [
    { id: '1', dependencies: [], status: 'done' },
    { id: '2', dependencies: ['1'], status: 'pending' },
    { id: '3', dependencies: [], status: 'pending' },
  ],
  nextTaskId: '2',
  pendingTaskIds: ['2', '3'],
};

// ---------------------------------------------------------------------------
// runOpSequence(_paths) → SemanticProjection
//
// Runs the deterministic C-2 op sequence through the native task-core engine
// in an isolated directory, then extracts and returns the semantic projection.
// Excludes non-semantic fields (updatedAt, titles) so the projection is stable
// across runs regardless of timestamp variance.
//
// Op sequence:
//   1. addTask x3 (all medium priority; task 2 depends on task 1)
//   2. setStatus task '1' → 'done'
//   3. nextTask
//   4. listTasks(pending)
//
// The dependency for task 2 is set by reading and patching the tasks file
// directly (using task-core's own internal helpers) immediately after adding
// the task, because addTask always initializes dependencies:[] per FR-003.
//
// @param {object} _paths — { tasksFile: string, stateFile: string }
//   Callers (including the CLI runner) must supply paths to an isolated tmp dir
//   so the real .taskmaster/ tree is never touched.
// @returns {{ tagSnapshot: object[], nextTaskId: string|null, pendingTaskIds: string[] }}
// ---------------------------------------------------------------------------
function runOpSequence(_paths) {
  if (!_paths || !_paths.tasksFile) {
    throw new Error('runOpSequence: _paths.tasksFile is required');
  }

  // Step 1a: add three tasks
  addTask('test', { title: 'Task 1', priority: 'medium' }, _paths);
  addTask('test', { title: 'Task 2', priority: 'medium' }, _paths);
  addTask('test', { title: 'Task 3', priority: 'medium' }, _paths);

  // Step 1b: set task 2 to depend on task 1.
  // addTask always initialises dependencies:[] (FR-003), so we patch the file
  // directly using task-core's own I/O helpers (same atomic write semantics).
  const d = _readTasksFile(_paths.tasksFile);
  const t2 = d['test'].tasks.find((t) => String(t.id) === '2');
  if (!t2) throw new Error('runOpSequence: task 2 not found after addTask sequence');
  t2.dependencies = ['1'];
  _writeTasksFileAtomic(_paths.tasksFile, d);

  // Step 2: mark task 1 done
  setStatus('test', '1', 'done', _paths);

  // Step 3: get next actionable task
  const nextResult = nextTask('test', _paths);
  const nextTaskId = (nextResult.task && nextResult.task.id) ? String(nextResult.task.id) : null;

  // Step 4: list pending tasks
  const listResult = listTasks('test', { status: 'pending' }, _paths);
  const pendingTaskIds = listResult.tasks.map((t) => String(t.id));

  // Build semantic projection — exclude non-semantic fields (updatedAt, title, etc.)
  const finalData = _readTasksFile(_paths.tasksFile);
  const allTasks = (finalData['test'] && Array.isArray(finalData['test'].tasks))
    ? finalData['test'].tasks
    : [];

  // Sort by numeric id ascending for a stable comparison
  const sorted = allTasks.slice().sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  const tagSnapshot = sorted.map((t) => ({
    id: String(t.id),
    dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
    status: t.status,
  }));

  return { tagSnapshot, nextTaskId, pendingTaskIds };
}

// ---------------------------------------------------------------------------
// semanticDiff(golden, actual) → string[]
//
// Compares two semantic projections field by field and returns an array of
// human-readable diff strings. Empty array = projections are equivalent.
//
// Checks performed:
//   1. tagSnapshot length
//   2. Per-task id, status, dependencies (by index — sorted match assumed)
//   3. nextTaskId
//   4. pendingTaskIds length and each element
//
// @param {{ tagSnapshot, nextTaskId, pendingTaskIds }} golden
// @param {{ tagSnapshot, nextTaskId, pendingTaskIds }} actual
// @returns {string[]}
// ---------------------------------------------------------------------------
function semanticDiff(golden, actual) {
  const diffs = [];

  // Guard: both must be objects
  if (!golden || typeof golden !== 'object') {
    diffs.push('golden is not a valid object');
    return diffs;
  }
  if (!actual || typeof actual !== 'object') {
    diffs.push('actual is not a valid object');
    return diffs;
  }

  // 1. tagSnapshot length
  const gSnap = Array.isArray(golden.tagSnapshot) ? golden.tagSnapshot : [];
  const aSnap = Array.isArray(actual.tagSnapshot) ? actual.tagSnapshot : [];

  if (gSnap.length !== aSnap.length) {
    diffs.push(
      `tagSnapshot length mismatch: expected ${gSnap.length}, got ${aSnap.length}`
    );
  }

  // 2. Per-task comparison (up to the shorter length)
  const len = Math.min(gSnap.length, aSnap.length);
  for (let i = 0; i < len; i++) {
    const gt = gSnap[i];
    const at = aSnap[i];

    if (String(gt.id) !== String(at.id)) {
      diffs.push(
        `tagSnapshot[${i}] id mismatch: expected '${gt.id}', got '${at.id}'`
      );
    }

    if (gt.status !== at.status) {
      diffs.push(
        `tagSnapshot[${i}] (id='${gt.id}') status mismatch: expected '${gt.status}', got '${at.status}'`
      );
    }

    const gDeps = (Array.isArray(gt.dependencies) ? gt.dependencies : []).map(String).sort();
    const aDeps = (Array.isArray(at.dependencies) ? at.dependencies : []).map(String).sort();
    if (JSON.stringify(gDeps) !== JSON.stringify(aDeps)) {
      diffs.push(
        `tagSnapshot[${i}] (id='${gt.id}') dependencies mismatch: expected [${gDeps.join(',')}], got [${aDeps.join(',')}]`
      );
    }
  }

  // 3. nextTaskId
  const gNext = golden.nextTaskId != null ? String(golden.nextTaskId) : null;
  const aNext = actual.nextTaskId != null ? String(actual.nextTaskId) : null;
  if (gNext !== aNext) {
    diffs.push(
      `nextTaskId mismatch: expected '${gNext}', got '${aNext}'`
    );
  }

  // 4. pendingTaskIds
  const gPending = Array.isArray(golden.pendingTaskIds) ? golden.pendingTaskIds.map(String) : [];
  const aPending = Array.isArray(actual.pendingTaskIds) ? actual.pendingTaskIds.map(String) : [];

  if (gPending.length !== aPending.length) {
    diffs.push(
      `pendingTaskIds length mismatch: expected ${gPending.length}, got ${aPending.length}`
    );
  }

  const pendingLen = Math.min(gPending.length, aPending.length);
  for (let i = 0; i < pendingLen; i++) {
    if (gPending[i] !== aPending[i]) {
      diffs.push(
        `pendingTaskIds[${i}] mismatch: expected '${gPending[i]}', got '${aPending[i]}'`
      );
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// verifyEquivalence(_paths, goldenOverride?, actualOverride?) → { equivalent, diff }
//
// Main gate function. Computes the actual projection via runOpSequence (or
// uses actualOverride for testing), diffs against golden, returns result.
//
// @param {object}  _paths          — path overrides for runOpSequence (can be null when
//                                    actualOverride is supplied — TC-006 usage)
// @param {object}  [goldenOverride]— use a custom golden instead of LEGACY_GOLDEN
// @param {object}  [actualOverride]— inject a pre-computed actual (TC-006: avoids I/O)
// @returns {{ equivalent: boolean, diff: string[] }}
// ---------------------------------------------------------------------------
function verifyEquivalence(_paths, goldenOverride, actualOverride) {
  const golden = goldenOverride || LEGACY_GOLDEN;
  const actual = actualOverride !== undefined ? actualOverride : runOpSequence(_paths);
  const diff = semanticDiff(golden, actual);
  return { equivalent: diff.length === 0, diff };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  LEGACY_GOLDEN,
  runOpSequence,
  semanticDiff,
  verifyEquivalence,
};

// ---------------------------------------------------------------------------
// CLI runner — operator-facing C-2 gate.
//
// Usage:  node lib/equivalence-verify.cjs
// Exit 0 → native engine is equivalent to LEGACY_GOLDEN (safe to flip).
// Exit 1 → mismatch detected; diff lines written to stderr.
//
// Creates a fresh tmp dir for isolation (no real .taskmaster/ is touched).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-verify-cli-'));
  const _paths = {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
  const { equivalent, diff } = verifyEquivalence(_paths);
  if (!equivalent) {
    process.stderr.write(diff.join('\n') + '\n');
  }
  process.exit(equivalent ? 0 : 1);
}
