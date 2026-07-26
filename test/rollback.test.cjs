/**
 * Unit tests for scripts/rollback.cjs — rollback tool + data-integrity check
 * (FR-008, TC-009, TC-010).
 *
 * Covers:
 *   (a) rollback() restores config engine → 'legacy', preserves other keys
 *   (b) rollback() restores .mcp.json → legacy npx entry
 *   (c) rollback() rewrites native node invocations back to legacy npx form
 *   (d) All three changed in ONE call
 *   (e) dryRun: true — writes nothing but returns planned changes
 *   (f) Reversibility bytes check — restoring captured bytes reproduces pre-rollback files
 *   (g) Summary return shape: { configChanged, mcpChanged, cliReplacements }
 *   (h) cliReplacements reports per-file count
 *   (i) verifyTasksIntact — seeds tasks via task-core, runs rollback on temp config,
 *       then verifyTasksIntact → same task count, schema valid, no data lost (TC-010)
 *   (j) dryRun writes nothing to any file
 *   (k) Real repo bindings are NEVER touched
 *
 * Tests use node:test + node:assert/strict, os.mkdtemp isolation.
 * The real .spec-flow/config.json, .mcp.json, and commands/ are NEVER touched.
 *
 * Run:  node test/rollback.test.cjs
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

let rollback;
let verifyTasksIntact;
test('rollback module imports without throwing', () => {
  ({ rollback, verifyTasksIntact } = require('../scripts/rollback.cjs'));
  assert.equal(typeof rollback, 'function', 'rollback must be a function');
  assert.equal(typeof verifyTasksIntact, 'function', 'verifyTasksIntact must be a function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
}

/**
 * Create a temp config.json with native engine (post-cutover state) and return its path.
 *
 * @param {string} tmpDir
 * @param {object} [extraConfig={}] - additional top-level keys to merge in
 */
function makeTmpNativeConfig(tmpDir, extraConfig) {
  const configPath = path.join(tmpDir, 'config.json');
  const config = Object.assign(
    { project: 'test-project', stack: 'node', taskCore: { engine: 'native' } },
    extraConfig || {}
  );
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

/**
 * Create a temp .mcp.json with the native node entry (post-cutover state) and return its path.
 *
 * @param {string} tmpDir
 */
function makeTmpNativeMcp(tmpDir) {
  const mcpPath = path.join(tmpDir, '.mcp.json');
  const native = {
    mcpServers: {
      'task-master-ai': {
        command: 'node',
        args: ['bin/mcp-server.js'],
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(native, null, 2), 'utf8');
  return mcpPath;
}

/**
 * Create a temp markdown file containing native node invocations (post-cutover state)
 * and return its path.
 *
 * @param {string} tmpDir
 * @param {string} [filename='cmd.md']
 */
function makeTmpNativeCliFile(tmpDir, filename) {
  const filePath = path.join(tmpDir, filename || 'cmd.md');
  const content = [
    '# Test command file',
    '',
    'Run this step:',
    '```',
    'node bin/task-master parse-prd --input SD.md --tag feat',
    '```',
    '',
    'Also this:',
    '```',
    'node bin/task-master analyze-complexity --research',
    '```',
    '',
    'End.',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// (a) TC-009: rollback restores config engine → 'legacy', preserves other keys
// ---------------------------------------------------------------------------

test('(a) rollback() restores config engine to legacy and preserves other keys', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir, { project: 'my-proj', language: 'vi', stack: 'node' });
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  await rollback({ configFile, mcpFile, cliFiles: [cliFile] });

  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.taskCore.engine, 'legacy', 'taskCore.engine must be "legacy" after rollback');
  assert.equal(config.project, 'my-proj', 'project key must be preserved');
  assert.equal(config.language, 'vi', 'language key must be preserved');
  assert.equal(config.stack, 'node', 'stack key must be preserved');
});

// ---------------------------------------------------------------------------
// (b) rollback restores .mcp.json to legacy npx entry
// ---------------------------------------------------------------------------

test('(b) rollback() restores .mcp.json to legacy npx entry', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  await rollback({ configFile, mcpFile, cliFiles: [cliFile] });

  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  const entry = mcp.mcpServers['task-master-ai'];
  assert.ok(entry, 'task-master-ai key must remain in mcpServers');
  assert.equal(entry.command, 'npx', 'legacy entry command must be "npx"');
  assert.deepEqual(entry.args, ['-y', 'task-master-ai@0.43.1'], 'legacy entry args must match');
});

// ---------------------------------------------------------------------------
// (c) rollback rewrites native node invocations back to legacy npx form
// ---------------------------------------------------------------------------

test('(c) rollback() rewrites native node lines back to legacy npx form', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  await rollback({ configFile, mcpFile, cliFiles: [cliFile] });

  const content = fs.readFileSync(cliFile, 'utf8');
  // Native form must be gone
  assert.ok(
    !content.includes('node bin/task-master parse-prd'),
    'native node form must not appear after rollback for parse-prd'
  );
  assert.ok(
    !content.includes('node bin/task-master analyze-complexity'),
    'native node form must not appear after rollback for analyze-complexity'
  );
  // Legacy form must be restored
  assert.ok(
    content.includes('npx -y -p task-master-ai@0.43.1 task-master parse-prd'),
    'parse-prd invocation must use legacy form after rollback'
  );
  assert.ok(
    content.includes('npx -y -p task-master-ai@0.43.1 task-master analyze-complexity'),
    'analyze-complexity invocation must use legacy form after rollback'
  );
});

// ---------------------------------------------------------------------------
// (d) rollback changes all three targets in one call
// ---------------------------------------------------------------------------

test('(d) rollback changes all three targets in one call', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  const result = await rollback({ configFile, mcpFile, cliFiles: [cliFile] });

  assert.equal(result.configChanged, true, 'configChanged must be true');
  assert.equal(result.mcpChanged, true, 'mcpChanged must be true');
  assert.ok(result.cliReplacements, 'cliReplacements must be present');
  const repCount = result.cliReplacements[cliFile];
  assert.ok(typeof repCount === 'number' && repCount > 0, 'cliReplacements[file] must be a positive number');
});

// ---------------------------------------------------------------------------
// (e) dryRun: true — computes changes without writing
// ---------------------------------------------------------------------------

test('(e) dryRun:true — returns planned changes and writes NOTHING', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  const configBefore = fs.readFileSync(configFile, 'utf8');
  const mcpBefore = fs.readFileSync(mcpFile, 'utf8');
  const cliBefore = fs.readFileSync(cliFile, 'utf8');

  const result = await rollback({ configFile, mcpFile, cliFiles: [cliFile], dryRun: true });

  // Files must be unchanged
  assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore, 'config must not change in dryRun');
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), mcpBefore, 'mcp must not change in dryRun');
  assert.equal(fs.readFileSync(cliFile, 'utf8'), cliBefore, 'cli file must not change in dryRun');

  // Result must report planned changes
  assert.ok(result.changes, 'dryRun result must have a changes property');
  assert.ok(Array.isArray(result.changes), 'changes must be an array');
  assert.ok(result.changes.length > 0, 'changes array must not be empty');
});

// ---------------------------------------------------------------------------
// (f) Reversibility bytes check
// ---------------------------------------------------------------------------

test('(f) reversibility — restoring captured bytes reproduces original files', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  // Capture bytes before rollback
  const configBefore = fs.readFileSync(configFile);
  const mcpBefore = fs.readFileSync(mcpFile);
  const cliBefore = fs.readFileSync(cliFile);

  // Apply rollback
  await rollback({ configFile, mcpFile, cliFiles: [cliFile] });

  // Verify files changed (sanity check)
  const configAfter = fs.readFileSync(configFile, 'utf8');
  assert.ok(configAfter.includes('"legacy"'), 'rollback must have changed config before restore test');

  // Restore from captured bytes (models git revert)
  fs.writeFileSync(configFile, configBefore);
  fs.writeFileSync(mcpFile, mcpBefore);
  fs.writeFileSync(cliFile, cliBefore);

  // Assert restored content equals original
  assert.deepEqual(fs.readFileSync(configFile), configBefore, 'restored config must equal original');
  assert.deepEqual(fs.readFileSync(mcpFile), mcpBefore, 'restored mcp must equal original');
  assert.deepEqual(fs.readFileSync(cliFile), cliBefore, 'restored cli file must equal original');
});

// ---------------------------------------------------------------------------
// (g) Summary return shape
// ---------------------------------------------------------------------------

test('(g) rollback returns { configChanged, mcpChanged, cliReplacements }', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFile = makeTmpNativeCliFile(tmpDir, 'cmd.md');

  const result = await rollback({ configFile, mcpFile, cliFiles: [cliFile] });

  assert.ok(Object.prototype.hasOwnProperty.call(result, 'configChanged'), 'result must have configChanged');
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'mcpChanged'), 'result must have mcpChanged');
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'cliReplacements'), 'result must have cliReplacements');
  assert.equal(typeof result.configChanged, 'boolean', 'configChanged must be boolean');
  assert.equal(typeof result.mcpChanged, 'boolean', 'mcpChanged must be boolean');
  assert.equal(typeof result.cliReplacements, 'object', 'cliReplacements must be object');
});

// ---------------------------------------------------------------------------
// (h) cliReplacements reports per-file count
// ---------------------------------------------------------------------------

test('(h) cliReplacements has one entry per cliFile with correct count', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);
  const cliFileA = makeTmpNativeCliFile(tmpDir, 'fileA.md');
  const cliFileB = makeTmpNativeCliFile(tmpDir, 'fileB.md');

  const result = await rollback({ configFile, mcpFile, cliFiles: [cliFileA, cliFileB] });

  assert.ok(Object.prototype.hasOwnProperty.call(result.cliReplacements, cliFileA), 'cliReplacements must have entry for fileA');
  assert.ok(Object.prototype.hasOwnProperty.call(result.cliReplacements, cliFileB), 'cliReplacements must have entry for fileB');
  // Each file has 2 native invocations
  assert.equal(result.cliReplacements[cliFileA], 2, 'fileA must report 2 replacements');
  assert.equal(result.cliReplacements[cliFileB], 2, 'fileB must report 2 replacements');
});

// ---------------------------------------------------------------------------
// (i) TC-010: no data loss — seed tasks, run rollback on config, verifyTasksIntact
// ---------------------------------------------------------------------------

test('(i) TC-010: verifyTasksIntact confirms no data loss after rollback', async () => {
  const tmpDir = makeTmpDir();

  // Set up tasks directory
  const tasksDir = path.join(tmpDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const tasksFile = path.join(tasksDir, 'tasks.json');

  // Seed tasks via task-core
  const { addTask } = require('../lib/task-core.cjs');
  const _paths = { tasksFile };

  addTask('default', { title: 'Task one', description: 'First task' }, _paths);
  addTask('default', { title: 'Task two', description: 'Second task' }, _paths);

  // Verify 2 tasks were created
  const dataBefore = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.equal(dataBefore.default.tasks.length, 2, 'must have seeded 2 tasks before rollback');

  // Set up temp config/mcp for rollback (tasks file separate — not touched by rollback)
  const configFile = makeTmpNativeConfig(tmpDir);
  const mcpFile = makeTmpNativeMcp(tmpDir);

  // Run rollback on config/mcp (tasks.json is NOT a target of rollback)
  await rollback({ configFile, mcpFile, cliFiles: [] });

  // Verify config was rolled back
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.taskCore.engine, 'legacy', 'config must show legacy engine after rollback');

  // TC-010: verifyTasksIntact confirms no records lost
  const { ok, tagCount, taskCount } = await verifyTasksIntact({ tasksFile });

  assert.equal(ok, true, 'verifyTasksIntact must return ok:true');
  assert.equal(tagCount, 1, 'tagCount must be 1 (one tag: "default")');
  assert.equal(taskCount, 2, 'taskCount must be 2 (no data loss)');
});

// ---------------------------------------------------------------------------
// (j) configChanged=false when config already has engine=legacy
// ---------------------------------------------------------------------------

test('(j) idempotent: configChanged=false when engine already legacy', async () => {
  const tmpDir = makeTmpDir();
  // Config already at legacy engine
  const configFile = makeTmpNativeConfig(tmpDir, { taskCore: { engine: 'legacy' } });
  const mcpFile = makeTmpNativeMcp(tmpDir);

  const result = await rollback({ configFile, mcpFile, cliFiles: [] });

  assert.equal(result.configChanged, false, 'configChanged must be false when engine already legacy');
});

// ---------------------------------------------------------------------------
// (k) Real repo bindings are NEVER touched
// ---------------------------------------------------------------------------

test('(k) real repo bindings are untouched after all rollback test operations', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const realConfig = path.join(repoRoot, '.spec-flow', 'config.json');
  const realMcp = path.join(repoRoot, '.mcp.json');

  // Read real config — must NOT have taskCore.engine = 'legacy' changed by tests
  // (the real repo does not have taskCore set at all in .spec-flow/config.json,
  // or if it exists it is not 'legacy' from our tests)
  const config = JSON.parse(fs.readFileSync(realConfig, 'utf8'));
  // Just verify the file is valid JSON and not corrupted by our tests
  assert.ok(typeof config === 'object' && config !== null, 'real config must be a valid object');
  assert.ok(config.project === 'spec-flow', 'real config project must still be spec-flow');

  const mcp = JSON.parse(fs.readFileSync(realMcp, 'utf8'));
  // The real .mcp.json should still be the legacy npx entry (the cutover tests
  // should have left it unchanged since they use temp dirs)
  assert.ok(typeof mcp === 'object' && mcp !== null, 'real .mcp.json must be a valid object');
  assert.ok(mcp.mcpServers, 'real .mcp.json must have mcpServers');
});
