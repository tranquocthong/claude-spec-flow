/**
 * tag-manager.cjs — TagManager module for spec-flow native task manager.
 *
 * Provides tag resolution and auto-create behaviour on top of StorageCore
 * (lib/task-core.cjs). All file paths are injectable via an optional `_paths`
 * argument so every function can be tested hermetically against a tmp directory
 * without ever touching the project's real .taskmaster/ tree.
 *
 * Public API (SD §9.1, FR-001..FR-004):
 *   useTag(tagName, _paths?)         → void     (FR-002, FR-003)
 *   getCurrentTag(_paths?)           → string   throws ERR_NO_CURRENT_TAG (FR-002)
 *   resolveTag(explicitTag, _paths?) → string   (FR-001, FR-002)
 *   ensureTagExists(tag, forWrite, _paths?) → void  throws ERR_TAG_NOT_FOUND (FR-003, FR-004)
 *
 * Error codes (SD §12.2):
 *   ERR_NO_CURRENT_TAG — getCurrentTag called when state.json has no currentTag field.
 *   ERR_TAG_NOT_FOUND  — ensureTagExists or a read op called for a tag that does not exist.
 *
 * Architecture notes:
 *   - state.json is read + merged + written atomically (SD §6 D6 merge: never overwrites
 *     the whole file; only assigns the updated fields via Object.assign).
 *   - tasks.json I/O delegates entirely to _readTasksFile / _writeTasksFileAtomic from
 *     task-core.cjs (no reimplementation of file I/O, per task instructions).
 *   - state.json I/O uses a small local merge+atomic-write (same write-tmp-then-rename
 *     pattern as task-core) because state.json is separate from tasks.json and
 *     task-core does not export a state-specific writer.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { _readTasksFile, _writeTasksFileAtomic, TASKS_FILE, STATE_FILE } = require('./task-core.cjs');
const { ensureDir } = require('./core.cjs');

// ---------------------------------------------------------------------------
// Internal helpers — state.json read + atomic write
// ---------------------------------------------------------------------------

/**
 * Read state.json at the given path. Returns parsed object or {} on ENOENT /
 * malformed JSON. Never throws (mirrors task-core._getCurrentTag resilience).
 *
 * @param {string} stateFilePath
 * @returns {object}
 */
function _readStateFile(stateFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(stateFilePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e; // unexpected fs error — propagate
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // malformed JSON → treat as empty (resilient read)
  }
}

/**
 * Write state.json atomically using write-tmp-then-rename (same pattern as
 * task-core._writeTasksFileAtomic). Ensures the containing directory exists.
 *
 * @param {string} stateFilePath
 * @param {object} data
 */
function _writeStateFileAtomic(stateFilePath, data) {
  ensureDir(path.dirname(stateFilePath));
  const tmpPath = stateFilePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, stateFilePath); // atomic on same filesystem (POSIX)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the current tag in state.json and auto-create the tag namespace in
 * tasks.json if it does not already exist (FR-002, FR-003, SD §9.1 useTag).
 *
 * Merge algorithm (SD §6 D6 — merge, never overwrite):
 *   1. Read state.json (returns {} on ENOENT / malformed JSON).
 *   2. Object.assign(stateData, { currentTag: tagName }) — preserves all other fields.
 *   3. Atomic write back to stateFile.
 *
 * Auto-create (FR-003):
 *   Read tasks.json; if tasks.json[tagName] is absent, initialise it to
 *   {tasks:[], metadata:{}} and write atomically.
 *
 * @param {string} tagName  - name of the tag to switch to
 * @param {object} [_paths] - { tasksFile?, stateFile? } for test isolation
 * @returns {void}
 */
function useTag(tagName, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const stateFile = (_paths && _paths.stateFile) || STATE_FILE;

  // 1. Merge currentTag into state.json (read → assign → atomic write)
  const stateData = _readStateFile(stateFile);
  Object.assign(stateData, { currentTag: tagName });
  _writeStateFileAtomic(stateFile, stateData);

  // 2. Auto-create tag namespace in tasks.json if absent (FR-003)
  const tasksData = _readTasksFile(tasksFile);
  if (!tasksData[tagName]) {
    tasksData[tagName] = { tasks: [], metadata: {} };
    _writeTasksFileAtomic(tasksFile, tasksData);
  }
}

/**
 * Read the current tag from state.json and return it as a string.
 * Throws ERR_NO_CURRENT_TAG if state.json does not exist or has no currentTag
 * field — this forces the caller to call useTag or pass --tag explicitly before
 * any op that depends on a resolved tag (FR-002, SD §9.1 getCurrentTag).
 *
 * @param {object} [_paths] - { stateFile? } for test isolation
 * @returns {string}
 * @throws {Error} with .code='ERR_NO_CURRENT_TAG' when no currentTag is set
 */
function getCurrentTag(_paths) {
  const stateFile = (_paths && _paths.stateFile) || STATE_FILE;
  const stateData = _readStateFile(stateFile);

  if (typeof stateData.currentTag !== 'string' || !stateData.currentTag) {
    const e = new Error(
      'No current tag set in .taskmaster/state.json. ' +
      'Run useTag(<tag>) or pass --tag explicitly before performing this operation.'
    );
    e.code = 'ERR_NO_CURRENT_TAG';
    throw e;
  }
  return stateData.currentTag;
}

/**
 * Resolve the tag to use for an operation (FR-001, FR-002, SD §9.1 resolveTag,
 * SD §10.1 Tag Resolution Flow step 1-2).
 *
 * If explicitTag is truthy → return it directly (explicit tag always wins, ensuring
 * tag isolation: op on tag A can never accidentally see tag B's data).
 * Otherwise → fall back to getCurrentTag() which reads state.json.
 *
 * @param {string|null|undefined} explicitTag - tag supplied by the caller, or falsy
 * @param {object} [_paths] - { stateFile? } for test isolation
 * @returns {string}
 * @throws {Error} with .code='ERR_NO_CURRENT_TAG' (propagated from getCurrentTag)
 */
function resolveTag(explicitTag, _paths) {
  if (explicitTag) return explicitTag;
  return getCurrentTag(_paths);
}

/**
 * Assert that a tag namespace exists in tasks.json, or handle the missing case
 * based on the operation type (FR-003 write, FR-004 read, SD §9.1 ensureTagExists,
 * SD §10.1 Tag Resolution Flow steps 3-4).
 *
 * Behaviour:
 *   - Tag exists in tasks.json → return (no-op).
 *   - Tag absent + forWrite=true → auto-create {tasks:[], metadata:{}} and write atomically.
 *   - Tag absent + forWrite=false → throw ERR_TAG_NOT_FOUND (read ops must not silently
 *     create namespaces — that would generate confusing empty-tag results, per SD §6 D3).
 *
 * @param {string}  tag      - tag namespace to check
 * @param {boolean} forWrite - true when called from a write op; false for read ops
 * @param {object}  [_paths] - { tasksFile? } for test isolation
 * @returns {void}
 * @throws {Error} with .code='ERR_TAG_NOT_FOUND' when tag is absent and forWrite=false
 */
function ensureTagExists(tag, forWrite, _paths) {
  const tasksFile = (_paths && _paths.tasksFile) || TASKS_FILE;
  const tasksData = _readTasksFile(tasksFile);

  if (tasksData[tag]) return; // Tag exists — nothing to do

  if (forWrite) {
    // Auto-create namespace; caller continues writing into the new tag (FR-003)
    tasksData[tag] = { tasks: [], metadata: {} };
    _writeTasksFileAtomic(tasksFile, tasksData);
  } else {
    // Read ops must not silently create empty tags (SD §6 D3, FR-004)
    const e = new Error(
      `Tag "${tag}" does not exist in tasks.json. ` +
      'Run use-tag <tag> to create or switch to it before performing read operations.'
    );
    e.code = 'ERR_TAG_NOT_FOUND';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  useTag,
  getCurrentTag,
  resolveTag,
  ensureTagExists,
};
