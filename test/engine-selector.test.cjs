/**
 * Unit tests for lib/engine-selector.cjs — canonical config-level engine reader.
 *
 * Covers:
 *   TC-001  missing config file → 'native' (shipped default, FR-002)
 *   TC-001  taskCore absent from config → 'native'
 *   TC-001  taskCore.engine = null / '' → 'native'; explicit 'legacy' → 'legacy'
 *   TC-002  taskCore.engine = 'native' → 'native' (FR-002)
 *   TC-003  unknown engine value → 'native' + stderr warning (FR-003)
 *   Extra   parse error (malformed JSON) → rethrows (not ENOENT)
 *   Extra   read-once-per-call (no caching) — two calls with different injected files
 *           return independently resolved values (D3)
 *
 * Each test uses os.mkdtemp-isolated tmp dirs with an injected _configFile so
 * the real .spec-flow/config.json is NEVER touched during testing.
 *
 * Run:  node test/engine-selector.test.cjs
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

let engineSelector;
test('engine-selector module imports without throwing', () => {
  engineSelector = require('../lib/engine-selector.cjs');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-selector-test-'));
}

/**
 * Write a config file with the given taskCore.engine value and return its path.
 *
 * @param {string}          tmpDir
 * @param {string|null|undefined} engineValue
 *   - undefined → write config WITHOUT taskCore key at all
 *   - null      → write config with taskCore:{} (engine field absent)
 *   - ''        → write config with taskCore:{engine:''}
 *   - any other string → write config with taskCore:{engine: engineValue}
 */
function makeConfigFile(tmpDir, engineValue) {
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  let config;
  if (engineValue === undefined) {
    // No taskCore key at all
    config = { project: 'test' };
  } else if (engineValue === null) {
    // taskCore exists but engine field is absent
    config = { taskCore: {} };
  } else {
    config = { taskCore: { engine: engineValue } };
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  return configFile;
}

/**
 * Capture text written to process.stderr during fn() execution.
 * Returns the captured string.
 *
 * @param {() => *} fn  synchronous function to call
 * @returns {string}
 */
function captureStderr(fn) {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// TC-001 — Missing config file → 'native' (shipped default, FR-002)
// ---------------------------------------------------------------------------

test('TC-001: missing config file returns native', () => {
  const tmpDir = makeTmpDir();
  // Do NOT create any config file — simulate ENOENT
  const _configFile = path.join(tmpDir, '.spec-flow', 'config.json');

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'native',
    'readEngineConfig must return native when config file is missing');
});

// ---------------------------------------------------------------------------
// TC-001 — taskCore key absent from config → 'native'
// ---------------------------------------------------------------------------

test('TC-001: taskCore absent in config returns native', () => {
  const tmpDir = makeTmpDir();
  // engineValue=undefined → writes config WITHOUT taskCore key
  const _configFile = makeConfigFile(tmpDir, undefined);

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'native',
    'readEngineConfig must return native when taskCore is absent');
});

// ---------------------------------------------------------------------------
// TC-001 — taskCore exists but engine field is absent → 'native'
// ---------------------------------------------------------------------------

test('TC-001: taskCore.engine absent (empty taskCore object) returns native', () => {
  const tmpDir = makeTmpDir();
  // engineValue=null → writes config with taskCore:{} (no engine field)
  const _configFile = makeConfigFile(tmpDir, null);

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'native',
    'readEngineConfig must return native when taskCore.engine field is missing');
});

// ---------------------------------------------------------------------------
// TC-001 — taskCore.engine = null → 'legacy'
// ---------------------------------------------------------------------------

test('TC-001: taskCore.engine = null returns native', () => {
  const tmpDir = makeTmpDir();
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const _configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(_configFile, JSON.stringify({ taskCore: { engine: null } }), 'utf8');

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'native',
    'readEngineConfig must return native when taskCore.engine is null');
});

// ---------------------------------------------------------------------------
// TC-001 — taskCore.engine = '' → 'native'
// ---------------------------------------------------------------------------

test('TC-001: taskCore.engine empty string returns native', () => {
  const tmpDir = makeTmpDir();
  // engineValue='' → writes config with taskCore:{engine:''}
  const _configFile = makeConfigFile(tmpDir, '');

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'native',
    'readEngineConfig must return native when taskCore.engine is empty string');
});

// ---------------------------------------------------------------------------
// TC-001 — taskCore.engine = 'legacy' → 'legacy'
// ---------------------------------------------------------------------------

test('TC-001: taskCore.engine = legacy returns legacy', () => {
  const tmpDir = makeTmpDir();
  const _configFile = makeConfigFile(tmpDir, 'legacy');

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'legacy',
    'readEngineConfig must return legacy when taskCore.engine is explicitly legacy');
});

// ---------------------------------------------------------------------------
// TC-002 — taskCore.engine = 'native' → 'native' (opt-in, FR-002)
// ---------------------------------------------------------------------------

test('TC-002: taskCore.engine = native returns native', () => {
  const tmpDir = makeTmpDir();
  const _configFile = makeConfigFile(tmpDir, 'native');

  const result = engineSelector.readEngineConfig({ _configFile });

  assert.equal(result, 'native',
    'readEngineConfig must return native when taskCore.engine is native');
});

// ---------------------------------------------------------------------------
// TC-003 — Unknown engine value → 'native' + stderr warning (FR-003)
// No silent implicit legacy (a removed dependency) for an unrecognised value.
// ---------------------------------------------------------------------------

test('TC-003: unknown engine value returns native and writes stderr warning', () => {
  const tmpDir = makeTmpDir();
  const _configFile = makeConfigFile(tmpDir, 'foo');

  let result;
  const stderrOutput = captureStderr(() => {
    result = engineSelector.readEngineConfig({ _configFile });
  });

  assert.equal(result, 'native',
    'readEngineConfig must return native for unknown engine value');
  assert.ok(stderrOutput.length > 0,
    'a warning must be written to stderr for unknown engine values');
  assert.ok(stderrOutput.includes('foo'),
    `stderr warning must include the unknown value 'foo'; got: ${stderrOutput}`);
});

test('TC-003: another unknown value (bar) also returns native with stderr warning', () => {
  const tmpDir = makeTmpDir();
  const _configFile = makeConfigFile(tmpDir, 'bar');

  let result;
  const stderrOutput = captureStderr(() => {
    result = engineSelector.readEngineConfig({ _configFile });
  });

  assert.equal(result, 'native',
    'readEngineConfig must return native for any unknown engine value');
  assert.ok(stderrOutput.includes('bar'),
    `stderr warning must include the value 'bar'; got: ${stderrOutput}`);
});

// ---------------------------------------------------------------------------
// Extra — parse error (malformed JSON) must rethrow (not ENOENT path)
// ---------------------------------------------------------------------------

test('Extra: malformed JSON config rethrows SyntaxError', () => {
  const tmpDir = makeTmpDir();
  const configDir = path.join(tmpDir, '.spec-flow');
  fs.mkdirSync(configDir, { recursive: true });
  const _configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(_configFile, '{ not valid json !!!', 'utf8');

  assert.throws(
    () => engineSelector.readEngineConfig({ _configFile }),
    (err) => err instanceof SyntaxError,
    'malformed JSON must cause readEngineConfig to rethrow a SyntaxError'
  );
});

// ---------------------------------------------------------------------------
// Extra — default config path: no _inject → uses .spec-flow/config.json
// (when cwd has no .spec-flow/config.json, must return native, not throw)
// ---------------------------------------------------------------------------

test('Extra: no inject uses default path, returns native when file missing', () => {
  // We cannot control cwd between calls, so just verify no throw and legacy returned.
  // The real .spec-flow/config.json may or may not exist; either way must not throw.
  let result;
  assert.doesNotThrow(() => {
    result = engineSelector.readEngineConfig();
  });
  // Result must be either 'legacy' or 'native' — whatever the actual config says.
  assert.ok(result === 'legacy' || result === 'native',
    `result must be 'legacy' or 'native'; got: ${result}`);
});

// ---------------------------------------------------------------------------
// Extra — read-once-per-call (D3 — no caching)
// Two successive calls with DIFFERENT injected config files must return
// independently resolved values, proving no memoisation.
// ---------------------------------------------------------------------------

test('Extra: no caching — two calls with different configs return different values', () => {
  const tmpA = makeTmpDir();
  const tmpB = makeTmpDir();
  const configA = makeConfigFile(tmpA, 'legacy');
  const configB = makeConfigFile(tmpB, 'native');

  const resultA = engineSelector.readEngineConfig({ _configFile: configA });
  const resultB = engineSelector.readEngineConfig({ _configFile: configB });

  assert.equal(resultA, 'legacy', 'first call (legacy config) must return legacy');
  assert.equal(resultB, 'native', 'second call (native config) must return native');
});
