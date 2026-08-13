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

test('splitRow: `\\|` is cell text, not a column separator', () => {
  // An FR whose Requirement names an enum: the pipes belong to the VALUE. Split on
  // them and every later column shifts — route() read the priority out of the
  // Source cell and trace-build stored a truncated requirement.
  const row = '| FR-002 | status must be one of `pending\\|done\\|failed` | Must Have | BL-03 |';
  assert.deepEqual(core.splitRow(row), [
    'FR-002',
    'status must be one of `pending|done|failed`',
    'Must Have',
    'BL-03',
  ], 'four cells, and the real `|` (U+007C) is restored — never the backslash');

  // Unescaped pipes still separate (a hand-written SD stays parseable, just wrong-shaped).
  assert.equal(core.splitRow('| a | b|c | d |').length, 4);
  // Escape at the very end of the last cell: the trailing `|` is still the row terminator.
  assert.deepEqual(core.splitRow('| a | ends with \\| |'), ['a', 'ends with |']);
});

test('mdCell → splitRow round-trips a pipe-bearing value losslessly', () => {
  const payload = 'sha256(merchantId|orderId|amount)';
  const cell = core.mdCell(payload);
  assert.equal(cell, 'sha256(merchantId\\|orderId\\|amount)', 'escaped on write');
  assert.deepEqual(core.splitRow(`| FR-001 | ${cell} | Must Have | BL-01 |`)[1], payload, 'unescaped on read');
  // Already-escaped input must not double-escape (an SRS author may write `\|` themselves;
  // splitRow hands us the plain value, so a re-render stays stable).
  assert.equal(core.mdCell(core.splitRow(`| ${cell} |`)[0]), cell);
  // Newlines would break the row entirely.
  assert.equal(core.mdCell('two\nlines'), 'two lines');
  assert.equal(core.mdCell(null), '');
});

test('resolveCols: header names win over position, fallback when absent', () => {
  // 6-col enriched §13.2 — position 3 is Input / Condition, NOT Expected.
  const rich = { headers: ['TC ID', 'Flow', 'Test Case', 'Input / Condition', 'Expected Result', 'FR'], rows: [] };
  const c = core.resolveCols(rich, { id: [/tc\s*id/i, 0], text: [/test\s*case/i, 2], expected: [/expected/i, 3] });
  assert.equal(c.expected, 4);
  // 4-col skeleton — the same spec falls back to its positional index.
  const skeleton = { headers: ['TC ID', 'Flow', 'Test Case', 'Expected'], rows: [] };
  assert.equal(core.resolveCols(skeleton, { expected: [/expected/i, 3] }).expected, 3);
  // Reordered columns resolve by name.
  const swapped = { headers: ['Requirement', 'ID', 'Priority (MoSCoW)', 'Source'], rows: [] };
  const s = core.resolveCols(swapped, { id: [/\bid\b/i, 0], text: [/requirement/i, 1], priority: [/priority|moscow/i, 2] });
  assert.deepEqual([s.id, s.text, s.priority], [1, 0, 2]);
  // No headers at all → pure fallback, never -1 (which would read undefined cells).
  assert.deepEqual(core.resolveCols(null, { a: [/nope/i, 0], b: [/nah/i, 1] }), { a: 0, b: 1 });
});

test('tableShapeWarnings: flags rows that lost the header column count', () => {
  const table = {
    headers: ['ID', 'Requirement', 'Priority', 'Source'],
    rows: [
      ['FR-001', 'fine', 'Must Have', 'BL-01'],
      ['FR-002', 'status in pending', 'done', 'failed', 'Must Have', 'BL-02'], // unescaped `|`
    ],
  };
  const w = core.tableShapeWarnings(table, 'SD §5.1 FR table');
  assert.equal(w.length, 1);
  assert.match(w[0], /SD §5\.1 FR table/);
  assert.match(w[0], /FR-002 \(6 cells\)/, 'names the offending row and its actual cell count');
  assert.match(w[0], /unescaped/, 'says what to fix');
  assert.deepEqual(core.tableShapeWarnings({ headers: ['A'], rows: [['x']] }, 'ok'), [], 'well-formed → silent');
  assert.deepEqual(core.tableShapeWarnings(null, 'absent'), [], 'absent table → silent');
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

test('genSd: a `|` harvested from the SRS is escaped, so the row keeps 4 columns', () => {
  // The SRS legitimately uses `|` as a delimiter. Interpolated raw it added a column:
  // §5.1 rendered shifted AND route/trace-build read the wrong cells.
  // The SRS is itself a well-formed markdown table: it escapes its own pipes. So the
  // value round-trips SRS → splitRow (unescape) → genSd (re-escape) with no loss and
  // no double-escaping.
  const srs = core.parseSrs([
    '# Feature: Signature',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | payload = merchantId\\|orderId\\|amount, then sha256 |',
    '',
  ].join('\n'));
  const { sd } = core.genSd(srs, { feature: 'signature' });
  const frRow = sd.split('\n').find((l) => l.startsWith('| FR-001 |'));
  assert.ok(frRow, '§5.1 has an FR-001 row');
  assert.match(frRow, /merchantId\\\|orderId\\\|amount/, 'pipes escaped in the cell');
  assert.equal(core.splitRow(frRow).length, 4, 'row still has exactly 4 cells');
  assert.match(core.splitRow(frRow)[1], /merchantId\|orderId\|amount/, 'parsed value is the plain `|`');
  assert.deepEqual(core.tableShapeWarnings(
    core.parseAllTables(sd.split('\n')).find((t) => /requirement/i.test(t.headers.join(' '))),
    '§5.1',
  ), [], 'the generated §5.1 is shape-clean');
  // And the SD tells the implementer not to copy the backslash into code.
  assert.match(sd, /U\+007C/, '§5.1 carries the escaping note');
});

test('genSd: free-form SRS with nothing parseable → TODO placeholders', () => {
  const srs = core.parseSrs('# Feature: Mystery\n\nJust prose, no tables, no user stories.\n');
  const { stats } = core.genSd(srs, { feature: 'mystery' });
  assert.equal(stats.fr, 0);
  assert.ok(stats.todoManualReview > 0, 'emits TODO markers when nothing harvested');
});

test('countSdTodos: only the marker blockquote counts, not the prose that mentions it', () => {
  // Every line below legitimately contains the string in a CLEARED, approved SD.
  // A bare /TODO:MANUAL-REVIEW/ counted all of them and gated work that was ready.
  const sd = [
    '> Generated by spec-flow Pass-1 from SRS. Sections marked TODO:MANUAL-REVIEW need Pass-2.',
    '',
    '## Revision History',
    '| v0.2 | Cleared the last TODO:MANUAL-REVIEW in §7.2 | sd-author |',
    '',
    '<!-- Pass-2 summary: TODO:MANUAL-REVIEW remaining: 0 -->',
    'Prose that says a reviewer should resolve any TODO:MANUAL-REVIEW before approval.',
  ].join('\n');
  assert.equal(core.countSdTodos(sd), 0, 'prose mentions are not unresolved markers');

  const withMarkers = [sd, '', core.TODO('§7.2 column types'), core.TODO('§9.3 error mapping')].join('\n');
  assert.equal(core.countSdTodos(withMarkers), 2, 'counts exactly the TODO() blockquotes');
  assert.equal(core.countSdTodos(''), 0);
  assert.equal(core.countSdTodos(null), 0);
});

test('genSd: epic-scale flag trips past the FR threshold', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| FR-${i + 1} | MUST | requirement ${i} |`);
  const srs = core.parseSrs(['# Feature: Big', '', '## Reqs', '', '| Ma | P | D |', '| --- | --- | --- |', ...rows, ''].join('\n'));
  const { stats, warnings } = core.genSd(srs, { feature: 'big' });
  assert.ok(stats.fr >= 25);
  assert.ok(stats.epicScale, 'epicScale set');
  assert.ok(warnings.some((w) => /EPIC-SCALE/.test(w)));
});

test('parseProseBullets: groups bullets by nearest heading, skips tables and noise', () => {
  const md = [
    '# SRS — X', '',
    'intro prose no bullet', '',
    '## 5. Functional Requirements',
    '- The system MUST do A.',
    '1. The system MUST do B.',
    '| col | col2 |', '| --- | --- |', '| - not a bullet | x |',
    '- ok', // <4 chars after normalize? "ok" length 2 → skipped
    '## 6. Business Rules',
    '* BR: never do C.',
  ].join('\n');
  const m = core.parseProseBullets(md);
  const fr = m.get('5. Functional Requirements');
  assert.deepEqual(fr, ['The system MUST do A.', 'The system MUST do B.']);
  const br = m.get('6. Business Rules');
  assert.deepEqual(br, ['BR: never do C.']);
});
