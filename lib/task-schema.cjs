/**
 * task-schema.cjs — canonical Task JSON schema + hand-rolled validator.
 *
 * Provides:
 *   TASK_SCHEMA          — a JSON-Schema-like descriptor of the Task object,
 *                          used by AgentNativeDriver to embed in GenerationSpec.
 *   validateTaskSchema() — hand-rolled validator that collects ALL field errors
 *                          in a single pass and returns { valid, errors }.
 *
 * Reuses VALID_STATUSES and VALID_PRIORITIES from task-core.cjs so enum values
 * stay in lockstep with the storage layer (TC-011 byte-compat requirement).
 *
 * Zero external dependencies — pure Node CommonJS (FR-003, TC-006, TC-011).
 */
'use strict';

const { VALID_STATUSES, VALID_PRIORITIES } = require('./task-core.cjs');

// ---------------------------------------------------------------------------
// TASK_SCHEMA — JSON-Schema-like descriptor for the Task object.
//
// Describes the shape expected by the native task engine and task-master-ai@0.43.1.
// Required fields: id, title, description, status, priority, dependencies,
//                  subtasks, updatedAt.
// Optional fields: details, testStrategy.
// ---------------------------------------------------------------------------

const TASK_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'description', 'status', 'priority', 'dependencies', 'subtasks', 'updatedAt'],
  properties: {
    id: {
      type: 'string',
      description: 'Auto-incremented unique identifier within a tag (string form of integer).',
    },
    title: {
      type: 'string',
      minLength: 1,
      description: 'Short human-readable task title. Must be a non-empty string.',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: 'Concise statement of what the task accomplishes.',
    },
    status: {
      type: 'string',
      enum: VALID_STATUSES,
      description: 'Lifecycle status. One of: ' + VALID_STATUSES.join(', ') + '.',
    },
    priority: {
      type: 'string',
      enum: VALID_PRIORITIES,
      description: 'Scheduling priority. One of: ' + VALID_PRIORITIES.join(', ') + '.',
    },
    dependencies: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of task ids that must be done before this task becomes eligible.',
    },
    subtasks: {
      type: 'array',
      description: 'Ordered list of sub-tasks belonging to this task.',
    },
    updatedAt: {
      type: 'string',
      description: 'ISO-8601 timestamp of the last mutation.',
    },
    details: {
      type: 'string',
      description: 'Optional extended implementation notes.',
    },
    testStrategy: {
      type: 'string',
      description: 'Optional description of how to verify this task.',
    },
  },
};

// ---------------------------------------------------------------------------
// validateTaskSchema(task) — hand-rolled validator.
//
// Checks every required field and any optional field that is present.
// Collects ALL failures into `errors` without stopping at the first.
//
// @param {*} task - value to validate (expected to be an object)
// @returns {{ valid: boolean, errors: Array<{ field: string, reason: string }> }}
// ---------------------------------------------------------------------------

function validateTaskSchema(task) {
  const errors = [];

  // Guard: task must be a non-null object
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    errors.push({ field: 'task', reason: 'must be a non-null object' });
    return { valid: false, errors };
  }

  // --- Required field: id (must be a string) ---
  if (task.id === undefined || task.id === null) {
    errors.push({ field: 'id', reason: 'required field is missing' });
  } else if (typeof task.id !== 'string') {
    errors.push({ field: 'id', reason: `must be a string, got ${typeof task.id}` });
  }

  // --- Required field: title (must be a non-empty string) ---
  if (task.title === undefined || task.title === null) {
    errors.push({ field: 'title', reason: 'required field is missing' });
  } else if (typeof task.title !== 'string') {
    errors.push({ field: 'title', reason: `must be a string, got ${typeof task.title}` });
  } else if (task.title.trim().length === 0) {
    errors.push({ field: 'title', reason: 'must be a non-empty string (whitespace-only is not allowed)' });
  }

  // --- Required field: description (must be a non-empty string) ---
  if (task.description === undefined || task.description === null) {
    errors.push({ field: 'description', reason: 'required field is missing' });
  } else if (typeof task.description !== 'string') {
    errors.push({ field: 'description', reason: `must be a string, got ${typeof task.description}` });
  } else if (task.description.trim().length === 0) {
    errors.push({ field: 'description', reason: 'must be a non-empty string (whitespace-only is not allowed)' });
  }

  // --- Required field: status (must be a member of VALID_STATUSES) ---
  if (task.status === undefined || task.status === null) {
    errors.push({ field: 'status', reason: 'required field is missing' });
  } else if (typeof task.status !== 'string') {
    errors.push({ field: 'status', reason: `must be a string, got ${typeof task.status}` });
  } else if (!VALID_STATUSES.includes(task.status)) {
    errors.push({
      field: 'status',
      reason: `"${task.status}" is not a valid status. Valid values: ${VALID_STATUSES.join(', ')}`,
    });
  }

  // --- Required field: priority (must be a member of VALID_PRIORITIES) ---
  if (task.priority === undefined || task.priority === null) {
    errors.push({ field: 'priority', reason: 'required field is missing' });
  } else if (typeof task.priority !== 'string') {
    errors.push({ field: 'priority', reason: `must be a string, got ${typeof task.priority}` });
  } else if (!VALID_PRIORITIES.includes(task.priority)) {
    errors.push({
      field: 'priority',
      reason: `"${task.priority}" is not a valid priority. Valid values: ${VALID_PRIORITIES.join(', ')}`,
    });
  }

  // --- Required field: dependencies (must be an array) ---
  if (task.dependencies === undefined || task.dependencies === null) {
    errors.push({ field: 'dependencies', reason: 'required field is missing' });
  } else if (!Array.isArray(task.dependencies)) {
    errors.push({ field: 'dependencies', reason: `must be an array, got ${typeof task.dependencies}` });
  }

  // --- Required field: subtasks (must be an array) ---
  if (task.subtasks === undefined || task.subtasks === null) {
    errors.push({ field: 'subtasks', reason: 'required field is missing' });
  } else if (!Array.isArray(task.subtasks)) {
    errors.push({ field: 'subtasks', reason: `must be an array, got ${typeof task.subtasks}` });
  }

  // --- Required field: updatedAt (must be a string) ---
  if (task.updatedAt === undefined || task.updatedAt === null) {
    errors.push({ field: 'updatedAt', reason: 'required field is missing' });
  } else if (typeof task.updatedAt !== 'string') {
    errors.push({ field: 'updatedAt', reason: `must be a string, got ${typeof task.updatedAt}` });
  }

  // --- Optional field: details (if present, must be a string) ---
  if (task.details !== undefined && task.details !== null) {
    if (typeof task.details !== 'string') {
      errors.push({ field: 'details', reason: `must be a string when present, got ${typeof task.details}` });
    }
  }

  // --- Optional field: testStrategy (if present, must be a string) ---
  if (task.testStrategy !== undefined && task.testStrategy !== null) {
    if (typeof task.testStrategy !== 'string') {
      errors.push({
        field: 'testStrategy',
        reason: `must be a string when present, got ${typeof task.testStrategy}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  TASK_SCHEMA,
  validateTaskSchema,
};
