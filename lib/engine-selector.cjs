/**
 * engine-selector.cjs — canonical config-level engine reader.
 *
 * Used by the cutover script, rollback script, and /sf:doctor gate to
 * determine which task engine is configured, independently of the MCP
 * routing layer (engine-router.cjs).
 *
 * Public API (FR-002, FR-003, decision D3):
 *   readEngineConfig(_inject?) → 'legacy' | 'native'
 *
 * Value semantics (consistent with engine-router.cjs):
 *   - Default is 'native' (official engine as of the cutover release).
 *   - An explicit taskCore.engine = 'legacy' remains a supported rollback escape hatch.
 *   - Any unknown value produces a stderr warning and falls back to 'native'
 *     (no silent implicit legacy).
 *
 * Error handling:
 *   - ENOENT (missing file) → return 'native' (the shipped default).
 *   - Any other read/parse error → rethrow (caller must handle).
 *
 * Caching: none. Every call re-reads config.json (D3).
 *
 * Path injection:
 *   Pass { _configFile: '/absolute/path/to/config.json' } for tests.
 *   Production callers omit _inject (or pass undefined/null).
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default location of .spec-flow/config.json, relative to cwd. */
const DEFAULT_CONFIG_FILE = path.join('.spec-flow', 'config.json');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file synchronously.
 *
 * @param {string} configFile - path to the JSON file
 * @returns {object|null}     - parsed object, or null on ENOENT
 * @throws {Error|SyntaxError} on any non-ENOENT error or malformed JSON
 */
function _readConfig(configFile) {
  let raw;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw); // SyntaxError propagates to caller on malformed JSON
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read taskCore.engine from .spec-flow/config.json and return the resolved
 * engine identifier.
 *
 * @param {object}  [_inject]              - optional injection for tests
 * @param {string}  [_inject._configFile]  - override config.json path
 * @returns {'legacy'|'native'}
 */
function readEngineConfig(_inject) {
  const inject = _inject || {};
  const configFile = inject._configFile || DEFAULT_CONFIG_FILE;

  // Read once per call — no caching (D3).
  const config = _readConfig(configFile); // throws on non-ENOENT errors

  // Missing file → 'native' (shipped default).
  if (config === null) {
    return 'native';
  }

  // Extract engine value; absent / null / '' → 'native'.
  const engine = config.taskCore && config.taskCore.engine;

  if (!engine) {
    // Covers: taskCore absent, taskCore.engine absent, null, or ''
    return 'native';
  }

  if (engine === 'legacy') {
    return 'legacy';
  }

  if (engine === 'native') {
    return 'native';
  }

  // Unknown value — warn to stderr and fall back to native (FR-003).
  // Must not silently enable legacy (a removed dependency) for an unrecognised value.
  process.stderr.write(
    `[engine-selector] Unknown taskCore.engine '${engine}', defaulting to native\n`
  );
  return 'native';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { readEngineConfig };
