/**
 * drift.cjs — Layer-2 SEMANTIC drift-check (SD-mismatch defense).
 *
 * The structural `sd-drift-detect` hook only checks file-in-trace / FR-has-TC. THIS is
 * the semantic layer the original design advertised: it diffs what the executor ACTUALLY
 * implemented (the `update-task --append` notes the hybrid-executor logs into tasks.json:
 * actual error codes / status codes / files) against what the SD SPECIFIES (§12.2 error
 * codes, via the trace) — surfacing SD-mismatch BEFORE it ships.
 *
 * Scope (v1): §12.2 error codes — the high-signal, deterministically-extractable contract
 * element. §9.2 field names and §10.4 state transitions are left to future work: their
 * "actual" form in free-prose task logs is too noisy to diff deterministically without
 * false positives. Error codes (and the configured errorCodePattern) are precise tokens.
 *
 * HONEST framing: the ACTUAL signal is whatever the executor chose to LOG. So absence of
 * an SD code in the logs means "no evidence in the task notes", NOT "definitely
 * unimplemented" — the warning says exactly that. Advisory only, never blocks.
 */
'use strict';
const path = require('path');
const { PATHS, ok, err, readJsonSafe, readTrace, readTmTasks } = require('./core.cjs');

module.exports = {
  // -----------------------------------------------------------------------
  // drift-check  [--feature <f>] [--tasks <tasks.json>]
  // Diff SD §12.2 error codes vs the executor's implementation logs in tasks.json.
  // Returns ok({ specifiedErrorCodes, evidencedErrorCodes, implOnlyErrorCodes, drift[], clean }).
  // NEVER blocks — drift[] is advisory (surfaced by /sf:phase before next_task).
  // -----------------------------------------------------------------------
  'drift-check'(args) {
    const feature = args.feature || (readJsonSafe(PATHS.trace, null) || {}).feature || null;
    const trace = readTrace(feature);
    if (!trace) return err('NO_TRACE: run trace-build first');
    const errorNodes = (trace.nodes && trace.nodes.errors) || [];

    // Gather the executor's implementation logs (task.details / subtask.details — where
    // `update-task --append` writes the actual field/status/error-code notes).
    const tasksFile = args.tasks || path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
    const tasks = readTmTasks(readJsonSafe(tasksFile, null), feature);
    const logParts = [];
    for (const t of tasks) {
      if (t && t.details) logParts.push(String(t.details));
      for (const st of (t && t.subtasks) || []) { if (st && st.details) logParts.push(String(st.details)); }
    }
    const implLog = logParts.join('\n');
    const logLc = implLog.toLowerCase();
    const hasLogs = implLog.trim().length > 0;

    const sdCodes = errorNodes.map((n) => String(n.code || '').replace(/`/g, '').trim()).filter(Boolean);
    const lc = (s) => s.toLowerCase();

    // No logs yet → can't diff (every SD code would falsely look "not evidenced").
    if (!hasLogs) {
      return ok({
        feature, specifiedErrorCodes: sdCodes, evidencedErrorCodes: [], implOnlyErrorCodes: [],
        drift: [], clean: true,
        note: 'no task implementation logs found yet — drift-check needs the executor\'s update-task notes (run after some tasks are implemented).',
      });
    }

    // Extract impl error-code tokens: the configured prefix (default ERR_), plus the
    // project's errorCodePattern when set (so non-ERR_ schemes like WALLET-4001 are caught).
    const conv = (readJsonSafe(PATHS.config, {}) || {}).conventions || {};
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRes = [new RegExp('\\b' + esc(conv.errorCodePrefix || 'ERR_') + '[A-Za-z0-9_]+\\b', 'g')];
    if (conv.errorCodePattern) { try { tokenRes.push(new RegExp(conv.errorCodePattern.replace(/^\^/, '').replace(/\$$/, ''), 'g')); } catch { /* invalid pattern: skip */ } }
    const implCodes = new Set();
    for (const re of tokenRes) { let m; while ((m = re.exec(implLog)) !== null) implCodes.add(m[0]); }

    const sdLcSet = new Set(sdCodes.map(lc));
    const drift = [];
    // (1) SD-specified error code with NO evidence in any task log.
    for (const c of sdCodes) {
      if (!logLc.includes(lc(c))) {
        drift.push({ type: 'spec-not-evidenced', code: c, hint: `SD §12.2 defines ${c} but no task log mentions it — confirm it's implemented (or that the executor logged the actual error code).` });
      }
    }
    // (2) Implemented error code the SD §12.2 doesn't document.
    for (const c of implCodes) {
      if (!sdLcSet.has(lc(c))) {
        drift.push({ type: 'impl-not-specced', code: c, hint: `Task logs mention ${c} but SD §12.2 doesn't document it — add it to §12.2, or change the code to the spec'd one.` });
      }
    }

    return ok({
      feature,
      specifiedErrorCodes: sdCodes,
      evidencedErrorCodes: sdCodes.filter((c) => logLc.includes(lc(c))),
      implOnlyErrorCodes: [...implCodes].filter((c) => !sdLcSet.has(lc(c))),
      drift,
      clean: drift.length === 0,
      note: 'Layer-2 error-code drift (advisory). §9.2 field / §10.4 state drift not yet covered (too noisy from prose logs).',
    });
  },
};
