/**
 * maintenance.cjs — static, non-workflow commands: setup + health + meta.
 * init, init-project, learn, doctor. (Workflow commands live in bin/flow-tools.cjs.)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  STATE_DIR, PATHS, PLUGIN_ROOT, STATE_FILE, SKIP_SCAN_DIRS, ok, err, parseArgs, readJsonSafe, traceFileFor, readTrace, hydrateTrace, resolveActiveFeature, shipFileFor, versionSyncStatus, pluginSourceDrift, ensureDir, slugify, pad3, readTmTasks, fileLinksPathFor, resolveRepos, resolveRepoVerify, parseReposArg, langPack, kwRe, cleanHeading, parseHeadings, bodyOf, classifyHeading, findHeading, findTableByHeader, parseFirstTable, parseAllTables, splitRow, parseUserStories, trimOrNull, extractBulletsAfter, inferDesignType, parseSrs, TODO, countSdTodos, moscowFor, genSd, readSdTables, scoreComplexity, routeFor, tcIdsForReq, resolveTemplate
} = require('./core.cjs');
const taskCore = require('./task-core.cjs');
const backlog = require('./backlog.cjs');
const { validateRules } = require('./code-rules.cjs');

/**
 * Compare the runtime surface of two plugin trees by content hash.
 *
 * Deliberately NOT a full recursive diff. It walks only the directories whose
 * contents change behaviour, so the check stays fast and cannot be tripped by the
 * things that legitimately differ between a source repo and its installed copy:
 * build output (dist/), the maintainer's own dev state (.spec-flow/, .taskmaster/),
 * tests, CI config, node_modules.
 *
 * @returns {{differing: string[], compared: number}} paths relative to each root
 */
const SYNC_DIRS = ['bin', 'lib', 'commands', 'agents', 'skills', 'templates', 'hooks'];
function compareTrees(srcRoot, dstRoot) {
  const { createHash } = require('crypto');
  // Existence is checked here, not by the caller: pluginSourceDrift is a pure
  // decision function and this is the only place allowed to touch the disk.
  if (!fs.existsSync(srcRoot)) return { differing: [], compared: 0, missingSource: true };
  const differing = [];
  let compared = 0;

  const walk = (root, dir, out) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name === '.DS_Store' || e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(root, rel, out);
      else if (e.isFile()) out.add(rel);
    }
    return out;
  };
  const hash = (file) => {
    try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
  };

  for (const top of SYNC_DIRS) {
    const rels = walk(srcRoot, top, new Set());
    for (const r of walk(dstRoot, top, new Set())) rels.add(r);
    for (const rel of rels) {
      compared++;
      // A missing file on either side hashes to null; null !== hex, and
      // null === null only when BOTH are unreadable, which is not drift.
      if (hash(path.join(srcRoot, rel)) !== hash(path.join(dstRoot, rel))) differing.push(rel);
    }
  }
  differing.sort();
  return { differing, compared };
}

module.exports = {
  init() {
    ensureDir(PATHS.stateDir);
    return ok({ paths: PATHS, config: readJsonSafe(PATHS.config, { mode: 'adaptive', smokeTag: 'smoke', regressionTag: 'regression' }), traceExists: fs.existsSync(PATHS.trace) });
  },

  // -----------------------------------------------------------------------
  // init-project  [--name <n>] [--stack java-spring|node|python|go|dotnet]
  //               [--design-type auto|api|internal|hybrid]
  //
  // Idempotent bootstrap: writes .spec-flow/config.json + project-author.md
  // + .gitignore. Does NOT overwrite files that already exist.
  // Seeds a "verify" block in config.json based on --stack (DATA presets;
  // engine stays 100% generic — stack specifics are just config values).
  // Returns ok({ created, alreadyExisted, verifyPreset, next }).
  // -----------------------------------------------------------------------
  'init-project'(args) {
    const VALID_STACKS = ['java-spring', 'java-maven', 'node', 'python', 'go', 'dotnet'];
    const VALID_DESIGN_TYPES = ['auto', 'api', 'internal', 'hybrid'];

    // Auto-detect the stack from build-tool markers when --stack is omitted, so the verify
    // gate isn't silently empty for an obvious project. Gradle vs Maven matter (different
    // test command). Explicit --stack always wins.
    const detectStack = (dir) => {
      const has = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch { return false; } };
      if (has('build.gradle') || has('build.gradle.kts')) return 'java-spring';
      if (has('pom.xml')) return 'java-maven';
      if (has('package.json')) return 'node';
      if (has('go.mod')) return 'go';
      if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) return 'python';
      try { if (fs.readdirSync(dir).some((f) => f.endsWith('.csproj'))) return 'dotnet'; } catch {}
      return 'unknown';
    };

    const projectName = args.name || path.basename(process.cwd());
    const stack = VALID_STACKS.includes(args.stack) ? args.stack : detectStack(process.cwd());
    const designTypeDefault = VALID_DESIGN_TYPES.includes(args['design-type']) ? args['design-type'] : 'auto';
    // Language for AUTHORED-DOC PROSE (SD, CONTEXT) — read by the sd-author agent.
    // Free-form label/code (e.g. 'en', 'vi', 'Vietnamese'); default English.
    // NOTE: only prose is localized; SD structure (section numbers, table headers,
    // FR/TC/NFR IDs, code identifiers) stays canonical English so the deterministic
    // parsers (checklist-gen, trace-build) keep working.
    const language = (typeof args.language === 'string' && args.language.trim()) ? args.language.trim() : 'en';
    // Multi-repo: --repos "auth-svc=../auth-svc,billing-svc=../billing-svc" → config.repos map.
    // Absent → single-repo (cwd). One SRS/SD can drive code across sibling repos.
    const repos = parseReposArg(args.repos);

    // ---- verify presets (DATA — engine never reads these; verify-code is generic) ----
    const VERIFY_PRESETS = {
      'java-spring': {
        testCommand: './gradlew test',
        coverageThreshold: 80,
        coverageCommand: null,
        forbiddenPatterns: ['\\.block\\(\\)', '\\.blockFirst\\(\\)', '\\.blockLast\\(\\)'],
        scanPath: 'src',
        secretScan: true,
      },
      'java-maven': {
        testCommand: 'mvn -q test',
        coverageThreshold: 80,
        coverageCommand: null,
        forbiddenPatterns: ['\\.block\\(\\)', '\\.blockFirst\\(\\)', '\\.blockLast\\(\\)'],
        scanPath: 'src',
        secretScan: true,
      },
      'node': {
        testCommand: 'npm test',
        coverageThreshold: null,
        coverageCommand: null,
        forbiddenPatterns: ['console\\.log\\(', 'debugger;', '\\.only\\('],
        scanPath: 'src',
        secretScan: true,
      },
      'python': {
        testCommand: 'pytest -q',
        coverageThreshold: null,
        coverageCommand: null,
        forbiddenPatterns: ['pdb\\.set_trace\\(\\)', 'breakpoint\\(\\)'],
        scanPath: 'src',
        secretScan: true,
      },
      'go': {
        testCommand: 'go test ./...',
        coverageThreshold: null,
        coverageCommand: null,
        forbiddenPatterns: ['fmt\\.Println\\(', 'time\\.Sleep\\('],
        scanPath: '.',
        secretScan: true,
      },
      'dotnet': {
        testCommand: 'dotnet test',
        coverageThreshold: null,
        coverageCommand: null,
        forbiddenPatterns: ['Console\\.WriteLine\\('],
        scanPath: 'src',
        secretScan: true,
      },
    };
    // Fallback for unknown/none: all-skipping generic preset
    const verifyPreset = VERIFY_PRESETS[stack] || {
      testCommand: null,
      coverageThreshold: null,
      coverageCommand: null,
      forbiddenPatterns: [],
      scanPath: 'src',
      secretScan: true,
    };

    // ---- branching defaults (DATA — VCS-agnostic; engine just substitutes templates) ----
    // base = the current branch at init time (the integration branch teams merge back into).
    let detectedBase = 'main';
    try {
      const { execSync } = require('child_process');
      const b = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
      if (b && b !== 'HEAD') detectedBase = b;
    } catch { /* not a git repo — keep 'main' */ }
    const BRANCHING_DEFAULT = {
      mode: 'per-sd', // per-sd | per-sd+bug | off
      base: detectedBase,
      templates: { sd: 'feat/{feature}', bug: 'fix/{id}-{slug}', change: '{type}/{id}-{slug}' },
    };

    ensureDir(PATHS.stateDir);
    ensureDir(path.join(STATE_DIR, 'srs'));
    ensureDir(path.join(STATE_DIR, 'snapshots'));
    ensureDir(path.join(STATE_DIR, 'specs'));
    ensureDir(path.join(STATE_DIR, 'changes'));
    ensureDir(path.join(STATE_DIR, 'bugs'));

    const created = [];
    const alreadyExisted = [];
    let verifyAction = 'seeded';

    // --- config.json ---
    if (fs.existsSync(PATHS.config)) {
      alreadyExisted.push(PATHS.config);
      // Idempotency: do NOT overwrite existing verify / branching blocks; patch in only what's missing.
      const existingCfg = readJsonSafe(PATHS.config, {});
      let dirty = false;
      if (existingCfg.verify) {
        verifyAction = 'already_exists';
      } else {
        existingCfg.verify = verifyPreset;
        verifyAction = 'patched_into_existing';
        dirty = true;
      }
      if (!existingCfg.branching) {
        existingCfg.branching = BRANCHING_DEFAULT;
        dirty = true;
      }
      if (!existingCfg.language) {
        existingCfg.language = language;
        dirty = true;
      }
      if (!existingCfg.phase) {
        existingCfg.phase = { confirmTasks: true, taskNotes: false, codeReview: 'off' };
        dirty = true;
      } else {
        if (existingCfg.phase.taskNotes === undefined) {
          // Back-fill the key so it is DISCOVERABLE in the file (a user who wants
          // per-task AI history has to know it exists). Value stays false — the
          // reader treats absent as false anyway, so this never changes behaviour.
          existingCfg.phase.taskNotes = false;
          dirty = true;
        }
        if (existingCfg.phase.codeReview === undefined) {
          // Same reason: the pre-ship review gate is opt-in and configurable, so
          // the key must be visible. "off" is what the reader assumes when the
          // key is absent, so back-filling it changes nothing.
          existingCfg.phase.codeReview = 'off';
          dirty = true;
        }
      }
      if (!existingCfg.models) {
        existingCfg.models = { sdAuthor: null, hybridExecutor: 'sonnet', codeReviewer: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } };
        dirty = true;
      } else {
        if (!existingCfg.models.taskmaster) {
          existingCfg.models.taskmaster = { main: 'sonnet', research: 'sonnet' };
          dirty = true;
        }
        if (existingCfg.models.codeReviewer === undefined) {
          existingCfg.models.codeReviewer = 'sonnet';
          dirty = true;
        }
      }
      if (repos && !existingCfg.repos) {
        existingCfg.repos = repos;
        dirty = true;
      }
      if (dirty) {
        try {
          fs.writeFileSync(PATHS.config, JSON.stringify(existingCfg, null, 2) + '\n');
        } catch (e) { return err(`WRITE_FAILED (config.json patch): ${e.message}`); }
      }
    } else {
      const config = {
        project: projectName,
        stack,
        designTypeDefault,
        language,
        smokeTag: 'smoke',
        regressionTag: 'regression',
        mode: 'adaptive',
        conventions: {
          frPrefix: 'FR-',
          tcPrefix: 'TC-',
          errorCodePrefix: 'ERR_',
          // Opt-in: a regex (string) the project's error codes must match. When set,
          // trace-build warns on any §12.2 code that violates it (enforces the
          // project's standard pattern). null = no enforcement. Examples:
          //   "^ERR_[A-Z]+_[A-Z]+_\\d{3}$"  |  "^[a-z]+(\\.[a-z]+)+$"  |  "^[A-Z]+-\\d{4}$"
          errorCodePattern: null,
        },
        verify: verifyPreset,
        branching: BRANCHING_DEFAULT,
        ...(repos ? { repos } : {}),
        // phase.confirmTasks: after Step 0 seeds the task list, /sf:phase pauses for a
        // one-time human review of the breakdown before implementing (parse-prd is an
        // AI op, not deterministic — "approve SD" does not cover the task list). Set
        // false to auto-implement straight through.
        // phase.taskNotes: `update-task --append` in the /sf:phase per-task loop is
        // ONE AI subprocess per task (measured 13.2 tasks/feature) and produces only
        // human-readable history — the durable record is trace-link + the TM status.
        // Off by default; set true if you want that narrative log back.
        // phase.codeReview: the OPTIONAL pre-ship code review. An independent
        // sub-agent reviews the feature's diff right before the ship step and writes
        // specs/<feature>/CODE-REVIEW.md. Opt-in, three states: "off" (default —
        // never runs, never asks), "ask" (/sf:phase asks yes/no before shipping),
        // "always" (run it every ship, no prompt).
        phase: { confirmTasks: true, taskNotes: false, codeReview: 'off' },
        // models: per-agent override for the Agent tool's `model` param, read by the
        // orchestrating commands (/sf:phase for hybridExecutor + codeReviewer,
        // /sf:ingest + /sf:resync for sdAuthor) at spawn time. null/absent = inherit the main session's model
        // (the agent's own frontmatter `model:` is just its packaged default).
        // taskmaster: model IDs for Task Master CLI AI-ops (main/research roles only —
        // no fallback key, per FR-011). Values mirror TM built-in defaults; change to
        // override the model Task Master uses for parse-prd / expand / etc.
        // codeReviewer: the model for the pre-ship review sub-agent. Deliberately a
        // cheaper model than the executor's ceiling — the review is a second pass
        // over a bounded diff, and it runs on EVERY ship when codeReview is on.
        models: { sdAuthor: null, hybridExecutor: 'sonnet', codeReviewer: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } },
        createdAt: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(PATHS.config, JSON.stringify(config, null, 2) + '\n');
        created.push(PATHS.config);
      } catch (e) { return err(`WRITE_FAILED (config.json): ${e.message}`); }
    }

    // --- project-author.md ---
    if (fs.existsSync(PATHS.projectAuthor)) {
      alreadyExisted.push(PATHS.projectAuthor);
    } else {
      const stackLine = stack !== 'unknown' ? `- Stack: **${stack}**` : '- Stack: (not set — update config.json → stack)';
      const authorMd = [
        '# Project SD-authoring overrides',
        '',
        '> This file is committed with the project. It is read by the sd-author agent at the',
        '> start of every run, on top of the base agent prompt. Add team-specific rules here.',
        '> Append learned rules via: `node flow-tools.cjs learn --note "<rule>" [--category writing|always|pitfall]`',
        '',
        '## Stack & conventions',
        '',
        stackLine,
        '- FR prefix: FR-  · TC prefix: TC-  · Error code prefix: ERR_',
        '',
        '## Always include (per team)',
        '',
        '<!-- List sections/fields your team always wants in every SD, e.g.:',
        '- Always include audit_log section in §7 DB Design',
        '- Always add X-Request-Id header in API endpoints',
        '-->',
        '',
        '## Known pitfalls',
        '',
        '<!-- Document recurring mistakes or things sd-author tends to get wrong for this project: -->',
        '',
        '## Code Rules',
        '',
        '> Judgment rules go here, one bullet each. When a task touches code a bullet',
        '> covers, the executor must report pass / n/a / violated for it in the task',
        '> summary, and the pre-ship reviewer treats any violated bullet as a blocking',
        '> finding — not a style nitpick.',
        '>',
        '> Rules a machine CAN check (a forbidden pattern, or "file has A => needs B")',
        '> belong in `config.verify.rules` instead, so verify-code enforces them on',
        '> every new/changed line automatically. Example entry:',
        '> <!-- {"id": "no-fixme-comments", "message": "Resolve FIXME before merge, do not commit it", "forbid": "FIXME", "glob": "**/*.java"} -->',
        '',
        '<!-- One bullet per judgment rule, e.g.:',
        '- Controllers return @ResponseStatus, never wrap the body in ResponseEntity',
        '-->',
        '',
        '## Code review checklist (project-owned)',
        '',
        '> Generic checklist — add or remove items to match your team\'s standards.',
        '> Stack-specific anti-patterns belong in config.verify.forbiddenPatterns, not hardcoded here.',
        '',
        '- [ ] No secrets or credentials committed (passwords, tokens, API keys)',
        '- [ ] Errors handled, not swallowed (no silent catch blocks without logging)',
        '- [ ] No debug or forbidden patterns (see `config.verify.forbiddenPatterns`)',
        '- [ ] Tests cover the acceptance criteria (§5.1 FR / §13.2 TC in SD)',
        '- [ ] Public interfaces documented (method/API contract matches SD)',
        '',
        '> Add YOUR stack\'s anti-patterns here',
        '> (e.g. Java: no .block() in reactive code; Node: no console.log in prod; Python: no pdb.set_trace() committed).',
        '',
        '## Learned rules (appended by spec-flow learn)',
        '',
        '<!-- Rules below are appended automatically via: flow-tools.cjs learn --note "..." -->',
        '',
      ].join('\n');
      try {
        fs.writeFileSync(PATHS.projectAuthor, authorMd);
        created.push(PATHS.projectAuthor);
      } catch (e) { return err(`WRITE_FAILED (project-author.md): ${e.message}`); }
    }

    // --- commit policy ---
    // DEFAULT: commit the whole .spec-flow/ (profile + state = audit trail). Nothing
    // is ignored. OPT-OUT: --no-commit-docs adds `.spec-flow/` to the PROJECT .gitignore
    // so it stays local.
    let commitPolicy;
    let next;
    if (args['no-commit-docs']) {
      const giPath = path.join(process.cwd(), '.gitignore');
      let gi = '';
      try { gi = fs.readFileSync(giPath, 'utf8'); } catch {}
      if (!/^\.spec-flow\/?\s*$/m.test(gi)) {
        const add = (gi && !gi.endsWith('\n') ? '\n' : '') + '\n# spec-flow — kept local (--no-commit-docs)\n.spec-flow/\n';
        try { fs.writeFileSync(giPath, gi + add); } catch (e) { return err(`WRITE_FAILED (.gitignore): ${e.message}`); }
      }
      commitPolicy = 'no-commit — added .spec-flow/ to project .gitignore (kept local)';
      next = '.spec-flow/ is git-ignored for this project. Nothing to commit.';
    } else {
      commitPolicy = 'commit-all (default) — .spec-flow/ is tracked (profile + state)';
      next = 'git add .spec-flow/ && git commit -m "chore: init spec-flow profile"';
    }

    return ok({
      created,
      alreadyExisted,
      verifyPreset: { stack, action: verifyAction, preset: verifyPreset },
      commitPolicy,
      next,
    });
  },

  // -----------------------------------------------------------------------
  // learn  --note "<rule>"  [--category writing|always|pitfall]
  //
  // Evolve write-back: appends a timestamped rule under the matching section
  // of .spec-flow/project-author.md. Bootstraps the file via init-project
  // semantics if missing.
  // Returns ok({ appended, file }).
  // -----------------------------------------------------------------------
  learn(args) {
    const note = args.note;
    if (!note) return err('MISSING_ARG: --note "<rule to learn>"');

    const VALID_CATEGORIES = ['writing', 'always', 'pitfall', 'learned'];
    const rawCat = (args.category || 'learned').toLowerCase();
    const category = VALID_CATEGORIES.includes(rawCat) ? rawCat : 'learned';

    // Bootstrap project-author.md if missing
    if (!fs.existsSync(PATHS.projectAuthor)) {
      const bootstrapResult = commands['init-project']({});
      if (!bootstrapResult.ok) return bootstrapResult;
    }

    let content;
    try { content = fs.readFileSync(PATHS.projectAuthor, 'utf8'); }
    catch (e) { return err(`READ_FAILED: ${e.message}`); }

    // Map category to the section header in project-author.md
    const SECTION_MAP = {
      writing: '## Stack & conventions',
      always: '## Always include (per team)',
      pitfall: '## Known pitfalls',
      learned: '## Learned rules (appended by spec-flow learn)',
    };
    const targetSection = SECTION_MAP[category];

    const timestamp = new Date().toISOString();
    const entry = `- [${timestamp}] ${note}`;

    // Find the section and append the entry after it (before the next ## or end of file)
    const lines = content.split('\n');
    const sectionIdx = lines.findIndex(l => l.trim() === targetSection.trim());

    if (sectionIdx === -1) {
      // Section not found — append at end with a new section header
      const appended = `\n${targetSection}\n\n${entry}\n`;
      try {
        fs.appendFileSync(PATHS.projectAuthor, appended);
      } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    } else {
      // Find the end of this section (next ## heading or EOF)
      let insertAt = lines.length;
      for (let i = sectionIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) { insertAt = i; break; }
      }
      // Back up past trailing blank lines so entry appears flush with section content
      while (insertAt > sectionIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
      // Insert entry followed by a blank line before the next section
      lines.splice(insertAt, 0, entry, '');
      try {
        fs.writeFileSync(PATHS.projectAuthor, lines.join('\n'));
      } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    }

    return ok({ appended: entry, file: PATHS.projectAuthor });
  },

  // -----------------------------------------------------------------------
  // doctor  [--sd <SD.md>] [--feature <f>]
  // Health-check: env + plugin files + install state + project state + SD/trace consistency.
  // ALWAYS returns ok({ checks, summary }) — never err (a doctor reports, not fails).
  // status ∈ "ok"|"warn"|"fail"
  // -----------------------------------------------------------------------
  doctor(args) {
    const os = require('os');
    const checks = [];

    const push = (name, status, detail, fix) => checks.push({ name, status, detail, fix: fix || null });

    // a. Node runtime
    push('node-runtime', 'ok', `Node.js ${process.version}`, null);

    // c. Plugin files — templates/sd-template.md + skills/manual-test/scripts/run-checklist.sh
    const sdTpl = path.join(PLUGIN_ROOT, 'templates', 'sd-template.md');
    const runChecklist = path.join(PLUGIN_ROOT, 'skills', 'manual-test', 'scripts', 'run-checklist.sh');
    if (!fs.existsSync(sdTpl)) {
      push('plugin-file:sd-template.md', 'fail', `Missing: ${sdTpl}`, 'reinstall spec-flow plugin — file should be at spec-flow/templates/sd-template.md');
    } else {
      push('plugin-file:sd-template.md', 'ok', sdTpl, null);
    }
    if (!fs.existsSync(runChecklist)) {
      push('plugin-file:run-checklist.sh', 'fail', `Missing: ${runChecklist}`, 'reinstall spec-flow plugin — file should be at spec-flow/skills/manual-test/scripts/run-checklist.sh');
    } else {
      push('plugin-file:run-checklist.sh', 'ok', runChecklist, null);
    }

    // c2. Version sync — .claude-plugin/plugin.json vs .claude-plugin/marketplace.json.
    // These are two hand-edited files that must move together on every release,
    // and nothing was checking that they did: this repo shipped 18 consecutive
    // tags (v0.5.8 through v0.8.1) whose marketplace metadata still read 0.5.5
    // while plugin.json had reached 0.8.1, so the marketplace advertised a
    // version nobody was running. Same shape as the currentTag drift check:
    // compare the two real sources rather than trusting that a manual step ran.
    {
      const pj = readJsonSafe(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), null);
      const mj = readJsonSafe(path.join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'), null);
      const v = versionSyncStatus(pj, mj);
      push('version-sync', v.status, v.detail, v.fix);
    }

    // d. Install state — ~/.claude/plugins/installed_plugins.json + known_marketplaces.json
    const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
    const installedPath = path.join(pluginsDir, 'installed_plugins.json');
    const marketplacePath = path.join(pluginsDir, 'known_marketplaces.json');
    const installFix = '/plugin marketplace add <pluginRoot> && /plugin install sf@claude-spec-flow';

    const installedRaw = readJsonSafe(installedPath, null);
    const installedStr = installedRaw ? JSON.stringify(installedRaw) : '';
    if (!installedRaw) {
      push('install:installed_plugins', 'warn', 'installed_plugins.json not found (plugin may not be installed)', installFix);
    } else if (!installedStr.includes('claude-spec-flow')) {
      push('install:installed_plugins', 'warn', 'sf not found in installed_plugins.json', installFix);
    } else {
      push('install:installed_plugins', 'ok', 'sf installed (key sf@claude-spec-flow)', null);
    }

    const marketplaceRaw = readJsonSafe(marketplacePath, null);
    const marketplaceStr = marketplaceRaw ? JSON.stringify(marketplaceRaw) : '';
    if (!marketplaceRaw) {
      push('install:known_marketplaces', 'warn', 'known_marketplaces.json not found', installFix);
    } else if (!marketplaceStr.includes('claude-spec-flow')) {
      push('install:known_marketplaces', 'warn', 'claude-spec-flow marketplace not found in known_marketplaces.json', installFix);
    } else {
      push('install:known_marketplaces', 'ok', 'claude-spec-flow marketplace registered', null);
    }

    // d2. Source drift — a plugin installed from a LOCAL DIRECTORY marketplace runs
    // from a version-keyed cache copy, not from the source repo. Between releases the
    // version does not move, so the cache never refreshes and every edit to the source
    // is silently inert: a new engine command answers UNKNOWN_COMMAND and an edited
    // command doc is simply the old one. Nothing else in doctor catches this, and it
    // costs a maintainer a whole debugging session to discover by hand.
    {
      const d = pluginSourceDrift(PLUGIN_ROOT, installedRaw, marketplaceRaw, compareTrees);
      push('plugin-source-sync', d.status, d.detail, d.fix);
    }

    // e. Project init — .spec-flow/config.json
    if (!fs.existsSync(PATHS.config)) {
      push('project-init', 'warn', '.spec-flow/config.json not found — project not initialised', '/sf:init');
    } else {
      const cfg = readJsonSafe(PATHS.config, {});
      push('project-init', 'ok', `.spec-flow/config.json present (project: ${cfg.project || 'unknown'}, stack: ${cfg.stack || 'unknown'})`, null);
      // Branching policy (informational)
      const br = cfg.branching;
      if (br) {
        push('branching', 'ok', `mode: ${br.mode || 'unset'}, base: ${br.base || 'unset'}`, br.mode === 'off' ? 'branching disabled — commits go on current branch' : null);
      } else {
        push('branching', 'warn', 'no branching block in config.json', 're-run /sf:init to seed branching, or add config.branching manually');
      }
    }

    // f. Trace health — assessed against the active feature's DURABLE trace
    // (specs/<feature>/trace.json), not the global mirror. The mirror only reflects
    // the last-built feature, so with concurrent sessions doctor used to grade a
    // feature nobody asked about and report it as "the" trace. The feature name is
    // now in the detail line, and featureSource says whether it was inferred.
    const { feature: docFeature, source: docFeatureSource } = resolveActiveFeature(args.feature);
    if (fs.existsSync(PATHS.trace) || (docFeature && fs.existsSync(traceFileFor(docFeature)))) {
      // D3: doctor reports a link count, and the derived links are no longer
      // persisted — hydrate so the reported figure stays comparable to before.
      const rawDocTrace = readTrace(docFeature);
      const trace = rawDocTrace ? hydrateTrace(docFeature, rawDocTrace) : rawDocTrace;
      const traceScope = docFeature
        ? `feature "${docFeature}"${docFeatureSource === 'mirror' ? ' (inferred from the shared trace.json mirror — pass --feature to be sure)' : ''}`
        : 'active feature';
      if (!trace) {
        push('trace-health', 'warn', 'trace.json exists but is invalid JSON', 'run: node flow-tools.cjs trace-build --sd <SD.md>');
      } else {
        const frCount = (trace.nodes && trace.nodes.fr) ? trace.nodes.fr.length : 0;
        const tcCount = (trace.nodes && trace.nodes.tc) ? trace.nodes.tc.length : 0;
        const linkCount = (trace.links) ? trace.links.length : 0;
        const frTcLinks = (trace.links || []).filter(l => l.type === 'fr-tc');
        const linkedFrIds = new Set(frTcLinks.map(l => l.from));
        const frNodes = (trace.nodes && trace.nodes.fr) ? trace.nodes.fr : [];
        const unlinkedFrCount = frNodes.filter(f => !linkedFrIds.has(f.id)).length;

        const detail = `${traceScope} — FR: ${frCount}, TC: ${tcCount}, links: ${linkCount}`;
        if (unlinkedFrCount > 0) {
          push('trace-health', 'warn', `${detail} — ${unlinkedFrCount} FR without a test case`, 'review SD §13.2 / re-run: node flow-tools.cjs trace-build --sd <SD.md>');
        } else {
          push('trace-health', 'ok', detail, null);
        }
      }
    } else {
      push('trace-health', 'ok', 'trace.json not yet built (no trace-build run yet)', null);
    }

    // g. SD gate — auto-detect the active feature's SD when --sd is omitted, so a
    // project with an unapproved SD is flagged even without an explicit path
    // (transparency: don't report "all ok" while a TODO-laden SD is sitting there).
    let sdPath = args.sd || null;
    if (!sdPath) {
      const feat = docFeature;
      if (feat) {
        const candidate = path.join(STATE_DIR, 'specs', feat, 'SD.md');
        if (fs.existsSync(candidate)) sdPath = candidate;
      }
    }
    if (sdPath) {
      if (!fs.existsSync(sdPath)) {
        push('sd-gate', 'warn', `SD file not found: ${sdPath}`, 'check the path and re-run');
      } else {
        let sdContent = '';
        try { sdContent = fs.readFileSync(sdPath, 'utf8'); } catch {}
        const todoCount = countSdTodos(sdContent);
        if (todoCount > 0) {
          push('sd-gate', 'warn', `SD has ${todoCount} TODO:MANUAL-REVIEW marker(s) — not ready for parse_prd`, 'review SD before running parse_prd (Task Master)');
        } else {
          push('sd-gate', 'ok', `SD has 0 TODO:MANUAL-REVIEW markers — ready for parse_prd`, null);
        }
      }
    }

    // g2. Multi-repo — validate config.repos paths exist and are git repos.
    const doctorCfg = readJsonSafe(PATHS.config, null);
    if (doctorCfg && doctorCfg.repos && typeof doctorCfg.repos === 'object' && Object.keys(doctorCfg.repos).length) {
      for (const rp of resolveRepos(doctorCfg)) {
        const { name, root, rel } = rp;
        if (!fs.existsSync(root)) {
          push('repos', 'warn', `config.repos["${name}"] → ${rel} does not exist`, 'fix the relative path in config.json or remove the entry');
          continue;
        }
        if (!fs.existsSync(path.join(root, '.git'))) {
          push('repos', 'warn', `config.repos["${name}"] → ${rel} is not a git repo`, 'point it at a git working tree (branch-ensure/commit operate per repo)');
          continue;
        }
        // Build-tool fit. config.verify is a project-wide singleton, so a repo on a
        // different build tool used to fail the verify gate for a reason that had
        // nothing to do with its code. Say it here instead of at gate time.
        const eff = resolveRepoVerify(doctorCfg, rp);
        if (eff.note && eff.detected) {
          push('repos', 'warn', `config.repos["${name}"] → ${rel} OK, but ${eff.note}`,
            `pin it: config.repos["${name}"] = { "path": "${rel}", "stack": "${eff.stack}", "verify": { "testCommand": "${eff.verify.testCommand}" } }`);
        } else if (eff.note) {
          push('repos', 'warn', `config.repos["${name}"] → ${rel} OK, but ${eff.note}`,
            `set config.repos["${name}"].verify.testCommand to a command that runs in that repo`);
        } else {
          push('repos', 'ok', `config.repos["${name}"] → ${rel} OK`, null);
        }
      }
    }

    // g2b. Code rules config (FR-011) — validate config.verify.rules (and each
    // config.repos[*].verify.rules override, when a multi-repo config exists) by
    // reusing the SAME validator verify-code calls at gate time (lib/code-rules.cjs
    // validateRules). Doctor never re-implements the schema check — it only narrates
    // the warnings so a bad rule is caught before a real verify-code run silently
    // skips it. Never fails (D4): a malformed rule is a warning here too, exactly
    // like at gate time.
    {
      const describeRuleWarning = (w) => {
        const badRegex = /^RULE_INVALID_REGEX: (.+)$/.exec(w);
        if (badRegex) return `rule "${badRegex[1]}": regex in forbid/when/require does not compile`;
        const invalid = /^RULE_INVALID: (.+)$/.exec(w);
        if (invalid) return `rule "${invalid[1]}": invalid — check for missing id/message, duplicate id, both forbid+when set, when without require, or scope outside "diff"/"all"`;
        return w;
      };
      const checkRulesScope = (rules, scopeLabel) => {
        const { valid, warnings } = validateRules(rules);
        for (const w of warnings) {
          push('code-rules-config', 'warn', `${scopeLabel}: ${describeRuleWarning(w)}`,
            'fix the rule in config.json (see /sf:doctor detail); a malformed rule is skipped, not fatal, until fixed');
        }
        if (valid.length) {
          push('code-rules-config', 'ok', `${scopeLabel}: ${valid.length} rule(s) valid`, null);
        }
      };

      let anyRulesSeen = false;
      const topRules = doctorCfg && doctorCfg.verify && Array.isArray(doctorCfg.verify.rules) ? doctorCfg.verify.rules : null;
      if (topRules && topRules.length) {
        anyRulesSeen = true;
        checkRulesScope(topRules, 'config.verify.rules');
      }
      if (doctorCfg && doctorCfg.repos && typeof doctorCfg.repos === 'object') {
        for (const [name, val] of Object.entries(doctorCfg.repos)) {
          const repoRules = val && typeof val === 'object' && val.verify && Array.isArray(val.verify.rules) ? val.verify.rules : null;
          if (repoRules && repoRules.length) {
            anyRulesSeen = true;
            checkRulesScope(repoRules, `config.repos["${name}"].verify.rules`);
          }
        }
      }
      if (!anyRulesSeen) {
        push('code-rules-config', 'ok',
          'no config.verify.rules configured — add entries there for machine-checkable conventions (regex-forbid or when/require) that should block automatically on new/changed code; judgment rules go in project-author.md ## Code Rules instead',
          null);
      }
    }

    // g3. currentTag drift (W3) — Task Master MCP state ops bind to the global
    // currentTag; if it points at another feature, state ops silently hit the wrong
    // tag. Compare the REAL currentTag out of .taskmaster/state.json against the
    // active feature. The prior heuristic never opened state.json — it guessed from
    // the tasks.json key list, so it reported "aligned" for any feature not yet
    // seeded (the entire ingest→phase window, when doctor is run most) and nagged
    // whenever a second tag merely existed even with currentTag already correct.
    {
      const activeFeat = docFeature;
      const tmDir = path.join(process.cwd(), '.taskmaster');
      // A SHIPPED feature is not drifted — it is finished. currentTag pointing
      // elsewhere is the correct end state once work has moved on, so nagging to
      // `use-tag` it back is noise that trains the reader to ignore this check.
      // (The hazard this check exists for is state ops landing on the wrong tag
      // mid-implementation; a shipped feature has no state ops left to land.)
      const activeShipped = activeFeat ? readJsonSafe(shipFileFor(activeFeat), null) : null;
      if (activeFeat && activeShipped) {
        push('current-tag', 'ok', `active feature "${activeFeat}" shipped ${String(activeShipped.shippedAt || '').slice(0, 10)} — currentTag drift is not meaningful for a finished feature`, null);
      } else if (activeFeat && fs.existsSync(tmDir)) {
        const currentTag = taskCore._getCurrentTag();
        const fix = `run \`task-master use-tag ${activeFeat}\` so MCP state ops (next_task/set_task_status) bind to this feature's tag`;
        if (!currentTag) {
          push('current-tag', 'warn', `no currentTag set in .taskmaster/state.json; active feature is "${activeFeat}"`, fix);
        } else if (currentTag !== activeFeat) {
          push('current-tag', 'warn', `currentTag drift: .taskmaster/state.json points at "${currentTag}" but the active feature is "${activeFeat}"`, fix);
        } else {
          push('current-tag', 'ok', `currentTag matches active feature "${activeFeat}"`, null);
        }
      }
    }

    // i. dep-lock — the task engine is driven entirely through its CLI; the plugin
    // declares no MCP server at all. So this verifies the CLI entry points exist and
    // that no .mcp.json has reappeared at the plugin root to re-expose an MCP surface.
    const mcpJsonPath = path.join(PLUGIN_ROOT, '.mcp.json');
    try {
      const missingBins = ['bin/flow-tools.cjs', 'bin/task-master']
        .filter(rel => !fs.existsSync(path.join(PLUGIN_ROOT, rel)));
      if (missingBins.length) {
        push('dep-lock', 'fail', `task engine CLI missing: ${missingBins.join(', ')}`, 'Reinstall the plugin — the bundled CLI is the only task engine');
      } else if (fs.existsSync(mcpJsonPath)) {
        const mcpRaw = readJsonSafe(mcpJsonPath, null);
        const servers = (mcpRaw && mcpRaw.mcpServers) || {};
        if (Object.keys(servers).length) {
          push('dep-lock', 'warn', `plugin-root .mcp.json declares ${Object.keys(servers).join(', ')} — the plugin ships no MCP server; this re-exposes a surface the commands no longer use`, 'Delete .mcp.json at the plugin root; every task op has a flow-tools CLI twin (task-add / task-get / task-list / task-set-status / task-next)');
        } else {
          push('dep-lock', 'ok', 'native task engine via CLI (no MCP binding declared)', null);
        }
      } else {
        push('dep-lock', 'ok', 'native task engine via CLI, zero-dependency (no MCP binding declared)', null);
      }
    } catch (e) {
      push('dep-lock', 'warn', `dep-lock check error: ${e && e.message ? e.message : String(e)}`, null);
    }

    // i2. mcp-shadow — the plugin no longer declares an MCP server, so a project-level
    // .mcp.json entry named "task-master-ai" is not shadowing anything of ours: it binds
    // a separate, unrelated server (typically `npx task-master-ai`, often
    // TASK_MASTER_TOOLS=core) that writes the same .taskmaster/ files from a different
    // implementation. Left in place it is a second writer and a stale surface.
    {
      const projectMcpPath = path.join(process.cwd(), '.mcp.json');
      try {
        if (fs.existsSync(projectMcpPath) && path.resolve(projectMcpPath) !== path.resolve(mcpJsonPath)) {
          const projRaw = readJsonSafe(projectMcpPath, null);
          const projEntry = (projRaw && projRaw.mcpServers && projRaw.mcpServers['task-master-ai']) || null;
          if (!projEntry) {
            push('mcp-shadow', 'ok', 'project .mcp.json does not override the bundled task engine', null);
          } else {
            const projArgs = (projEntry.args || []).map(String);
            const tier = (projEntry.env && projEntry.env.TASK_MASTER_TOOLS) || 'core (default)';
            push(
              'mcp-shadow',
              'warn',
              `project .mcp.json still declares "task-master-ai" (${projEntry.command} ${projArgs.join(' ')}, tier=${tier}) — spec-flow ships no MCP server, so this binds a separate implementation writing the same .taskmaster/ files`,
              'Remove the "task-master-ai" entry from the project .mcp.json; every task op the commands use has a flow-tools CLI twin (task-add / task-set-status / task-next / task-list / task-get)'
            );
          }
        }
      } catch (e) {
        push('mcp-shadow', 'warn', `mcp-shadow check error: ${e && e.message ? e.message : String(e)}`, null);
      }
    }

    // h. Tasks — .taskmaster/tasks/tasks.json (info only)
    const tasksPath = path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
    if (fs.existsSync(tasksPath)) {
      const taskCount = readTmTasks(readJsonSafe(tasksPath, null)).length;
      push('tasks', 'ok', `.taskmaster/tasks/tasks.json present (${taskCount} tasks)`, null);
    } else {
      push('tasks', 'ok', '.taskmaster/tasks/tasks.json not found (run parse_prd after SD approval)', null);
    }

    // k. Verification integrity — a 'passed' VERIFICATION must NOT coexist with an
    // unfilled CHECKLIST (TODO verify-blocks). The run path is gated (run-checklist
    // calls lint-checklist, which refuses TODOs), but a hand-set 'passed' would slip;
    // this detects that bypass.
    const verifFeat = docFeature;
    const verifPath = verifFeat ? path.join(process.cwd(), PATHS.specs, verifFeat, 'VERIFICATION.md') : null;
    if (verifPath && fs.existsSync(verifPath)) {
      let verif = ''; try { verif = fs.readFileSync(verifPath, 'utf8'); } catch {}
      const passed = /status:\s*passed/i.test(verif);
      if (passed) {
        const feat = verifFeat;
        let todoCount = null;
        if (feat) {
          const clPath = path.join(process.cwd(), PATHS.specs, feat, 'CHECKLIST.yaml');
          if (fs.existsSync(clPath)) {
            // Strip full-line YAML comments first. A checklist may legitimately
            // DOCUMENT why its scaffold was not filled (e.g. a non-HTTP feature whose
            // tests are all no-verify), and counting the word in that prose failed the
            // gate for writing about the problem. lint-checklist and checklist-status
            // already ignore comments; this is the one counter that did not.
            try {
              const body = fs.readFileSync(clPath, 'utf8')
                .split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
              todoCount = (body.match(/\bTODO\b/g) || []).length;
            } catch {}
          }
        }
        if (todoCount > 0) {
          push('verify-integrity', 'fail', `VERIFICATION=passed but CHECKLIST has ${todoCount} unfilled TODO — manual-test gate was bypassed`, 'fill the verify blocks + re-run scripts/run-checklist.sh; never hand-set VERIFICATION status (it must come from the run-checklist → checklist-to-verification hook)');
        } else {
          push('verify-integrity', 'ok', todoCount === null ? 'VERIFICATION=passed (CHECKLIST not found to cross-check)' : 'VERIFICATION=passed, CHECKLIST 0 TODO', null);
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Check 1 (FR-029): Legacy epic files — single .md file in .spec-flow/epics/
    // ---------------------------------------------------------------------------
    try {
      const epicsAbsDir = path.join(process.cwd(), STATE_DIR, 'epics');
      if (fs.existsSync(epicsAbsDir)) {
        for (const entry of fs.readdirSync(epicsAbsDir)) {
          const entryPath = path.join(epicsAbsDir, entry);
          if (entry.endsWith('.md') && fs.statSync(entryPath).isFile()) {
            const slug = entry.slice(0, -3);
            push(
              `epic-legacy-${slug}`,
              'warn',
              `legacy epic '${slug}' is a single-file epic (.spec-flow/epics/${entry}); consider converting to a directory workspace: mkdir .spec-flow/epics/${slug}/ && mv .spec-flow/epics/${entry} .spec-flow/epics/${slug}/EPIC.md`,
              null
            );
          }
        }
      }
    } catch (e) {
      push('epic-legacy-check', 'warn', `epic legacy file check error: ${e && e.message ? e.message : String(e)}`, null);
    }

    // ---------------------------------------------------------------------------
    // Check 2 (FR-030): Stale epic links — EPIC.md sub-feature listings and reverse EPIC files
    // ---------------------------------------------------------------------------
    try {
      const epicsAbsDir = path.join(process.cwd(), STATE_DIR, 'epics');
      const specsAbsDir = path.join(process.cwd(), STATE_DIR, 'specs');

      // 2a: For each directory epic with EPIC.md, check its sub-feature listings
      if (fs.existsSync(epicsAbsDir)) {
        for (const entry of fs.readdirSync(epicsAbsDir)) {
          const epicDirPath = path.join(epicsAbsDir, entry);
          if (!fs.statSync(epicDirPath).isDirectory()) continue;
          const epicMdPath = path.join(epicDirPath, 'EPIC.md');
          if (!fs.existsSync(epicMdPath)) continue;
          const epicContent = fs.readFileSync(epicMdPath, 'utf8');
          const subsMatch = epicContent.match(/## Sub-features([\s\S]*?)(?=##|$)/);
          const subSlugs = [];
          if (subsMatch) {
            const subSection = subsMatch[1];
            for (const line of subSection.split('\n')) {
              const m = line.match(/^- (.+)$/);
              if (m && !m[1].startsWith('*')) subSlugs.push(m[1].trim());
            }
          }
          for (const sub of subSlugs) {
            const subSpecDir = path.join(specsAbsDir, sub);
            if (!fs.existsSync(subSpecDir)) {
              push(
                `epic-stale-listing:${entry}/${sub}`,
                'warn',
                `epic '${entry}' lists '${sub}' but .spec-flow/specs/${sub}/ does not exist — stale sub-feature listing`,
                null
              );
            }
          }
        }
      }

      // 2b: For each feature in specs/, check its EPIC reverse link
      if (fs.existsSync(specsAbsDir)) {
        for (const feat of fs.readdirSync(specsAbsDir)) {
          const featPath = path.join(specsAbsDir, feat);
          if (!fs.statSync(featPath).isDirectory()) continue;
          const epicLinkFile = path.join(featPath, 'EPIC');
          if (!fs.existsSync(epicLinkFile)) continue;
          const epicSlug = fs.readFileSync(epicLinkFile, 'utf8').trim();
          if (!epicSlug) continue;
          const epicDirExists = fs.existsSync(path.join(epicsAbsDir, epicSlug)) &&
            fs.statSync(path.join(epicsAbsDir, epicSlug)).isDirectory();
          const epicMdExists = fs.existsSync(path.join(epicsAbsDir, `${epicSlug}.md`));
          if (!epicDirExists && !epicMdExists) {
            push(
              `epic-stale-reverse:${feat}`,
              'warn',
              `specs/${feat}/EPIC points to '${epicSlug}' but no such epic exists — stale reverse link`,
              null
            );
          }
        }
      }
    } catch (e) {
      push('epic-stale-check', 'warn', `epic stale link check error: ${e && e.message ? e.message : String(e)}`, null);
    }

    // ---------------------------------------------------------------------------
    // Check 3 (FR-031, FR-032): Sensitive files in .spec-flow/epics/ directories
    // ---------------------------------------------------------------------------
    try {
      const { spawnSync } = require('child_process');
      const epicsAbsDir = path.join(process.cwd(), STATE_DIR, 'epics');
      const sensitiveNamePattern = /priv(ate)?[_-]?key|secret|credential|password|token/i;
      const sensitiveExtPattern = /\.(pem|key|p12|pfx|env)$/i;

      const scanEpicsForSecrets = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir)) {
          const entryPath = path.join(dir, entry);
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            scanEpicsForSecrets(entryPath);
          } else if (stat.isFile()) {
            const name = path.basename(entry);
            if (!sensitiveNamePattern.test(name) && !sensitiveExtPattern.test(name)) continue;
            const result = spawnSync('git', ['check-ignore', '--quiet', entryPath], { cwd: process.cwd() });
            if (result.error && result.error.code === 'ENOENT') {
              push('epic-secret-check', 'warn', 'git not found in PATH — sensitive filename check in .spec-flow/epics/ was skipped', null);
              return; // stop scanning
            }
            if (result.status !== 0) {
              // not ignored by git → warn
              const relPath = path.relative(path.join(process.cwd(), STATE_DIR, 'epics'), entryPath);
              push(
                `epic-secret:${relPath}`,
                'warn',
                `epics/${relPath} matches a sensitive filename pattern and is not git-ignored — it may be accidentally committed; add it to .gitignore`,
                null
              );
            }
            // status === 0 → ignored, skip
          }
        }
      };

      // Test for git availability before scanning
      const gitCheck = spawnSync('git', ['--version'], { cwd: process.cwd() });
      if (gitCheck.error && gitCheck.error.code === 'ENOENT') {
        push('epic-secret-check', 'warn', 'git not found in PATH — sensitive filename check in .spec-flow/epics/ was skipped', null);
      } else {
        scanEpicsForSecrets(epicsAbsDir);
      }
    } catch (e) {
      push('epic-secret-check', 'warn', `epic sensitive file check error: ${e && e.message ? e.message : String(e)}`, null);
    }

    // j. Backlog priority hygiene — WARN only, never FAIL (FR-025, SD §10.7,
    // TC-019): flag every item whose priority is 'unset' (a legacy file with no
    // priority line, or a marker record without one), each with the backlog-set
    // command that fixes it. A legacy file that already carries a valid priority
    // is NOT flagged: it lists correctly, and warning about it would recommend a
    // fix the user has already applied, forever. A
    // missing backlog dir, or one with nothing to flag, is a single 'ok' —
    // a stale priority is a hygiene nag, not a broken state.
    {
      const backlogDir = path.join(PATHS.stateDir, 'backlog');
      if (!fs.existsSync(backlogDir)) {
        push('backlog-priority', 'ok', '.spec-flow/backlog/ not found (no backlog items yet)', null);
      } else {
        const flagged = backlog.readRecords(backlogDir).filter(it => it.priority === 'unset');
        if (!flagged.length) {
          push('backlog-priority', 'ok', 'every backlog item has a priority', null);
        } else {
          for (const it of flagged) {
            const reason = it.legacy ? 'legacy file with no priority' : "priority: 'unset'";
            push(
              'backlog-priority',
              'warn',
              `${path.basename(it.path)} (${it.id}) — ${reason}`,
              `node \${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs backlog-set --id ${it.id} --priority <high|medium|low>`
            );
          }
        }
      }
    }

    // Summary
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;

    return ok({ checks, summary });
  },
};
