/**
 * Unit tests for lib/maintenance.cjs — the static, non-workflow commands
 * (init, init-project, learn, doctor). These require the module DIRECTLY and call
 * the command functions in a throwaway cwd (the commands resolve .spec-flow relative
 * to process.cwd()). Complements the CLI integration tests in flow-tools.test.cjs.
 *
 * Run:  node --test test/maintenance.test.cjs   (or: node --test test/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const maintenance = require('../lib/maintenance.cjs');

/** Run fn() with cwd set to a fresh temp dir, always restoring cwd afterward. */
function inTmp(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-maint-'));
  try { process.chdir(dir); return fn(dir); }
  finally { process.chdir(prev); }
}

test('init: returns paths + config + traceExists, and seeds .spec-flow', () => {
  inTmp(() => {
    const r = maintenance.init();
    assert.equal(r.ok, true);
    assert.ok(r.data.paths && r.data.paths.stateDir === '.spec-flow');
    assert.equal(r.data.traceExists, false);
  });
});

test('init-project: explicit --stack wins and seeds the matching verify preset', () => {
  inTmp(() => {
    const r = maintenance['init-project']({ stack: 'node' });
    assert.equal(r.ok, true);
    assert.equal(r.data.verifyPreset.stack, 'node');
    assert.equal(r.data.verifyPreset.preset.testCommand, 'npm test');
    assert.ok(fs.existsSync('.spec-flow/config.json'));
  });
});

test('init-project: auto-detects java-spring from build.gradle when --stack omitted (#3)', () => {
  inTmp(() => {
    fs.writeFileSync('build.gradle', 'plugins { id "java" }\n');
    const r = maintenance['init-project']({});
    assert.equal(r.data.verifyPreset.stack, 'java-spring');
    assert.equal(r.data.verifyPreset.preset.testCommand, './gradlew test');
  });
});

test('init-project: auto-detects java-maven from pom.xml (mvn, not gradle) (#3)', () => {
  inTmp(() => {
    fs.writeFileSync('pom.xml', '<project></project>\n');
    const r = maintenance['init-project']({});
    assert.equal(r.data.verifyPreset.stack, 'java-maven');
    assert.match(r.data.verifyPreset.preset.testCommand, /^mvn /);
  });
});

test('init-project: seeds config.models (sdAuthor inherits, hybridExecutor pinned to sonnet)', () => {
  inTmp(() => {
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models, { sdAuthor: null, hybridExecutor: 'sonnet' });
  });
});

test('init-project: patches config.models into a pre-existing config.json missing it', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({ project: 'p', stack: 'node' }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models, { sdAuthor: null, hybridExecutor: 'sonnet' });
  });
});

test('init-project: no build markers → unknown (empty verify, no false gate)', () => {
  inTmp(() => {
    const r = maintenance['init-project']({});
    assert.equal(r.data.verifyPreset.stack, 'unknown');
    assert.equal(r.data.verifyPreset.preset.testCommand, null);
  });
});

test('learn: requires --note', () => {
  inTmp(() => {
    const r = maintenance.learn({});
    assert.equal(r.ok, false);
    assert.match(r.error, /MISSING_ARG/);
  });
});

test('learn: appends the rule to project-author.md', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const r = maintenance.learn({ note: 'always assert the error body on rejection tests' });
    assert.equal(r.ok, true);
    const txt = fs.readFileSync('.spec-flow/project-author.md', 'utf8');
    assert.match(txt, /always assert the error body/);
  });
});

test('doctor: always returns ok with a checks array (reports, never throws)', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const r = maintenance.doctor({});
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data.checks));
    assert.ok(r.data.summary && typeof r.data.summary === 'object');
  });
});
