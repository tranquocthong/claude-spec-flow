/**
 * cli-dispatcher.cjs — CLI subcommand dispatcher for the native task manager.
 *
 * Implements the 9-subcommand CLI contract (SD §9.3) as a drop-in replacement
 * for the task-master-ai@0.43.1 CLI surface.
 *
 * Public API:
 *   runCli(argv, _inject?) → Promise<{ stdout, stderr, exitCode }>
 *
 * argv  — array of args AFTER the node/bin entry (e.g. ['use-tag', 'feat-x']).
 * _inject — optional { _configFile, _paths } for test isolation (same convention
 *           as engine-router.cjs — keeps real .spec-flow/ and .taskmaster/ untouched
 *           during unit tests).
 *
 * Contract (SD §9.3):
 *   - NEVER calls process.exit; returns { exitCode } so tests can assert without
 *     killing the test process.
 *   - Exit 0 = success or no-op; Exit 1 = handleable error with clear stderr message.
 *   - Unhandled exceptions: caught and printed as "${code||ERR_UNKNOWN}: ${message}"
 *     to stderr — no raw stack trace leaks to stdout.
 *
 * Subcommands:
 *   CRUD (direct native-core path via engine-router):
 *     use-tag <tagName>
 *     update-task --id <id> [--tag <tag>] [--prompt <text>]
 *     init [--yes]
 *   AI (engine-router AI path — returns ERR_AI_HOST_REQUIRED until sub 4/5):
 *     parse-prd --input <file> [--tag <tag>]
 *     analyze-complexity [--tag <tag>]
 *     expand --id <id> [--tag <tag>]
 *     update --from <taskId> [--tag <tag>] [--prompt <text>]
 *     research <query> [--tag <tag>]
 *   No-op shim (exit 0 always, TODO task-5 extracts to lib/models-shim.cjs):
 *     models [--set-main|--set-research|--set-fallback <model>] [--claude-code]
 */
'use strict';
const { parseArgs } = require('./core.cjs');
const { routeToEngine } = require('./engine-router.cjs');
const { runModels } = require('./models-shim.cjs');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format an error envelope { error: { code, message } } as a stderr string.
 * @param {{ error: { code: string, message: string } }} envelope
 * @returns {string}
 */
function _formatError(envelope) {
  const { code, message } = envelope.error;
  return `${code}: ${message}`;
}

/**
 * Build the base args object for routeToEngine from parsed CLI flags plus
 * injected test isolation fields (_configFile, _paths).
 *
 * @param {object} parsed   - output of parseArgs (flags + _:[] positionals)
 * @param {object} _inject  - { _configFile?, _paths? } from test harness
 * @returns {object}
 */
function _baseArgs(parsed, _inject) {
  return Object.assign({}, _inject || {}, parsed);
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// Each returns Promise<{ stdout, stderr, exitCode }>.
// ---------------------------------------------------------------------------

/**
 * use-tag <tagName>
 * Sets the current tag in state.json (CRUD, SD §9.3).
 * Required: positional tagName.
 * Exit 0 on success, 1 on missing tagName or error.
 */
async function _handleUseTag(parsed, _inject) {
  const tagName = parsed._[1]; // argv[0]=subcommand, argv[1]=tagName
  if (!tagName) {
    return {
      stdout: '',
      stderr: 'Usage: task-master use-tag <tagName>\nError: tagName is required.',
      exitCode: 1,
    };
  }

  const args = Object.assign({}, _inject || {}, { tag: tagName });
  let result;
  try {
    result = await routeToEngine('use-tag', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: `Switched to tag: ${tagName}\n`, stderr: '', exitCode: 0 };
}

/**
 * update-task --id <id> [--tag <tag>] [--prompt <text>] [--append]
 * Updates a task's notes/description via the native core (CRUD, SD §9.3).
 * Required: --id.
 * Exit 0 on success, 1 on missing --id or native error.
 */
async function _handleUpdateTask(parsed, _inject) {
  const id = parsed.id;
  if (!id) {
    return {
      stdout: '',
      stderr: 'Usage: task-master update-task --id <id> [--tag <tag>] [--prompt <text>]\n' +
              'Error: --id is required.',
      exitCode: 1,
    };
  }

  // --prompt maps to notes (task-master-ai@0.43.1 append convention)
  const args = Object.assign({}, _inject || {}, {
    id: String(id),
    tag: parsed.tag || undefined,
    notes: parsed.prompt || undefined,
    description: parsed.description || undefined,
    details: parsed.details || undefined,
  });

  let result;
  try {
    result = await routeToEngine('update-task', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: `Task ${id} updated.\n`, stderr: '', exitCode: 0 };
}

/**
 * init [--yes]
 * Idempotent initialisation of the .taskmaster/ namespace (CRUD, SD §9.3, FR-014).
 * Creates .taskmaster/, .taskmaster/tasks/, .taskmaster/reports/ and writes
 * tasks/tasks.json, state.json, config.json when not already present.
 * Exit 0 on success or when already initialised.
 * Delegates to lib/init.cjs so the scaffold logic is unit-testable in isolation.
 */
async function _handleInit(parsed, _inject) {
  return require('./init.cjs').runInit(parsed, _inject);
}

/**
 * parse-prd --input <file> [--tag <tag>]
 * AI op: delegates to engine-router (will return ERR_AI_HOST_REQUIRED in sub 3/5).
 * Required: --input.
 * Exit 1 when --input is missing or when AI host is not available.
 */
async function _handleParsePrd(parsed, _inject) {
  const input = parsed.input;
  if (!input) {
    return {
      stdout: '',
      stderr: 'Usage: task-master parse-prd --input <file> [--tag <tag>]\n' +
              'Error: --input is required.',
      exitCode: 1,
    };
  }

  const args = Object.assign({}, _inject || {}, {
    input,
    tag: parsed.tag || undefined,
  });

  let result;
  try {
    result = await routeToEngine('parse-prd', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
}

/**
 * analyze-complexity [--tag <tag>]
 * AI op: delegates to engine-router.
 * Exit 1 when AI host is not available.
 */
async function _handleAnalyzeComplexity(parsed, _inject) {
  const args = Object.assign({}, _inject || {}, {
    tag: parsed.tag || undefined,
  });

  let result;
  try {
    result = await routeToEngine('analyze-complexity', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
}

/**
 * expand --id <taskId> [--tag <tag>]
 * AI op: delegates to engine-router.
 * Required: --id.
 */
async function _handleExpand(parsed, _inject) {
  const id = parsed.id;
  if (!id) {
    return {
      stdout: '',
      stderr: 'Usage: task-master expand --id <taskId> [--tag <tag>]\n' +
              'Error: --id is required.',
      exitCode: 1,
    };
  }

  const args = Object.assign({}, _inject || {}, {
    id: String(id),
    tag: parsed.tag || undefined,
  });

  let result;
  try {
    result = await routeToEngine('expand', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
}

/**
 * update --from <taskId> [--tag <tag>] [--prompt <text>]
 * AI op: delegates to engine-router.
 * Required: --from.
 */
async function _handleUpdate(parsed, _inject) {
  const from = parsed.from;
  if (!from) {
    return {
      stdout: '',
      stderr: 'Usage: task-master update --from <taskId> [--tag <tag>] [--prompt <text>]\n' +
              'Error: --from is required.',
      exitCode: 1,
    };
  }

  const args = Object.assign({}, _inject || {}, {
    from: String(from),
    tag: parsed.tag || undefined,
    prompt: parsed.prompt || undefined,
  });

  let result;
  try {
    result = await routeToEngine('update', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
}

/**
 * research <query> [--tag <tag>]
 * AI op: delegates to engine-router.
 * Required: positional query (first positional after subcommand).
 */
async function _handleResearch(parsed, _inject) {
  // query is the first positional after the subcommand name
  const query = parsed._.slice(1).join(' ');
  if (!query) {
    return {
      stdout: '',
      stderr: 'Usage: task-master research <query> [--tag <tag>]\n' +
              'Error: query is required.',
      exitCode: 1,
    };
  }

  const args = Object.assign({}, _inject || {}, {
    query,
    tag: parsed.tag || undefined,
  });

  let result;
  try {
    result = await routeToEngine('research', args);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  if (result && result.error) {
    return { stdout: '', stderr: _formatError(result), exitCode: 1 };
  }

  return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
}

/**
 * models [--set-main <model>] [--set-research <model>] [--set-fallback <model>] [--claude-code]
 * No-op shim: exits 0 always (SD §9.3, FR-015, decision D2).
 * Delegates to lib/models-shim.cjs which handles compat-config write and logging.
 * Passes args after the 'models' subcommand name (parsed._ slice starting at index 1)
 * plus the raw flag values reconstructed from parsed, so models-shim can parse them.
 */
function _handleModels(parsed, _inject) {
  // Reconstruct the args array from parsed flags (all args after 'models' subcommand).
  // parsed._[0] is 'models', so slice from index 1 for positionals; flags come from parsed.
  const argsAfterSubcommand = [];
  if (parsed['set-main'] !== undefined && parsed['set-main'] !== true) {
    argsAfterSubcommand.push('--set-main', String(parsed['set-main']));
  }
  if (parsed['set-research'] !== undefined && parsed['set-research'] !== true) {
    argsAfterSubcommand.push('--set-research', String(parsed['set-research']));
  }
  if (parsed['set-fallback'] !== undefined && parsed['set-fallback'] !== true) {
    argsAfterSubcommand.push('--set-fallback', String(parsed['set-fallback']));
  }
  if (parsed['claude-code']) {
    argsAfterSubcommand.push('--claude-code');
  }
  return runModels(argsAfterSubcommand, _inject);
}

// ---------------------------------------------------------------------------
// Subcommand dispatch table
// ---------------------------------------------------------------------------

const HANDLERS = {
  'use-tag': _handleUseTag,
  'update-task': _handleUpdateTask,
  'init': _handleInit,
  'parse-prd': _handleParsePrd,
  'analyze-complexity': _handleAnalyzeComplexity,
  'expand': _handleExpand,
  'update': _handleUpdate,
  'research': _handleResearch,
  'models': _handleModels,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse argv, dispatch the subcommand, and return { stdout, stderr, exitCode }.
 *
 * This function NEVER calls process.exit — it returns the exit code so callers
 * (bin/task-master) and tests can handle it without killing the process.
 *
 * @param {string[]} argv     - args after the node/bin entry (e.g. ['use-tag', 'feat-x'])
 * @param {object}  [_inject] - { _configFile?, _paths? } for test isolation
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function runCli(argv, _inject) {
  let parsed;
  try {
    parsed = parseArgs(argv || []);
  } catch (err) {
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }

  const subcommand = parsed._[0];

  if (!subcommand) {
    const usage = [
      'Usage: task-master <subcommand> [flags]',
      '',
      'Subcommands:',
      '  use-tag <tagName>                         Switch to a tag namespace',
      '  update-task --id <id> [--prompt <text>]   Update a task',
      '  init [--yes]                              Initialise .taskmaster/',
      '  parse-prd --input <file> [--tag <tag>]   Parse a PRD into tasks (AI)',
      '  analyze-complexity [--tag <tag>]          Analyse task complexity (AI)',
      '  expand --id <id> [--tag <tag>]            Expand a task into subtasks (AI)',
      '  update --from <id> [--prompt <text>]      Update tasks from prompt (AI)',
      '  research <query> [--tag <tag>]            Research a query (AI)',
      '  models [flags]                            Configure AI models (no-op)',
    ].join('\n');
    return { stdout: '', stderr: usage, exitCode: 1 };
  }

  const handler = HANDLERS[subcommand];
  if (!handler) {
    return {
      stdout: '',
      stderr: `ERR_UNKNOWN_SUBCOMMAND: Unknown subcommand '${subcommand}'. ` +
              `Valid subcommands: ${Object.keys(HANDLERS).join(', ')}`,
      exitCode: 1,
    };
  }

  try {
    return await handler(parsed, _inject);
  } catch (err) {
    // Catch any unhandled exception from a handler — never leak raw stack traces
    const code = err.code || 'ERR_UNKNOWN';
    return { stdout: '', stderr: `${code}: ${err.message}`, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runCli };
