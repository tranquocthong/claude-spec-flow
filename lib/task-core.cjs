/**
 * task-core.cjs — native task storage + CRUD module for spec-flow.
 *
 * Provides deterministic, zero-network task operations over the standard
 * .taskmaster/tasks/tasks.json tag-keyed schema (drop-in replacement for
 * the task-master-ai@0.43.1 storage layer). All ops follow the
 * read-once → mutate-in-memory → write-once (atomic rename) cycle per SD §6 D1-D3.
 *
 * Public API (SD §9.2):
 *   addTask(tag, fields)      → Task
 *   getTask(tag, id)          → Task | null
 *   listTasks(tag, opts)      → { tasks, stats }
 *   setStatus(tag, id, status)→ Task   throws ERR_INVALID_STATUS, ERR_TASK_NOT_FOUND
 *   nextTask(tag)             → { task, reason? }
 *   updateTask(tag, id,fields)→ Task   throws ERR_TASK_NOT_FOUND
 *
 * Errors: thrown as Error with a `.code` property (Node library idiom, SD §12.2).
 * No HTTP layer; callers map .code to exit codes or log as appropriate.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { readJsonSafe, ensureDir } = require('./core.cjs');

// ---------------------------------------------------------------------------
// Constants (exported for callers and tests)
// ---------------------------------------------------------------------------

/** All valid task status values (SD §7.1, FR-008). */
const VALID_STATUSES = ['pending', 'in-progress', 'done', 'blocked', 'deferred', 'cancelled', 'review'];

/**
 * All valid task priority values in descending priority order (SD §7.1).
 * 'critical' is included for drop-in parity with task-master-ai@0.43.1, which
 * ranks it above 'high'; keep it first so priorityRank() orders it highest.
 */
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Canonical tasks.json path constant (SD §6 D1, FR-001).
 * Exported so callers and tests can reference it without hard-coding the path.
 */
const TASKS_FILE = path.join('.taskmaster', 'tasks', 'tasks.json');

/**
 * Canonical state.json path constant (SD §6 D7, FR-004).
 * Exported so callers and tests can reference it without hard-coding the path.
 * Read-only in this sub — never written here.
 */
const STATE_FILE = path.join('.taskmaster', 'state.json');

/**
 * Read a tasks data file by explicit path (SD §6 D1, FR-002).
 *
 *   - Caller supplies the path (enables tests to use a tmp directory).
 *   - File-not-found (ENOENT) returns {} so callers treat a missing file as an
 *     empty tag-keyed structure — consistent with the first-run experience.
 *   - Malformed JSON re-throws the SyntaxError rather than silently falling back;
 *     a corrupt tasks.json must surface immediately, not be silently discarded.
 *
 * @param {string} filePath - absolute or cwd-relative path to the tasks JSON file
 * @returns {object} parsed data object, or {} when the file does not exist
 * @throws {SyntaxError} when the file exists but contains malformed JSON
 */
function _readTasksFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e; // unexpected fs error (permissions, etc.) — propagate to caller
  }
  return JSON.parse(raw); // SyntaxError propagates on malformed JSON (FR-002)
}

/**
 * Write the tasks data atomically by explicit path (SD §6 D3, FR-002).
 *
 * Algorithm:
 *   1. Serialise `data` with JSON.stringify(data, null, 2) — stable 2-space indent
 *      for clean git diffs (SD §6 D2).
 *   2. Write the result to `${filePath}.tmp` in the SAME directory (fs.writeFileSync).
 *   3. Rename the tmp file over the target path (fs.renameSync).
 *      On POSIX, rename within the same filesystem is atomic: if the process is
 *      interrupted after step 2 but before step 3, the original file survives
 *      intact (the only leftover is the orphaned .tmp file).
 *
 * Caller supplies the path so tests can target a tmp directory without touching
 * the project's real .taskmaster/ tree.
 *
 * @param {string} filePath - destination path for the tasks JSON file
 * @param {object} data     - full tasks data object to serialise
 */
function _writeTasksFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath); // atomic on same filesystem (POSIX)
}

/**
 * Read the currentTag from state.json without ever throwing (SD §6 D7, FR-004).
 *
 * Returns the tag string when the file exists and the `currentTag` field is a
 * non-empty string.  Returns null in all other situations:
 *   - file does not exist (checked with fs.existsSync before reading)
 *   - file exists but contains no `currentTag` field
 *   - file exists but contains malformed JSON (readJsonSafe catches SyntaxError)
 *
 * READ-ONLY — never writes state.json.
 *
 * @param {string} [stateFilePath] - override path for tests; defaults to STATE_FILE
 * @returns {string|null}
 */
function _getCurrentTag(stateFilePath) {
  const fp = stateFilePath || STATE_FILE;
  if (!fs.existsSync(fp)) return null;
  const state = readJsonSafe(fp, null);
  if (!state || typeof state.currentTag !== 'string' || !state.currentTag) return null;
  return state.currentTag;
}

/**
 * Get the tasks array for a given tag from the data object.
 * Returns [] when the tag or its tasks array does not exist (no throw).
 * @param {object} data - full tasks data object
 * @param {string} tag
 * @returns {Array}
 */
function getTagTasks(data, tag) {
  return (data[tag] && Array.isArray(data[tag].tasks)) ? data[tag].tasks : [];
}

/**
 * Compute the auto-incrementing id for a new task in a given tasks array.
 * Finds the max numeric id present, then returns (max + 1) as a string (FR-003).
 * @param {Array} tasks
 * @returns {string}
 */
function nextId(tasks) {
  if (!tasks.length) return '1';
  const max = tasks.reduce((m, t) => {
    const n = parseInt(t.id, 10);
    return (!isNaN(n) && n > m) ? n : m;
  }, 0);
  return String(max + 1);
}

/**
 * Build the stats object that listTasks must return (FR-007, SD §7.2).
 * completionPercentage = round(done / (total - cancelled) * 100), 0 when denominator = 0.
 * @param {Array} allTasks - full task list for the tag (unfiltered)
 * @returns {object} stats
 */
function buildStats(allTasks) {
  const stats = {};
  for (const s of VALID_STATUSES) stats[s] = 0;
  for (const t of allTasks) {
    if (VALID_STATUSES.includes(t.status)) stats[t.status]++;
  }
  const total = allTasks.length;
  const denominator = total - stats.cancelled;
  stats.completionPercentage = denominator > 0 ? Math.round((stats.done / denominator) * 100) : 0;
  return stats;
}

/**
 * Priority rank for sorting: lower number = higher priority (SD §10.2 step 5).
 * @param {string} priority
 * @returns {number}
 */
function priorityRank(priority) {
  const idx = VALID_PRIORITIES.indexOf(priority);
  return idx >= 0 ? idx : VALID_PRIORITIES.length; // unknown → lowest
}

// ---------------------------------------------------------------------------
// Lookup helper: find a task (or subtask) by id within a tasks array.
// Subtask ids follow the "<parent>.<n>" format (FR-008).
// Returns { task, parent, isSubtask } or null if not found.
// ---------------------------------------------------------------------------
function findById(tasks, id) {
  const str = String(id);

  // Check for subtask id: "<parentId>.<subtaskIndex>"
  const dotIdx = str.indexOf('.');
  if (dotIdx > 0) {
    const parentId = str.slice(0, dotIdx);
    const subtaskId = str.slice(dotIdx + 1);
    const parent = tasks.find((t) => String(t.id) === parentId);
    if (!parent) return null;
    const subtasks = Array.isArray(parent.subtasks) ? parent.subtasks : [];
    const sub = subtasks.find((s) => String(s.id) === subtaskId);
    if (!sub) return null;
    return { task: sub, parent, isSubtask: true };
  }

  const task = tasks.find((t) => String(t.id) === str);
  return task ? { task, parent: null, isSubtask: false } : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new task in the specified tag (FR-003, FR-004).
 *
 * @param {string|undefined} tag    - tag to write to; undefined/null resolves from state.json
 * @param {object}           fields - { title, description?, details?, testStrategy?, priority? }
 * @param {object}           [_paths] - optional path overrides for test isolation:
 *                                      { tasksFile?: string, stateFile?: string }
 *                                      Production callers omit this; tests pass tmp paths so
 *                                      no real .taskmaster/ file is ever touched during testing.
 * @returns {object} the newly created task
 */
function addTask(tag, fields, _paths) {
  // Resolve file paths — use injected paths when provided (test isolation), else global defaults.
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const stateFile = (_paths && _paths.stateFile) || STATE_FILE;

  // 1. Resolve tag: explicit tag wins; undefined/null falls back to currentTag in state.json.
  let resolvedTag = tag || null;
  if (!resolvedTag) {
    resolvedTag = _getCurrentTag(stateFile);
  }
  if (!resolvedTag) {
    const e = new Error('Tag not specified and no currentTag found in .taskmaster/state.json');
    e.code = 'ERR_NO_TAG';
    throw e;
  }

  // 2. Validate title — must be a non-empty string (SD §9.2 fields contract, FR-003).
  if (!fields || typeof fields.title !== 'string' || !fields.title.trim()) {
    const e = new Error('Task title must be a non-empty string');
    e.code = 'ERR_INVALID_TITLE';
    throw e;
  }

  // 3. Read current tasks data; initialise the tag bucket when it does not exist yet.
  const data = _readTasksFile(tasksFile);
  if (!data[resolvedTag]) data[resolvedTag] = { tasks: [], metadata: {} };
  if (!Array.isArray(data[resolvedTag].tasks)) data[resolvedTag].tasks = [];

  const tasks = data[resolvedTag].tasks;

  // 4. Auto-increment id: max numeric id in the tag + 1, default '1' when empty (FR-003).
  const id = nextId(tasks);
  const now = new Date().toISOString();

  // 5. Build task with only schema-defined fields (FR-014 — no extra fields survive).
  const task = {
    id,
    title: fields.title.trim(),
    description: fields.description || '',
    details: fields.details || '',
    testStrategy: fields.testStrategy || '',
    priority: VALID_PRIORITIES.includes(fields.priority) ? fields.priority : 'medium',
    dependencies: [],
    status: 'pending',
    subtasks: [],
    updatedAt: now,
  };

  // 6. Push and write atomically (write-temp-then-rename, SD §6 D3, FR-002).
  tasks.push(task);
  _writeTasksFileAtomic(tasksFile, data);
  return task;
}

/**
 * Return a single task by id, or null if not found (FR-005).
 *
 * Returns null when the tag does not exist in the file or when the id is absent
 * from the tag — NEVER throws for these cases (SD §9.2).  Id comparison is
 * tolerant of number vs string: both sides are stringified before comparing
 * (handled by findById → String(id)).
 *
 * @param {string}       tag
 * @param {string|number} id
 * @param {object}       [_paths] - optional path overrides for test isolation:
 *                                  { tasksFile?: string }
 *                                  Production callers omit this; tests pass a
 *                                  tmp path so the real .taskmaster/ is not read.
 * @returns {object|null}
 */
function getTask(tag, id, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const data = _readTasksFile(tasksFile);
  const tasks = getTagTasks(data, tag);
  const found = findById(tasks, id);
  return found ? found.task : null;
}

/**
 * Return all tasks in a tag with optional filtering, plus a stats object (FR-006, FR-007).
 *
 * Stats are computed on the FULL unfiltered task list so that filtering by
 * status (opts.status) does not distort the per-tag completion metrics (TC-007).
 *
 * @param {string} tag
 * @param {object} [opts]
 * @param {string}  [opts.status]       - single value or comma-separated list
 * @param {boolean} [opts.withSubtasks] - include subtasks in each task (pass-through)
 * @param {object}  [_paths]            - optional path overrides for test isolation:
 *                                        { tasksFile?: string }
 * @returns {{ tasks: object[], stats: object }}
 */
function listTasks(tag, opts, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const data = _readTasksFile(tasksFile);
  const allTasks = getTagTasks(data, tag);

  let result = allTasks;

  // Apply status filter (single value or comma-separated, FR-006)
  const statusFilter = opts && opts.status ? String(opts.status) : null;
  if (statusFilter) {
    const allowed = new Set(statusFilter.split(',').map((s) => s.trim()).filter(Boolean));
    result = allTasks.filter((t) => allowed.has(t.status));
  }

  // stats are computed on the FULL unfiltered task list (TC-007 — stats on whole tag)
  const stats = buildStats(allTasks);

  return { tasks: result, stats };
}

/**
 * Change the status of a task (or subtask) and write atomically (FR-008, FR-009, FR-010).
 *
 * Validates `status` against VALID_STATUSES BEFORE reading the file so the file
 * is never touched on invalid input (FR-009). Finds the task (or subtask) by id;
 * throws ERR_TASK_NOT_FOUND without writing if not found (FR-010). No state-machine
 * enforcement — any transition from one valid status to another is allowed (SD §10.4).
 *
 * For subtask ids of the form "<parent>.<sub>" (e.g. "3.2"), the subtask's status
 * and updatedAt are updated; the PARENT task is returned so callers receive the
 * complete containing task object (SD §9.2).
 *
 * @param {string}  tag
 * @param {string}  id       - plain task id or "<parent>.<sub>" for subtasks
 * @param {string}  status   - must be a member of VALID_STATUSES
 * @param {object}  [_paths] - optional path overrides for test isolation:
 *                             { tasksFile?: string }
 *                             Production callers omit this; tests pass a tmp path
 *                             so the real .taskmaster/ is never touched.
 * @returns {object} the updated top-level task (parent task when a subtask was updated)
 * @throws {Error} with .code='ERR_INVALID_STATUS' when status is not in VALID_STATUSES
 * @throws {Error} with .code='ERR_TASK_NOT_FOUND' when id is not found in the tag
 */
function setStatus(tag, id, status, _paths) {
  // 1. Validate status BEFORE reading the file so we never touch it on invalid input (FR-009).
  if (!VALID_STATUSES.includes(status)) {
    const e = new Error(
      `Invalid status: '${status}'. Valid values: ${VALID_STATUSES.join(', ')}`
    );
    e.code = 'ERR_INVALID_STATUS';
    throw e;
  }

  // 2. Resolve file path — use injected path when provided (test isolation), else global default.
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;

  // 3. Read; find task by id — throw ERR_TASK_NOT_FOUND without writing if not found (FR-010).
  const data = _readTasksFile(tasksFile);
  const tasks = getTagTasks(data, tag);
  const found = findById(tasks, id);

  if (!found) {
    const e = new Error(`Task '${id}' not found in tag '${tag}'`);
    e.code = 'ERR_TASK_NOT_FOUND';
    throw e;
  }

  // 4. Update .status and .updatedAt on the resolved task (subtask or top-level).
  found.task.status = status;
  found.task.updatedAt = new Date().toISOString();

  // 5. Atomic write; return the top-level task.
  //    For a subtask update, return the parent so callers get the whole containing task.
  _writeTasksFileAtomic(tasksFile, data);
  return found.isSubtask ? found.parent : found.task;
}

/**
 * Return the next actionable pending task whose dependencies are all done (FR-011, FR-012).
 * Ties broken by priority (high → medium → low) then by numeric id ascending.
 * Never throws; returns { task: null, reason } when no eligible task exists.
 *
 * Dep evaluation rules (SD §6 D6, FR-016):
 *   - Only the `dependencies` array is read — never mutated.
 *   - A dep id that does not exist in the same tag is treated as not-done (fail-safe).
 *   - No cycle detection, validation, or mutation — those belong to sub `tags-deps`.
 *
 * @param {string} tag
 * @param {object} [_paths] - optional path overrides for test isolation:
 *                            { tasksFile?: string }
 *                            Production callers omit this; tests pass a tmp path so
 *                            the real .taskmaster/ is never touched.
 * @returns {{ task: object|null, reason?: string }}
 */
function nextTask(tag, _paths) {
  // Resolve file path — use injected path when provided (test isolation), else global default.
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const data = _readTasksFile(tasksFile);
  const tasks = getTagTasks(data, tag);

  const pending = tasks.filter((t) => t.status === 'pending');

  if (!pending.length) {
    return { task: null, reason: 'No pending tasks remaining' };
  }

  // Build a status lookup map for fast dependency checking
  const statusById = new Map(tasks.map((t) => [String(t.id), t.status]));

  const eligible = pending.filter((t) => {
    const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
    // All deps must correspond to a task with status 'done' (SD §10.2 step 3, FR-016)
    return deps.every((depId) => statusById.get(String(depId)) === 'done');
  });

  if (!eligible.length) {
    return { task: null, reason: 'All pending tasks are blocked by unresolved dependencies' };
  }

  eligible.sort((a, b) => {
    const pd = priorityRank(a.priority) - priorityRank(b.priority);
    if (pd !== 0) return pd;
    return parseInt(a.id, 10) - parseInt(b.id, 10);
  });

  // Lazy require avoids a circular dependency at module load time:
  // subtask-manager.cjs requires task-core.cjs at its top level; requiring
  // subtask-manager.cjs here (inside a function, at call time) is safe because
  // task-core.cjs is fully initialised before nextTask is ever invoked.
  // computeCompletion is a pure function — no I/O, no side effects (FR-011).
  const { computeCompletion } = require('./subtask-manager.cjs');
  const chosenTask = Object.assign({}, eligible[0], {
    completionPercentage: computeCompletion(eligible[0]),
  });
  return { task: chosenTask };
}

/**
 * Update writable fields of an existing task (FR-013, FR-014).
 *
 * Only description, details, and notes are applied from `fields`; every other
 * key in `fields` is silently ignored.  Unknown fields already present on the
 * stored task object (e.g. written by task-master-ai@0.43.1) are preserved
 * unchanged — the function operates via in-place property assignment and never
 * reconstructs the task object from scratch, so extra properties pass through.
 *
 * `updatedAt` is always refreshed, even when `fields` is empty (no-op update).
 * The file is always written atomically so callers can rely on the disk copy
 * matching the returned task.
 *
 * @param {string}  tag
 * @param {string}  id
 * @param {object}  [fields]  - { description?, details?, notes? }; undefined/empty = timestamp-only no-op
 * @param {object}  [_paths]  - optional path overrides for test isolation:
 *                              { tasksFile?: string }
 *                              Production callers omit this; tests pass a tmp path
 *                              so the real .taskmaster/ is never touched.
 * @returns {object} the updated task
 * @throws {Error} with .code='ERR_TASK_NOT_FOUND' when id is not found in the tag
 */
function updateTask(tag, id, fields, _paths) {
  // Resolve file path — use injected path when provided (test isolation), else global default.
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;

  // 1. Read; find task by id — throw ERR_TASK_NOT_FOUND without writing if not found (FR-013).
  const data = _readTasksFile(tasksFile);
  const tasks = getTagTasks(data, tag);
  const found = findById(tasks, id);

  if (!found) {
    const e = new Error(`Task '${id}' not found in tag '${tag}'`);
    e.code = 'ERR_TASK_NOT_FOUND';
    throw e;
  }

  // 2. Apply only the allowed updatable fields that are present in `fields` (FR-013, FR-014).
  //    Unknown keys in `fields` are silently skipped.
  //    Unknown pre-existing fields on the task are preserved via in-place mutation (FR-014).
  const task = found.task;
  const safeFields = fields && typeof fields === 'object' ? fields : {};
  if (safeFields.description !== undefined) task.description = safeFields.description;
  if (safeFields.details !== undefined) task.details = safeFields.details;
  if (safeFields.notes !== undefined) task.notes = safeFields.notes;

  // 3. Always refresh updatedAt — even for an empty fields no-op (FR-013).
  task.updatedAt = new Date().toISOString();

  // 4. Atomic write; return updated task.
  _writeTasksFileAtomic(tasksFile, data);
  return task;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  VALID_STATUSES,
  VALID_PRIORITIES,
  TASKS_FILE,
  STATE_FILE,
  // Internal helpers (underscore-prefixed by convention: not public API, but
  // exported so unit tests can drive them with injected paths and stubs).
  _readTasksFile,
  _writeTasksFileAtomic,
  _getCurrentTag,
  // Public CRUD API (SD §9.2)
  addTask,
  getTask,
  listTasks,
  setStatus,
  nextTask,
  updateTask,
};
