/**
 * agent-native-driver.cjs — GenerationSpec builder for agent-native AI ops.
 *
 * Produces a GenerationSpec plain object that the AIRouter writes to stdout.
 * The orchestrator LLM reads the spec and performs the AI operation without
 * any LLM call, network request, or HTTP client being needed here.
 *
 * Supported operations (SD §9.2):
 *   parse-prd         — generate pending tasks from a requirements document.
 *   expand            — generate subtasks for a given parent task.
 *   analyze-complexity — return per-task complexity + recommendedSubtasks.
 *   research          — research a query and format results.
 *
 * Public API:
 *   generateSpec(op, inputContent, tag, context) → GenerationSpec
 *
 * Constraints:
 *   Zero external dependencies. Pure Node CommonJS. No network / HTTP client.
 *   Any diagnostic output goes to stderr only — never log the spec to stdout
 *   (AIRouter writes it; this module only builds it).
 *
 * FR-002, FR-005, FR-011 (SD §5.1); TC-003, TC-010, TC-012 (SD §13.2).
 */
'use strict';

const { TASK_SCHEMA } = require('./task-schema.cjs');

// ---------------------------------------------------------------------------
// Operation-specific instructions and expectedOutput descriptions
// ---------------------------------------------------------------------------

/**
 * Per-operation configuration for instructions and expectedOutput descriptions.
 * Each entry is specific enough to guide an orchestrator LLM toward the correct
 * output shape while remaining concise.
 */
const OP_CONFIG = {
  'parse-prd': {
    instructions:
      'Parse the provided inputContent (a requirements / SD document) and generate ' +
      'a set of pending tasks that implement the requirements. Follow taskSchema exactly ' +
      'for every task object. Assign sequential string ids starting from "1". ' +
      'Set status to "pending" and choose an appropriate priority. ' +
      'Return the tasks as a JSON array.',
    expectedOutputDescription:
      'Array of Task objects parsed from the requirements document, each conforming to taskSchema.',
  },
  'expand': {
    instructions:
      'Generate subtasks for the parent task identified by context.parentTaskId. ' +
      'Each subtask must conform to taskSchema. Avoid ids already listed in ' +
      'context.existingSubtaskIds. If context.existingTaskIds is provided, also ' +
      'avoid colliding with those top-level task ids. ' +
      'Return the subtasks as a JSON array ordered by execution sequence.',
    expectedOutputDescription:
      'Array of subtask Task objects for the parent task, each conforming to taskSchema.',
  },
  'analyze-complexity': {
    instructions:
      'Analyze the tasks described in inputContent and return a complexity assessment ' +
      'for each task. For every task include: id, complexity (number 1-10), and ' +
      'recommendedSubtasks (number of subtasks recommended to break the task into). ' +
      'Return the analysis as a JSON array, one entry per task.',
    expectedOutputDescription:
      'Array of complexity analysis entries, each with id, complexity, and recommendedSubtasks.',
  },
  'research': {
    instructions:
      'Research the query provided in inputContent and return structured results. ' +
      'Summarize findings clearly. Return the research results as a JSON array of ' +
      'result entries, each with a source and summary field.',
    expectedOutputDescription:
      'Array of research result entries, each with source and summary fields.',
  },
};

// ---------------------------------------------------------------------------
// generateSpec
// ---------------------------------------------------------------------------

/**
 * Build a GenerationSpec plain object for the given AI operation.
 *
 * The caller (AIRouter) is responsible for writing the returned spec to stdout.
 * This function is synchronous and performs no I/O.
 *
 * @param {string} op           - AI operation: 'parse-prd' | 'expand' |
 *                                'analyze-complexity' | 'research'
 * @param {string} inputContent - SD.md content, task details, or query string.
 * @param {string} tag          - Active tag (e.g. 'main').
 * @param {object} [context]    - Optional context object. For 'expand':
 *                                { parentTaskId, existingSubtaskIds, existingTaskIds? }.
 *                                May also carry existingTaskIds for id-collision avoidance.
 * @returns {GenerationSpec} Plain object with all required spec fields.
 */
function generateSpec(op, inputContent, tag, context) {
  const cfg = OP_CONFIG[op];

  const spec = {
    operation: op,
    tag: tag,
    inputContent: inputContent,
    taskSchema: TASK_SCHEMA,
    expectedOutput: {
      type: 'array',
      description: cfg ? cfg.expectedOutputDescription : 'Array of results.',
    },
    instructions: cfg ? cfg.instructions : `Execute the "${op}" operation on the provided inputContent and return results as a JSON array.`,
  };

  // Include context only when the caller provided it (for 'expand' and other
  // context-carrying ops). Omit entirely when undefined to keep the spec clean.
  if (context !== undefined && context !== null) {
    spec.context = context;
  }

  return spec;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateSpec,
};
