/**
 * init.cjs — idempotent .taskmaster/ scaffold for the native task manager.
 *
 * Implements FR-014 / TC-012 (SD §9.3 init subcommand):
 *   - Creates .taskmaster/, .taskmaster/tasks/, .taskmaster/reports/
 *     and writes tasks/tasks.json, state.json, config.json.
 *   - Idempotent: if tasks/tasks.json already exists, prints "Already initialized"
 *     and exits 0 without touching any existing file.
 *   - --yes flag: accepted for non-interactive callers; no prompts are emitted
 *     regardless of its presence or absence.
 *   - NEVER calls process.exit. Returns { stdout, stderr, exitCode }.
 *
 * Public API:
 *   runInit(args, _inject?) → { stdout, stderr, exitCode }
 *
 * args    — parsed CLI flags object (may contain yes: true from --yes flag)
 * _inject — optional { _baseDir?, _paths?: { baseDir? } } for test isolation.
 *           When provided, the base directory is resolved from _inject._baseDir
 *           or _inject._paths.baseDir. Falls back to process.cwd() when absent.
 *
 * Zero external dependencies. Uses only node built-in fs and path modules.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Resolve the base directory for .taskmaster/ placement.
 *
 * Priority:
 *   1. _inject._baseDir — explicit base dir (used by init.test.cjs)
 *   2. _inject._paths.baseDir — alternate injection form
 *   3. process.cwd() — production default
 *
 * @param {object|undefined} _inject
 * @returns {string} absolute base directory path
 */
function _resolveBaseDir(_inject) {
  if (_inject && _inject._baseDir) {
    return _inject._baseDir;
  }
  if (_inject && _inject._paths && _inject._paths.baseDir) {
    return _inject._paths.baseDir;
  }
  return process.cwd();
}

/**
 * Run the init subcommand — create .taskmaster/ idempotently.
 *
 * @param {object}  args     - parsed CLI flags (e.g. { yes: true })
 * @param {object} [_inject] - { _baseDir?, _paths?: { baseDir? } } for test isolation
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
function runInit(args, _inject) {
  const baseDir = _resolveBaseDir(_inject);

  const taskmasterDir = path.join(baseDir, '.taskmaster');
  const tasksDir      = path.join(taskmasterDir, 'tasks');
  const reportsDir    = path.join(taskmasterDir, 'reports');
  const tasksFile     = path.join(tasksDir, 'tasks.json');
  const stateFile     = path.join(taskmasterDir, 'state.json');
  const configFile    = path.join(taskmasterDir, 'config.json');

  // Idempotency check: if tasks.json already exists, report and exit 0
  if (fs.existsSync(tasksFile)) {
    return { stdout: 'Already initialized\n', stderr: '', exitCode: 0 };
  }

  // Create directory structure
  fs.mkdirSync(tasksDir,   { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  // Write initial file contents
  fs.writeFileSync(tasksFile,  JSON.stringify({}, null, 2) + '\n', 'utf8');
  fs.writeFileSync(stateFile,  JSON.stringify({}, null, 2) + '\n', 'utf8');
  fs.writeFileSync(configFile, JSON.stringify({ models: {} }, null, 2) + '\n', 'utf8');

  return { stdout: 'Initialized .taskmaster/\n', stderr: '', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runInit };
