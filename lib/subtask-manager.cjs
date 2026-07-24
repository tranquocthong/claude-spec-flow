/**
 * subtask-manager.cjs — SubtaskManager module for spec-flow native task manager.
 *
 * Provides hierarchical subtask creation and completion calculation on top of
 * StorageCore (lib/task-core.cjs). All file paths are injectable via an optional
 * `_paths` argument so every function can be tested hermetically against a tmp
 * directory without ever touching the project's real .taskmaster/ tree.
 *
 * Public API (SD §9.1, FR-010, FR-011):
 *   addSubtask(parentId, subtaskData, tag, _paths?) → Subtask  (FR-010)
 *   computeCompletion(task)                         → number   (FR-011, pure, no I/O)
 *
 * Error codes (SD §12.2):
 *   ERR_TAG_NOT_FOUND  — tag does not exist in tasks.json (read op, SD §6 D3).
 *   ERR_TASK_NOT_FOUND — parent task id does not exist in the tag's tasks array.
 *
 * Architecture notes:
 *   - All file I/O delegates to _readTasksFile / _writeTasksFileAtomic from
 *     task-core.cjs (no reimplementation of file I/O — reuse StorageCore helpers).
 *   - computeCompletion is a pure function: no I/O, no side effects. StorageCore's
 *     nextTask can import and call it when computing task eligibility (SD §6 D5).
 *   - Subtask id derivation: n = parent.subtasks.length + 1 at call time (SD §10.3).
 *   - Any incoming `id` field in subtaskData is silently ignored (SD §9.1 addSubtask).
 */
'use strict';
const { _readTasksFile, _writeTasksFileAtomic, TASKS_FILE } = require('./task-core.cjs');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a subtask to the specified parent task in the given tag namespace.
 *
 * Steps (SD §9.1 addSubtask, FR-010, SD §10.3):
 *   1. Read tasks.json, locate tag and parent task.
 *      - Tag absent → throw ERR_TAG_NOT_FOUND.
 *      - Parent id absent in tag's tasks array → throw ERR_TASK_NOT_FOUND.
 *   2. Compute n = parent.subtasks.length + 1.
 *   3. Build subtask: id = "${parentId}.${n}"; status = subtaskData.status ?? 'pending';
 *      copy title, description, details, testStrategy from subtaskData.
 *      Any incoming `id` in subtaskData is ignored (id is always derived).
 *   4. Push subtask to parent.subtasks[]; atomic write via _writeTasksFileAtomic.
 *   5. Return the created subtask object.
 *
 * @param {string}  parentId     - id of the parent task (top-level, e.g. "3")
 * @param {object}  subtaskData  - { title, description?, details?, testStrategy?, status? }
 *                                 Any `id` field present is silently ignored.
 * @param {string}  tag          - tag namespace to operate on
 * @param {object}  [_paths]     - { tasksFile? } for test isolation; production callers omit
 * @returns {object} the newly created subtask object (with derived hierarchical id)
 * @throws {Error} with .code='ERR_TAG_NOT_FOUND'  when tag is absent in tasks.json
 * @throws {Error} with .code='ERR_TASK_NOT_FOUND' when parent task is not found in tag
 */
function addSubtask(parentId, subtaskData, tag, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;

  // 1. Read tasks data; validate tag exists (read op — no auto-create per SD §6 D3)
  const data = _readTasksFile(tasksFile);

  if (!data[tag]) {
    const e = new Error(
      `Tag "${tag}" does not exist in tasks.json. ` +
      'Run use-tag <tag> to create or switch to it before adding subtasks.'
    );
    e.code = 'ERR_TAG_NOT_FOUND';
    throw e;
  }

  const tasks = Array.isArray(data[tag].tasks) ? data[tag].tasks : [];

  // 2. Locate parent task by id
  const parentStr = String(parentId);
  const parent = tasks.find((t) => String(t.id) === parentStr);

  if (!parent) {
    const e = new Error(
      `Task "${parentId}" not found in tag "${tag}". Cannot add subtask to a non-existent parent.`
    );
    e.code = 'ERR_TASK_NOT_FOUND';
    throw e;
  }

  // Ensure subtasks array exists on the parent
  if (!Array.isArray(parent.subtasks)) {
    parent.subtasks = [];
  }

  // 3. Derive subtask id and build subtask object (SD §10.3, FR-010)
  const n = parent.subtasks.length + 1;
  const subtask = {
    id: `${parentId}.${n}`,                   // derived — incoming id is always ignored
    title: (subtaskData && subtaskData.title) || '',
    description: (subtaskData && subtaskData.description) || '',
    details: (subtaskData && subtaskData.details) || '',
    testStrategy: (subtaskData && subtaskData.testStrategy) || '',
    status: (subtaskData && subtaskData.status) || 'pending',
  };

  // 4. Append and write atomically
  parent.subtasks.push(subtask);
  _writeTasksFileAtomic(tasksFile, data);

  // 5. Return the created subtask
  return subtask;
}

/**
 * Compute the completion percentage of a task, accounting for subtasks.
 *
 * Logic (SD §9.1 computeCompletion, FR-011):
 *   - If task has subtasks (task.subtasks.length > 0):
 *       doneCount = subtasks with status === 'done'
 *       return Math.round((doneCount / task.subtasks.length) * 100)
 *   - If no subtasks:
 *       return task.status === 'done' ? 100 : 0
 *
 * Pure function — no I/O, no side effects. Safe to call in hot paths such as
 * next_task eligibility checks in StorageCore (SD §6 D5).
 *
 * @param {object} task - task object with { status: string, subtasks: object[] }
 * @returns {number} completion percentage 0–100 (integer)
 */
function computeCompletion(task) {
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];

  if (subtasks.length > 0) {
    const doneCount = subtasks.filter((s) => s.status === 'done').length;
    return Math.round((doneCount / subtasks.length) * 100);
  }

  // No subtasks: fall back to the task's own status (FR-011)
  return task.status === 'done' ? 100 : 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  addSubtask,
  computeCompletion,
};
