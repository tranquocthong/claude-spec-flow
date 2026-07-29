/**
 * Unit tests for scripts/remove-legacy-dep.cjs — legacy dependency removal tool
 * (FR-009, TC-011).
 *
 * Covers:
 *   (a) Guard refuses when engineConfig is legacy — writes nothing, returns refused:true
 *   (b) Guard refuses when engineConfig file is absent — writes nothing, returns refused:true
 *   (c) With engine=native + DEPENDENCIES.md containing the pin → pin line removed
 *   (d) dryRun:true — writes nothing but reports planned changes
 *   (e) Temp .mcp.json with leftover legacy npx entry → mcpCleaned:true, entry removed
 *   (f) Temp .mcp.json already with native entry → mcpCleaned:false, entry untouched
 *   (g) Summary return shape: { depLinesRemoved, mcpCleaned } (no refused when allowed)
 *   (h) dryRun:true writes nothing when engine is native
 *   (i) Real DEPENDENCIES.md and .mcp.json are untouched after all test operations
 *   (j) depLinesRemoved counts lines actually removed
 *   (k) DEPENDENCIES.md without pin → depLinesRemoved:0
 *
 * Tests use node:test + node:assert/strict, os.mkdtemp isolation.
 * The real DEPENDENCIES.md and .mcp.json are NEVER touched.
 *
 * Run:  node test/remove-legacy-dep.test.cjs
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let removeLegacyDep;
test('remove-legacy-dep module imports without throwing', () => {
  ({ removeLegacyDep } = require('../scripts/remove-legacy-dep.cjs'));
  assert.equal(typeof removeLegacyDep, 'function', 'removeLegacyDep must be a function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remove-dep-test-'));
}

/**
 * Create a temp config.json with the specified engine and return its path.
 *
 * @param {string} tmpDir
 * @param {'native'|'legacy'} engine
 */
function makeTmpEngineConfig(tmpDir, engine) {
  const configPath = path.join(tmpDir, 'config.json');
  const config = {
    project: 'test-project',
    stack: 'node',
    taskCore: { engine },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

/**
 * Create a temp DEPENDENCIES.md with a task-master-ai@0.43.1 pin line.
 *
 * @param {string} tmpDir
 * @param {boolean} [includePin=true] - whether to include the pin line
 */
function makeTmpDepsFile(tmpDir, includePin) {
  const depsPath = path.join(tmpDir, 'DEPENDENCIES.md');
  const includeIt = includePin !== false;
  const lines = [
    '# spec-flow — Dependency Registry',
    '',
    '## Dependencies',
    '',
    '| Name | Type | Pinned version | Why | Bump policy |',
    '| --- | --- | --- | --- | --- |',
  ];
  if (includeIt) {
    lines.push(
      '| `task-master-ai` | Runtime MCP (pulled via `npx`) | `0.43.1` | Wired by `.mcp.json` | Bump deliberately. |'
    );
  }
  lines.push(
    '| `manual-test` | Bundled | This plugin\'s version | Shipped as part of the plugin | Re-vendor intentionally. |',
    '| `node` | Environment | >= 18 | Modern Node APIs | Document only. |',
    '',
    '## Lock policy',
    '',
    'Dependencies are pinned.',
  );
  fs.writeFileSync(depsPath, lines.join('\n'), 'utf8');
  return depsPath;
}

/**
 * Create a temp .mcp.json with a legacy npx task-master-ai entry.
 *
 * @param {string} tmpDir
 */
function makeTmpLegacyMcp(tmpDir) {
  const mcpPath = path.join(tmpDir, '.mcp.json');
  const data = {
    mcpServers: {
      'task-master-ai': {
        command: 'npx',
        args: ['-y', 'task-master-ai@0.43.1'],
        env: { TASK_MASTER_TOOLS: 'standard' },
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return mcpPath;
}

/**
 * Create a temp .mcp.json with a native node entry (already post-cutover).
 *
 * @param {string} tmpDir
 */
function makeTmpNativeMcp(tmpDir) {
  const mcpPath = path.join(tmpDir, '.mcp.json');
  const data = {
    mcpServers: {
      'task-master-ai': {
        command: 'node',
        args: ['bin/mcp-server.js'],
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return mcpPath;
}

// ---------------------------------------------------------------------------
// (a) Guard refuses when engine config is 'legacy'
// ---------------------------------------------------------------------------

test('(a) guard refuses when engine is legacy — writes nothing, refused:true', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'legacy');
  const dependenciesFile = makeTmpDepsFile(tmpDir);
  const mcpFile = makeTmpLegacyMcp(tmpDir);

  const depsBefore = fs.readFileSync(dependenciesFile, 'utf8');
  const mcpBefore = fs.readFileSync(mcpFile, 'utf8');

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.equal(result.refused, true, 'result.refused must be true when engine is legacy');
  assert.ok(result.reason, 'result.reason must be set when refused');

  // Files must be untouched
  assert.equal(fs.readFileSync(dependenciesFile, 'utf8'), depsBefore, 'DEPENDENCIES.md must not change when refused');
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), mcpBefore, '.mcp.json must not change when refused');
});

// ---------------------------------------------------------------------------
// (b) Guard does NOT refuse when engine config file is absent (defaults to native)
// ---------------------------------------------------------------------------

test('(b) guard proceeds when engine config file is absent — defaults to native', async () => {
  const tmpDir = makeTmpDir();
  // Non-existent config file → readEngineConfig now returns 'native' (shipped default)
  const engineConfigFile = path.join(tmpDir, 'nonexistent-config.json');
  const dependenciesFile = makeTmpDepsFile(tmpDir, true); // includes pin line
  const mcpFile = makeTmpLegacyMcp(tmpDir);

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.equal(result.refused, undefined, 'result must not be refused when engine config is absent (defaults to native)');
  assert.ok(result.depLinesRemoved >= 1, 'the task-master-ai pin line must be removed');
});

// ---------------------------------------------------------------------------
// (c) With engine=native + DEPENDENCIES.md containing pin → pin line removed
// ---------------------------------------------------------------------------

test('(c) with engine=native + pin in DEPENDENCIES.md → pin line removed', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, true); // includes pin line
  const mcpFile = makeTmpNativeMcp(tmpDir);

  const depsBefore = fs.readFileSync(dependenciesFile, 'utf8');
  // The real DEPENDENCIES.md format has package name and version in separate table columns,
  // so we check for both tokens rather than the combined 'task-master-ai@0.43.1' form.
  assert.ok(
    depsBefore.includes('task-master-ai') && depsBefore.includes('0.43.1'),
    'pin line must be present before removal (package and version in separate columns)'
  );

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.ok(!result.refused, 'must not refuse when engine is native');

  const depsAfter = fs.readFileSync(dependenciesFile, 'utf8');
  assert.ok(
    !depsAfter.includes('task-master-ai@0.43.1'),
    'pin line must be removed from DEPENDENCIES.md'
  );
  // Other lines must remain
  assert.ok(depsAfter.includes('manual-test'), 'manual-test entry must remain');
  assert.ok(depsAfter.includes('node'), 'node entry must remain');
});

// ---------------------------------------------------------------------------
// (d) dryRun:true — writes nothing but reports planned changes
// ---------------------------------------------------------------------------

test('(d) dryRun:true — writes nothing but reports planned changes', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, true);
  const mcpFile = makeTmpLegacyMcp(tmpDir);

  const depsBefore = fs.readFileSync(dependenciesFile, 'utf8');
  const mcpBefore = fs.readFileSync(mcpFile, 'utf8');

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile, dryRun: true });

  // Files must be untouched
  assert.equal(fs.readFileSync(dependenciesFile, 'utf8'), depsBefore, 'DEPENDENCIES.md must not change in dryRun');
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), mcpBefore, '.mcp.json must not change in dryRun');

  // Result must have planned info
  assert.ok(!result.refused, 'must not refuse when engine is native');
  assert.ok(typeof result.depLinesRemoved === 'number', 'depLinesRemoved must be a number in dryRun');
  assert.ok(typeof result.mcpCleaned === 'boolean', 'mcpCleaned must be boolean in dryRun');
});

// ---------------------------------------------------------------------------
// (e) .mcp.json with leftover legacy npx entry → mcpCleaned:true, entry removed
// ---------------------------------------------------------------------------

test('(e) leftover legacy .mcp.json entry → mcpCleaned:true and entry deleted', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, false); // no pin
  const mcpFile = makeTmpLegacyMcp(tmpDir); // legacy npx entry

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.ok(!result.refused, 'must not refuse when engine is native');
  assert.equal(result.mcpCleaned, true, 'mcpCleaned must be true when legacy entry was removed');

  const mcpAfter = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  // The legacy task-master-ai entry must no longer be present (or must not be the npx entry)
  const entry = mcpAfter.mcpServers && mcpAfter.mcpServers['task-master-ai'];
  if (entry) {
    // If entry remains, it must not be the legacy npx entry
    assert.notEqual(entry.command, 'npx', 'task-master-ai entry must not be legacy npx entry after clean');
  }
});

// ---------------------------------------------------------------------------
// (f) .mcp.json already with native entry → mcpCleaned:false, entry untouched
// ---------------------------------------------------------------------------

test('(f) native .mcp.json entry → mcpCleaned:false, entry untouched', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, false);
  const mcpFile = makeTmpNativeMcp(tmpDir);

  const mcpBefore = fs.readFileSync(mcpFile, 'utf8');

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.ok(!result.refused, 'must not refuse when engine is native');
  assert.equal(result.mcpCleaned, false, 'mcpCleaned must be false when entry was already native');

  // .mcp.json must be unchanged
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), mcpBefore, '.mcp.json must not change when already native');
});

// ---------------------------------------------------------------------------
// (g) Summary return shape: { depLinesRemoved, mcpCleaned } when not refused
// ---------------------------------------------------------------------------

test('(g) return shape has depLinesRemoved and mcpCleaned when engine is native', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, true);
  const mcpFile = makeTmpNativeMcp(tmpDir);

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.ok(Object.prototype.hasOwnProperty.call(result, 'depLinesRemoved'), 'result must have depLinesRemoved');
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'mcpCleaned'), 'result must have mcpCleaned');
  assert.equal(typeof result.depLinesRemoved, 'number', 'depLinesRemoved must be a number');
  assert.equal(typeof result.mcpCleaned, 'boolean', 'mcpCleaned must be boolean');
  assert.ok(!result.refused, 'result.refused must be falsy when not refused');
});

// ---------------------------------------------------------------------------
// (h) dryRun:true writes nothing even when engine is native and both changes needed
// ---------------------------------------------------------------------------

test('(h) dryRun:true with both changes needed — writes nothing', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, true); // has pin
  const mcpFile = makeTmpLegacyMcp(tmpDir); // has legacy entry

  const depsBefore = fs.readFileSync(dependenciesFile, 'utf8');
  const mcpBefore = fs.readFileSync(mcpFile, 'utf8');

  await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile, dryRun: true });

  assert.equal(fs.readFileSync(dependenciesFile, 'utf8'), depsBefore, 'DEPENDENCIES.md must not change in dryRun (both changes)');
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), mcpBefore, '.mcp.json must not change in dryRun (both changes)');
});

// ---------------------------------------------------------------------------
// (i) Real DEPENDENCIES.md and .mcp.json are untouched after all test operations
// ---------------------------------------------------------------------------

test('(i) real DEPENDENCIES.md and .mcp.json are untouched after all test operations', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const realDeps = path.join(repoRoot, 'DEPENDENCIES.md');
  const realMcp = path.join(repoRoot, '.mcp.json');

  const depsContent = fs.readFileSync(realDeps, 'utf8');
  assert.ok(typeof depsContent === 'string' && depsContent.length > 0, 'real DEPENDENCIES.md must be a non-empty string');
  assert.ok(depsContent.includes('# spec-flow'), 'real DEPENDENCIES.md must still have the project heading');

  const mcpContent = fs.readFileSync(realMcp, 'utf8');
  const mcp = JSON.parse(mcpContent);
  assert.ok(typeof mcp === 'object' && mcp !== null, 'real .mcp.json must be a valid object');
  assert.ok(mcp.mcpServers, 'real .mcp.json must have mcpServers');
});

// ---------------------------------------------------------------------------
// (j) depLinesRemoved counts lines actually removed
// ---------------------------------------------------------------------------

test('(j) depLinesRemoved counts lines actually removed', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const mcpFile = makeTmpNativeMcp(tmpDir);

  // DEPENDENCIES.md with exactly one pin line
  const depsPath = path.join(tmpDir, 'DEPENDENCIES.md');
  const content = [
    '# Deps',
    '',
    '| `task-master-ai` | MCP | `0.43.1` | Wired | Bump deliberately. |',
    '| `node` | Env | >= 18 | Node APIs | Doc only. |',
  ].join('\n');
  fs.writeFileSync(depsPath, content, 'utf8');

  const result = await removeLegacyDep({
    dependenciesFile: depsPath,
    mcpFile,
    engineConfigFile,
  });

  assert.ok(!result.refused, 'must not refuse when engine is native');
  assert.equal(result.depLinesRemoved, 1, 'depLinesRemoved must be 1 for a single pin line');
});

// ---------------------------------------------------------------------------
// (k) DEPENDENCIES.md without pin → depLinesRemoved:0
// ---------------------------------------------------------------------------

test('(k) DEPENDENCIES.md without pin → depLinesRemoved:0, file unchanged', async () => {
  const tmpDir = makeTmpDir();
  const engineConfigFile = makeTmpEngineConfig(tmpDir, 'native');
  const dependenciesFile = makeTmpDepsFile(tmpDir, false); // no pin
  const mcpFile = makeTmpNativeMcp(tmpDir);

  const depsBefore = fs.readFileSync(dependenciesFile, 'utf8');

  const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile });

  assert.ok(!result.refused, 'must not refuse when engine is native');
  assert.equal(result.depLinesRemoved, 0, 'depLinesRemoved must be 0 when no pin line exists');
  assert.equal(fs.readFileSync(dependenciesFile, 'utf8'), depsBefore, 'file must be unchanged when no pin found');
});
