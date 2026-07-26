/**
 * engine-bootstrap.cjs — MCP + CLI binding descriptors for dark-launch engine switching.
 *
 * Given an engine value ('legacy' | 'native'), returns the intended MCP server
 * entry object (.mcp.json shape) and CLI invocation descriptor. The cutover script
 * uses these descriptors to rewrite bindings; /sf:doctor uses them to verify the
 * active binding matches the configured engine.
 *
 * This module NEVER reads or writes .mcp.json, .spec-flow/config.json (except
 * via engine-selector), commands/, or skills/. It is descriptor-only (no side
 * effects beyond reading config via engine-selector).
 *
 * Public API (FR-002):
 *   mcpServerEntry(engine)               → MCP server entry object for .mcp.json
 *   cliInvocation(engine, subcommand, args) → { command, args } invocation descriptor
 *   activeBinding(_inject?)              → { engine, mcp, cli } convenience wrapper
 *
 * Error handling:
 *   - Unknown engine value → throws Error with a clear message.
 *   - engine-selector handles config read errors (ENOENT → 'legacy', others rethrow).
 */
'use strict';

const { readEngineConfig } = require('./engine-selector.cjs');

// ---------------------------------------------------------------------------
// Constants — canonical legacy MCP entry (must match .mcp.json in repo root)
// ---------------------------------------------------------------------------

/**
 * The legacy MCP server entry as it appears in the repo's .mcp.json under
 * mcpServers["task-master-ai"]. Any change to .mcp.json must be reflected here.
 */
const LEGACY_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', 'task-master-ai@0.43.1'],
  env: { TASK_MASTER_TOOLS: 'standard' },
};

/**
 * The native MCP server entry: runs the project-local mcp-server.js via node.
 * bin/mcp-server.js is the native MCP server built in sub 3/5.
 */
const NATIVE_MCP_ENTRY = {
  command: 'node',
  args: ['bin/mcp-server.js'],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert that the engine value is one of the two known identifiers.
 * Throws a clear Error for anything else so callers get an actionable message.
 *
 * @param {string} engine
 * @throws {Error} when engine is not 'legacy' or 'native'
 */
function _assertKnownEngine(engine) {
  if (engine !== 'legacy' && engine !== 'native') {
    throw new Error(
      `[engine-bootstrap] Unknown engine '${engine}'. Must be 'legacy' or 'native'.`
    );
  }
}

/**
 * Convert an args array into an array of flag strings suitable for appending
 * to a command-line invocation. The input is already an array of strings, so
 * this is a passthrough that guards against non-array input.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function _flagsFromArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map(String);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the .mcp.json mcpServers["task-master-ai"] object for the given engine.
 *
 * - 'legacy' → the current repo .mcp.json legacy entry (npx task-master-ai@0.43.1).
 * - 'native' → node bin/mcp-server.js (the native server from sub 3/5).
 *
 * The returned object is a fresh shallow copy so callers cannot mutate the
 * canonical constants.
 *
 * @param {'legacy'|'native'} engine
 * @returns {{ command: string, args: string[], env?: object }}
 * @throws {Error} for unknown engine values
 */
function mcpServerEntry(engine) {
  _assertKnownEngine(engine);

  if (engine === 'legacy') {
    // Return a copy to protect the canonical constant from mutation.
    return {
      command: LEGACY_MCP_ENTRY.command,
      args: [...LEGACY_MCP_ENTRY.args],
      env: Object.assign({}, LEGACY_MCP_ENTRY.env),
    };
  }

  // engine === 'native'
  return {
    command: NATIVE_MCP_ENTRY.command,
    args: [...NATIVE_MCP_ENTRY.args],
  };
}

/**
 * Return a CLI invocation descriptor { command, args } for the given engine,
 * subcommand, and optional flags.
 *
 * - 'legacy' → { command: 'npx', args: ['-y', 'task-master-ai@0.43.1', subcommand, ...flags] }
 * - 'native' → { command: 'node', args: ['bin/task-master', subcommand, ...flags] }
 *
 * @param {'legacy'|'native'} engine
 * @param {string}   subcommand - task-master subcommand (e.g. 'get-tasks', 'update-task')
 * @param {string[]} args       - additional flags/arguments to append (may be empty)
 * @returns {{ command: string, args: string[] }}
 * @throws {Error} for unknown engine values
 */
function cliInvocation(engine, subcommand, args) {
  _assertKnownEngine(engine);

  const flags = _flagsFromArgs(args);

  if (engine === 'legacy') {
    return {
      command: 'npx',
      args: ['-y', 'task-master-ai@0.43.1', subcommand, ...flags],
    };
  }

  // engine === 'native'
  return {
    command: 'node',
    args: ['bin/task-master', subcommand, ...flags],
  };
}

/**
 * Convenience: read the engine from config via engine-selector and return a
 * unified binding object with the MCP entry and a partially-applied CLI helper.
 *
 * The returned binding is:
 *   {
 *     engine: 'legacy' | 'native',
 *     mcp:    <mcpServerEntry(engine)>,
 *     cli:    (subcommand, args) => cliInvocation(engine, subcommand, args),
 *   }
 *
 * @param {object} [_inject]             - optional injection forwarded to engine-selector
 * @param {string} [_inject._configFile] - override config.json path (for tests)
 * @returns {{ engine: string, mcp: object, cli: Function }}
 */
function activeBinding(_inject) {
  // Delegate engine resolution entirely to engine-selector (no re-reading config here).
  const engine = readEngineConfig(_inject);

  return {
    engine,
    mcp: mcpServerEntry(engine),
    cli: (subcommand, args) => cliInvocation(engine, subcommand, args || []),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { mcpServerEntry, cliInvocation, activeBinding };
