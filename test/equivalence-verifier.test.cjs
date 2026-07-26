/**
 * Tests for lib/equivalence-verify.cjs — equivalence verifier (FR-005, TC-005, TC-006, D4).
 *
 * Go/no-go release gate: proves the native engine produces semantically equivalent
 * tasks.json output to the legacy engine for deterministic ops (SD C-2 runbook step).
 *
 * TC-005: runOpSequence through native core equals LEGACY_GOLDEN → verifyEquivalence
 *         returns {equivalent:true, diff:[]} → CLI runner exits 0.
 * TC-006: Injected actual with deliberately wrong id/status → semanticDiff non-empty →
 *         verifyEquivalence returns {equivalent:false} → CLI runner exits non-zero,
 *         diff describes the mismatch.
 *
 * Tests run OFFLINE and DETERMINISTIC — no npx/network calls are made.
 *
 * Run:  node test/equivalence-verifier.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let equiv;
test('equivalence-verify module imports without throwing', () => {
  equiv = require('../lib/equivalence-verify.cjs');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-verify-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

// ---------------------------------------------------------------------------
// Exports surface
// ---------------------------------------------------------------------------

test('LEGACY_GOLDEN is exported as an object', () => {
  assert.ok(equiv.LEGACY_GOLDEN !== null && typeof equiv.LEGACY_GOLDEN === 'object',
    'LEGACY_GOLDEN must be a non-null object');
});

test('LEGACY_GOLDEN has tagSnapshot array', () => {
  assert.ok(Array.isArray(equiv.LEGACY_GOLDEN.tagSnapshot),
    'LEGACY_GOLDEN.tagSnapshot must be an array');
});

test('LEGACY_GOLDEN has nextTaskId string', () => {
  assert.equal(typeof equiv.LEGACY_GOLDEN.nextTaskId, 'string',
    'LEGACY_GOLDEN.nextTaskId must be a string');
});

test('LEGACY_GOLDEN has pendingTaskIds array', () => {
  assert.ok(Array.isArray(equiv.LEGACY_GOLDEN.pendingTaskIds),
    'LEGACY_GOLDEN.pendingTaskIds must be an array');
});

test('runOpSequence is exported as a function', () => {
  assert.equal(typeof equiv.runOpSequence, 'function');
});

test('semanticDiff is exported as a function', () => {
  assert.equal(typeof equiv.semanticDiff, 'function');
});

test('verifyEquivalence is exported as a function', () => {
  assert.equal(typeof equiv.verifyEquivalence, 'function');
});

// ---------------------------------------------------------------------------
// TC-005 — native engine matches LEGACY_GOLDEN
// ---------------------------------------------------------------------------

test('TC-005: runOpSequence returns a semantic projection object', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  assert.ok(projection !== null && typeof projection === 'object', 'projection must be an object');
  assert.ok(Array.isArray(projection.tagSnapshot), 'projection.tagSnapshot must be an array');
  assert.equal(typeof projection.nextTaskId, 'string', 'projection.nextTaskId must be a string');
  assert.ok(Array.isArray(projection.pendingTaskIds), 'projection.pendingTaskIds must be an array');
});

test('TC-005: runOpSequence tagSnapshot has 3 tasks sorted by id', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  assert.equal(projection.tagSnapshot.length, 3, 'tagSnapshot must have 3 tasks');
  assert.equal(projection.tagSnapshot[0].id, '1');
  assert.equal(projection.tagSnapshot[1].id, '2');
  assert.equal(projection.tagSnapshot[2].id, '3');
});

test('TC-005: runOpSequence tagSnapshot task 1 is done with no deps', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  const t1 = projection.tagSnapshot.find((t) => t.id === '1');
  assert.ok(t1, 'task 1 must exist in tagSnapshot');
  assert.equal(t1.status, 'done', 'task 1 status must be done');
  assert.deepEqual(t1.dependencies, [], 'task 1 must have no dependencies');
});

test('TC-005: runOpSequence tagSnapshot task 2 is pending and depends on task 1', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  const t2 = projection.tagSnapshot.find((t) => t.id === '2');
  assert.ok(t2, 'task 2 must exist in tagSnapshot');
  assert.equal(t2.status, 'pending', 'task 2 status must be pending');
  assert.deepEqual(t2.dependencies, ['1'], 'task 2 must depend on task 1');
});

test('TC-005: runOpSequence tagSnapshot task 3 is pending with no deps', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  const t3 = projection.tagSnapshot.find((t) => t.id === '3');
  assert.ok(t3, 'task 3 must exist in tagSnapshot');
  assert.equal(t3.status, 'pending', 'task 3 status must be pending');
  assert.deepEqual(t3.dependencies, [], 'task 3 must have no dependencies');
});

test('TC-005: runOpSequence nextTaskId is task 2 (lowest eligible pending)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  assert.equal(projection.nextTaskId, '2',
    'nextTaskId must be 2 (task 1 done, task 2 eligible, lower id than task 3)');
});

test('TC-005: runOpSequence pendingTaskIds are [2, 3] (task 1 is done)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  assert.deepEqual(projection.pendingTaskIds, ['2', '3'],
    'pendingTaskIds must be [2, 3] — task 1 is done');
});

test('TC-005: runOpSequence result equals LEGACY_GOLDEN', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const projection = equiv.runOpSequence(_paths);
  assert.deepEqual(projection, equiv.LEGACY_GOLDEN,
    'native engine projection must equal LEGACY_GOLDEN (D3: shared schema)');
});

test('TC-005: verifyEquivalence returns {equivalent:true, diff:[]} for native engine', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const result = equiv.verifyEquivalence(_paths);
  assert.equal(result.equivalent, true, 'equivalent must be true');
  assert.deepEqual(result.diff, [], 'diff must be empty');
});

// ---------------------------------------------------------------------------
// TC-006 — deliberate mismatch detection
// ---------------------------------------------------------------------------

test('TC-006: semanticDiff returns empty array for identical projections', () => {
  const golden = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      { id: '2', dependencies: ['1'], status: 'pending' },
    ],
    nextTaskId: '2',
    pendingTaskIds: ['2'],
  };
  const diff = equiv.semanticDiff(golden, golden);
  assert.deepEqual(diff, [], 'semanticDiff must return [] for identical inputs');
});

test('TC-006: semanticDiff detects wrong task status', () => {
  const golden = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
    ],
    nextTaskId: null,
    pendingTaskIds: [],
  };
  const wrongActual = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'pending' }, // wrong: should be 'done'
    ],
    nextTaskId: null,
    pendingTaskIds: [],
  };
  const diff = equiv.semanticDiff(golden, wrongActual);
  assert.ok(diff.length > 0, 'semanticDiff must return non-empty diff for wrong status');
  assert.ok(diff.some((d) => d.includes('status') || d.includes('done') || d.includes('pending')),
    'diff must mention status mismatch');
});

test('TC-006: semanticDiff detects wrong nextTaskId', () => {
  const golden = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      { id: '2', dependencies: ['1'], status: 'pending' },
    ],
    nextTaskId: '2',
    pendingTaskIds: ['2'],
  };
  const wrongActual = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      { id: '2', dependencies: ['1'], status: 'pending' },
    ],
    nextTaskId: '1', // wrong: should be '2'
    pendingTaskIds: ['2'],
  };
  const diff = equiv.semanticDiff(golden, wrongActual);
  assert.ok(diff.length > 0, 'semanticDiff must detect wrong nextTaskId');
  assert.ok(diff.some((d) => d.includes('nextTaskId') || d.includes('next')),
    'diff must mention nextTaskId mismatch');
});

test('TC-006: semanticDiff detects wrong pendingTaskIds', () => {
  const golden = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      { id: '2', dependencies: ['1'], status: 'pending' },
      { id: '3', dependencies: [], status: 'pending' },
    ],
    nextTaskId: '2',
    pendingTaskIds: ['2', '3'],
  };
  const wrongActual = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      { id: '2', dependencies: ['1'], status: 'pending' },
      { id: '3', dependencies: [], status: 'pending' },
    ],
    nextTaskId: '2',
    pendingTaskIds: ['2'], // wrong: missing task 3
  };
  const diff = equiv.semanticDiff(golden, wrongActual);
  assert.ok(diff.length > 0, 'semanticDiff must detect wrong pendingTaskIds');
});

test('TC-006: semanticDiff detects wrong task count in tagSnapshot', () => {
  const golden = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      { id: '2', dependencies: ['1'], status: 'pending' },
    ],
    nextTaskId: '2',
    pendingTaskIds: ['2'],
  };
  const wrongActual = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'done' },
      // missing task 2
    ],
    nextTaskId: '2',
    pendingTaskIds: ['2'],
  };
  const diff = equiv.semanticDiff(golden, wrongActual);
  assert.ok(diff.length > 0, 'semanticDiff must detect missing tasks');
});

test('TC-006: verifyEquivalence returns {equivalent:false} for injected wrong actual', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  const wrongActual = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'pending' }, // wrong: should be done
      { id: '2', dependencies: ['1'], status: 'pending' },
      { id: '3', dependencies: [], status: 'pending' },
    ],
    nextTaskId: '1', // wrong: should be '2'
    pendingTaskIds: ['1', '2', '3'], // wrong: should be ['2', '3']
  };
  const result = equiv.verifyEquivalence(_paths, undefined, wrongActual);
  assert.equal(result.equivalent, false, 'equivalent must be false for wrong actual');
  assert.ok(result.diff.length > 0, 'diff must be non-empty');
});

test('TC-006: semanticDiff diff strings describe the mismatch', () => {
  const golden = equiv.LEGACY_GOLDEN;
  const wrongActual = {
    tagSnapshot: [
      { id: '1', dependencies: [], status: 'pending' }, // wrong status
      { id: '2', dependencies: ['1'], status: 'pending' },
      { id: '3', dependencies: [], status: 'pending' },
    ],
    nextTaskId: '99',
    pendingTaskIds: ['1', '2', '3'],
  };
  const diff = equiv.semanticDiff(golden, wrongActual);
  assert.ok(diff.length > 0, 'diff must be non-empty');
  // Each diff string must be a non-empty human-readable string
  for (const d of diff) {
    assert.equal(typeof d, 'string', 'each diff entry must be a string');
    assert.ok(d.length > 0, 'each diff string must be non-empty');
  }
});

// ---------------------------------------------------------------------------
// TC-005/TC-006 — CLI runner exit codes
// ---------------------------------------------------------------------------

test('TC-005: CLI runner exits 0 when native equals golden', () => {
  const modulePath = path.join(__dirname, '..', 'lib', 'equivalence-verify.cjs');
  const result = spawnSync(process.execPath, [modulePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'CLI runner must exit 0 when native equals golden');
});
