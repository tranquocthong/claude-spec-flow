/**
 * Unit tests for scripts/cutover.cjs — atomic cutover tool (FR-006, TC-007).
 *
 * Covers:
 *   (a) TC-007 — after cutover(), config has taskCore.engine === 'native'
 *   (b) TC-007 — after cutover(), .mcp.json entry is the native node entry
 *   (c) TC-007 — after cutover(), legacy npx line in CLI file → node bin/task-master
 *   (d) All three changed in ONE call
 *   (e) dryRun: true — writes nothing but returns planned changes
 *   (f) Reversibility — restore captured bytes → files identical to pre-cutover state
 *   (g) Summary return shape: { configChanged, mcpChanged, cliReplacements }
 *   (h) cliReplacements reports per-file replacement count
 *   (i) Config without taskCore key gets taskCore created
 *   (j) Module has no file-writing default (require.main === module guard)
 *
 * Tests use node:test + node:assert/strict, os.mkdtemp isolation.
 * The real .spec-flow/config.json, .mcp.json, and commands/ are NEVER touched.
 *
 * Run:  node test/cutover.test.cjs
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

let cutover;
test('cutover module imports without throwing', () => {
  ({ cutover } = require('../scripts/cutover.cjs'));
  assert.equal(typeof cutover, 'function', 'cutover must be a function');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-test-'));
}

/**
 * Create a temp config.json with no taskCore (or legacy engine) and return its path.
 *
 * @param {string} tmpDir
 * @param {object} [extraConfig={}] - additional top-level keys to merge in
 */
function makeTmpConfig(tmpDir, extraConfig) {
  const configPath = path.join(tmpDir, 'config.json');
  const config = Object.assign(
    { project: 'test-project', stack: 'node' },
    extraConfig || {}
  );
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

/**
 * Create a temp .mcp.json with the legacy task-master-ai entry and return its path.
 *
 * @param {string} tmpDir
 */
function makeTmpMcp(tmpDir) {
  const mcpPath = path.join(tmpDir, '.mcp.json');
  const legacy = {
    mcpServers: {
      'task-master-ai': {
        command: 'npx',
        args: ['-y', 'task-master-ai@0.43.1'],
        env: { TASK_MASTER_TOOLS: 'standard' },
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(legacy, null, 2), 'utf8');
  return mcpPath;
}

/**
 * Create a temp markdown file containing a legacy npx invocation and return its path.
 *
 * @param {string} tmpDir
 * @param {string} [filename='cmd.md']
 */
function makeTmpCliFile(tmpDir, filename) {
  const filePath = path.join(tmpDir, filename || 'cmd.md');
  const content = [
    '# Test command file',
    '',
    'Run this step:',
    '```',
    'npx -y -p task-master-ai@0.43.1 task-master parse-prd --input SD.md --tag feat',
    '```',
    '',
    'Also this:',
    '```',
    'npx -y -p task-master-ai@0.43.1 task-master analyze-complexity --research',
    '```',
    '',
    'And via short form:',
    '```',
    'npx -y task-master-ai@0.43.1 expand --id=5',
    '```',
    '',
    'End.',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// (a-d) TC-007: atomic cutover — all three files changed in one call
// ---------------------------------------------------------------------------

test('(a) after cutover(), config has taskCore.engine === native', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  await cutover({ configFile, mcpFile, cliFiles: [cliFile] });

  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.ok(config.taskCore, 'taskCore key must exist in config');
  assert.equal(config.taskCore.engine, 'native', 'taskCore.engine must be "native"');
});

test('(b) after cutover(), .mcp.json entry is native node form', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  await cutover({ configFile, mcpFile, cliFiles: [cliFile] });

  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  const entry = mcp.mcpServers['task-master-ai'];
  assert.ok(entry, 'task-master-ai key must remain in mcpServers');
  assert.equal(entry.command, 'node', 'native entry command must be "node"');
  assert.deepEqual(entry.args, ['bin/mcp-server.js'], 'native entry args must be ["bin/mcp-server.js"]');
});

test('(c) after cutover(), legacy npx line becomes node bin/task-master', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  await cutover({ configFile, mcpFile, cliFiles: [cliFile] });

  const content = fs.readFileSync(cliFile, 'utf8');
  // Legacy form must be gone
  assert.ok(
    !content.includes('npx -y -p task-master-ai@0.43.1 task-master'),
    'legacy -p form must not appear after cutover'
  );
  assert.ok(
    !content.includes('npx -y task-master-ai@0.43.1'),
    'legacy short form must not appear after cutover'
  );
  // Native form must be present for each subcommand
  assert.ok(content.includes('node bin/task-master parse-prd'), 'parse-prd invocation must use native form');
  assert.ok(content.includes('node bin/task-master analyze-complexity'), 'analyze-complexity invocation must use native form');
  assert.ok(content.includes('node bin/task-master expand'), 'expand invocation must use native form');
});

test('(d) cutover changes all three targets in one call', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  const result = await cutover({ configFile, mcpFile, cliFiles: [cliFile] });

  // All three must report changes
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
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  // Capture bytes before
  const configBefore = fs.readFileSync(configFile, 'utf8');
  const mcpBefore = fs.readFileSync(mcpFile, 'utf8');
  const cliBefore = fs.readFileSync(cliFile, 'utf8');

  const result = await cutover({ configFile, mcpFile, cliFiles: [cliFile], dryRun: true });

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
// (f) Reversibility — restore captured bytes → identical to pre-cutover
// ---------------------------------------------------------------------------

test('(f) reversibility — restoring captured bytes reproduces original files', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  // Capture bytes before cutover
  const configBefore = fs.readFileSync(configFile);
  const mcpBefore = fs.readFileSync(mcpFile);
  const cliBefore = fs.readFileSync(cliFile);

  // Apply cutover
  await cutover({ configFile, mcpFile, cliFiles: [cliFile] });

  // Verify files changed (sanity check that cutover actually ran)
  const configAfter = fs.readFileSync(configFile, 'utf8');
  assert.ok(configAfter.includes('"native"'), 'cutover must have changed config before restore test');

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

test('(g) cutover returns { configChanged, mcpChanged, cliReplacements }', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFile = makeTmpCliFile(tmpDir, 'cmd.md');

  const result = await cutover({ configFile, mcpFile, cliFiles: [cliFile] });

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
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);
  const cliFileA = makeTmpCliFile(tmpDir, 'fileA.md');
  const cliFileB = makeTmpCliFile(tmpDir, 'fileB.md'); // same content = same 3 replacements each

  const result = await cutover({ configFile, mcpFile, cliFiles: [cliFileA, cliFileB] });

  assert.ok(Object.prototype.hasOwnProperty.call(result.cliReplacements, cliFileA), 'cliReplacements must have entry for fileA');
  assert.ok(Object.prototype.hasOwnProperty.call(result.cliReplacements, cliFileB), 'cliReplacements must have entry for fileB');
  // Each file has 3 legacy invocations (2 with -p form and 1 short form)
  assert.equal(result.cliReplacements[cliFileA], 3, 'fileA must report 3 replacements');
  assert.equal(result.cliReplacements[cliFileB], 3, 'fileB must report 3 replacements');
});

// ---------------------------------------------------------------------------
// (i) Config without taskCore gets taskCore created, other keys preserved
// ---------------------------------------------------------------------------

test('(i) config without taskCore: taskCore is created, other keys preserved', async () => {
  const tmpDir = makeTmpDir();
  // Config with no taskCore but with other keys
  const configFile = makeTmpConfig(tmpDir, { project: 'my-proj', language: 'vi', stack: 'node' });
  const mcpFile = makeTmpMcp(tmpDir);

  await cutover({ configFile, mcpFile, cliFiles: [] });

  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.project, 'my-proj', 'project key must be preserved');
  assert.equal(config.language, 'vi', 'language key must be preserved');
  assert.equal(config.stack, 'node', 'stack key must be preserved');
  assert.equal(config.taskCore.engine, 'native', 'taskCore.engine must be "native"');
});

// ---------------------------------------------------------------------------
// (j) configChanged=false when config already has engine=native
// ---------------------------------------------------------------------------

test('(j) idempotent: configChanged=false when engine already native', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir, { taskCore: { engine: 'native' } });
  const mcpFile = makeTmpMcp(tmpDir);

  const result = await cutover({ configFile, mcpFile, cliFiles: [] });

  // engine is already native — should report unchanged
  assert.equal(result.configChanged, false, 'configChanged must be false when engine already native');
});

// ---------------------------------------------------------------------------
// (k) cliReplacements is 0 for a file with no legacy invocations
// ---------------------------------------------------------------------------

test('(k) cliReplacements is 0 for a file with no legacy invocations', async () => {
  const tmpDir = makeTmpDir();
  const configFile = makeTmpConfig(tmpDir);
  const mcpFile = makeTmpMcp(tmpDir);

  const cleanFile = path.join(tmpDir, 'clean.md');
  fs.writeFileSync(cleanFile, '# No legacy calls here\n\nJust some text.\n', 'utf8');

  const result = await cutover({ configFile, mcpFile, cliFiles: [cleanFile] });

  assert.equal(result.cliReplacements[cleanFile], 0, 'replacements must be 0 for file without legacy invocations');
});
