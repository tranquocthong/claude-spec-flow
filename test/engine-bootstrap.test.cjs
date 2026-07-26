/**
 * Unit tests for lib/engine-bootstrap.cjs — MCP + CLI binding descriptors.
 *
 * Covers:
 *   (a) mcpServerEntry('legacy')  → matches repo .mcp.json legacy entry exactly
 *   (b) mcpServerEntry('native')  → node bin/mcp-server.js entry
 *   (c) cliInvocation('legacy', subcommand, args) → npx form with flags
 *   (d) cliInvocation('native', subcommand, args) → node bin/task-master form with flags
 *   (e) activeBinding with injected legacy config → legacy binding returned
 *   (f) activeBinding with injected native config → native binding returned
 *   (g) mcpServerEntry with unknown engine → throws Error
 *   (h) cliInvocation with unknown engine → throws Error
 *   (i) descriptors only — module must NOT export file-writing functions
 *
 * Tests use node:test + node:assert/strict. _configFile injection is passed to
 * activeBinding so the real .spec-flow/config.json is NEVER touched.
 *
 * Run:  node test/engine-bootstrap.test.cjs
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

let engineBootstrap;
test('engine-bootstrap module imports without throwing', () => {
  engineBootstrap = require('../lib/engine-bootstrap.cjs');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-bootstrap-test-'));
}

/**
 * Write a config file with the given taskCore.engine value and return its path.
 *
 * @param {string} tmpDir
 * @param {string} engineValue - 'legacy' | 'native'
 */
function makeConfigFile(tmpDir, engineValue) {
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  const config = { taskCore: { engine: engineValue } };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  return configFile;
}

// ---------------------------------------------------------------------------
// (a) mcpServerEntry('legacy') → must match .mcp.json legacy entry exactly
// ---------------------------------------------------------------------------

test('(a) mcpServerEntry legacy matches repo .mcp.json legacy entry', () => {
  // Expected: what the repo .mcp.json currently has for task-master-ai.
  // This is the canonical legacy entry — the module must return an identical shape.
  const expected = {
    command: 'npx',
    args: ['-y', 'task-master-ai@0.43.1'],
    env: { TASK_MASTER_TOOLS: 'standard' },
  };

  const result = engineBootstrap.mcpServerEntry('legacy');

  assert.deepEqual(result, expected,
    'mcpServerEntry("legacy") must exactly match the current repo .mcp.json legacy entry');
});

// ---------------------------------------------------------------------------
// (b) mcpServerEntry('native') → node bin/mcp-server.js
// ---------------------------------------------------------------------------

test('(b) mcpServerEntry native returns node bin/mcp-server.js entry', () => {
  const result = engineBootstrap.mcpServerEntry('native');

  assert.equal(result.command, 'node',
    'mcpServerEntry("native").command must be "node"');
  assert.deepEqual(result.args, ['bin/mcp-server.js'],
    'mcpServerEntry("native").args must be ["bin/mcp-server.js"]');
  // Must NOT have an env field (or it must be absent/undefined)
  assert.ok(!result.env,
    'mcpServerEntry("native") must not include an env field');
});

// ---------------------------------------------------------------------------
// (c) cliInvocation('legacy', ...) → npx -y task-master-ai@0.43.1 form
// ---------------------------------------------------------------------------

test('(c) cliInvocation legacy without args returns npx form', () => {
  const result = engineBootstrap.cliInvocation('legacy', 'get-tasks', []);

  assert.equal(result.command, 'npx',
    'cliInvocation("legacy").command must be "npx"');
  assert.ok(Array.isArray(result.args),
    'cliInvocation("legacy").args must be an array');
  assert.ok(result.args.includes('-y'),
    'legacy args must include -y flag');
  assert.ok(result.args.includes('task-master-ai@0.43.1'),
    'legacy args must include task-master-ai@0.43.1');
  assert.ok(result.args.includes('get-tasks'),
    'legacy args must include the subcommand');
});

test('(c) cliInvocation legacy with flags appends them to args', () => {
  const flags = ['--tag', 'main', '--status', 'pending'];
  const result = engineBootstrap.cliInvocation('legacy', 'get-tasks', flags);

  // flags must appear after the subcommand
  const subcmdIdx = result.args.indexOf('get-tasks');
  assert.ok(subcmdIdx >= 0, 'subcommand must appear in args');
  const tail = result.args.slice(subcmdIdx + 1);
  assert.deepEqual(tail, flags,
    'flags must be appended after the subcommand');
});

// ---------------------------------------------------------------------------
// (d) cliInvocation('native', ...) → node bin/task-master form
// ---------------------------------------------------------------------------

test('(d) cliInvocation native without args returns node bin/task-master form', () => {
  const result = engineBootstrap.cliInvocation('native', 'get-tasks', []);

  assert.equal(result.command, 'node',
    'cliInvocation("native").command must be "node"');
  assert.ok(Array.isArray(result.args),
    'cliInvocation("native").args must be an array');
  assert.ok(result.args.includes('bin/task-master'),
    'native args must include bin/task-master');
  assert.ok(result.args.includes('get-tasks'),
    'native args must include the subcommand');
});

test('(d) cliInvocation native with flags appends them to args', () => {
  const flags = ['--tag', 'feature', '--id', '42'];
  const result = engineBootstrap.cliInvocation('native', 'update-task', flags);

  assert.equal(result.command, 'node');
  const subcmdIdx = result.args.indexOf('update-task');
  assert.ok(subcmdIdx >= 0, 'subcommand must appear in args');
  const tail = result.args.slice(subcmdIdx + 1);
  assert.deepEqual(tail, flags,
    'flags must be appended after the subcommand for native');
});

// ---------------------------------------------------------------------------
// (e) activeBinding with injected legacy config → legacy binding
// ---------------------------------------------------------------------------

test('(e) activeBinding with legacy config returns legacy engine binding', () => {
  const tmpDir = makeTmpDir();
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const binding = engineBootstrap.activeBinding({ _configFile });

  assert.equal(binding.engine, 'legacy',
    'activeBinding must return engine=legacy when config is set to legacy');
  // mcp entry must be the legacy entry
  assert.equal(binding.mcp.command, 'npx',
    'binding.mcp.command must be npx for legacy');
  assert.ok(binding.mcp.args.includes('task-master-ai@0.43.1'),
    'binding.mcp.args must include task-master-ai@0.43.1 for legacy');
  // cli function must be callable and return legacy form
  assert.ok(typeof binding.cli === 'function',
    'binding.cli must be a function');
  const cliResult = binding.cli('list-tasks', []);
  assert.equal(cliResult.command, 'npx',
    'binding.cli() must return npx invocation for legacy engine');
});

// ---------------------------------------------------------------------------
// (f) activeBinding with injected native config → native binding
// ---------------------------------------------------------------------------

test('(f) activeBinding with native config returns native engine binding', () => {
  const tmpDir = makeTmpDir();
  const _configFile = makeConfigFile(tmpDir, 'native');

  const binding = engineBootstrap.activeBinding({ _configFile });

  assert.equal(binding.engine, 'native',
    'activeBinding must return engine=native when config is set to native');
  // mcp entry must be the native entry
  assert.equal(binding.mcp.command, 'node',
    'binding.mcp.command must be node for native');
  assert.deepEqual(binding.mcp.args, ['bin/mcp-server.js'],
    'binding.mcp.args must be [bin/mcp-server.js] for native');
  // cli function must be callable and return native form
  assert.ok(typeof binding.cli === 'function',
    'binding.cli must be a function');
  const cliResult = binding.cli('get-tasks', ['--tag', 'main']);
  assert.equal(cliResult.command, 'node',
    'binding.cli() must return node invocation for native engine');
  assert.ok(cliResult.args.includes('bin/task-master'),
    'binding.cli() args must include bin/task-master for native engine');
});

// ---------------------------------------------------------------------------
// (g) mcpServerEntry with unknown engine → throws Error
// ---------------------------------------------------------------------------

test('(g) mcpServerEntry with unknown engine throws Error', () => {
  assert.throws(
    () => engineBootstrap.mcpServerEntry('unknown-engine'),
    (err) => err instanceof Error,
    'mcpServerEntry must throw Error for unknown engine'
  );
});

test('(g) mcpServerEntry with null engine throws Error', () => {
  assert.throws(
    () => engineBootstrap.mcpServerEntry(null),
    (err) => err instanceof Error,
    'mcpServerEntry must throw Error for null engine'
  );
});

// ---------------------------------------------------------------------------
// (h) cliInvocation with unknown engine → throws Error
// ---------------------------------------------------------------------------

test('(h) cliInvocation with unknown engine throws Error', () => {
  assert.throws(
    () => engineBootstrap.cliInvocation('bogus', 'get-tasks', []),
    (err) => err instanceof Error,
    'cliInvocation must throw Error for unknown engine'
  );
});

// ---------------------------------------------------------------------------
// (i) Descriptors only — module must NOT export file-writing utilities
// (side-effect guard: no writeFileSync, no bindings rewrite, etc.)
// ---------------------------------------------------------------------------

test('(i) module exports only the three documented functions', () => {
  const exports = Object.keys(engineBootstrap).sort();
  assert.deepEqual(exports, ['activeBinding', 'cliInvocation', 'mcpServerEntry'],
    'module must export exactly mcpServerEntry, cliInvocation, activeBinding — no extra side-effecting exports');
});

// ---------------------------------------------------------------------------
// activeBinding with missing config → falls back to legacy (engine-selector behaviour)
// ---------------------------------------------------------------------------

test('activeBinding with missing config file returns legacy binding', () => {
  const tmpDir = makeTmpDir();
  // Do NOT create a config file — simulates ENOENT → engine-selector returns legacy
  const _configFile = path.join(tmpDir, '.spec-flow', 'config.json');

  const binding = engineBootstrap.activeBinding({ _configFile });

  assert.equal(binding.engine, 'legacy',
    'activeBinding must fall back to legacy when config file is missing');
});
