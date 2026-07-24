/**
 * models-shim.cjs — No-op shim for the `models` subcommand.
 *
 * Implements the models subcommand contract (SD §9.3, FR-015, decision D2):
 *   - ALWAYS exits 0 regardless of flags.
 *   - Accepts --set-main, --set-research, --set-fallback, --claude-code
 *     with NO validation (any string value is accepted).
 *   - Logs a no-op line to stderr plus one indented line per provided flag.
 *   - Compat write (D2): if .taskmaster/config.json exists, writes
 *     config.models.main/research/fallback for each provided --set-* flag,
 *     atomically (temp file + fs.renameSync). Any write error is swallowed —
 *     the shim must NEVER fail.
 *   - NEVER calls process.exit.
 *
 * Public API:
 *   runModels(args, _inject?) → Promise<{ stdout, stderr, exitCode }>
 *
 * args    — array of args AFTER 'models' subcommand name
 *           (e.g. ['--set-main', 'claude-3-5-sonnet', '--claude-code'])
 * _inject — optional { _configFile? } for test isolation.
 *           _configFile defaults to '.taskmaster/config.json' relative to cwd.
 *
 * Zero external dependencies. Uses parseArgs from lib/core.cjs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs } = require('./core.cjs');

// Default path for the task-master compat config file
const DEFAULT_CONFIG_FILE = path.join('.taskmaster', 'config.json');

/**
 * Run the models no-op shim.
 *
 * @param {string[]} args     - CLI args after the 'models' subcommand
 * @param {object}  [_inject] - { _configFile? } for test isolation
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function runModels(args, _inject) {
  const parsed = parseArgs(args || []);

  const setMain = parsed['set-main'];
  const setResearch = parsed['set-research'];
  const setFallback = parsed['set-fallback'];
  const claudeCode = parsed['claude-code'];

  // Build stderr log lines (English only)
  const logLines = ['models shim: no-op'];
  if (setMain !== undefined && setMain !== true) {
    logLines.push(`  --set-main ${setMain}`);
  }
  if (setResearch !== undefined && setResearch !== true) {
    logLines.push(`  --set-research ${setResearch}`);
  }
  if (setFallback !== undefined && setFallback !== true) {
    logLines.push(`  --set-fallback ${setFallback}`);
  }
  if (claudeCode) {
    logLines.push('  --claude-code');
  }

  const stderrOutput = logLines.join('\n') + '\n';

  // Compat write (D2): update .taskmaster/config.json if it exists
  const configFile = (_inject && _inject._configFile)
    ? _inject._configFile
    : path.resolve(DEFAULT_CONFIG_FILE);

  try {
    if (fs.existsSync(configFile)) {
      let config;
      try {
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      } catch (_readErr) {
        // Malformed JSON — skip write, swallow error
        config = null;
      }

      if (config !== null && typeof config === 'object') {
        // Ensure config.models exists
        if (!config.models || typeof config.models !== 'object') {
          config.models = {};
        }

        // Apply each --set-* flag
        if (setMain !== undefined && setMain !== true) {
          config.models.main = String(setMain);
        }
        if (setResearch !== undefined && setResearch !== true) {
          config.models.research = String(setResearch);
        }
        if (setFallback !== undefined && setFallback !== true) {
          config.models.fallback = String(setFallback);
        }

        // Atomic write: temp file in the same directory + renameSync
        const configDir = path.dirname(configFile);
        const tmpFile = path.join(configDir, `.models-shim-tmp-${process.pid}-${Date.now()}`);
        try {
          fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
          fs.renameSync(tmpFile, configFile);
        } catch (_writeErr) {
          // Clean up temp file if rename failed, then swallow
          try { fs.unlinkSync(tmpFile); } catch (_) {} // ignore cleanup error
        }
      }
    }
    // If config file does not exist — skip silently (no error)
  } catch (_outerErr) {
    // Swallow any unexpected error — the shim must never fail
  }

  return {
    stdout: '',
    stderr: stderrOutput,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runModels };
