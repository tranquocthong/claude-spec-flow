/**
 * rollback.cjs — inverse of cutover.cjs; restores legacy bindings instantly.
 *
 * Performs three coordinated file changes that undo a native-task-manager cutover:
 *   1. .spec-flow/config.json → sets taskCore.engine = 'legacy' (preserve other keys)
 *   2. .mcp.json              → restores task-master-ai entry to legacy npx entry
 *   3. CLI files (commands/ + skills/) → rewrites native node invocations back to
 *      the legacy npx -y -p task-master-ai@0.43.1 task-master <sub> form
 *
 * Also exports verifyTasksIntact({ tasksFile }) for TC-010 spot-check:
 *   reads tasks.json, validates via tasks-json-schema, returns { ok, tagCount, taskCount }
 *   so an operator can confirm no records were lost after rollback.
 *
 * SAFETY: The thin CLI runner requires --confirm to write anything. Running
 * `node scripts/rollback.cjs` without --confirm is a no-op (dry-run only).
 *
 * In tests, pass all paths explicitly via the options object — the defaults are
 * NEVER used in test contexts (os.mkdtemp isolation is enforced by the caller).
 *
 * Usage:
 *   const { rollback, verifyTasksIntact } = require('./scripts/rollback.cjs');
 *   const result = await rollback({ configFile, mcpFile, cliFiles, dryRun });
 *
 * Returns:
 *   { configChanged, mcpChanged, cliReplacements: { [filePath]: count } }
 *   When dryRun=true also includes: { changes: [ { file, description } ] }
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Default paths (used ONLY by the CLI runner when an operator passes --confirm)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_CONFIG_FILE = path.join(REPO_ROOT, '.spec-flow', 'config.json');
const DEFAULT_MCP_FILE = path.join(REPO_ROOT, '.mcp.json');
const DEFAULT_CLI_FILES = [
  path.join(REPO_ROOT, 'commands', 'resync.md'),
  path.join(REPO_ROOT, 'commands', 'ingest.md'),
  path.join(REPO_ROOT, 'commands', 'init.md'),
  path.join(REPO_ROOT, 'commands', 'phase.md'),
  path.join(REPO_ROOT, 'skills', 'srs-to-sd', 'SKILL.md'),
];

// ---------------------------------------------------------------------------
// Regex patterns for native CLI invocations
//
// Pattern: node bin/task-master <subcommand...>
// Replaced with: npx -y -p task-master-ai@0.43.1 task-master <subcommand...>
//
// The replacement is done on the prefix only so flags after the subcommand
// remain intact.
// ---------------------------------------------------------------------------

const NATIVE_PATTERN = /node bin\/task-master /g;
const LEGACY_CLI_PREFIX = 'npx -y -p task-master-ai@0.43.1 task-master ';

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
 * Apply regex substitution to restore native CLI invocations to legacy form.
 * Returns the new content and count of replacements made.
 *
 * @param {string} content
 * @returns {{ newContent: string, count: number }}
 */
function _applyCliRollback(content) {
  let count = 0;

  const result = content.replace(NATIVE_PATTERN, () => {
    count++;
    return LEGACY_CLI_PREFIX;
  });

  return { newContent: result, count };
}

/**
 * Determine whether the config already has taskCore.engine === 'legacy'.
 *
 * @param {object} config
 * @returns {boolean}
 */
function _configAlreadyLegacy(config) {
  return (
    config.taskCore &&
    typeof config.taskCore === 'object' &&
    config.taskCore.engine === 'legacy'
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform (or simulate) the atomic rollback — inverse of cutover.
 *
 * @param {object} [options]
 * @param {string}   [options.configFile]  - path to .spec-flow/config.json (default: repo root)
 * @param {string}   [options.mcpFile]     - path to .mcp.json (default: repo root)
 * @param {string[]} [options.cliFiles]    - paths to CLI files to rewrite (default: 5 files)
 * @param {boolean}  [options.dryRun=false] - when true, compute changes but write nothing
 *
 * @returns {Promise<object>} summary object (always resolved, never rejected for
 *   normal flow; throws only on I/O or parse errors)
 */
async function rollback(options) {
  const opts = options || {};

  const configFile = opts.configFile !== undefined ? opts.configFile : DEFAULT_CONFIG_FILE;
  const mcpFile = opts.mcpFile !== undefined ? opts.mcpFile : DEFAULT_MCP_FILE;
  const cliFiles = opts.cliFiles !== undefined ? opts.cliFiles : DEFAULT_CLI_FILES;
  const dryRun = opts.dryRun === true;

  // --- 1. Config: set taskCore.engine = 'legacy' ---

  const config = _readJson(configFile);
  const configAlreadyLegacy = _configAlreadyLegacy(config);
  let configChanged = false;

  const newConfig = Object.assign({}, config);
  if (!configAlreadyLegacy) {
    newConfig.taskCore = Object.assign({}, config.taskCore || {}, { engine: 'legacy' });
    configChanged = true;
  }

  // --- 2. MCP: restore task-master-ai entry to legacy entry ---

  const { mcpServerEntry } = require('../lib/engine-bootstrap.cjs');
  const legacyMcpEntry = mcpServerEntry('legacy');

  const mcpData = _readJson(mcpFile);
  const currentEntry = mcpData.mcpServers && mcpData.mcpServers['task-master-ai'];

  // Check if entry is already the legacy npx entry
  const mcpAlreadyLegacy =
    currentEntry &&
    currentEntry.command === legacyMcpEntry.command &&
    JSON.stringify(currentEntry.args) === JSON.stringify(legacyMcpEntry.args);

  let mcpChanged = false;
  const newMcpData = JSON.parse(JSON.stringify(mcpData)); // deep clone
  if (!mcpAlreadyLegacy) {
    newMcpData.mcpServers = Object.assign({}, mcpData.mcpServers, {
      'task-master-ai': legacyMcpEntry,
    });
    mcpChanged = true;
  }

  // --- 3. CLI files: replace native invocations with legacy form ---

  const cliReplacements = {};
  const cliChanges = []; // { file, originalContent, newContent, count }

  for (const filePath of cliFiles) {
    const originalContent = fs.readFileSync(filePath, 'utf8');
    const { newContent, count } = _applyCliRollback(originalContent);
    cliReplacements[filePath] = count;
    cliChanges.push({ file: filePath, originalContent, newContent, count });
  }

  // --- dryRun: build changes list and return without writing ---

  if (dryRun) {
    const changes = [];
    if (configChanged) {
      changes.push({ file: configFile, description: 'set taskCore.engine = "legacy"' });
    }
    if (mcpChanged) {
      changes.push({ file: mcpFile, description: 'restore task-master-ai entry to legacy npx entry' });
    }
    for (const c of cliChanges) {
      if (c.count > 0) {
        changes.push({ file: c.file, description: `restore ${c.count} native node invocation(s) to legacy npx form` });
      }
    }
    return {
      configChanged,
      mcpChanged,
      cliReplacements,
      changes,
    };
  }

  // --- Write changes ---

  if (configChanged) {
    _writeJson(configFile, newConfig);
  }

  if (mcpChanged) {
    _writeJson(mcpFile, newMcpData);
  }

  for (const c of cliChanges) {
    if (c.count > 0) {
      fs.writeFileSync(c.file, c.newContent, 'utf8');
    }
  }

  return { configChanged, mcpChanged, cliReplacements };
}

/**
 * Spot-check that tasks.json has no data loss (R-3 / TC-010).
 *
 * Reads the tasks.json at the injected path, validates via tasks-json-schema,
 * and returns { ok, tagCount, taskCount } so an operator can confirm no records
 * were lost after rollback.
 *
 * @param {object} _inject - injection object for test isolation
 * @param {string} _inject.tasksFile - path to tasks.json to validate
 * @returns {Promise<{ ok: boolean, tagCount: number, taskCount: number }>}
 */
async function verifyTasksIntact(_inject) {
  const { validateTasksJson } = require('../lib/tasks-json-schema.cjs');

  const inject = _inject || {};
  const tasksFile = inject.tasksFile;

  if (!tasksFile) {
    throw new Error('[rollback] verifyTasksIntact requires _inject.tasksFile to be set');
  }

  let raw;
  try {
    raw = fs.readFileSync(tasksFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // No tasks file — nothing to lose; treat as 0 tags, 0 tasks
      return { ok: true, tagCount: 0, taskCount: 0 };
    }
    throw e;
  }

  const data = JSON.parse(raw);
  const result = validateTasksJson(data);

  if (!result.valid) {
    return { ok: false, tagCount: 0, taskCount: 0 };
  }

  // Count tags and total tasks across all tags
  const tags = Object.keys(data);
  let taskCount = 0;
  for (const tag of tags) {
    const tasks = (data[tag] && Array.isArray(data[tag].tasks)) ? data[tag].tasks : [];
    taskCount += tasks.length;
  }

  return { ok: true, tagCount: tags.length, taskCount };
}

// ---------------------------------------------------------------------------
// Thin CLI runner (operator-facing)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirm');

  if (!confirmed) {
    console.log('dry-run only; pass --confirm to apply');
    rollback({ dryRun: true }).then((result) => {
      console.log('Planned changes:');
      (result.changes || []).forEach((c) => {
        console.log(`  ${c.file}: ${c.description}`);
      });
      if (!result.changes || result.changes.length === 0) {
        console.log('  (none — all bindings are already legacy)');
      }
    }).catch((err) => {
      console.error('rollback dry-run failed:', err.message);
      process.exitCode = 1;
    });
  } else {
    rollback({}).then((result) => {
      console.log('Rollback applied:');
      console.log(`  config changed: ${result.configChanged}`);
      console.log(`  mcp changed:    ${result.mcpChanged}`);
      const repSummary = Object.entries(result.cliReplacements)
        .map(([f, n]) => `    ${path.relative(REPO_ROOT, f)}: ${n} replacement(s)`)
        .join('\n');
      if (repSummary) {
        console.log('  cli replacements:\n' + repSummary);
      }
    }).catch((err) => {
      console.error('rollback failed:', err.message);
      process.exitCode = 1;
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { rollback, verifyTasksIntact };
