/**
 * ai-router.cjs — AI operation router (SD §9.2).
 *
 * Routes AI operations based on taskCore.aiMode config and host-agent presence.
 * Lazy-requires driver and provider modules so unused paths never load them
 * and the zero-network guarantee holds (NFR-002).
 *
 * Implements FR-001, FR-008, FR-011; decisions D2, D6, D7.
 *
 * Public API:
 *   route(op, params, config, _inject)  → Promise<result>
 *   resolveHostPresence(_inject)        → boolean
 *
 * _inject — optional object for test isolation:
 *   { _env }    — override process.env for host detection (deterministic tests)
 *   { _stdout } — override stdout writer (capture emitted spec in tests)
 *   Remaining fields (e.g. _httpPost, _paths) are forwarded to the provider.
 *
 * Zero external dependencies. Pure Node CommonJS.
 */
'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** String values of SPEC_FLOW_HOST_AGENT that mean "no host" (D2). */
const FALSY_AGENT_VALUES = new Set(['0', 'false', '']);

// ---------------------------------------------------------------------------
// resolveHostPresence
// ---------------------------------------------------------------------------

/**
 * Detect whether an orchestrator host agent is present (D2).
 *
 * Priority:
 *   1. SPEC_FLOW_HOST_AGENT in env → explicit override wins; '0', 'false', ''
 *      are treated as FALSE (no host), any other value as TRUE (host present).
 *   2. CLAUDECODE in env → truthy value → host present.
 *   3. Default → no host.
 *
 * @param {object|undefined} _inject - optional { _env } for test isolation.
 *   When _env is provided, it is used instead of process.env for all lookups.
 * @returns {boolean} true when a host agent is detected, false otherwise.
 */
function resolveHostPresence(_inject) {
  const env = (_inject && _inject._env !== undefined) ? _inject._env : process.env;

  if ('SPEC_FLOW_HOST_AGENT' in env) {
    const val = env.SPEC_FLOW_HOST_AGENT;
    // Explicit override: falsy strings mean no host; everything else means host.
    return !FALSY_AGENT_VALUES.has(val);
  }

  if ('CLAUDECODE' in env) {
    return !!env.CLAUDECODE;
  }

  return false;
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

/**
 * Route an AI operation to the correct execution path.
 *
 * Routing logic (SD §9.2 BL-01..BL-03):
 *   BL-01: Validate aiMode — throws ERR_AI_MODE_UNKNOWN if unrecognised.
 *   BL-02: headless-fallback mode → always delegate to headless-fallback-provider.
 *   BL-03: agent-native mode:
 *     - host present   → call agent-native-driver, write spec to stdout (D7).
 *     - no host + fallback configured → delegate to headless-fallback-provider.
 *     - no host + no fallback → throw ERR_AI_HOST_REQUIRED (FR-008, TC-007).
 *
 * Diagnostics MUST go to stderr only. The spec JSON written for the orchestrator
 * MUST go to stdout via _stdout (or process.stdout). Never console.log to stdout.
 *
 * @param {string} op      - AI operation: 'parse-prd' | 'expand' | 'analyze-complexity' | 'research'
 * @param {object} params  - operation parameters: { tag, inputContent, context, ...rest }
 * @param {object} config  - config object returned by ai-config.cjs loadConfig
 * @param {object|undefined} _inject - injection for test isolation:
 *   { _env, _stdout, _httpPost, _paths }
 * @returns {Promise<*>}
 * @throws {Error} with .code='ERR_AI_MODE_UNKNOWN' for unrecognised aiMode (TC-002)
 * @throws {Error} with .code='ERR_AI_HOST_REQUIRED' when host absent and no fallback (TC-007)
 */
async function route(op, params, config, _inject) {
  // Resolve aiMode with default (BL-03: default is 'agent-native').
  const aiMode = (config && config.taskCore && config.taskCore.aiMode)
    ? config.taskCore.aiMode
    : 'agent-native';

  // BL-01, TC-002: validate aiMode — reject unknown values immediately.
  if (aiMode !== 'agent-native' && aiMode !== 'headless-fallback') {
    const err = new Error(
      `Unknown taskCore.aiMode: '${aiMode}'. Valid values: agent-native, headless-fallback. Check .spec-flow/config.json.`
    );
    err.code = 'ERR_AI_MODE_UNKNOWN';
    throw err;
  }

  // BL-02: headless-fallback mode — delegate regardless of host presence.
  if (aiMode === 'headless-fallback') {
    const fallbackCfg = config.taskCore && config.taskCore.headlessFallback;
    if (!fallbackCfg) {
      const err = new Error(
        'aiMode is headless-fallback but taskCore.headlessFallback is not configured in .spec-flow/config.json. ' +
        'Provide an object with endpoint, model, and apiKey.'
      );
      err.code = 'ERR_AI_HOST_REQUIRED';
      throw err;
    }
    // Lazy-require so this path never loads the driver (zero-network guarantee for agent-native tests).
    return require('./headless-fallback-provider.cjs').execute(op, params, fallbackCfg, _inject);
  }

  // BL-03: agent-native mode.
  const hostPresent = resolveHostPresence(_inject);

  if (hostPresent) {
    // Host present: build GenerationSpec and write it to stdout (D7).
    // Lazy-require so no-host tests never load the driver.
    const spec = require('./agent-native-driver.cjs').generateSpec(
      op,
      params.inputContent,
      params.tag,
      params.context
    );
    // Write to injected stdout (tests) or process.stdout (production).
    // ALL diagnostic / log output goes to stderr — never console.log the spec.
    const writeStdout = (_inject && typeof _inject._stdout === 'function')
      ? _inject._stdout
      : process.stdout.write.bind(process.stdout);
    writeStdout(JSON.stringify(spec));
    return { emitted: true, spec };
  }

  // No host — check for headless fallback configuration.
  const fallbackCfg = config.taskCore && config.taskCore.headlessFallback;

  if (fallbackCfg != null) {
    // Fallback configured: lazy-require and delegate.
    return require('./headless-fallback-provider.cjs').execute(op, params, fallbackCfg, _inject);
  }

  // No host, no fallback — FR-008, TC-007.
  const err = new Error(
    'AI operation requires an orchestrator host agent. No host agent detected ' +
    '(SPEC_FLOW_HOST_AGENT not set) and headless fallback is disabled. ' +
    'To enable fallback: set taskCore.headlessFallback in .spec-flow/config.json. ' +
    'To run agent-native: invoke from a Claude Code agent session.'
  );
  err.code = 'ERR_AI_HOST_REQUIRED';
  throw err;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  route,
  resolveHostPresence,
};
