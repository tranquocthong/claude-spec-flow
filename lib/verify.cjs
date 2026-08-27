/**
 * verify.cjs — the verification gate commands: verify-collect (consume the
 * checklist runner's JSON into VERIFICATION truths) and verify-code (the
 * automated quality gate: tests, coverage, forbidden patterns, secret scan).
 * Extracted from bin/flow-tools.cjs; behaviour and CLI contract are unchanged.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  PATHS, SKIP_SCAN_DIRS, TODO, ok, err, readJsonSafe, readTrace, resolveActiveFeature,
  resolveRepos, fileLinksPathFor,
} = require('./core.cjs');

module.exports = {
  // -----------------------------------------------------------------------
  // verify-collect  --results <file>
  // Consume the runner's JSON result and produce truths[] for VERIFICATION.md.
  // The runner (run-checklist.sh --json) emits a final line:
  //   {"passed":["TC-001",...],"failed":[{"id":"TC-002","reason":"..."}]}
  // Accepts a whole-file JSON object too. Run the runner with --json.
  // -----------------------------------------------------------------------
  'verify-collect'(args) {
    const resultsFile = args.results;
    if (!resultsFile) return err('MISSING_ARG: --results <file>');
    if (!fs.existsSync(resultsFile)) return err(`NOT_FOUND: ${resultsFile}`);

    let raw;
    try { raw = fs.readFileSync(resultsFile, 'utf8'); } catch (e) { return err(`READ_FAILED: ${e.message}`); }

    // Whole-file JSON, else the last line that parses as a results object (the
    // runner prints its human summary first, then a final JSON line under --json).
    const looksLikeResults = (o) => o && typeof o === 'object' && !Array.isArray(o) && (o.passed || o.failed);
    let data = readJsonSafe(resultsFile, null);
    if (!looksLikeResults(data)) {
      data = null;
      const lines = raw.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t.startsWith('{')) continue;
        try { const o = JSON.parse(t); if (looksLikeResults(o)) { data = o; break; } } catch {}
      }
    }
    if (!data) {
      return err('NO_JSON_RESULTS: no {passed,failed} JSON found — run the checklist with `run-checklist.sh ... --json` so the runner emits a machine-readable result line.');
    }

    const passed = (data.passed || []).map(String);
    const failed = (data.failed || []).map(f =>
      typeof f === 'string' ? { id: f, reason: 'unknown' } : { id: String(f.id || f), reason: String(f.reason || 'unknown') });

    const status = failed.length === 0 ? 'passed' : 'failed';
    const truths = passed.map(id => `${id}: verified`);

    return ok({ status, passed, failed, truths });
  },

  // -----------------------------------------------------------------------
  // verify-code  [--feature <f>]
  //
  // Generic, config-driven quality gate. Reads .spec-flow/config.json →
  // verify block. If no config or no verify block → all checks skipped
  // gracefully (never fails for unconfigured projects).
  //
  // verify block shape:
  //   { testCommand, coverageThreshold, coverageCommand,
  //     forbiddenPatterns, scanPath, secretScan }
  //
  // Checks: tests · coverage · forbidden-patterns · secret-scan
  // Returns ok({ checks, summary, gate }) — NEVER throws.
  // -----------------------------------------------------------------------
  'verify-code'(args) {
    const { spawnSync } = require('child_process');
    // --expect fail: RED-phase mode — test must FAIL before implementation.
    // Inverts pass/fail logic for the test check and skips the other checks.
    const expectFail = args.expect === 'fail';

    // --- helper: one check entry -----------------------------------------
    const makeCheck = (name, status, detail, fix) =>
      ({ name, status: status || 'skipped', detail: detail || null, fix: fix || null });

    // --- read config -------------------------------------------------------
    const cfg = readJsonSafe(PATHS.config, null);
    const verifyCfg = cfg && cfg.verify ? cfg.verify : null;

    // If no config at all or no verify block → skip everything gracefully
    if (!verifyCfg) {
      const checks = [
        makeCheck('tests', 'skipped', 'No verify block in .spec-flow/config.json', 'Run /sf:init to seed a verify preset, or add a "verify" block manually.'),
        makeCheck('coverage', 'skipped', 'No verify block in .spec-flow/config.json', null),
        makeCheck('forbidden-patterns', 'skipped', 'No verify block in .spec-flow/config.json', null),
        makeCheck('secret-scan', 'skipped', 'No verify block in .spec-flow/config.json', null),
      ];
      const summary = { ok: 0, warn: 0, fail: 0, skipped: 4 };
      // gate: 'skipped' — NOT 'pass'. A no-op gate must not masquerade as a passed
      // gate (transparency): nothing was actually verified. The caller treats
      // 'skipped' distinctly (warn, do not claim the code was verified).
      return ok({ checks, summary, gate: 'skipped', note: 'verify not configured — nothing checked. Re-run /sf:init with --stack <stack> to seed a real verify preset.' });
    }

    const {
      testCommand = null,
      coverageThreshold = null,
      coverageCommand = null,
      forbiddenPatterns = [],
      scanPath: rawScanPath = null,
      secretScan = true,
    } = verifyCfg;

    // Multi-repo: run the checks inside EACH code root (config.repos) so a feature
    // whose code lives in sibling service repos is actually scanned. Single-repo →
    // one root at cwd (backward compat). Check names are repo-prefixed in multi mode.
    const roots = resolveRepos(cfg);

    // Scope (multi-repo): a change usually touches only SOME of config.repos, but the
    // gate is worst-wins across all of them — so an unrelated repo's red WIP poisons a
    // clean feature's gate. Narrow to the repos the feature targets, by precedence:
    //   1. --repos "a,b"  → explicit filter.
    //   2. trace.json.repos (declared via trace-repos) → stated intent.
    //   3. --feature X    → auto from X's file-links.json repo prefixes (evidence).
    // No filter, single-repo (name null), or no match → scan all (full backward compat).
    let scopedRoots = roots;
    let scopeNote = null;
    const scopeWarnings = [];
    const explicitRepos = (typeof args.repos === 'string' && args.repos.trim())
      ? new Set(args.repos.split(',').map(s => s.trim()).filter(Boolean)) : null;
    const { feature: vcFeature, source: vcFeatureSource } = resolveActiveFeature(args.feature);
    // Declared subset (intent stated up front, ABOVE file-links evidence).
    let declaredRepos = null;
    if (!explicitRepos && vcFeature) {
      const tr = readTrace(vcFeature);
      if (tr && Array.isArray(tr.repos) && tr.repos.length) declaredRepos = new Set(tr.repos);
    }
    // File-links inference (what the feature actually wrote to).
    let touchedRepos = null;
    if (!explicitRepos && vcFeature) {
      const flPath = fileLinksPathFor(vcFeature);
      if (fs.existsSync(flPath)) {
        const names = new Set(roots.map(r => r.name).filter(Boolean));
        const seen = new Set(((readJsonSafe(flPath, { links: [] }).links) || [])
          .map(l => String(l.file || '').split('/')[0]).filter(seg => names.has(seg)));
        if (seen.size) touchedRepos = seen;
      }
    }
    // Consistency cross-check: a declared repo with zero file-links → possibly forgotten
    // work. Surfaces drift; does NOT fail the gate.
    if (declaredRepos && touchedRepos) {
      for (const r of declaredRepos) if (!touchedRepos.has(r)) scopeWarnings.push(`declared repo "${r}" has no file-links yet — forgotten work?`);
    }
    const repoFilter = explicitRepos || declaredRepos || touchedRepos;
    const filterVia = explicitRepos ? '--repos' : declaredRepos ? `feature ${vcFeature} (declared)` : `feature ${vcFeature} (file-links)`;
    if (repoFilter) {
      const narrowed = roots.filter(r => !r.name || repoFilter.has(r.name));
      if (narrowed.length) {
        scopedRoots = narrowed;
        scopeNote = `scoped to [${[...repoFilter].join(', ')}] via ${filterVia}`;
      }
    }

    // --- per-task test scoping (opt-in via --task/--files) ------------------
    // Running the FULL suite on every task close is the single biggest cost in
    // a multi-task phase. When the caller identifies which files THIS task
    // touched, scope the "tests" check to just their test files instead — the
    // full suite still runs, but once, at phase close-out (regression sweep).
    // Backward compatible: no --task/--files → unscoped, exactly the old behavior.
    const rawFilesArg = (typeof args.files === 'string' && args.files.trim()) ? args.files.split(',').map(s => s.trim()).filter(Boolean) : [];
    let taskFiles = [...rawFilesArg];
    if (args.task && vcFeature) {
      const flPath = fileLinksPathFor(vcFeature);
      const links = (readJsonSafe(flPath, { links: [] }).links || []).filter(l => String(l.task) === String(args.task));
      taskFiles.push(...links.map(l => l.file));
    }
    taskFiles = [...new Set(taskFiles)];

    // Group scoping files by which repo root they belong to (multi-repo files are
    // stored "<repo>/<path>" by trace-link; single-repo files are bare paths).
    const scopeFilesByRoot = new Map(); // key: rp.name || '' -> string[] (root-relative)
    for (const f of taskFiles) {
      const rootMatch = roots.find(r => r.name && f.startsWith(r.name + '/'));
      const key = rootMatch ? rootMatch.name : '';
      const rel = rootMatch ? f.slice(rootMatch.name.length + 1) : f;
      if (!scopeFilesByRoot.has(key)) scopeFilesByRoot.set(key, []);
      scopeFilesByRoot.get(key).push(rel);
    }

    // Java (Gradle/Maven): "src/test/(java|kotlin)/a/b/CFoo.java" -> FQCN "a.b.CFoo".
    const toJavaFqcn = (relPath) => {
      const m = String(relPath).replace(/\\/g, '/').match(/(?:^|\/)src\/test\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/);
      return m ? m[1].replace(/\//g, '.') : null;
    };

    // Build a scoped test command for one root, or null if scoping isn't possible
    // (no matching test files, or the stack has no known filter syntax) — caller
    // falls back to the full, unscoped testCommand.
    const buildScopedTestCommand = (rootKey) => {
      const files = scopeFilesByRoot.get(rootKey) || [];
      if (!files.length) return null;
      if (cfg.stack === 'java-spring') {
        const fqcns = files.map(toJavaFqcn).filter(Boolean);
        if (!fqcns.length) return null;
        return { command: `${testCommand} ${fqcns.map(f => `--tests "${f}"`).join(' ')}`, targets: fqcns };
      }
      if (cfg.stack === 'java-maven') {
        const fqcns = files.map(toJavaFqcn).filter(Boolean);
        if (!fqcns.length) return null;
        return { command: `${testCommand} -Dtest=${fqcns.join(',')}`, targets: fqcns };
      }
      // Other stacks: no validated filter syntax yet — scope by explicit opt-in
      // only (config.verify.taskTestCommand, a template with a {files} placeholder).
      if (verifyCfg.taskTestCommand) {
        return { command: String(verifyCfg.taskTestCommand).replace('{files}', files.map(f => `"${f}"`).join(' ')), targets: files };
      }
      return null;
    };

    // Build the check list for ONE repo root. `rootDir` scopes both the test/
    // coverage commands' cwd and the forbidden/secret filesystem scans.
    const runChecksInRoot = (rootDir, rootKey) => {
      // Resolve scanPath per root: explicit → src if exists → '.'
      let scanPath = rawScanPath || null;
      if (!scanPath) {
        scanPath = fs.existsSync(path.join(rootDir, 'src')) ? 'src' : '.';
      }

      const checks = [];
      let testOutput = '';

      const scoped = buildScopedTestCommand(rootKey);
      const effectiveTestCommand = scoped ? scoped.command : testCommand;

    // ---- a. tests ---------------------------------------------------------
    if (!testCommand) {
      checks.push(makeCheck('tests', 'skipped', 'testCommand not set', null));
    } else {
      let testStatus = 'ok';
      let testDetail = '';
      let testFix = null;
      try {
        const result = spawnSync(effectiveTestCommand, {
          shell: true,
          cwd: rootDir,
          timeout: 600000,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        const combined = (result.stdout || '') + (result.stderr || '');
        testOutput = combined;
        const exitCode = result.status;
        const scopeTag = scoped ? ` [scoped to ${scoped.targets.length} test(s): ${scoped.targets.join(', ')}]` : '';
        if (result.error) {
          // spawn-level error (command not found, timeout, etc.)
          testStatus = 'fail';
          testDetail = `Command error: ${result.error.message}`;
          testFix = `Check testCommand in .spec-flow/config.json: "${effectiveTestCommand}"`;
        } else if (expectFail) {
          // RED-phase: test must fail before production code exists
          if (exitCode !== 0) {
            testStatus = 'ok';
            testDetail = `RED confirmed — test fails (exit ${exitCode}).${scopeTag} Implement now.`;
          } else {
            testStatus = 'fail';
            testDetail = `RED not confirmed — tests pass (exit 0) before any production code was written.${scopeTag} The test is trivially green or the behavior already exists.`;
            testFix = 'Write a more specific test that exercises the new behavior. Check: is this FR already implemented?';
          }
        } else if (exitCode !== 0) {
          testStatus = 'fail';
          const lines = combined.split(/\r?\n/).filter(Boolean);
          const tail = lines.slice(-15).join('\n');
          testDetail = `Exit ${exitCode}.${scopeTag} Last output:\n${tail}`;
          testFix = `Fix failing tests before proceeding. Command: ${effectiveTestCommand}`;
        } else {
          testStatus = 'ok';
          testDetail = `Command exited 0: ${effectiveTestCommand}${scopeTag}`;
        }
      } catch (e) {
        testStatus = 'fail';
        testDetail = `Unexpected error running tests: ${e && e.message ? e.message : String(e)}`;
        testFix = `Check testCommand in .spec-flow/config.json`;
      }
      checks.push(makeCheck('tests', testStatus, testDetail, testFix));
      if (scoped) checks[checks.length - 1].scoped = true;
    }
    // RED-phase: skip implementation-phase checks (production code doesn't exist yet)
    if (expectFail) {
      ['coverage', 'forbidden-patterns', 'secret-scan'].forEach(n =>
        checks.push(makeCheck(n, 'skipped', 'RED-phase — not applicable pre-implementation', null)));
      return checks;
    }

    // ---- b. coverage ------------------------------------------------------
    if (coverageThreshold === null || coverageThreshold === undefined) {
      checks.push(makeCheck('coverage', 'skipped', 'coverageThreshold not set', null));
    } else {
      let covStatus = 'skipped';
      let covDetail = null;
      let covFix = null;
      // Source text: run coverageCommand if set, else reuse testOutput
      let covText = testOutput;
      if (coverageCommand) {
        try {
          const cr = spawnSync(coverageCommand, {
            shell: true, cwd: rootDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe',
          });
          covText = (cr.stdout || '') + (cr.stderr || '');
        } catch (e) {
          covText = '';
        }
      }
      // Prefer a coverage-labelled line; else take the LAST percentage. Never the
      // first: build tools print progress like "Executing tasks [80%]" BEFORE the
      // real coverage number, so a first-match would read the progress bar as coverage.
      const labelled = covText.split(/\r?\n/).filter(l => /coverage|total|lines?|instructions?/i.test(l) && /\d+(?:\.\d+)?\s*%/.test(l));
      const pctSource = labelled.length ? labelled[labelled.length - 1] : covText;
      const allPct = [...pctSource.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
      const pctMatch = allPct.length ? allPct[allPct.length - 1] : null;
      if (!pctMatch) {
        covStatus = 'warn';
        covDetail = `Could not parse a coverage percentage from output. Threshold is ${coverageThreshold}%.`;
        covFix = 'Ensure your test/coverage command prints a percentage like "80%" or "Coverage: 75.3%".';
      } else {
        const pct = parseFloat(pctMatch[1]);
        if (pct >= coverageThreshold) {
          covStatus = 'ok';
          covDetail = `Coverage ${pct}% >= threshold ${coverageThreshold}%`;
        } else {
          covStatus = 'fail';
          covDetail = `Coverage ${pct}% < threshold ${coverageThreshold}%`;
          covFix = `Increase test coverage to at least ${coverageThreshold}%.`;
        }
      }
      checks.push(makeCheck('coverage', covStatus, covDetail, covFix));
    }

    // ---- c. forbidden-patterns --------------------------------------------
    if (!Array.isArray(forbiddenPatterns) || forbiddenPatterns.length === 0) {
      checks.push(makeCheck('forbidden-patterns', 'skipped', 'forbiddenPatterns is empty', null));
    } else {
      let fpStatus = 'ok';
      const hits = [];

      // Recursive file walk (pure Node — no child_process grep dependency)
      const walkDir = (dir, depth) => {
        if (depth > 20) return; // safety cap
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          const fullPath = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            // Skip obvious noise dirs
            if (SKIP_SCAN_DIRS.has(ent.name)) continue;
            walkDir(fullPath, depth + 1);
          } else if (ent.isFile()) {
            // Skip prose/doc files — forbiddenPatterns (console.log(, debugger;, .only() are
            // JS code smells; markdown commonly embeds a literal snippet (e.g. a `node -e
            // "console.log(...)"` CLI example) that legitimately contains the pattern text
            // without being leftover debug code. Scanning doc prose for source-code smells
            // produces false positives, not real findings.
            if (/\.mdx?$/i.test(ent.name)) continue;
            let content;
            try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
            const lines = content.split(/\r?\n/);
            for (const rawPat of forbiddenPatterns) {
              if (!rawPat) continue;
              let re;
              try { re = new RegExp(rawPat); } catch { re = new RegExp(rawPat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
              for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                  hits.push({ pattern: rawPat, file: path.relative(process.cwd(), fullPath), line: i + 1, text: lines[i].trim().slice(0, 120) });
                  if (hits.length >= 10) return; // cap hits
                }
              }
              if (hits.length >= 10) return;
            }
          }
        }
      };

      const absScanPath = path.isAbsolute(scanPath) ? scanPath : path.join(rootDir, scanPath);
      if (fs.existsSync(absScanPath)) {
        walkDir(absScanPath, 0);
      }

      if (hits.length > 0) {
        fpStatus = 'fail';
        const hitSummary = hits.slice(0, 5).map(h => `${h.file}:${h.line} [${h.pattern}] → ${h.text}`).join('\n');
        checks.push(makeCheck('forbidden-patterns', fpStatus,
          `${hits.length} forbidden pattern hit(s):\n${hitSummary}`,
          `Remove the flagged patterns. See config.verify.forbiddenPatterns.`));
      } else {
        checks.push(makeCheck('forbidden-patterns', 'ok',
          `No forbidden patterns found in ${scanPath} (checked ${forbiddenPatterns.length} pattern(s))`, null));
      }
    }

    // ---- d. secret-scan ---------------------------------------------------
    if (secretScan === false) {
      checks.push(makeCheck('secret-scan', 'skipped', 'secretScan disabled in config', null));
    } else {
      // Generic: look for common secret-like key=value patterns (case-insensitive)
      const SECRET_PATTERNS = [
        /password\s*=/i,
        /api_key\s*=/i,
        /apikey\s*=/i,
        /secret\s*=/i,
        /token\s*=/i,
      ];
      // Exclude common placeholders so we don't cry wolf on config templates
      const PLACEHOLDER_RE = /\$\{|\{\{|<.*?>|CHANGEME|TODO|PLACEHOLDER|your[-_]|example[-_]/i;

      const secretHits = [];

      const walkForSecrets = (dir, depth) => {
        if (depth > 20 || secretHits.length >= 10) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (secretHits.length >= 10) return;
          const fullPath = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (SKIP_SCAN_DIRS.has(ent.name)) continue;
            walkForSecrets(fullPath, depth + 1);
          } else if (ent.isFile()) {
            // Skip binary-ish extensions
            const ext = path.extname(ent.name).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.eot', '.ttf', '.otf', '.pdf', '.zip', '.jar', '.class'].includes(ext)) continue;
            // Skip test files (they legitimately use fake secrets)
            if (/test|spec|mock|fixture|example/i.test(ent.name)) continue;
            let content;
            try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              for (const re of SECRET_PATTERNS) {
                if (re.test(line) && !PLACEHOLDER_RE.test(line)) {
                  secretHits.push({ file: path.relative(process.cwd(), fullPath), line: i + 1, text: line.trim().slice(0, 80) });
                  if (secretHits.length >= 10) break;
                }
              }
              if (secretHits.length >= 10) break;
            }
          }
        }
      };

      const absScanPath = path.isAbsolute(scanPath) ? scanPath : path.join(rootDir, scanPath);
      if (fs.existsSync(absScanPath)) {
        walkForSecrets(absScanPath, 0);
      }

      if (secretHits.length > 0) {
        const hitSummary = secretHits.slice(0, 5).map(h => `${h.file}:${h.line} → ${h.text}`).join('\n');
        checks.push(makeCheck('secret-scan', 'warn',
          `${secretHits.length} potential secret pattern(s) found:\n${hitSummary}`,
          'Review and replace hardcoded credentials with environment variables or vault references.'));
      } else {
        checks.push(makeCheck('secret-scan', 'ok',
          `No secret patterns found in ${scanPath}`, null));
      }
      }
      return checks;
    };

    // Aggregate across all code roots. In multi-repo mode prefix each check name
    // with its repo so a failing check is traceable to the right service.
    const checks = [];
    for (const rp of scopedRoots) {
      const got = runChecksInRoot(rp.root, rp.name || '');
      if (rp.name) got.forEach((c) => { c.name = `[${rp.name}] ${c.name}`; c.repo = rp.name; });
      checks.push(...got);
    }

    // ---- summary + gate ---------------------------------------------------
    const summary = { ok: 0, warn: 0, fail: 0, skipped: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
    // 'skipped' when nothing actually ran (all checks skipped) — don't let a no-op
    // gate read as 'pass'. 'fail' on any failure (worst-wins across repos); else
    // 'pass' if at least one real check ran in any repo.
    const ran = summary.ok + summary.warn + summary.fail;
    const gate = summary.fail > 0 ? 'fail' : (ran === 0 ? 'skipped' : (expectFail ? 'red-confirmed' : 'pass'));

    const result = { checks, summary, gate, feature: vcFeature, featureSource: vcFeatureSource, repos: scopedRoots.map((r) => r.name).filter(Boolean), scope: scopeNote };
    if (scopeWarnings.length) result.scopeWarnings = scopeWarnings;
    const testScoped = checks.some((c) => c.scoped);
    result.testsScoped = testScoped;
    if (!testScoped && taskFiles.length) {
      result.scopeNoteTests = 'requested test scoping (--task/--files) but could not derive a filter for this stack/these files — ran the full suite.';
    }
    return ok(result);
  },
};
