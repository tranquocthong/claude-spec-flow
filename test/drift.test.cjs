/**
 * Unit tests for lib/drift.cjs — the Layer-2 semantic drift-check (SD §12.2 error codes
 * vs the executor's implementation logs in tasks.json). Direct-require, chdir-to-tmp
 * (the command reads .spec-flow/ + .taskmaster/ relative to cwd).
 *
 * Run:  node --test test/drift.test.cjs   (or: node --test test/*.test.cjs)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const drift = require('../lib/drift.cjs');

function inTmp(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-drift-'));
  try { process.chdir(dir); return fn(dir); }
  finally { process.chdir(prev); }
}

function writeTrace(errors) {
  fs.mkdirSync('.spec-flow/specs/demo', { recursive: true });
  const trace = { feature: 'demo', nodes: { errors } };
  fs.writeFileSync('.spec-flow/specs/demo/trace.json', JSON.stringify(trace));
  fs.writeFileSync('.spec-flow/trace.json', JSON.stringify(trace));
}
function writeTasks(detailsArr) {
  fs.mkdirSync('.taskmaster/tasks', { recursive: true });
  const tasks = detailsArr.map((d, i) => ({ id: i + 1, title: 't' + i, details: d }));
  fs.writeFileSync('.taskmaster/tasks/tasks.json', JSON.stringify({ demo: { tasks } }));
}

test('drift-check: NO_TRACE before trace-build', () => {
  inTmp(() => {
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.ok, false);
    assert.match(r.error, /NO_TRACE/);
  });
});

test('drift-check: no logs yet → clean + note (no false positives)', () => {
  inTmp(() => {
    writeTrace([{ code: 'ERR_FOO_001', http: '422' }]);
    writeTasks([]);
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.ok, true);
    assert.equal(r.data.clean, true, 'absent logs must not flag every SD code as drift');
    assert.match(r.data.note, /no task implementation logs/);
  });
});

test('drift-check: flags spec-not-evidenced + impl-not-specced error codes', () => {
  inTmp(() => {
    writeTrace([{ code: 'ERR_FOO_001', http: '422' }, { code: 'ERR_BAR_002', http: '404' }]);
    // Log mentions FOO (evidenced) and BAZ (not in SD), but never BAR (spec-not-evidenced).
    writeTasks(['login done; returns ERR_FOO_001 on bad creds; added ERR_BAZ_003 for lockout']);
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.ok, true);
    assert.equal(r.data.clean, false);
    assert.ok(r.data.evidencedErrorCodes.includes('ERR_FOO_001'), 'FOO evidenced in logs');
    const byCode = Object.fromEntries(r.data.drift.map((d) => [d.code, d.type]));
    assert.equal(byCode['ERR_BAR_002'], 'spec-not-evidenced', 'SD code with no log mention');
    assert.equal(byCode['ERR_BAZ_003'], 'impl-not-specced', 'logged code not in SD §12.2');
  });
});

test('drift-check: all SD codes evidenced → clean', () => {
  inTmp(() => {
    writeTrace([{ code: 'ERR_FOO_001', http: '422' }]);
    writeTasks(['handled error ERR_FOO_001 as specified']);
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.data.clean, true);
    assert.deepEqual(r.data.drift, []);
  });
});
