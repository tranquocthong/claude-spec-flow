/**
 * task-importer.cjs — TaskImporter: single validated write layer for all AI output.
 *
 * Validates schema, normalizes status to 'pending' (or caller-supplied forceStatus),
 * and writes atomically via the native storage core. Implements the reject-entire-batch
 * contract (D3): if ANY task/subtask is invalid the file is left byte-identical.
 *
 * Public API (SD §9.1, FR-003, FR-004, FR-012):
 *   importTasks(tag, tasks, options?, _paths?)      → { imported: number }
 *   importSubtasks(tag, parentTaskId, subtasks, _paths?) → { imported: number }
 *
 * Error codes (SD §12.2):
 *   ERR_AI_SCHEMA_INVALID — one or more tasks/subtasks failed schema validation.
 *                           The batch is rejected; no write occurs.
 *
 * Zero external dependencies — pure Node CommonJS (FR-003, TC-006, TC-011).
 * All file I/O reuses _readTasksFile / _writeTasksFileAtomic from task-core.cjs
 * (write-tmp-then-rename, SD §6 D3, FR-002).
 */
'use strict';
const { _readTasksFile, _writeTasksFileAtomic, TASKS_FILE } = require('./task-core.cjs');
const { validateTaskSchema } = require('./task-schema.cjs');
const { addSubtask } = require('./subtask-manager.cjs');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `tag` is a non-empty string.
 * @param {*} tag
 * @throws {Error} with a descriptive message when invalid
 */
function assertTag(tag) {
  if (!tag || typeof tag !== 'string' || !tag.trim()) {
    const e = new Error(
      'tag must be a non-empty string; received: ' + JSON.stringify(tag)
    );
    e.code = 'ERR_INVALID_TAG';
    throw e;
  }
}

/**
 * Validate that a subtask object has a non-empty title string.
 * Returns { valid, errors } matching the shape of validateTaskSchema so callers
 * can use the same reject-entire-batch pattern.
 *
 * @param {*} subtask
 * @returns {{ valid: boolean, errors: Array<{ field: string, reason: string }> }}
 */
function validateSubtaskSchema(subtask) {
  const errors = [];

  if (!subtask || typeof subtask !== 'object' || Array.isArray(subtask)) {
    errors.push({ field: 'subtask', reason: 'must be a non-null object' });
    return { valid: false, errors };
  }

  if (subtask.title === undefined || subtask.title === null) {
    errors.push({ field: 'title', reason: 'required field is missing' });
  } else if (typeof subtask.title !== 'string') {
    errors.push({ field: 'title', reason: 'must be a string, got ' + typeof subtask.title });
  } else if (subtask.title.trim().length === 0) {
    errors.push({ field: 'title', reason: 'must be a non-empty string (whitespace-only is not allowed)' });
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import (replace) a batch of tasks into the given tag namespace.
 *
 * Algorithm (FR-003, FR-004, FR-012, D3, D4):
 *   1. Assert tag is a non-empty string.
 *   2. Validate EVERY task via validateTaskSchema — collect the first invalid one.
 *      If ANY task is invalid → throw ERR_AI_SCHEMA_INVALID; write NOTHING (D3).
 *   3. Normalize: set every task's status to options.forceStatus (default 'pending') (D4).
 *   4. Read tasks.json; ensure the tag namespace exists (create if absent — write op).
 *   5. Replace data[tag].tasks with the normalized tasks array.
 *   6. Write atomically via _writeTasksFileAtomic (temp-then-rename, SD §6 D3).
 *   7. Return { imported: tasks.length }.
 *
 * @param {string}  tag      - tag namespace to write into; must be a non-empty string
 * @param {Array}   tasks    - array of task objects to import
 * @param {object}  [options] - { forceStatus?: string }; default { forceStatus: 'pending' }
 * @param {object}  [_paths] - { tasksFile? } for test isolation; production callers omit
 * @returns {{ imported: number }}
 * @throws {Error} with .code='ERR_AI_SCHEMA_INVALID' when any task fails schema validation
 */
function importTasks(tag, tasks, options, _paths) {
  // 1. Tag validation
  assertTag(tag);

  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const forceStatus = (options && typeof options.forceStatus === 'string')
    ? options.forceStatus
    : 'pending';

  const taskList = Array.isArray(tasks) ? tasks : [];

  // 2. Validate every task before touching the file (reject-entire-batch, D3)
  for (const task of taskList) {
    const { valid, errors } = validateTaskSchema(task);
    if (!valid) {
      const taskId = (task && task.id != null) ? String(task.id) : '(unknown)';
      const first = errors[0];
      const e = new Error(
        `Task "${taskId}" failed schema validation: field "${first.field}" — ${first.reason}`
      );
      e.code = 'ERR_AI_SCHEMA_INVALID';
      throw e;
    }
  }

  // 3. Normalize status for every task (D4/BL-05)
  const normalizedTasks = taskList.map((task) =>
    Object.assign({}, task, { status: forceStatus })
  );

  // 4-6. Read → ensure tag namespace → replace tasks → atomic write
  //
  // Single read-mutate-write cycle (mirrors addTask in task-core.cjs):
  //   a. Read (ENOENT → {} treated as empty structure)
  //   b. Initialise tag namespace when absent (write op — auto-create is correct here)
  //   c. Replace tasks array; preserve/create metadata
  //   d. Atomic write (temp-then-rename)
  const data = _readTasksFile(tasksFile);
  if (!data[tag]) {
    data[tag] = { tasks: [], metadata: {} };
  }
  if (!data[tag].metadata) {
    data[tag].metadata = {};
  }
  data[tag].tasks = normalizedTasks;

  _writeTasksFileAtomic(tasksFile, data);

  // 7. Return count
  return { imported: taskList.length };
}

/**
 * Import a batch of subtasks under the specified parent task in the given tag.
 *
 * Algorithm (FR-003, FR-012, D3):
 *   1. Assert tag is a non-empty string.
 *   2. Validate EVERY subtask via validateSubtaskSchema — if ANY is invalid →
 *      throw ERR_AI_SCHEMA_INVALID; write NOTHING (reject-entire-batch, D3).
 *   3. Delegate to addSubtask (subtask-manager.cjs) for each valid subtask in order.
 *      addSubtask auto-assigns ids "<parentId>.<n>" (FR-010).
 *   4. Return { imported: subtasks.length }.
 *
 * @param {string}  tag          - tag namespace; must be a non-empty string
 * @param {string}  parentTaskId - id of the parent task (e.g. "3")
 * @param {Array}   subtasks     - array of subtask objects to import
 * @param {object}  [_paths]     - { tasksFile? } for test isolation; production callers omit
 * @returns {{ imported: number }}
 * @throws {Error} with .code='ERR_AI_SCHEMA_INVALID' when any subtask fails validation
 * @throws {Error} with .code='ERR_TAG_NOT_FOUND'     (from addSubtask) when tag is absent
 * @throws {Error} with .code='ERR_TASK_NOT_FOUND'    (from addSubtask) when parent is absent
 */
function importSubtasks(tag, parentTaskId, subtasks, _paths) {
  // 1. Tag validation
  assertTag(tag);

  const subtaskList = Array.isArray(subtasks) ? subtasks : [];

  // 2. Validate every subtask before writing any (reject-entire-batch, D3)
  for (let i = 0; i < subtaskList.length; i++) {
    const subtask = subtaskList[i];
    const { valid, errors } = validateSubtaskSchema(subtask);
    if (!valid) {
      const first = errors[0];
      const e = new Error(
        `Subtask at index ${i} failed validation: field "${first.field}" — ${first.reason}`
      );
      e.code = 'ERR_AI_SCHEMA_INVALID';
      throw e;
    }
  }

  // 3. Delegate to addSubtask for each validated subtask in order
  for (const subtask of subtaskList) {
    addSubtask(String(parentTaskId), subtask, tag, _paths);
  }

  // 4. Return count
  return { imported: subtaskList.length };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  importTasks,
  importSubtasks,
};
