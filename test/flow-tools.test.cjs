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
// TDD RED-phase gate: verify-code --expect fail (v0.5.2)
// ---------------------------------------------------------------------------

test('verify-code --expect fail: failing test → gate "red-confirmed"', () => {
  const dir = tmpProject();
  initProject(dir);
  // Override verify block: testCommand always exits non-zero (simulates a failing test)
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify = { testCommand: 'exit 1', coverageThreshold: null, forbiddenPatterns: [], secretScan: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = run(['verify-code', '--expect', 'fail'], dir);
  assert.equal(r.ok, true, 'never throws');
  assert.equal(r.data.gate, 'red-confirmed', 'failing tests confirm RED');
  const testCheck = r.data.checks.find(c => c.name === 'tests');
  assert.equal(testCheck.status, 'ok', 'test check is ok when RED confirmed');
  assert.match(testCheck.detail, /RED confirmed/);
  // coverage / forbidden-patterns / secret-scan must be skipped in RED-phase
  ['coverage', 'forbidden-patterns', 'secret-scan'].forEach(n => {
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
  const r = run(['verify-collect', '--results', results], dir);
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
  const r = run(['verify-collect', '--results', results], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /NO_JSON_RESULTS/);
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
  // fr-task link must exist in the trace.
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'trace.json'), 'utf8'));
  assert.ok(trace.links.some(l => l.type === 'fr-task' && l.from === 'FR-001' && l.to === '7'), 'fr-task link emitted');

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

test('#4 status-report: surfaces declared live gaps from VERIFICATION.md', () => {
  // verified-adhoc ship with "not verified live" items must be VISIBLE in /sf:status,
  // not buried in prose. status-report extracts bullets under a gaps heading.
  const dir = tmpProject();
  initProject(dir);
  // Minimal feature surface so featureName resolves + a VERIFICATION with a gaps section.
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), '# SD: demo\n');
  fs.writeFileSync(path.join(dir, '.spec-flow', 'VERIFICATION.md'), [
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
  const r = run(['status-report', '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.verifiedGaps.length, 2, 'two live gaps extracted (Notes section excluded)');
  assert.match(r.data.verifiedGaps[0], /webhook delivery/);
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
