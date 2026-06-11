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

test('multi-repo trace-link --repo qualifies the stored path', () => {
  const dir = tmpProject();
  run(['init-project', '--repos', 'svc-a=../svc-a'], dir);
  const r = run(['trace-link', '--task', '1', '--feature', 'demo', '--repo', 'svc-a', '--files', 'src/A.java'], dir);
  assert.equal(r.ok, true);
  const links = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'file-links.json'), 'utf8'));
  assert.equal(links.links[0].file, 'svc-a/src/A.java', 'path is repo-qualified, not bare src/A.java');
});
