/**
 * Unit tests for lib/core.cjs — the shared infra + SRS/SD parsers (no command logic).
 * These require the module DIRECTLY (not via the CLI) to exercise the pure parsing/
 * generation functions in isolation. Complements flow-tools.test.cjs (CLI integration).
 *
 * Run:  node --test test/core.test.cjs   (or: node --test test/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.cjs');

// ---------------------------------------------------------------------------
// Result helpers + tiny utils
// ---------------------------------------------------------------------------

test('ok/err produce the Result contract', () => {
  assert.deepEqual(core.ok({ a: 1 }), { ok: true, data: { a: 1 } });
  assert.deepEqual(core.err('BOOM'), { ok: false, error: 'BOOM' });
});

test('slugify: lowercases, hyphenates, trims, caps length, falls back', () => {
  assert.equal(core.slugify('Outbox CDC Circuit Breaker'), 'outbox-cdc-circuit-breaker');
  assert.equal(core.slugify('  Foo / Bar!! '), 'foo-bar');
  assert.equal(core.slugify(''), 'feature');
  assert.equal(core.slugify('---'), 'feature');
  assert.ok(core.slugify('x'.repeat(200)).length <= 60);
});

test('pad3 zero-pads to 3', () => {
  assert.equal(core.pad3(1), '001');
  assert.equal(core.pad3(42), '042');
  assert.equal(core.pad3(1234), '1234');
});

test('parseArgs: --key value, positionals, trailing boolean flag', () => {
  // A flag is boolean only when last or followed by another --flag; `--force X` would
  // bind X as the value. Here --force is last → true; `pos` is a positional.
  assert.deepEqual(core.parseArgs(['--sd', 'X.md', 'pos', '--force']), { _: ['pos'], sd: 'X.md', force: true });
  assert.deepEqual(core.parseArgs([]), { _: [] });
});

test('moscowFor: first=Must, middle=Should, tail=Could', () => {
  assert.equal(core.moscowFor(0, 4), 'Must Have');
  assert.equal(core.moscowFor(1, 4), 'Should Have');
  assert.equal(core.moscowFor(3, 4), 'Could Have');
});

test('routeFor: complexity score → adaptive route', () => {
  assert.equal(core.routeFor(2), 'fast');
  assert.equal(core.routeFor(5), 'expand');
  assert.equal(core.routeFor(9), 'deep');
});

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

test('parseAllTables: extracts headers + rows, skips the --- separator', () => {
  const md = [
    '| A | B | C |',
    '| --- | --- | --- |',
    '| 1 | 2 | 3 |',
    '| x | y | z |',
  ];
  const tables = core.parseAllTables(md);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['A', 'B', 'C']);
  assert.equal(tables[0].rows.length, 2);
  assert.deepEqual(tables[0].rows[0], ['1', '2', '3']);
});

test('tcIdsForReq: explicit FR-ref column wins over fuzzy text', () => {
  const tc = {
    headers: ['TC ID', 'Flow', 'Test Case', 'Expected', 'FR'],
    rows: [
      ['TC-001', 'f', 'totally different text', 'ok', 'FR-001'],
      ['TC-002', 'f', 'unrelated', 'ok', 'FR-002'],
    ],
  };
  assert.deepEqual(core.tcIdsForReq(tc, 'the requirement prose', 'FR-001'), ['TC-001']);
});

test('tcIdsForReq: falls back to fuzzy text match when no FR column', () => {
  const tc = {
    headers: ['TC ID', 'Flow', 'Test Case', 'Expected'],
    rows: [['TC-001', 'f', 'login returns jwt', 'ok']],
  };
  assert.deepEqual(core.tcIdsForReq(tc, 'login returns jwt'), ['TC-001']);
});

// ---------------------------------------------------------------------------
// SRS parsing
// ---------------------------------------------------------------------------

test('parseSrs: featureName from "Feature:" line', () => {
  const srs = core.parseSrs('# Title\n\nFeature: My Cool Thing\n');
  assert.equal(srs.featureName, 'My Cool Thing');
});

test('parseSrs: strips a leading "SRS:" prefix from an H1-derived name (#5)', () => {
  const srs = core.parseSrs('# SRS: Outbox CDC Circuit Breaker\n\nbody\n');
  assert.equal(srs.featureName, 'Outbox CDC Circuit Breaker');
});

test('parseSrs: ID-prefix table detection is language-independent (#2)', () => {
  const md = [
    '# Feature: X',
    '',
    '## 5. Yeu cau chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | does X |',
    '| FR-2 | SHOULD | does Y |',
    '',
    '| Ma | Yeu cau |',
    '| --- | --- |',
    '| NFR-1 | fast |',
    '',
  ].join('\n');
  const srs = core.parseSrs(md);
  assert.ok(srs.frTable, 'frTable detected by FR- prefix');
  assert.equal(srs.frTable.rows.length, 2);
  assert.ok(srs.nfrTable, 'nfrTable detected by NFR- prefix');
});

// ---------------------------------------------------------------------------
// SD generation (genSd) — drives the Pass-1 skeleton + stats
// ---------------------------------------------------------------------------

test('genSd: harvests an ID-prefixed FR table into §5.1 (#2)', () => {
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | publish after commit |',
    '| FR-2 | SHOULD | retry with backoff |',
    '',
  ].join('\n'));
  const { sd, stats } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(stats.fr, 2, 'two FRs harvested by ID-prefix');
  assert.match(sd, /publish after commit/);
  assert.match(sd, /\| FR-001 \|/, 'renumbered to canonical FR-001');
});

test('genSd: free-form SRS with nothing parseable → TODO placeholders', () => {
  const srs = core.parseSrs('# Feature: Mystery\n\nJust prose, no tables, no user stories.\n');
  const { stats } = core.genSd(srs, { feature: 'mystery' });
  assert.equal(stats.fr, 0);
  assert.ok(stats.todoManualReview > 0, 'emits TODO markers when nothing harvested');
});

test('genSd: epic-scale flag trips past the FR threshold', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| FR-${i + 1} | MUST | requirement ${i} |`);
  const srs = core.parseSrs(['# Feature: Big', '', '## Reqs', '', '| Ma | P | D |', '| --- | --- | --- |', ...rows, ''].join('\n'));
  const { stats, warnings } = core.genSd(srs, { feature: 'big' });
  assert.ok(stats.fr >= 25);
  assert.ok(stats.epicScale, 'epicScale set');
  assert.ok(warnings.some((w) => /EPIC-SCALE/.test(w)));
});
