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

const MODELS_DEFAULT = { sdAuthor: null, hybridExecutor: 'sonnet', codeReviewer: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } };

test('init-project: seeds config.models (sdAuthor inherits, hybridExecutor + codeReviewer pinned to sonnet, taskmaster seeded)', () => {
  inTmp(() => {
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models, MODELS_DEFAULT);
  });
});

test('init-project: patches config.models into a pre-existing config.json missing it (includes taskmaster)', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({ project: 'p', stack: 'node' }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.models, MODELS_DEFAULT);
  });
});

test('init-project: seeds phase.codeReview: off — the pre-ship gate is opt-in', () => {
  inTmp(() => {
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.deepEqual(cfg.phase, { confirmTasks: true, taskNotes: false, codeReview: 'off' });
  });
});

test('init-project: back-fills phase.codeReview + models.codeReviewer into an older config without touching set values', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({
      project: 'p',
      phase: { confirmTasks: false, taskNotes: true },
      models: { sdAuthor: 'opus', hybridExecutor: 'opus', taskmaster: { main: 'opus', research: 'opus' } },
    }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    // Back-filled, discoverable, and behaviour-neutral (absent already read as these).
    assert.equal(cfg.phase.codeReview, 'off');
    assert.equal(cfg.models.codeReviewer, 'sonnet');
    // Pre-existing choices survive the patch.
    assert.equal(cfg.phase.confirmTasks, false);
    assert.equal(cfg.phase.taskNotes, true);
    assert.equal(cfg.models.hybridExecutor, 'opus');
  });
});

test('init-project: an explicit phase.codeReview: off is never overwritten', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({ project: 'p', phase: { confirmTasks: true, taskNotes: false, codeReview: 'off' } }));
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.equal(cfg.phase.codeReview, 'off');
  });
});

test('init-project: no build markers → unknown (empty verify, no false gate)', () => {
  inTmp(() => {
    const r = maintenance['init-project']({});
    assert.equal(r.data.verifyPreset.stack, 'unknown');
    assert.equal(r.data.verifyPreset.preset.testCommand, null);
  });
});

test('init-project: fresh project-author.md has an empty ## Code Rules section with guidance (TC-022, FR-012)', () => {
  inTmp(() => {
    const r = maintenance['init-project']({ stack: 'node' });
    assert.ok(r.data.created.includes('.spec-flow/project-author.md'));
    const txt = fs.readFileSync('.spec-flow/project-author.md', 'utf8');
    assert.match(txt, /^## Code Rules$/m, 'heading must be exactly "## Code Rules" (D5 — parsed by executor/reviewer as an anchor)');
    // Guidance distinguishes machine-checkable (config.verify.rules) from judgment rules (bullets here).
    assert.match(txt, /config\.verify\.rules/);
    assert.match(txt, /pass|n\/a|violated/i);
  });
});

test('init-project: an existing project-author.md is never rewritten, even without ## Code Rules', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    const legacy = '# Project SD-authoring overrides\n\nNo Code Rules section here.\n';
    fs.writeFileSync('.spec-flow/project-author.md', legacy);
    const r = maintenance['init-project']({ stack: 'node' });
    assert.ok(r.data.alreadyExisted.includes('.spec-flow/project-author.md'));
    const txt = fs.readFileSync('.spec-flow/project-author.md', 'utf8');
    assert.equal(txt, legacy, 'init-project must not touch a pre-existing project-author.md');
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

// mcp-shadow: spec-flow ships no MCP server, so a project-level .mcp.json
// "task-master-ai" entry binds a separate implementation that writes the same
// .taskmaster/ files. Doctor must warn and point at the CLI twins.
test('doctor: warns when a project .mcp.json still declares task-master-ai', () => {
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
    assert.match(shadow.detail, /ships no MCP server/);
    assert.match(shadow.fix, /task-add/);
  });
});

test('doctor: mcp-shadow is ok when the project .mcp.json has no task-master-ai entry', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });

    fs.writeFileSync('.mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const noEntry = maintenance.doctor({}).data.checks.find(c => c.name === 'mcp-shadow');
    assert.equal(noEntry.status, 'ok');

    // Even the old "native" shape is now a stale binding: the plugin no longer
    // ships bin/mcp-server.js as a declared server, so pointing at it is not ok.
    fs.writeFileSync('.mcp.json', JSON.stringify({
      mcpServers: { 'task-master-ai': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/mcp-server.js'] } },
    }));
    const stale = maintenance.doctor({}).data.checks.find(c => c.name === 'mcp-shadow');
    assert.equal(stale.status, 'warn');
  });
});

// dep-lock: the engine is CLI-only now; the check must confirm the bins exist and
// that no .mcp.json has reappeared at the plugin root to re-expose an MCP surface.
test('doctor: dep-lock reports the CLI task engine with no MCP binding declared', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const depLock = maintenance.doctor({}).data.checks.find(c => c.name === 'dep-lock');
    assert.ok(depLock, 'dep-lock check must be present');
    assert.equal(depLock.status, 'ok');
    assert.match(depLock.detail, /no MCP binding declared/);
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

// --- US-7: config.phase.taskNotes (opt-in per-task AI history) -------------
// FR-034/FR-036, BL-15. `update-task --append` is one AI subprocess per task
// (measured 13.2 tasks/feature = ~13 calls) and only produces human-readable
// history — the disk facts are trace-link + task status. It must be OFF unless
// the project explicitly asks for it, and an ABSENT key must read as false so
// existing projects get the speedup without editing their config.

test('init-project: seeds phase.taskNotes=false alongside confirmTasks', () => {
  inTmp(() => {
    const r = maintenance['init-project']({ stack: 'node' });
    assert.equal(r.ok, true);
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.equal(cfg.phase.confirmTasks, true, 'confirmTasks default unchanged');
    assert.equal(cfg.phase.taskNotes, false, 'taskNotes must default to false');
  });
});

test('init-project: upgrades a config that has no phase block at all', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify({ project: 'legacy', stack: 'node' }));
    const r = maintenance['init-project']({ stack: 'node' });
    assert.equal(r.ok, true);
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.equal(cfg.phase.taskNotes, false);
  });
});

test('init-project: a pre-existing phase block keeps its own confirmTasks choice', () => {
  inTmp(() => {
    fs.mkdirSync('.spec-flow', { recursive: true });
    fs.writeFileSync('.spec-flow/config.json',
      JSON.stringify({ project: 'legacy', stack: 'node', phase: { confirmTasks: false } }));
    const r = maintenance['init-project']({ stack: 'node' });
    assert.equal(r.ok, true);
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    assert.equal(cfg.phase.confirmTasks, false, 'must not clobber an explicit user choice');
    // BL-15: absent taskNotes reads as false at the call site, so back-filling it
    // here is optional — but it must never be back-filled as true.
    assert.notEqual(cfg.phase.taskNotes, true);
  });
});

// -----------------------------------------------------------------------
// doctor / code-rules-config (FR-011) — validates config.verify.rules (and
// config.repos[*].verify.rules) by reusing lib/code-rules.cjs validateRules,
// so a malformed rule is caught here BEFORE a real verify-code run silently
// skips it. Never fails the gate (D4) — every outcome is 'ok' or 'warn'.
// -----------------------------------------------------------------------
const codeRulesChecks = (cfgPatch) => {
  return inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const cfgPath = '.spec-flow/config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    Object.assign(cfg, cfgPatch);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return maintenance.doctor({}).data.checks.filter(c => c.name === 'code-rules-config');
  });
};

test('doctor code-rules-config: ok with a hint when no rules are configured (TC-like empty)', () => {
  const checks = codeRulesChecks({});
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'ok');
  assert.match(checks[0].detail, /no.*rules configured/i);
});

test('doctor code-rules-config: ok with a hint when rules is an empty array', () => {
  const checks = codeRulesChecks({ verify: { rules: [] } });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'ok');
  assert.match(checks[0].detail, /no.*rules configured/i);
});

test('doctor code-rules-config: warns when a rule is missing id/message (TC-016)', () => {
  const checks = codeRulesChecks({ verify: { rules: [{ forbid: 'foo' }] } });
  assert.ok(checks.some(c => c.status === 'warn'), 'must warn on a rule missing id/message');
  assert.ok(checks.every(c => c.status !== 'fail'), 'must never fail the gate');
});

test('doctor code-rules-config: warns on duplicate id (TC-017)', () => {
  const checks = codeRulesChecks({
    verify: {
      rules: [
        { id: 'dup', message: 'm1', forbid: 'foo' },
        { id: 'dup', message: 'm2', forbid: 'bar' },
      ],
    },
  });
  assert.ok(checks.some(c => c.status === 'warn' && /dup/.test(c.detail)), 'must warn identifying the duplicate id');
});

test('doctor code-rules-config: warns when forbid and when are both set (TC-018)', () => {
  const checks = codeRulesChecks({
    verify: { rules: [{ id: 'both', message: 'm', forbid: 'foo', when: 'bar', require: 'baz' }] },
  });
  assert.ok(checks.some(c => c.status === 'warn' && /both/.test(c.detail)));
});

test('doctor code-rules-config: warns when when has no require (TC-019)', () => {
  const checks = codeRulesChecks({
    verify: { rules: [{ id: 'no-require', message: 'm', when: 'foo' }] },
  });
  assert.ok(checks.some(c => c.status === 'warn' && /no-require/.test(c.detail)));
});

test('doctor code-rules-config: warns on a regex that fails to compile (TC-020)', () => {
  const checks = codeRulesChecks({
    verify: { rules: [{ id: 'bad-regex', message: 'm', forbid: '[unclosed' }] },
  });
  assert.ok(checks.some(c => c.status === 'warn' && /bad-regex/.test(c.detail)));
});

test('doctor code-rules-config: warns on an unsupported scope value (TC-021)', () => {
  const checks = codeRulesChecks({
    verify: { rules: [{ id: 'bad-scope', message: 'm', forbid: 'foo', scope: 'unknown' }] },
  });
  assert.ok(checks.some(c => c.status === 'warn' && /bad-scope/.test(c.detail)));
});

test('doctor code-rules-config: ok "N rule(s) valid" when every rule is well formed', () => {
  const checks = codeRulesChecks({
    verify: {
      rules: [
        { id: 'r1', message: 'm1', forbid: 'foo' },
        { id: 'r2', message: 'm2', when: 'bar', require: 'baz' },
      ],
    },
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'ok');
  assert.match(checks[0].detail, /2 rule\(s\) valid/);
});

test('doctor code-rules-config: also validates config.repos[*].verify.rules (multi-repo, FR-006/FR-011)', () => {
  const checks = inTmp((dir) => {
    maintenance['init-project']({ stack: 'node' });
    const cfgPath = '.spec-flow/config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const svcDir = path.join(dir, 'svc-a');
    fs.mkdirSync(svcDir, { recursive: true });
    fs.mkdirSync(path.join(svcDir, '.git'), { recursive: true });
    cfg.repos = { 'svc-a': { path: './svc-a', verify: { rules: [{ forbid: 'x' }] } } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return maintenance.doctor({}).data.checks.filter(c => c.name === 'code-rules-config');
  });
  assert.ok(checks.some(c => c.status === 'warn' && /svc-a/.test(c.detail)), 'must surface a per-repo rules problem, labeled by repo name');
});

// ---------------------------------------------------------------------------
// doctor: backlog-priority (FR-025, SD §10.7, TC-019) — WARN-only check
// listing legacy backlog files (no marker) and marker records left with
// priority 'unset', each with the backlog-set command to fix it. Never FAIL,
// and no noise when there is nothing to flag.
// ---------------------------------------------------------------------------

const MARKER = '<!-- spec-flow backlog record -->';
function backlogRecord({ id = 'bl-001', title = 'Test item', priority = 'medium' } = {}) {
  return [
    `# ${title}`,
    '',
    MARKER,
    `id: ${id}`,
    'created: 2026-09-24T00:00:00.000Z',
    `priority: ${priority}`,
    'status: open',
    '',
    '## Description',
    '',
  ].join('\n');
}

const backlogPriorityChecks = () => maintenance.doctor({}).data.checks.filter(c => c.name === 'backlog-priority');

test('doctor: backlog-priority is ok with no noise when .spec-flow/backlog/ does not exist', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const checks = backlogPriorityChecks();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'ok');
    assert.equal(checks[0].fix, null);
  });
});

test('doctor: backlog-priority is ok with no noise when the backlog dir has nothing to flag', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    fs.mkdirSync('.spec-flow/backlog', { recursive: true });
    fs.writeFileSync('.spec-flow/backlog/001-bl-foo.md', backlogRecord({ id: 'bl-001', priority: 'high' }));
    const checks = backlogPriorityChecks();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'ok');
  });
});

test('doctor: backlog-priority WARNs on a legacy file and a priority-less record, each with a backlog-set fix hint (TC-019)', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    fs.mkdirSync('.spec-flow/backlog', { recursive: true });
    // Legacy: no marker at all.
    fs.writeFileSync('.spec-flow/backlog/legacy-note.md', '# Some old note\n\nno marker here\n');
    // Marker present, but priority is missing/invalid -> parses to 'unset'.
    fs.writeFileSync('.spec-flow/backlog/002-bl-bar.md', backlogRecord({ id: 'bl-002', priority: 'nope' }));
    // A well-formed record must NOT be flagged.
    fs.writeFileSync('.spec-flow/backlog/003-bl-baz.md', backlogRecord({ id: 'bl-003', priority: 'low' }));

    const checks = backlogPriorityChecks();
    assert.equal(checks.length, 2, 'exactly the legacy file and the priority-less record are flagged');
    assert.ok(checks.every(c => c.status === 'warn'), 'never FAIL, only WARN');
    assert.ok(checks.every(c => /backlog-set --id/.test(c.fix)), 'each flagged item carries a backlog-set fix hint');

    const details = checks.map(c => c.detail).join(' | ');
    assert.match(details, /legacy-note\.md/);
    assert.match(details, /bl-002/);
  });
});

test('doctor: backlog-priority does not flag a legacy file once backlog-set gave it a priority (the fix clears the warning)', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    fs.mkdirSync('.spec-flow/backlog', { recursive: true });
    // What `backlog-set --priority medium` leaves on a legacy file: a priority line under the heading, still no marker.
    fs.writeFileSync('.spec-flow/backlog/legacy-note.md', '# Some old note\npriority: medium\n\nno marker here\n');

    const checks = backlogPriorityChecks();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'ok', 'a legacy file with a valid priority lists correctly, so there is nothing to fix');
  });
});

test('doctor verify-integrity: a TODO inside a YAML comment is not an unfilled test', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const d = path.join('.spec-flow', 'specs', 'demo');
    fs.mkdirSync(d, { recursive: true });
    // doctor resolves the active feature from the trace mirror, so seed both.
    fs.writeFileSync(path.join(d, 'SD.md'), '# Solution Design: demo\n\n## 1. Overview\n');
    const trace = { feature: 'demo', nodes: { fr: [], tc: [], nfr: [], errors: [], states: [] }, links: [] };
    fs.writeFileSync(path.join(d, 'trace.json'), JSON.stringify(trace));
    fs.writeFileSync(path.join('.spec-flow', 'trace.json'), JSON.stringify(trace));
    fs.writeFileSync(path.join(d, 'VERIFICATION.md'), 'status: passed\n\n- TC-001: verified\n');
    // The comment explains why the scaffold was NOT filled — it is documentation,
    // not an unfilled test. lint-checklist and checklist-status both strip comments
    // before counting; doctor did not, so writing about TODOs failed the gate.
    fs.writeFileSync(path.join(d, 'CHECKLIST.yaml'), [
      '# checklist-gen emits `GET /api/v1/TODO` stubs for non-HTTP features.',
      'config:',
      '  base_url: "http://localhost:8080"',
      'suites:',
      '  - id: suite-1',
      '    name: "s"',
      '    tags: [regression]',
      '    tests:',
      '      - id: TC-001',
      '        name: "t"',
      '        tags: [regression, no-verify]',
    ].join('\n'));
    const r = maintenance.doctor({});
    const vi = (r.data.checks || []).find(c => c.name === 'verify-integrity');
    assert.ok(vi, 'verify-integrity check must run');
    assert.notEqual(vi.status, 'fail',
      'a TODO in a comment must not read as an unfilled test');
  });
});
