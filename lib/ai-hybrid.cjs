/**
 * ai-hybrid.cjs — THIN STUB for AI operation routing.
 *
 * THIS FILE IS A STUB. Sub 4/5 (native-task-manager AI host) will replace or
 * expand this file with real AI execution logic (strangler-fig pattern).
 *
 * Responsibility in sub 3/5 (contract-shim):
 *   Provide the stable dispatch surface that lib/engine-router.cjs requires.
 *   While the real AI host (sub 4/5) does not exist, every AI op throws an
 *   Error with .code === 'ERR_AI_HOST_REQUIRED' so the router wraps it into
 *   the standard { error: { code, message } } envelope (FR-019).
 *
 * Design decision D4 (SD §6.3):
 *   contract-shim owns the stable surface; ai-hybrid owns AI execution.
 *   The file path lib/ai-hybrid.cjs is the stable contract — engine-router.cjs
 *   does require('./ai-hybrid.cjs') and calls .dispatch().
 *
 * Execution order:
 *   1. Check host availability — if unavailable, immediately throw
 *      ERR_AI_HOST_REQUIRED. This is the ONLY observable path in sub 3/5
 *      (hostAvailable is always false) and guarantees all engine-router AI op
 *      tests keep returning ERR_AI_HOST_REQUIRED regardless of arg shape.
 *   2. Validate required args — only reached when the host IS available (sub
 *      4/5). Throws 'Missing required arg: <name>' on missing required arg.
 *   3. Forward to real execution — not implemented in sub 3/5.
 *
 * TODO(sub-4/5): replace hostAvailable stub with real orchestrator-agent
 *   presence detection and wire up actual AI execution.
 *
 * Public API:
 *   executeAiOp(operation, args) → Promise<result>   — primary implementation
 *   dispatch(operation, args)    → Promise<result>   — alias called by engine-router.cjs
 *   _validateArgs(operation, args)                   — exported for direct unit-testing
 */
'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stub flag indicating whether an AI host agent is reachable.
 * Always false in sub 3/5. Sub 4/5 replaces this with real detection.
 * TODO(sub-4/5): detect orchestrator-agent presence.
 */
const hostAvailable = false;

/**
 * Required arguments per AI operation. Operations absent from this map have
 * no required argument (e.g. 'analyze-complexity').
 */
const REQUIRED_ARGS = {
  'parse-prd': 'input',
  'expand': 'id',
  'update': 'from',
  'research': 'query',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that all required arguments for the given operation are present.
 * Throws a descriptive Error (no .code) when a required arg is missing.
 * This validation is only reached when the AI host is available (sub 4/5).
 *
 * Exported as _validateArgs so test coverage can reach this path directly,
 * independent of host availability.
 *
 * @param {string} operation - AI operation name
 * @param {object} args      - argument object from the caller
 * @throws {Error} 'Missing required arg: <name>' when a required arg is absent
 */
function _validateArgs(operation, args) {
  const requiredArg = REQUIRED_ARGS[operation];
  if (requiredArg !== undefined && (args[requiredArg] === undefined || args[requiredArg] === null)) {
    throw new Error(`Missing required arg: ${requiredArg}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an AI operation, routing to the AI host when available.
 *
 * In sub 3/5 the host is never available (hostAvailable = false), so every
 * call throws ERR_AI_HOST_REQUIRED immediately (before arg validation).
 * The engine-router catches that code and wraps it into the standard error
 * envelope (FR-019).
 *
 * When sub 4/5 sets hostAvailable = true, execution proceeds to arg
 * validation and then to real AI dispatch.
 *
 * @param {string} operation - AI operation name (e.g. 'parse-prd', 'expand')
 * @param {object} [args={}] - Operation arguments from the MCP tool call
 * @returns {Promise<*>} — never resolves in sub 3/5; always throws
 * @throws {Error} with .code='ERR_AI_HOST_REQUIRED' when no AI host is present
 * @throws {Error} 'Missing required arg: <name>' when host is available but arg missing
 */
async function executeAiOp(operation, args) {
  const safeArgs = args || {};

  // 1. Check AI host availability FIRST.
  //    When unavailable (always in sub 3/5), throw immediately so callers
  //    always get ERR_AI_HOST_REQUIRED — regardless of arg shape.
  if (!hostAvailable) {
    const err = new Error(
      'AI host agent required to execute AI operations; run inside an agent context or enable headless fallback.'
    );
    err.code = 'ERR_AI_HOST_REQUIRED';
    throw err;
  }

  // 2. Validate required arguments — only reached when host is available (sub 4/5).
  _validateArgs(operation, safeArgs);

  // 3. Forward to real AI execution — not implemented in sub 3/5.
  // TODO(sub-4/5): implement real AI operation dispatch here.
  throw new Error('AI execution not implemented in sub 3/5; requires sub 4/5 ai-hybrid');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  executeAiOp,
  // dispatch is the alias called by engine-router.cjs:
  //   const aiHybrid = require('./ai-hybrid.cjs');
  //   return await aiHybrid.dispatch(operation, safeArgs);
  dispatch: executeAiOp,
  // Exported for direct unit testing of arg validation logic (not reachable
  // through executeAiOp while hostAvailable = false).
  _validateArgs,
};
