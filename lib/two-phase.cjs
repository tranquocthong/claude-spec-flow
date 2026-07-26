/**
 * two-phase.cjs — Two-phase orchestrator-side protocol helper (SD §10.2, decision D1).
 *
 * Implements the 3-phase agent-native protocol IN-PROCESS (no real subprocess,
 * no real LLM). The orchestrator's LLM capability is injected via deps.generate,
 * so this helper never calls an LLM itself.
 *
 * Protocol phases:
 *   Phase 1 (emit spec):   call the CLI with CLAUDECODE=1 + stdout capture.
 *                          The AIRouter detects the host flag, builds a GenerationSpec
 *                          via AgentNativeDriver, and writes it to the captured stdout.
 *   Phase 2 (generate):    call deps.generate(spec) — the injected orchestrator function.
 *                          Returns Task[] (or subtasks). No LLM work done here.
 *   Phase 3 (import):      call tasks-import via the CLI with the generated tasks as
 *                          injected stdin. TaskImporter validates schema, normalizes
 *                          status to 'pending', and writes atomically. Surfaces
 *                          ERR_AI_SCHEMA_INVALID from the importer on bad output.
 *
 * Supported operations:
 *   parse-prd         — requires params.input  (path to the SD / requirements file)
 *   expand            — requires params.id     (parent task id)
 *   analyze-complexity — uses params.tag only  (reads all tasks for the tag)
 *   research          — requires params.query  (positional query string)
 *
 * Public API:
 *   runAgentNativeOp(op, params, deps) → Promise<{ imported: number }>
 *
 * Parameters:
 *   op     {string}  — 'parse-prd' | 'expand' | 'analyze-complexity' | 'research'
 *   params {object}  — { tag, input?, id?, query? }  (op-specific CLI flags)
 *   deps   {object}  — {
 *            generate {async function(spec) → Task[]}  — REQUIRED; injected LLM capability.
 *            runCli   {async function}                 — optional; defaults to cli-dispatcher.cjs.
 *            _paths   {object}                         — optional test isolation:
 *                       { tasksFile?, stateFile?, configFile? }
 *                       configFile → forwarded as _configFile to Phase 1 so engine-router
 *                       and ai-hybrid use the test config instead of .spec-flow/config.json.
 *          }
 *
 * Zero external dependencies beyond sibling lib modules and Node built-ins.
 * CommonJS, 'use strict'.
 *
 * FR-002, FR-005, FR-007, FR-011, FR-012 (SD §5.1); D1, D7 (SD §10.2).
 */
'use strict';

// ---------------------------------------------------------------------------
// Phase 1 CLI argv builders — one per supported operation
// ---------------------------------------------------------------------------

/**
 * Map an operation name to the Phase 1 CLI argv array.
 *
 * Each argv array is passed to runCli(argv, inject) and targets the CLI
 * subcommand that emits a GenerationSpec when CLAUDECODE=1 is set in env.
 *
 * @param {string} op     - operation name
 * @param {object} params - { tag, input?, id?, query? }
 * @returns {string[]} argv without the node/bin entry (e.g. ['parse-prd', '--input', '...'])
 * @throws {Error} with code='ERR_UNKNOWN_OP' for unsupported operations
 */
function _buildPhase1Argv(op, params) {
  const tag = params.tag;
  switch (op) {
    case 'parse-prd':
      return ['parse-prd', '--input', params.input, '--tag', tag];
    case 'expand':
      return ['expand', '--id', String(params.id), '--tag', tag];
    case 'analyze-complexity':
      return ['analyze-complexity', '--tag', tag];
    case 'research':
      return ['research', params.query, '--tag', tag];
    default: {
      const err = new Error(
        `runAgentNativeOp: unknown operation "${op}". ` +
        'Supported: parse-prd, expand, analyze-complexity, research.'
      );
      err.code = 'ERR_UNKNOWN_OP';
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// runAgentNativeOp — public API
// ---------------------------------------------------------------------------

/**
 * Execute an AI operation using the 3-phase agent-native protocol.
 *
 * This function is purely in-process: it orchestrates the CLI (Phase 1 + 3)
 * and the injected generate() function (Phase 2) without spawning subprocesses
 * or making LLM calls itself.
 *
 * Phase 1 — Emit GenerationSpec:
 *   Calls runCli(phase1Argv, { _paths, _configFile, _inject: { _env, _stdout } }).
 *   The _env sets CLAUDECODE=1 so AIRouter sees a host present and writes the spec
 *   to the captured _stdout function instead of process.stdout. The captured output
 *   is JSON-parsed into the GenerationSpec object.
 *   If the CLI exits non-zero, throws with the stderr content.
 *
 * Phase 2 — Generate:
 *   Calls await deps.generate(spec). The caller supplies this function; in production
 *   it is backed by the orchestrator's LLM (Claude Code agent); in tests it is a mock.
 *   Returns Task[] for Phase 3.
 *
 * Phase 3 — Import:
 *   Calls runCli(['tasks-import', '--tag', params.tag], { _paths, _stdin: JSON.stringify(tasks) }).
 *   TaskImporter validates schema (throws ERR_AI_SCHEMA_INVALID on invalid tasks —
 *   reject-entire-batch; the tasks file is left byte-identical), normalizes statuses to
 *   'pending', and writes atomically. If the CLI exits non-zero, throws with stderr.
 *   On success, JSON-parses stdout to return { imported: N }.
 *
 * @param {string} op     - 'parse-prd' | 'expand' | 'analyze-complexity' | 'research'
 * @param {object} params - op-specific params: { tag, input?, id?, query? }
 * @param {object} deps   - {
 *   generate  {function}  REQUIRED — async (GenerationSpec) => Task[]
 *   runCli    {function}  optional — defaults to require('./cli-dispatcher.cjs').runCli
 *   _paths    {object}    optional — test isolation: { tasksFile?, stateFile?, configFile? }
 * }
 * @returns {Promise<{ imported: number }>}
 * @throws {Error} Phase 1 failure: CLI exits non-zero (code='ERR_PHASE1_FAILED')
 * @throws {Error} Phase 1 bad spec: captured stdout is not valid JSON (code='ERR_PHASE1_INVALID_SPEC')
 * @throws {Error} Phase 3 failure: e.g. ERR_AI_SCHEMA_INVALID surfaced from TaskImporter
 * @throws {Error} ERR_UNKNOWN_OP: unsupported operation name
 */
async function runAgentNativeOp(op, params, deps) {
  // Resolve injected dependencies.
  const runCli = (deps && typeof deps.runCli === 'function')
    ? deps.runCli
    : require('./cli-dispatcher.cjs').runCli;

  const _paths = deps && deps._paths;

  // _paths.configFile: test-isolated path to .spec-flow/config.json.
  // Forwarded as _configFile so engine-router and ai-hybrid use the test config
  // instead of the real .spec-flow/config.json in the working directory.
  const configFile = _paths && _paths.configFile;

  // Build Phase 1 CLI args for the requested operation.
  const phase1Argv = _buildPhase1Argv(op, params);

  // ---------------------------------------------------------------------------
  // Phase 1 — Emit GenerationSpec
  //
  // We inject CLAUDECODE=1 so AIRouter takes the agent-native host-present path
  // and writes the GenerationSpec to the _stdout callback instead of process.stdout.
  // The CLI handler emits { emitted: true } after the write and exits 0.
  // ---------------------------------------------------------------------------

  let capturedSpec = '';
  const captureStdout = (chunk) => {
    capturedSpec += String(chunk);
  };

  const phase1Result = await runCli(phase1Argv, {
    _paths,
    _configFile: configFile,
    _inject: {
      _env: { CLAUDECODE: '1' },
      _stdout: captureStdout,
    },
  });

  if (phase1Result.exitCode !== 0) {
    const err = new Error(
      'runAgentNativeOp Phase 1 failed for op "' + op + '": ' + phase1Result.stderr
    );
    err.code = 'ERR_PHASE1_FAILED';
    throw err;
  }

  // Parse the captured stdout as a GenerationSpec JSON object.
  let spec;
  try {
    spec = JSON.parse(capturedSpec);
  } catch (parseErr) {
    const err = new Error(
      'runAgentNativeOp Phase 1 produced non-JSON output for op "' + op +
      '": ' + parseErr.message +
      ' (captured: ' + capturedSpec.slice(0, 200) + ')'
    );
    err.code = 'ERR_PHASE1_INVALID_SPEC';
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Generate
  //
  // Delegate to the injected generate() function. In production this is backed
  // by the orchestrator LLM; in tests it is a mock returning fixed task JSON.
  // This module performs no LLM work.
  // ---------------------------------------------------------------------------

  const tasks = await deps.generate(spec);

  // ---------------------------------------------------------------------------
  // Phase 3 — Import
  //
  // Feed the generated tasks to the tasks-import subcommand via _stdin injection.
  // TaskImporter validates schema, normalizes statuses, and writes atomically.
  // ERR_AI_SCHEMA_INVALID surfaces here if any task is invalid.
  // ---------------------------------------------------------------------------

  const phase3Result = await runCli(
    ['tasks-import', '--tag', params.tag],
    {
      _paths,
      _stdin: JSON.stringify(tasks),
    }
  );

  if (phase3Result.exitCode !== 0) {
    // Propagate the error from TaskImporter with its original code.
    // stderr format from cli-dispatcher: "<CODE>: <message>" or plain message.
    const errMsg = phase3Result.stderr;
    const err = new Error(errMsg);

    // Extract the leading error code (e.g. "ERR_AI_SCHEMA_INVALID: ...") so
    // callers can check err.code programmatically.
    const codeMatch = errMsg.match(/^([A-Z][A-Z0-9_]+):/);
    if (codeMatch) {
      err.code = codeMatch[1];
    }
    throw err;
  }

  // Return the import count: { imported: N }.
  return JSON.parse(phase3Result.stdout);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runAgentNativeOp,
};
