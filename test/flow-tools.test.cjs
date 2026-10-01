/**
 * Engine test net for bin/flow-tools.cjs — zero-dep (node:test + node:assert).
 *
 * Behavioral: every case runs the real CLI (`node flow-tools.cjs <cmd>`) in a
 * throwaway temp project and asserts on the JSON Result contract. The engine has
 * no exports / require.main guard (it runs main() on load), so the CLI is the only
 * seam — which is also exactly the interface every /sf:* flow uses.
 *
 * Dev tooling — NOT loaded at runtime; not part of the plugin's behavior.
 * Run:  node --test test/flow-tools.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');

/** Run the engine; return the parsed Result even when it exits non-zero (ok:false). */
function run(args, cwd) {
  let out;
  try {
    out = execFileSync('node', [ENGINE, ...args], { cwd, encoding: 'utf8' });
  } catch (e) {
    if (e.stdout) out = String(e.stdout);
    else throw e;
  }
  const lastLine = out.trim().split('\n').pop();
  return JSON.parse(lastLine);
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-'));
  return dir;
}

function initProject(dir) {
  const r = run(['init-project', '--stack', 'node'], dir);
  assert.equal(r.ok, true, 'init-project should succeed');
  return r;
}

/** Create a real git repo with one commit on `main` under root/name; return its path. */
function makeGitRepo(root, name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: d });
  return d;
}
const branchOf = (d) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();

// ---------------------------------------------------------------------------
// Dispatch / contract
// ---------------------------------------------------------------------------

test('unknown command → ok:false UNKNOWN_COMMAND', () => {
  const dir = tmpProject();
  const r = run(['no-such-cmd'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /UNKNOWN_COMMAND/);
});

test('no command → ok:false NO_COMMAND', () => {
  const dir = tmpProject();
  const r = run([], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /NO_COMMAND/);
});

// ---------------------------------------------------------------------------
// Happy-path smoke across the main commands
// ---------------------------------------------------------------------------

test('init-project seeds .spec-flow/config.json', () => {
  const dir = tmpProject();
  initProject(dir);
  assert.ok(fs.existsSync(path.join(dir, '.spec-flow', 'config.json')), 'config.json written');
});

test('doctor / status-report return a well-formed Result (no INTERNAL)', () => {
  const dir = tmpProject();
  initProject(dir);
  for (const cmd of ['doctor', 'status-report']) {
    const r = run([cmd], dir);
    assert.equal(typeof r.ok, 'boolean', `${cmd} returns a Result`);
    if (!r.ok) assert.doesNotMatch(r.error, /^INTERNAL/, `${cmd} must not throw INTERNAL`);
  }
});

test('bug-new then bug-list reflects the new record', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['bug-new', '--desc', 'login 500 on empty body', '--severity', 'high'], dir);
  assert.equal(created.ok, true, 'bug-new ok');
  const list = run(['bug-list'], dir);
  assert.equal(list.ok, true, 'bug-list ok');
  const blob = JSON.stringify(list.data);
  assert.match(blob, /login 500 on empty body/, 'new bug appears in bug-list');
});

test('bug-new numbers from the max existing id, not a file count (no collision when a file is missing)', () => {
  const dir = tmpProject();
  initProject(dir);
  const bugsDir = path.join(dir, '.spec-flow', 'bugs');
  fs.mkdirSync(bugsDir, { recursive: true });
  // Simulate a branch that only sees 3 local files while bug-004 already
  // exists elsewhere (e.g. created on an unmerged MR) — count-based numbering
  // would recompute 004 here and collide; max-based numbering must skip to 005.
  fs.writeFileSync(path.join(bugsDir, '001-bug-a.md'), 'id: bug-001\n');
  fs.writeFileSync(path.join(bugsDir, '002-bug-b.md'), 'id: bug-002\n');
  fs.writeFileSync(path.join(bugsDir, '004-bug-d.md'), 'id: bug-004\n');
  const created = run(['bug-new', '--desc', 'gap regression'], dir);
  assert.equal(created.ok, true, 'bug-new ok');
  assert.equal(created.data.id, 'bug-005', 'next id skips past the gap instead of recolliding with bug-004');
});

test('epic-new then epic-list ok', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['epic-new', '--name', 'payments', '--subs', 'transfer,refund'], dir);
  assert.equal(created.ok, true, 'epic-new ok');
  const list = run(['epic-list'], dir);
  assert.equal(list.ok, true, 'epic-list ok');
});

// ---------------------------------------------------------------------------
// Regression — Phase 4 fixes (these would FAIL against the pre-v0.0.44 engine)
// ---------------------------------------------------------------------------

test('REGRESSION sd-skeleton: English "Non-Functional Requirements" heading is harvested (not dropped)', () => {
  // Pre-fix bug: the `detail` regex matched the "functional requirement" substring
  // inside "Non-Functional Requirements", so the NFR heading was misclassified and
  // its table silently dropped (stats.nfr === 0).
  const dir = tmpProject();
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, [
    '# Feature: Demo',
    '',
    '## 6. Non-Functional Requirements',
    '',
    '| Requirement | Category | Note |',
    '| --- | --- | --- |',
    '| p95 latency under 200ms | Perf | |',
    '| TLS 1.2+ required | Security | |',
    '',
  ].join('\n'));
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'demo', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.nfr, 2, 'both NFR rows harvested (would be 0 with the misclassification bug)');
});

test('REGRESSION trace-build: §13.2 "Expected" resolved by header on a 6-col table', () => {
  // Pre-fix bug: trace-build read `expected` positionally as r[3], which is the
  // "Input/Condition" column on the 6-col sd-author-enriched table.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns a JWT | Must Have | US-1 |',
    '',
    '## 13.2 Test Cases',
    '',
    '| TC ID | Flow | Test Case | Input/Condition | Expected Result | FR |',
    '| --- | --- | --- | --- | --- | --- |',
    '| TC-001 | Login | valid creds login | POST /auth/login valid creds | JWT returned, status 200 | FR-001 |',
    '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'trace-build ok');
  assert.equal(r.data.counts.tc, 1, 'one TC node');
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'trace.json'), 'utf8'));
  assert.equal(
    trace.nodes.tc[0].expected,
    'JWT returned, status 200',
    'expected = the "Expected Result" column (col 4), not "Input/Condition" (col 3)'
  );
});

test('REGRESSION trace-build: an escaped `\\|` in a cell keeps the trace intact', () => {
  // Pre-fix bug: splitRow split on every `|`, so an FR whose Requirement names an
  // enum or a pipe-joined payload gained cells — the FR node stored a truncated
  // requirement and read its priority out of the next column.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Signature over `merchantId\\|orderId\\|amount` | Must Have | BL-01 |',
    '',
    '## 13.2 Test Cases',
    '',
    '| TC ID | Flow | Test Case | Expected | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Sign | status is `pending\\|done` | Pass | FR-001 |',
    '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'trace-build ok');
  assert.deepEqual(r.data.warnings || [], [], 'a properly escaped SD produces no shape warning');
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'trace.json'), 'utf8'));
  assert.equal(trace.nodes.fr[0].text, 'Signature over `merchantId|orderId|amount`', 'full requirement, real `|`');
  assert.equal(trace.nodes.fr[0].priority, 'Must Have', 'priority read from its own column');
  assert.equal(trace.nodes.fr[0].source, 'BL-01');
  assert.equal(trace.nodes.tc[0].text, 'status is `pending|done`');
});

test('REGRESSION trace-build: an UNESCAPED `|` warns instead of silently mis-tracing', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | status in pending|done|failed | Must Have | BL-01 |',
    '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'still builds — a warning, never a block');
  const w = (r.data.warnings || []).join(' ');
  assert.match(w, /SD §5\.1 FR table/, 'names the table');
  assert.match(w, /FR-001 \(6 cells\)/, 'names the row and its real cell count');
  assert.match(w, /unescaped `\|`/, 'names the cause and the fix');
});

test('REGRESSION route: FR columns resolved by header, shape warning surfaced', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| ID | Requirement | Priority (MoSCoW) | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Signature over `merchantId\\|orderId\\|amount` | Must Have | BL-01 |',
    '| FR-002 | status in pending|done | Should Have | BL-02 |',
    '',
  ].join('\n'));
  const r = run(['route', '--sd', path.join(sdDir, 'SD.md')], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.items[0].requirement, 'Signature over `merchantId|orderId|amount`');
  assert.equal(r.data.items[0].priority, 'Must Have', 'escaped row: priority from its own column');
  assert.match((r.data.warnings || []).join(' '), /FR-002 \(5 cells\)/, 'the unescaped row is reported');
});

test('REGRESSION trace-build: fr-tc links via explicit FR-ref column (6-col TC table)', () => {
  // Pre-fix bug: tcIdsForReq matched tr[2] ("Test Case" description) against fr.text
  // via fuzzy includes — always 0 links on real SDs where descriptions differ.
  // Fix: resolve the "FR" column by header name and match fr.id explicitly.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | System validates webhook HMAC signature | Must Have | SRS §5.1 FR-1 |',
    '| FR-002 | System returns 200 on valid signature | Must Have | SRS §5.1 FR-2 |',
    '',
    '## 13.2 Test Cases',
    '',
    '| TC ID | Flow | Test Case | Input/Condition | Expected Result | FR |',
    '| --- | --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid signature accepted | valid HMAC header | 200 OK | FR-001 |',
    '| TC-002 | Happy path | Valid signature returns body | valid HMAC header | response body present | FR-001, FR-002 |',
    '| TC-003 | Error | Invalid signature rejected | bad HMAC header | 401 Unauthorized | FR-001 |',
    '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'trace-build ok');
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'trace.json'), 'utf8'));
  const frTcLinks = trace.links.filter(l => l.type === 'fr-tc');
  // FR-001 must link to TC-001, TC-002, TC-003 (all reference FR-001)
  const fr001TcIds = frTcLinks.filter(l => l.from === 'FR-001').map(l => l.to).sort();
  assert.deepEqual(fr001TcIds, ['TC-001', 'TC-002', 'TC-003'], 'FR-001 links to all 3 TCs via explicit FR column');
  // FR-002 must link to TC-002 only
  const fr002TcIds = frTcLinks.filter(l => l.from === 'FR-002').map(l => l.to);
  assert.deepEqual(fr002TcIds, ['TC-002'], 'FR-002 links to TC-002 via multi-value FR column');
});

test('REGRESSION trace-build: src-fr links from embedded source refs ("SRS §5.1 FR-N")', () => {
  // Pre-fix bug: src-fr regex /^(US|BL|NFR)-?\d+/i only matched sources starting
  // with those prefixes — "SRS §5.1 FR-1" was silently skipped, linkCount=0.
  // Fix: \b match extracts any FR/US/BL/AC id embedded anywhere in the source.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Validate HMAC signature | Must Have | SRS §5.1 FR-1 |',
    '| FR-002 | Return signed response | Must Have | US-5 |',
    '',
    '## 13.2 Test Cases',
    '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid request | 200 OK | FR-001 |',
    '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'trace-build ok');
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'trace.json'), 'utf8'));
  const srcFrLinks = trace.links.filter(l => l.type === 'src-fr');
  // FR-001 source "SRS §5.1 FR-1" → extracts FR-1, creates link
  const fr001src = srcFrLinks.find(l => l.to === 'FR-001');
  assert.ok(fr001src, 'FR-001 gets a src-fr link from embedded "SRS §5.1 FR-1" source');
  assert.equal(fr001src.from, 'FR-1', 'extracted id is normalized');
  // FR-002 source "US-5" → still works as before
  const fr002src = srcFrLinks.find(l => l.to === 'FR-002');
  assert.ok(fr002src, 'FR-002 gets a src-fr link from "US-5"');
  assert.equal(fr002src.from, 'US-5', 'clean US-N id preserved');
});

test('REGRESSION P1 trace clobber: per-feature trace is durable; build B never destroys A', () => {
  // Pre-fix bug: a single global .spec-flow/trace.json — trace-build --feature B
  // overwrote feature A's trace (the 103→21 link data-loss). Fix: durable copy at
  // specs/<feature>/trace.json; global is just an active-feature mirror.
  const dir = tmpProject();
  initProject(dir);
  const mkSd = (feat, frRows) => {
    const sdDir = path.join(dir, '.spec-flow', 'specs', feat);
    fs.mkdirSync(sdDir, { recursive: true });
    fs.writeFileSync(path.join(sdDir, 'SD.md'), [
      `# SD: ${feat}`, '',
      '## 5.1 Functional Requirements', '',
      '| FR ID | Requirement | Priority | Source |',
      '| --- | --- | --- | --- |',
      ...frRows,
      '',
      '## 13.2 Test Cases', '',
      '| TC ID | Flow | Test Case | Expected Result | FR |',
      '| --- | --- | --- | --- | --- |',
      '| TC-001 | F | t | ok | FR-001 |',
      '',
    ].join('\n'));
    return path.join(sdDir, 'SD.md');
  };
  const sdA = mkSd('feat-a', ['| FR-001 | A only | Must Have | US-1 |']);
  const sdB = mkSd('feat-b', ['| FR-001 | B one | Must Have | US-1 |', '| FR-002 | B two | Must Have | US-2 |']);

  const ra = run(['trace-build', '--sd', sdA, '--feature', 'feat-a'], dir);
  assert.equal(ra.ok, true);
  assert.match(ra.data.perFeatureTrace, /specs[/\\]feat-a[/\\]trace\.json$/, 'durable per-feature path returned');
  assert.equal(ra.data.switchedFrom, null, 'first build: no prior active feature');

  const rb = run(['trace-build', '--sd', sdB, '--feature', 'feat-b'], dir);
  assert.equal(rb.ok, true);
  assert.equal(rb.data.switchedFrom, 'feat-a', 'building feat-b reports the active switch from feat-a');

  // feat-a's durable trace must STILL be intact after building feat-b.
  const aTrace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'feat-a', 'trace.json'), 'utf8'));
  assert.equal(aTrace.feature, 'feat-a', 'feat-a durable trace not clobbered');
  assert.equal(aTrace.nodes.fr.length, 1, 'feat-a still has its 1 FR');

  // Global mirror now reflects feat-b (last built).
  const globalTrace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'trace.json'), 'utf8'));
  assert.equal(globalTrace.feature, 'feat-b', 'global mirror = last-built feature');

  // status-report --feature feat-a reads feat-a's durable trace, not the global mirror.
  const sa = run(['status-report', '--feature', 'feat-a'], dir);
  assert.equal(sa.ok, true);
  assert.equal(sa.data.feature, 'feat-a');
  assert.equal(sa.data.trace.fr, 1, 'status reads feat-a durable trace (1 FR), not feat-b mirror (2 FR)');
});

test('REGRESSION P1 resync guard: srs-diff flags an empty changeset (wrong-input signal)', () => {
  // Pre-fix: srs-diff against the latest snapshot of an unrelated doc returned 0/0/0
  // and resync silently ran the whole pipeline as a no-op. Now emptyChangeset + hint.
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, '.spec-flow', 'srs', 'demo.md');
  fs.mkdirSync(path.dirname(srs), { recursive: true });
  fs.writeFileSync(srs, '# Feature: Demo\n\n## 5. Business Logic\n\n| Business Logic | Note |\n| --- | --- |\n| BL-01 must do X | |\n');
  const snap = run(['srs-snapshot', '--srs', srs, '--feature', 'demo'], dir);
  assert.equal(snap.ok, true);

  // Diff the SAME content vs its snapshot → no changes.
  const same = run(['srs-diff', '--new', srs, '--feature', 'demo'], dir);
  assert.equal(same.ok, true);
  assert.equal(same.data.emptyChangeset, true, '0/0/0 diff flagged as empty');
  assert.match(same.data.hint, /ingest|change/i, 'hint routes to /sf:ingest or /sf:change');

  // A real edit → not flagged.
  fs.writeFileSync(srs, '# Feature: Demo\n\n## 5. Business Logic\n\n| Business Logic | Note |\n| --- | --- |\n| BL-01 must do X | |\n| BL-02 also do Y | |\n');
  const changed = run(['srs-diff', '--new', srs, '--feature', 'demo'], dir);
  assert.equal(changed.ok, true);
  assert.equal(changed.data.emptyChangeset, false, 'a real BL addition is not an empty changeset');
});

test('REGRESSION srs-snapshot: warns on ANY filename-derived slug, not only a date-prefixed one', () => {
  // Pre-fix: the warning only fired for a date-prefixed filename ("2026-01-01-...").
  // A filename like "phase-3-agentgw-client.md" (no "Feature:" line, no --feature)
  // silently adopted that exact slug with zero signal, even when it drifts from the
  // project's own feature-slug convention.
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, 'phase-3-agentgw-client.md');
  fs.writeFileSync(srs, '## 5. Business Logic\n\n| Business Logic | Note |\n| --- | --- |\n| BL-01 must do X | |\n');
  const snap = run(['srs-snapshot', '--srs', srs], dir);
  assert.equal(snap.ok, true);
  assert.equal(snap.data.feature, 'phase-3-agentgw-client', 'slug derived from the filename');
  assert.equal(snap.data.warnings.length, 1, 'a warning fires even without a date prefix');
  assert.match(snap.data.warnings[0], /derived from the SRS filename/, 'names the actual cause');

  // An explicit --feature suppresses it entirely (stated intent, not a guess).
  const srs2 = path.join(dir, 'other.md');
  fs.writeFileSync(srs2, '## 5. Business Logic\n\n| Business Logic | Note |\n| --- | --- |\n| BL-01 must do X | |\n');
  const explicit = run(['srs-snapshot', '--srs', srs2, '--feature', 'my-clean-slug'], dir);
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.data.warnings, [], 'an explicit --feature produces no warning');
});

test('REGRESSION branch-ensure: git repo with no commits → NO_COMMITS (not NOT_A_GIT_REPO)', () => {
  const dir = tmpProject();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  initProject(dir);
  const r = run(['branch-ensure', '--kind', 'sd', '--name', 'demo'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^NO_COMMITS/, 'fresh repo with no HEAD reports NO_COMMITS');
});

// ---------------------------------------------------------------------------
// Clobber-safety
// ---------------------------------------------------------------------------

test('sd-skeleton refuses to overwrite an existing SD without --force', () => {
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, '# Feature: Demo\n\n## 6. Non-Functional Requirements\n\n| Requirement | Category | Note |\n| --- | --- | --- |\n| fast | Perf | |\n');
  const first = run(['sd-skeleton', '--srs', srs, '--feature', 'demo'], dir);
  assert.equal(first.ok, true, 'first write ok');
  const second = run(['sd-skeleton', '--srs', srs, '--feature', 'demo'], dir);
  assert.equal(second.ok, false);
  assert.match(second.error, /SD_EXISTS/, 'second run without --force is blocked');
  const forced = run(['sd-skeleton', '--srs', srs, '--feature', 'demo', '--force'], dir);
  assert.equal(forced.ok, true, '--force re-derives');
});

// ---------------------------------------------------------------------------
// Per-feature tag scoping + honest gate (v0.1.3 regressions)
// ---------------------------------------------------------------------------

test('REGRESSION trace-build: task count is scoped to --feature tag, not master/first-tag', () => {
  // Pre-fix bug (currentTag drift): trace-build read tasks without the feature
  // tag, so readTmTasks fell back to master/first-tag and miscounted (the
  // 64->11->66 symptom). A tagged tasks.json must count ONLY the feature's tasks.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does a thing | Must Have | US-1 |', '',
  ].join('\n'));
  // Tagged tasks.json: master/other tag has 3 tasks, the demo tag has 2.
  const tmDir = path.join(dir, '.taskmaster', 'tasks');
  fs.mkdirSync(tmDir, { recursive: true });
  fs.writeFileSync(path.join(tmDir, 'tasks.json'), JSON.stringify({
    'sof-card-network': { tasks: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    demo: { tasks: [{ id: 1 }, { id: 2 }] },
  }));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'trace-build ok');
  assert.equal(r.data.counts.tasks, 2, 'counts the demo tag (2), not sof-card-network (3) or a sum');
});

test('REGRESSION verify-code: forbidden-patterns skips .md files (doc snippets legitimately contain the pattern text)', () => {
  // Pre-fix: scanning scanPath: "." for `console\.log\(` hit a markdown doc's own
  // `node -e "console.log(...)"` CLI-usage example — a real, correct code sample, not
  // leftover debug code. Source-code smells must not be checked against prose docs.
  const dir = tmpProject();
  const init = run(['init-project', '--stack', 'node'], dir);
  assert.equal(init.ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.scanPath = '.';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), [
    '# Example',
    '```bash',
    'RESULT=$(node -e "console.log(1+1)")',
    '```',
    '',
  ].join('\n'));
  const r = run(['verify-code'], dir);
  assert.equal(r.ok, true);
  const fp = r.data.checks.find((c) => c.name === 'forbidden-patterns');
  assert.equal(fp.status, 'ok', 'a console.log( inside a .md code sample is not a forbidden-pattern hit');
});

test('REGRESSION verify-code: unconfigured project → gate "skipped", not "pass"', () => {
  // Pre-fix bug: a no-op gate returned gate:"pass" and read as if the code was
  // verified. With no verify block it must report "skipped" (transparency).
  const dir = tmpProject();
  // No init-project → no config.json at all → no verify block.
  const r = run(['verify-code'], dir);
  assert.equal(r.ok, true, 'verify-code never throws');
  assert.equal(r.data.gate, 'skipped', 'unconfigured gate is skipped, not pass');
});

// ---------------------------------------------------------------------------
// Multi-repo: one SRS/SD whose code lives in sibling service repos (v0.2.0)
// ---------------------------------------------------------------------------

test('multi-repo verify-code: scans each code repo, prefixes checks, gate is worst', () => {
  // hub/ holds the planning .spec-flow; code lives in sibling svc-a / svc-b.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mr-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'svc-a', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'svc-b', 'src'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(path.join(root, 'svc-a', 'src', 'A.java'), 'class A { void f(){ x.block(); } }\n');
  fs.writeFileSync(path.join(root, 'svc-b', 'src', 'B.java'), 'class B { void g(){ ok(); } }\n');
  const init = run(['init-project', '--stack', 'java-spring', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);
  assert.equal(init.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(hub, '.spec-flow', 'config.json'), 'utf8'));
  assert.deepEqual(cfg.repos, { 'svc-a': '../svc-a', 'svc-b': '../svc-b' }, 'config.repos seeded');
  const r = run(['verify-code'], hub);
  assert.equal(r.ok, true);
  assert.equal(r.data.gate, 'fail', 'svc-a .block() makes the aggregate gate fail');
  const aFp = r.data.checks.find((c) => c.name === '[svc-a] forbidden-patterns');
  const bFp = r.data.checks.find((c) => c.name === '[svc-b] forbidden-patterns');
  assert.equal(aFp && aFp.status, 'fail', 'svc-a forbidden-patterns fails (.block())');
  assert.equal(bFp && bFp.status, 'ok', 'svc-b forbidden-patterns ok');
});

test('verify-code: --repos scopes the scan so an unrelated repo cannot poison the gate', () => {
  // svc-a has a .block() (would FAIL); the change only touched svc-b (clean).
  // Without scoping the aggregate gate fails on svc-a; --repos svc-b must isolate it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-scope-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'svc-a', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'svc-b', 'src'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(path.join(root, 'svc-a', 'src', 'A.java'), 'class A { void f(){ x.block(); } }\n');
  fs.writeFileSync(path.join(root, 'svc-b', 'src', 'B.java'), 'class B { void g(){ ok(); } }\n');
  run(['init-project', '--stack', 'java-spring', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);
  // Make .block() the ONLY failure signal — drop the test/coverage commands (no real
  // build tool in a temp dir, which would fail everywhere and mask the scoping effect).
  const cfgPath = path.join(hub, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageCommand = null; cfg.verify.coverageThreshold = null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // Unscoped: svc-a's .block() fails the aggregate gate (baseline).
  const all = run(['verify-code'], hub);
  assert.equal(all.data.gate, 'fail', 'baseline: unrelated svc-a poisons the gate');

  // Scoped to svc-b only → svc-a not scanned → gate passes.
  const scoped = run(['verify-code', '--repos', 'svc-b'], hub);
  assert.equal(scoped.data.gate, 'pass', 'scoping to svc-b isolates the clean repo');
  assert.deepEqual(scoped.data.repos, ['svc-b'], 'only svc-b scanned');
  assert.ok(!scoped.data.checks.some((c) => c.repo === 'svc-a'), 'no svc-a checks present');
  assert.match(scoped.data.scope, /scoped to \[svc-b\] via --repos/);
});

test('branch-ensure: --repos scopes branching so only the targeted repo branches', () => {
  // Pre-fix bug: branch-ensure fanned out to ALL config.repos — creating stray
  // feat/<feature> branches on unrelated services. --repos must narrow to the subset
  // the feature actually targets; an unconfigured name must error, not misbranch.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-be-scope-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  const aDir = makeGitRepo(root, 'svc-a');
  const bDir = makeGitRepo(root, 'svc-b');
  run(['init-project', '--stack', 'node', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);

  // Scoped to svc-a → only svc-a leaves main; svc-b stays untouched.
  const scoped = run(['branch-ensure', '--kind', 'sd', '--name', 'demo', '--repos', 'svc-a'], hub);
  assert.equal(scoped.ok, true, 'branch-ensure ok');
  assert.deepEqual(scoped.data.repos.map((r) => r.repo), ['svc-a'], 'only svc-a in results');
  assert.equal(branchOf(aDir), 'feat/demo', 'svc-a branched');
  assert.equal(branchOf(bDir), 'main', 'svc-b NOT branched (scoped out)');

  // Unconfigured repo name → clear error, no misbranch.
  const bad = run(['branch-ensure', '--kind', 'sd', '--name', 'demo', '--repos', 'wallet-ms'], hub);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /REPO_NOT_CONFIGURED/, 'unknown --repos name errors instead of misbranching');
});

test('verify-code: --feature auto-scopes from the feature file-links repo prefixes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-scopef-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'svc-a', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'svc-b', 'src'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(path.join(root, 'svc-a', 'src', 'A.java'), 'class A { void f(){ x.block(); } }\n'); // would fail
  fs.writeFileSync(path.join(root, 'svc-b', 'src', 'B.java'), 'class B { void g(){ ok(); } }\n');
  run(['init-project', '--stack', 'java-spring', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);
  const cfgPath = path.join(hub, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageCommand = null; cfg.verify.coverageThreshold = null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // Feature "demo" only wrote to svc-b (recorded via trace-link --repo).
  run(['trace-link', '--task', '1', '--feature', 'demo', '--repo', 'svc-b', '--files', 'src/B.java'], hub);
  const r = run(['verify-code', '--feature', 'demo'], hub);
  assert.equal(r.data.gate, 'pass', 'auto-scope from file-links excludes the unrelated svc-a');
  assert.deepEqual(r.data.repos, ['svc-b'], 'only the touched repo (svc-b) scanned');
  assert.match(r.data.scope, /feature demo/);
});

test('multi-repo trace-link --repo qualifies the stored path', () => {
  const dir = tmpProject();
  run(['init-project', '--repos', 'svc-a=../svc-a'], dir);
  const r = run(['trace-link', '--task', '1', '--feature', 'demo', '--repo', 'svc-a', '--files', 'src/A.java'], dir);
  assert.equal(r.ok, true);
  const links = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'file-links.json'), 'utf8'));
  assert.equal(links.links[0].file, 'svc-a/src/A.java', 'path is repo-qualified, not bare src/A.java');
});

// ---------------------------------------------------------------------------
// Per-feature repo scope: trace.json.repos as the source of truth (Tầng 2)
// ---------------------------------------------------------------------------

test('trace-repos: --set persists the declared subset, --get round-trips, unknown name errors', () => {
  const dir = tmpProject();
  run(['init-project', '--stack', 'node', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], dir);
  const set = run(['trace-repos', '--feature', 'demo', '--set', 'svc-b'], dir);
  assert.equal(set.ok, true, 'set ok');
  assert.deepEqual(set.data.repos, ['svc-b']);
  const got = run(['trace-repos', '--feature', 'demo', '--get'], dir);
  assert.deepEqual(got.data.repos, ['svc-b'], '--get round-trips the declared subset');
  const bad = run(['trace-repos', '--feature', 'demo', '--set', 'wallet-ms'], dir);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /REPO_NOT_CONFIGURED/, 'unknown repo name rejected on write');
  const empty = run(['trace-repos', '--feature', 'undeclared', '--get'], dir);
  assert.deepEqual(empty.data.repos, [], 'undeclared feature → []');
});

test('branch-ensure: falls back to the feature declared repos (trace-repos) when no --repos flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-be-trace-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  const aDir = makeGitRepo(root, 'svc-a');
  const bDir = makeGitRepo(root, 'svc-b');
  run(['init-project', '--stack', 'node', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);
  run(['trace-repos', '--feature', 'demo', '--set', 'svc-b'], hub);
  // No --repos flag → must pick up the declared subset from trace.json.
  const r = run(['branch-ensure', '--kind', 'sd', '--name', 'demo'], hub);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.repos.map((x) => x.repo), ['svc-b'], 'declared subset scoped branching');
  assert.equal(branchOf(bDir), 'feat/demo', 'declared svc-b branched');
  assert.equal(branchOf(aDir), 'main', 'undeclared svc-a NOT branched');
});

test('verify-code: declared repos (trace-repos) scope the gate above file-links + warn on zero-link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-gate-decl-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'svc-a', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'svc-b', 'src'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(path.join(root, 'svc-a', 'src', 'A.java'), 'class A { void f(){ x.block(); } }\n'); // would fail
  fs.writeFileSync(path.join(root, 'svc-b', 'src', 'B.java'), 'class B { void g(){ ok(); } }\n');
  run(['init-project', '--stack', 'java-spring', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);
  const cfgPath = path.join(hub, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageCommand = null; cfg.verify.coverageThreshold = null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // File-links say svc-a; the feature DECLARES svc-b → declared must win, and the
  // declared-but-unlinked svc-b must raise a forgotten-work warning.
  run(['trace-link', '--task', '1', '--feature', 'demo', '--repo', 'svc-a', '--files', 'src/A.java'], hub);
  run(['trace-repos', '--feature', 'demo', '--set', 'svc-b'], hub);
  const r = run(['verify-code', '--feature', 'demo'], hub);
  assert.equal(r.data.gate, 'pass', 'declared svc-b scopes out svc-a .block() — declared beats file-links');
  assert.deepEqual(r.data.repos, ['svc-b'], 'only the declared repo scanned');
  assert.match(r.data.scope, /declared/, 'scope note credits the declaration');
  assert.ok(r.data.scopeWarnings && r.data.scopeWarnings.some((w) => /svc-b.*no file-links/.test(w)),
    'declared repo with no file-links warns (forgotten work)');
});

// ---------------------------------------------------------------------------
// code-rules check (code-rules-gate task 2): config.verify.rules wired into
// verify-code, resolved per repo root, diff-scoped against config.branching.base.
// Real temp git repos throughout (see test/code-rules.test.cjs for the same
// convention at the engine-unit level) — this module's whole point is correct
// `git diff` handling, which a mock would just re-assert my own assumptions about.
// ---------------------------------------------------------------------------

function crGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
/** git init a repo on branch `main` (so a same-cwd init-project auto-detects base:"main"). */
function crInitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  crGit(['init', '-q'], dir);
  crGit(['checkout', '-q', '-b', 'main'], dir);
  crGit(['config', 'user.email', 't@t.co'], dir);
  crGit(['config', 'user.name', 't'], dir);
}
function crWriteFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function crCommitAll(dir, msg) {
  crGit(['add', '-A'], dir);
  crGit(['commit', '-q', '-m', msg], dir);
}

test('verify-code: code-rules skipped when config.verify.rules is empty (FR-004, TC-007)', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true);
  const r = run(['verify-code'], dir);
  assert.equal(r.ok, true);
  const cr = r.data.checks.find((c) => c.name === 'code-rules');
  assert.equal(cr.status, 'skipped');
  assert.match(cr.detail, /config\.verify\.rules/);
  // Other checks still run normally — code-rules is additive, not a gate on them.
  const fp = r.data.checks.find((c) => c.name === 'forbidden-patterns');
  assert.ok(fp && fp.status !== undefined, 'forbidden-patterns unaffected by the absence of rules[]');
});

test('verify-code: code-rules fails on a new diff violation and reports preexisting count (FR-002, FR-004, TC-001)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cr-fail-'));
  crInitRepo(dir);
  const baseLines = [
    'class FooController {',
    '  ResponseEntity<String> a() { return null; }',
    '  ResponseEntity<String> b() { return null; }',
    '  ResponseEntity<String> c() { return null; }',
    '  ResponseEntity<String> d() { return null; }',
    '  ResponseEntity<String> e() { return null; }',
    '}',
  ];
  crWriteFile(dir, 'src/FooController.java', baseLines.join('\n') + '\n');
  crCommitAll(dir, 'baseline');
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true, 'init-project on main → branching.base "main"');
  crGit(['checkout', '-q', '-b', 'feature'], dir);
  const updated = baseLines.slice(0, -1)
    .concat(['  ResponseEntity<String> f() { return null; }'], baseLines.slice(-1));
  crWriteFile(dir, 'src/FooController.java', updated.join('\n') + '\n');

  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageThreshold = null; cfg.verify.secretScan = false;
  cfg.verify.rules = [{
    id: 'no-response-entity',
    message: 'Use @ResponseStatus, not ResponseEntity.',
    forbid: 'ResponseEntity<',
    glob: '**/*Controller.java',
  }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = run(['verify-code'], dir);
  assert.equal(r.ok, true);
  const cr = r.data.checks.find((c) => c.name === 'code-rules');
  assert.equal(cr.status, 'fail');
  assert.match(cr.detail, /1 violation/);
  assert.match(cr.detail, /src\/FooController\.java:7 \[no-response-entity\] Use @ResponseStatus, not ResponseEntity\./);
  assert.match(cr.detail, /preexisting: 5/, 'the 5 untouched preexisting hits are reported, not blocking');
  assert.match(cr.fix, /config\.verify\.rules/);
  assert.equal(r.data.gate, 'fail', 'a code-rules violation fails the overall gate');
});

test('verify-code: code-rules is "ok" when the task never touches the violating file — preexisting count still shown (FR-002, TC-002)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cr-ok-'));
  crInitRepo(dir);
  const baseLines = [
    'class FooController {',
    '  ResponseEntity<String> a() { return null; }',
    '  ResponseEntity<String> b() { return null; }',
    '  ResponseEntity<String> c() { return null; }',
    '  ResponseEntity<String> d() { return null; }',
    '  ResponseEntity<String> e() { return null; }',
    '}',
  ];
  crWriteFile(dir, 'src/FooController.java', baseLines.join('\n') + '\n');
  crCommitAll(dir, 'baseline');
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true);
  crGit(['checkout', '-q', '-b', 'feature'], dir);
  // Task touches an unrelated file only — FooController.java is untouched.
  crWriteFile(dir, 'src/Other.java', 'class Other {}\n');

  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageThreshold = null; cfg.verify.secretScan = false;
  cfg.verify.rules = [{
    id: 'no-response-entity',
    message: 'Use @ResponseStatus, not ResponseEntity.',
    forbid: 'ResponseEntity<',
    glob: '**/*Controller.java',
  }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = run(['verify-code'], dir);
  assert.equal(r.ok, true);
  const cr = r.data.checks.find((c) => c.name === 'code-rules');
  assert.equal(cr.status, 'ok', 'no in-scope violation — the 5 hits are all preexisting, outside the diff');
  assert.match(cr.detail, /preexisting: 5/);
  assert.equal(r.data.gate, 'pass');
});

test('verify-code: --task never narrows the code-rules diff scope (FR-004)', () => {
  // --task/--files scopes the "tests" check only; code-rules always evaluates the
  // FULL diff for the root regardless of which files this task's file-links name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cr-task-'));
  crInitRepo(dir);
  crWriteFile(dir, 'src/FooController.java', 'class FooController {\n}\n');
  crCommitAll(dir, 'baseline');
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true);
  crGit(['checkout', '-q', '-b', 'feature'], dir);
  crWriteFile(dir, 'src/FooController.java', 'class FooController {\n  ResponseEntity<String> a(){ return null; }\n}\n');

  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageThreshold = null; cfg.verify.secretScan = false;
  cfg.verify.rules = [{ id: 'no-response-entity', message: 'no ResponseEntity', forbid: 'ResponseEntity<' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // Declare a task whose recorded file-links point at a completely different file —
  // if code-rules were (wrongly) narrowed to file-links, it would see nothing.
  run(['trace-link', '--task', '1', '--feature', 'demo', '--files', 'src/Unrelated.java'], dir);

  const r = run(['verify-code', '--feature', 'demo', '--task', '1'], dir);
  assert.equal(r.ok, true);
  const cr = r.data.checks.find((c) => c.name === 'code-rules');
  assert.equal(cr.status, 'fail', 'code-rules still sees the FooController.java violation despite --task scoping to another file');
});

test('verify-code: forbidden-patterns output is byte-identical whether or not config.verify.rules is configured (FR-005, TC-008)', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'console.log("x");\n');
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageThreshold = null; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const before = run(['verify-code'], dir);
  const fpBefore = before.data.checks.find((c) => c.name === 'forbidden-patterns');
  assert.equal(fpBefore.status, 'fail', 'baseline: console.log( is a configured forbidden pattern');

  cfg.verify.rules = [{ id: 'dummy', message: 'no-op', forbid: 'THIS_NEVER_MATCHES_ANYTHING', scope: 'all' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const after = run(['verify-code'], dir);
  const fpAfter = after.data.checks.find((c) => c.name === 'forbidden-patterns');

  assert.deepEqual(fpAfter, fpBefore, 'adding config.verify.rules does not change the forbidden-patterns check at all');
});

test('multi-repo verify-code: code-rules resolves per repo root, diff computed in each repo\'s own git (FR-006, TC-029)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cr-multi-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  const svcA = path.join(root, 'svc-a');
  const svcB = path.join(root, 'svc-b');
  crInitRepo(svcA);
  crInitRepo(svcB);
  crWriteFile(svcA, 'src/AController.java', 'class AController {\n}\n');
  crWriteFile(svcB, 'src/BController.java', 'class BController {\n}\n');
  crCommitAll(svcA, 'baseline');
  crCommitAll(svcB, 'baseline');
  assert.equal(run(['init-project', '--stack', 'java-spring', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub).ok, true);
  crGit(['checkout', '-q', '-b', 'feature'], svcA);
  crGit(['checkout', '-q', '-b', 'feature'], svcB);
  // Only svc-a gets a new violation; svc-b stays clean and has no rules of its own.
  crWriteFile(svcA, 'src/AController.java', 'class AController {\n  ResponseEntity<String> a(){ return null; }\n}\n');

  const cfgPath = path.join(hub, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = null; cfg.verify.coverageThreshold = null; cfg.verify.coverageCommand = null; cfg.verify.secretScan = false;
  cfg.repos['svc-a'] = { path: '../svc-a', verify: { rules: [{ id: 'no-response-entity', message: 'no ResponseEntity', forbid: 'ResponseEntity<' }] } };
  cfg.repos['svc-b'] = { path: '../svc-b', verify: { rules: [] } };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = run(['verify-code'], hub);
  assert.equal(r.ok, true);
  const aCr = r.data.checks.find((c) => c.name === '[svc-a] code-rules');
  const bCr = r.data.checks.find((c) => c.name === '[svc-b] code-rules');
  assert.equal(aCr && aCr.status, 'fail', 'svc-a rule catches its own new violation, using svc-a\'s own git diff');
  assert.match(aCr.detail, /AController\.java/);
  assert.equal(bCr && bCr.status, 'skipped', 'svc-b has no rules configured for itself — svc-a\'s rule does not leak over');
  assert.equal(r.data.gate, 'fail');
});

// ---------------------------------------------------------------------------
// TDD RED-phase gate: verify-code --expect fail (v0.5.2)
// ---------------------------------------------------------------------------

test('verify-code --expect fail: failing test → gate "red-confirmed"', () => {
  const dir = tmpProject();
  initProject(dir);
  // Override verify block: testCommand always exits non-zero (simulates a failing test)
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify = {
    testCommand: 'exit 1', coverageThreshold: null, forbiddenPatterns: [], secretScan: false,
    // Configured (not empty) — proves code-rules is skipped for RED-phase, not merely
    // because there was nothing to evaluate (TC-011).
    rules: [{ id: 'no-response-entity', message: 'no ResponseEntity', forbid: 'ResponseEntity<' }],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = run(['verify-code', '--expect', 'fail'], dir);
  assert.equal(r.ok, true, 'never throws');
  assert.equal(r.data.gate, 'red-confirmed', 'failing tests confirm RED');
  const testCheck = r.data.checks.find(c => c.name === 'tests');
  assert.equal(testCheck.status, 'ok', 'test check is ok when RED confirmed');
  assert.match(testCheck.detail, /RED confirmed/);
  // coverage / forbidden-patterns / code-rules / secret-scan must be skipped in RED-phase
  ['coverage', 'forbidden-patterns', 'code-rules', 'secret-scan'].forEach(n => {
    const c = r.data.checks.find(ch => ch.name === n);
    assert.equal(c && c.status, 'skipped', `${n} skipped in RED-phase`);
  });
});

test('verify-code --expect fail: passing test → gate "fail" (RED not confirmed)', () => {
  const dir = tmpProject();
  initProject(dir);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify = { testCommand: 'exit 0', coverageThreshold: null, forbiddenPatterns: [], secretScan: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = run(['verify-code', '--expect', 'fail'], dir);
  assert.equal(r.ok, true, 'never throws');
  assert.equal(r.data.gate, 'fail', 'passing tests before implementation = RED not confirmed');
  const testCheck = r.data.checks.find(c => c.name === 'tests');
  assert.equal(testCheck.status, 'fail', 'test check is fail when RED not confirmed');
  assert.match(testCheck.detail, /RED not confirmed/);
});

test('verify-code --expect fail: no testCommand → gate "skipped"', () => {
  const dir = tmpProject();
  // No verify block at all (tmpProject default has no config.json / no verify block).
  const r = run(['verify-code', '--expect', 'fail'], dir);
  assert.equal(r.ok, true, 'never throws');
  assert.equal(r.data.gate, 'skipped', 'no testCommand → RED cannot be machine-confirmed');
});

// ---------------------------------------------------------------------------
// Per-task test scoping (--task / --files) — run the full suite once at phase
// close-out instead of on every task; the per-task gate targets just the
// files this task touched.
// ---------------------------------------------------------------------------

/** testCommand that records the args it was actually invoked with, into CMDLINE.txt (one per line). */
const CAPTURE_ARGS_CMD = `bash -c 'printf "%s\\n" "$@" > CMDLINE.txt' _`;

function readCmdline(dir) {
  const raw = fs.readFileSync(path.join(dir, 'CMDLINE.txt'), 'utf8');
  return raw.split('\n').filter(Boolean);
}

test('verify-code: --task scopes java-spring tests to the FQCN(s) trace-link recorded for that task', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(['trace-link', '--task', '7', '--feature', 'demo', '--fr', 'FR-001',
    '--files', 'src/main/java/a/Foo.java,src/test/java/a/FooTest.java'], dir);

  const r = run(['verify-code', '--feature', 'demo', '--task', '7'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.testsScoped, true, 'scoping applied');
  const testCheck = r.data.checks.find((c) => c.name === 'tests');
  assert.equal(testCheck.status, 'ok');
  assert.match(testCheck.detail, /scoped to 1 test/);
  assert.match(testCheck.detail, /a\.FooTest/);
  assert.deepEqual(readCmdline(dir), ['--tests', 'a.FooTest'], 'gradle invoked with --tests "<fqcn>", not the full suite');
});

test('verify-code: --task scopes java-maven tests via -Dtest=', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'java-maven'], dir).ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(['trace-link', '--task', '3', '--feature', 'demo', '--fr', 'FR-002',
    '--files', 'src/test/java/x/y/BarTest.java'], dir);

  const r = run(['verify-code', '--feature', 'demo', '--task', '3'], dir);
  assert.equal(r.data.testsScoped, true);
  assert.deepEqual(readCmdline(dir), ['-Dtest=x.y.BarTest']);
});

test('verify-code: --files scopes directly (RED-phase use — before trace-link has run for this task)', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = run(['verify-code', '--files', 'src/test/java/a/b/NewFeatureTest.java', '--expect', 'fail'], dir);
  assert.equal(r.ok, true);
  const testCheck = r.data.checks.find((c) => c.name === 'tests');
  assert.match(testCheck.detail, /scoped to 1 test.*a\.b\.NewFeatureTest/);
  assert.deepEqual(readCmdline(dir), ['--tests', 'a.b.NewFeatureTest']);
});

test('verify-code: scoping requested but not derivable (non-java stack, no taskTestCommand) → falls back to full suite, notes why', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(['trace-link', '--task', '1', '--feature', 'demo', '--fr', 'FR-001', '--files', 'test/foo.test.js'], dir);
  const r = run(['verify-code', '--feature', 'demo', '--task', '1'], dir);
  assert.equal(r.data.testsScoped, false);
  assert.match(r.data.scopeNoteTests, /could not derive a filter/);
  assert.deepEqual(readCmdline(dir), [], 'no extra args — the plain, unscoped testCommand ran');
});

test('verify-code: --task honors an explicit verify.taskTestCommand template for any stack', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.taskTestCommand = `${CAPTURE_ARGS_CMD} -- {files}`;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(['trace-link', '--task', '1', '--feature', 'demo', '--fr', 'FR-001', '--files', 'test/foo.test.js'], dir);
  const r = run(['verify-code', '--feature', 'demo', '--task', '1'], dir);
  assert.equal(r.data.testsScoped, true);
  assert.deepEqual(readCmdline(dir), ['--', 'test/foo.test.js']);
});

test('verify-code: no --task/--files → unscoped, identical to pre-existing behavior', () => {
  const dir = tmpProject();
  assert.equal(run(['init-project', '--stack', 'java-spring'], dir).ok, true);
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  run(['trace-link', '--task', '7', '--feature', 'demo', '--fr', 'FR-001', '--files', 'src/test/java/a/FooTest.java'], dir);

  const r = run(['verify-code', '--feature', 'demo'], dir); // no --task
  assert.equal(r.data.testsScoped, false);
  assert.equal(r.data.scopeNoteTests, undefined, 'no scoping was even requested, so no fallback note either');
  assert.deepEqual(readCmdline(dir), []);
});

test('multi-repo verify-code: --task scopes to the touched repo only, using root-relative FQCN', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-scope-mr-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'svc-a', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'svc-b', 'src'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  run(['init-project', '--stack', 'java-spring', '--repos', 'svc-a=../svc-a,svc-b=../svc-b'], hub);
  const cfgPath = path.join(hub, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = CAPTURE_ARGS_CMD;
  cfg.verify.coverageThreshold = null; cfg.verify.forbiddenPatterns = []; cfg.verify.secretScan = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  run(['trace-link', '--task', '9', '--feature', 'demo', '--fr', 'FR-001', '--repo', 'svc-b',
    '--files', 'src/test/java/z/ZTest.java'], hub);

  const r = run(['verify-code', '--feature', 'demo', '--task', '9'], hub);
  assert.equal(r.data.gate, 'pass');
  assert.deepEqual(r.data.repos, ['svc-b'], 'only the touched repo scanned (existing multi-repo scoping)');
  assert.equal(r.data.testsScoped, true);
  assert.deepEqual(readCmdline(path.join(root, 'svc-b')), ['--tests', 'z.ZTest'], 'FQCN derived relative to svc-b, not hub');
});

// ---------------------------------------------------------------------------
// Audit-hardening regressions (v0.3.0)
// ---------------------------------------------------------------------------

test('REGRESSION B1: branch-ensure --kind sd without --name → MISSING_ARG (not a `feat` branch)', () => {
  const dir = tmpProject();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  initProject(dir);
  const r = run(['branch-ensure', '--kind', 'sd'], dir);  // no --name
  assert.equal(r.ok, false, 'must refuse, not branch `feat`');
  assert.match(r.error, /MISSING_ARG: --name/);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.notEqual(branch, 'feat', 'must not have created a `feat` branch');
});

test('REGRESSION B1: branch-ensure --kind sd --name X → creates feat/x', () => {
  const dir = tmpProject();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  initProject(dir);
  const r = run(['branch-ensure', '--kind', 'sd', '--name', 'My Feature'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.branch, 'feat/my-feature');
  assert.equal(r.data.action, 'created');
});

test('REGRESSION B6: route on an empty FR table → count 0 with an explicit note', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  // FR table header present, zero data rows.
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |', '',
  ].join('\n'));
  const r = run(['route', '--sd', path.join(sdDir, 'SD.md')], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.count, 0);
  assert.match(r.data.note || '', /0 rows/i, 'empty FR table is surfaced, not a silent count:0');
});

test('REGRESSION B4: srs-diff picks the latest snapshot of THE FEATURE by version, not mtime', () => {
  const dir = tmpProject();
  initProject(dir);
  const snaps = path.join(dir, '.spec-flow', 'snapshots');
  fs.mkdirSync(snaps, { recursive: true });
  // demo-001 (old), demo-002 (new). Touch demo-001 LAST so mtime would mis-pick it.
  fs.writeFileSync(path.join(snaps, 'demo-001.md'), '# Feature: demo\n\n## 3. User Stories\n\n### US-1: old\n');
  fs.writeFileSync(path.join(snaps, 'other-001.md'), '# Feature: other\n\n### US-9: unrelated\n');
  fs.writeFileSync(path.join(snaps, 'demo-002.md'), '# Feature: demo\n\n## 3. User Stories\n\n### US-1: old\n### US-2: newer\n');
  // make demo-001 the newest by mtime (the old mtime-based bug would pick it)
  const future = Date.now() / 1000 + 1000;
  fs.utimesSync(path.join(snaps, 'demo-001.md'), future, future);
  const newSrs = path.join(dir, 'demo.md');
  fs.writeFileSync(newSrs, '# Feature: demo\n\n## 3. User Stories\n\n### US-1: old\n### US-2: newer\n### US-3: newest\n');
  const r = run(['srs-diff', '--new', newSrs, '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'srs-diff ok');
  // Against demo-002 (the right baseline) only US-3 is added. Against demo-001 (wrong) US-2+US-3 would be.
  const addedUs = ((r.data.changeset && r.data.changeset.added) || []).filter((a) => a.kind === 'us').map((a) => a.id);
  assert.ok(addedUs.includes('US-3'), 'US-3 is new');
  assert.ok(!addedUs.includes('US-2'), 'US-2 already in demo-002 → not added (proves demo-002 was the baseline, not demo-001)');
});

test('verify-collect reads the runner JSON result line (human summary above it)', () => {
  const dir = tmpProject();
  const results = path.join(dir, 'out.txt');
  // Mirrors run-checklist.sh --json: human summary, then a final JSON line.
  fs.writeFileSync(results, [
    '── summary ──',
    '  total: 2',
    '  passed: 1',
    '  failed: 1',
    '{"passed":["TC-001"],"failed":[{"id":"TC-002","reason":"status 500"}]}',
  ].join('\n'));
  const r = run(['verify-collect', '--results', results, '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'failed');
  assert.deepEqual(r.data.passed, ['TC-001']);
  assert.equal(r.data.failed[0].id, 'TC-002');
  assert.deepEqual(r.data.truths, ['TC-001: verified']);
});

test('verify-collect errors clearly when there is no JSON result line', () => {
  const dir = tmpProject();
  const results = path.join(dir, 'out.txt');
  fs.writeFileSync(results, '── summary ──\n  passed: 0\n(no machine line)\n');
  const r = run(['verify-collect', '--results', results, '--feature', 'demo'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /NO_JSON_RESULTS/);
});

test('verify-collect requires --feature (writes are never inferred from the active-feature mirror)', () => {
  const dir = tmpProject();
  const results = path.join(dir, 'out.txt');
  fs.writeFileSync(results, '{"passed":["TC-001"],"failed":[]}');
  const r = run(['verify-collect', '--results', results], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*--feature/);
});

test('REGRESSION verify-collect: actually WRITES VERIFICATION.md (was JSON-only, gate never opened)', () => {
  // Pre-fix: verify-collect computed {status, passed, failed, truths} and returned
  // them as JSON only — nothing ever landed on disk, even though commands/manual-test.md
  // says "This writes VERIFICATION.md" and status-report / maintenance's
  // verify-integrity / task-baseline all read that file to decide the feature is
  // verified. A full pass reported status:"passed" while the feature stayed
  // "not verified" forever and the ship gate never opened.
  const dir = tmpProject();
  initProject(dir);
  const r = run(['verify-collect', '--feature', 'demo',
    '--results', '{"passed":["TC-001","TC-002"],"failed":[{"id":"TC-003","reason":"status 500"}]}'], dir);
  assert.equal(r.ok, true);
  const outPath = path.join(dir, '.spec-flow', 'specs', 'demo', 'VERIFICATION.md');
  assert.equal(path.resolve(dir, r.data.verification), outPath, 'result names the file it wrote');
  assert.ok(fs.existsSync(outPath), 'VERIFICATION.md actually written to disk');
  const md = fs.readFileSync(outPath, 'utf8');
  assert.match(md, /^status:\s*failed/m, 'status line matches the failed TC');
  assert.match(md, /^-\s*TC-001:\s*verified\b/m, 'passed TC recorded as verified (status-report / task-baseline contract)');
  assert.match(md, /^-\s*TC-002:\s*verified\b/m);
  assert.doesNotMatch(md, /TC-003:\s*verified\b/, 'the failed TC is NOT recorded as verified');
  assert.match(md, /TC-003:\s*FAILED/, 'the failure is recorded with its reason');

  // status-report picks it up.
  const sr = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(sr.ok, true);
  assert.equal(sr.data.verified, false, 'a failed run is NOT reported as verified');

  // Inline JSON (matching commands/manual-test.md's own worked example) round-trips too.
  const r2 = run(['verify-collect', '--feature', 'demo', '--results', '{"passed":["TC-001"],"failed":[]}'], dir);
  assert.equal(r2.ok, true);
  assert.equal(r2.data.status, 'passed');
  const sr2 = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(sr2.data.verified, true, 'an all-pass run is reported verified');
});

test('verify-collect: a test the runner never executed is NOT recorded as verified', () => {
  // The runner computes PASS as "no assertion reported an error", so a test with
  // no request, no assertion and no executing setup step used to land in "passed"
  // without anything leaving the machine. verify-collect then wrote
  // `status: passed` + `- TC-00x: verified` for evidence that does not exist, and
  // the ship gate opened on it. The runner now reports those ids under
  // notVerified; they must never become a truth, and their presence must hold the
  // status at incomplete so a human records the evidence by hand.
  const dir = tmpProject();
  initProject(dir);
  const r = run(['verify-collect', '--feature', 'demo', '--results',
    '{"passed":["TC-001"],"failed":[],"notVerified":[{"id":"TC-002","reason":"no request, no assertion (live-e2e)"}]}'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'incomplete', 'an unexecuted test holds the status back from passed');
  assert.deepEqual(r.data.truths, ['TC-001: verified'], 'only the executed test becomes a truth');
  assert.equal(r.data.notVerified[0].id, 'TC-002');

  const md = fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'VERIFICATION.md'), 'utf8');
  assert.doesNotMatch(md, /^-\s*TC-002:\s*verified\b/m, 'the unexecuted TC is never written as verified');
  assert.match(md, /TC-002:\s*NOT VERIFIED/, 'it is named as needing a hand-run, with the reason');
  assert.match(md, /## Not verified/, 'a section tells the reader what is still owed');

  // The ship gate stays shut until someone records the evidence.
  const sr = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(sr.data.verified, false, 'incomplete does not open the ship gate');
});

test('verify-collect: an all-placeholder run reports nothing passed', () => {
  // The shape from the plugin's own backlog note: every TC carved out with
  // no-verify/live-e2e, runner reported "41 passed, 0 failed", VERIFICATION.md
  // said status: passed. Nothing had run.
  const dir = tmpProject();
  initProject(dir);
  const r = run(['verify-collect', '--feature', 'demo', '--results',
    '{"passed":[],"failed":[],"notVerified":[{"id":"TC-001","reason":"x"},{"id":"TC-002","reason":"x"}]}'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'incomplete');
  assert.deepEqual(r.data.truths, [], 'no truths at all — nothing was executed');
});

// ---------------------------------------------------------------------------
// Language pack — SRS-parsing keywords are DATA, loaded per config.language
// ---------------------------------------------------------------------------

const VI_NFR_SRS = [
  '# Feature: demo', '',
  '## 6. Yêu cầu phi chức năng', '',  // VI "phi chức năng" → nfr role (only in vi pack)
  '| Yêu cầu | Mục | Mục tiêu |',
  '| --- | --- | --- |',
  '| Hiệu năng | Perf | p99 < 200ms |', '',
].join('\n');

test('lang pack: a VI NFR heading is harvested under config.language=vi', () => {
  const dir = tmpProject();
  run(['init-project', '--stack', 'node', '--language', 'vi'], dir);
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, VI_NFR_SRS);
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'demo', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.nfr, 1, 'vi pack classifies "phi chức năng" → NFR table harvested');
});

test('lang pack: the same VI NFR heading is NOT classified under config.language=en (config-scoped)', () => {
  const dir = tmpProject();
  run(['init-project', '--stack', 'node'], dir);  // default en
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, VI_NFR_SRS);
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'demo', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.nfr, 0, 'en pack does not know "phi chức năng" → not harvested (declare language to enable)');
});

test('lang pack: a project-local language file extends parsing with no engine change', () => {
  const dir = tmpProject();
  run(['init-project', '--stack', 'node'], dir);
  // Point config at a custom language and drop a project-local pack for it.
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.language = 'xx';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const langDir = path.join(dir, '.spec-flow', 'templates', 'lang');
  fs.mkdirSync(langDir, { recursive: true });
  fs.writeFileSync(path.join(langDir, 'xx.json'), JSON.stringify({ headingRoles: { nfr: ['ZZNFRZZ'] } }));
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, ['# Feature: demo', '', '## 6. ZZNFRZZ block', '',
    '| Req | Cat | Target |', '| --- | --- | --- |', '| fast | Perf | x |', ''].join('\n'));
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'demo', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.nfr, 1, 'custom xx.json keyword classifies the NFR heading — no engine edit');
});

// ---------------------------------------------------------------------------
// New coverage: 6 previously-untested engine commands
// ---------------------------------------------------------------------------

test('init: returns paths, config, and traceExists flag', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['init'], dir);
  assert.equal(r.ok, true, 'init ok');
  // paths object must expose known keys
  assert.ok(r.data.paths && typeof r.data.paths.stateDir === 'string', 'paths.stateDir present');
  assert.ok(r.data.paths.config, 'paths.config present');
  // config is the live config.json
  assert.ok(r.data.config && typeof r.data.config === 'object', 'config is an object');
  // traceExists is a boolean
  assert.equal(typeof r.data.traceExists, 'boolean', 'traceExists is boolean');
  // after init-project only (no trace-build), trace should not exist yet
  assert.equal(r.data.traceExists, false, 'traceExists false before any trace-build');
});

test('learn: appends a rule entry to project-author.md', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['learn', '--note', 'always use snake_case for DB columns', '--category', 'pitfall'], dir);
  assert.equal(r.ok, true, 'learn ok');
  assert.match(r.data.appended, /always use snake_case for DB columns/, 'appended field echoes the note');
  assert.ok(r.data.file, 'file path returned');
  // Verify the rule actually landed in project-author.md
  const content = fs.readFileSync(path.join(dir, r.data.file), 'utf8');
  assert.match(content, /always use snake_case for DB columns/, 'rule appears in project-author.md');
});

test('checklist-gen: SD §13.2 TC table → CHECKLIST.yaml scaffold with suites and TODO markers', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid creds login | JWT returned 200 | FR-001 |',
    '| TC-002 | Error | Invalid password | 401 Unauthorized | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'checklist-gen ok');
  assert.equal(r.data.feature, 'demo', 'feature echoed');
  assert.equal(r.data.tests, 2, 'two TC rows → two tests');
  assert.ok(r.data.suites >= 1, 'at least one suite');
  assert.ok(r.data.todo > 0, 'TODO markers present (checklist not filled)');
  // CHECKLIST.yaml must have been written
  const checklistPath = path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml');
  assert.ok(fs.existsSync(checklistPath), 'CHECKLIST.yaml written to specs/<feature>/');
  const yaml = fs.readFileSync(checklistPath, 'utf8');
  assert.match(yaml, /TC-001/, 'TC-001 appears in scaffold');
  assert.match(yaml, /TC-002/, 'TC-002 appears in scaffold');
  // Default (no --auth, no stack markers in the tmp project) → detect-auth.sh
  // resolves 'unknown'. X-Userinfo is Summer/APISIX-specific, so an unclassified
  // project must NOT get it — it 401s every test. Bearer is the safe wire default.
  assert.match(yaml, /^\s+bearer:/m, 'unknown auth → scaffolds the standard Authorization: Bearer form');
  assert.doesNotMatch(yaml, /^\s+payload:/m, 'unknown auth → does not emit an active Summer/APISIX payload: token key');
  assert.match(yaml, /detected auth: unknown/, 'unknown auth → advisory comment names the detection result');
});

test('checklist-gen: smoke is the happy-path spine — first non-edge TC per flow only', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'tags');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: tags', '',
    '## 9. API Design', '',
    '| Method | Path |', '| --- | --- |', '| POST | /api/v1/transfers |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Transfer | Valid transfer | 200 | FR-001 |',
    '| TC-002 | Transfer | Insufficient balance | 422 | FR-001 |',
    '| TC-003 | Transfer | Duplicate request id | 409 | FR-001 |',
    '| TC-004 | Refund | Edge: zero amount | 422 | FR-002 |',
    '| TC-005 | Refund | Valid refund | 200 | FR-002 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'tags'], dir);
  assert.equal(r.ok, true, 'checklist-gen ok');
  const yaml = fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'tags', 'CHECKLIST.yaml'), 'utf8');
  const tagOf = (id) => {
    const m = yaml.match(new RegExp(`- id: ${id}\\n[\\s\\S]*?tags: \\[([^\\]]+)\\]`));
    return m ? m[1] : null;
  };
  // One smoke per flow — otherwise `--tag smoke` runs the whole checklist and the
  // smoke → regression escalation the skill promises stops meaning anything.
  assert.equal(tagOf('TC-001'), 'smoke', 'first TC of a flow is that flow\'s smoke test');
  assert.equal(tagOf('TC-002'), 'regression', 'second TC of the same flow is regression');
  assert.equal(tagOf('TC-003'), 'regression', 'third TC of the same flow is regression');
  // A flow whose first row is an `Edge:` case must not promote it to smoke.
  assert.equal(tagOf('TC-004'), 'regression', 'leading Edge: TC stays regression');
  assert.equal(tagOf('TC-005'), 'smoke', 'first NON-edge TC of the flow is the smoke test');
  assert.equal((yaml.match(/tags: \[smoke\]/g) || []).length, 2, 'exactly one smoke test per flow (2 flows)');
});

test('checklist-gen: --auth jwt-basic scaffolds a bearer token, not X-Userinfo payload', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid creds login | JWT returned 200 | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo', '--auth', 'jwt-basic'], dir);
  assert.equal(r.ok, true, 'checklist-gen ok');
  const yaml = fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml'), 'utf8');
  assert.match(yaml, /bearer: "\$\{TOKEN\}"/, 'jwt-basic → scaffolds a bearer: token, not X-Userinfo payload');
  assert.doesNotMatch(yaml, /payload:/, 'jwt-basic → no X-Userinfo payload: form emitted');
  assert.doesNotMatch(yaml, /detected auth:/, 'jwt-basic is an unambiguous detection → no advisory comment');
});

test('checklist-gen: --auth summer keeps the payload: X-Userinfo scaffold with no advisory comment', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid creds login | JWT returned 200 | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo', '--auth', 'summer'], dir);
  assert.equal(r.ok, true, 'checklist-gen ok');
  const yaml = fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml'), 'utf8');
  assert.match(yaml, /payload:/, 'summer → keeps the payload:/X-Userinfo scaffold');
  assert.doesNotMatch(yaml, /detected auth:/, 'summer (the default assumption) gets no advisory comment');
});

test('REGRESSION checklist-gen: auth detection is scoped to the feature\'s declared repo, not the whole hub', () => {
  // Pre-fix: detect-auth.sh's hub-reconciliation classified EVERY config.repos entry
  // and majority-voted across them. A feature scoped to ONE no-auth repo in a hub
  // that also has a JWT-signal repo got the JWT/summer scaffold hub-wide — 401ing
  // every generated test. Declaring the repo via trace-repos must now scope
  // detection to that repo alone.
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(path.join(dir, 'svc-jwt', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'svc-jwt', 'package.json'), JSON.stringify({ name: 'svc-jwt', dependencies: { jsonwebtoken: '^9.0.0' } }));
  fs.mkdirSync(path.join(dir, 'svc-plain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'svc-plain', 'package.json'), JSON.stringify({ name: 'svc-plain' }));

  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.repos = { 'svc-jwt': 'svc-jwt', 'svc-plain': 'svc-plain' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // Sanity: unscoped (hub-wide) detection picks up the jwt signal.
  const unscoped = execFileSync(
    path.join(__dirname, '..', 'skills', 'manual-test', 'scripts', 'detect-auth.sh'), [dir], { encoding: 'utf8' },
  ).trim();
  assert.equal(unscoped, 'jwt-basic', 'sanity: hub-wide scan sees the jwt-signal repo');

  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Do the thing | Must | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Do the thing | 200 OK | FR-001 |', '',
  ].join('\n'));

  const declare = run(['trace-repos', '--feature', 'demo', '--set', 'svc-plain'], dir);
  assert.equal(declare.ok, true);

  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'checklist-gen ok');
  const yaml = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.match(yaml, /detected auth: unknown/, 'scoped to svc-plain (no JWT signal there) → unknown, not jwt-basic');
  assert.ok(r.data.warnings.some((w) => /scoped to repo "svc-plain"/.test(w)), 'warning names the scoped repo');
});

test('REGRESSION checklist-gen: no SD §7 Data Model section → skips config.db/redis and cleanup', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Validate signature | Must | BL-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Sign | Valid signature accepted | 200 OK | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  const yaml = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /^\s*db:/m, 'no §7 → no db: block');
  assert.doesNotMatch(yaml, /^\s*redis:/m, 'no §7 → no redis: block');
  assert.doesNotMatch(yaml, /^cleanup:/m, 'no §7 → no cleanup: block');
  // §7 is detected by NUMBER (/^##\s*7\.?\s+/), so the heading text is free to be
  // "Data Model" (what 25/34 real SDs call it) — the warning wording follows the
  // template, the detection does not depend on it.
  assert.ok(r.data.warnings.some((w) => /no §7 Data Model section/.test(w)), 'warning explains why persistence config was skipped');
});

test('REGRESSION checklist-gen: SD §7 explicitly says no database → skips config.db/redis and cleanup', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Validate signature | Must | BL-1 |', '',
    '## 7. Database Design', '',
    'N/A — this feature has no database or cache; all state is stateless HMAC validation.', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Sign | Valid signature accepted | 200 OK | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  const yaml = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /^\s*db:/m, '§7 says no DB → no db: block');
  assert.ok(r.data.warnings.some((w) => /declares no database\/cache/.test(w)));
});

test('REGRESSION checklist-gen: an SD §7 WITH a real database keeps db/redis/cleanup (no false-negative)', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Persist order | Must | US-1 |', '',
    '## 7. Database Design', '',
    '### 7.2 Table Definitions',
    'New `orders` table.', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Order | Order row persisted | 200 OK | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  const yaml = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.match(yaml, /^\s*db:/m, 'a real §7 section keeps the db: block');
  assert.match(yaml, /^cleanup:/m, 'a real §7 section keeps the cleanup: block');
});

test('REGRESSION checklist-gen: warns when every suite is single-test (Flow column not grouping)', () => {
  // Pre-fix: no signal at all when §13.2's Flow column happens to be unique per row
  // (e.g. one Flow value per business-rule-derived TC) — grouping degenerates to
  // one suite per test, and a single-test suite's lone test is ALWAYS tagged smoke
  // (never regression), so `--tag regression` silently skips the whole checklist.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Validate signature | Must | BL-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | BL-1 valid | Valid signature accepted | 200 OK | FR-001 |',
    '| TC-002 | BL-1 missing ts | Missing timestamp rejected | 422 | FR-001 |',
    '| TC-003 | BL-1 expired ts | Expired timestamp rejected | 422 | FR-001 |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.suites, 3, 'each distinct Flow value became its own suite');
  assert.ok(r.data.warnings.some((w) => /all 3 suites are single-test/.test(w)), 'the degenerate-grouping trap is surfaced');
  const yaml = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /tags: \[smoke, regression\]/, 'no suite got a real smoke+regression split');
});

test('trace-impact: --ids FR-001 resolves transitively to linked TC', () => {
  // Build a trace first, then call trace-impact and assert the impacted set.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid creds login | JWT 200 | FR-001 |', '',
  ].join('\n'));
  const tb = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(tb.ok, true, 'trace-build ok before trace-impact');

  const r = run(['trace-impact', '--feature', 'demo', '--ids', 'FR-001'], dir);
  assert.equal(r.ok, true, 'trace-impact ok');
  assert.ok(r.data.impacted.fr.includes('FR-001'), 'FR-001 in impacted.fr');
  // Transitive: FR-001 links to TC-001 via fr-tc link
  assert.ok(r.data.impacted.tc.includes('TC-001'), 'TC-001 transitively impacted via FR-001 fr-tc link');
});

test('REGRESSION #3 trace-impact: a changed FR reaches the implementing task via fr-task link', () => {
  // Pre-fix: no fr-task link type existed → an FR-id changeset resolved to tasks=[]
  // and /sf:change could not auto-reopen the task. Fix: trace-link --fr --task seeds
  // an fr→task link in file-links; trace-build emits fr-task; trace-impact walks it.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid creds login | JWT 200 | FR-001 |', '',
  ].join('\n'));
  // Implementation recorded task 7 against FR-001 (as /sf:phase does via trace-link --fr).
  const tl = run(['trace-link', '--task', '7', '--feature', 'demo', '--fr', 'FR-001', '--files', 'src/Login.java'], dir);
  assert.equal(tl.ok, true, 'trace-link --fr ok');
  const tb = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(tb.ok, true);
  // The fr-task link is DERIVED from file-links.json (US-1), so it is deliberately
  // NOT persisted in trace.json — the guarantee that matters is that a later
  // /sf:change on FR-001 still reaches task 7, which it does through hydration.
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'trace.json'), 'utf8'));
  assert.ok(!trace.links.some(l => l.type === 'fr-task'),
    'derived fr-task links must not be written to disk');
  assert.ok(!trace.nodes.files && !trace.nodes.tasks,
    'derived nodes.files / nodes.tasks must not be written to disk');
  const imp = run(['trace-impact', '--feature', 'demo', '--ids', 'FR-001'], dir);
  assert.equal(imp.ok, true, 'trace-impact ok');
  assert.ok(imp.data.impacted.tasks.includes('7'),
    'FR-001 must still resolve to task 7 via the hydrated fr-task link');

  const r = run(['trace-impact', '--feature', 'demo', '--ids', 'FR-001'], dir);
  assert.equal(r.ok, true);
  assert.ok(r.data.impacted.tasks.includes('7'), 'changed FR-001 reaches implementing task 7 (was [] pre-fix)');
});

test('#3 init-project: auto-detects stack from build markers when --stack omitted', () => {
  // Gradle project, no --stack → java-spring preset (./gradlew test, 80% coverage).
  const g = tmpProject();
  fs.writeFileSync(path.join(g, 'build.gradle'), 'plugins { id "java" }\n');
  const rg = run(['init-project'], g);
  assert.equal(rg.ok, true);
  assert.equal(rg.data.verifyPreset.stack, 'java-spring', 'build.gradle → java-spring');
  assert.equal(rg.data.verifyPreset.preset.testCommand, './gradlew test');
  assert.equal(rg.data.verifyPreset.preset.coverageThreshold, 80);

  // Maven project → java-maven (mvn test, NOT gradle).
  const m = tmpProject();
  fs.writeFileSync(path.join(m, 'pom.xml'), '<project></project>\n');
  const rm = run(['init-project'], m);
  assert.equal(rm.data.verifyPreset.stack, 'java-maven', 'pom.xml → java-maven');
  assert.match(rm.data.verifyPreset.preset.testCommand, /^mvn /, 'maven uses mvn, not gradlew');

  // No markers → unknown (backward compat: empty verify, no false gate).
  const u = tmpProject();
  const ru = run(['init-project'], u);
  assert.equal(ru.data.verifyPreset.stack, 'unknown');
  assert.equal(ru.data.verifyPreset.preset.testCommand, null);
});

test('#5 sd-skeleton: strips "SRS:" prefix from an H1-derived feature (no srs- slug drift)', () => {
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, 'srs.md');
  // No `Feature:` line and no --feature → derived from H1. The "SRS:" prefix must be stripped.
  fs.writeFileSync(srs, '# SRS: Outbox CDC Circuit Breaker\n\n## 5. Business Logic\n\n| Business Logic | Note |\n| --- | --- |\n| BL-01 publish after commit | |\n');
  const r = run(['sd-skeleton', '--srs', srs, '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.feature, 'outbox-cdc-circuit-breaker', 'slug has no leading srs- prefix');
});

test('#2 sd-skeleton: harvests FR/NFR/TC tables by ID-prefix under non-English headings', () => {
  // A structured SRS whose headings/headers are NOT in the keyword pack (here: Vietnamese,
  // no vi pack configured) but whose tables use canonical FR-/NFR-/TC- ids. Pre-fix this
  // harvested 0 (all TODO); the ID-prefix fallback must pull the rows in.
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, [
    '# Feature: Outbox CDC',
    '',
    '## 5. Yeu cau chuc nang',          // "Functional requirements" in VI, no diacritics, not a pack keyword
    '',
    '| Ma | Muc do | Mo ta |',          // headers in VI → header-keyword detection fails
    '| --- | --- | --- |',
    '| FR-1 | MUST | He thong publish outbox event sau commit |',
    '| FR-2 | SHOULD | Retry voi backoff khi publish loi |',
    '',
    '## 6. Yeu cau phi ham',
    '',
    '| Ma | Yeu cau | Target |',
    '| --- | --- | --- |',
    '| NFR-1 | Publish latency p95 | < 2s |',
    '',
    '## 7. Test',
    '',
    '| Ma | Mo ta |',
    '| --- | --- |',
    '| TC-1 | Commit -> event xuat hien tren topic |',
    '',
  ].join('\n'));
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'outbox-cdc', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.fr, 2, 'both FR rows harvested by ID-prefix (was 0)');
  assert.equal(r.data.stats.nfr, 1, 'NFR row harvested by ID-prefix');
  assert.equal(r.data.stats.testCases, 1, 'TC row harvested by ID-prefix');
});

test('REGRESSION sd-skeleton: harvests §6.2 "Error & Notification Messages" table, not just story edge cases', () => {
  // Pre-fix: §12.2 error-code harvest read ONLY per-story Edge Cases bullets —
  // an SRS listing its error codes in the dedicated §6.2 table (the SRS template's
  // own convention) harvested 0, even though the generated §12.2 fallback text
  // itself says "derive from SRS §6.2" (it never actually read that section).
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, [
    'Feature: demo',
    '',
    '## 4. User Stories',
    '',
    '**US-1: As a client, I want to call the API, so that I get a result**',
    '',
    '#### Acceptance Criteria',
    '- valid input returns 200',
    '',
    '## 6. Non-Functional Requirements',
    '',
    '### 6.2 Error & Notification Messages',
    '',
    '| Code / trigger | Message text | Channel | Audience |',
    '| --- | --- | --- | --- |',
    '| ERR_INVALID_INPUT | Invalid input, request rejected | API | Client |',
    '| resource not found | The requested resource does not exist | API | Client |',
    '',
  ].join('\n'));
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'demo', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.errorCodes, 2, '§6.2 table rows harvested (was 0 — only story edges were read)');
});

test('trace-build: warns on error codes violating conventions.errorCodePattern (enforcement)', () => {
  const dir = tmpProject();
  initProject(dir);
  // Declare the project's standard pattern: ERR_<ONE-TOKEN>_<NNN>.
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.conventions.errorCodePattern = '^ERR_[A-Z]+_\\d{3}$';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does X | Must Have | US-1 |', '',
    '## 12.2 Domain Error Codes', '',
    '| Error Code | HTTP | Trigger |',
    '| --- | --- | --- |',
    '| ERR_ORDER_001 | 422 | conforms |',
    '| ERR_WEBHOOK_PGMS_LOOKUP_002 | 404 | stacked domain, violates |', '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data.warnings), 'warnings array present');
  const w = r.data.warnings.join(' ');
  assert.match(w, /errorCodePattern/, 'a pattern-violation warning is surfaced');
  assert.match(w, /ERR_WEBHOOK_PGMS_LOOKUP_002/, 'the stacked code is flagged');
  assert.ok(!/ERR_ORDER_001/.test(w), 'the conforming code is NOT flagged');
});

test('REGRESSION trace-build: warns when a numbered section exists but its table headers were translated (0 nodes, no signal pre-fix)', () => {
  // Pre-fix: every table (§5.1/§13.2/§12.2/§10.4/§5.2) is located by CONTENT
  // (English header keywords), not by its canonical section NUMBER. A table whose
  // column headers drifted (translated, renamed) produced a null table and 0 nodes
  // with zero warning — the SD reads complete, the trace silently drops that node kind.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does X | Must Have | US-1 |', '',
    '## 12.2 Error Codes', '',
    '| Mã lỗi | HTTP | Điều kiện kích hoạt | Thông báo người dùng |',
    '| --- | --- | --- | --- |',
    '| ERR_A | 400 | bad input | invalid |', '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.counts.errors, 0, 'header-translated error table parses to 0 nodes');
  const w = r.data.warnings.join(' ');
  assert.match(w, /§12\.2 error table/, 'names the affected table');
  assert.match(w, /Mã lỗi/, 'quotes the actual (mismatched) headers found');
});

test('REGRESSION trace-build: §10.4 repurposed for non-state content does NOT get a false "state table" mismatch warning', () => {
  // A project can legitimately keep the "10.4" numbering but retitle the sub-section
  // away from "State Management" (sd-template.md explicitly allows deleting/repurposing
  // it when the feature has no state machine). Before the titleRe guard, ANY table under
  // a heading numbered 10.4 was compared against the state-table header convention and
  // flagged as a "mismatch" even when the table was never meant to be a state table.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does X | Must Have | US-1 |', '',
    '### 10.4 OUTBOX vs DIRECT Route Comparison', '',
    '| Route | Latency | Consistency |',
    '| --- | --- | --- |',
    '| OUTBOX | higher | strong |',
    '| DIRECT | lower | eventual |', '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  const w = r.data.warnings.join(' ');
  assert.ok(!/§10\.4 state table/.test(w), 'a repurposed, non-state §10.4 table must not be flagged as a state-table header mismatch');
});

test('REGRESSION trace-build: §10.4 still warns when it IS a state section with translated/mismatched headers', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does X | Must Have | US-1 |', '',
    '### 10.4 State Management', '',
    '| Trạng thái | Ý nghĩa |',
    '| --- | --- |',
    '| PENDING | chờ xử lý |', '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.counts.states, 0, 'header-translated state table parses to 0 nodes');
  const w = r.data.warnings.join(' ');
  assert.match(w, /§10\.4 state table/, 'a genuine state section with drifted headers still gets flagged');
});

test('REGRESSION trace-build/state-update: switching the active-feature mirror away from an unfinished feature is a real warning, not silent metadata', () => {
  const dir = tmpProject();
  initProject(dir);
  // Feature A: build its trace + state first (becomes the active mirror), no ship record.
  const aDir = path.join(dir, '.spec-flow', 'specs', 'feature-a');
  fs.mkdirSync(aDir, { recursive: true });
  fs.writeFileSync(path.join(aDir, 'SD.md'), [
    '# SD: feature-a', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does X | Must Have | US-1 |', '',
  ].join('\n'));
  let r = run(['trace-build', '--sd', path.join(aDir, 'SD.md'), '--feature', 'feature-a'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.switchedFrom, null, 'first trace-build in a fresh project has nothing to switch from');
  r = run(['state-update', '--feature', 'feature-a'], dir);
  assert.equal(r.ok, true);

  // Feature B: building its trace now switches the global mirror away from A, which
  // has no ship record — this must surface as a warning, not just switchedFrom metadata.
  const bDir = path.join(dir, '.spec-flow', 'specs', 'feature-b');
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, 'SD.md'), [
    '# SD: feature-b', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | does Y | Must Have | US-1 |', '',
  ].join('\n'));
  r = run(['trace-build', '--sd', path.join(bDir, 'SD.md'), '--feature', 'feature-b'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.switchedFrom, 'feature-a');
  let w = r.data.warnings.join(' ');
  assert.match(w, /ACTIVE FEATURE SWITCHED/, 'trace-build warns when switching away from an unshipped feature');
  assert.match(w, /feature-a/);

  r = run(['state-update', '--feature', 'feature-b'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.switchedFrom, 'feature-a');
  w = (r.data.warnings || []).join(' ');
  assert.match(w, /ACTIVE FEATURE SWITCHED/, 'state-update warns when switching away from an unshipped feature');
});

test('REGRESSION trace-build/state-update: switching away from a SHIPPED feature stays silent (expected churn)', () => {
  const dir = tmpProject();
  initProject(dir);
  const aDir = path.join(dir, '.spec-flow', 'specs', 'feature-a');
  fs.mkdirSync(aDir, { recursive: true });
  fs.writeFileSync(path.join(aDir, 'SD.md'), '# SD: feature-a\n');
  run(['trace-build', '--sd', path.join(aDir, 'SD.md'), '--feature', 'feature-a'], dir);
  let r = run(['state-update', '--feature', 'feature-a', '--shipped'], dir);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(aDir, 'ship.json')), 'ship record written');

  const bDir = path.join(dir, '.spec-flow', 'specs', 'feature-b');
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, 'SD.md'), '# SD: feature-b\n');
  r = run(['trace-build', '--sd', path.join(bDir, 'SD.md'), '--feature', 'feature-b'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.switchedFrom, 'feature-a');
  assert.ok(!/ACTIVE FEATURE SWITCHED/.test(r.data.warnings.join(' ')), 'a shipped feature switching away is expected churn, stays silent');
});

test('REGRESSION trace-build: warns on FRs with no linked TC in §13.2 (orphan requirement)', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Do the thing | Must | US-1 |',
    '| FR-002 | Do another thing | Must | US-2 |', '',
    '## 13.2 Test Cases (Critical)', '',
    '| TC ID | Flow | Test Case | Expected |',
    '| --- | --- | --- | --- |',
    '| TC-001 | US-1 | Do the thing | Do the thing succeeds |', '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  const w = r.data.warnings.join(' ');
  assert.match(w, /FR-002/, 'the orphaned FR is named');
  assert.ok(!/FR-001\b.*no linked TC|no linked TC.*FR-001/.test(w), 'the covered FR is NOT flagged');
});

test('#4 status-report: surfaces declared live gaps from VERIFICATION.md', () => {
  // verified-adhoc ship with "not verified live" items must be VISIBLE in /sf:status,
  // not buried in prose. status-report extracts bullets under a gaps heading.
  const dir = tmpProject();
  initProject(dir);
  // Minimal feature surface so featureName resolves + a VERIFICATION with a gaps section.
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), '# SD: demo\n');
  fs.writeFileSync(path.join(sdDir, 'VERIFICATION.md'), [
    '# VERIFICATION — demo',
    'status: verified-adhoc',
    '',
    '## Not verified live',
    '- webhook delivery end-to-end (outbox→CDC→publisher→callback)',
    '- DLT replay on publisher 5xx',
    '',
    '## Notes',
    '- something else',
    '',
  ].join('\n'));
  // Regression guard: a stale global .spec-flow/VERIFICATION.md (leftover from a
  // prior feature's close-out) must NOT leak into this feature's status. Reads are
  // per-feature only.
  fs.writeFileSync(path.join(dir, '.spec-flow', 'VERIFICATION.md'), [
    '# VERIFICATION — other-feature',
    'status: passed',
    '',
    '## Live gaps',
    '- stale global gap that must not appear',
    '',
  ].join('\n'));
  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.verifiedGaps.length, 2, 'two live gaps extracted (Notes section excluded)');
  assert.match(r.data.verifiedGaps[0], /webhook delivery/);
  assert.ok(!r.data.verifiedGaps.some(g => /stale global/.test(g)), 'stale global VERIFICATION.md must not leak');
});

test('#1 checklist-gen: internal/no-HTTP SD emits live-e2e scaffold, not a fake HTTP stub', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'outbox');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# Solution Design: Outbox', '',
    '> Generated by spec-flow Pass-1 from SRS. Design type: **internal**.', '',
    '## 13. Testing Strategy', '',
    '### 13.2 Test Cases (Critical)', '',
    '| TC ID | Flow | Test Case | Expected |',
    '| --- | --- | --- | --- |',
    '| TC-001 | publish | commit emits outbox event | event on topic |', '',
  ].join('\n'));
  const r = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'outbox'], dir);
  assert.equal(r.ok, true);
  const cl = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.match(cl, /live-e2e/, 'internal design-type → live-e2e tag');
  assert.ok(!/\/api\/v1\/TODO/.test(cl), 'no fake HTTP stub emitted for a no-HTTP feature');

  // Contrast: an SD with a §9 API section keeps the HTTP stub.
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# Solution Design: Api', '',
    '> Generated by spec-flow Pass-1 from SRS. Design type: **api**.', '',
    '## 9. API Design', '', 'stuff', '',
    '## 13. Testing Strategy', '', '### 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected |',
    '| --- | --- | --- | --- |',
    '| TC-001 | login | valid creds | 200 |', '',
  ].join('\n'));
  const r2 = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'outbox', '--force'], dir);
  assert.equal(r2.ok, true);
  const cl2 = fs.readFileSync(path.join(sdDir, 'CHECKLIST.yaml'), 'utf8');
  assert.match(cl2, /\/api\/v1\/TODO/, 'api design-type keeps the HTTP stub');
});

test('checklist-gen: clobber guard — CHECKLIST_EXISTS without --force, overwrites with --force', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'guard-test');
  fs.mkdirSync(sdDir, { recursive: true });
  const sdContent = [
    '# Solution Design: Guard', '',
    '> Generated by spec-flow. Design type: **api**.', '',
    '## 9. API Design', '', 'stuff', '',
    '## 13. Testing Strategy', '', '### 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected |',
    '| --- | --- | --- | --- |',
    '| TC-001 | login | valid creds | 200 |', '',
  ].join('\n');
  fs.writeFileSync(path.join(sdDir, 'SD.md'), sdContent);
  // First gen: ok
  const r1 = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'guard-test'], dir);
  assert.equal(r1.ok, true, 'first gen succeeds');
  // Second gen without --force: CHECKLIST_EXISTS
  const r2 = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'guard-test'], dir);
  assert.equal(r2.ok, false, 'second gen without --force fails');
  assert.match(r2.error || '', /CHECKLIST_EXISTS/, 'error code is CHECKLIST_EXISTS');
  // With --force: overwrites
  const r3 = run(['checklist-gen', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'guard-test', '--force'], dir);
  assert.equal(r3.ok, true, '--force overwrites existing checklist');
});

test('checkpoint-write: creates checkpoint.md; checkpoint-clear: removes it', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(path.join(dir, '.spec-flow', 'specs', 'feat-x'), { recursive: true });

  // write
  const rw = run(['checkpoint-write', '--feature', 'feat-x', '--task', '3 — Add repo layer',
    '--phase', 'GREEN', '--done', 'FooRepo.java', '--next', 'wire controller route'], dir);
  assert.equal(rw.ok, true, 'checkpoint-write succeeds');
  const cpPath = path.join(dir, '.spec-flow', 'specs', 'feat-x', 'checkpoint.md');
  assert.ok(fs.existsSync(cpPath), 'checkpoint.md written');
  const cpText = fs.readFileSync(cpPath, 'utf8');
  assert.match(cpText, /task: 3 — Add repo layer/, 'task recorded');
  assert.match(cpText, /phase: GREEN/, 'phase recorded');
  assert.match(cpText, /wire controller route/, 'next recorded');

  // overwrite (idempotent)
  run(['checkpoint-write', '--feature', 'feat-x', '--task', '3 — Add repo layer', '--phase', 'REFACTOR'], dir);
  const cpText2 = fs.readFileSync(cpPath, 'utf8');
  assert.match(cpText2, /phase: REFACTOR/, 'overwrite updates phase');

  // clear
  const rc = run(['checkpoint-clear', '--feature', 'feat-x'], dir);
  assert.equal(rc.ok, true, 'checkpoint-clear succeeds');
  assert.ok(!fs.existsSync(cpPath), 'checkpoint.md removed');

  // clear on absent: ok, cleared: false
  const rc2 = run(['checkpoint-clear', '--feature', 'feat-x'], dir);
  assert.equal(rc2.ok, true, 'clear on absent is ok');
  assert.equal(rc2.data.cleared, false, 'cleared: false when file absent');
});

test('checklist-status: classifies tests filled / scaffold / no-verify / live-e2e', () => {
  const dir = tmpProject();
  initProject(dir);
  const cl = path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml');
  fs.mkdirSync(path.dirname(cl), { recursive: true });
  fs.writeFileSync(cl, [
    'config: {}',
    'suites:',
    '  - id: suite-1',
    '    name: "Flow"',
    '    tests:',
    '      - id: TC-001',          // scaffold: still has the gen tripwires
    '        name: "scaffolded"',
    '        request:',
    '          path: /api/v1/TODO',
    '        expect:',
    '          body:',
    '            _assert: TODO',
    '      - id: TC-002',          // filled: real path + assertion
    '        name: "filled one"',
    '        request:',
    '          path: /api/v1/webhooks',
    '        expect:',
    '          status: 200',
    '      - id: TC-003',          // no-verify (pure unit transform)
    '        name: "mask util [no-verify]"',
    '        request:',
    '          path: /api/v1/TODO',
    '      - id: TC-004',          // live-e2e (event-driven, not curl-able)
    '        name: "webhook delivery [live-e2e]"',
    '',
  ].join('\n'));
  const r = run(['checklist-status', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.total, 4, '4 tests (suite-1 header not counted)');
  assert.equal(r.data.counts.scaffold, 1, 'TC-001 is scaffold');
  assert.equal(r.data.counts.filled, 1, 'TC-002 is filled');
  assert.equal(r.data.counts['no-verify'], 1, 'TC-003 tagged no-verify (not counted scaffold despite TODO path)');
  assert.equal(r.data.counts['live-e2e'], 1, 'TC-004 tagged live-e2e');
  assert.equal(r.data.ready, false, 'not ready: one scaffold stub remains');
  assert.deepEqual(r.data.byStatus.scaffold, ['TC-001']);
});

test('#4 checklist-status: recognizes carve-out tags in the tags LIST (not only bracketed-name)', () => {
  // Unified with lint-checklist (which reads the tags list). Pre-fix, checklist-status
  // only matched literal [no-verify] in the name → a `tags: [smoke, no-verify]` test was
  // miscounted as scaffold/filled, forcing the user to mark it in two places.
  const dir = tmpProject();
  initProject(dir);
  const cl = path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml');
  fs.mkdirSync(path.dirname(cl), { recursive: true });
  fs.writeFileSync(cl, [
    'suites:',
    '  - id: suite-1',
    '    tests:',
    '      - id: TC-001',
    '        name: "unit transform"',
    '        tags: [smoke, no-verify]',      // tag-list form, no brackets in name
    '      - id: TC-002',
    '        name: "event delivery"',
    '        tags: [regression, live-e2e]',  // tag-list form
    '',
  ].join('\n'));
  const r = run(['checklist-status', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.counts['no-verify'], 1, 'tags-list no-verify recognized');
  assert.equal(r.data.counts['live-e2e'], 1, 'tags-list live-e2e recognized');
  assert.equal(r.data.counts.scaffold, 0, 'neither miscounted as scaffold');
});

test('checklist-status: scaffold hint comment mentioning the OTHER carve-out tag does not override the real tags: line', () => {
  // Pre-fix: classify() scanned the whole body blob including checklist-gen's own
  // auto-comment ("...retag [no-verify]."), which every live-e2e scaffold carries —
  // so a genuinely live-e2e test always misclassified as no-verify regardless of its
  // actual tags: line. Comments must never drive classification, only real YAML content.
  const dir = tmpProject();
  initProject(dir);
  const cl = path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml');
  fs.mkdirSync(path.dirname(cl), { recursive: true });
  fs.writeFileSync(cl, [
    'suites:',
    '  - id: suite-1',
    '    tests:',
    '      - id: TC-001',
    '        name: "event delivery"',
    '        tags: [regression, live-e2e]',
    '        # SD Expected Result: ...',
    '        # If this is a pure unit transform (a util case, no integration), retag [no-verify].',
    '',
  ].join('\n'));
  const r = run(['checklist-status', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.counts['live-e2e'], 1, 'real tags: line (live-e2e) wins over comment text');
  assert.equal(r.data.counts['no-verify'], 0, 'comment-only mention of no-verify is ignored');
});

test('status-report: a fully-filled checklist reads "ready", not "scaffold" from boilerplate TODO mentions', () => {
  // Pre-fix: checklistStatus counted raw `TODO` occurrences anywhere in the file text,
  // including checklist-gen's own header comment ("...gates on remaining TODO markers")
  // and the default cleanup stub ("all: | # TODO: DELETE test rows..."). Neither is an
  // unfilled test — both are inert once every test itself has a real tag/assertion.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), '# SD: demo\n');
  fs.writeFileSync(path.join(sdDir, 'CHECKLIST.yaml'), [
    '# Fill each test before running (lint-checklist.sh gates on remaining TODO markers):',
    'config: {}',
    "cleanup:",
    "  all: | # TODO: DELETE test rows (LIKE 'TEST-%')",
    'suites:',
    '  - id: suite-1',
    '    tests:',
    '      - id: TC-001',
    '        name: "fully filled test"',
    '        tags: [smoke, no-verify]',
    '',
  ].join('\n'));
  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.checklist, 'ready', 'boilerplate TODO mentions in comments do not count as scaffold');
});

test('state-update: writes STATE.md and returns state path, lines, nextStep', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['state-update', '--feature', 'demo', '--note', 'initial state capture'], dir);
  assert.equal(r.ok, true, 'state-update ok');
  assert.ok(r.data.state, 'state file path returned');
  assert.ok(typeof r.data.lines === 'number' && r.data.lines > 0, 'lines is a positive number');
  assert.ok(typeof r.data.nextStep === 'string' && r.data.nextStep.length > 0, 'nextStep is a non-empty string');
  // STATE.md must be written on disk
  const statePath = path.join(dir, '.spec-flow', 'STATE.md');
  assert.ok(fs.existsSync(statePath), 'STATE.md exists on disk');
  const content = fs.readFileSync(statePath, 'utf8');
  assert.match(content, /STATE — demo/, 'STATE.md has the feature name heading');
  assert.match(content, /initial state capture/, 'note appears in STATE.md');
});

test('wave-plan: returns ready set from tasks.json respecting dependencies', () => {
  const dir = tmpProject();
  initProject(dir);
  const tmDir = path.join(dir, '.taskmaster', 'tasks');
  fs.mkdirSync(tmDir, { recursive: true });
  // task 1 done, task 2 depends on 1 (ready), task 3 depends on 2 (blocked), task 4 no deps (ready)
  fs.writeFileSync(path.join(tmDir, 'tasks.json'), JSON.stringify({
    tasks: [
      { id: 1, title: 'setup db', status: 'done', dependencies: [] },
      { id: 2, title: 'create tables', status: 'pending', dependencies: [1] },
      { id: 3, title: 'seed data', status: 'pending', dependencies: [2] },
      { id: 4, title: 'write tests', status: 'pending', dependencies: [] },
    ],
  }));
  const r = run(['wave-plan'], dir);
  assert.equal(r.ok, true, 'wave-plan ok');
  assert.equal(r.data.doneCount, 1, '1 done task');
  assert.equal(r.data.total, 4, 'total = 4 tasks');
  // tasks 2 and 4 are ready (deps satisfied); task 3 is blocked
  assert.equal(r.data.readyTotal, 2, 'tasks 2 and 4 are ready (deps met)');
  assert.equal(r.data.blockedCount, 1, 'task 3 is blocked (dep 2 not done)');
  const readyIds = r.data.ready.map((t) => t.id);
  assert.ok(readyIds.includes(2), 'task 2 in ready set');
  assert.ok(readyIds.includes(4), 'task 4 in ready set');
  assert.ok(!readyIds.includes(3), 'task 3 not in ready set (blocked)');
});

// ---------------------------------------------------------------------------
// srs-diff prose fallback + trace-impact srs-diff-shape ingestion (0.5.6)
// ---------------------------------------------------------------------------

test('srs-diff prose fallback: anchor-free SRS revision is NOT an empty changeset', () => {
  // Pre-fix: an SRS written as prose bullets (no US-/BL-/NFR anchors) parsed to
  // empty structures on BOTH sides, so any revision diffed 0/0/0 and the resync
  // guard mis-routed a genuine edit to "wrong input". Now the prose layer sees it.
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, '.spec-flow', 'srs', 'prosy.md');
  fs.mkdirSync(path.dirname(srs), { recursive: true });
  fs.writeFileSync(srs, [
    '# SRS — Prosy', '',
    '## 5. Functional Requirements',
    '- The system MUST expose balance via GetBalance.',
    '- The system MUST support top-up via InitCheckout.', '',
  ].join('\n'));
  const snap = run(['srs-snapshot', '--srs', srs, '--feature', 'prosy'], dir);
  assert.equal(snap.ok, true);

  // Identical → still empty (both layers quiet)
  const same = run(['srs-diff', '--new', srs, '--feature', 'prosy'], dir);
  assert.equal(same.ok, true);
  assert.equal(same.data.emptyChangeset, true, 'identical prose doc stays empty');
  assert.deepEqual(same.data.anchors, { old: 0, new: 0 }, 'diagnostics show anchor-free doc');

  // Real prose edit: one bullet changed, one added
  fs.writeFileSync(srs, [
    '# SRS — Prosy', '',
    '## 5. Functional Requirements',
    '- The system MUST expose balance via the WalletService facade.',
    '- The system MUST support top-up via InitCheckout.',
    '- The system MUST reject withdraw without payout wallet id.', '',
  ].join('\n'));
  const changed = run(['srs-diff', '--new', srs, '--feature', 'prosy'], dir);
  assert.equal(changed.ok, true);
  assert.equal(changed.data.counts.added + changed.data.counts.changed + changed.data.counts.removed, 0,
    'anchor layer still sees nothing');
  assert.equal(changed.data.emptyChangeset, false, 'prose layer rescues the revision from the empty-gate');
  assert.equal(changed.data.proseCounts.added, 2, 'changed bullet + new bullet surface as prose added');
  assert.equal(changed.data.proseCounts.removed, 1, 'old wording surfaces as prose removed');
  assert.match(changed.data.hint, /prose-level diff found/i, 'hint explains parser-blind vs no-change');
  assert.ok(changed.data.proseSections.some(s => /functional requirements/i.test(s)), 'section attributed');
});

test('trace-impact: accepts srs-diff output shape directly and harvests ids from changed text', () => {
  // Pre-fix: resync.md pipes srs-diff output into trace-impact --changeset, but
  // trace-impact only understood {ids, keywords} — the documented pipeline seeded
  // nothing, silently. Now the srs-diff shape ({changeset,prose}) is a first-class input.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Valid creds login | JWT 200 | FR-001 |', '',
  ].join('\n'));
  const tb = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(tb.ok, true);

  const csFile = path.join(dir, 'cs.json');
  fs.writeFileSync(csFile, JSON.stringify({
    changeset: { added: [], changed: [], removed: [] },
    prose: { added: [{ kind: 'prose', section: '5. FR', text: 'Login (FR-001) must also rotate refresh token.' }], removed: [] },
  }));
  const r = run(['trace-impact', '--feature', 'demo', '--changeset', csFile], dir);
  assert.equal(r.ok, true, 'trace-impact ok');
  assert.ok(r.data.impacted.fr.includes('FR-001'), 'FR-001 harvested from prose entry text');
  assert.ok(r.data.impacted.tc.includes('TC-001'), 'transitive fr-tc walk still applies');
});

test('srs-diff: detects a content edit inside an ID-prefixed FR/NFR table row', () => {
  // Pre-fix: diffTableRows() only ran against srs.nfr / srs.businessLogic / srs.stateTable
  // (the keyword-headed tables). An SRS shaped as ID-prefixed `| FR-1 | ... |` / `| NFR-1 |
  // ... |` tables (parseSrs's language-independent fallback — no user stories, no
  // keyword-matched headings) was never diffed at all: editing an FR row's requirement
  // text, an error-code mapping, or a validation limit read as 0/0/0, emptyChangeset:true.
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, '.spec-flow', 'srs', 'idtable.md');
  fs.mkdirSync(path.dirname(srs), { recursive: true });
  const body = (timeout, limit) => [
    '# Feature: Outbox', '',
    '## 5. Chuc nang', '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    `| FR-1 | MUST | timeout default is ${timeout} |`, '',
    '## 6. Phi chuc nang', '',
    '| NFR-1 | Category | Requirement |',
    '| --- | --- | --- |',
    `| NFR-1 | Perf | validation limit is ${limit} items per batch |`, '',
  ].join('\n');
  fs.writeFileSync(srs, body('30s', 100));
  const snap = run(['srs-snapshot', '--srs', srs, '--feature', 'idtable'], dir);
  assert.equal(snap.ok, true);

  const same = run(['srs-diff', '--new', srs, '--feature', 'idtable'], dir);
  assert.equal(same.data.emptyChangeset, true, 'unedited doc still round-trips clean');
  assert.ok(same.data.anchors.old > 0, 'FR/NFR ID tables now count as diffable anchors');

  fs.writeFileSync(srs, body('90s', 500));
  const changed = run(['srs-diff', '--new', srs, '--feature', 'idtable'], dir);
  assert.equal(changed.ok, true);
  assert.equal(changed.data.emptyChangeset, false, 'a real FR/NFR content edit is no longer invisible');
  assert.equal(changed.data.counts.changed, 2, 'both the FR row and the NFR row are flagged changed');
  const kinds = changed.data.changeset.changed.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['fr', 'nfr']);
});

test('srs-diff: an unchanged SRS round-trips clean across an NFC/NFD Unicode normalization mismatch', () => {
  // Pre-fix: norm() only lowercased + collapsed whitespace, never Unicode-normalized.
  // The SAME visible Vietnamese text encoded as precomposed (NFC) vs decomposed (NFD)
  // combining characters — routine when a snapshot copy and the later working SRS pass
  // through different editors/OSes — compared as different strings. Every affected
  // bullet showed up as a phantom removed+added pair, and emptyChangeset flipped to
  // false ("this IS a revision") for a document nobody had touched.
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, '.spec-flow', 'srs', 'unicode.md');
  fs.mkdirSync(path.dirname(srs), { recursive: true });
  const nfc = [
    '# Feature: Vi Du', '',
    '## 4. Truong hop bien',
    '- Giới hạn xác thực khi hết phiên đăng nhập',
    '- Xử lý lỗi khi kết nối mạng bị gián đoạn', '',
  ].join('\n').normalize('NFC');
  fs.writeFileSync(srs, nfc);
  const snap = run(['srs-snapshot', '--srs', srs, '--feature', 'unicode'], dir);
  assert.equal(snap.ok, true);

  // Re-save with the identical text decomposed to NFD — no actual content change.
  fs.writeFileSync(srs, nfc.normalize('NFD'));
  const r = run(['srs-diff', '--new', srs, '--feature', 'unicode'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.emptyChangeset, true, 'an encoding-only difference is not a real revision');
  assert.equal(r.data.proseCounts.added, 0);
  assert.equal(r.data.proseCounts.removed, 0);
});

// ---------------------------------------------------------------------------
// task-baseline — evidence-driven done for backfilled features (0.5.7)
// ---------------------------------------------------------------------------

/** Seed a demo feature: SD (FR-001/TC-001 + FR-002/TC-002), trace, tagged tasks.json. */
function seedBaselineProject() {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Login returns JWT | Must Have | US-1 |',
    '| FR-002 | Logout revokes refresh | Must Have | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy | Valid creds login | JWT 200 | FR-001 |',
    '| TC-002 | Happy | Logout | refresh revoked | FR-002 |', '',
  ].join('\n'));
  // Task 1 mapped via trace fr-task link; task 2 only mentions FR-002 in its text.
  const tl = run(['trace-link', '--task', '1', '--feature', 'demo', '--fr', 'FR-001', '--files', 'src/login.go'], dir);
  assert.equal(tl.ok, true);
  const tb = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(tb.ok, true);
  const tmDir = path.join(dir, '.taskmaster', 'tasks');
  fs.mkdirSync(tmDir, { recursive: true });
  fs.writeFileSync(path.join(tmDir, 'tasks.json'), JSON.stringify({
    demo: { tasks: [
      { id: 1, title: 'Implement login', status: 'pending' },
      { id: 2, title: 'Implement logout (FR-002)', status: 'pending' },
      { id: 3, title: 'Unrelated infra chore', status: 'pending' },
    ] },
  }, null, 2));
  return dir;
}

test('task-baseline: no VERIFICATION.md → zero baselined (manual-test gate stays the only door to done)', () => {
  const dir = seedBaselineProject();
  const r = run(['task-baseline', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.baselined.length, 0, 'no evidence, no done');
  assert.match(r.data.note, /VERIFICATION/i, 'note routes to /sf:manual-test');
});

test('task-baseline: dry-run proposes from evidence (trace link + text fallback), --apply writes done', () => {
  const dir = seedBaselineProject();
  fs.writeFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'VERIFICATION.md'), [
    '# VERIFICATION — demo', '', 'status: passed', '', 'truths:',
    '- TC-001: verified',
    '- TC-002: verified', '',
  ].join('\n'));

  // Dry-run: proposal only, tasks.json untouched.
  const dry = run(['task-baseline', '--feature', 'demo'], dir);
  assert.equal(dry.ok, true);
  assert.equal(dry.data.applied, false);
  const ids = dry.data.baselined.map(b => b.id);
  assert.deepEqual(ids.sort(), ['1', '2'], 'task 1 (trace link) + task 2 (text mention) qualify');
  assert.equal(dry.data.baselined.find(b => b.id === '1').mappedVia, 'trace fr-task link');
  assert.equal(dry.data.baselined.find(b => b.id === '2').mappedVia, 'task text mention');
  assert.ok(dry.data.skipped.some(s => s.id === '3' && /no evidence set/.test(s.reason)),
    'unmapped task skipped with explicit reason, never silently done');
  let tm = JSON.parse(fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8'));
  assert.ok(tm.demo.tasks.every(t => t.status === 'pending'), 'dry-run writes nothing');

  // Apply: statuses move, evidence note recorded.
  const ap = run(['task-baseline', '--feature', 'demo', '--apply'], dir);
  assert.equal(ap.ok, true);
  assert.equal(ap.data.applied, true);
  tm = JSON.parse(fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8'));
  const byId = Object.fromEntries(tm.demo.tasks.map(t => [t.id, t]));
  assert.equal(byId[1].status, 'done');
  assert.equal(byId[2].status, 'done');
  assert.equal(byId[3].status, 'pending', 'unmapped task untouched');
  assert.match(byId[1].details, /baselined from VERIFICATION .* TC-001/, 'evidence note in details');
});

test('task-baseline: partially verified evidence set does NOT baseline (full-coverage rule)', () => {
  const dir = seedBaselineProject();
  fs.writeFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'VERIFICATION.md'), [
    '# VERIFICATION — demo', '', 'truths:',
    '- TC-001: verified',
    '- TC-002: failed', '',
  ].join('\n'));
  const r = run(['task-baseline', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  const ids = r.data.baselined.map(b => b.id);
  assert.deepEqual(ids, ['1'], 'only the fully-verified task baselines');
  assert.ok(r.data.skipped.some(s => s.id === '2' && /unverified TCs: TC-002/.test(s.reason)),
    'failed TC blocks its task with the exact reason');
});

// ---------------------------------------------------------------------------
// taskmaster-model-plan — TC-001 through TC-006 (SD §13.2)
// ---------------------------------------------------------------------------

/**
 * Helper: create a minimal project with .spec-flow/config.json containing a
 * given models.taskmaster block and an optional .taskmaster/config.json.
 */
function makePlanProject({ sfModels, tmConfig } = {}) {
  const dir = tmpProject();
  // Write .spec-flow/config.json with the supplied models block.
  fs.mkdirSync(path.join(dir, '.spec-flow'), { recursive: true });
  const cfg = {
    project: 'test',
    stack: 'node',
    models: Object.assign({ sdAuthor: null, hybridExecutor: 'sonnet' }, sfModels ? { taskmaster: sfModels } : {}),
  };
  fs.writeFileSync(path.join(dir, '.spec-flow', 'config.json'), JSON.stringify(cfg, null, 2));
  // Write .taskmaster/config.json when provided.
  if (tmConfig !== undefined && tmConfig !== null) {
    fs.mkdirSync(path.join(dir, '.taskmaster'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.taskmaster', 'config.json'),
      JSON.stringify(tmConfig, null, 2)
    );
  }
  return dir;
}

// TC-001: needsChange:true — role main, configured !== previous (FR-003)
test('taskmaster-model-plan TC-001: needsChange:true when configured opus != previous sonnet (role main)', () => {
  const dir = makePlanProject({
    sfModels: { main: 'opus', research: 'sonnet' },
    tmConfig: { models: { main: { modelId: 'sonnet' }, research: { modelId: 'sonnet' } } },
  });
  const r = run(['taskmaster-model-plan', '--role', 'main'], dir);
  assert.equal(r.ok, true, 'command returns ok');
  assert.equal(r.data.needsChange, true, 'needsChange is true');
  assert.equal(r.data.configured, 'opus', 'configured echoes the sf config value');
  assert.equal(r.data.previous, 'sonnet', 'previous echoes the tm config value');
});

// TC-006: role research — same logic (FR-003)
test('taskmaster-model-plan TC-006: needsChange:true for role research (configured opus != previous sonnet)', () => {
  const dir = makePlanProject({
    sfModels: { main: 'sonnet', research: 'opus' },
    tmConfig: { models: { main: { modelId: 'sonnet' }, research: { modelId: 'sonnet' } } },
  });
  const r = run(['taskmaster-model-plan', '--role', 'research'], dir);
  assert.equal(r.ok, true, 'command returns ok');
  assert.equal(r.data.needsChange, true, 'needsChange is true');
  assert.equal(r.data.configured, 'opus', 'configured is opus');
  assert.equal(r.data.previous, 'sonnet', 'previous is sonnet');
});

// TC-002: needsChange:false + reason:"already-set" (FR-002)
test('taskmaster-model-plan TC-002: needsChange:false + reason already-set when configured === previous', () => {
  const dir = makePlanProject({
    sfModels: { main: 'opus', research: 'sonnet' },
    tmConfig: { models: { main: { modelId: 'opus' }, research: { modelId: 'sonnet' } } },
  });
  const r = run(['taskmaster-model-plan', '--role', 'main'], dir);
  assert.equal(r.ok, true, 'command returns ok');
  assert.equal(r.data.needsChange, false, 'needsChange is false');
  assert.equal(r.data.reason, 'already-set', 'reason is already-set');
});

// TC-003: needsChange:false for null / absent / empty-string configured — must NOT read tm config (FR-001)
test('taskmaster-model-plan TC-003a: needsChange:false when configured is null (no tm read)', () => {
  // No .taskmaster/config.json written — if the command tried to read it, it would
  // throw/fail because the directory does not exist. Clean pass proves early return.
  const dir = makePlanProject({ sfModels: { main: null, research: 'sonnet' } });
  const r = run(['taskmaster-model-plan', '--role', 'main'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.needsChange, false);
  assert.equal(r.data.reason, undefined, 'no reason field when null-configured');
});

test('taskmaster-model-plan TC-003b: needsChange:false when models.taskmaster block is absent (no tm read)', () => {
  // Config has no models.taskmaster key at all.
  const dir = makePlanProject({ sfModels: undefined });
  const r = run(['taskmaster-model-plan', '--role', 'main'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.needsChange, false);
});

test('taskmaster-model-plan TC-003c: needsChange:false when configured is empty string (no tm read)', () => {
  const dir = makePlanProject({ sfModels: { main: '', research: 'sonnet' } });
  const r = run(['taskmaster-model-plan', '--role', 'main'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.needsChange, false);
});

// TC-004: graceful when .taskmaster/config.json is missing (FR-005)
test('taskmaster-model-plan TC-004: needsChange:false and no throw when .taskmaster/config.json is absent', () => {
  // configured is non-empty but .taskmaster/config.json does not exist.
  const dir = makePlanProject({
    sfModels: { main: 'opus', research: 'sonnet' },
    // tmConfig intentionally omitted (undefined) → file not written
  });
  const r = run(['taskmaster-model-plan', '--role', 'main'], dir);
  assert.equal(r.ok, true, 'never throws even when tm config missing');
  assert.equal(r.data.needsChange, false, 'graceful needsChange:false');
});

// TC-005: no subprocess spawned — command succeeds without task-master on PATH (FR-004)
test('taskmaster-model-plan TC-005: no subprocess — succeeds when PATH has no task-master binary', () => {
  // Override PATH to an empty temp dir (no task-master, no npx, etc.).
  // A subprocess call would fail with ENOENT or hang; a pure fs-based implementation
  // ignores PATH entirely and succeeds cleanly.
  // We use process.execPath (absolute node path) so overriding PATH does not break the
  // node invocation itself — only external tools like task-master/npx become unavailable.
  const dir = makePlanProject({
    sfModels: { main: 'opus', research: 'sonnet' },
    tmConfig: { models: { main: { modelId: 'sonnet' }, research: { modelId: 'sonnet' } } },
  });
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-empty-bin-'));
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [ENGINE, 'taskmaster-model-plan', '--role', 'main'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: emptyBin } }
    );
  } catch (e) {
    if (e.stdout) out = String(e.stdout);
    else throw e;
  }
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.ok, true, 'command succeeds without task-master on PATH (no subprocess)');
  assert.equal(r.data.needsChange, true, 'result is correct despite empty PATH');
});

// Invalid --role → INVALID_ROLE error (§12.2)
test('taskmaster-model-plan: invalid --role value returns INVALID_ROLE error', () => {
  const dir = makePlanProject({ sfModels: { main: 'opus', research: 'sonnet' } });
  const r = run(['taskmaster-model-plan', '--role', 'fallback'], dir);
  assert.equal(r.ok, false, 'invalid role returns ok:false');
  assert.match(r.error, /INVALID_ROLE/, 'error code is INVALID_ROLE');
});

test('taskmaster-model-plan: missing --role returns INVALID_ROLE error', () => {
  const dir = makePlanProject({ sfModels: { main: 'opus', research: 'sonnet' } });
  const r = run(['taskmaster-model-plan'], dir);
  assert.equal(r.ok, false, 'missing role returns ok:false');
  assert.match(r.error, /INVALID_ROLE/, 'error code is INVALID_ROLE');
});

// ---------------------------------------------------------------------------
// taskmaster-model-check — preflight: does every role have what it needs to run?
// ---------------------------------------------------------------------------

/** Write .taskmaster/config.json with the given models block. */
function makeTmProject(models) {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.taskmaster'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.taskmaster', 'config.json'),
    JSON.stringify({ models }, null, 2)
  );
  return dir;
}

/** Run taskmaster-model-check with a fully-controlled env (real host env never leaks in). */
function runModelCheck(dir, env) {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [ENGINE, 'taskmaster-model-check'],
      { cwd: dir, encoding: 'utf8', env }
    );
  } catch (e) {
    if (e.stdout) out = String(e.stdout);
    else throw e;
  }
  return JSON.parse(out.trim().split('\n').pop());
}

test('taskmaster-model-check: checked:false when .taskmaster/config.json is absent', () => {
  const dir = tmpProject();
  const r = runModelCheck(dir, { PATH: process.env.PATH });
  assert.equal(r.ok, true);
  assert.equal(r.data.checked, false);
});

test('taskmaster-model-check: clean:true when every role is on the keyless claude-code provider', () => {
  const dir = makeTmProject({
    main: { provider: 'claude-code', modelId: 'sonnet' },
    research: { provider: 'claude-code', modelId: 'sonnet' },
    fallback: { provider: 'claude-code', modelId: 'sonnet' },
  });
  const r = runModelCheck(dir, { PATH: process.env.PATH });
  assert.equal(r.ok, true);
  assert.equal(r.data.checked, true);
  assert.equal(r.data.clean, true);
  assert.deepEqual(r.data.problems, []);
});

test('taskmaster-model-check: flags a keyed provider with no key in env or .env (the plat-int-test failure mode)', () => {
  const dir = makeTmProject({
    main: { provider: 'claude-code', modelId: 'sonnet' },
    research: { provider: 'claude-code', modelId: 'sonnet' },
    fallback: { provider: 'anthropic', modelId: 'claude-3-7-sonnet-20250219' },
  });
  // Deliberately no ANTHROPIC_API_KEY in the child env and no .env file written.
  const r = runModelCheck(dir, { PATH: process.env.PATH });
  assert.equal(r.ok, true);
  assert.equal(r.data.checked, true);
  assert.equal(r.data.clean, false);
  assert.equal(r.data.problems.length, 1);
  assert.match(r.data.problems[0], /fallback/);
  assert.match(r.data.problems[0], /ANTHROPIC_API_KEY/);
});

test('taskmaster-model-check: clean:true when the required key is present via process env', () => {
  const dir = makeTmProject({
    main: { provider: 'anthropic', modelId: 'claude-3-7-sonnet-20250219' },
  });
  const r = runModelCheck(dir, { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-test-fake' });
  assert.equal(r.data.clean, true, 'key present in env satisfies the check');
});

test('taskmaster-model-check: clean:true when the required key is present via .env (not process env)', () => {
  const dir = makeTmProject({
    research: { provider: 'perplexity', modelId: 'sonar-pro' },
  });
  fs.writeFileSync(path.join(dir, '.env'), 'PERPLEXITY_API_KEY=pplx-test-fake\n');
  const r = runModelCheck(dir, { PATH: process.env.PATH }); // no PERPLEXITY_API_KEY in process env
  assert.equal(r.data.clean, true, '.env is read even when process env lacks the key');
});

test('taskmaster-model-check: reports multiple broken roles independently', () => {
  const dir = makeTmProject({
    main: { provider: 'openai', modelId: 'gpt-4o' },
    research: { provider: 'perplexity', modelId: 'sonar-pro' },
    fallback: { provider: 'claude-code', modelId: 'sonnet' },
  });
  const r = runModelCheck(dir, { PATH: process.env.PATH });
  assert.equal(r.data.clean, false);
  assert.equal(r.data.problems.length, 2, 'main and research both flagged; fallback (claude-code) is not');
  assert.ok(r.data.problems.some((p) => /^main:/.test(p) && /OPENAI_API_KEY/.test(p)));
  assert.ok(r.data.problems.some((p) => /^research:/.test(p) && /PERPLEXITY_API_KEY/.test(p)));
});

// ---------------------------------------------------------------------------
// task-* command wrappers (Task #9 — wires task-core into flow-tools.cjs)
// Tests cover: ok/err shape, error-code mapping, end-to-end persistence, atomicity.
// ---------------------------------------------------------------------------

/** Seed a .taskmaster/state.json so task-add can resolve the tag from cwd. */
function seedState(dir, tag) {
  const tmDir = path.join(dir, '.taskmaster');
  fs.mkdirSync(tmDir, { recursive: true });
  fs.writeFileSync(path.join(tmDir, 'state.json'), JSON.stringify({ currentTag: tag }));
}

// -- task-add ----------------------------------------------------------------

test('task-add: creates a task and returns ok with the new task object', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  const r = run(['task-add', '--tag', 'default', '--title', 'My first task'], dir);
  assert.equal(r.ok, true, 'task-add ok');
  assert.equal(r.data.id, '1', 'first task gets id 1');
  assert.equal(r.data.title, 'My first task');
  assert.equal(r.data.status, 'pending');
  assert.equal(r.data.priority, 'medium');
  assert.ok(r.data.updatedAt, 'updatedAt present');
});

test('task-add: resolves tag from state.json when --tag is omitted', () => {
  const dir = tmpProject();
  seedState(dir, 'myfeature');
  const r = run(['task-add', '--title', 'Tag-from-state task'], dir);
  assert.equal(r.ok, true, 'task-add resolves tag from state.json');
  assert.equal(r.data.title, 'Tag-from-state task');
});

test('task-add: missing title returns err carrying ERR_INVALID_TITLE', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  const r = run(['task-add', '--tag', 'default'], dir);
  assert.equal(r.ok, false, 'missing title returns err');
  assert.match(r.error, /ERR_INVALID_TITLE|MISSING_ARG/);
});

test('task-add: no tag and no state.json returns err carrying ERR_NO_TAG', () => {
  const dir = tmpProject();
  // no seedState — no state.json
  const r = run(['task-add', '--title', 'No tag task'], dir);
  assert.equal(r.ok, false, 'no tag → err');
  assert.match(r.error, /ERR_NO_TAG/);
});

test('task-add: --priority is applied when valid', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  const r = run(['task-add', '--tag', 'default', '--title', 'High prio task', '--priority', 'high'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.priority, 'high');
});

// -- task-get ----------------------------------------------------------------

test('task-get: returns the task when found', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Find me'], dir);
  const r = run(['task-get', '--tag', 'default', '--id', '1'], dir);
  assert.equal(r.ok, true, 'task-get ok');
  assert.equal(r.data.id, '1');
  assert.equal(r.data.title, 'Find me');
});

test('task-get: returns ok with data:null when id does not exist (FR-005: no throw)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  const r = run(['task-get', '--tag', 'default', '--id', '999'], dir);
  assert.equal(r.ok, true, 'task-get returns ok even when task not found');
  assert.equal(r.data, null, 'data is null when task not found');
});

test('task-get: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-get', '--id', '1'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

test('task-get: missing --id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-get', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*id/i);
});

// -- task-list ---------------------------------------------------------------

test('task-list: returns tasks array and stats object (FR-006, FR-007)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task A'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task B'], dir);
  const r = run(['task-list', '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'task-list ok');
  assert.equal(Array.isArray(r.data.tasks), true, 'tasks is array');
  assert.equal(r.data.tasks.length, 2, 'two tasks returned');
  assert.ok(r.data.stats, 'stats object present');
  assert.equal(typeof r.data.stats.completionPercentage, 'number', 'completionPercentage is a number');
  assert.equal(r.data.stats.pending, 2, 'both tasks are pending');
});

test('task-list: --status filter returns only matching tasks', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task A'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task B'], dir);
  run(['task-set-status', '--tag', 'default', '--id', '1', '--status', 'done'], dir);
  const r = run(['task-list', '--tag', 'default', '--status', 'pending'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.tasks.length, 1, 'only the pending task returned');
  assert.equal(r.data.tasks[0].id, '2', 'task 2 is the pending one');
  // stats are still computed on all tasks (FR-007: stats on whole tag, not filtered set)
  assert.equal(r.data.stats.done, 1, 'stats.done counts all tasks (1 done in whole tag)');
});

test('task-list: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-list'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- task-set-status ---------------------------------------------------------

test('task-set-status: changes status and returns the updated task', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Status target'], dir);
  const r = run(['task-set-status', '--tag', 'default', '--id', '1', '--status', 'done'], dir);
  assert.equal(r.ok, true, 'task-set-status ok');
  assert.equal(r.data.status, 'done', 'status updated to done');
});

test('task-set-status: invalid status returns err with ERR_INVALID_STATUS (FR-009)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task'], dir);
  const r = run(['task-set-status', '--tag', 'default', '--id', '1', '--status', 'bogus'], dir);
  assert.equal(r.ok, false, 'invalid status returns err');
  assert.match(r.error, /ERR_INVALID_STATUS/, 'error carries ERR_INVALID_STATUS code');
});

test('task-set-status: non-existent id returns err with ERR_TASK_NOT_FOUND (FR-010)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  const r = run(['task-set-status', '--tag', 'default', '--id', '999', '--status', 'done'], dir);
  assert.equal(r.ok, false, 'non-existent id returns err');
  assert.match(r.error, /ERR_TASK_NOT_FOUND/, 'error carries ERR_TASK_NOT_FOUND code');
});

test('task-set-status: missing --status returns err MISSING_ARG', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task'], dir);
  const r = run(['task-set-status', '--tag', 'default', '--id', '1'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*status/i);
});

// -- task-next ---------------------------------------------------------------

test('task-next: returns the next actionable pending task (FR-011)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Next candidate'], dir);
  const r = run(['task-next', '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'task-next ok');
  assert.ok(r.data.task, 'task field present');
  assert.equal(r.data.task.id, '1', 'next task is id 1');
});

test('task-next: returns task:null with reason when no pending tasks remain (FR-012)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  // no tasks added — no pending tasks
  const r = run(['task-next', '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'task-next never throws');
  assert.equal(r.data.task, null, 'task is null when no eligible task');
  assert.ok(r.data.reason, 'reason string provided');
});

test('task-next: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-next'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- task-update -------------------------------------------------------------

test('task-update: updates description and returns the updated task (FR-013)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Update target'], dir);
  const r = run(['task-update', '--tag', 'default', '--id', '1', '--description', 'Updated desc'], dir);
  assert.equal(r.ok, true, 'task-update ok');
  assert.equal(r.data.description, 'Updated desc', 'description updated');
});

test('task-update: updates notes field', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Notes target'], dir);
  const r = run(['task-update', '--tag', 'default', '--id', '1', '--notes', 'some notes'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.notes, 'some notes');
});

test('task-update: non-existent id returns err with ERR_TASK_NOT_FOUND (FR-013)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  const r = run(['task-update', '--tag', 'default', '--id', '999', '--description', 'x'], dir);
  assert.equal(r.ok, false, 'non-existent id returns err');
  assert.match(r.error, /ERR_TASK_NOT_FOUND/, 'error carries ERR_TASK_NOT_FOUND code');
});

test('task-update: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-update', '--id', '1', '--description', 'x'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- E2E sequence: cross-command persistence ---------------------------------

test('E2E: task-add → task-get → task-set-status → task-list persists state across CLI calls', () => {
  const dir = tmpProject();
  seedState(dir, 'default');

  // 1. Add two tasks
  const add1 = run(['task-add', '--tag', 'default', '--title', 'E2E task 1'], dir);
  assert.equal(add1.ok, true);
  const add2 = run(['task-add', '--tag', 'default', '--title', 'E2E task 2'], dir);
  assert.equal(add2.ok, true);
  assert.equal(add2.data.id, '2', 'second task gets id 2');

  // 2. Verify task-get reads what task-add wrote
  const got = run(['task-get', '--tag', 'default', '--id', '1'], dir);
  assert.equal(got.ok, true);
  assert.equal(got.data.title, 'E2E task 1', 'task-get retrieves task written by task-add');

  // 3. Change status in a separate CLI call
  const setOk = run(['task-set-status', '--tag', 'default', '--id', '1', '--status', 'done'], dir);
  assert.equal(setOk.ok, true);
  assert.equal(setOk.data.status, 'done');

  // 4. task-list reflects the status change persisted to disk
  const listed = run(['task-list', '--tag', 'default'], dir);
  assert.equal(listed.ok, true);
  assert.equal(listed.data.stats.done, 1, '1 done task in stats');
  assert.equal(listed.data.stats.pending, 1, '1 pending task in stats');
  assert.equal(listed.data.stats.completionPercentage, 50, 'completion = 1/2 * 100 = 50');

  // 5. task-next returns task 2 (task 1 is done, not pending)
  const nextR = run(['task-next', '--tag', 'default'], dir);
  assert.equal(nextR.ok, true);
  assert.equal(nextR.data.task.id, '2', 'next returns task 2 (task 1 already done)');
});

// -- Atomic persistence ------------------------------------------------------

test('atomic: tasks.json has sequential ids and valid JSON after multiple task-add calls', () => {
  const dir = tmpProject();
  seedState(dir, 'default');

  run(['task-add', '--tag', 'default', '--title', 'Atomic task 1'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Atomic task 2'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Atomic task 3'], dir);

  // The tasks.json must be valid JSON (not truncated/corrupted) with 3 tasks
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  assert.equal(tasksJson['default'].tasks.length, 3, 'all 3 tasks persisted correctly');
  assert.equal(tasksJson['default'].tasks[0].id, '1');
  assert.equal(tasksJson['default'].tasks[1].id, '2');
  assert.equal(tasksJson['default'].tasks[2].id, '3');
});

// ---------------------------------------------------------------------------
// task-use-tag / task-add-dep / task-remove-dep / task-add-subtask / task-expand
// (Task #6 — wires TagManager, DependencyManager, SubtaskManager, ExpandHook
//  into flow-tools.cjs — additive only; no existing command modified)
//
// Tests cover: ok/err shape, error-code mapping, MISSING_ARG guards, and a
// multi-step E2E persistence check (use-tag → add-subtask → add-dep).
// ---------------------------------------------------------------------------

// -- task-use-tag ------------------------------------------------------------

test('task-use-tag: writes currentTag to state.json (FR-002)', () => {
  const dir = tmpProject();
  const r = run(['task-use-tag', '--tag', 'feat-x'], dir);
  assert.equal(r.ok, true, 'task-use-tag ok');
  assert.equal(r.data.tag, 'feat-x', 'data.tag reflects the set tag');
  // Verify state.json was actually written to disk
  const state = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'state.json'), 'utf8')
  );
  assert.equal(state.currentTag, 'feat-x', 'state.json.currentTag persisted');
});

test('task-use-tag: auto-creates tag namespace in tasks.json (FR-003)', () => {
  const dir = tmpProject();
  run(['task-use-tag', '--tag', 'brand-new'], dir);
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  assert.ok(tasksJson['brand-new'], 'brand-new namespace exists');
  assert.deepEqual(tasksJson['brand-new'].tasks, [], 'namespace has empty tasks array');
});

test('task-use-tag: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-use-tag'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- task-add-dep ------------------------------------------------------------

test('task-add-dep: adds dependency and returns ok (FR-005, TC-007)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  // Seed two tasks
  run(['task-add', '--tag', 'default', '--title', 'Task 1'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task 2'], dir);
  // Add dep: task 1 depends on task 2
  const r = run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'task-add-dep ok');
  assert.equal(r.data.taskId, '1');
  assert.equal(r.data.depId, '2');
  // Verify dependency persisted in tasks.json
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  assert.deepEqual(tasksJson['default'].tasks[0].dependencies, ['2'], 'dep persisted');
});

test('task-add-dep: no-op when dep already present (FR-005, TC-008)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task 1'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task 2'], dir);
  run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  // Add the same dep again — must be no-op
  const r2 = run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  assert.equal(r2.ok, true, 'second task-add-dep no-op ok');
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  assert.equal(tasksJson['default'].tasks[0].dependencies.length, 1, 'no duplicate dep');
});

test('task-add-dep: ERR_TAG_NOT_FOUND when tag absent (FR-004, TC-006)', () => {
  const dir = tmpProject();
  // No task-use-tag, no tag namespace exists
  const r = run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'ghost-tag'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_TAG_NOT_FOUND/);
});

test('task-add-dep: ERR_DEP_NOT_FOUND when depId absent (FR-007, TC-009)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task 1'], dir);
  const r = run(['task-add-dep', '--task-id', '1', '--dep-id', '999', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_DEP_NOT_FOUND/);
});

test('task-add-dep: ERR_DEP_CYCLE on direct cycle (FR-006, TC-010)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task A'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task B'], dir);
  // A → B
  run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  // B → A would form a cycle
  const r = run(['task-add-dep', '--task-id', '2', '--dep-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_DEP_CYCLE/);
});

test('task-add-dep: ERR_DEP_CYCLE on indirect cycle (FR-006, TC-011)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task A'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task B'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task C'], dir);
  // A → B, B → C
  run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  run(['task-add-dep', '--task-id', '2', '--dep-id', '3', '--tag', 'default'], dir);
  // C → A would form an indirect cycle
  const r = run(['task-add-dep', '--task-id', '3', '--dep-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_DEP_CYCLE/);
});

test('task-add-dep: cross-tag dep rejected as ERR_DEP_NOT_FOUND (FR-009, TC-014)', () => {
  const dir = tmpProject();
  seedState(dir, 'tagA');
  run(['task-use-tag', '--tag', 'tagA'], dir);
  run(['task-use-tag', '--tag', 'tagB'], dir);
  // Add task 1 in tagA, task 2 in tagB
  run(['task-add', '--tag', 'tagA', '--title', 'Task in A'], dir);
  run(['task-add', '--tag', 'tagB', '--title', 'Task in B'], dir);
  // task 2 in tagA does not exist — cross-tag dep should fail
  const r = run(['task-add-dep', '--task-id', '1', '--dep-id', '1', '--tag', 'tagA'], dir);
  // Dep from task1 to task1 is itself — but task 1 in tagA exists. We need to try
  // to dep to task 1 from tagB (which doesn't exist in tagA namespace).
  // tagA has task '1', tagB has task '1' too, so let's add another to tagB.
  run(['task-add', '--tag', 'tagB', '--title', 'Task 2 in B'], dir);
  // Task '2' exists only in tagB, not tagA
  const r2 = run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'tagA'], dir);
  assert.equal(r2.ok, false, 'cross-tag dep rejected');
  assert.match(r2.error, /ERR_DEP_NOT_FOUND/, 'error is ERR_DEP_NOT_FOUND');
});

test('task-add-dep: missing --task-id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-add-dep', '--dep-id', '2', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*task-id/i);
});

test('task-add-dep: missing --dep-id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-add-dep', '--task-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*dep-id/i);
});

test('task-add-dep: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-add-dep', '--task-id', '1', '--dep-id', '2'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- task-remove-dep ---------------------------------------------------------

test('task-remove-dep: removes dep and returns ok (FR-008, TC-012)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task 1'], dir);
  run(['task-add', '--tag', 'default', '--title', 'Task 2'], dir);
  run(['task-add-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  // Remove the dep
  const r = run(['task-remove-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'task-remove-dep ok');
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  assert.deepEqual(tasksJson['default'].tasks[0].dependencies, [], 'dep removed');
});

test('task-remove-dep: no-op when depId not in list (FR-008, TC-013)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task 1'], dir);
  // Remove a dep that was never added — must be ok, no error
  const r = run(['task-remove-dep', '--task-id', '1', '--dep-id', '999', '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'task-remove-dep no-op ok');
});

test('task-remove-dep: ERR_TAG_NOT_FOUND when tag absent', () => {
  const dir = tmpProject();
  const r = run(['task-remove-dep', '--task-id', '1', '--dep-id', '2', '--tag', 'ghost-tag'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_TAG_NOT_FOUND/);
});

test('task-remove-dep: ERR_DEP_NOT_FOUND when taskId absent', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Task 1'], dir);
  const r = run(['task-remove-dep', '--task-id', '999', '--dep-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_DEP_NOT_FOUND/);
});

test('task-remove-dep: missing --task-id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-remove-dep', '--dep-id', '2', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*task-id/i);
});

test('task-remove-dep: missing --dep-id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-remove-dep', '--task-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*dep-id/i);
});

test('task-remove-dep: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-remove-dep', '--task-id', '1', '--dep-id', '2'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- task-add-subtask --------------------------------------------------------

test('task-add-subtask: creates subtask with hierarchical id "1.1" (FR-010, TC-015)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Parent task'], dir);
  const r = run([
    'task-add-subtask',
    '--parent-id', '1',
    '--title', 'First subtask',
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, true, 'task-add-subtask ok');
  assert.equal(r.data.id, '1.1', 'subtask id is 1.1');
  assert.equal(r.data.title, 'First subtask');
  assert.equal(r.data.status, 'pending', 'default status is pending');
});

test('task-add-subtask: sequential id "1.3" after two existing subtasks (FR-010, TC-016)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Parent task'], dir);
  run(['task-add-subtask', '--parent-id', '1', '--title', 'Sub A', '--tag', 'default'], dir);
  run(['task-add-subtask', '--parent-id', '1', '--title', 'Sub B', '--tag', 'default'], dir);
  const r = run(['task-add-subtask', '--parent-id', '1', '--title', 'Sub C', '--tag', 'default'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.id, '1.3', 'third subtask gets id 1.3');
});

test('task-add-subtask: accepts --description and --details fields', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Parent task'], dir);
  const r = run([
    'task-add-subtask',
    '--parent-id', '1',
    '--title', 'Detailed sub',
    '--description', 'Describe it',
    '--details', 'Deep details here',
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.description, 'Describe it');
  assert.equal(r.data.details, 'Deep details here');
});

test('task-add-subtask: ERR_TAG_NOT_FOUND when tag absent', () => {
  const dir = tmpProject();
  const r = run([
    'task-add-subtask',
    '--parent-id', '1',
    '--title', 'Sub',
    '--tag', 'ghost-tag',
  ], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_TAG_NOT_FOUND/);
});

test('task-add-subtask: ERR_TASK_NOT_FOUND when parent task absent', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Existing task'], dir);
  const r = run([
    'task-add-subtask',
    '--parent-id', '999',
    '--title', 'Orphan sub',
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_TASK_NOT_FOUND/);
});

test('task-add-subtask: missing --parent-id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-add-subtask', '--title', 'Sub', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*parent-id/i);
});

test('task-add-subtask: missing --title returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-add-subtask', '--parent-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*title/i);
});

test('task-add-subtask: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-add-subtask', '--parent-id', '1', '--title', 'Sub'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- task-expand -------------------------------------------------------------

test('task-expand: creates multiple subtasks from JSON file (FR-012, TC-019)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Parent task'], dir);
  // Write subtasks JSON file
  const subtasksFile = path.join(dir, 'subtasks.json');
  fs.writeFileSync(subtasksFile, JSON.stringify([
    { title: 'Sub A' },
    { title: 'Sub B', description: 'B desc' },
  ]));
  const r = run([
    'task-expand',
    '--task-id', '1',
    '--subtasks', subtasksFile,
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, true, 'task-expand ok');
  assert.equal(r.data.created.length, 2, '2 subtasks created');
  assert.equal(r.data.created[0].id, '1.1');
  assert.equal(r.data.created[1].id, '1.2');
});

test('task-expand: appends to existing subtasks (FR-013, TC-020)', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Parent task'], dir);
  // First expansion
  const file1 = path.join(dir, 'subs1.json');
  fs.writeFileSync(file1, JSON.stringify([{ title: 'First sub' }]));
  run(['task-expand', '--task-id', '1', '--subtasks', file1, '--tag', 'default'], dir);
  // Second expansion — must append, not overwrite
  const file2 = path.join(dir, 'subs2.json');
  fs.writeFileSync(file2, JSON.stringify([{ title: 'Second sub' }]));
  const r = run(['task-expand', '--task-id', '1', '--subtasks', file2, '--tag', 'default'], dir);
  assert.equal(r.ok, true, 'second task-expand ok');
  assert.equal(r.data.created[0].id, '1.2', 'second sub gets id 1.2 (appended after 1.1)');
  // Verify tasks.json has both subtasks
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  assert.equal(tasksJson['default'].tasks[0].subtasks.length, 2, 'both subtasks present');
});

test('task-expand: ERR_INVALID_SUBTASKS when element missing title', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'Parent'], dir);
  const subtasksFile = path.join(dir, 'bad.json');
  fs.writeFileSync(subtasksFile, JSON.stringify([{ description: 'no title here' }]));
  const r = run([
    'task-expand',
    '--task-id', '1',
    '--subtasks', subtasksFile,
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_INVALID_SUBTASKS/);
});

test('task-expand: ERR_SUBTASKS_FILE when --subtasks file does not exist', () => {
  const dir = tmpProject();
  const r = run([
    'task-expand',
    '--task-id', '1',
    '--subtasks', '/nonexistent/subtasks.json',
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_SUBTASKS_FILE/);
});

test('task-expand: ERR_TAG_NOT_FOUND when tag absent', () => {
  const dir = tmpProject();
  const subtasksFile = path.join(dir, 'subs.json');
  fs.writeFileSync(subtasksFile, JSON.stringify([{ title: 'Sub' }]));
  const r = run([
    'task-expand',
    '--task-id', '1',
    '--subtasks', subtasksFile,
    '--tag', 'ghost-tag',
  ], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_TAG_NOT_FOUND/);
});

test('task-expand: ERR_TASK_NOT_FOUND when parent absent', () => {
  const dir = tmpProject();
  seedState(dir, 'default');
  run(['task-add', '--tag', 'default', '--title', 'A task'], dir);
  const subtasksFile = path.join(dir, 'subs.json');
  fs.writeFileSync(subtasksFile, JSON.stringify([{ title: 'Sub' }]));
  const r = run([
    'task-expand',
    '--task-id', '999',
    '--subtasks', subtasksFile,
    '--tag', 'default',
  ], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /ERR_TASK_NOT_FOUND/);
});

test('task-expand: missing --task-id returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const subtasksFile = path.join(dir, 'subs.json');
  fs.writeFileSync(subtasksFile, JSON.stringify([{ title: 'Sub' }]));
  const r = run(['task-expand', '--subtasks', subtasksFile, '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*task-id/i);
});

test('task-expand: missing --subtasks returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const r = run(['task-expand', '--task-id', '1', '--tag', 'default'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*subtasks/i);
});

test('task-expand: missing --tag returns err MISSING_ARG', () => {
  const dir = tmpProject();
  const subtasksFile = path.join(dir, 'subs.json');
  fs.writeFileSync(subtasksFile, JSON.stringify([{ title: 'Sub' }]));
  const r = run(['task-expand', '--task-id', '1', '--subtasks', subtasksFile], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG.*tag/i);
});

// -- E2E: task-use-tag → task-add → task-add-subtask → task-add-dep ---------

test('E2E: use-tag → add → add-subtask → add-dep persists state across CLI calls (FR-002, FR-005, FR-010)', () => {
  const dir = tmpProject();

  // 1. Set the current tag
  const useTagR = run(['task-use-tag', '--tag', 'e2e-feature'], dir);
  assert.equal(useTagR.ok, true, 'task-use-tag ok');

  // 2. Add two tasks (tag resolves from state.json because we do not pass --tag)
  const t1 = run(['task-add', '--tag', 'e2e-feature', '--title', 'Task One'], dir);
  assert.equal(t1.ok, true);
  assert.equal(t1.data.id, '1');
  const t2 = run(['task-add', '--tag', 'e2e-feature', '--title', 'Task Two'], dir);
  assert.equal(t2.ok, true);
  assert.equal(t2.data.id, '2');

  // 3. Add subtask to task 1
  const sub = run([
    'task-add-subtask',
    '--parent-id', '1',
    '--title', 'Subtask of Task One',
    '--tag', 'e2e-feature',
  ], dir);
  assert.equal(sub.ok, true, 'task-add-subtask ok');
  assert.equal(sub.data.id, '1.1', 'subtask id is 1.1');

  // 4. Add dependency: task 1 depends on task 2
  const dep = run([
    'task-add-dep',
    '--task-id', '1',
    '--dep-id', '2',
    '--tag', 'e2e-feature',
  ], dir);
  assert.equal(dep.ok, true, 'task-add-dep ok');

  // 5. Verify final state in tasks.json
  const tasksJson = JSON.parse(
    fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8')
  );
  const tag = tasksJson['e2e-feature'];
  assert.ok(tag, 'e2e-feature namespace exists');
  assert.equal(tag.tasks[0].subtasks.length, 1, 'task 1 has 1 subtask');
  assert.equal(tag.tasks[0].subtasks[0].id, '1.1', 'subtask id correct');
  assert.deepEqual(tag.tasks[0].dependencies, ['2'], 'task 1 depends on task 2');
});

// ---------------------------------------------------------------------------
// Shared-singleton isolation — the global .spec-flow/trace.json + STATE.md are
// an active-feature MIRROR shared by every concurrent session. A write that
// infers its scope from that mirror lands in whichever feature another session
// happened to build last, and nothing downstream can tell afterwards (TM task
// ids repeat across features, so the bogus entries look native). These cases
// pin the two rules that make that impossible: writes demand an explicit
// --feature, and every per-feature artifact has a durable copy to restore from.
// ---------------------------------------------------------------------------

test('trace-link: refuses to infer the feature from the shared trace.json mirror', () => {
  const dir = tmpProject();
  initProject(dir);
  // Simulate a concurrent session having flipped the mirror to ITS feature.
  fs.mkdirSync(path.join(dir, '.spec-flow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'other-session-feature', nodes: {}, links: [] }));

  const r = run(['trace-link', '--task', '1', '--files', 'src/A.java'], dir);
  assert.equal(r.ok, false, 'trace-link without --feature is refused');
  assert.match(r.error, /MISSING_ARG: --feature/);
  // The decisive assertion: the other session's store was NOT written to.
  const victim = path.join(dir, '.spec-flow', 'specs', 'other-session-feature', 'file-links.json');
  assert.equal(fs.existsSync(victim), false, "the mirror's feature must not receive our links");
});

test('trace-link: an explicit --feature still writes into that feature only', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(path.join(dir, '.spec-flow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'other-session-feature', nodes: {}, links: [] }));

  const r = run(['trace-link', '--task', '1', '--feature', 'mine', '--files', 'src/A.java'], dir);
  assert.equal(r.ok, true, 'explicit --feature ok');
  assert.equal(r.data.feature, 'mine');
  assert.ok(fs.existsSync(path.join(dir, '.spec-flow', 'specs', 'mine', 'file-links.json')));
  assert.equal(
    fs.existsSync(path.join(dir, '.spec-flow', 'specs', 'other-session-feature', 'file-links.json')),
    false, 'the mirror feature is untouched');
});

test('task-baseline: --apply refuses a mirror-inferred feature (dry-run may infer)', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(path.join(dir, '.spec-flow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'other-session-feature', nodes: {}, links: [] }));

  const r = run(['task-baseline', '--apply'], dir);
  assert.equal(r.ok, false, '--apply without --feature is refused');
  assert.match(r.error, /MISSING_ARG: --feature/);
});

test('state-update: writes a durable per-feature STATE.md, not just the mirror', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['state-update', '--feature', 'alpha', '--note', 'alpha position'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.perFeatureState, path.join('.spec-flow', 'specs', 'alpha', 'STATE.md'));
  const durable = path.join(dir, '.spec-flow', 'specs', 'alpha', 'STATE.md');
  assert.ok(fs.existsSync(durable), 'durable per-feature STATE.md written');
  assert.match(fs.readFileSync(durable, 'utf8'), /alpha position/);
});

test('state-update: a second feature reports switchedFrom and cannot erase the first', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['state-update', '--feature', 'alpha', '--note', 'alpha position'], dir);

  // A concurrent session updates ITS feature — this rewrites the shared mirror.
  const r = run(['state-update', '--feature', 'beta', '--note', 'beta position'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.switchedFrom, 'alpha', 'the displaced feature is reported, not silently dropped');

  // The mirror now shows beta...
  const mirror = fs.readFileSync(path.join(dir, '.spec-flow', 'STATE.md'), 'utf8');
  assert.match(mirror, /STATE — beta/);
  // ...but alpha's own position survived intact and is restorable.
  const alpha = fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'alpha', 'STATE.md'), 'utf8');
  assert.match(alpha, /STATE — alpha/);
  assert.match(alpha, /alpha position/, "alpha's durable state is untouched by beta's update");
});

test('state-update: switchedFrom is null when the mirror already holds this feature', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['state-update', '--feature', 'alpha'], dir);
  const r = run(['state-update', '--feature', 'alpha', '--note', 'again'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.switchedFrom, null, 'same feature is not a switch');
});

test('read commands report featureSource so a mirror-inferred answer is legible', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(path.join(dir, '.spec-flow', 'specs', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  fs.writeFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'CHECKLIST.yaml'),
    'tests:\n  - id: TC-001\n    name: smoke\n');

  const inferred = run(['checklist-status'], dir);
  assert.equal(inferred.ok, true);
  assert.equal(inferred.data.feature, 'demo');
  assert.equal(inferred.data.featureSource, 'mirror', 'inferred answers say so');

  const explicit = run(['checklist-status', '--feature', 'demo'], dir);
  assert.equal(explicit.data.featureSource, 'explicit');
});

// ---------------------------------------------------------------------------
// Ship marker — the Next Step ladder's terminal rung. `verified` used to be the
// last rung, so a feature that had already shipped kept being told to ship, and
// the session re-anchor hook repeated that instruction every turn with nothing on
// disk able to contradict it.
// ---------------------------------------------------------------------------

/** Give `feature` an SD, a filled CHECKLIST and a passing VERIFICATION. */
function shippableFeature(dir, feature) {
  const d = path.join(dir, '.spec-flow', 'specs', feature);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SD.md'), '# SD\n\nno todos here\n');
  fs.writeFileSync(path.join(d, 'CHECKLIST.yaml'), 'tests:\n  - id: TC-001\n    name: smoke\n');
  fs.writeFileSync(path.join(d, 'VERIFICATION.md'), '# VERIFICATION\n\nstatus: passed\n');
  const tmDir = path.join(dir, '.taskmaster', 'tasks');
  fs.mkdirSync(tmDir, { recursive: true });
  fs.writeFileSync(path.join(tmDir, 'tasks.json'),
    JSON.stringify({ [feature]: { tasks: [{ id: 1, title: 't1', status: 'done' }] } }));
}

test('state-update: a verified-but-unshipped feature is still told to ship', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  const r = run(['state-update', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.shipped, null);
  assert.match(r.data.nextStep, /ship: stage/);
});

test('state-update --shipped: records ship.json and the ladder stops asking', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  const r = run(['state-update', '--feature', 'demo', '--shipped', '--ref', 'abc1234'], dir);
  assert.equal(r.ok, true);
  assert.ok(r.data.shipped, 'ship recorded in the Result');
  assert.equal(r.data.shipped.ref, 'abc1234');
  assert.match(r.data.nextStep, /^Shipped/, 'terminal rung replaces the ship instruction');
  assert.doesNotMatch(r.data.nextStep, /ship: stage/);

  const marker = path.join(dir, '.spec-flow', 'specs', 'demo', 'ship.json');
  assert.ok(fs.existsSync(marker), 'ship.json written');
  assert.match(fs.readFileSync(path.join(dir, '.spec-flow', 'STATE.md'), 'utf8'), /- Shipped: /);
});

test('state-update: the ship marker survives later plain state-updates', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  run(['state-update', '--feature', 'demo', '--shipped', '--ref', 'abc1234'], dir);
  // A later update with no --shipped must not resurrect the ship instruction —
  // STATE.md is regenerated wholesale, which is exactly why the marker is its own file.
  const r = run(['state-update', '--feature', 'demo', '--note', 'routine refresh'], dir);
  assert.equal(r.ok, true);
  assert.match(r.data.nextStep, /^Shipped/);
  assert.equal(r.data.shipped.ref, 'abc1234', 'ref carried forward');
});

test('state-update --shipped: re-running keeps the original ship date', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  const first = run(['state-update', '--feature', 'demo', '--shipped'], dir);
  const again = run(['state-update', '--feature', 'demo', '--shipped'], dir);
  assert.equal(again.data.shipped.shippedAt, first.data.shipped.shippedAt,
    'a feature ships once; re-running does not rewrite that date');
});

test('state-update --shipped: refuses without an explicit --feature', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['state-update', '--shipped'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG: --feature/);
});

test('status-report: surfaces the ship marker', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  assert.equal(run(['status-report'], dir).data.shipped, null);
  run(['state-update', '--feature', 'demo', '--shipped', '--ref', 'deadbee'], dir);
  const after = run(['status-report'], dir);
  assert.equal(after.data.shipped.ref, 'deadbee');
});

// ---------------------------------------------------------------------------
// status-report: backlog summary + shipped next-step hint (SD backlog-registry
// FR-022..FR-024, §10.6; CONTEXT C-7/C-8). `/sf:status` renders status-report's
// JSON (commands/status.md) rather than a raw markdown "## Backlog" section —
// state-update's STATE.md is a different artifact — so the closest faithful
// equivalent of FR-022's "section with open count + top 3" is a pair of fields
// mirroring the existing bugsOpen/bugsOpenList and changesOpen/changesOpenList
// convention already in this same Result.
// ---------------------------------------------------------------------------

test('status-report: no backlog dir — output unchanged (FR-024 regression, captured before the backlog fields existed)', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  run(['state-update', '--feature', 'demo', '--shipped', '--ref', 'abc1234'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  // Pre-existing fields keep exactly the value they had before this feature —
  // in particular nextStep is NOT touched when there is nothing open to hint at.
  assert.match(r.data.nextStep, /ship: stage/, 'nextStep text unchanged when backlog has no open items');
  assert.doesNotMatch(r.data.nextStep, /backlog/i, 'no backlog mention when there is nothing open');
  // New fields report the empty state rather than being entirely absent — see
  // bugsOpen/changesOpen precedent (always-present counters, never omitted).
  assert.equal(r.data.backlogOpen, 0, 'no backlog/ dir -> 0 open items');
  assert.deepEqual(r.data.backlogOpenList, [], 'no backlog/ dir -> empty top list');
});

test('status-report: shipped feature + open backlog — nextStep hints the top-1 id + title (TC-006)', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  run(['state-update', '--feature', 'demo', '--shipped', '--ref', 'abc1234'], dir);

  run(['backlog-new', '--title', 'Improve error messages', '--priority', 'low'], dir);
  run(['backlog-new', '--title', 'Add dark mode toggle', '--priority', 'high'], dir);
  run(['backlog-new', '--title', 'Cache warm-up job', '--priority', 'medium'], dir);
  run(['backlog-new', '--title', 'Extra low item', '--priority', 'low'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.backlogOpen, 4, 'counts every open item, not just the top 3');
  assert.equal(r.data.backlogOpenList.length, 3, 'top 3 only, per backlog-list order');
  assert.equal(r.data.backlogOpenList[0].title, 'Add dark mode toggle', 'high priority sorts first');
  assert.match(r.data.nextStep, /Add dark mode toggle/, 'nextStep hint names the top-1 title');
  assert.match(r.data.nextStep, new RegExp(r.data.backlogOpenList[0].id), 'nextStep hint names the top-1 id');
});

test('status-report: open backlog is reported even before the feature ships, but nextStep gets no hint yet (CONTEXT C-8)', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo'); // NOT shipped — no state-update --shipped call
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));

  run(['backlog-new', '--title', 'Someday maybe', '--priority', 'high'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.shipped, null);
  assert.equal(r.data.backlogOpen, 1, 'still surfaced — the summary itself does not depend on shipped');
  assert.equal(r.data.backlogOpenList[0].title, 'Someday maybe');
  assert.doesNotMatch(r.data.nextStep, /Someday maybe/, 'hint only appended once the feature has shipped');
});

test('status-report: codeReview is null until the optional gate has actually run', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.codeReview, null, 'an un-run review is not a clean one');
  assert.match(r.data.nextStep, /ship: stage/);
});

test('status-report: an unaccepted blocking review outranks "go ship" in nextStep', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  run(['review-collect', '--feature', 'demo', '--findings',
    '{"findings":[{"severity":"critical","title":"refund double-spend","checkedAgainst":"FR-007"}]}'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.codeReview.status, 'blocking');
  assert.equal(r.data.codeReview.accepted, false);
  assert.equal(r.data.codeReview.counts.critical, 1);
  // The whole point of the gate: it must survive a context reset, not just the turn
  // that produced it.
  assert.match(r.data.nextStep, /Code review is BLOCKING/);
  assert.match(r.data.nextStep, /CODE-REVIEW\.md/);
});

test('status-report: a blocking review is surfaced even when the ladder is nowhere near the ship', () => {
  // REGRESSION (found by dogfooding on a real project): the warning used to live in
  // the "done + verified" branch only, so a feature with no tasks seeded reported
  // "seeds tasks" while an unaccepted blocking verdict sat on disk, unmentioned.
  const dir = tmpProject();
  initProject(dir);
  const d = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SD.md'), '# SD\n\nno todos here\n');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  run(['review-collect', '--feature', 'demo', '--findings',
    '{"findings":[{"severity":"critical","title":"x","checkedAgainst":"FR-001"}]}'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.tasks, null, 'no tasks seeded — the ladder exits long before the ship branch');
  assert.match(r.data.nextStep, /^Code review is BLOCKING/, 'the verdict leads, whatever the ladder said');
  assert.match(r.data.nextStep, /Then: /, 'and the ladder advice is kept, not discarded');
});

test('status-report: an accepted blocking review stops nagging', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  run(['review-collect', '--feature', 'demo', '--findings',
    '{"findings":[{"severity":"high","title":"x","checkedAgainst":"none"}]}'], dir);
  run(['review-accept', '--feature', 'demo', '--note', 'false positive, covered by TC-014'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.codeReview.status, 'blocking');
  assert.equal(r.data.codeReview.accepted, true);
  assert.doesNotMatch(r.data.nextStep, /Code review is BLOCKING/);
});

test('status-report: an advisory review never blocks the ship step', () => {
  const dir = tmpProject();
  initProject(dir);
  shippableFeature(dir, 'demo');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    JSON.stringify({ feature: 'demo', nodes: {}, links: [] }));
  run(['review-collect', '--feature', 'demo', '--findings',
    '{"findings":[{"severity":"medium","title":"duplicated parser"}]}'], dir);

  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.data.codeReview.status, 'advisory');
  assert.match(r.data.nextStep, /ship: stage/);
  assert.doesNotMatch(r.data.nextStep, /BLOCKING/);
});

test('trace-build: preserves the repo subset declared via trace-repos', () => {
  const dir = tmpProject();
  initProject(dir);
  // Declare config.repos so trace-repos accepts the names.
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.repos = { 'svc-a': '../svc-a', 'svc-b': '../svc-b' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), '# SD\n\n| ID | Requirement | Priority |\n| --- | --- | --- |\n| FR-001 | do a thing | Must |\n');

  const set = run(['trace-repos', '--feature', 'demo', '--set', 'svc-b'], dir);
  assert.equal(set.ok, true);
  // A rebuild used to construct a fresh trace object and drop `repos` — declared
  // intent that nothing in the SD can regenerate.
  const build = run(['trace-build', '--sd', path.join('.spec-flow', 'specs', 'demo', 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(build.ok, true);
  const after = run(['trace-repos', '--feature', 'demo'], dir);
  assert.deepEqual(after.data.repos, ['svc-b'], 'declared repo subset survives trace-build');
});

// ---------------------------------------------------------------------------
// Mixed-toolchain hub: Gradle services + one Maven gateway
// ---------------------------------------------------------------------------

/** Executable launcher stub that echoes its args and exits 0 (hermetic build tool). */
function writeLauncher(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\necho "RAN $0 $@"\nexit 0\n');
  fs.chmodSync(p, 0o755);
}

/** hub/ + a Gradle service + a Maven gateway, each with a working launcher stub. */
function mixedHub(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  const gsvc = path.join(root, 'wallet-ms');
  const msvc = path.join(root, 'eid-gateway');
  fs.mkdirSync(path.join(gsvc, 'src'), { recursive: true });
  fs.mkdirSync(path.join(msvc, 'src'), { recursive: true });
  fs.writeFileSync(path.join(gsvc, 'build.gradle'), '');
  writeLauncher(gsvc, 'gradlew');
  fs.writeFileSync(path.join(msvc, 'pom.xml'), '<project/>');
  writeLauncher(msvc, 'mvnw');
  // doctor's repo checks require a real git working tree before it looks at build fit.
  for (const d of [gsvc, msvc]) {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  }
  run(['init-project', '--stack', 'java-spring', '--repos', 'wallet-ms=../wallet-ms,eid-gateway=../eid-gateway'], hub);
  const cfgPath = path.join(hub, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify.testCommand = './gradlew test';
  cfg.verify.coverageThreshold = null;
  cfg.verify.coverageCommand = null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return { root, hub, gsvc, msvc, cfgPath };
}

test('verify-code: a Maven repo in a Gradle hub is auto-resolved instead of failing on a missing gradlew', () => {
  // Pre-fix: config.verify.testCommand "./gradlew test" ran in eid-gateway too →
  // "No such file" → the gate failed for a reason that had nothing to do with the code.
  const { hub } = mixedHub('sf-mixed-');
  const r = run(['verify-code'], hub);
  assert.equal(r.ok, true);
  const gTests = r.data.checks.find((c) => c.name === '[wallet-ms] tests');
  const mTests = r.data.checks.find((c) => c.name === '[eid-gateway] tests');
  assert.equal(gTests.status, 'ok', 'gradle service unaffected');
  assert.match(gTests.detail, /\.\/gradlew test/);
  assert.equal(mTests.status, 'ok', 'maven gateway resolved to its own launcher');
  assert.match(mTests.detail, /\.\/mvnw -q test/);
  assert.match(mTests.detail, /auto-detected java-maven in eid-gateway/, 'never runs a different command silently');
  assert.ok(Array.isArray(r.data.repoResolution) && r.data.repoResolution.length === 1,
    'the swap is reported at the top level too');
  assert.equal(r.data.gate, 'pass');
});

test('verify-code: per-repo override in config.repos beats both the project verify block and detection', () => {
  const { hub, cfgPath } = mixedHub('sf-mixed-ovr-');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.repos['eid-gateway'] = {
    path: '../eid-gateway',
    stack: 'java-maven',
    verify: { testCommand: './mvnw -q verify' },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = run(['verify-code'], hub);
  const mTests = r.data.checks.find((c) => c.name === '[eid-gateway] tests');
  assert.equal(mTests.status, 'ok');
  assert.match(mTests.detail, /\.\/mvnw -q verify/, 'the explicit override ran');
  assert.ok(!r.data.repoResolution, 'explicit config → nothing auto-detected');
});

test('verify-code: scoped test filter follows the ROOT stack (-Dtest= for Maven, --tests for Gradle)', () => {
  // The filter flag is Gradle-only syntax; a Maven root scoped with --tests dies on
  // an unknown option. Each root must build its filter from its own stack.
  const { hub } = mixedHub('sf-mixed-scope-');
  const files = [
    'wallet-ms/src/test/java/com/w/WalletTest.java',
    'eid-gateway/src/test/java/com/g/GatewayTest.java',
  ].join(',');
  const r = run(['verify-code', '--files', files], hub);
  const gTests = r.data.checks.find((c) => c.name === '[wallet-ms] tests');
  const mTests = r.data.checks.find((c) => c.name === '[eid-gateway] tests');
  assert.match(gTests.detail, /--tests "com\.w\.WalletTest"/);
  assert.match(mTests.detail, /-Dtest=com\.g\.GatewayTest/);
  assert.ok(!/--tests/.test(mTests.detail), 'no Gradle syntax leaks into the Maven root');
  assert.equal(r.data.testsScoped, true);
});

test('doctor: warns when a configured repo cannot run the project testCommand, with the pin to apply', () => {
  const { hub } = mixedHub('sf-mixed-doctor-');
  const r = run(['doctor'], hub);
  assert.equal(r.ok, true);
  const repoChecks = r.data.checks.filter((c) => c.name === 'repos');
  const gw = repoChecks.find((c) => /eid-gateway/.test(c.detail));
  assert.equal(gw.status, 'warn', 'a mixed-toolchain hub must not read as all-green');
  assert.match(gw.fix, /"stack": "java-maven"/);
  assert.match(gw.fix, /mvnw -q test/);
  const wallet = repoChecks.find((c) => /wallet-ms/.test(c.detail));
  assert.equal(wallet.status, 'ok', 'the matching repo stays green');
});

test('detect-auth.sh: classifies a config.repos OBJECT-form entry, not "[object Object]"', () => {
  // Regression: the multi-repo branch built its repo list with `n + "\t" + p`,
  // string-concatenating `p` straight from config.repos["x"]. That works for the
  // plain-string form but the 0.8.9 object form ({ path, stack, verify }) stringifies
  // to the literal text "[object Object]" — a path that never exists, so the entry
  // silently fell into the "does not exist; skipped" branch and detection fell
  // through to classifying the HUB (which has no service code) instead of the repo.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-auth-objrepo-'));
  const hub = path.join(root, 'hub');
  const svc = path.join(root, 'svc');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(path.join(svc, 'src'), { recursive: true });
  fs.writeFileSync(path.join(svc, 'package.json'), JSON.stringify({ name: 'svc', dependencies: { jsonwebtoken: '^9.0.0' } }));
  fs.mkdirSync(path.join(hub, '.spec-flow'), { recursive: true });
  fs.writeFileSync(path.join(hub, '.spec-flow', 'config.json'), JSON.stringify({
    repos: { svc: { path: '../svc', stack: 'node', verify: { testCommand: 'npm test' } } },
  }));
  const script = path.join(__dirname, '..', 'skills', 'manual-test', 'scripts', 'detect-auth.sh');
  const out = execFileSync(script, [hub], { encoding: 'utf8' });
  assert.equal(out.trim(), 'jwt-basic', 'object-form repo is classified by its own package.json, not skipped');
});

test('REGRESSION detect-auth.sh: a custom HMAC/signature scheme is "unknown", not "no-auth"', () => {
  // Pre-fix: java-spring with no Spring Security dep and no Authorization: Bearer
  // pattern fell straight to "no-auth" — a service that verifies an HMAC request
  // signature (a real access-control check) got scaffolded as if it needed none.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-auth-hmac-'));
  fs.mkdirSync(path.join(root, 'src', 'main', 'java'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build.gradle'), [
    "plugins { id 'org.springframework.boot' version '3.2.0' }",
    'dependencies { implementation "org.springframework.boot:spring-boot-starter-web" }',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'SigFilter.java'), [
    'public class SigFilter {',
    '  void verify(String header) {',
    '    javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");',
    '  }',
    '}',
  ].join('\n'));
  const script = path.join(__dirname, '..', 'skills', 'manual-test', 'scripts', 'detect-auth.sh');
  const out = execFileSync(script, [root], { encoding: 'utf8' });
  assert.equal(out.trim(), 'unknown', 'HMAC signature evidence prevents the false "no-auth" default');
});

test('REGRESSION lint-checklist.sh: flags a dict `expect:` on a SQL verify/setup/teardown step', () => {
  // A dict expect on a SQL step is NEVER asserted (db-query.sh -t has no column
  // headers) — checklist_lib.sql.check_scalar returns None (descriptive only), so
  // a multi-column dict looked like the natural way to assert several columns but
  // silently asserted nothing. Catch it before the run, not after a false pass.
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'CHECKLIST.yaml'), [
    'config:',
    '  base_url: "http://localhost:8080"',
    'tokens:',
    '  user_token:',
    '    bearer: "${TOKEN}"',
    'suites:',
    '  - id: suite-1',
    '    name: "Test"',
    '    tags: [smoke]',
    '    tests:',
    '      - id: TC-001',
    '        name: "Test row"',
    '        tags: [smoke]',
    '        request:',
    '          method: GET',
    '          path: /api/v1/x',
    '          token: user_token',
    '        expect:',
    '          status: 200',
    '        verify:',
    '          - sql: "SELECT col1, col2 FROM t WHERE id = 1"',
    '            expect:',
    '              col1: 5',
    '              col2: "y"',
    '',
  ].join('\n'));
  const script = path.join(__dirname, '..', 'skills', 'manual-test', 'scripts', 'lint-checklist.sh');
  let threw = null;
  try {
    execFileSync(script, [path.join(dir, 'CHECKLIST.yaml')], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'lint-checklist.sh exits non-zero on a dict expect over a SQL step');
  assert.match(String(threw.stderr), /dict expect on a SQL step is never asserted/);
});

test('lint-checklist.sh: accepts a valid http setup expect_status and flags a malformed one', () => {
  const lint = (stepYaml) => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'CHECKLIST.yaml'), [
      'config:', '  base_url: "http://localhost:8080"',
      'suites:', '  - id: suite-1', '    name: "Test"', '    tags: [smoke]', '    tests:',
      '      - id: TC-001', '        name: "Test row"', '        tags: [smoke]',
      '        setup:', stepYaml,
      '        request:', '          method: GET', '          path: /api/v1/x',
      '        expect:', '          status: 200', '          body_contains: ok', '',
    ].join('\n'));
    const script = path.join(__dirname, '..', 'skills', 'manual-test', 'scripts', 'lint-checklist.sh');
    try {
      execFileSync(script, [path.join(dir, 'CHECKLIST.yaml')], { encoding: 'utf8', stdio: 'pipe' });
      return null;
    } catch (e) { return e; }
  };
  for (const ok of [
    '          - http: {method: POST, path: /login, expect_status: 401}',
    '          - http: {method: POST, path: /login, expect_status: [400, 401]}',
    '          - http: {method: POST, path: /login}\n            expect_status: any',
  ]) {
    assert.equal(lint(ok), null, `should lint clean: ${ok}`);
  }
  const bad = lint('          - http: {method: POST, path: /login, expect_status: banana}');
  assert.ok(bad, 'a malformed expect_status exits non-zero');
  assert.match(String(bad.stderr) + String(bad.stdout), /expect_status: invalid value 'banana'/);
});

test('REGRESSION sd-skeleton: merges ALL FR-prefix tables, not just the first', () => {
  // Pre-fix: `tableByIdPrefix` used tables.find() — an SRS whose FRs are split into
  // several sub-tables (one per module, a common real shape) harvested only the
  // FIRST table's rows and silently dropped the rest (26 FRs across 4 tables → 6).
  const dir = tmpProject();
  initProject(dir);
  const srs = path.join(dir, 'srs.md');
  fs.writeFileSync(srs, [
    'Feature: multi-fr-demo',
    '',
    '## 5. Yeu cau chuc nang module A',
    '',
    '| Ma | Yeu cau | Muc do |',
    '| --- | --- | --- |',
    '| FR-1 | req A1 | Must |',
    '| FR-2 | req A2 | Must |',
    '',
    '## 6. Yeu cau chuc nang module B',
    '',
    '| Ma | Yeu cau | Muc do |',
    '| --- | --- | --- |',
    '| FR-3 | req B1 | Must |',
    '| FR-4 | req B2 | Must |',
    '| FR-5 | req B3 | Must |',
    '',
  ].join('\n'));
  const r = run(['sd-skeleton', '--srs', srs, '--feature', 'multi-fr-demo', '--dry-run'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.stats.fr, 5, 'all 5 FR rows across both sub-tables harvested (was 2 — first table only)');
});

test('REGRESSION checklist-gen: stdout is pure JSON even when the caller merges stderr (2>&1)', () => {
  // Pre-fix: execFileSync's default stdio INHERITS the child's (detect-auth.sh)
  // stderr straight into this process's own stderr. Any caller that merges stdout+
  // stderr (2>&1, a tool wrapper capturing combined output) saw detect-auth.sh's
  // diagnostic prose land BEFORE the JSON line and failed to parse it as JSON, even
  // though the command had already succeeded and written the checklist file.
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo', '',
    '## 5.1 Functional Requirements', '',
    '| ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Do the thing | Must | US-1 |', '',
    '## 13.2 Test Cases', '',
    '| TC ID | Flow | Test Case | Expected Result | FR |',
    '| --- | --- | --- | --- | --- |',
    '| TC-001 | Happy path | Do the thing | 200 OK | FR-001 |', '',
  ].join('\n'));
  const { execSync } = require('node:child_process');
  // Actually merge stdout+stderr the way a naive caller (2>&1 / a wrapper that
  // captures combined output) would — execFileSync alone never mixes the two.
  const out = execSync(
    `node ${JSON.stringify(ENGINE)} checklist-gen --sd ${JSON.stringify(path.join(sdDir, 'SD.md'))} --feature demo 2>&1`,
    { cwd: dir, encoding: 'utf8' },
  );
  const lines = out.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one line of output — no stray diagnostic prose');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, true);
});

test('verify-code: multi-repo with no declared scope warns to run trace-repos', () => {
  const dir = tmpProject();
  initProject(dir);
  // Two sibling repos configured, but the feature never declared which it targets and
  // its file-links hold BARE paths (no --repo prefix), so neither scoping signal fires.
  // Old behaviour: silently scan every configured repo — on a 16-repo hub that is 64
  // check rows, most of them failures from repos the feature never touched, with
  // scope:null and no hint at all. Found by dogfooding on a real 16-repo project.
  for (const r of ['svc-a', 'svc-b']) {
    fs.mkdirSync(path.join(dir, '..', path.basename(dir) + '-' + r, 'src'), { recursive: true });
  }
  const cfgP = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
  cfg.repos = {
    'svc-a': path.join('..', path.basename(dir) + '-svc-a'),
    'svc-b': path.join('..', path.basename(dir) + '-svc-b'),
  };
  fs.writeFileSync(cfgP, JSON.stringify(cfg));
  fs.mkdirSync(path.join(dir, '.spec-flow', 'specs', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'file-links.json'),
    JSON.stringify({ links: [{ task: '1', fr: 'FR-001', file: 'src/bare.js' }] }));
  const r = run(['verify-code', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.ok((r.data.scopeWarnings || []).some(w => /trace-repos/.test(w)),
    'must name trace-repos --set as the fix, not silently scan every repo');
});

test('status-report: `status: passed` must be read from the STATUS LINE, not anywhere in the file', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  // The ship gate (G3) is "do not ship unless VERIFICATION reads status: passed".
  // A substring test over the whole file lets that gate be opened by a document
  // that FORBIDS shipping, as long as the phrase appears anywhere in the prose --
  // e.g. a correction note explaining that a false `status: passed` was replaced.
  fs.writeFileSync(path.join(sdDir, 'VERIFICATION.md'), [
    '# VERIFICATION — demo',
    '',
    'status: failed',
    '',
    '> Do NOT ship. 12 regression tests are red. This must not be recorded as `status: passed`.',
  ].join('\n'));
  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.verified, false,
    'a file whose status line says failed must never read as verified');
});

test('status-report: verified-adhoc on the status line counts as verified', () => {
  const dir = tmpProject();
  initProject(dir);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  // /sf:phase close-out step 4 accepts `verified-adhoc` for an out-of-loop live
  // verify, so the gate must recognise it — anchoring on "passed" alone would
  // silently reject every ad-hoc verified feature.
  fs.writeFileSync(path.join(sdDir, 'VERIFICATION.md'),
    '# VERIFICATION — demo\n\nstatus: verified-adhoc\n\n- TC-001: verified\n');
  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.verified, true, 'verified-adhoc is a shippable status');
});

test('state-update: shipped "nothing pending" nextStep names the top open backlog item (FR-023), unchanged without one (FR-024)', () => {
  const dir = tmpProject();
  initProject(dir);
  const fDir = path.join(dir, '.spec-flow', 'specs', 'feat-s');
  fs.mkdirSync(fDir, { recursive: true });
  fs.writeFileSync(path.join(fDir, 'SD.md'), '# SD: feat-s\n');
  fs.writeFileSync(path.join(fDir, 'CHECKLIST.yaml'), 'suites: []\n');
  let r = run(['task-add', '--tag', 'feat-s', '--title', 'Only task'], dir);
  assert.equal(r.ok, true);
  r = run(['task-set-status', '--tag', 'feat-s', '--id', r.data.id, '--status', 'done'], dir);
  assert.equal(r.ok, true);

  r = run(['state-update', '--feature', 'feat-s', '--shipped'], dir);
  assert.equal(r.ok, true);
  assert.match(r.data.nextStep, /nothing pending/);
  const before = r.data.nextStep;
  assert.ok(!/Backlog:/.test(before), 'no backlog dir → nextStep unchanged');

  run(['backlog-new', '--title', 'Low thing', '--priority', 'low'], dir);
  run(['backlog-new', '--title', 'Urgent thing', '--priority', 'high'], dir);
  r = run(['state-update', '--feature', 'feat-s'], dir);
  assert.equal(r.ok, true);
  assert.ok(r.data.nextStep.startsWith(before), 'hint is appended, original text kept');
  assert.match(r.data.nextStep, /Backlog: 2 open — top: bl-002 "Urgent thing"/);
});
