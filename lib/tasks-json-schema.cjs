/**
 * tasks-json-schema.cjs — shared tasks.json schema validator.
 *
 * Validates that a parsed object (or JSON string) conforms to the tag-keyed
 * shared schema both the native engine and task-master-ai@0.43.1 use:
 *
 *   { [tag]: { tasks: Task[], metadata: object } }
 *
 * This is the zero-migration / rollback-safety guarantee (SD §6 D3, FR-004,
 * TC-004, TC-010): both engines write exactly this shape so a rollback from
 * native → task-master-ai@0.43.1 requires no data migration.
 *
 * Per-task field validation is delegated to validateTaskSchema() from
 * task-schema.cjs — enum values and required fields stay in lockstep with
 * the storage layer without redeclaring rules here.
 *
 * Zero external dependencies — pure Node CommonJS (FR-003).
 */
'use strict';

const { validateTaskSchema } = require('./task-schema.cjs');

// ---------------------------------------------------------------------------
// validateTasksJson(input)
//
// @param {object|string} input - a parsed tasks.json object OR a JSON string
// @returns {{ valid: boolean, errors: Array<{ tag: string, taskId?: string, field?: string, reason: string }> }}
//
// Collects ALL problems in a single pass — does not throw on the first error.
// valid = true only when errors is empty.
// ---------------------------------------------------------------------------

function validateTasksJson(input) {
  const errors = [];

  // --- Parse if the caller passed a JSON string ---
  let data;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      // Malformed JSON: re-throw a clear error rather than returning invalid.
      // This makes the bad-parse case distinct from a structurally invalid document
      // so callers can distinguish "your file is corrupt JSON" from "schema mismatch".
      const err = new Error(
        'tasks.json is not valid JSON: ' + e.message
      );
      err.code = 'ERR_TASKS_JSON_PARSE';
      err.cause = e;
      throw err;
    }
  } else {
    data = input;
  }

  // --- Top-level must be a non-null, non-array object ---
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push({
      tag: null,
      reason: 'tasks.json top-level must be a non-null object mapping tag names to tag entries',
    });
    return { valid: false, errors };
  }

  // --- Validate each tag entry ---
  for (const tag of Object.keys(data)) {
    const entry = data[tag];

    // The tag entry itself must be a non-null object
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ tag, reason: 'tag entry must be a non-null object' });
      continue; // cannot inspect tasks/metadata on a non-object
    }

    // tasks must be an array (required; absent = invalid)
    if (!Object.prototype.hasOwnProperty.call(entry, 'tasks') || entry.tasks === null || entry.tasks === undefined) {
      errors.push({ tag, reason: '"tasks" key is required in every tag entry' });
    } else if (!Array.isArray(entry.tasks)) {
      errors.push({ tag, reason: '"tasks" must be an array, got ' + typeof entry.tasks });
    } else {
      // Validate each task in the array using the canonical per-task validator
      for (const task of entry.tasks) {
        const taskId = (task && typeof task === 'object') ? String(task.id) : undefined;
        const result = validateTaskSchema(task);
        if (!result.valid) {
          // Expand each task-level field error into a top-level error carrying tag + taskId
          for (const fieldErr of result.errors) {
            errors.push({
              tag,
              taskId,
              field: fieldErr.field,
              reason: fieldErr.reason,
            });
          }
        }
      }
    }

    // metadata must be an object when present (absent is fine — it is optional)
    if (Object.prototype.hasOwnProperty.call(entry, 'metadata') &&
        entry.metadata !== null &&
        entry.metadata !== undefined) {
      if (typeof entry.metadata !== 'object' || Array.isArray(entry.metadata)) {
        errors.push({ tag, reason: '"metadata" must be an object when present, got ' + typeof entry.metadata });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// assertTasksJsonValid(input)
//
// Convenience wrapper for callers that prefer throw semantics.
// Throws an Error with .code = 'ERR_TASKS_JSON_INVALID' when the document is
// invalid. The message includes the error count and the first error's reason so
// callers can surface a useful diagnostic without parsing the errors array.
//
// @param {object|string} input
// @throws {Error} with .code = 'ERR_TASKS_JSON_INVALID'
// ---------------------------------------------------------------------------

function assertTasksJsonValid(input) {
  const result = validateTasksJson(input); // may throw ERR_TASKS_JSON_PARSE
  if (!result.valid) {
    const count = result.errors.length;
    const first = result.errors[0];
    const summary = first
      ? (first.tag ? '[' + first.tag + '] ' : '') +
        (first.taskId ? '(taskId ' + first.taskId + ') ' : '') +
        first.reason
      : 'unknown error';
    const err = new Error(
      'tasks.json validation failed: ' + count +
      ' error' + (count === 1 ? '' : 's') +
      '. First: ' + summary
    );
    err.code = 'ERR_TASKS_JSON_INVALID';
    err.errors = result.errors;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateTasksJson,
  assertTasksJsonValid,
};
