/**
 * stats-builder.cjs — canonical Stats builder for the MCP contract (FR-003, SD §9.1).
 *
 * The MCP get_tasks response requires Stats shaped as:
 *   { total: number, byStatus: { pending, 'in-progress', done, blocked, deferred, cancelled, review },
 *     completionPercentage: number }
 *
 * All 7 byStatus keys MUST be present even when their count is 0.
 *
 * Two functions are exported:
 *
 *   buildStats(tasksArray)
 *     Compute contract Stats from a FULL task array directly.
 *     Used by unit tests and any caller that holds the full task list.
 *
 *   toContractStats(flatStats)
 *     Convert task-core's FLAT stats { <7 status keys>, completionPercentage }
 *     into the contract shape { total, byStatus, completionPercentage }.
 *     Used by the MCP layer which receives already-aggregated flat stats from listTasks.
 *
 * Zero external dependencies. CommonJS .cjs. All code English.
 */
'use strict';

/** All 7 valid task status keys — must match task-core.cjs VALID_STATUSES (SD §9.1). */
const STATUS_KEYS = [
  'pending',
  'in-progress',
  'done',
  'blocked',
  'deferred',
  'cancelled',
  'review',
];

/**
 * Compute contract Stats from a FULL task array.
 *
 * completionPercentage = round(done / (total - cancelled) * 100)
 * When denominator (total - cancelled) is 0, completionPercentage = 0.
 *
 * @param {Array} tasksArray - full task list (not filtered)
 * @returns {{ total: number, byStatus: object, completionPercentage: number }}
 */
function buildStats(tasksArray) {
  const byStatus = {};
  for (const key of STATUS_KEYS) byStatus[key] = 0;

  const tasks = Array.isArray(tasksArray) ? tasksArray : [];
  for (const task of tasks) {
    if (task && STATUS_KEYS.includes(task.status)) {
      byStatus[task.status]++;
    }
  }

  const total = tasks.length;
  const denominator = total - byStatus.cancelled;
  const completionPercentage = denominator > 0
    ? Math.round((byStatus.done / denominator) * 100)
    : 0;

  return { total, byStatus, completionPercentage };
}

/**
 * Convert task-core's FLAT stats into the MCP contract shape.
 *
 * task-core buildStats returns:
 *   { pending: N, 'in-progress': N, done: N, blocked: N, deferred: N, cancelled: N, review: N,
 *     completionPercentage: N }
 * (no `total`, no `byStatus` wrapper)
 *
 * This function wraps that into:
 *   { total: N, byStatus: { <7 keys> }, completionPercentage: N }
 *
 * Any key missing from flatStats defaults to 0.
 * total = sum of the 7 status counts.
 * completionPercentage is passed through as-is (already computed over the full list in task-core).
 *
 * @param {object|undefined} flatStats - flat stats from task-core listTasks
 * @returns {{ total: number, byStatus: object, completionPercentage: number }}
 */
function toContractStats(flatStats) {
  const byStatus = {};
  let total = 0;

  for (const key of STATUS_KEYS) {
    const count = (flatStats && typeof flatStats[key] === 'number') ? flatStats[key] : 0;
    byStatus[key] = count;
    total += count;
  }

  const completionPercentage = (flatStats && typeof flatStats.completionPercentage === 'number')
    ? flatStats.completionPercentage
    : 0;

  return { total, byStatus, completionPercentage };
}

module.exports = { buildStats, toContractStats };
