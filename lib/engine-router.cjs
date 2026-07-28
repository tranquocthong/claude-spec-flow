/**
 * engine-router.cjs — config-driven dispatch for the native task engine.
 *
 * Reads .spec-flow/config.json synchronously ONCE per invocation (design
 * decision D3 — no global cache) and routes each MCP operation to either:
 *   - The native CRUD core (task-core.cjs + tag-manager.cjs), or
 *   - The AI hybrid stub (ai-hybrid.cjs, lazily required), or
 *   - Legacy mode (fail-open envelope) when engine is not 'native'.
 *
 * Public API (SD §10.2, FR-016..FR-019):
 *   routeToEngine(operation, args) → Promise<result | {error:{code,message}}>
 *
 * Error envelope convention (FR-019):
 *   All errors — whether from missing config, wrong engine, or a thrown
 *   native Error — are returned as { error: { code, message } } rather than
 *   thrown. The MCP envelope layer (task 6) maps these to wire format.
 *
 * Path injection (_paths / _configFile in args):
 *   Production callers omit these; tests inject them so no real .spec-flow/
 *   or .taskmaster/ file is ever touched during testing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { wrapError } = require('./mcp-error-wrapper.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default .spec-flow/config.json location relative to cwd (FR-016). */
const DEFAULT_CONFIG_FILE = path.join('.spec-flow', 'config.json');

/** Legacy mode error envelope returned for fail-open cases (FR-017). */
const LEGACY_ENVELOPE = wrapError({ code: 'ERR_LEGACY_MODE', message: 'Native core not active' });

/**
 * CRUD operations dispatched to task-core.cjs / tag-manager.cjs.
 * Changing this set changes routing — keep in sync with SD §10.2.
 */
const CRUD_OPS = new Set([
  'set_task_status',
  'get_task',
  'get_tasks',
  'next_task',
  'add_task',
  'use-tag',
  'update-task',
  'init',
]);

/**
 * AI operations dispatched to ai-hybrid.cjs (sub 4/5 — may not exist yet).
 */
const AI_OPS = new Set([
  'parse-prd',
  'expand',
  'analyze-complexity',
  'research',
  'update',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse .spec-flow/config.json synchronously (FR-016, D3 — no cache).
 *
 * Returns the parsed object on success.
 * Returns null when the file is missing (ENOENT) — caller maps to legacy mode.
 * Re-throws unexpected fs errors or SyntaxErrors so the caller can handle them.
 *
 * @param {string} configFile - absolute or cwd-relative path to config.json
 * @returns {object|null}
 */
function _readConfig(configFile) {
  let raw;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw); // SyntaxError propagates on malformed JSON
}

// Error envelope construction is delegated to mcp-error-wrapper.cjs (wrapError).
// Imported at the top of this file; all { error: { code, message } } shapes
// originate from that single canonical source (FR-018, FR-019, D5).

/**
 * Log the invocation context (operation + available identifiers) so the
 * audit trail exists even when the call fails (FR-018, FR-019).
 *
 * @param {string} operation
 * @param {object} args
 */
function _logInvocation(operation, args) {
  const parts = [`[engine-router] op=${operation}`];
  if (args.tag) parts.push(`tag=${args.tag}`);
  if (args.taskId !== undefined) parts.push(`taskId=${args.taskId}`);
  if (args.id !== undefined) parts.push(`id=${args.id}`);
  // Diagnostics MUST go to stderr: the agent-native path (parse-prd/expand) emits
  // the GenerationSpec as the ONLY thing on stdout (decision D7), so any stray
  // stdout write here would corrupt that JSON channel for the orchestrator.
  console.error(parts.join(' '));
}

// ---------------------------------------------------------------------------
// CRUD dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a CRUD operation to the appropriate native core function.
 *
 * Argument mapping (MCP tool arg names → native signatures):
 *   set_task_status {taskId, status, tag}    → setStatus(tag, taskId, status, _paths)
 *   get_task        {id, tag}                → getTask(tag, id, _paths)
 *   get_tasks       {tag, status, withSubtasks} → listTasks(tag, opts, _paths)
 *   next_task       {tag}                    → nextTask(tag, _paths)
 *   add_task        {tag, title, ...fields}  → addTask(tag, fields, _paths)
 *   use-tag         {tag}                    → useTag(tag, _paths)
 *   update-task     {id, tag, ...fields}     → updateTask(tag, id, fields, _paths)
 *   init            {tag?}                   → useTag(tag || 'master', _paths)
 *
 * @param {string} operation
 * @param {object} args
 * @returns {*} result from the native function
 * @throws {Error} native errors propagate to the caller for wrapping
 */
function _dispatchCrud(operation, args) {
  const _paths = args._paths;

  switch (operation) {
    case 'set_task_status': {
      const { setStatus } = require('./task-core.cjs');
      return setStatus(args.tag, args.taskId, args.status, _paths);
    }

    case 'get_task': {
      const { getTask } = require('./task-core.cjs');
      return getTask(args.tag, args.id, _paths);
    }

    case 'get_tasks': {
      const { listTasks } = require('./task-core.cjs');
      const opts = {
        status: args.status,
        withSubtasks: args.withSubtasks,
      };
      return listTasks(args.tag, opts, _paths);
    }

    case 'next_task': {
      const { nextTask } = require('./task-core.cjs');
      return nextTask(args.tag, _paths);
    }

    case 'add_task': {
      const { addTask } = require('./task-core.cjs');
      const fields = {
        title: args.title,
        description: args.description,
        details: args.details,
        testStrategy: args.testStrategy,
        priority: args.priority,
      };
      return addTask(args.tag, fields, _paths);
    }

    case 'use-tag': {
      const { useTag } = require('./tag-manager.cjs');
      useTag(args.tag, _paths);
      return { ok: true };
    }

    case 'update-task': {
      const { updateTask } = require('./task-core.cjs');
      const fields = {
        description: args.description,
        details: args.details,
        notes: args.notes,
      };
      return updateTask(args.tag, args.id, fields, _paths);
    }

    case 'init': {
      // Initialise the tag namespace; default to 'master' when no tag is given.
      const { useTag } = require('./tag-manager.cjs');
      const tag = args.tag || 'master';
      useTag(tag, _paths);
      return { ok: true };
    }

    default: {
      const e = new Error(`Unknown CRUD operation: '${operation}'`);
      e.code = 'ERR_UNKNOWN_OPERATION';
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route an MCP operation to the correct engine (native vs legacy) and return
 * the result or an error envelope. Always returns — never throws (FR-019).
 *
 * Steps (SD §10.2):
 *   1. Log invocation context (FR-018).
 *   2. Read config.json (once per call, D3).
 *   3. Extract taskCore.engine; missing config or missing engine → legacy mode.
 *   4. engine='legacy' → legacy envelope (fail-open, FR-017).
 *   5. engine='native' → classify op as CRUD or AI:
 *      a. CRUD: dispatch to task-core / tag-manager; catch + wrap native errors.
 *      b. AI: lazy-require ai-hybrid.cjs; catch MODULE_NOT_FOUND → ERR_AI_HOST_REQUIRED.
 *
 * @param {string} operation  - MCP tool name (e.g. 'get_tasks', 'expand')
 * @param {object} [args={}]  - MCP tool arguments + optional injection fields:
 *                              _configFile {string} - override config.json path (tests)
 *                              _paths {object}      - { tasksFile?, stateFile? } (tests)
 * @returns {Promise<*>}      - result from the native fn, or { error: { code, message } }
 */
async function routeToEngine(operation, args) {
  const safeArgs = args || {};

  // 1. Log invocation context before anything that might fail (FR-018, FR-019).
  _logInvocation(operation, safeArgs);

  // 2. Read config.json — once per invocation, no global cache (D3, FR-016).
  const configFile = safeArgs._configFile || DEFAULT_CONFIG_FILE;
  let config;
  try {
    config = _readConfig(configFile);
  } catch (err) {
    // Unexpected error reading config — log and fall back to legacy mode.
    console.warn(`[engine-router] config read error: ${err.message}; defaulting to legacy`);
    return LEGACY_ENVELOPE;
  }

  // 3. Extract engine value; absent config or absent engine → log warning + legacy mode.
  const engine = config && config.taskCore && config.taskCore.engine;

  if (!config || engine === undefined || engine === null || engine === '') {
    console.warn(
      '[engine-router] taskCore.engine not found, defaulting to legacy'
    );
    return LEGACY_ENVELOPE;
  }

  // 4. Explicit engine='legacy' → legacy envelope (fail-open, FR-017).
  if (engine === 'legacy') {
    return LEGACY_ENVELOPE;
  }

  // 5. engine='native' → dispatch.
  if (engine === 'native') {
    if (AI_OPS.has(operation)) {
      // 5b. AI op — lazy require so task 4 (ai-hybrid) is not a hard dependency.
      try {
        const aiHybrid = require('./ai-hybrid.cjs');
        return await aiHybrid.dispatch(operation, safeArgs);
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          return wrapError({ code: 'ERR_AI_HOST_REQUIRED', message: 'AI host (ai-hybrid) not available' });
        }
        // ai-hybrid exists but threw a runtime error — wrap normally.
        return wrapError(err);
      }
    }

    if (CRUD_OPS.has(operation)) {
      // 5a. CRUD op — dispatch to native core; catch + wrap any native errors.
      try {
        return _dispatchCrud(operation, safeArgs);
      } catch (err) {
        console.warn(
          `[engine-router] native error on op=${operation}: ${err.code || 'ERR_UNKNOWN'} — ${err.message}`
        );
        return wrapError(err);
      }
    }

    // Unknown operation — not in CRUD_OPS or AI_OPS.
    const e = new Error(`Unknown operation: '${operation}'`);
    e.code = 'ERR_UNKNOWN_OPERATION';
    return wrapError(e);
  }

  // Unknown engine value — treat as legacy (fail-open, FR-017).
  console.warn(
    `[engine-router] unknown engine value '${engine}', defaulting to legacy`
  );
  return LEGACY_ENVELOPE;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  routeToEngine,
  // Exported for test introspection
  CRUD_OPS,
  AI_OPS,
  DEFAULT_CONFIG_FILE,
};
