/**
 * maintenance.cjs — static, non-workflow commands: setup + health + meta.
 * init, init-project, learn, doctor. (Workflow commands live in bin/flow-tools.cjs.)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  STATE_DIR, PATHS, PLUGIN_ROOT, STATE_FILE, SKIP_SCAN_DIRS, ok, err, parseArgs, readJsonSafe, traceFileFor, readTrace, ensureDir, slugify, pad3, readTmTasks, fileLinksPathFor, resolveRepos, parseReposArg, langPack, kwRe, cleanHeading, parseHeadings, bodyOf, classifyHeading, findHeading, findTableByHeader, parseFirstTable, parseAllTables, splitRow, parseUserStories, trimOrNull, extractBulletsAfter, inferDesignType, parseSrs, TODO, countSdTodos, moscowFor, genSd, readSdTables, scoreComplexity, routeFor, tcIdsForReq, resolveTemplate
} = require('./core.cjs');

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
        existingCfg.phase = { confirmTasks: true };
        dirty = true;
      }
      if (!existingCfg.models) {
        existingCfg.models = { sdAuthor: null, hybridExecutor: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } };
        dirty = true;
      } else if (!existingCfg.models.taskmaster) {
        existingCfg.models.taskmaster = { main: 'sonnet', research: 'sonnet' };
        dirty = true;
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
        phase: { confirmTasks: true },
        // models: per-agent override for the Agent tool's `model` param, read by the
        // orchestrating commands (/sf:phase for hybridExecutor, /sf:ingest + /sf:resync
        // for sdAuthor) at spawn time. null/absent = inherit the main session's model
        // (the agent's own frontmatter `model:` is just its packaged default).
        // taskmaster: model IDs for Task Master CLI AI-ops (main/research roles only —
        // no fallback key, per FR-011). Values mirror TM built-in defaults; change to
        // override the model Task Master uses for parse-prd / expand / etc.
        models: { sdAuthor: null, hybridExecutor: 'sonnet', taskmaster: { main: 'sonnet', research: 'sonnet' } },
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

    // f. Trace health
    if (fs.existsSync(PATHS.trace)) {
      const trace = readJsonSafe(PATHS.trace, null);
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

        const detail = `FR: ${frCount}, TC: ${tcCount}, links: ${linkCount}`;
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
      const tr = readJsonSafe(PATHS.trace, null);
      const feat = args.feature || (tr && tr.feature) || null;
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
      for (const [name, rel] of Object.entries(doctorCfg.repos)) {
        const root = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), String(rel));
        if (!fs.existsSync(root)) {
          push('repos', 'warn', `config.repos["${name}"] → ${rel} does not exist`, 'fix the relative path in config.json or remove the entry');
        } else if (!fs.existsSync(path.join(root, '.git'))) {
          push('repos', 'warn', `config.repos["${name}"] → ${rel} is not a git repo`, 'point it at a git working tree (branch-ensure/commit operate per repo)');
        } else {
          push('repos', 'ok', `config.repos["${name}"] → ${rel} OK`, null);
        }
      }
    }

    // g3. currentTag drift (W3) — Task Master MCP state ops bind to the global
    // currentTag; if it points at another feature, state ops silently hit the wrong tag.
    {
      const tr = readJsonSafe(PATHS.trace, null);
      const activeFeat = args.feature || (tr && tr.feature) || null;
      const tmTasksPath = path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
      if (activeFeat && fs.existsSync(tmTasksPath)) {
        const tmRaw = readJsonSafe(tmTasksPath, null);
        const tags = tmRaw && typeof tmRaw === 'object' && !Array.isArray(tmRaw) ? Object.keys(tmRaw) : [];
        // currentTag is stored in TM state, not tasks.json; best-effort: if the active
        // feature has its own tag but it's not the only one, remind to `use-tag`.
        if (tags.includes(activeFeat) && tags.length > 1) {
          push('current-tag', 'warn', `multiple TM tags present (${tags.join(', ')}); active feature is "${activeFeat}"`, `run \`task-master use-tag ${activeFeat}\` so MCP state ops (next_task/set_task_status) bind to this feature's tag`);
        } else {
          push('current-tag', 'ok', `TM tag aligned for "${activeFeat}"`, null);
        }
      }
    }

    // i. dep-lock — verify the task engine MCP entry in .mcp.json is the native
    // bundled server (bin/mcp-server.js), or, on a rollback-flipped project, that
    // the legacy task-master-ai entry is still version-pinned (not floating @latest).
    const mcpJsonPath = path.join(PLUGIN_ROOT, '.mcp.json');
    try {
      if (!fs.existsSync(mcpJsonPath)) {
        push('dep-lock', 'warn', '.mcp.json not found — cannot verify task engine binding', 'Ensure .mcp.json exists at the plugin root');
      } else {
        const mcpRaw = readJsonSafe(mcpJsonPath, null);
        const tmEntry = (mcpRaw && mcpRaw.mcpServers && mcpRaw.mcpServers['task-master-ai']) || null;
        const tmArgs = (tmEntry && tmEntry.args) || [];
        if (tmEntry && tmEntry.command === 'node') {
          push('dep-lock', 'ok', 'native task engine bound in .mcp.json (bin/mcp-server.js, zero-dependency)', null);
        } else {
          const tmArg = tmArgs.find(a => String(a).startsWith('task-master-ai'));
          if (!tmArg) {
            push('dep-lock', 'warn', 'no native or task-master-ai entry found in .mcp.json', 'Restore the native entry, or run scripts/rollback.cjs --confirm for the legacy fallback');
          } else {
            const versionMatch = String(tmArg).match(/^task-master-ai@(.+)$/);
            if (versionMatch) {
              push('dep-lock', 'ok', `legacy engine pinned to ${versionMatch[1]} in .mcp.json (rollback state)`, null);
            } else {
              push('dep-lock', 'warn', 'legacy task-master-ai not version-pinned in .mcp.json — floating @latest risks breakage; pin to a tested version (e.g. task-master-ai@0.43.1)', 'Edit .mcp.json: change "task-master-ai" to "task-master-ai@<version>"');
            }
          }
        }
      }
    } catch (e) {
      push('dep-lock', 'warn', `dep-lock check error: ${e && e.message ? e.message : String(e)}`, null);
    }

    // i2. mcp-shadow — a project-level .mcp.json entry named "task-master-ai" wins over
    // the plugin's bundled native server. A stale legacy entry (npx task-master-ai, often
    // TASK_MASTER_TOOLS=core) then exposes a reduced tool surface with NO add_task, and the
    // commands' MCP state ops silently lose tools. Plugin-root check (i) cannot see this.
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
            const isNative = projEntry.command === 'node' && projArgs.some(a => a.includes('mcp-server.js'));
            if (isNative) {
              push('mcp-shadow', 'ok', 'project .mcp.json binds the native task engine (bin/mcp-server.js)', null);
            } else {
              const tier = (projEntry.env && projEntry.env.TASK_MASTER_TOOLS) || 'core (default)';
              push(
                'mcp-shadow',
                'warn',
                `project .mcp.json overrides "task-master-ai" with a legacy entry (${projEntry.command} ${projArgs.join(' ')}, tier=${tier}) — it shadows the bundled native server; a core tier exposes no add_task`,
                'Remove the "task-master-ai" entry from the project .mcp.json (the plugin ships its own native server), or point it at node ${CLAUDE_PLUGIN_ROOT}/bin/mcp-server.js. Until then use the flow-tools task-* CLI twins (task-add / task-set-status / task-next / task-list / task-get)'
              );
            }
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
    const verifTrc = readJsonSafe(PATHS.trace, null);
    const verifFeat = verifTrc && verifTrc.feature;
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
            try { todoCount = (fs.readFileSync(clPath, 'utf8').match(/\bTODO\b/g) || []).length; } catch {}
          }
        }
        if (todoCount > 0) {
          push('verify-integrity', 'fail', `VERIFICATION=passed but CHECKLIST has ${todoCount} unfilled TODO — manual-test gate was bypassed`, 'fill the verify blocks + re-run scripts/run-checklist.sh; never hand-set VERIFICATION status (it must come from the run-checklist → checklist-to-verification hook)');
        } else {
          push('verify-integrity', 'ok', todoCount === null ? 'VERIFICATION=passed (CHECKLIST not found to cross-check)' : 'VERIFICATION=passed, CHECKLIST 0 TODO', null);
        }
      }
    }

    // Summary
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;

    return ok({ checks, summary });
  },
};
