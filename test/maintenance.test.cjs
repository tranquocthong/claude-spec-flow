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

test('init-project: seeds config.models (sdAuthor inherits, hybridExecutor pinned to sonnet, taskmaster seeded)', () => {
  inTmp(() => {
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models, { sdAuthor: null, hybridExecutor: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } });
  });
});

test('init-project: patches config.models into a pre-existing config.json missing it (includes taskmaster)', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({ project: 'p', stack: 'node' }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models, { sdAuthor: null, hybridExecutor: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } });
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

// mcp-shadow: a project-level .mcp.json "task-master-ai" entry overrides the plugin's
// bundled native server. A legacy/core-tier entry there exposes no add_task — doctor must warn.
test('doctor: warns when a project .mcp.json shadows the bundled task engine with a legacy entry', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    fs.writeFileSync('.mcp.json', JSON.stringify({
      mcpServers: {
        'task-master-ai': {
          command: 'npx',
          args: ['-y', 'task-master-ai'],
          env: { TASK_MASTER_TOOLS: 'core' },
        },
      },
    }));
    const shadow = maintenance.doctor({}).data.checks.find(c => c.name === 'mcp-shadow');
    assert.ok(shadow, 'mcp-shadow check must be present');
    assert.equal(shadow.status, 'warn');
    assert.match(shadow.detail, /add_task/);
    assert.match(shadow.fix, /task-add/);
  });
});

test('doctor: mcp-shadow is ok when the project .mcp.json binds the native server or has no TM entry', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });

    fs.writeFileSync('.mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const noEntry = maintenance.doctor({}).data.checks.find(c => c.name === 'mcp-shadow');
    assert.equal(noEntry.status, 'ok');

    fs.writeFileSync('.mcp.json', JSON.stringify({
      mcpServers: { 'task-master-ai': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/mcp-server.js'] } },
    }));
    const native = maintenance.doctor({}).data.checks.find(c => c.name === 'mcp-shadow');
    assert.equal(native.status, 'ok');
    assert.match(native.detail, /native task engine/);
  });
});

// TC-007: fresh project seeds models.taskmaster: {main, research} — no fallback key (FR-009, FR-011)
test('init-project: seeds models.taskmaster {main,research} on fresh project — no fallback key (TC-007)', () => {
  inTmp(() => {
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models.taskmaster, { main: 'sonnet', research: 'sonnet' });
    assert.strictEqual(cfg.models.taskmaster.fallback, undefined);
  });
});

// TC-008: existing config missing models.taskmaster block — patched in, sdAuthor/hybridExecutor unchanged (FR-010)
test('init-project: patches models.taskmaster into existing config missing the block — others unchanged (TC-008)', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({
      project: 'p',
      models: { sdAuthor: null, hybridExecutor: 'sonnet' },
    }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models.taskmaster, { main: 'sonnet', research: 'sonnet' });
    assert.strictEqual(cfg.models.sdAuthor, null);
    assert.strictEqual(cfg.models.hybridExecutor, 'sonnet');
  });
});

// TC-009: existing config already has models.taskmaster with custom values — left exactly as-is (FR-010 idempotent)
test('init-project: leaves models.taskmaster untouched when already present with custom values (TC-009)', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({
      project: 'p',
      models: { sdAuthor: null, hybridExecutor: 'sonnet', taskmaster: { main: 'opus', research: 'sonnet' } },
    }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models.taskmaster, { main: 'opus', research: 'sonnet' });
  });
});

// ---------------------------------------------------------------------------
// doctor / current-tag drift (W3)
//
// Regression guard for the false-GREEN that shipped with the original heuristic:
// it never opened .taskmaster/state.json, it only inspected the tasks.json key
// list. A feature that had not been through parse-prd yet owns no tag, so the
// check fell through to its `else` and reported "TM tag aligned" while the real
// currentTag still pointed at a prior feature — precisely the ingest→phase
// window where doctor is run most.
// ---------------------------------------------------------------------------

/** Seed an active feature (.spec-flow/trace.json) + a TM state.json currentTag. */
function seedTagState(activeFeature, currentTag, tagsInTasksJson) {
  fs.mkdirSync('.spec-flow', { recursive: true });
  fs.writeFileSync('.spec-flow/trace.json', JSON.stringify({ feature: activeFeature }));
  fs.mkdirSync('.taskmaster/tasks', { recursive: true });
  if (currentTag !== null) {
    fs.writeFileSync('.taskmaster/state.json', JSON.stringify({ currentTag }));
  }
  const tasks = {};
  for (const t of (tagsInTasksJson || [])) tasks[t] = { tasks: [], metadata: {} };
  fs.writeFileSync('.taskmaster/tasks/tasks.json', JSON.stringify(tasks));
}

const currentTagCheck = () => maintenance.doctor({}).data.checks.find(c => c.name === 'current-tag');

test('doctor: warns on currentTag drift even when the active feature has no tag yet (pre-parse-prd)', () => {
  inTmp(() => {
    // ekyc is ingested (SD + trace) but not yet seeded, so tasks.json holds only
    // the prior feature's tag. The old heuristic reported ok here.
    seedTagState('user-re-ekyc-bo-history', 'wcm-vm-p11-face-verify', ['wcm-vm-p11-face-verify']);
    const c = currentTagCheck();
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /wcm-vm-p11-face-verify/);
    assert.match(c.detail, /user-re-ekyc-bo-history/);
    assert.match(c.fix, /use-tag user-re-ekyc-bo-history/);
  });
});

test('doctor: current-tag is ok when currentTag matches the active feature, even with other tags present', () => {
  inTmp(() => {
    // The old heuristic warned here purely because a second tag existed.
    seedTagState('feat-a', 'feat-a', ['master', 'feat-a', 'feat-b']);
    const c = currentTagCheck();
    assert.equal(c.status, 'ok');
    assert.equal(c.fix, null);
  });
});

test('doctor: warns when .taskmaster/state.json has no currentTag set', () => {
  inTmp(() => {
    seedTagState('feat-a', null, ['feat-a']);
    const c = currentTagCheck();
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /no currentTag set/);
  });
});

test('doctor: reports version-sync against the real plugin tree', () => {
  inTmp(() => {
    // The comparison itself is unit-tested in core.test.cjs (versionSyncStatus).
    // This pins the wiring: doctor emits the check, reading the actual
    // .claude-plugin/ files from PLUGIN_ROOT rather than the project cwd.
    const c = maintenance.doctor({}).data.checks.find(x => x.name === 'version-sync');
    assert.ok(c, 'doctor emits a version-sync check');
    assert.equal(c.status, 'ok', 'this repo ships plugin.json and marketplace.json in sync');
    assert.match(c.detail, /both at \d+\.\d+\.\d+/);
  });
});

test('doctor: current-tag does not nag about a SHIPPED feature', () => {
  inTmp(() => {
    // Drift is only a hazard while state ops can still land on the wrong tag.
    // Once the feature has shipped there are none left, and currentTag pointing
    // elsewhere is the correct end state — warning here trains the reader to
    // ignore the check. Surfaced by this repo's own post-ship doctor run.
    seedTagState('shipped-feature', 'some-other-tag', ['some-other-tag']);
    fs.mkdirSync('.spec-flow/specs/shipped-feature', { recursive: true });
    fs.writeFileSync('.spec-flow/specs/shipped-feature/ship.json',
      JSON.stringify({ feature: 'shipped-feature', shippedAt: '2026-08-27T00:00:00.000Z', ref: 'abc1234' }));
    const c = currentTagCheck();
    assert.equal(c.status, 'ok');
    assert.match(c.detail, /shipped 2026-08-27/);
  });
});

test('doctor: current-tag still warns for an UNshipped feature with the same setup', () => {
  inTmp(() => {
    seedTagState('shipped-feature', 'some-other-tag', ['some-other-tag']);
    const c = currentTagCheck();
    assert.equal(c.status, 'warn', 'the ship marker is what silences it, nothing else');
  });
});

test('doctor: current-tag check is skipped entirely when the project has no .taskmaster/', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/trace.json', JSON.stringify({ feature: 'feat-a' }));
    assert.equal(currentTagCheck(), undefined);
  });
});
