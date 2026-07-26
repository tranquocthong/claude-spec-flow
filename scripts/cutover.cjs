/**
 * cutover.cjs — atomic C-3 cutover tool for the native-task-manager strangler fig.
 *
 * Performs three coordinated file changes an operator commits together (revertable
 * in one `git revert`):
 *   1. .spec-flow/config.json → sets taskCore.engine = 'native'
 *   2. .mcp.json              → replaces task-master-ai entry with native node entry
 *   3. CLI files (commands/ + skills/) → rewrites legacy npx invocations to node
 *
 * SAFETY: The thin CLI runner requires --confirm to write anything. Running
 * `node scripts/cutover.cjs` without --confirm is a no-op (dry-run only).
 *
 * In tests, pass all paths explicitly via the options object — the defaults are
 * NEVER used in test contexts (os.mkdtemp isolation is enforced by the caller).
 *
 * Usage:
 *   const { cutover } = require('./scripts/cutover.cjs');
 *   const result = await cutover({ configFile, mcpFile, cliFiles, dryRun });
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
// Regex patterns for legacy CLI invocations
//
// Pattern 1: npx -y -p task-master-ai@0.43.1 task-master <subcommand...>
// Pattern 2: npx -y task-master-ai@0.43.1 <subcommand...>
//
// Both forms are replaced with: node bin/task-master <subcommand...>
// The replacement is done on the prefix only so flags after the subcommand
// remain intact.
// ---------------------------------------------------------------------------

const LEGACY_PATTERN_WITH_P = /npx -y -p task-master-ai@0\.43\.1 task-master /g;
const LEGACY_PATTERN_SHORT = /npx -y task-master-ai@0\.43\.1 /g;
const NATIVE_CLI_PREFIX = 'node bin/task-master ';

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
 * Apply regex substitutions to the content string and return the new string
 * along with the total number of replacements made.
 *
 * @param {string} content
 * @returns {{ newContent: string, count: number }}
 */
function _applyCliReplacements(content) {
  let count = 0;

  const withP = content.replace(LEGACY_PATTERN_WITH_P, () => {
    count++;
    return NATIVE_CLI_PREFIX;
  });

  const withShort = withP.replace(LEGACY_PATTERN_SHORT, () => {
    count++;
    return NATIVE_CLI_PREFIX;
  });

  return { newContent: withShort, count };
}

/**
 * Determine whether the config already has taskCore.engine === 'native'.
 *
 * @param {object} config
 * @returns {boolean}
 */
function _configAlreadyNative(config) {
  return (
    config.taskCore &&
    typeof config.taskCore === 'object' &&
    config.taskCore.engine === 'native'
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform (or simulate) the atomic cutover.
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
async function cutover(options) {
  const opts = options || {};

  const configFile = opts.configFile !== undefined ? opts.configFile : DEFAULT_CONFIG_FILE;
  const mcpFile = opts.mcpFile !== undefined ? opts.mcpFile : DEFAULT_MCP_FILE;
  const cliFiles = opts.cliFiles !== undefined ? opts.cliFiles : DEFAULT_CLI_FILES;
  const dryRun = opts.dryRun === true;

  // --- 1. Config: set taskCore.engine = 'native' ---

  const config = _readJson(configFile);
  const configAlreadyNative = _configAlreadyNative(config);
  let configChanged = false;

  const newConfig = Object.assign({}, config);
  if (!configAlreadyNative) {
    newConfig.taskCore = Object.assign({}, config.taskCore || {}, { engine: 'native' });
    configChanged = true;
  }

  // --- 2. MCP: replace task-master-ai entry with native entry ---

  const { mcpServerEntry } = require('../lib/engine-bootstrap.cjs');
  const nativeMcpEntry = mcpServerEntry('native');

  const mcpData = _readJson(mcpFile);
  const currentEntry = mcpData.mcpServers && mcpData.mcpServers['task-master-ai'];
  const mcpAlreadyNative =
    currentEntry &&
    currentEntry.command === nativeMcpEntry.command &&
    JSON.stringify(currentEntry.args) === JSON.stringify(nativeMcpEntry.args);

  let mcpChanged = false;
  const newMcpData = JSON.parse(JSON.stringify(mcpData)); // deep clone
  if (!mcpAlreadyNative) {
    newMcpData.mcpServers = Object.assign({}, mcpData.mcpServers, {
      'task-master-ai': nativeMcpEntry,
    });
    mcpChanged = true;
  }

  // --- 3. CLI files: replace legacy invocations ---

  const cliReplacements = {};
  const cliChanges = []; // { file, originalContent, newContent, count }

  for (const filePath of cliFiles) {
    const originalContent = fs.readFileSync(filePath, 'utf8');
    const { newContent, count } = _applyCliReplacements(originalContent);
    cliReplacements[filePath] = count;
    cliChanges.push({ file: filePath, originalContent, newContent, count });
  }

  // --- dryRun: build changes list and return without writing ---

  if (dryRun) {
    const changes = [];
    if (configChanged) {
      changes.push({ file: configFile, description: 'set taskCore.engine = "native"' });
    }
    if (mcpChanged) {
      changes.push({ file: mcpFile, description: 'replace task-master-ai entry with native node entry' });
    }
    for (const c of cliChanges) {
      if (c.count > 0) {
        changes.push({ file: c.file, description: `replace ${c.count} legacy npx invocation(s) with node bin/task-master` });
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

// ---------------------------------------------------------------------------
// Thin CLI runner (operator-facing)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirm');

  if (!confirmed) {
    console.log('dry-run only; pass --confirm to apply');
    cutover({ dryRun: true }).then((result) => {
      console.log('Planned changes:');
      (result.changes || []).forEach((c) => {
        console.log(`  ${c.file}: ${c.description}`);
      });
      if (!result.changes || result.changes.length === 0) {
        console.log('  (none — all bindings are already native)');
      }
    }).catch((err) => {
      console.error('cutover dry-run failed:', err.message);
      process.exitCode = 1;
    });
  } else {
    cutover({}).then((result) => {
      console.log('Cutover applied:');
      console.log(`  config changed: ${result.configChanged}`);
      console.log(`  mcp changed:    ${result.mcpChanged}`);
      const repSummary = Object.entries(result.cliReplacements)
        .map(([f, n]) => `    ${path.relative(REPO_ROOT, f)}: ${n} replacement(s)`)
        .join('\n');
      if (repSummary) {
        console.log('  cli replacements:\n' + repSummary);
      }
    }).catch((err) => {
      console.error('cutover failed:', err.message);
      process.exitCode = 1;
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { cutover };
