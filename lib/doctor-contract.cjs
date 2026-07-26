/**
 * doctor-contract.cjs — post-flip contract checker for the native task engine.
 *
 * This is the C-4 gate: a doctor fail signals the operator to roll back.
 * Verifies all 5 §9.4 categories against the NATIVE engine, in-process,
 * on an isolated os.mkdtemp tasks.json. Never touches the real .taskmaster/.
 *
 * Public API:
 *   runContractCheck(_inject?) → Promise<{ ok: boolean, checks: Array<{name, status, detail}> }>
 *
 * _inject fields (all optional — used for test isolation):
 *   _paths            { tasksFile, stateFile }  — use a pre-existing tmp path set
 *   _configFile       string                    — path to .spec-flow/config.json
 *   _simulateMissingTool  string                — tool name to treat as absent from
 *                                                 TOOL_REGISTRY (TC-009 fail-path)
 *
 * CLI runner (if require.main === module):
 *   Prints per-check summary to stderr, exits 0 when ok, 1 when any check fails.
 *
 * Zero external dependencies. Pure Node CommonJS. 'use strict'. All code English.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 5 MCP tools that must be registered and callable (SD §9.4 category 1). */
const EXPECTED_TOOLS = ['set_task_status', 'get_task', 'get_tasks', 'next_task', 'add_task'];

/** The 10 CLI subcommands that must be registered (SD §9.4 category 2). */
const EXPECTED_SUBCOMMANDS = [
  'parse-prd', 'analyze-complexity', 'expand', 'use-tag', 'update',
  'update-task', 'research', 'init', 'models', 'tasks-import',
];

/** All 7 task status keys required in get_tasks stats.byStatus (SD §9.1). */
const REQUIRED_STATUS_KEYS = [
  'pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write a single tag into tasks.json (overwrites the whole file).
 * Used to establish a clean baseline before surface checks.
 *
 * @param {string}   tasksFile - absolute path to tasks.json
 * @param {string}   tag       - tag namespace key
 * @param {object[]} tasks     - array of task objects for the tag
 */
function _seedTasksFile(tasksFile, tag, tasks) {
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  const data = {};
  data[tag] = { tasks, metadata: {} };
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Build a minimal valid task object, with optional field overrides.
 * All required fields from SD §9.1 Task type are present.
 *
 * @param {object} [overrides] - fields to override
 * @returns {object}
 */
function _makeMinimalTask(overrides) {
  return Object.assign({
    id: '1',
    title: 'Doctor contract check task',
    description: 'Contract check seed task',
    details: '',
    testStrategy: '',
    priority: 'medium',
    dependencies: [],
    status: 'pending',
    subtasks: [],
    updatedAt: new Date().toISOString(),
  }, overrides);
}

// ---------------------------------------------------------------------------
// Check 1: MCP tool surface — 5 tools exist and are callable (§9.4 cat. 1)
// ---------------------------------------------------------------------------

/**
 * Verify all 5 expected MCP tools are registered in TOOL_REGISTRY and callable
 * via handleToolCall (no ERR_UNKNOWN_TOOL returned).
 *
 * simulateMissingTool: when set to a tool name, that tool is treated as absent
 * without modifying the real TOOL_REGISTRY (TC-009 fail-path injection).
 *
 * @param {object} _paths           - { tasksFile, stateFile }
 * @param {string} _configFile      - path to .spec-flow/config.json
 * @param {string} [simulateMissing] - tool name to simulate as missing
 * @returns {Promise<{name, status, detail}>}
 */
async function _checkMcpSurface(_paths, _configFile, simulateMissing) {
  const { TOOL_REGISTRY, handleToolCall } = require('./mcp-server.cjs');

  // Seed a clean task for the surface check (overwrites; uses its own tag)
  _seedTasksFile(_paths.tasksFile, 'mcp-surface-check', [_makeMinimalTask()]);

  const failedTools = [];

  for (const toolName of EXPECTED_TOOLS) {
    // Simulate this tool as absent (TC-009 injection — does not touch real TOOL_REGISTRY)
    if (simulateMissing === toolName) {
      failedTools.push(toolName);
      continue;
    }

    // Verify tool is registered in TOOL_REGISTRY
    if (!TOOL_REGISTRY[toolName]) {
      failedTools.push(toolName);
      continue;
    }

    // Verify tool is callable by invoking it with minimal valid args
    const callArgs = _buildMcpCallArgs(toolName, 'mcp-surface-check', _paths, _configFile);
    let result;
    try {
      result = await handleToolCall(toolName, callArgs);
    } catch (err) {
      failedTools.push(toolName);
      continue;
    }

    // ERR_UNKNOWN_TOOL would mean the tool is not actually handled
    if (result && result.error && result.error.code === 'ERR_UNKNOWN_TOOL') {
      failedTools.push(toolName);
    }
  }

  if (failedTools.length > 0) {
    return {
      name: 'mcp-tool-surface',
      status: 'fail',
      detail: `tools missing or not callable: ${failedTools.join(', ')}`,
    };
  }

  return {
    name: 'mcp-tool-surface',
    status: 'pass',
    detail: `all ${EXPECTED_TOOLS.length} tools registered and callable`,
  };
}

/**
 * Build minimal-valid handleToolCall args for a given tool.
 *
 * Uses status 'pending' for set_task_status (same as initial — idempotent).
 *
 * @param {string} toolName
 * @param {string} tag
 * @param {object} _paths
 * @param {string} _configFile
 * @returns {object}
 */
function _buildMcpCallArgs(toolName, tag, _paths, _configFile) {
  const base = { tag, _paths, _configFile };
  switch (toolName) {
    case 'set_task_status':
      return Object.assign({ taskId: '1', status: 'pending' }, base);
    case 'get_task':
      return Object.assign({ taskId: '1' }, base);
    case 'get_tasks':
      return base;
    case 'next_task':
      return base;
    case 'add_task':
      return Object.assign({ title: 'doctor-surface-check', description: 'Surface check add_task call' }, base);
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Check 2: CLI subcommands registered (§9.4 cat. 2)
// ---------------------------------------------------------------------------

/**
 * Verify all expected CLI subcommands are registered in cli-dispatcher by
 * sending a probe call with a deliberately unknown subcommand. The cli-dispatcher
 * error message lists all valid subcommands, which we parse and check against
 * EXPECTED_SUBCOMMANDS.
 *
 * @returns {Promise<{name, status, detail}>}
 */
async function _checkCliSubcommands() {
  const { runCli } = require('./cli-dispatcher.cjs');

  // Probe with a deliberately unknown subcommand — cli-dispatcher returns:
  // "ERR_UNKNOWN_SUBCOMMAND: Unknown subcommand '...'. Valid subcommands: <list>"
  const probeResult = await runCli(['__doctor_contract_probe__'], {});

  const match = probeResult.stderr.match(/Valid subcommands: (.+)/);
  if (!match) {
    return {
      name: 'cli-subcommands',
      status: 'fail',
      detail: 'could not extract valid subcommands list from cli-dispatcher probe response',
    };
  }

  const registered = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  const missing = EXPECTED_SUBCOMMANDS.filter((sub) => !registered.includes(sub));

  if (missing.length > 0) {
    return {
      name: 'cli-subcommands',
      status: 'fail',
      detail: `subcommands not registered: ${missing.join(', ')}`,
    };
  }

  return {
    name: 'cli-subcommands',
    status: 'pass',
    detail: `all ${EXPECTED_SUBCOMMANDS.length} required subcommands registered`,
  };
}

// ---------------------------------------------------------------------------
// Check 3: models shim exits 0 (§9.4 cat. 3)
// ---------------------------------------------------------------------------

/**
 * Verify the models subcommand exits 0 for any flags (no-op shim confirmed).
 *
 * Uses a dummy config file path that does not exist so models-shim skips the
 * compat write — keeps the check side-effect-free.
 *
 * @param {string} tmpDir - doctor's internal temp dir for the models config path
 * @returns {Promise<{name, status, detail}>}
 */
async function _checkModelsShim(tmpDir) {
  const { runCli } = require('./cli-dispatcher.cjs');

  // Point models-shim to a config file that does not exist — it will skip the
  // compat write (swallows ENOENT) but still return exitCode 0.
  const dummyConfigFile = path.join(tmpDir, '.taskmaster', 'config.json');

  let result;
  try {
    result = await runCli(['models', '--set-main', 'sonnet', '--claude-code'], {
      _configFile: dummyConfigFile,
    });
  } catch (err) {
    return {
      name: 'models-shim',
      status: 'fail',
      detail: `runCli threw unexpectedly: ${err.message}`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      name: 'models-shim',
      status: 'fail',
      detail: `models subcommand exited with code ${result.exitCode}; stderr: ${result.stderr}`,
    };
  }

  return {
    name: 'models-shim',
    status: 'pass',
    detail: 'models --set-main sonnet --claude-code exited 0 (no-op shim confirmed)',
  };
}

// ---------------------------------------------------------------------------
// Check 4: tasks.json round-trip (§9.4 cat. 4)
// ---------------------------------------------------------------------------

/**
 * Verify the add→read round-trip via MCP (add_task then get_task) and confirm
 * the resulting tasks.json validates against the tag-keyed schema.
 *
 * @param {object} _paths      - { tasksFile, stateFile }
 * @param {string} _configFile - path to .spec-flow/config.json
 * @returns {Promise<{name, status, detail}>}
 */
async function _checkRoundTrip(_paths, _configFile) {
  const { handleToolCall } = require('./mcp-server.cjs');
  const { validateTasksJson } = require('./tasks-json-schema.cjs');

  const tag = 'contract-check';

  // Add a task via MCP
  const addResult = await handleToolCall('add_task', {
    title: 'Doctor round-trip task',
    description: 'Round-trip schema check',
    tag,
    _paths,
    _configFile,
  });

  if (addResult && addResult.error) {
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: `add_task returned error: ${addResult.error.code} — ${addResult.error.message}`,
    };
  }

  const taskId = addResult.task && String(addResult.task.id);
  if (!taskId) {
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: 'add_task succeeded but returned no task.id',
    };
  }

  // Validate the on-disk tasks.json schema
  let rawContent;
  try {
    rawContent = fs.readFileSync(_paths.tasksFile, 'utf8');
  } catch (err) {
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: `tasks.json not found after add_task: ${err.message}`,
    };
  }

  let validationResult;
  try {
    validationResult = validateTasksJson(rawContent);
  } catch (err) {
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: `tasks.json parse/validation threw: ${err.message}`,
    };
  }

  if (!validationResult.valid) {
    const firstErr = validationResult.errors[0];
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: `tasks.json schema invalid: ${firstErr ? firstErr.reason : 'unknown error'}`,
    };
  }

  // Read back the added task via get_task
  const getResult = await handleToolCall('get_task', {
    taskId,
    tag,
    _paths,
    _configFile,
  });

  if (getResult && getResult.error) {
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: `get_task failed after add_task: ${getResult.error.code} — ${getResult.error.message}`,
    };
  }

  if (!getResult.task || String(getResult.task.id) !== taskId) {
    return {
      name: 'tasks-json-round-trip',
      status: 'fail',
      detail: `round-trip id mismatch: added id=${taskId}, read back id=${getResult.task && getResult.task.id}`,
    };
  }

  return {
    name: 'tasks-json-round-trip',
    status: 'pass',
    detail: `task id=${taskId} added, schema valid, and read back via get_task successfully`,
  };
}

// ---------------------------------------------------------------------------
// Check 5: get_tasks response shapes — { tasks, stats } with all 7 byStatus keys (§9.4 cat. 5)
// ---------------------------------------------------------------------------

/**
 * Verify get_tasks returns the correct response envelope with a stats object
 * that has all 7 byStatus keys (SD §9.1 Stats type).
 *
 * @param {object} _paths      - { tasksFile, stateFile }
 * @param {string} _configFile - path to .spec-flow/config.json
 * @returns {Promise<{name, status, detail}>}
 */
async function _checkResponseShapes(_paths, _configFile) {
  const { handleToolCall } = require('./mcp-server.cjs');

  const tag = 'shapes-check';

  // Seed the shapes-check tag with two tasks (different statuses)
  _seedTasksFile(_paths.tasksFile, tag, [
    _makeMinimalTask({ id: '1', status: 'done' }),
    _makeMinimalTask({ id: '2', status: 'pending' }),
  ]);

  const result = await handleToolCall('get_tasks', {
    tag,
    _paths,
    _configFile,
  });

  if (result && result.error) {
    return {
      name: 'response-shapes',
      status: 'fail',
      detail: `get_tasks returned error: ${result.error.code} — ${result.error.message}`,
    };
  }

  // Verify top-level envelope: { tasks, stats }
  if (!result.tasks || !Array.isArray(result.tasks)) {
    return {
      name: 'response-shapes',
      status: 'fail',
      detail: 'get_tasks did not return a "tasks" array',
    };
  }

  if (!result.stats || typeof result.stats !== 'object') {
    return {
      name: 'response-shapes',
      status: 'fail',
      detail: 'get_tasks did not return a "stats" object',
    };
  }

  if (!result.stats.byStatus || typeof result.stats.byStatus !== 'object') {
    return {
      name: 'response-shapes',
      status: 'fail',
      detail: 'stats.byStatus is missing or not an object',
    };
  }

  // All 7 byStatus keys must be present
  const missingKeys = REQUIRED_STATUS_KEYS.filter((k) => !(k in result.stats.byStatus));
  if (missingKeys.length > 0) {
    return {
      name: 'response-shapes',
      status: 'fail',
      detail: `stats.byStatus missing required keys: ${missingKeys.join(', ')}`,
    };
  }

  return {
    name: 'response-shapes',
    status: 'pass',
    detail: 'get_tasks returns { tasks, stats } with all 7 byStatus keys present',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all 5 §9.4 contract checks against the native engine.
 *
 * Each check is independent — a failure in one does not prevent the others from
 * running. Never throws; all errors are captured as 'fail' check entries.
 *
 * @param {object} [_inject] - test isolation fields (see module doc)
 * @returns {Promise<{ ok: boolean, checks: Array<{name: string, status: string, detail: string}> }>}
 */
async function runContractCheck(_inject) {
  // Create an internal temp dir for the doctor's own transient files (models config, etc.)
  // This is SEPARATE from any injected _paths so tests are fully isolated.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-contract-'));

  // Resolve _paths: use injected or create in tmpDir
  const _paths = (_inject && _inject._paths) || {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };

  // Resolve _configFile: use injected or create native engine config in tmpDir
  let _configFile = _inject && _inject._configFile;
  if (!_configFile) {
    const configDir = path.join(tmpDir, '.spec-flow');
    fs.mkdirSync(configDir, { recursive: true });
    _configFile = path.join(configDir, 'config.json');
    fs.writeFileSync(_configFile, JSON.stringify({ taskCore: { engine: 'native' } }), 'utf8');
  }

  const simulateMissingTool = _inject && _inject._simulateMissingTool;

  const checks = [];

  // Run all 5 checks sequentially. Errors are caught per-check so one failure
  // does not abort the remaining checks.
  const checkRunners = [
    () => _checkMcpSurface(_paths, _configFile, simulateMissingTool),
    () => _checkCliSubcommands(),
    () => _checkModelsShim(tmpDir),
    () => _checkRoundTrip(_paths, _configFile),
    () => _checkResponseShapes(_paths, _configFile),
  ];

  for (const runner of checkRunners) {
    try {
      checks.push(await runner());
    } catch (err) {
      // Defensive: a check function threw unexpectedly — capture as fail
      checks.push({
        name: 'unknown-check',
        status: 'fail',
        detail: `unexpected error during check: ${err.message}`,
      });
    }
  }

  const ok = checks.every((c) => c.status === 'pass');
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// CLI runner — C-4 gate (run via `node lib/doctor-contract.cjs`)
// ---------------------------------------------------------------------------

if (require.main === module) {
  runContractCheck()
    .then(({ ok, checks }) => {
      for (const check of checks) {
        const marker = check.status === 'pass' ? 'PASS' : 'FAIL';
        process.stderr.write(`[${marker}] ${check.name}: ${check.detail}\n`);
      }
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`doctor-contract: fatal error: ${err.message}\n`);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runContractCheck };
