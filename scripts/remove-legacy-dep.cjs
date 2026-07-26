/**
 * remove-legacy-dep.cjs — final C-7 step: remove task-master-ai@0.43.1 after soak.
 *
 * This is the LAST step in the native-task-manager cutover sequence (FR-009, TC-011).
 * It is deferred until the C-6 monitoring soak is green (allGreen from cutover-monitor).
 *
 * Performs two cleanup actions when the operator runs it after a stable soak:
 *   1. DEPENDENCIES.md   — removes line(s) pinning task-master-ai@0.43.1
 *   2. .mcp.json          — removes any leftover legacy npx task-master-ai entry
 *                           (post-cutover the entry should already be the native node entry;
 *                           this cleans up a leftover legacy entry if somehow still present)
 *
 * Safety guard (D5):
 *   Refuses to proceed unless readEngineConfig() returns 'native'. This ensures the
 *   operator cannot accidentally remove the legacy dep before the engine flip has occurred.
 *   If not native: returns { refused: true, reason: '...' } and writes nothing.
 *
 * USAGE (programmatic):
 *   const { removeLegacyDep } = require('./scripts/remove-legacy-dep.cjs');
 *   const result = await removeLegacyDep({ dependenciesFile, mcpFile, engineConfigFile, dryRun });
 *
 * RETURNS:
 *   { refused: true, reason: string }         — when engine is not native (nothing written)
 *   { depLinesRemoved: number, mcpCleaned: boolean }  — when changes applied (or dryRun reported)
 *
 * CLI runner (require.main === module):
 *   node scripts/remove-legacy-dep.cjs           — dry-run only (shows planned changes)
 *   node scripts/remove-legacy-dep.cjs --confirm — writes changes (requires native engine)
 *
 * Zero external dependencies. Pure Node CommonJS. 'use strict'. All code English.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Default paths (used ONLY by the CLI runner when an operator passes --confirm)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_DEPENDENCIES_FILE = path.join(REPO_ROOT, 'DEPENDENCIES.md');
const DEFAULT_MCP_FILE = path.join(REPO_ROOT, '.mcp.json');
const DEFAULT_ENGINE_CONFIG_FILE = path.join(REPO_ROOT, '.spec-flow', 'config.json');

// ---------------------------------------------------------------------------
// Pattern for task-master-ai@0.43.1 pin in DEPENDENCIES.md
//
// Matches any line (full row) that references task-master-ai@0.43.1.
// Handles the markdown table row format (content between pipe characters).
// ---------------------------------------------------------------------------

const DEP_PIN_PATTERN = /^.*task-master-ai@0\.43\.1.*$/gm;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file.
 *
 * @param {string} filePath
 * @returns {object}
 * @throws {Error} if file cannot be read or parsed
 */
function _readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Write an object as JSON with 2-space indent, terminating with a newline.
 *
 * @param {string} filePath
 * @param {object} data
 */
function _writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Determine whether a .mcp.json task-master-ai entry is the legacy npx form.
 * The legacy entry has command='npx' and args containing 'task-master-ai@0.43.1'.
 *
 * @param {object|undefined} entry
 * @returns {boolean}
 */
function _isLegacyMcpEntry(entry) {
  if (!entry) return false;
  if (entry.command !== 'npx') return false;
  const args = entry.args;
  if (!Array.isArray(args)) return false;
  return args.some((a) => typeof a === 'string' && a.includes('task-master-ai@0.43.1'));
}

/**
 * Remove lines that pin task-master-ai@0.43.1 from a markdown string.
 *
 * Matches two forms:
 *   - Combined:  task-master-ai@0.43.1   (e.g. inline code or URL fragment)
 *   - Separate:  task-master-ai <...> 0.43.1 on the same line
 *                (as in the DEPENDENCIES.md table where the package name
 *                and pinned version are in separate columns)
 *
 * Returns the cleaned content and the count of removed lines.
 *
 * @param {string} content
 * @returns {{ cleaned: string, count: number }}
 */
function _removePinLines(content) {
  const lines = content.split('\n');
  let count = 0;
  const kept = lines.filter((line) => {
    const isPinLine =
      line.includes('task-master-ai@0.43.1') ||
      (line.includes('task-master-ai') && line.includes('0.43.1'));
    if (isPinLine) {
      count++;
      return false;
    }
    return true;
  });
  return { cleaned: kept.join('\n'), count };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove the task-master-ai@0.43.1 legacy dependency (DEPENDENCIES.md + .mcp.json).
 *
 * This function ONLY proceeds when the engine-selector reports 'native' for the
 * provided engineConfigFile. This is the D5 safety guard: you cannot remove the
 * safety net until the cutover is stable.
 *
 * @param {object} [options]
 * @param {string}  [options.dependenciesFile]  - path to DEPENDENCIES.md (default: repo root)
 * @param {string}  [options.mcpFile]           - path to .mcp.json (default: repo root)
 * @param {string}  [options.engineConfigFile]  - path to .spec-flow/config.json (default: repo root)
 * @param {boolean} [options.dryRun=false]      - when true, compute changes but write nothing
 *
 * @returns {Promise<object>}
 *   On refuse: { refused: true, reason: string }
 *   On proceed: { depLinesRemoved: number, mcpCleaned: boolean }
 */
async function removeLegacyDep(options) {
  const opts = options || {};

  const dependenciesFile =
    opts.dependenciesFile !== undefined ? opts.dependenciesFile : DEFAULT_DEPENDENCIES_FILE;
  const mcpFile = opts.mcpFile !== undefined ? opts.mcpFile : DEFAULT_MCP_FILE;
  const engineConfigFile =
    opts.engineConfigFile !== undefined ? opts.engineConfigFile : DEFAULT_ENGINE_CONFIG_FILE;
  const dryRun = opts.dryRun === true;

  // --- D5 Safety guard: refuse unless engine is already 'native' ---

  const { readEngineConfig } = require('../lib/engine-selector.cjs');
  const engine = readEngineConfig({ _configFile: engineConfigFile });

  if (engine !== 'native') {
    return {
      refused: true,
      reason:
        'engine is not native; cutover must be stable before removing the legacy dependency',
    };
  }

  // --- 1. DEPENDENCIES.md: remove lines pinning task-master-ai@0.43.1 ---

  const depsContent = fs.readFileSync(dependenciesFile, 'utf8');
  const { cleaned: depsNew, count: depLinesRemoved } = _removePinLines(depsContent);

  // --- 2. .mcp.json: remove leftover legacy npx entry if present ---

  const mcpData = _readJson(mcpFile);
  const currentEntry = mcpData.mcpServers && mcpData.mcpServers['task-master-ai'];
  const hasLegacyEntry = _isLegacyMcpEntry(currentEntry);

  let mcpCleaned = false;
  let newMcpData = mcpData;

  if (hasLegacyEntry) {
    mcpCleaned = true;
    newMcpData = JSON.parse(JSON.stringify(mcpData)); // deep clone
    delete newMcpData.mcpServers['task-master-ai'];
  }

  // --- dryRun: report planned changes, write nothing ---

  if (dryRun) {
    return { depLinesRemoved, mcpCleaned };
  }

  // --- Write changes ---

  if (depLinesRemoved > 0) {
    fs.writeFileSync(dependenciesFile, depsNew, 'utf8');
  }

  if (mcpCleaned) {
    _writeJson(mcpFile, newMcpData);
  }

  return { depLinesRemoved, mcpCleaned };
}

// ---------------------------------------------------------------------------
// Thin CLI runner (operator-facing)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirm');

  const run = async () => {
    const opts = { dryRun: !confirmed };

    const result = await removeLegacyDep(opts);

    if (result.refused) {
      console.error(`Refused: ${result.reason}`);
      console.error(
        'Run `node scripts/cutover.cjs --confirm` first, then soak the native engine (C-6), then retry.'
      );
      process.exitCode = 1;
      return;
    }

    if (!confirmed) {
      console.log('dry-run only; pass --confirm to apply');
      console.log(`  DEPENDENCIES.md lines to remove: ${result.depLinesRemoved}`);
      console.log(`  .mcp.json legacy entry to clean: ${result.mcpCleaned}`);
      if (result.depLinesRemoved === 0 && !result.mcpCleaned) {
        console.log('  (none — legacy dependency already removed)');
      }
    } else {
      console.log('Legacy dependency removed:');
      console.log(`  dep lines removed: ${result.depLinesRemoved}`);
      console.log(`  mcp entry cleaned: ${result.mcpCleaned}`);
    }
  };

  run().catch((err) => {
    console.error('remove-legacy-dep failed:', err.message);
    process.exitCode = 1;
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { removeLegacyDep };
