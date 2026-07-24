/**
 * expand-hook.cjs — ExpandHook thin gateway module for spec-flow native task manager.
 *
 * Provides a deterministic entry point that validates structured subtask input and
 * delegates persistence to SubtaskManager. Zero AI logic, zero network calls, zero
 * complexity calculation — pure validation + delegation (SD §6.3 D7, FR-012, FR-013).
 *
 * Public API (SD §9.1 expand, FR-012, FR-013):
 *   expandHook(taskId, subtasksInput, tag, _paths?) → Subtask[]
 *
 * Error codes (SD §12.2):
 *   ERR_INVALID_SUBTASKS — subtasksInput is not an Array, or an element lacks a
 *                          non-empty string title field.
 *   ERR_TAG_NOT_FOUND    — (propagated from SubtaskManager) tag does not exist.
 *   ERR_TASK_NOT_FOUND   — (propagated from SubtaskManager) parent task not found in tag.
 *
 * Architecture notes:
 *   - SubtaskManager (lib/subtask-manager.cjs) exports addSubtask and computeCompletion
 *     but does NOT export an expand function. ExpandHook therefore loops addSubtask for
 *     each element — one read-write per element. Each addSubtask reads current state so
 *     the n = subtasks.length + 1 derivation is correct across successive calls.
 *   - This module does NOT reimplement file I/O; all storage is delegated to
 *     SubtaskManager which in turn delegates to StorageCore (lib/task-core.cjs).
 *   - _paths is forwarded as-is to addSubtask to maintain test hermeticity.
 */
'use strict';
const { addSubtask } = require('./subtask-manager.cjs');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and persist a structured list of subtasks under the given parent task.
 *
 * Steps (SD §9.1 expand, SD §6.3 D7, FR-012, FR-013):
 *   1. Validate subtasksInput is an Array — throw ERR_INVALID_SUBTASKS if not.
 *   2. Validate each element has { title: <non-empty string> } — throw ERR_INVALID_SUBTASKS
 *      if any element fails.
 *   3. For empty array → return [] immediately (no-op; no file writes).
 *   4. Loop addSubtask(taskId, element, tag, _paths) for each element (delegation).
 *      Subtask id is derived by SubtaskManager as "${taskId}.${n}" where n grows
 *      from subtasks.length + 1 on each successive call (FR-013 append guarantee).
 *   5. Return array of all created subtask objects (each with derived hierarchical id).
 *
 * @param {string}   taskId         - id of the parent task (top-level, e.g. "5")
 * @param {object[]} subtasksInput  - Array of subtask descriptors; each must have
 *                                    { title: string (non-empty), description?, details?,
 *                                      testStrategy?, status? }. Any `id` field is ignored
 *                                    (id is derived by SubtaskManager).
 * @param {string}   tag            - tag namespace to operate on
 * @param {object}   [_paths]       - { tasksFile? } for test isolation; omit in production
 * @returns {object[]} array of newly created subtask objects (with derived hierarchical ids)
 * @throws {Error} with .code='ERR_INVALID_SUBTASKS' when subtasksInput is not an Array or
 *                 any element lacks a non-empty string title
 * @throws {Error} with .code='ERR_TAG_NOT_FOUND'    propagated from SubtaskManager
 * @throws {Error} with .code='ERR_TASK_NOT_FOUND'   propagated from SubtaskManager
 */
function expandHook(taskId, subtasksInput, tag, _paths) {
  // 1. Validate subtasksInput is an Array
  if (!Array.isArray(subtasksInput)) {
    const e = new Error(
      'subtasksInput must be an Array of subtask objects with at least { title: string }. ' +
      `Received type: ${subtasksInput === null ? 'null' : typeof subtasksInput}.`
    );
    e.code = 'ERR_INVALID_SUBTASKS';
    throw e;
  }

  // 2. Validate each element has a non-empty string title
  for (let i = 0; i < subtasksInput.length; i++) {
    const element = subtasksInput[i];
    if (
      !element ||
      typeof element.title !== 'string' ||
      element.title.trim() === ''
    ) {
      const e = new Error(
        `subtasksInput[${i}] must have a non-empty string "title" field. ` +
        `Received: ${JSON.stringify(element)}`
      );
      e.code = 'ERR_INVALID_SUBTASKS';
      throw e;
    }
  }

  // 3. Empty array → no-op
  if (subtasksInput.length === 0) {
    return [];
  }

  // 4. Delegate to SubtaskManager (no expand export — loop addSubtask per element)
  //    Each addSubtask call reads tasks.json fresh, so n = subtasks.length + 1 is
  //    correct for each successive call (FR-013 append guarantee).
  const created = [];
  for (const element of subtasksInput) {
    const subtask = addSubtask(taskId, element, tag, _paths);
    created.push(subtask);
  }

  // 5. Return all created subtask objects
  return created;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  expandHook,
};
