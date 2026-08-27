/**
 * task-cli.cjs — the native task-manager CLI surface: thin, deterministic
 * wrappers that adapt --flags onto lib/task-core, tag-manager, dependency-manager,
 * subtask-manager and the expand hook. Extracted from bin/flow-tools.cjs;
 * behaviour and CLI contract are unchanged.
 */
'use strict';
const fs = require('fs');
const { ok, err } = require('./core.cjs');
const taskCore = require('./task-core.cjs');
const tagManager = require('./tag-manager.cjs');
const dependencyManager = require('./dependency-manager.cjs');
const subtaskManager = require('./subtask-manager.cjs');
const { expandHook } = require('./expand-hook.cjs');

module.exports = {
  /**
   * task-add  --title <title> [--tag <tag>] [--priority high|medium|low]
   *           [--description <desc>] [--details <details>]
   *
   * Creates a new task. When --tag is omitted the tag is resolved from
   * .taskmaster/state.json (currentTag field) in the process cwd — this is
   * the same resolution that task-core.addTask() performs internally (FR-004).
   */
  'task-add'(args) {
    const tag = args.tag || null;
    const fields = {
      title: args.title,
      description: args.description,
      details: args.details,
      priority: args.priority,
    };
    try {
      const task = taskCore.addTask(tag, fields);
      return ok(task);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-get  --tag <tag> --id <id>
   *
   * Returns the task with the given id from the tag. Returns ok with data:null
   * when the id is not found — never returns err for a missing task (FR-005).
   */
  'task-get'(args) {
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    if (!args.id) return err('MISSING_ARG: --id <id>');
    try {
      const task = taskCore.getTask(args.tag, args.id);
      return ok(task);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-list  --tag <tag> [--status <status|csv>] [--with-subtasks]
   *
   * Lists all tasks in the tag. Supports optional --status filter (single value
   * or comma-separated list) and --with-subtasks flag. Returns { tasks, stats }
   * where stats always covers the entire unfiltered tag (FR-006, FR-007).
   */
  'task-list'(args) {
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    const opts = {};
    if (args.status) opts.status = args.status;
    if (args['with-subtasks']) opts.withSubtasks = true;
    try {
      const result = taskCore.listTasks(args.tag, opts);
      return ok(result);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-set-status  --tag <tag> --id <id> --status <status>
   *
   * Changes the status of a task (or subtask when id is "<parent>.<sub>").
   * Returns the updated top-level task on success. On error, maps thrown
   * Error codes to the err() result shape: ERR_INVALID_STATUS (FR-009),
   * ERR_TASK_NOT_FOUND (FR-010).
   */
  'task-set-status'(args) {
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    if (!args.id) return err('MISSING_ARG: --id <id>');
    if (!args.status) return err('MISSING_ARG: --status <status>');
    try {
      const task = taskCore.setStatus(args.tag, args.id, args.status);
      return ok(task);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-next  --tag <tag>
   *
   * Returns the next actionable pending task whose dependencies are all done.
   * Never throws — returns ok({ task: null, reason }) when no eligible task
   * exists (FR-011, FR-012). Priority: high > medium > low, then id ascending.
   */
  'task-next'(args) {
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    try {
      const result = taskCore.nextTask(args.tag);
      return ok(result);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-update  --tag <tag> --id <id>
   *              [--description <desc>] [--details <details>] [--notes <notes>]
   *
   * Updates the description, details, and/or notes of an existing task (FR-013).
   * Throws ERR_TASK_NOT_FOUND when the id is not found.
   */
  'task-update'(args) {
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    if (!args.id) return err('MISSING_ARG: --id <id>');
    const fields = {};
    if (args.description !== undefined) fields.description = args.description;
    if (args.details !== undefined) fields.details = args.details;
    if (args.notes !== undefined) fields.notes = args.notes;
    try {
      const task = taskCore.updateTask(args.tag, args.id, fields);
      return ok(task);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  // ---------------------------------------------------------------------------
  // TagManager / DependencyManager / SubtaskManager / ExpandHook wrappers
  // (Task #6 — additive only; no existing command modified)
  //
  // Collision check: none of these names exist in the commands object above.
  //   task-use-tag    — new (TagManager.useTag)
  //   task-add-dep    — new (DependencyManager.addDependency)
  //   task-remove-dep — new (DependencyManager.removeDependency)
  //   task-add-subtask — new (SubtaskManager.addSubtask)
  //   task-expand     — new (ExpandHook.expandHook)
  //
  // Each wrapper: parse args with the existing parseArgs result, call the module
  // fn in try/catch, map thrown Error.code → err(...), return ok(data) on success.
  // Require cycles: lib modules already require task-core; requiring them from bin
  // is one-way (bin → lib), so no cycle.
  // ---------------------------------------------------------------------------

  /**
   * task-use-tag  --tag <tagName>
   *
   * Sets the current tag in .taskmaster/state.json and auto-creates the tag
   * namespace in tasks.json if it does not exist (FR-002, FR-003, SD §9.2).
   */
  'task-use-tag'(args) {
    if (!args.tag) return err('MISSING_ARG: --tag <tagName>');
    try {
      tagManager.useTag(args.tag);
      return ok({ tag: args.tag });
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-add-dep  --task-id <taskId>  --dep-id <depId>  --tag <tag>
   *
   * Adds depId to taskId.dependencies[] with full validation: tag existence,
   * depId existence, and iterative DFS cycle detection (FR-005..FR-009, SD §9.2).
   * No-op (ok) if depId is already present in the list.
   */
  'task-add-dep'(args) {
    if (!args['task-id']) return err('MISSING_ARG: --task-id <taskId>');
    if (!args['dep-id']) return err('MISSING_ARG: --dep-id <depId>');
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    try {
      dependencyManager.addDependency(args['task-id'], args['dep-id'], args.tag);
      return ok({ taskId: args['task-id'], depId: args['dep-id'], tag: args.tag });
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-remove-dep  --task-id <taskId>  --dep-id <depId>  --tag <tag>
   *
   * Removes depId from taskId.dependencies[]. No-op (ok) if depId is not in
   * the list. Throws ERR_TAG_NOT_FOUND or ERR_DEP_NOT_FOUND when task is absent
   * (FR-008, SD §9.2).
   */
  'task-remove-dep'(args) {
    if (!args['task-id']) return err('MISSING_ARG: --task-id <taskId>');
    if (!args['dep-id']) return err('MISSING_ARG: --dep-id <depId>');
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    try {
      dependencyManager.removeDependency(args['task-id'], args['dep-id'], args.tag);
      return ok({ taskId: args['task-id'], depId: args['dep-id'], tag: args.tag });
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-add-subtask  --parent-id <parentId>  --title <title>  --tag <tag>
   *                   [--description <desc>]  [--details <details>]
   *
   * Appends a subtask to the parent task's subtasks[] with a derived hierarchical
   * id "${parentId}.${n}" (FR-010, SD §9.2). Returns the created subtask object.
   */
  'task-add-subtask'(args) {
    if (!args['parent-id']) return err('MISSING_ARG: --parent-id <parentId>');
    if (!args.title) return err('MISSING_ARG: --title <title>');
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    const subtaskData = {
      title: args.title,
      description: args.description,
      details: args.details,
    };
    try {
      const subtask = subtaskManager.addSubtask(args['parent-id'], subtaskData, args.tag);
      return ok(subtask);
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },

  /**
   * task-expand  --task-id <taskId>  --subtasks <json-file>  --tag <tag>
   *
   * Reads a JSON file containing an array of subtask descriptors and appends them
   * all to the parent task's subtasks[] with sequentially derived ids (FR-012,
   * FR-013, SD §9.2). Each element must have { title: string }. Returns the array
   * of created subtask objects as data.created.
   *
   * Errors mapped:
   *   ERR_SUBTASKS_FILE    — --subtasks file cannot be read or parsed as JSON
   *   ERR_INVALID_SUBTASKS — propagated from expandHook (missing title field)
   *   ERR_TAG_NOT_FOUND    — propagated from expandHook
   *   ERR_TASK_NOT_FOUND   — propagated from expandHook
   */
  'task-expand'(args) {
    if (!args['task-id']) return err('MISSING_ARG: --task-id <taskId>');
    if (!args.subtasks) return err('MISSING_ARG: --subtasks <json-file>');
    if (!args.tag) return err('MISSING_ARG: --tag <tag>');
    let subtasksInput;
    try {
      const raw = fs.readFileSync(args.subtasks, 'utf8');
      subtasksInput = JSON.parse(raw);
    } catch (e) {
      return err(`ERR_SUBTASKS_FILE: Cannot read --subtasks file "${args.subtasks}": ${e.message}`);
    }
    try {
      const created = expandHook(args['task-id'], subtasksInput, args.tag);
      return ok({ created });
    } catch (e) {
      return err(`${e.code || 'ERR'}: ${e.message}`);
    }
  },
};
