/**
 * ai-config.cjs — Config loader for taskCore aiMode + headlessFallback.
 *
 * Implements FR-001, FR-009, FR-010 (SD §9.2 config loader):
 *   - Reads .spec-flow/config.json and returns the taskCore AI config with
 *     defaults applied.
 *   - Missing file → return default config (aiMode 'agent-native', headlessFallback null).
 *   - Present file → read + JSON.parse, apply defaults on taskCore sub-object.
 *   - Validate headlessFallback STRUCTURE only: if non-null object, must have
 *     string endpoint, model, and apiKey → throw ERR_CONFIG_INVALID if missing.
 *
 * NOTE: aiMode enum validation is NOT done here. That check belongs to
 *   AIRouter.route per SD §9.2 BL-01 / TC-002 (task 1). loadConfig only
 *   defaults a missing aiMode; it passes through whatever string is present.
 *
 * Public API:
 *   loadConfig(_inject?) → configObject
 *
 * _inject — optional object for test isolation:
 *   { _configFile: string } — absolute path to the config file to use instead
 *                             of the default .spec-flow/config.json (relative to cwd).
 *
 * Zero external dependencies. Uses only node built-in fs and path modules.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default config file location relative to cwd. */
const DEFAULT_CONFIG_FILE = path.join('.spec-flow', 'config.json');

/** Default taskCore config applied when the key or file is absent. */
const DEFAULT_TASK_CORE = {
  aiMode: 'agent-native',
  headlessFallback: null,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the config file.
 *
 * Priority:
 *   1. _inject._configFile — explicit path for test isolation (absolute or relative)
 *   2. DEFAULT_CONFIG_FILE — .spec-flow/config.json relative to cwd (production)
 *
 * @param {object|undefined} _inject
 * @returns {string} resolved config file path
 */
function _resolveConfigFile(_inject) {
  if (_inject && typeof _inject._configFile === 'string') {
    return _inject._configFile;
  }
  return path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);
}

/**
 * Validate the headlessFallback structure when it is a non-null object.
 *
 * Rules (FR-010):
 *   - null → valid (disables headless fallback)
 *   - non-null object → must have non-empty string: endpoint, model, apiKey
 *   - Any other value (array, primitive) with all three present fields → passed through
 *     (the caller is responsible for providing a proper object if they use it)
 *
 * @param {*} fallback - the headlessFallback value from config
 * @throws {Error} with .code 'ERR_CONFIG_INVALID' when required fields are missing
 */
function _validateHeadlessFallback(fallback) {
  if (fallback === null || fallback === undefined) {
    // null or undefined → valid (disables fallback)
    return;
  }

  if (typeof fallback !== 'object' || Array.isArray(fallback)) {
    // Non-object value (besides null) — treat as config error only if it lacks the fields
    // For robustness, validate field presence even on edge-case values
    const err = new Error('headlessFallback requires endpoint, model, apiKey');
    err.code = 'ERR_CONFIG_INVALID';
    throw err;
  }

  const missing = ['endpoint', 'model', 'apiKey'].filter(
    (field) => typeof fallback[field] !== 'string' || fallback[field].length === 0
  );

  if (missing.length > 0) {
    const err = new Error('headlessFallback requires endpoint, model, apiKey');
    err.code = 'ERR_CONFIG_INVALID';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and return the resolved taskCore AI config from .spec-flow/config.json.
 *
 * Defaults are applied when the file is missing or when the taskCore sub-object
 * (or individual fields) is absent. aiMode enum validation is intentionally
 * omitted — that check belongs to AIRouter.route (task 1, TC-002).
 *
 * @param {object} [_inject] - optional { _configFile } for test isolation
 * @returns {{ taskCore: { aiMode: string, headlessFallback: object|null }, ...rest }}
 * @throws {Error} with .code 'ERR_CONFIG_INVALID' when headlessFallback is malformed
 */
function loadConfig(_inject) {
  const configFile = _resolveConfigFile(_inject);

  // Missing file → return defaults
  if (!fs.existsSync(configFile)) {
    return {
      taskCore: {
        aiMode: DEFAULT_TASK_CORE.aiMode,
        headlessFallback: DEFAULT_TASK_CORE.headlessFallback,
      },
    };
  }

  // Read and parse the config file
  const raw = fs.readFileSync(configFile, 'utf8');
  const parsed = JSON.parse(raw);

  // Apply defaults on taskCore sub-object
  const taskCoreRaw = parsed.taskCore && typeof parsed.taskCore === 'object'
    ? parsed.taskCore
    : {};

  const aiMode = typeof taskCoreRaw.aiMode === 'string'
    ? taskCoreRaw.aiMode
    : DEFAULT_TASK_CORE.aiMode;

  const headlessFallback = taskCoreRaw.headlessFallback !== undefined
    ? taskCoreRaw.headlessFallback
    : DEFAULT_TASK_CORE.headlessFallback;

  // Validate headlessFallback structure (FR-010)
  _validateHeadlessFallback(headlessFallback);

  // Return the full config with taskCore defaulted
  return {
    ...parsed,
    taskCore: {
      ...taskCoreRaw,
      aiMode,
      headlessFallback,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { loadConfig };
