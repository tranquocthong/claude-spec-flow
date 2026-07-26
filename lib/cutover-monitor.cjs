/**
 * cutover-monitor.cjs — post-cutover monitoring suite for the native task engine (C-6, FR-007).
 *
 * Provides the tooling an operator uses to monitor native-engine health across the
 * 1-2 real features after the flip (the C-6 soak). Wraps doctor-contract.runContractCheck
 * per feature and aggregates results into a soak summary.
 *
 * The allGreen signal gates C-7 (dependency removal): only when every monitored
 * feature passes all doctor-contract checks can the operator proceed to remove the
 * task-master-ai dependency.
 *
 * Public API:
 *   monitorFeature(featureName, _inject?) → Promise<{ feature, ok, checks }>
 *   summarize(results) → { total, passed, failed, allGreen, failures }
 *
 * CLI runner (if require.main === module):
 *   node lib/cutover-monitor.cjs <feature1> [feature2 ...]
 *   Prints summary to stderr. Exits 0 iff allGreen.
 *
 * Zero external dependencies. Pure Node CommonJS. 'use strict'. All code English.
 */
'use strict';

// ---------------------------------------------------------------------------
// monitorFeature — run contract check for one feature
// ---------------------------------------------------------------------------

/**
 * Run the native doctor-contract check for a single feature and wrap the result
 * with the feature name.
 *
 * Delegates entirely to doctor-contract.cjs runContractCheck — all _inject fields
 * (_paths, _configFile, _simulateMissingTool) are passed through unchanged for
 * test isolation.
 *
 * Never throws. All errors surface as { ok: false, checks: [{ status: 'fail', ... }] }.
 *
 * @param {string} featureName - the feature under monitor (label only, not a path)
 * @param {object} [_inject]   - injection fields forwarded to runContractCheck (see doctor-contract.cjs)
 * @returns {Promise<{ feature: string, ok: boolean, checks: Array<{name, status, detail}> }>}
 */
async function monitorFeature(featureName, _inject) {
  const { runContractCheck } = require('./doctor-contract.cjs');

  let contractResult;
  try {
    contractResult = await runContractCheck(_inject);
  } catch (err) {
    // Defensive: runContractCheck threw unexpectedly — report as a single failed check
    contractResult = {
      ok: false,
      checks: [
        {
          name: 'doctor-contract-error',
          status: 'fail',
          detail: `runContractCheck threw: ${err.message}`,
        },
      ],
    };
  }

  return {
    feature: featureName,
    ok: contractResult.ok,
    checks: contractResult.checks,
  };
}

// ---------------------------------------------------------------------------
// summarize — aggregate an array of monitorFeature results
// ---------------------------------------------------------------------------

/**
 * Aggregate an array of monitorFeature results into a soak summary.
 *
 * allGreen is the C-6 gate: true only when every feature passed all checks.
 * An empty input is vacuously allGreen (no features to monitor yet is not a failure).
 *
 * @param {Array<{ feature: string, ok: boolean, checks: Array<{name, status, detail}> }>} results
 * @returns {{
 *   total: number,
 *   passed: number,
 *   failed: number,
 *   allGreen: boolean,
 *   failures: Array<{ feature: string, failedChecks: string[] }>
 * }}
 */
function summarize(results) {
  const total = results.length;
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const result of results) {
    if (result.ok) {
      passed++;
    } else {
      failed++;
      const failedChecks = (result.checks || [])
        .filter((c) => c.status === 'fail')
        .map((c) => c.name);
      failures.push({ feature: result.feature, failedChecks });
    }
  }

  const allGreen = failed === 0;

  return { total, passed, failed, allGreen, failures };
}

// ---------------------------------------------------------------------------
// CLI runner — C-6 soak runner (node lib/cutover-monitor.cjs feat-a feat-b ...)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const featureNames = process.argv.slice(2);

  if (featureNames.length === 0) {
    process.stderr.write('cutover-monitor: no features specified\n');
    process.stderr.write('usage: node lib/cutover-monitor.cjs <feature1> [feature2 ...]\n');
    process.exit(1);
  }

  (async () => {
    const results = [];
    for (const name of featureNames) {
      process.stderr.write(`[RUN] monitoring feature: ${name}\n`);
      const result = await monitorFeature(name);
      results.push(result);

      for (const check of result.checks) {
        const marker = check.status === 'pass' ? 'PASS' : 'FAIL';
        process.stderr.write(`  [${marker}] ${check.name}: ${check.detail}\n`);
      }

      const status = result.ok ? 'OK' : 'FAILED';
      process.stderr.write(`[${status}] ${name}\n\n`);
    }

    const summary = summarize(results);

    process.stderr.write('--- cutover-monitor summary ---\n');
    process.stderr.write(`total: ${summary.total}  passed: ${summary.passed}  failed: ${summary.failed}\n`);

    if (summary.allGreen) {
      process.stderr.write('allGreen: true — C-7 dependency removal gate OPEN\n');
    } else {
      process.stderr.write('allGreen: false — C-7 gate BLOCKED; rollback if regressions persist\n');
      for (const f of summary.failures) {
        process.stderr.write(`  FAILED ${f.feature}: ${f.failedChecks.join(', ')}\n`);
      }
    }

    process.exit(summary.allGreen ? 0 : 1);
  })().catch((err) => {
    process.stderr.write(`cutover-monitor: fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { monitorFeature, summarize };
