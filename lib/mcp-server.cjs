/**
 * mcp-server.cjs — dependency-free MCP server core for spec-flow.
 *
 * Implements the 5 MCP tools (set_task_status, get_task, get_tasks,
 * next_task, add_task) with parameter + response shapes byte-compatible
 * with task-master-ai@0.43.1 (SD §9.1, §9.2 FR-001..FR-006).
 *
 * Design decisions:
 *   - Zero external dependencies: pure Node.js CommonJS (no @modelcontextprotocol/sdk).
 *     SD §6.2 lists "MCP SDK" as an aspirational Pass-2 note; this sub honors the
 *     repo's hard zero-dependency constraint instead (no package.json, no node_modules).
 *   - All logic lives in this module; bin/mcp-server.js is the transport-only stdio loop.
 *   - Engine routing is fully delegated to engine-router.cjs (D3 — config read once
 *     at entry, not here). This module does NOT re-read config.json.
 *   - Stats shaping: task-core returns flat stats; the MCP contract requires
 *     { total, byStatus: {...}, completionPercentage }. The reshaping is delegated to
 *     stats-builder.cjs via toContractStats() (FR-003, SD §9.1).
 *
 * Public exports:
 *   TOOL_REGISTRY         — 5 tool definitions with required + param schemas
 *   handleToolCall(name, args) → Promise<result | {error:{code,message}}>
 *   handleJsonRpcRequest(req)  → Promise<{jsonrpc,id,result}|{jsonrpc,id,error}>
 *
 * Error envelope convention (mirroring engine-router — FR-018, FR-019):
 *   { error: { code: string, message: string } }
 * Errors from engine-router are passed through unchanged.
 */
'use strict';

const { routeToEngine } = require('./engine-router.cjs');
const { toContractStats } = require('./stats-builder.cjs');
const { wrapError } = require('./mcp-error-wrapper.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All valid task status values — must match task-core.cjs VALID_STATUSES (SD §9.1). */
const STATUS_KEYS = [
  'pending',
  'in-progress',
  'done',
  'blocked',
  'deferred',
  'cancelled',
  'review',
];

// ---------------------------------------------------------------------------
// Tool registry — 5 tools, byte-compatible with task-master-ai@0.43.1 (FR-006)
// ---------------------------------------------------------------------------

/**
 * Tool registry mapping tool name → schema definition.
 *
 * Fields:
 *   description {string} — human-readable description for tools/list responses.
 *   required    {string[]} — list of required param names; empty array when all optional.
 *   params      {object}   — param name → { type, description } for tools/list schema.
 *
 * Param names and types match the observable contract of task-master-ai@0.43.1 (FR-006).
 */
const TOOL_REGISTRY = {
  set_task_status: {
    description: 'Set the status of a task by ID. Returns { success, task }.',
    required: ['taskId', 'status'],
    params: {
      taskId: { type: 'string', description: 'Task ID (e.g. "1", "2.3" for subtask)' },
      status: { type: 'string', description: 'New status: pending|in-progress|done|blocked|deferred|cancelled|review' },
      tag: { type: 'string', description: 'Tag namespace (optional; falls back to currentTag)' },
    },
  },

  get_task: {
    description: 'Get a single task by ID. Returns { task }.',
    required: ['taskId'],
    params: {
      taskId: { type: 'string', description: 'Task ID (e.g. "1")' },
      tag: { type: 'string', description: 'Tag namespace (optional; falls back to currentTag)' },
    },
  },

  get_tasks: {
    description: 'List all tasks in a tag with optional filtering. Returns { tasks, stats }.',
    required: [],
    params: {
      tag: { type: 'string', description: 'Tag namespace (optional; falls back to currentTag)' },
      status: { type: 'string', description: 'Status filter — single value or comma-separated list (optional)' },
      withSubtasks: { type: 'boolean', description: 'Include subtasks in each task object (optional)' },
    },
  },

  next_task: {
    description: 'Get the next actionable pending task (dependencies all done). Returns { task, message? }.',
    required: [],
    params: {
      tag: { type: 'string', description: 'Tag namespace (optional; falls back to currentTag)' },
    },
  },

  add_task: {
    description: 'Add a new task to a tag. Returns { task } with auto-assigned id.',
    required: ['title'],
    params: {
      title: { type: 'string', description: 'Task title (required)' },
      description: { type: 'string', description: 'Task description (optional)' },
      details: { type: 'string', description: 'Implementation details (optional)' },
      priority: { type: 'string', description: 'Priority: high|medium|low (optional; default medium)' },
      tag: { type: 'string', description: 'Tag namespace (optional; falls back to currentTag)' },
      dependencies: { type: 'array', description: 'Dependency task ID strings (optional)' },
    },
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build engine-router args from MCP tool args.
 *
 * Engine-router uses 'id' for get_task, but the MCP contract param is 'taskId'.
 * All other tools pass args through unchanged (engine-router already uses 'taskId').
 *
 * Test-isolation fields (_paths, _configFile) are always preserved.
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {object}
 */
function _buildEngineArgs(toolName, args) {
  if (toolName === 'get_task') {
    // MCP param name: 'taskId'; engine-router get_task dispatch uses args.id
    return {
      id: args.taskId,
      tag: args.tag,
      _paths: args._paths,
      _configFile: args._configFile,
    };
  }
  return args;
}

/**
 * Shape a raw engine-router result into the MCP response envelope for the tool.
 *
 * Response shapes (SD §9.2, FR-001..FR-005):
 *   set_task_status → { success: boolean, task: Task }
 *   get_task        → { task: Task } | error when result is null (task not found)
 *   get_tasks       → { tasks: Task[], stats: Stats }
 *   next_task       → { task: Task|null, message?: string }
 *   add_task        → { task: Task }
 *
 * @param {string} toolName
 * @param {*}      result - raw value from routeToEngine
 * @returns {object}
 */
function _shapeResponse(toolName, result) {
  switch (toolName) {
    case 'set_task_status':
      return { success: true, task: result };

    case 'get_task':
      // task-core returns null when task not found (does not throw) — convert to error envelope
      if (result === null || result === undefined) {
        return wrapError({ code: 'ERR_TASK_NOT_FOUND', message: 'Task not found' });
      }
      return { task: result };

    case 'get_tasks':
      return {
        tasks: (result && Array.isArray(result.tasks)) ? result.tasks : [],
        stats: toContractStats(result && result.stats),
      };

    case 'next_task':
      // engine-router returns { task, reason? } — map 'reason' → 'message' for MCP contract
      return {
        task: (result && result.task) || null,
        message: (result && (result.reason || result.message)) || undefined,
      };

    case 'add_task':
      return { task: result };

    default:
      return result;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle an MCP tool call. Validates tool existence and required params, then
 * routes to engine-router and shapes the response to the MCP contract.
 *
 * Never throws — all errors are returned as { error: { code, message } }.
 *
 * Test isolation: _paths and _configFile in args are forwarded to engine-router
 * so tests can inject tmp paths without touching real .taskmaster/ or .spec-flow/.
 *
 * @param {string} toolName - one of the 5 registered MCP tool names
 * @param {object} [args]   - MCP tool arguments; may include _paths and _configFile
 *                            for test isolation (forwarded to engine-router)
 * @returns {Promise<object>} MCP response shape or { error: { code, message } }
 */
async function handleToolCall(toolName, args) {
  // 1. Validate tool exists in registry
  const toolDef = TOOL_REGISTRY[toolName];
  if (!toolDef) {
    return wrapError({ code: 'ERR_UNKNOWN_TOOL', message: `Unknown MCP tool: '${toolName}'` });
  }

  // 2. Validate required params are present and non-empty
  const safeArgs = args || {};
  for (const param of toolDef.required) {
    const val = safeArgs[param];
    if (val === undefined || val === null || val === '') {
      return wrapError({ code: 'ERR_MISSING_PARAM', message: `Required parameter missing: '${param}'` });
    }
  }

  // 3. Build engine-router args (maps param names where needed, e.g. get_task taskId→id)
  const engineArgs = _buildEngineArgs(toolName, safeArgs);

  // 4. Route to engine — always returns, never throws (engine-router contract)
  let result;
  try {
    result = await routeToEngine(toolName, engineArgs);
  } catch (err) {
    // Defensive: routeToEngine should not throw, but guard against unexpected errors
    return wrapError(err);
  }

  // 5. Pass through error envelopes from engine-router unchanged (D5 — no code translation)
  if (result && result.error) {
    return result;
  }

  // 6. Shape raw engine result into MCP response contract
  return _shapeResponse(toolName, result);
}

/**
 * Handle a JSON-RPC 2.0 request.
 *
 * Supported methods:
 *   tools/call  — dispatch to handleToolCall; params: { name, arguments }
 *   tools/list  — return all 5 tool definitions in JSON Schema format
 *
 * Returns a full JSON-RPC 2.0 response object. Never throws.
 *
 * @param {object} request - { jsonrpc, id, method, params }
 * @returns {Promise<{jsonrpc: string, id: *, result?: *, error?: *}>}
 */
async function handleJsonRpcRequest(request) {
  const { jsonrpc, id, method, params } = request || {};
  const safeId = id !== undefined ? id : null;

  if (jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: safeId,
      error: {
        code: -32600,
        message: 'Invalid Request: jsonrpc field must be "2.0"',
      },
    };
  }

  // --- tools/call ---
  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = params && params.arguments;

    const toolResult = await handleToolCall(toolName, toolArgs);

    if (toolResult && toolResult.error) {
      // Tool returned an error envelope — surface as JSON-RPC error
      return {
        jsonrpc: '2.0',
        id: safeId,
        error: toolResult.error,
      };
    }

    return {
      jsonrpc: '2.0',
      id: safeId,
      result: toolResult,
    };
  }

  // --- tools/list ---
  if (method === 'tools/list') {
    const tools = Object.entries(TOOL_REGISTRY).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: {
        type: 'object',
        properties: def.params,
        required: def.required,
      },
    }));
    return {
      jsonrpc: '2.0',
      id: safeId,
      result: { tools },
    };
  }

  // --- unknown method ---
  return {
    jsonrpc: '2.0',
    id: safeId,
    error: {
      code: -32601,
      message: `Method not found: '${method}'`,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  TOOL_REGISTRY,
  handleToolCall,
  handleJsonRpcRequest,
  // Exported for test introspection
  STATUS_KEYS,
};
