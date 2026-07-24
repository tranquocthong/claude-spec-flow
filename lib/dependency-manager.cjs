/**
 * dependency-manager.cjs — DependencyManager module for spec-flow native task manager.
 *
 * Provides dependency management (add/remove) with full validation on top of
 * StorageCore (lib/task-core.cjs) and TagManager (lib/tag-manager.cjs).
 *
 * All file paths are injectable via an optional `_paths` argument so every
 * function can be tested hermetically against a tmp directory without ever
 * touching the project's real .taskmaster/ tree.
 *
 * Public API (SD §9.1, FR-005..FR-009):
 *   addDependency(taskId, depId, tag, _paths?)    → void
 *   removeDependency(taskId, depId, tag, _paths?) → void
 *
 * Validation order for addDependency (SD §9.1, §10.2):
 *   1. Tag exists in tasks.json      → ERR_TAG_NOT_FOUND  (FR-004)
 *   2. depId exists in tasks[tag]    → ERR_DEP_NOT_FOUND  (FR-007)
 *   3. DFS cycle check from depId   → ERR_DEP_CYCLE       (FR-006)
 *   4. Append depId (no-op if dup)  → atomic write        (FR-005)
 *
 * Validation order for removeDependency (SD §9.1):
 *   1. Tag exists in tasks.json      → ERR_TAG_NOT_FOUND  (FR-004)
 *   2. taskId exists in tasks[tag]   → ERR_DEP_NOT_FOUND  (FR-008)
 *   3. Filter depId out (no-op OK)  → atomic write        (FR-008)
 *
 * Error codes (SD §12.2):
 *   ERR_TAG_NOT_FOUND — tag namespace absent from tasks.json on a read/dep op.
 *   ERR_DEP_NOT_FOUND — depId or taskId does not exist in tasks.json[tag].tasks.
 *   ERR_DEP_CYCLE     — DFS finds that adding depId would create a cycle.
 *
 * Architecture notes:
 *   - Dependencies are intra-tag only (SD §6 D1, FR-009). depId is validated
 *     against tasks.json[tag]; a depId from a different tag is indistinguishable
 *     from a nonexistent id and returns ERR_DEP_NOT_FOUND.
 *   - Cycle detection uses iterative DFS with an explicit stack (SD §6 D2).
 *     No recursion → no call-stack overflow risk on long dependency chains.
 *   - All writes delegate to _writeTasksFileAtomic from task-core (SD §4 D3,
 *     write-temp-then-rename). No I/O reimplementation here.
 *   - ensureTagExists(tag, false) is reused from tag-manager so tag validation
 *     logic stays in one place (DRY).
 */
'use strict';
const { _readTasksFile, _writeTasksFileAtomic, TASKS_FILE, STATE_FILE } = require('./task-core.cjs');
const { ensureTagExists } = require('./tag-manager.cjs');

// ---------------------------------------------------------------------------
// Internal helper: build a task lookup map (id → task) for the given tag.
// Returns an empty Map when the tag or its tasks array does not exist.
// ---------------------------------------------------------------------------

/**
 * Build a Map<id, task> from tasks.json[tag].tasks for O(1) id lookup.
 * @param {object} data - full tasks data object
 * @param {string} tag
 * @returns {Map<string, object>}
 */
function buildTaskMap(data, tag) {
  const tagData = data[tag];
  if (!tagData || !Array.isArray(tagData.tasks)) return new Map();
  const map = new Map();
  for (const task of tagData.tasks) {
    map.set(String(task.id), task);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add depId to taskId.dependencies[] after full validation (FR-005, FR-006, FR-007, FR-009).
 *
 * Validation order (SD §10.2):
 *   1. Tag exists → ERR_TAG_NOT_FOUND (delegates to ensureTagExists, FR-004)
 *   2. depId exists in tasks.json[tag] → ERR_DEP_NOT_FOUND (FR-007)
 *   3. Iterative DFS from depId: if taskId is reachable → ERR_DEP_CYCLE (FR-006)
 *   4. Append depId to task.dependencies[] (no-op if already present) (FR-005)
 *   5. Atomic write
 *
 * Dependencies are strictly intra-tag (SD §6 D1, FR-009): a depId belonging to
 * another tag is absent from tasks.json[tag] and is rejected as ERR_DEP_NOT_FOUND.
 *
 * @param {string} taskId  - id of the task that will depend on depId
 * @param {string} depId   - id of the task being depended upon
 * @param {string} tag     - tag namespace (intra-tag only)
 * @param {object} [_paths] - { tasksFile?, stateFile? } for test isolation
 * @returns {void}
 * @throws {Error} with .code='ERR_TAG_NOT_FOUND' when tag is absent
 * @throws {Error} with .code='ERR_DEP_NOT_FOUND' when depId does not exist in tag
 * @throws {Error} with .code='ERR_DEP_CYCLE'     when adding dep would create a cycle
 */
function addDependency(taskId, depId, tag, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;

  // Step 1: Validate tag exists (read op — ensureTagExists throws ERR_TAG_NOT_FOUND if absent).
  // forWrite=false because we are reading the tag before conditionally writing.
  // Passing _paths so ensureTagExists uses the injected tasksFile (test isolation).
  ensureTagExists(tag, false, _paths);

  // Step 2: Read the full tasks data; build a fast lookup map.
  const data = _readTasksFile(tasksFile);
  const taskMap = buildTaskMap(data, tag);

  // Step 3: Validate depId exists in this tag (FR-007, FR-009).
  if (!taskMap.has(String(depId))) {
    const e = new Error(
      `Task "${depId}" does not exist in tag "${tag}". ` +
      'Cannot create a dependency to a task that does not exist or belongs to another tag.'
    );
    e.code = 'ERR_DEP_NOT_FOUND';
    throw e;
  }

  // Step 4: Iterative DFS cycle detection from depId (SD §6 D2, §10.2, FR-006).
  //
  // We are about to add edge: taskId → depId (taskId will depend on depId).
  // We need to check whether depId can already reach taskId through existing
  // dependencies — if it can, adding this edge closes a cycle.
  //
  // Algorithm (SD §10.2 flowchart):
  //   stack   = [depId]   — start DFS from the proposed dependency
  //   visited = Set()     — prevent revisiting nodes (handles shared deps, not just cycles)
  //   loop:
  //     current = stack.pop()
  //     if current === taskId → cycle detected, throw
  //     if already visited   → skip
  //     mark visited
  //     push each id in current.dependencies (ids in same tag; missing ones are no-ops)
  //   stack empty → no cycle found
  const taskIdStr = String(taskId);
  const stack = [String(depId)];
  const visited = new Set();

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === taskIdStr) {
      // DFS reached taskId from depId → adding taskId→depId creates a cycle.
      const e = new Error(
        `Cannot add dependency: task ${taskId} → ... → ${depId} → ${taskId} would create a cycle. ` +
        'Check the existing dependency chain before adding this dependency.'
      );
      e.code = 'ERR_DEP_CYCLE';
      throw e;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    // Push unvisited dependencies of the current node (follow existing dep edges).
    const currentTask = taskMap.get(current);
    if (currentTask && Array.isArray(currentTask.dependencies)) {
      for (const nextDep of currentTask.dependencies) {
        const nextStr = String(nextDep);
        if (!visited.has(nextStr)) {
          stack.push(nextStr);
        }
      }
    }
    // Note: if current is not in taskMap (dep points to a task removed after the edge was
    // added), we simply skip — the graph still terminates, no crash.
  }

  // Step 5: Append depId to taskId.dependencies[] (no-op if already present) (FR-005).
  const task = taskMap.get(String(taskId));
  if (!task) {
    // taskId itself does not exist — treat as ERR_DEP_NOT_FOUND for the source task.
    // (SD does not define a separate code for missing taskId in addDependency, but
    // ERR_DEP_NOT_FOUND is the closest — the dependency cannot be created.)
    const e = new Error(
      `Task "${taskId}" does not exist in tag "${tag}". ` +
      'Cannot add a dependency from a task that does not exist.'
    );
    e.code = 'ERR_DEP_NOT_FOUND';
    throw e;
  }

  if (!Array.isArray(task.dependencies)) task.dependencies = [];
  const depIdStr = String(depId);
  if (!task.dependencies.map(String).includes(depIdStr)) {
    task.dependencies.push(depIdStr);
  }
  // (If depId is already present, the list is unchanged — no-op, no error, FR-005.)

  // Step 6: Atomic write.
  _writeTasksFileAtomic(tasksFile, data);
}

/**
 * Remove depId from taskId.dependencies[] (FR-008).
 *
 * If depId is not in the list → no-op, no error (FR-008).
 * taskId must exist in the tag; if not → ERR_DEP_NOT_FOUND (SD §9.1).
 *
 * Validation order (SD §9.1 removeDependency):
 *   1. Tag exists → ERR_TAG_NOT_FOUND
 *   2. taskId exists in tasks.json[tag] → ERR_DEP_NOT_FOUND
 *   3. Filter depId out (no-op if absent) → atomic write
 *
 * @param {string} taskId  - id of the task whose dependencies list is modified
 * @param {string} depId   - id to remove from dependencies[]
 * @param {string} tag     - tag namespace
 * @param {object} [_paths] - { tasksFile?, stateFile? } for test isolation
 * @returns {void}
 * @throws {Error} with .code='ERR_TAG_NOT_FOUND' when tag is absent
 * @throws {Error} with .code='ERR_DEP_NOT_FOUND' when taskId does not exist in tag
 */
function removeDependency(taskId, depId, tag, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;

  // Step 1: Validate tag exists.
  ensureTagExists(tag, false, _paths);

  // Step 2: Read; validate taskId exists.
  const data = _readTasksFile(tasksFile);
  const taskMap = buildTaskMap(data, tag);
  const task = taskMap.get(String(taskId));

  if (!task) {
    const e = new Error(
      `Task "${taskId}" does not exist in tag "${tag}". ` +
      'Cannot remove a dependency from a task that does not exist.'
    );
    e.code = 'ERR_DEP_NOT_FOUND';
    throw e;
  }

  // Step 3: Filter depId out of dependencies[] (no-op if absent — FR-008).
  if (!Array.isArray(task.dependencies)) {
    task.dependencies = [];
  } else {
    const depIdStr = String(depId);
    task.dependencies = task.dependencies.filter((d) => String(d) !== depIdStr);
  }

  // Step 4: Atomic write.
  _writeTasksFileAtomic(tasksFile, data);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  addDependency,
  removeDependency,
};
