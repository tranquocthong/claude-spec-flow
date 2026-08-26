/**
 * Tests for hooks/sd-drift-detect.sh — the PreToolUse advisory that warns when the
 * file you are editing is linked to an untested FR or a review/blocked task.
 *
 * The hook used to read only the global .spec-flow/trace.json, which is an
 * active-feature MIRROR: with two features in play it graded whichever one another
 * session built last, so an edit inside feature A matched nothing while A's trace
 * sat right there on disk. It now scans every specs/<feature>/trace.json.
 *
 * Contract under test stays: advisory only — always exit 0, warnings on stderr.
 *
 * Run:  node --test test/sd-drift-hook.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hooks', 'sd-drift-detect.sh');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-drifthook-'));
}

/** Write a per-feature trace linking `file` to an FR that has no test case. */
function writeFeatureTrace(dir, feature, file, frId) {
  const d = path.join(dir, '.spec-flow', 'specs', feature);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'trace.json'), JSON.stringify({
    feature,
    nodes: { fr: [{ id: frId, text: `requirement for ${feature}` }], tasks: [] },
    links: [{ type: 'fr-file', from: frId, to: file }],   // no fr-tc → drift signal
  }));
}

/** Run the hook for an Edit of `file`; return { code, stderr }. */
function runHook(dir, file) {
  const ev = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } });
  const r = spawnSync('bash', [HOOK], { cwd: dir, input: ev, encoding: 'utf8' });
  return { code: r.status, stderr: (r.stderr || '') + (r.stdout || '') };
}

test('warns for the feature that owns the file even when the mirror points elsewhere', () => {
  const dir = tmpProject();
  writeFeatureTrace(dir, 'alpha', 'src/Alpha.java', 'FR-001');
  writeFeatureTrace(dir, 'beta', 'src/Beta.java', 'FR-002');
  // A concurrent session left the shared mirror pointing at beta.
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'),
    fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'beta', 'trace.json')));

  const r = runHook(dir, 'src/Alpha.java');
  assert.equal(r.code, 0, 'hook is advisory — always exit 0');
  assert.match(r.stderr, /FR-001/, "alpha's FR is found despite the mirror holding beta");
  assert.match(r.stderr, /alpha/, 'the owning feature is named in the warning');
  assert.doesNotMatch(r.stderr, /FR-002/, "beta's FR must not colour an alpha edit");
});

test('stays silent for a file no feature trace links', () => {
  const dir = tmpProject();
  writeFeatureTrace(dir, 'alpha', 'src/Alpha.java', 'FR-001');
  const r = runHook(dir, 'src/Unrelated.java');
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '', 'untracked file → no noise');
});

test('falls back to the global mirror for a project with no per-feature traces', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.spec-flow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spec-flow', 'trace.json'), JSON.stringify({
    feature: 'legacy',
    nodes: { fr: [{ id: 'FR-009', text: 'legacy requirement' }], tasks: [] },
    links: [{ type: 'fr-file', from: 'FR-009', to: 'src/Legacy.java' }],
  }));
  const r = runHook(dir, 'src/Legacy.java');
  assert.equal(r.code, 0);
  assert.match(r.stderr, /FR-009/, 'pre-per-feature projects keep working');
});

test('no .spec-flow directory → silent, exit 0', () => {
  const dir = tmpProject();
  const r = runHook(dir, 'src/Anything.java');
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '');
});
