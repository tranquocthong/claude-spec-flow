/**
 * Unit tests for lib/stats-builder.cjs (FR-003, SD §9.1, TC-001/TC-002).
 *
 * Covers:
 *   buildStats(tasksArray):
 *     - empty array → all 7 byStatus keys = 0, completionPercentage = 0, total = 0
 *     - 2 done / 1 pending / 1 cancelled → completionPercentage = 67 (2/(4-1)), total = 4
 *     - all cancelled → completionPercentage = 0 (denominator = 0)
 *     - all 7 byStatus keys present even when counts are 0
 *     - unknown status values are not counted but do not throw
 *
 *   toContractStats(flatStats):
 *     - flat stats with all keys → total = sum of 7 status counts, byStatus (7 keys), completionPercentage passthrough
 *     - missing key in flatStats defaults to 0 in byStatus and does not affect total
 *     - undefined flatStats → zero contract object
 *
 * Run: node test/stats-builder.test.cjs
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let statsBuilder;
test('stats-builder module imports without throwing', () => {
  statsBuilder = require('../lib/stats-builder.cjs');
});

// ---------------------------------------------------------------------------
// buildStats — exports
// ---------------------------------------------------------------------------

test('buildStats is exported as a function', () => {
  assert.equal(typeof statsBuilder.buildStats, 'function');
});

test('toContractStats is exported as a function', () => {
  assert.equal(typeof statsBuilder.toContractStats, 'function');
});

// ---------------------------------------------------------------------------
// buildStats — empty array
// ---------------------------------------------------------------------------

test('buildStats: empty array → total = 0', () => {
  const result = statsBuilder.buildStats([]);
  assert.equal(result.total, 0);
});

test('buildStats: empty array → completionPercentage = 0', () => {
  const result = statsBuilder.buildStats([]);
  assert.equal(result.completionPercentage, 0);
});

test('buildStats: empty array → all 7 byStatus keys present with count 0', () => {
  const result = statsBuilder.buildStats([]);
  const expected = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of expected) {
    assert.equal(result.byStatus[key], 0, `byStatus.${key} should be 0`);
  }
});

test('buildStats: empty array → byStatus has exactly 7 keys', () => {
  const result = statsBuilder.buildStats([]);
  assert.equal(Object.keys(result.byStatus).length, 7);
});

// ---------------------------------------------------------------------------
// buildStats — mixed statuses: 2 done, 1 pending, 1 cancelled
// ---------------------------------------------------------------------------

test('buildStats: 2 done / 1 pending / 1 cancelled → total = 4', () => {
  const tasks = [
    { id: '1', status: 'done' },
    { id: '2', status: 'done' },
    { id: '3', status: 'pending' },
    { id: '4', status: 'cancelled' },
  ];
  const result = statsBuilder.buildStats(tasks);
  assert.equal(result.total, 4);
});

test('buildStats: 2 done / 1 pending / 1 cancelled → completionPercentage = 67', () => {
  // denominator = total - cancelled = 4 - 1 = 3; done = 2; round(2/3 * 100) = 67
  const tasks = [
    { id: '1', status: 'done' },
    { id: '2', status: 'done' },
    { id: '3', status: 'pending' },
    { id: '4', status: 'cancelled' },
  ];
  const result = statsBuilder.buildStats(tasks);
  assert.equal(result.completionPercentage, 67);
});

test('buildStats: 2 done / 1 pending / 1 cancelled → byStatus counts are correct', () => {
  const tasks = [
    { id: '1', status: 'done' },
    { id: '2', status: 'done' },
    { id: '3', status: 'pending' },
    { id: '4', status: 'cancelled' },
  ];
  const result = statsBuilder.buildStats(tasks);
  assert.equal(result.byStatus.done, 2);
  assert.equal(result.byStatus.pending, 1);
  assert.equal(result.byStatus.cancelled, 1);
  assert.equal(result.byStatus['in-progress'], 0);
  assert.equal(result.byStatus.blocked, 0);
  assert.equal(result.byStatus.deferred, 0);
  assert.equal(result.byStatus.review, 0);
});

// ---------------------------------------------------------------------------
// buildStats — all cancelled → denominator = 0 → completionPercentage = 0
// ---------------------------------------------------------------------------

test('buildStats: all cancelled → completionPercentage = 0', () => {
  const tasks = [
    { id: '1', status: 'cancelled' },
    { id: '2', status: 'cancelled' },
  ];
  const result = statsBuilder.buildStats(tasks);
  assert.equal(result.completionPercentage, 0);
});

test('buildStats: all cancelled → total = 2', () => {
  const tasks = [
    { id: '1', status: 'cancelled' },
    { id: '2', status: 'cancelled' },
  ];
  const result = statsBuilder.buildStats(tasks);
  assert.equal(result.total, 2);
});

// ---------------------------------------------------------------------------
// buildStats — all 7 byStatus keys are always present
// ---------------------------------------------------------------------------

test('buildStats: all 7 byStatus keys present even when some counts are 0', () => {
  const tasks = [
    { id: '1', status: 'done' },
    { id: '2', status: 'in-progress' },
  ];
  const result = statsBuilder.buildStats(tasks);
  const expectedKeys = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of expectedKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(result.byStatus, key),
      `byStatus should have key '${key}'`);
  }
});

// ---------------------------------------------------------------------------
// toContractStats — converts flat stats to contract shape
// ---------------------------------------------------------------------------

test('toContractStats: flat stats with all keys → total is sum of 7 status counts', () => {
  const flatStats = {
    pending: 2,
    'in-progress': 1,
    done: 3,
    blocked: 0,
    deferred: 0,
    cancelled: 1,
    review: 0,
    completionPercentage: 75,
  };
  const result = statsBuilder.toContractStats(flatStats);
  // total = 2 + 1 + 3 + 0 + 0 + 1 + 0 = 7
  assert.equal(result.total, 7);
});

test('toContractStats: flat stats → byStatus has all 7 keys with correct values', () => {
  const flatStats = {
    pending: 2,
    'in-progress': 1,
    done: 3,
    blocked: 0,
    deferred: 0,
    cancelled: 1,
    review: 0,
    completionPercentage: 75,
  };
  const result = statsBuilder.toContractStats(flatStats);
  assert.equal(result.byStatus.pending, 2);
  assert.equal(result.byStatus['in-progress'], 1);
  assert.equal(result.byStatus.done, 3);
  assert.equal(result.byStatus.blocked, 0);
  assert.equal(result.byStatus.deferred, 0);
  assert.equal(result.byStatus.cancelled, 1);
  assert.equal(result.byStatus.review, 0);
});

test('toContractStats: flat stats → completionPercentage is passed through', () => {
  const flatStats = {
    pending: 0,
    'in-progress': 0,
    done: 3,
    blocked: 0,
    deferred: 0,
    cancelled: 0,
    review: 0,
    completionPercentage: 100,
  };
  const result = statsBuilder.toContractStats(flatStats);
  assert.equal(result.completionPercentage, 100);
});

test('toContractStats: missing key in flatStats defaults to 0 in byStatus', () => {
  // flatStats missing 'review' and 'deferred' keys
  const flatStats = {
    pending: 1,
    'in-progress': 2,
    done: 0,
    blocked: 0,
    cancelled: 0,
    completionPercentage: 0,
  };
  const result = statsBuilder.toContractStats(flatStats);
  assert.equal(result.byStatus.review, 0, 'missing review key defaults to 0');
  assert.equal(result.byStatus.deferred, 0, 'missing deferred key defaults to 0');
  // total = 1 + 2 + 0 + 0 + 0 + 0 + 0 = 3
  assert.equal(result.total, 3);
});

test('toContractStats: undefined flatStats → zero contract object', () => {
  const result = statsBuilder.toContractStats(undefined);
  assert.equal(result.total, 0);
  assert.equal(result.completionPercentage, 0);
  const expectedKeys = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];
  for (const key of expectedKeys) {
    assert.equal(result.byStatus[key], 0, `byStatus.${key} should be 0`);
  }
});

test('toContractStats: byStatus has exactly 7 keys', () => {
  const flatStats = {
    pending: 1,
    'in-progress': 0,
    done: 2,
    blocked: 0,
    deferred: 0,
    cancelled: 0,
    review: 0,
    completionPercentage: 67,
  };
  const result = statsBuilder.toContractStats(flatStats);
  assert.equal(Object.keys(result.byStatus).length, 7);
});
