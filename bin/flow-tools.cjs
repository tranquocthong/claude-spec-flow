#!/usr/bin/env node
/**
 * flow-tools.cjs — deterministic engine for spec-flow.
 *
 * Contract: NEVER throws, NEVER prints partial output. Every command returns a
 * single JSON Result on stdout: { ok: boolean, data?: any, error?: string }.
 * AI is only invoked (by the calling skill) for reasoning sections; everything
 * here is pure, testable, ~0 token.
 *
 * Usage:  node flow-tools.cjs <command> [--key value ...]
 *
 * Commands: init, srs-snapshot, sd-skeleton, route, checklist-gen, trace-build, trace-impact,
 *           trace-repos, trace-link, srs-diff, state-update, verify-collect, verify-code, wave-plan,
 *           task-baseline, taskmaster-model-plan, taskmaster-model-check,
 *           epic-new, epic-list, bug-new, bug-list, branch-ensure,
 *           learn, doctor, status-report
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  STATE_DIR, PATHS, PLUGIN_ROOT, STATE_FILE, SKIP_SCAN_DIRS, ok, err, parseArgs, readJsonSafe, traceFileFor, readTrace, ensureDir, slugify, pad3, readTmTasks, fileLinksPathFor, resolveRepos, parseReposArg, langPack, kwRe, cleanHeading, parseHeadings, bodyOf, classifyHeading, findHeading, findTableByHeader, parseFirstTable, parseAllTables, splitRow, parseUserStories, trimOrNull, extractBulletsAfter, inferDesignType, parseSrs, parseProseBullets, TODO, countSdTodos, moscowFor, genSd, readSdTables, scoreComplexity, routeFor, tcIdsForReq, resolveTemplate
} = require('../lib/core.cjs');
const maintenance = require('../lib/maintenance.cjs');
const drift = require('../lib/drift.cjs');
const taskCore = require('../lib/task-core.cjs');
const tagManager = require('../lib/tag-manager.cjs');
const dependencyManager = require('../lib/dependency-manager.cjs');
const subtaskManager = require('../lib/subtask-manager.cjs');
const { expandHook } = require('../lib/expand-hook.cjs');

// =====================================================================
//  COMMANDS (workflow). Static commands live in lib/maintenance.cjs;
//  the semantic drift-check lives in lib/drift.cjs.
// =====================================================================
const commands = {
  ...maintenance,
  ...drift,
  'srs-snapshot'(args) {
    const src = args.srs;
    if (!src) return err('MISSING_ARG: --srs <path>');
    if (!fs.existsSync(src)) return err(`NOT_FOUND: ${src}`);
    ensureDir(PATHS.snapshots);
    const fromContent = (fs.readFileSync(src, 'utf8').match(/Feature:\s*([^\n#]+)/i) || [])[1];
    const feature = args.feature || slugify(fromContent || path.basename(src, path.extname(src)));
    const warnings = [];
    if (!args.feature && !fromContent && /^\d{4}-\d{2}-\d{2}-/.test(feature)) {
      warnings.push(`slug "${feature}" looks date-prefixed (derived from filename). Move SRS to .spec-flow/srs/<clean-name>.md or pass --feature <slug>.`);
    }
    const existing = fs.readdirSync(PATHS.snapshots).filter(f => f.startsWith(feature + '-')).length;
    // Zero-pad version so files sort in order (login-002.md before login-010.md).
    const dest = path.join(PATHS.snapshots, `${feature}-${pad3(existing + 1)}.md`);
    try { fs.copyFileSync(src, dest); } catch (e) { return err(`COPY_FAILED: ${e.message}`); }
    return ok({ feature, snapshot: dest, version: existing + 1, warnings });
  },

  'sd-skeleton'(args) {
    const src = args.srs;
    if (!src) return err('MISSING_ARG: --srs <path>');
    if (!fs.existsSync(src)) return err(`NOT_FOUND: ${src}`);
    let md; try { md = fs.readFileSync(src, 'utf8'); } catch (e) { return err(`READ_FAILED: ${e.message}`); }
    const srs = parseSrs(md);
    const feature = args.feature || slugify(srs.featureName || path.basename(src, path.extname(src)));
    const { sd, stats, warnings } = genSd(srs, { type: args.type, feature });
    const outPath = args.out || path.join(PATHS.specs, feature, 'SD.md');
    if (args['dry-run']) return ok({ feature, stats, warnings, preview: sd.slice(0, 1200) + '\n...[truncated]' });
    // Clobber guard: a fresh harvest would overwrite an SD that sd-author/human
    // already cleaned (e.g. re-running /sf:ingest after a mid-ingest exit). On
    // resume, SKIP skeleton — don't re-run it. Pass --force to deliberately re-derive (resync).
    if (!args.force && fs.existsSync(outPath)) {
      return err(`SD_EXISTS: ${outPath} already exists — resume should SKIP skeleton (continue from the first missing artifact). Pass --force only to deliberately re-harvest.`);
    }
    ensureDir(path.dirname(outPath));
    try { fs.writeFileSync(outPath, sd); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    return ok({ feature, sd: outPath, stats, warnings });
  },

  // Adaptive router — the bit Task Master lacks. Score each FR -> fast|expand|deep.
  route(args) {
    const sd = args.sd;
    if (!sd) return err('MISSING_ARG: --sd <SD.md>');
    if (!fs.existsSync(sd)) return err(`NOT_FOUND: ${sd}`);
    const { fr } = readSdTables(sd);
    if (!fr) return err('NO_FR_TABLE: SD §5.1 Functional Requirements not found');
    const items = fr.rows.map(r => {
      const [id, req, prio, src] = r;
      const score = scoreComplexity(req || '');
      return { id, requirement: req, priority: prio, source: src, score, route: routeFor(score) };
    });
    const summary = items.reduce((a, it) => { a[it.route] = (a[it.route] || 0) + 1; return a; }, {});
    // Transparent: an FR table that parsed to zero rows is a real signal (empty/malformed
    // §5.1), not a successful "nothing to route" — say so rather than a silent count:0.
    if (!items.length) return ok({ count: 0, summary: {}, items: [], note: 'FR table found but parsed 0 rows — check SD §5.1 formatting.' });
    return ok({ count: items.length, summary, items });
  },

  // SD §13.2 Test Cases -> manual-test CHECKLIST.yaml scaffold (TODO markers gate on lint).
  'checklist-gen'(args) {
    const sd = args.sd;
    if (!sd) return err('MISSING_ARG: --sd <SD.md>');
    if (!fs.existsSync(sd)) return err(`NOT_FOUND: ${sd}`);
    const { tc } = readSdTables(sd);
    if (!tc || !tc.rows.length) return err('NO_TC_TABLE: SD §13.2 Test Cases not found');
    const feature = args.feature || slugify(path.basename(path.dirname(path.resolve(sd))) || 'feature');

    // Design type → decide HTTP-stub vs live-e2e scaffold. A library/internal/event-driven
    // feature has NO synchronous HTTP surface, so a `GET /api/v1/TODO` stub is wrong (forces
    // the user to rewrite every test). Read the SD preamble's `Design type: **...**`, or
    // `--type`, or fall back to whether the SD has a §9 API section.
    const sdText = fs.readFileSync(sd, 'utf8');
    const dtMatch = sdText.match(/Design type:\s*\*\*([^*]+)\*\*/i);
    // `\.?` after the optional sub-number: the template's own top heading is
    // `## 9. API Design`, which the stricter form missed (it only matched via the
    // `### 9.2 API Endpoints` subsection) — an SD with §9 but no §9.x subsection
    // silently classified as `internal` and got the live-e2e scaffold.
    const hasApiSection = /^#{2,3}\s*9(\.\d+)?\.?\s+API/im.test(sdText);
    const designType = String(args.type || (dtMatch && dtMatch[1]) || (hasApiSection ? 'api' : 'internal')).trim().toLowerCase();
    const httpSurface = designType === 'api' || designType === 'hybrid' || hasApiSection;
    const q = (s) => '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

    // Auth scaffold. `X-Userinfo` (the `payload:` token form) is a Summer/APISIX-SPECIFIC
    // convention — it is NOT a safe default. `Authorization: Bearer <token>` is what
    // everything else on the wire uses, so ONLY an explicitly-detected `summer` project
    // gets the payload form; every other classification (including `unknown`) scaffolds
    // `bearer:`. Defaulting the other way meant an unclassified project (e.g. Node +
    // custom Bearer API-key, which no dependency fingerprint catches) silently got an
    // X-Userinfo scaffold and 401'd EVERY generated test — a confusing failure that reads
    // like an app bug, versus an unfilled bearer token which 401s with an obvious fix.
    // Reuse detect-auth.sh (same heuristic the manual-test skill uses for reference-doc
    // routing) rather than re-deriving it here.
    // --auth overrides detection; any detection failure falls back to 'unknown'.
    let authType = String(args.auth || '').trim().toLowerCase();
    if (!authType) {
      try {
        const { execFileSync } = require('child_process');
        authType = execFileSync(
          path.join(PLUGIN_ROOT, 'skills', 'manual-test', 'scripts', 'detect-auth.sh'),
          [process.cwd()],
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
      } catch (e) {
        authType = 'unknown';
      }
    }
    const isSummer = authType === 'summer';

    // Resolve columns by HEADER NAME, not position. sd-skeleton emits 4 cols
    // (TC ID | Flow | Test Case | Expected); sd-author commonly enriches §13.2 to
    // 6 cols (TC ID | Flow | Test Case | Input/Condition | Expected Result | FR).
    // Positional parsing grabbed "Input/Condition" as the expected value on the
    // richer table — header lookup makes it robust to either shape.
    const H = (tc.headers || []).map(h => String(h || '').toLowerCase());
    const col = (re, fallback) => { const i = H.findIndex(h => re.test(h)); return i >= 0 ? i : fallback; };
    const idIdx = col(/tc\s*id|^id$/, 0);
    const flowIdx = col(/flow/, 1);
    const caseIdx = col(/test\s*case/, 2);
    const expIdx = col(/expected/, H.length >= 5 ? 4 : 3); // "Expected Result" (rich) or "Expected" (skeleton)

    // group TC rows by Flow (US name)
    const byFlow = {};
    for (const r of tc.rows) {
      const tcId = r[idIdx], flow = r[flowIdx], testCase = r[caseIdx], expected = r[expIdx];
      const key = (flow || 'general').trim();
      (byFlow[key] = byFlow[key] || []).push({ tcId, testCase, expected, isEdge: /^edge:/i.test(testCase || '') });
    }

    const L = [];
    L.push('# Auto-generated by spec-flow checklist-gen from SD §13.2.');
    L.push('# Fill each test before running (lint-checklist.sh gates on remaining TODO markers):');
    L.push('#   request: method/path/token from SD §9.2 / §8.');
    L.push('#     token: <name> must match a key under `tokens:` below.');
    L.push('#     unauthenticated test (expect 401 / public endpoint): `token: none`, or drop the line.');
    L.push('#   assertion — pick ONE by feature type:');
    L.push('#     read / transform (e.g. masking): expect.body field(s) == the SD Expected value.');
    L.push('#     mutation (writes a row/event):    add a verify: SQL block asserting the DB/Redis delta.');
    L.push('#     pure unit transform (no endpoint): not a manual test — tag [no-verify] or move to BUILD unit tests.');
    // Block mappings (not flow `{...}`) + quoted ${VAR}: a flow mapping containing
    // `${DB_NAME}` is INVALID YAML (the `{` opens a nested map) and crashes both
    // lint-checklist.sh and _checklist_runner.py, which yaml.safe_load the raw file
    // and expand ${VAR} only afterwards. Quoting keeps the var literal for that pass.
    L.push('config:');
    L.push('  base_url: "http://localhost:${SERVER_PORT:-8080}"');
    L.push('  db:');
    L.push('    host: localhost');
    L.push('    port: 5432');
    L.push('    database: "${DB_NAME}"');
    L.push('    username: "${DB_USER:-postgres}"');
    L.push('    password: "${DB_PASS:-postgres}"');
    L.push('  redis:');
    L.push('    host: localhost');
    L.push('    port: 6379');
    L.push('tokens:');
    L.push('  user_token:');
    if (isSummer) {
      L.push("    payload: '{\"iat\":1772680061,\"exp\":2088040061,\"sub\":\"${USER_ID}\"}'");
    } else {
      L.push('    bearer: "${TOKEN}"   # TODO: supply the real Bearer token — see references/auth-jwt-basic.md (login endpoint / IDP ROPC / static secret / API key)');
      if (authType !== 'jwt-basic') {
        L.push(`    # detected auth: ${authType} — scaffolded the standard Authorization: Bearer form.`);
        L.push('    # Summer/APISIX project instead? replace with: payload: \'{"iat":...,"exp":...,"sub":"${USER_ID}"}\'  (sent as X-Userinfo)');
      }
    }
    L.push('cleanup:');
    L.push("  all: | # TODO: DELETE test rows (LIKE 'TEST-%')");
    L.push('suites:');
    let s = 0;
    for (const flow of Object.keys(byFlow)) {
      s++;
      // Smoke is the HAPPY-PATH SPINE, not the whole suite. Tagging every non-`Edge:`
      // test `smoke` made `--tag smoke` run the full set, collapsing the smoke →
      // regression escalation the skill promises: an SD whose §13.2 doesn't use the
      // `Edge:` naming convention (most of them) produced an all-smoke checklist.
      // Rule: the FIRST non-edge TC of each flow is that flow's smoke test; every
      // other TC — edge or not — is regression. One smoke test per user story.
      const tests = byFlow[flow];
      const smokeIdx = tests.findIndex(t => !t.isEdge);
      L.push(`  - id: suite-${s}`);
      L.push(`    name: ${q(flow)}`);
      L.push(`    tags: [${smokeIdx >= 0 && tests.length > 1 ? 'smoke, regression' : smokeIdx >= 0 ? 'smoke' : 'regression'}]`);
      L.push('    tests:');
      for (let ti = 0; ti < tests.length; ti++) {
        const t = tests[ti];
        const tag = ti === smokeIdx ? 'smoke' : 'regression';
        // Expected goes in a COMMENT (free SD prose — never inside a YAML value,
        // which would break the parser on backticks/quotes). The lint tripwire is
        // the clean `path: /api/v1/TODO` + `_assert: TODO` tokens.
        const expTxt = String(t.expected || '').replace(/\s+/g, ' ').trim().slice(0, 110) || '(see SD §13.2)';
        L.push(`      - id: ${t.tcId}`);
        L.push(`        name: ${q(t.testCase)}`);
        if (httpSurface) {
          L.push(`        tags: [${tag}]`);
          L.push(`        # SD Expected Result: ${expTxt}`);
          L.push('        request:    # method/path/token from SD §9.2 / §8 — GET for read/masking, POST/PUT/DELETE if mutating');
          L.push('          method: GET');
          L.push('          path: /api/v1/TODO');
          L.push('          token: user_token');
          L.push('        expect:');
          L.push(`          status: ${t.isEdge ? 422 : 200}   # confirm vs SD §9.3 / §12.2`);
          L.push('          body:     # read/transform: assert the response field(s) above. MUTATION: replace this body with a verify: SQL delta block.');
          L.push('            _assert: TODO');
        } else {
          // No HTTP surface (design-type: internal/library/event-driven) → live-e2e scaffold,
          // NOT a fake HTTP stub. Tagged live-e2e so checklist-status/lint treat it as verified
          // by a live run (surfaced as a VERIFICATION live gap). Retag [no-verify] if it's a
          // pure unit transform owned by BUILD.
          L.push(`        tags: [${tag}, live-e2e]`);
          L.push(`        # SD Expected Result: ${expTxt}`);
          L.push(`        # [live-e2e] design-type ${designType}: no synchronous HTTP surface — verify by a live`);
          L.push('        # run / observe the event or side-effect, then record it as a VERIFICATION live gap.');
          L.push('        # If this is a pure unit transform (a util case, no integration), retag [no-verify].');
        }
      }
    }
    const yaml = L.join('\n') + '\n';
    const outPath = args.out || path.join(PATHS.specs, feature, 'CHECKLIST.yaml');
    const todoCount = (yaml.match(/TODO/g) || []).length;
    if (args['dry-run']) return ok({ feature, suites: s, tests: tc.rows.length, todo: todoCount, preview: yaml.slice(0, 900) + '\n...[truncated]' });
    if (!args.force && fs.existsSync(outPath)) {
      return err(`CHECKLIST_EXISTS: ${outPath} already exists — pass --force to regenerate (destructive: overwrites filled assertions). Use \`/sf:manual-test ${feature}\` to run the existing checklist.`);
    }
    ensureDir(path.dirname(outPath));
    try { fs.writeFileSync(outPath, yaml); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    return ok({ feature, checklist: outPath, suites: s, tests: tc.rows.length, todo: todoCount });
  },

  // -----------------------------------------------------------------------
  // checklist-status  [--feature <f>] [--file <path>]
  // Classify each test in a CHECKLIST.yaml so you don't have to eyeball the file
  // to know what's ready: filled / scaffold (still has the gen tripwires
  // `path: /api/v1/TODO` or `_assert: TODO`) / no-verify / live-e2e (tagged).
  // Returns ok({ total, counts, byStatus, ready }). Zero-dep line parse (no YAML lib).
  // -----------------------------------------------------------------------
  'checklist-status'(args) {
    const feature = args.feature || (readJsonSafe(PATHS.trace, null) || {}).feature || null;
    const file = args.file || (feature ? path.join(PATHS.specs, feature, 'CHECKLIST.yaml') : null);
    if (!file) return err('MISSING_ARG: --feature <f> or --file <path>');
    if (!fs.existsSync(file)) return err(`NOT_FOUND: ${file}`);
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return err(`READ_FAILED: ${e.message}`); }
    // Split into test blocks: each begins at `- id: <X>` where X is not a `suite-` id.
    const tests = [];
    let cur = null;
    for (const ln of raw.split(/\r?\n/)) {
      const m = ln.match(/^\s*-\s*id:\s*(\S+)/);
      if (m) {
        if (/^suite-/i.test(m[1])) { cur = null; continue; } // suite header, not a test
        cur = { id: m[1], body: [] };
        tests.push(cur);
      } else if (cur) cur.body.push(ln);
    }
    const classify = (t) => {
      // Drop full-line comments first — checklist-gen's own scaffold hints (e.g.
      // "retag [no-verify]") mention both carve-out tags in prose, so scanning
      // comment text made every scaffolded test misclassify regardless of its
      // actual tags: line. Only real YAML content should drive classification.
      const bodyNoComments = t.body.filter((ln) => !/^\s*#/.test(ln)).join('\n');
      const blob = t.id + '\n' + bodyNoComments;
      // Match the bare token (word-boundary) so BOTH a tags-list entry (`tags: [smoke, no-verify]`)
      // AND a bracketed-name marker (`[no-verify]`) are recognized — same source of truth as
      // lint-checklist (which reads the tags list). Avoids the "mark it in two places" trap.
      if (/\bno-verify\b/i.test(blob)) return 'no-verify';
      if (/\blive-e2e\b/i.test(blob)) return 'live-e2e';
      if (/\/api\/v1\/TODO|_assert:\s*TODO/.test(blob)) return 'scaffold';
      return 'filled';
    };
    const byStatus = { filled: [], scaffold: [], 'no-verify': [], 'live-e2e': [] };
    for (const t of tests) byStatus[classify(t)].push(t.id);
    const counts = Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length]));
    const ready = counts.scaffold === 0;
    return ok({
      feature, file, total: tests.length, counts, byStatus, ready,
      note: ready
        ? 'no scaffold stubs left — fillable tests are filled or explicitly tagged; ready to run/lint.'
        : `${counts.scaffold} scaffold test(s) still have TODO stubs — fill from the SD, or tag [no-verify] / [live-e2e].`,
    });
  },

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // checkpoint-write  --feature <f> --task <id-or-title>
  //                   [--phase <RED|GREEN|REFACTOR|CHECKLIST|VERIFY>]
  //                   [--done <csv-of-files>] [--next <what-to-do>]
  //                   [--decision <key-decisions>]
  //
  // Writes (overwrites) .spec-flow/specs/<feature>/checkpoint.md — a single
  // file capturing mid-task state so a fresh agent can resume without re-deriving.
  // Cleared by checkpoint-clear when task reaches done.
  // -----------------------------------------------------------------------
  'checkpoint-write'(args) {
    const feature = args.feature;
    if (!feature) return err('MISSING_ARG: --feature');
    const task = args.task;
    if (!task) return err('MISSING_ARG: --task (task id or title)');
    const lines = [
      `# Checkpoint — ${feature}`,
      `task: ${task}`,
      args.phase ? `phase: ${args.phase}` : '',
      '',
      '## Done this session',
      args.done || '(none recorded)',
      '',
      '## Next',
      args.next || '(see SD)',
      '',
    ];
    if (args.decision) lines.push('## Decisions', args.decision, '');
    const content = lines.join('\n') + '\n';
    const outPath = path.join(PATHS.specs, feature, 'checkpoint.md');
    ensureDir(path.dirname(outPath));
    try { fs.writeFileSync(outPath, content); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    return ok({ feature, checkpoint: outPath, task, phase: args.phase || null });
  },

  // -----------------------------------------------------------------------
  // checkpoint-clear  --feature <f>
  // Remove checkpoint.md after task reaches done.
  // -----------------------------------------------------------------------
  'checkpoint-clear'(args) {
    const feature = args.feature;
    if (!feature) return err('MISSING_ARG: --feature');
    const p = path.join(PATHS.specs, feature, 'checkpoint.md');
    if (!fs.existsSync(p)) return ok({ feature, cleared: false });
    try { fs.unlinkSync(p); } catch (e) { return err(`DELETE_FAILED: ${e.message}`); }
    return ok({ feature, cleared: true });
  },

  // trace-link  --task <taskId> [--fr <FR-id>] --files "p1,p2,..."
  //
  // Append/dedupe entries into .spec-flow/file-links.json.
  // One entry per (task, file) pair; update fr/ts if re-linked.
  // Create the file if missing. NEVER throws.
  // Returns ok({ added, total, file: '.spec-flow/file-links.json' }).
  // -----------------------------------------------------------------------
  'trace-link'(args) {
    const taskId = args.task;
    if (!taskId) return err('MISSING_ARG: --task <taskId>');
    const filesArg = args.files;
    if (!filesArg) return err('MISSING_ARG: --files "path1,path2,..."');

    const frId = args.fr || null;
    const filePaths = String(filesArg).split(',').map(f => f.trim()).filter(Boolean);
    if (filePaths.length === 0) return err('MISSING_ARG: --files must contain at least one path');

    // Feature scope: explicit --feature, else the active feature from trace.json.
    // Scoping per feature keeps each feature's trace bounded + unambiguous (TM task
    // ids repeat across features, so a global store would collide).
    const flFeature = args.feature || (readJsonSafe(PATHS.trace, {}) || {}).feature || null;
    if (!flFeature) return err('MISSING_ARG: --feature <f> (or run trace-build first so the active feature is known)');
    const fileLinksFile = fileLinksPathFor(flFeature);
    ensureDir(path.dirname(fileLinksFile));

    // Load existing store (tolerate absent)
    const store = readJsonSafe(fileLinksFile, { links: [] });
    if (!Array.isArray(store.links)) store.links = [];

    const now = new Date().toISOString();
    let added = 0;
    // Multi-repo: --repo <name> qualifies the stored path as "<name>/<path>" so
    // files from sibling service repos stay distinguishable (auth-svc/src/... vs
    // billing-svc/src/...). Single-repo callers omit --repo → bare paths as before.
    const repoPrefix = (typeof args.repo === 'string' && args.repo.trim()) ? args.repo.trim().replace(/\/+$/, '') + '/' : '';

    for (const filePath of filePaths) {
      // Normalise: strip leading ./ ; prefix the repo when given.
      const normPath = repoPrefix + filePath.replace(/^\.\//, '');
      const existing = store.links.find(l => l.task === String(taskId) && l.file === normPath);
      if (existing) {
        // Update fr and ts if re-linked
        existing.fr = frId;
        existing.ts = now;
      } else {
        store.links.push({ task: String(taskId), fr: frId, file: normPath, ts: now });
        added++;
      }
    }

    try {
      fs.writeFileSync(fileLinksFile, JSON.stringify(store, null, 2) + '\n');
    } catch (e) {
      return err(`WRITE_FAILED: ${e.message}`);
    }

    return ok({ added, total: store.links.length, feature: flFeature, file: fileLinksFile });
  },

  // -----------------------------------------------------------------------
  // trace-build  --sd <SD.md> [--feature f] [--tasks <tasks.json path>]
  // Builds .spec-flow/trace.json from the SD tables (FR §5.1, TC §13.2,
  // errors §12.2, states §10.4) and optionally a Task Master tasks.json.
  // -----------------------------------------------------------------------
  'trace-build'(args) {
    const sdPath = args.sd;
    if (!sdPath) return err('MISSING_ARG: --sd <SD.md>');
    if (!fs.existsSync(sdPath)) return err(`NOT_FOUND: ${sdPath}`);

    let sdContent;
    try { sdContent = fs.readFileSync(sdPath, 'utf8'); } catch (e) { return err(`READ_FAILED: ${e.message}`); }

    const feature = args.feature || slugify(path.basename(path.dirname(path.resolve(sdPath))) || 'feature');
    const lines = sdContent.split(/\r?\n/);
    const tables = parseAllTables(lines);

    // FR table: §5.1 — headers contain "Requirement" and "Priority"/"MoSCoW"
    const frTable = tables.find(t =>
      /requirement/i.test(t.headers.join(' ')) && /priority|moscow/i.test(t.headers.join(' '))
    );
    // TC table: §13.2 — headers contain "TC ID" or "Test Case"
    const tcTable = tables.find(t =>
      /tc\s*id/i.test(t.headers.join(' ')) || (/test\s*case/i.test(t.headers.join(' ')) && /flow/i.test(t.headers.join(' ')))
    );
    // Error table: §12.2 — headers contain "Error Code" and "HTTP"
    const errTable = tables.find(t =>
      /error\s*code/i.test(t.headers.join(' ')) && /http/i.test(t.headers.join(' '))
    );
    // State table: §10.4 — headers contain "State" and "Meaning"
    const stateTable = tables.find(t =>
      /state/i.test(t.headers.join(' ')) && /meaning/i.test(t.headers.join(' '))
    );
    // NFR table: §5.2 — rows start with NFR-, or headers have Category + Target/Acceptance
    // (distinct from the FR table, which carries Priority/MoSCoW).
    const nfrTable = tables.find(t =>
      (t.rows[0] && /^NFR-?\d/i.test(String(t.rows[0][0] || '').trim())) ||
      (/category/i.test(t.headers.join(' ')) && /target|acceptance/i.test(t.headers.join(' ')) && !/priority|moscow/i.test(t.headers.join(' ')))
    );

    // Build FR nodes
    const frNodes = frTable ? frTable.rows.map(r => ({
      id: (r[0] || '').trim(),
      text: (r[1] || '').trim(),
      priority: (r[2] || '').trim(),
      source: (r[3] || '').trim(),
    })).filter(n => n.id) : [];

    // Build TC nodes (resolve "Expected" column by header — 6-col enriched vs 4-col skeleton)
    const tcH = (tcTable && tcTable.headers ? tcTable.headers : []).map(h => String(h || '').toLowerCase());
    const tcExpIdx = (() => { const i = tcH.findIndex(h => /expected/.test(h)); return i >= 0 ? i : (tcH.length >= 5 ? 4 : 3); })();
    const tcNodes = tcTable ? tcTable.rows.map(r => ({
      id: (r[0] || '').trim(),
      flow: (r[1] || '').trim(),
      text: (r[2] || '').trim(),
      expected: (r[tcExpIdx] || '').trim(),
    })).filter(n => n.id) : [];

    // Build error nodes
    const errorNodes = errTable ? errTable.rows.map(r => ({
      code: (r[0] || '').trim(),
      http: (r[1] || '').trim(),
      trigger: (r[2] || '').trim(),
    })).filter(n => n.code) : [];

    // Enforce the project's standard error-code pattern (opt-in: config.conventions
    // .errorCodePattern). WARN (not block) on §12.2 codes that don't match — surfaces
    // a drift from the house convention right at ingest/resync, not at review-by-eye.
    const warnings = [];
    const ecPattern = ((readJsonSafe(PATHS.config, {}) || {}).conventions || {}).errorCodePattern || null;
    if (ecPattern && errorNodes.length) {
      let ecRe = null;
      try { ecRe = new RegExp(ecPattern); } catch { warnings.push(`conventions.errorCodePattern is not a valid regex: ${ecPattern}`); }
      if (ecRe) {
        const bad = errorNodes.map(n => n.code.replace(/^`|`$/g, '')).filter(c => !ecRe.test(c));
        if (bad.length) warnings.push(`${bad.length} error code(s) violate conventions.errorCodePattern (${ecPattern}): ${bad.join(', ')}`);
      }
    }

    // Build state nodes
    const stateNodes = stateTable ? stateTable.rows.map(r => ({
      name: (r[0] || '').trim(),
      meaning: (r[1] || '').trim(),
    })).filter(n => n.name) : [];

    // Build NFR nodes (§5.2)
    const nfrNodes = nfrTable ? nfrTable.rows.map(r => ({
      id: (r[0] || '').trim(),
      category: (r[1] || '').trim(),
      text: (r[2] || '').trim(),
      target: (r[3] || '').trim(),
    })).filter(n => /^NFR/i.test(n.id)) : [];

    // Load tasks: explicit path, or infer relative to SD
    let taskNodes = [];
    let tasksPath = args.tasks || null;
    if (!tasksPath) {
      // Try .taskmaster/tasks/tasks.json relative to the SD's directory
      const sdDir = path.dirname(path.resolve(sdPath));
      const candidates = [
        path.join(sdDir, '.taskmaster', 'tasks', 'tasks.json'),
        path.join(sdDir, '..', '.taskmaster', 'tasks', 'tasks.json'),
        path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json'),
      ];
      tasksPath = candidates.find(c => fs.existsSync(c)) || null;
    }
    if (tasksPath && fs.existsSync(tasksPath)) {
      // Scope to THIS feature's tag — never fall back to master/first-tag, which
      // would miscount (the currentTag-drift symptom: counts read another feature's tasks).
      const rawTasks = readTmTasks(readJsonSafe(tasksPath, null), feature);
      taskNodes = rawTasks.map(t => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
        status: String(t.status || ''),
      })).filter(t => t.id);
    }

    // Build links
    const links = [];

    // FR <-> TC links via tcIdsForReq
    for (const fr of frNodes) {
      const tcIds = tcIdsForReq(tcTable, fr.text, fr.id);
      for (const tcId of tcIds) {
        links.push({ from: fr.id, to: tcId, type: 'fr-tc' });
      }
    }

    // source (US/BL/FR/AC reference) -> FR links
    // Accepts clean IDs ("US-1", "BL-001") and embedded refs ("SRS §5.1 FR-1").
    for (const fr of frNodes) {
      const src = fr.source;
      if (!src) continue;
      const m = src.match(/\b(US|BL|NFR|FR|AC)-?\d+/i);
      if (m) links.push({ from: m[0].toUpperCase(), to: fr.id, type: 'src-fr' });
    }

    // NFR -> FR / TC links: any FR or TC whose text/source references the NFR id
    // (so trace-impact on an NFR change reaches the requirements/tests verifying it).
    for (const nfr of nfrNodes) {
      const re = new RegExp(nfr.id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
      for (const fr of frNodes) {
        if (re.test(fr.text) || re.test(fr.source)) links.push({ from: nfr.id, to: fr.id, type: 'nfr-fr' });
      }
      for (const tc of tcNodes) {
        if (re.test(tc.text) || re.test(tc.flow)) links.push({ from: nfr.id, to: tc.id, type: 'nfr-tc' });
      }
    }

    // --- Merge file-links.json (tolerate absent) ----------------------------
    const fileLinksStore = readJsonSafe(fileLinksPathFor(feature), { links: [] });
    const rawFileLinks = Array.isArray(fileLinksStore.links) ? fileLinksStore.links : [];

    // Build task→FR map from src-fr + existing task links for fr resolution
    // A task links to an FR when an src-fr link mentions the task's id, or
    // when the file-link entry itself has an fr field.
    // We also check fr-tc links to find which tasks are associated via TC→FR.
    // Simple approach: build a taskId→frId map from the file-links store itself
    // (explicit fr field), then fall through.
    const taskToFrMap = {};
    for (const entry of rawFileLinks) {
      if (entry.task && entry.fr) {
        // Prefer the most-recently-set FR per task
        taskToFrMap[String(entry.task)] = entry.fr;
      }
    }

    // Build nodes.files (distinct file paths)
    const filePathSet = new Set();
    for (const entry of rawFileLinks) {
      if (entry.file) filePathSet.add(entry.file);
    }
    const fileNodes = Array.from(filePathSet).map(p => ({ path: p }));

    // Build task-file and fr-file links
    const addedLinkKeys = new Set(links.map(l => `${l.from}|${l.to}|${l.type}`));
    const addLink = (from, to, type) => {
      const key = `${from}|${to}|${type}`;
      if (!addedLinkKeys.has(key)) {
        links.push({ from, to, type });
        addedLinkKeys.add(key);
      }
    };

    for (const entry of rawFileLinks) {
      if (!entry.task || !entry.file) continue;
      addLink(String(entry.task), entry.file, 'task-file');

      // FR-file: use explicit fr on entry, or look up via taskToFrMap
      const frId = entry.fr || taskToFrMap[String(entry.task)] || null;
      if (frId) {
        addLink(frId, entry.file, 'fr-file');
      }
    }

    // FR-task links: so trace-impact (and /sf:change) can reach the tasks that
    // implemented a changed FR. Without this, an FR-id changeset resolves to
    // tasks=[] and the user has to map FR→task by hand. Source = file-links
    // entries carrying both task + fr (set by `trace-link --fr ... --task ...`).
    for (const [taskId, frId] of Object.entries(taskToFrMap)) {
      addLink(frId, taskId, 'fr-task');
    }

    ensureDir(PATHS.stateDir);
    const trace = {
      feature,
      generatedFrom: path.resolve(sdPath),
      generatedAt: new Date().toISOString(),
      nodes: {
        fr: frNodes,
        tc: tcNodes,
        nfr: nfrNodes,
        errors: errorNodes,
        states: stateNodes,
        tasks: taskNodes,
        files: fileNodes,
      },
      links,
    };

    const traceJson = JSON.stringify(trace, null, 2);
    const perFeaturePath = traceFileFor(feature);
    // Detect an active-feature switch BEFORE overwriting the mirror — purely for
    // transparency in the result; the prior feature's durable trace is never touched.
    const prevGlobal = readJsonSafe(PATHS.trace, null);
    const switchedFrom = (prevGlobal && prevGlobal.feature && prevGlobal.feature !== feature) ? prevGlobal.feature : null;
    try {
      ensureDir(path.join(PATHS.specs, feature));
      fs.writeFileSync(perFeaturePath, traceJson); // durable per-feature source of truth
      fs.writeFileSync(PATHS.trace, traceJson);    // active-feature mirror
    } catch (e) {
      return err(`WRITE_FAILED: ${e.message}`);
    }

    return ok({
      trace: PATHS.trace,
      perFeatureTrace: perFeaturePath,
      switchedFrom,
      counts: {
        fr: frNodes.length,
        tc: tcNodes.length,
        nfr: nfrNodes.length,
        errors: errorNodes.length,
        states: stateNodes.length,
        tasks: taskNodes.length,
        files: fileNodes.length,
      },
      linkCount: links.length,
      warnings,
    });
  },

  // -----------------------------------------------------------------------
  // trace-repos  --feature <f>  [--set "a,b" | --get]
  //
  // Declare/read the repo subset a feature targets — the per-feature source of
  // truth read by branch-ensure (at branch time, before any code exists, so the
  // gate's file-links inference can't help) AND by verify-code (declared intent
  // sits above file-links evidence). Stored as trace.json.repos[]. Each name is
  // validated against config.repos keys (reuses REPO_NOT_CONFIGURED). Default
  // action (no --set) is a read; single-repo / undeclared → returns [].
  // -----------------------------------------------------------------------
  'trace-repos'(args) {
    const feature = args.feature;
    if (!feature) return err('MISSING_ARG: --feature required');
    const cfg = readJsonSafe(PATHS.config, null);
    const known = cfg && cfg.repos && typeof cfg.repos === 'object' ? Object.keys(cfg.repos) : [];

    // Read (default when --set is absent): return the declared subset.
    if (typeof args.set !== 'string') {
      const tr = readTrace(feature);
      return ok({ feature, repos: (tr && Array.isArray(tr.repos)) ? tr.repos : [] });
    }

    // Write --set "a,b": validate names ∈ config.repos, then persist.
    const names = args.set.split(',').map((s) => s.trim()).filter(Boolean);
    if (known.length) {
      const unknown = names.filter((n) => !known.includes(n));
      if (unknown.length) return err(`REPO_NOT_CONFIGURED: [${unknown.join(', ')}] not in config.repos (known: ${known.join(', ') || '(none)'}).`);
    }
    const perFeaturePath = traceFileFor(feature);
    // Load the existing per-feature trace, or start a minimal stub — a feature may
    // declare its repos at intake (/sf:bug, /sf:change) before trace-build has run.
    let tr = fs.existsSync(perFeaturePath) ? readJsonSafe(perFeaturePath, null) : null;
    if (!tr) tr = { feature };
    tr.repos = names;
    try {
      ensureDir(path.join(PATHS.specs, feature));
      fs.writeFileSync(perFeaturePath, JSON.stringify(tr, null, 2));
      // Keep the active-feature global mirror in sync when it points at this feature.
      const g = readJsonSafe(PATHS.trace, null);
      if (g && g.feature === feature) { g.repos = names; fs.writeFileSync(PATHS.trace, JSON.stringify(g, null, 2)); }
    } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    return ok({ feature, repos: names, path: perFeaturePath });
  },

  // -----------------------------------------------------------------------
  // trace-impact  --changeset <json file>  |  --ids "FR-001,TC-003"  |  --keywords "callback,timeout"
  // Read .spec-flow/trace.json, resolve impacted nodes transitively.
  // Also walks task-file and fr-file links to populate impacted.files.
  // -----------------------------------------------------------------------
  'trace-impact'(args) {
    const trace = readTrace(args.feature);
    if (!trace) return err('NO_TRACE: run trace-build first');

    const reasons = [];
    const impacted = { fr: [], tc: [], errors: [], tasks: [], files: [] };

    // Helper: add to impacted without duplication
    const addImpacted = (kind, id, reason) => {
      if (!impacted[kind]) impacted[kind] = [];
      if (!impacted[kind].includes(id)) {
        impacted[kind].push(id);
        reasons.push({ id, kind, reason });
      }
    };

    // Collect seed IDs from --changeset file or --ids / --keywords
    const seedIds = new Set();

    if (args.changeset) {
      if (!fs.existsSync(args.changeset)) return err(`NOT_FOUND: ${args.changeset}`);
      const cs = readJsonSafe(args.changeset, null);
      if (!cs) return err('INVALID_JSON: changeset file is not valid JSON');
      // Accept { ids: [], keywords: [] } or flat array of strings
      const idList = cs.ids || (Array.isArray(cs) ? cs : []);
      for (const id of idList) seedIds.add(String(id).trim());
      const kws = cs.keywords || [];
      if (kws.length) {
        args._keywords = kws.join(',');
      }
      // Also accept srs-diff output directly: the full Result data ({ changeset, prose })
      // or the bare { added, changed, removed } object. Pre-fix this shape was silently
      // ignored (0 seeds) even though resync.md pipes srs-diff into trace-impact.
      const entries = [];
      const csRoot = (cs.changeset && typeof cs.changeset === 'object') ? cs.changeset : cs;
      for (const k of ['added', 'changed', 'removed']) {
        if (Array.isArray(csRoot[k])) entries.push(...csRoot[k]);
      }
      const proseRoot = cs.prose || csRoot.prose;
      if (proseRoot && typeof proseRoot === 'object') {
        for (const k of ['added', 'removed']) {
          if (Array.isArray(proseRoot[k])) entries.push(...proseRoot[k]);
        }
      }
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        if (e.id) seedIds.add(String(e.id).trim());
        // Harvest anchored ids mentioned inside the changed text itself
        const hay = [e.text, e.oldText, e.name,
          Array.isArray(e.row) ? e.row.join(' ') : '',
          Array.isArray(e.oldRow) ? e.oldRow.join(' ') : ''].join(' ');
        for (const m of hay.match(/\b(?:FR|TC|US|NFR|AC|BR)-\d+\b/gi) || []) seedIds.add(m.toUpperCase());
        for (const m of hay.match(/\bERR_[A-Z0-9_]+\b/g) || []) seedIds.add(m);
      }
    }

    if (args.ids) {
      for (const id of String(args.ids).split(',')) seedIds.add(id.trim());
    }

    // Keyword text match across all node kinds
    const kwList = args.keywords ? String(args.keywords).split(',').map(k => k.trim()).filter(Boolean)
      : args._keywords ? String(args._keywords).split(',').map(k => k.trim()).filter(Boolean)
      : [];

    const nodes = trace.nodes || {};
    const allNodes = [
      ...(nodes.fr || []).map(n => ({ ...n, kind: 'fr', searchText: `${n.id} ${n.text} ${n.source}` })),
      ...(nodes.tc || []).map(n => ({ ...n, kind: 'tc', searchText: `${n.id} ${n.flow} ${n.text}` })),
      ...(nodes.errors || []).map(n => ({ ...n, kind: 'errors', searchText: `${n.code} ${n.trigger}`, id: n.code })),
      ...(nodes.tasks || []).map(n => ({ ...n, kind: 'tasks', searchText: `${n.id} ${n.title}` })),
    ];

    // Match seed IDs directly
    for (const node of allNodes) {
      if (seedIds.has(node.id)) {
        addImpacted(node.kind, node.id, `direct id match`);
      }
    }

    // Match keywords
    for (const kw of kwList) {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      for (const node of allNodes) {
        if (re.test(node.searchText)) {
          addImpacted(node.kind, node.id, `keyword match: "${kw}"`);
        }
      }
    }

    // Walk links transitively: for each impacted FR, find linked TCs; for each src, find linked FRs
    const links = trace.links || [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const lnk of links) {
        const { from, to, type } = lnk;
        if (type === 'fr-tc') {
          if (impacted.fr.includes(from) && !impacted.tc.includes(to)) {
            addImpacted('tc', to, `transitive fr-tc from ${from}`);
            changed = true;
          }
          // reverse: if TC is impacted, mark FR
          if (impacted.tc.includes(to) && !impacted.fr.includes(from)) {
            addImpacted('fr', from, `transitive tc-fr from ${to}`);
            changed = true;
          }
        }
        if (type === 'fr-task') {
          // An impacted FR reaches the task(s) that implemented it → /sf:change reopens them.
          if (impacted.fr.includes(from) && !impacted.tasks.includes(to)) {
            addImpacted('tasks', to, `transitive fr-task from ${from}`);
            changed = true;
          }
        }
        if (type === 'src-fr') {
          // src is a US/BL id, not a node kind we track in impacted — skip upward
        }
      }
    }

    // Walk task-file and fr-file links to populate impacted.files
    for (const lnk of links) {
      const { from, to, type } = lnk;
      if (type === 'task-file' && impacted.tasks.includes(from)) {
        if (!impacted.files.includes(to)) {
          impacted.files.push(to);
          reasons.push({ id: to, kind: 'files', reason: `task-file from task ${from}` });
        }
      }
      if (type === 'fr-file' && impacted.fr.includes(from)) {
        if (!impacted.files.includes(to)) {
          impacted.files.push(to);
          reasons.push({ id: to, kind: 'files', reason: `fr-file from ${from}` });
        }
      }
    }

    return ok({ impacted, reasons });
  },

  // -----------------------------------------------------------------------
  // srs-diff  --new <srs.md> [--old <snapshot.md>]
  // Best-effort diff between two SRS versions using parseSrs(). Outputs
  // CHANGESET { added, changed, removed } each {kind, text, ...}.
  // NOTE: SRS is free-form — this is best-effort. The SD is the authoritative
  // controlled artifact; treat this output as a hint for sd-author.
  // -----------------------------------------------------------------------
  'srs-diff'(args) {
    const newPath = args.new;
    if (!newPath) return err('MISSING_ARG: --new <srs.md>');
    if (!fs.existsSync(newPath)) return err(`NOT_FOUND: ${newPath}`);

    // Resolve old snapshot: explicit --old, else the latest snapshot OF THIS FEATURE.
    // Feature = --feature, else the SRS basename (snapshots are `<feature>-NNN.md`).
    // Pick by NAME (the NNN version), not mtime — a touch/copy of an old file must not
    // win, and we must never diff against another feature's snapshot (mtime did both).
    let oldPath = args.old || null;
    if (!oldPath && fs.existsSync(PATHS.snapshots)) {
      const feature = args.feature || slugify(path.basename(newPath).replace(/\.md$/i, ''));
      const featRe = new RegExp(`^${feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.md$`);
      let snaps = fs.readdirSync(PATHS.snapshots).filter(f => featRe.test(f));
      // Fallback: if none match this feature (older un-prefixed snapshots), use all .md.
      if (!snaps.length) snaps = fs.readdirSync(PATHS.snapshots).filter(f => f.endsWith('.md'));
      snaps.sort();  // lexicographic → `<feature>-001` < `-002` < ... → last = latest
      if (snaps.length) oldPath = path.join(PATHS.snapshots, snaps[snaps.length - 1]);
    }
    if (!oldPath || !fs.existsSync(oldPath)) {
      return err('NO_OLD_SRS: provide --old <snapshot.md> or run srs-snapshot first');
    }

    let newMd, oldMd;
    try { newMd = fs.readFileSync(newPath, 'utf8'); } catch (e) { return err(`READ_FAILED (new): ${e.message}`); }
    try { oldMd = fs.readFileSync(oldPath, 'utf8'); } catch (e) { return err(`READ_FAILED (old): ${e.message}`); }

    const newSrs = parseSrs(newMd);
    const oldSrs = parseSrs(oldMd);

    const added = [], changed = [], removed = [];

    // Helper: normalize text for comparison
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').toLowerCase().trim();

    // Diff user stories (by id)
    const newUsMap = Object.fromEntries((newSrs.stories || []).map(s => [s.id, s]));
    const oldUsMap = Object.fromEntries((oldSrs.stories || []).map(s => [s.id, s]));
    for (const [id, story] of Object.entries(newUsMap)) {
      if (!oldUsMap[id]) {
        added.push({ kind: 'us', id, text: story.name, name: story.name });
        // also flag new ACs
        for (const ac of story.acceptance || []) added.push({ kind: 'ac', usId: id, text: ac });
      } else {
        const old = oldUsMap[id];
        if (norm(story.name) !== norm(old.name)) {
          changed.push({ kind: 'us', id, text: story.name, oldText: old.name });
        }
        // AC diff by text
        const newAcs = new Set((story.acceptance || []).map(norm));
        const oldAcs = new Set((old.acceptance || []).map(norm));
        for (const ac of (story.acceptance || [])) { if (!oldAcs.has(norm(ac))) added.push({ kind: 'ac', usId: id, text: ac }); }
        for (const ac of (old.acceptance || [])) { if (!newAcs.has(norm(ac))) removed.push({ kind: 'ac', usId: id, text: ac }); }
      }
    }
    for (const id of Object.keys(oldUsMap)) {
      if (!newUsMap[id]) {
        removed.push({ kind: 'us', id, text: oldUsMap[id].name });
        for (const ac of oldUsMap[id].acceptance || []) removed.push({ kind: 'ac', usId: id, text: ac });
      }
    }

    // Diff NFR rows (by first cell text)
    const diffTableRows = (oldT, newT, kind) => {
      const oldRows = (oldT && oldT.rows) ? oldT.rows : [];
      const newRows = (newT && newT.rows) ? newT.rows : [];
      const oldSet = new Map(oldRows.map(r => [norm(r[0]), r]));
      const newSet = new Map(newRows.map(r => [norm(r[0]), r]));
      for (const [k, r] of newSet) {
        if (!oldSet.has(k)) added.push({ kind, text: r[0], row: r });
        else {
          const oldR = oldSet.get(k);
          if (r.map(norm).join('|') !== oldR.map(norm).join('|')) changed.push({ kind, text: r[0], row: r, oldRow: oldR });
        }
      }
      for (const [k, r] of oldSet) { if (!newSet.has(k)) removed.push({ kind, text: r[0], row: r }); }
    };
    diffTableRows(oldSrs.nfr, newSrs.nfr, 'nfr');
    diffTableRows(oldSrs.businessLogic, newSrs.businessLogic, 'bl');
    diffTableRows(oldSrs.stateTable, newSrs.stateTable, 'state');

    const changeset = { added, changed, removed };
    const counts = { added: added.length, changed: changed.length, removed: removed.length };
    const anchorEmpty = counts.added + counts.changed + counts.removed === 0;

    // Prose fallback — an SRS written as prose bullets (no US-/anchored-id rows, no
    // keyword tables) is invisible to the anchor diff above, so a heavily-edited
    // revision would read 0/0/0 ("parser-blind", NOT "no change"). Diff bullets per
    // section so a real revision never reads as an empty changeset.
    const oldProse = parseProseBullets(oldMd);
    const newProse = parseProseBullets(newMd);
    const proseAdded = [], proseRemoved = [];
    const allTitles = new Set([...oldProse.keys(), ...newProse.keys()]);
    for (const title of allTitles) {
      const o = oldProse.get(title) || [], n = newProse.get(title) || [];
      const oSet = new Set(o.map(norm)), nSet = new Set(n.map(norm));
      for (const b of n) if (!oSet.has(norm(b))) proseAdded.push({ kind: 'prose', section: title, text: b.slice(0, 240) });
      for (const b of o) if (!nSet.has(norm(b))) proseRemoved.push({ kind: 'prose', section: title, text: b.slice(0, 240) });
    }
    const prose = { added: proseAdded, removed: proseRemoved };
    const proseCounts = { added: proseAdded.length, removed: proseRemoved.length };
    const proseEmpty = proseCounts.added + proseCounts.removed === 0;
    const proseSections = [...new Set([...proseAdded, ...proseRemoved].map(e => e.section))];

    // Diagnostics: how many anchor-diffable items each side actually had. old=0 AND
    // new=0 means the anchor diff never stood a chance — its 0/0/0 says nothing.
    const rowsOf = (t) => (t && t.rows) ? t.rows.length : 0;
    const anchorCount = (s) => (s.stories || []).length + rowsOf(s.nfr) + rowsOf(s.businessLogic) + rowsOf(s.stateTable);
    const anchors = { old: anchorCount(oldSrs), new: anchorCount(newSrs) };

    // emptyChangeset is the resync wrong-input gate: only true when BOTH layers saw
    // nothing. Anchor-empty + prose-changes = a genuine revision of an anchor-free SRS.
    const empty = anchorEmpty && proseEmpty;
    const hint = empty
      ? `0 changes vs snapshot "${path.basename(oldPath)}" — this doc may not be a revision of the tracked feature. If it's a new/different feature use /sf:ingest; for a spec tweak use /sf:change. Only continue resync if you expected an empty delta.`
      : (anchorEmpty && !proseEmpty)
        ? `anchor-level diff found nothing (diffable anchors: old=${anchors.old}, new=${anchors.new}) but prose-level diff found ${proseCounts.added} added / ${proseCounts.removed} removed bullet(s) in section(s): ${proseSections.slice(0, 6).join(' · ')}. This IS a revision — feed data.prose to sd-author; trace-impact accepts this result file directly via --changeset (it harvests FR-/TC-/ERR_ ids mentioned in the changed text).`
        : null;
    return ok({
      changeset, counts,
      prose, proseCounts, proseSections,
      anchors,
      emptyChangeset: empty,
      hint,
      note: 'best-effort: SRS is free-form; treat as hint for sd-author. The SD is the authoritative controlled artifact.',
    });
  },

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
  // state-update  [--feature f] [--note "..."]
  // Write/refresh .spec-flow/STATE.md — a <100-line living index.
  // -----------------------------------------------------------------------
  'state-update'(args) {
    const feature = args.feature || null;
    const note = args.note || null;
    const now = new Date().toISOString();

    // Try to read trace for task counts and feature name (per-feature durable copy
    // when --feature is given, else the active-feature mirror).
    const trace = readTrace(feature);
    const traceTasks = (trace && trace.nodes && trace.nodes.tasks) || [];
    const featureName = feature || (trace && trace.feature) || 'unknown';

    // Also try Task Master tasks.json
    const tmCandidates = [
      path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json'),
    ];
    let tmTasks = null;
    for (const c of tmCandidates) {
      if (fs.existsSync(c)) { tmTasks = readJsonSafe(c, null); break; }
    }

    // Count tasks by status
    let taskCountsByStatus = {};
    let totalTasks = 0;
    if (tmTasks) {
      const rawTasks = readTmTasks(tmTasks, featureName === 'unknown' ? undefined : featureName);
      totalTasks = rawTasks.length;
      for (const t of rawTasks) {
        const s = t.status || 'unknown';
        taskCountsByStatus[s] = (taskCountsByStatus[s] || 0) + 1;
      }
    } else if (traceTasks.length) {
      totalTasks = traceTasks.length;
      for (const t of traceTasks) {
        const s = t.status || 'unknown';
        taskCountsByStatus[s] = (taskCountsByStatus[s] || 0) + 1;
      }
    }

    // Compute rough "current position"
    const done = taskCountsByStatus.done || 0;
    const inProgress = taskCountsByStatus['in-progress'] || taskCountsByStatus.inprogress || 0;
    const pending = taskCountsByStatus.pending || taskCountsByStatus.todo || 0;
    const review = taskCountsByStatus.review || 0;

    let position = 'No tasks tracked';
    if (totalTasks > 0) {
      const pct = Math.round((done / totalTasks) * 100);
      position = `${done}/${totalTasks} tasks done (${pct}%)`;
      if (inProgress > 0) position += ` · ${inProgress} in-progress`;
      if (review > 0) position += ` · ${review} in-review`;
    }

    // Derive blockers (tasks in review state hint at potential blockers)
    const blockers = [];
    if (tmTasks) {
      const rawTasks = readTmTasks(tmTasks, featureName === 'unknown' ? undefined : featureName);
      for (const t of rawTasks) {
        if (t.status === 'review' || t.status === 'blocked') {
          blockers.push(`task #${t.id} "${t.title || ''}" [${t.status}]`);
        }
      }
    }

    // Counts from trace
    const trFr = (trace && trace.nodes && trace.nodes.fr) ? trace.nodes.fr.length : 0;
    const trTc = (trace && trace.nodes && trace.nodes.tc) ? trace.nodes.tc.length : 0;
    const trLinks = (trace && trace.links) ? trace.links.length : 0;

    const statusLines = Object.entries(taskCountsByStatus)
      .map(([s, n]) => `  ${s}: ${n}`)
      .join('\n') || '  (none)';

    // ---- Deterministic NEXT STEP (re-orients the agent after context loss) ----
    // Decision ladder driven purely by artifacts on disk — no AI, no guessing.
    const sdPath = path.join(process.cwd(), PATHS.specs, featureName, 'SD.md');
    const checklistPath = path.join(process.cwd(), PATHS.specs, featureName, 'CHECKLIST.yaml');
    const verificationPath = path.join(process.cwd(), PATHS.specs, featureName, 'VERIFICATION.md');
    let nextStep;
    if (featureName === 'unknown' || !fs.existsSync(sdPath)) {
      nextStep = 'No SD — run `/sf:ingest <srs>`.';
    } else {
      let sdTodos = 0;
      try { sdTodos = countSdTodos(fs.readFileSync(sdPath, 'utf8')); } catch {}
      if (sdTodos > 0) {
        nextStep = `SD has ${sdTodos} \`TODO:MANUAL-REVIEW\` — clear + approve, then \`/sf:checklist ${featureName}\` (no \`parse_prd\` until 0).`;
      } else if (!fs.existsSync(checklistPath)) {
        nextStep = `SD clean — \`/sf:checklist ${featureName}\`.`;
      } else if (totalTasks === 0) {
        nextStep = `\`/sf:phase ${featureName}\` — it seeds tasks (parse-prd, agent-run) then implements.`;
      } else if (pending + inProgress > 0) {
        nextStep = `\`/sf:phase ${featureName}\` — ${pending} pending · ${inProgress} wip${review ? ` · ${review} review (\`/sf:phase\` re-drives these first)` : ''}.`;
      } else if (review > 0) {
        nextStep = `${review} task(s) in \`review\` — \`/sf:phase ${featureName}\` picks them up first (re-run smoke → close if passed, re-attempt if failed). next_task alone skips review, so re-running the loop is correct, not a no-op.`;
      } else {
        let verified = false;
        try { verified = /status:\s*passed/i.test(fs.readFileSync(verificationPath, 'utf8')); } catch {}
        nextStep = verified
          ? 'Done + verified — ship: stage, then `commit` skill (push).'
          : `Done — \`/sf:manual-test ${featureName}\` (runs smoke + regression + records VERIFICATION).`;
      }
    }

    const L = [];
    L.push(`# STATE — ${featureName}`);
    L.push('');
    L.push(`> Generated: ${now}`);
    L.push('');
    L.push('## Position');
    L.push('');
    L.push(`- Feature: **${featureName}**`);
    L.push(`- Progress: ${position}`);
    if (note) L.push(`- Note: ${note}`);
    L.push('');
    L.push('## Next Step');
    L.push('');
    L.push(`- ${nextStep}`);
    L.push('');
    L.push('## Task Counts by Status');
    L.push('');
    L.push(statusLines);
    L.push('');
    if (trFr || trTc) {
      L.push('## Trace Coverage');
      L.push('');
      L.push(`- FR: ${trFr} · TC: ${trTc} · Links: ${trLinks}`);
      L.push('');
    }
    if (blockers.length) {
      L.push('## Blockers');
      L.push('');
      for (const b of blockers) L.push(`- ${b}`);
      L.push('');
    } else {
      L.push('## Blockers');
      L.push('');
      L.push('- (none)');
      L.push('');
    }
    L.push('## Last Activity');
    L.push('');
    L.push(`- ${now}${note ? ' — ' + note : ''}`);
    L.push('');

    // Keep under ~100 lines — truncate task counts if huge
    const stateContent = L.join('\n');
    const lineCount = L.length;

    ensureDir(PATHS.stateDir);
    try { fs.writeFileSync(STATE_FILE, stateContent); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }

    return ok({ state: STATE_FILE, lines: lineCount, nextStep });
  },

  // -----------------------------------------------------------------------
  // wave-plan  [--max <n>]
  // Dependency-aware visibility: which pending tasks are workable NOW.
  // Reads .taskmaster/tasks/tasks.json (tagged or flat) and returns the READY
  // SET — pending tasks whose every dependency is already done — capped at
  // --max (default 3). Pure, no AI. A planning/visibility helper; the agent may
  // also use it as a correctness check before working tasks concurrently.
  // Returns ok({ ready:[{id,title,deps}], readyCount, blockedCount, inProgressCount, doneCount, total, max }).
  // -----------------------------------------------------------------------
  'wave-plan'(args) {
    const tmPath = path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
    // Per-feature tag isolation (same as status-report/state-update): read the
    // active feature's own task space, not master's. --feature/--tag, else trace.json.
    const feature = args.feature || args.tag || (readJsonSafe(PATHS.trace, null) || {}).feature || undefined;
    const tasks = readTmTasks(readJsonSafe(tmPath, null), feature);
    if (!tasks.length) return ok({ ready: [], readyCount: 0, blockedCount: 0, inProgressCount: 0, doneCount: 0, total: 0, max: 0, note: 'no tasks (run parse-prd first)' });

    const max = Math.max(1, parseInt(args.max, 10) || 3);

    const norm = (s) => String(s || '').toLowerCase();
    const isDone = (s) => norm(s) === 'done';
    const doneIds = new Set(tasks.filter((t) => isDone(t.status)).map((t) => String(t.id)));

    let doneCount = 0, inProgressCount = 0, pendingCount = 0;
    const readyAll = [];
    for (const t of tasks) {
      const s = norm(t.status);
      if (s === 'done') { doneCount++; continue; }
      if (s === 'in-progress' || s === 'inprogress') inProgressCount++;
      if (s === 'pending' || s === 'todo' || s === '') {
        pendingCount++;
        const deps = (t.dependencies || []).map(String);
        if (deps.every((d) => doneIds.has(d))) {
          readyAll.push({ id: t.id, title: t.title || '', deps });
        }
      }
    }
    const ready = readyAll.slice(0, max);
    return ok({
      ready,
      readyCount: ready.length,
      readyTotal: readyAll.length,
      blockedCount: pendingCount - readyAll.length,
      inProgressCount,
      doneCount,
      total: tasks.length,
      max,
    });
  },

  // -----------------------------------------------------------------------
  // task-baseline  --feature <f>  [--apply]
  //
  // Backfill bridge. A feature implemented BEFORE its SD was ingested has no
  // task-status ledger: parse-prd seeds everything as `pending` and an executor
  // could re-implement (or overwrite) already-shipped scope. This marks tasks
  // `done` from EVIDENCE only — a task qualifies iff its evidence set (the TCs
  // of every FR it implements, plus TCs named in its own text) is non-empty and
  // every one of them is recorded `verified` in VERIFICATION.md (the
  // /sf:manual-test gate output). SD prose / status labels are NEVER consulted:
  // done means evidence, not claim. No VERIFICATION.md → nothing baselines —
  // the manual-test gate stays the only door to `done`.
  //
  // Task→FR mapping, strongest first:
  //   1. fr-task links in trace.json (recorded via trace-link during /sf:phase)
  //   2. fallback: FR-/TC- ids mentioned in the task's own title/description/
  //      details/testStrategy (deterministic text scan — parse-prd tasks carry
  //      the SD's FR ids). The report says which source mapped each task.
  //
  // Dry-run by default (proposal for human review); --apply writes tasks.json
  // (status=done + an evidence note in details). Only `pending` tasks move.
  // -----------------------------------------------------------------------
  'task-baseline'(args) {
    const feature = args.feature || (readJsonSafe(PATHS.trace, null) || {}).feature;
    if (!feature) return err('MISSING_ARG: --feature <feature>');
    const trace = readTrace(feature);
    if (!trace) return err('NO_TRACE: run trace-build first');

    const verPath = path.join(STATE_DIR, 'specs', feature, 'VERIFICATION.md');
    if (!fs.existsSync(verPath)) {
      return ok({
        feature, applied: false, baselined: [], skipped: [], verifiedTcs: [],
        note: 'no VERIFICATION.md — run /sf:manual-test first; task-baseline only trusts recorded evidence',
      });
    }
    const verifiedTcs = new Set();
    for (const m of fs.readFileSync(verPath, 'utf8').matchAll(/^\s*-\s*(TC-\d+)\s*:\s*verified\b/gim)) {
      verifiedTcs.add(m[1].toUpperCase());
    }

    const frToTcs = new Map();   // FR → Set(TC)
    const taskToFrs = new Map(); // task id → Set(FR) (from trace fr-task links)
    for (const l of trace.links || []) {
      if (l.type === 'fr-tc') {
        if (!frToTcs.has(l.from)) frToTcs.set(l.from, new Set());
        frToTcs.get(l.from).add(String(l.to).toUpperCase());
      }
      if (l.type === 'fr-task') {
        const t = String(l.to);
        if (!taskToFrs.has(t)) taskToFrs.set(t, new Set());
        taskToFrs.get(t).add(l.from);
      }
    }

    const tmPath = path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
    const tmRaw = readJsonSafe(tmPath, null);
    const tasks = readTmTasks(tmRaw, feature);
    if (!tasks.length) return err('NO_TASKS: seed tasks first (parse-prd --tag <feature>), then baseline');

    const baselined = [], skipped = [];
    for (const t of tasks) {
      const id = String(t.id);
      const status = String(t.status || '').toLowerCase();
      if (status !== 'pending') { skipped.push({ id, reason: `status=${status} (only pending tasks baseline)` }); continue; }

      let frs = [...(taskToFrs.get(id) || [])];
      let mappedVia = frs.length ? 'trace fr-task link' : null;
      const text = [t.title, t.description, t.details, t.testStrategy].filter(Boolean).join(' ');
      if (!frs.length) {
        frs = [...new Set((text.match(/\bFR-\d+\b/gi) || []).map(s => s.toUpperCase()))];
        if (frs.length) mappedVia = 'task text mention';
      }
      const tcSet = new Set(frs.flatMap(fr => [...(frToTcs.get(fr) || [])]));
      for (const m of text.match(/\bTC-\d+\b/gi) || []) tcSet.add(m.toUpperCase());
      const tcs = [...tcSet];
      if (!tcs.length) { skipped.push({ id, reason: 'no evidence set (no fr-task link, no FR/TC id in task text)' }); continue; }
      const unverified = tcs.filter(tc => !verifiedTcs.has(tc));
      if (unverified.length) { skipped.push({ id, reason: `unverified TCs: ${unverified.join(', ')}` }); continue; }
      baselined.push({ id, title: t.title || '', frs, tcs, mappedVia });
    }

    if (args.apply && baselined.length) {
      const stamp = new Date().toISOString().slice(0, 10);
      const byId = new Map(tasks.map(t => [String(t.id), t]));
      for (const b of baselined) {
        const t = byId.get(b.id);
        t.status = 'done';
        const note = `baselined from VERIFICATION ${stamp} (evidence: ${b.tcs.join(', ')})`;
        t.details = t.details ? `${t.details}\n${note}` : note;
      }
      fs.writeFileSync(tmPath, JSON.stringify(tmRaw, null, 2));
    }

    return ok({
      feature,
      applied: !!(args.apply && baselined.length),
      verifiedTcs: [...verifiedTcs],
      baselined, skipped,
      note: args.apply ? null : 'dry-run — review the proposal, then re-run with --apply',
    });
  },

  // -----------------------------------------------------------------------
  // epic-new  --name <epic-name>  [--subs "subA,subB,subC"]
  //
  // Write .spec-flow/epics/<slug>.md describing the epic and its sub-features.
  // Idempotent: if the file already exists, report alreadyExists (never overwrite).
  // Returns ok({ epic, path, subs }) or ok({ alreadyExists: true, epic, path }).
  // -----------------------------------------------------------------------
  'epic-new'(args) {
    const name = args.name;
    if (!name) return err('MISSING_ARG: --name <epic-name>');

    const epicSlug = slugify(name);
    const epicsDir = path.join(STATE_DIR, 'epics');
    ensureDir(epicsDir);

    const epicPath = path.join(epicsDir, `${epicSlug}.md`);
    if (fs.existsSync(epicPath)) {
      return ok({ alreadyExists: true, epic: epicSlug, path: epicPath });
    }

    // Parse sub-feature names
    const rawSubs = args.subs ? String(args.subs).split(',').map(s => s.trim()).filter(Boolean) : [];
    const subs = rawSubs.map(subName => ({
      name: subName,
      slug: slugify(subName),
      status: 'pending',
      sdPath: `${epicSlug}-${slugify(subName)}/SD.md`,
    }));

    const now = new Date().toISOString();
    const lines = [];
    lines.push(`# Epic: ${name}`);
    lines.push('');
    lines.push('<!-- spec-flow epic record -->');
    lines.push(`id: ${epicSlug}`);
    lines.push(`name: ${name}`);
    lines.push(`created: ${now}`);
    lines.push(`status: active`);
    lines.push('');
    lines.push('## Sub-features');
    lines.push('');
    if (subs.length) {
      for (const sub of subs) {
        lines.push(`- **${sub.name}**`);
        lines.push(`  - status: ${sub.status}`);
        lines.push(`  - sd: \`${sub.sdPath}\``);
        lines.push('');
      }
    } else {
      lines.push('> No sub-features defined yet. Run epic-new again with --subs "subA,subB,..." or add manually.');
      lines.push('');
    }

    const content = lines.join('\n');
    try { fs.writeFileSync(epicPath, content); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }

    return ok({ epic: epicSlug, path: epicPath, subs });
  },

  // -----------------------------------------------------------------------
  // epic-list
  // List .spec-flow/epics/*.md with id + name + status + subCount.
  // Returns ok({ epics: [{ id, name, status, subCount }] }).
  // -----------------------------------------------------------------------
  'epic-list'(args) {
    const epicsDir = path.join(STATE_DIR, 'epics');
    ensureDir(epicsDir);
    let files;
    try { files = fs.readdirSync(epicsDir).filter(f => f.endsWith('.md')).sort(); }
    catch (e) { return err(`READ_FAILED: ${e.message}`); }

    const epics = [];
    for (const f of files) {
      const epicPath = path.join(epicsDir, f);
      let content = '';
      try { content = fs.readFileSync(epicPath, 'utf8'); } catch { continue; }
      // Parse simple frontmatter-ish fields
      const field = (key) => {
        const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return m ? m[1].trim() : null;
      };
      // Count sub-features: lines starting with "- **"
      const subCount = (content.match(/^- \*\*/gm) || []).length;
      epics.push({
        id: field('id') || path.basename(f, '.md'),
        name: field('name') || path.basename(f, '.md'),
        status: field('status') || 'unknown',
        subCount,
      });
    }

    return ok({ epics });
  },

  // -----------------------------------------------------------------------
  // bug-new  --desc "<text>" [--severity low|med|high|critical]
  //          [--repro "<steps>"] [--expected "<>"] [--actual "<>"]
  //          [--feature <f>]
  // Create a new bug record at .spec-flow/bugs/<NNN>-bug-<slug>.md (id stays bug-NNN).
  // Returns ok({ id, path, severity }).
  // -----------------------------------------------------------------------
  'bug-new'(args) {
    const desc = args.desc;
    if (!desc) return err('MISSING_ARG: --desc "<description>"');

    const VALID_SEVERITIES = ['low', 'med', 'high', 'critical'];
    const severity = VALID_SEVERITIES.includes(args.severity) ? args.severity : 'med';
    const feature = args.feature || null;
    const repro = args.repro || null;
    const expected = args.expected || null;
    const actual = args.actual || null;

    ensureDir(PATHS.bugs);

    // Assign id bug-NNN by counting existing files.
    // Filename is NNN-bug-<slug>.md — number-first so files sort in creation order,
    // plus a short slug from --desc so the file is recognisable at a glance.
    // The internal `id` stays bug-NNN (short, stable handle for traceability refs).
    let existingCount = 0;
    try { existingCount = fs.readdirSync(PATHS.bugs).filter(f => f.endsWith('.md')).length; } catch {}
    const num = String(existingCount + 1).padStart(3, '0');
    const id = `bug-${num}`;
    const shortSlug = slugify(desc).split('-').slice(0, 6).join('-') || 'bug';
    const bugPath = path.join(PATHS.bugs, `${num}-bug-${shortSlug}.md`);

    const now = new Date().toISOString();
    const lines = [];
    lines.push(`# Bug Report: ${id}`);
    lines.push('');
    lines.push('<!-- spec-flow bug record — do not edit id/created fields manually -->');
    lines.push(`id: ${id}`);
    lines.push(`created: ${now}`);
    lines.push(`severity: ${severity}`);
    lines.push(`status: open`);
    lines.push(`feature: ${feature || 'TBD'}`);
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(desc);
    lines.push('');
    lines.push('## Repro Steps');
    lines.push('');
    lines.push(repro || '> TODO: fill in reproduction steps');
    lines.push('');
    lines.push('## Expected Behaviour');
    lines.push('');
    lines.push(expected || '> TODO: what should happen');
    lines.push('');
    lines.push('## Actual Behaviour');
    lines.push('');
    lines.push(actual || '> TODO: what actually happens');
    lines.push('');
    lines.push('## Triage (code-bug | spec-bug | srs-level): TBD');
    lines.push('');
    lines.push('> Decide: is the SD correct and the code wrong (code-bug)?');
    lines.push('> Or is the SD itself wrong/incomplete (spec-bug → hand off to /sf:change)?');
    lines.push('> Or is this a product/requirement misunderstanding (srs-level → hand off to /sf:resync)?');
    lines.push('');
    lines.push('## Linked (FR/TC/file): TBD');
    lines.push('');
    lines.push('> Populate after running: flow-tools trace-impact --keywords "<terms>"');
    lines.push('');
    lines.push('## Resolution log:');
    lines.push('');
    lines.push('> Record each fix attempt with timestamp, what was changed, and whether the repro test passed.');
    lines.push('');

    const content = lines.join('\n');
    try { fs.writeFileSync(bugPath, content); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }

    return ok({ id, path: bugPath, severity });
  },

  // -----------------------------------------------------------------------
  // branch-ensure --kind sd|bug|change [--name <feature>] [--id <id>]
  //               [--slug <slug>] [--type fix|enhance] [--repos "a,b"]
  // Deterministic branch policy for spec-flow lifecycle events.
  // Reads config.branching. Creates/switches a feature branch ONLY when the
  // current branch is the configured base — otherwise it is a safe no-op
  // (never switches away from an existing feature branch or a dirty tree).
  // Templates live in config (VCS-agnostic DATA); engine just substitutes.
  // Returns ok({ branch, action, base, mode }) where action ∈
  //   created | switched | already-on | kept   (or { skipped:true } when off).
  // -----------------------------------------------------------------------
  'branch-ensure'(args) {
    const { execSync } = require('child_process');

    const cfg = readJsonSafe(PATHS.config, null);
    const branching = cfg && cfg.branching;
    if (!branching || branching.mode === 'off') {
      return ok({ skipped: true, reason: branching ? 'mode=off' : 'no branching config', mode: branching ? branching.mode : null });
    }

    const VALID_KINDS = ['sd', 'bug', 'change'];
    const kind = args.kind;
    if (!VALID_KINDS.includes(kind)) return err('MISSING_ARG: --kind sd|bug|change');

    const tpl = (branching.templates || {})[kind];
    if (!tpl) return err(`NO_TEMPLATE: config.branching.templates.${kind} not set`);

    // Substitute template vars; slugify values, keep template separators.
    const vars = {
      feature: args.name ? slugify(args.name) : '',
      id: args.id ? slugify(args.id) : '',
      slug: args.slug ? slugify(args.slug) : '',
      type: args.type ? slugify(args.type) : 'fix',
    };
    // Guard required identity per kind BEFORE substituting — else a missing --name
    // collapses `feat/{feature}` → `feat/` → tidy → `feat`, silently branching `feat`
    // (the tidy step strips the trailing slash so the endsWith('/') guard misses it).
    const REQUIRED = { sd: ['feature'], bug: ['id', 'slug'], change: ['id'] };
    for (const need of (REQUIRED[kind] || [])) {
      if (!vars[need]) {
        const flag = need === 'feature' ? '--name' : `--${need}`;
        return err(`MISSING_ARG: ${flag} required for kind=${kind}`);
      }
    }
    let target = tpl.replace(/\{(feature|id|slug|type)\}/g, (_, k) => vars[k]);
    // Tidy any empty segments left by missing vars (e.g. "fix/-cart" → "fix/cart").
    target = target.replace(/-{2,}/g, '-').replace(/\/-+/g, '/').replace(/-+\//g, '/').replace(/-+$/g, '').replace(/\/+$/, '');
    if (!target || target.endsWith('/')) return err(`BAD_BRANCH_NAME: resolved "${target}" from template "${tpl}"`);

    const base = branching.base || 'main';

    // Ensure the branch in ONE repo root (cwd-scoped git). Same policy everywhere:
    // create/switch only when on base; never switch away from a feature branch.
    const ensureIn = (rootDir) => {
      const git = (cmd) => execSync(`git ${cmd}`, { cwd: rootDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
      let current;
      try { current = git('rev-parse --abbrev-ref HEAD'); }
      catch (e) {
        if (/ambiguous argument 'HEAD'|unknown revision/i.test(e.message)) return { error: 'NO_COMMITS' };
        return { error: 'NOT_A_GIT_REPO' };
      }
      if (current === target) return { branch: target, action: 'already-on' };
      if (current !== base) return { branch: current, action: 'kept', note: `not on base (${base})` };
      let exists = false;
      try { git(`show-ref --verify --quiet refs/heads/${target}`); exists = true; } catch { exists = false; }
      try {
        git(exists ? `checkout ${target}` : `checkout -b ${target}`);
        return { branch: target, action: exists ? 'switched' : 'created' };
      } catch (e) { return { error: `CHECKOUT_FAILED: ${e.message}` }; }
    };

    // Multi-repo: branch each code repo (one feat/<feature> per service → clean
    // PR-per-service). Single-repo: just cwd (backward compat, flat result shape).
    const roots = resolveRepos(cfg);

    // Scope (multi-repo): a feature usually targets only SOME of config.repos. Without
    // a filter, branching fans out to ALL — creating stray feat/<feature> branches on
    // unrelated services and missing the one the feature actually targets. Resolve a
    // filter from (highest precedence first):
    //   1. --repos "a,b"  → comma-separated repo NAMES (same name-filter semantics as
    //                       verify-code's --repos; NOT the name=path form).
    //   2. the feature's declared repo subset (trace.json.repos, set via trace-repos) —
    //      the only signal available at branch time, before any code/file-links exist.
    // No filter at all → all repos (full backward compat). Single-repo (name null) is
    // always kept, so a filter on a single-repo project is a harmless no-op.
    let repoFilter = (typeof args.repos === 'string' && args.repos.trim())
      ? new Set(args.repos.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    let filterSource = repoFilter ? '--repos' : null;
    if (!repoFilter) {
      const feat = args.feature || (kind === 'sd' ? args.name : null) || (readJsonSafe(PATHS.trace, null) || {}).feature || null;
      if (feat) {
        const tr = readTrace(feat);
        if (tr && Array.isArray(tr.repos) && tr.repos.length) { repoFilter = new Set(tr.repos); filterSource = `feature ${feat}`; }
      }
    }
    const scopedRoots = repoFilter ? roots.filter((r) => !r.name || repoFilter.has(r.name)) : roots;
    if (repoFilter && !scopedRoots.length) {
      const known = roots.map((r) => r.name).filter(Boolean).join(', ') || '(none)';
      return err(`REPO_NOT_CONFIGURED: [${[...repoFilter].join(', ')}] (via ${filterSource}) matches no config.repos entry (known: ${known}). Add it to config.repos first.`);
    }

    if (scopedRoots.length === 1 && !scopedRoots[0].name) {
      const r = ensureIn(scopedRoots[0].root);
      if (r.error === 'NO_COMMITS') return err('NO_COMMITS: git repo has no commits yet — make an initial commit before branching');
      if (r.error === 'NOT_A_GIT_REPO') return err('NOT_A_GIT_REPO');
      if (r.error) return err(r.error);
      return ok({ ...r, base, mode: branching.mode });
    }
    const results = scopedRoots.map((rp) => ({ repo: rp.name, ...ensureIn(rp.root) }));
    // Failures must speak: if EVERY repo errored, this is a hard failure (not ok:true
    // with errors buried in the array). If only some errored, stay ok but surface them.
    const errored = results.filter((r) => r.error);
    if (errored.length === results.length) {
      return err(`BRANCH_ENSURE_FAILED (all repos): ${errored.map((r) => `${r.repo}:${r.error}`).join('; ')}`);
    }
    const out = { branch: target, base, mode: branching.mode, repos: results };
    if (errored.length) out.warnings = errored.map((r) => `${r.repo}: ${r.error}`);
    return ok(out);
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
    const vcFeature = args.feature || (readJsonSafe(PATHS.trace, null) || {}).feature || null;
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

    const result = { checks, summary, gate, repos: scopedRoots.map((r) => r.name).filter(Boolean), scope: scopeNote };
    if (scopeWarnings.length) result.scopeWarnings = scopeWarnings;
    const testScoped = checks.some((c) => c.scoped);
    result.testsScoped = testScoped;
    if (!testScoped && taskFiles.length) {
      result.scopeNoteTests = 'requested test scoping (--task/--files) but could not derive a filter for this stack/these files — ran the full suite.';
    }
    return ok(result);
  },

  // -----------------------------------------------------------------------
  // bug-list
  // List .spec-flow/bugs/*.md with id + status + severity.
  // Returns ok({ bugs: [{ id, status, severity, feature, desc }] }).
  // -----------------------------------------------------------------------
  'bug-list'(args) {
    ensureDir(PATHS.bugs);
    let files;
    try { files = fs.readdirSync(PATHS.bugs).filter(f => f.endsWith('.md')).sort(); }
    catch (e) { return err(`READ_FAILED: ${e.message}`); }

    const bugs = [];
    for (const f of files) {
      const bugPath = path.join(PATHS.bugs, f);
      let content = '';
      try { content = fs.readFileSync(bugPath, 'utf8'); } catch { continue; }
      // Parse simple frontmatter-ish fields (lines like "key: value" near top)
      const field = (key) => {
        const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return m ? m[1].trim() : null;
      };
      // Grab first non-empty line after "## Description"
      const descMatch = content.match(/##\s+Description\s*\n+([^\n#][^\n]*)/);
      const desc = descMatch ? descMatch[1].trim() : null;
      bugs.push({
        id: field('id') || path.basename(f, '.md'),
        status: field('status') || 'unknown',
        severity: field('severity') || 'unknown',
        feature: field('feature') || null,
        desc,
      });
    }

    return ok({ bugs });
  },

  // -----------------------------------------------------------------------
  // status-report  [--feature <f>]
  // Pure read — no disk writes. Aggregates project status from existing files.
  // Returns ok({ project, branch, feature, sd, tasks, trace, ready, verified,
  //              bugsOpen, changesOpen, latestSnapshot, nextStep }).
  // -----------------------------------------------------------------------
  'status-report'(args) {
    const { execSync } = require('child_process');

    // Config
    const cfg = readJsonSafe(PATHS.config, {});
    const project = cfg.project || path.basename(process.cwd());
    let branch = null;
    try { branch = execSync('git branch --show-current', { stdio: 'pipe', timeout: 3000 }).toString().trim(); } catch {}

    // Feature — from arg, else the active-feature mirror's hint.
    const globalTrace = readJsonSafe(PATHS.trace, null);
    let featureName = args.feature || (globalTrace && globalTrace.feature) || null;
    // Fallback: an SD on disk with no trace.json yet (ingest interrupted before
    // trace-build) — detect the feature from specs/ so /sf:status can still resume it.
    if (!featureName && fs.existsSync(PATHS.specs)) {
      try {
        const sdDirs = fs.readdirSync(PATHS.specs).filter(d => fs.existsSync(path.join(PATHS.specs, d, 'SD.md')));
        if (sdDirs.length) featureName = sdDirs[sdDirs.length - 1];
      } catch {}
    }
    // Read THE FEATURE's durable trace — the global mirror may reflect a different
    // last-built feature, so resolve per-feature once featureName is known.
    const trace = readTrace(featureName) || globalTrace;

    // SD info
    const sdPath = featureName ? path.join(PATHS.specs, featureName, 'SD.md') : null;
    let sdTodos = null;
    let sdExists = false;
    if (sdPath && fs.existsSync(sdPath)) {
      sdExists = true;
      try { sdTodos = countSdTodos(fs.readFileSync(sdPath, 'utf8')); } catch {}
    }

    // Trace counts
    const frCount  = trace ? (trace.nodes && trace.nodes.fr  ? trace.nodes.fr.length  : 0) : null;
    const tcCount  = trace ? (trace.nodes && trace.nodes.tc  ? trace.nodes.tc.length  : 0) : null;
    const nfrCount = trace ? (trace.nodes && trace.nodes.nfr ? trace.nodes.nfr.length : 0) : null;
    const links    = trace ? (trace.links ? trace.links.length : 0) : null;

    // Task counts
    const tmPath = path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
    const tmRaw  = fs.existsSync(tmPath) ? readJsonSafe(tmPath, null) : null;
    const tmTasks = tmRaw ? readTmTasks(tmRaw, featureName) : [];
    const taskCounts = { done: 0, inProgress: 0, pending: 0, review: 0, blocked: 0, total: tmTasks.length };
    const doneIds = new Set();
    for (const t of tmTasks) {
      const s = String(t.status || '').toLowerCase();
      if (s === 'done') { taskCounts.done++; doneIds.add(String(t.id)); }
      else if (s === 'in-progress' || s === 'inprogress') taskCounts.inProgress++;
      else if (s === 'pending' || s === 'todo' || s === '') taskCounts.pending++;
      else if (s === 'review') taskCounts.review++;
      else if (s === 'blocked') taskCounts.blocked++;
    }

    // Ready-now tasks (dep-unblocked pending tasks, capped at 3)
    const ready = [];
    for (const t of tmTasks) {
      if (ready.length >= 3) break;
      const s = String(t.status || '').toLowerCase();
      if (s === 'pending' || s === 'todo' || s === '') {
        const deps = (t.dependencies || []).map(String);
        if (deps.every(d => doneIds.has(d))) ready.push({ id: t.id, title: t.title || '' });
      }
    }

    // Verification status + any declared live gaps. Transparent: a verified-adhoc
    // ship with open "not verified live" items must be VISIBLE in /sf:status, not
    // buried in VERIFICATION prose (else it's forgotten at merge). Convention: bullet
    // lines under a "Deferred / Not verified live / Live gaps" heading.
    const verifPath = featureName ? path.join(process.cwd(), PATHS.specs, featureName, 'VERIFICATION.md') : null;
    let verified = null;
    let verifiedGaps = [];
    if (verifPath && fs.existsSync(verifPath)) {
      try {
        const vc = fs.readFileSync(verifPath, 'utf8');
        verified = /status:\s*passed/i.test(vc);
        const gm = vc.match(/^#{1,6}\s*(?:deferred|not[- ]verified[- ]live|live gaps?)\b.*$/im);
        if (gm) {
          const after = vc.slice(vc.indexOf(gm[0]) + gm[0].length);
          const stop = after.search(/^#{1,6}\s/m);
          verifiedGaps = (stop >= 0 ? after.slice(0, stop) : after)
            .split(/\r?\n/).map(l => l.match(/^\s*[-*]\s+(.*\S)\s*$/)).filter(Boolean).map(m => m[1].slice(0, 80));
        }
      } catch {}
    }

    // Latest SRS snapshot
    let latestSnapshot = null;
    if (featureName && fs.existsSync(PATHS.snapshots)) {
      const snaps = fs.readdirSync(PATHS.snapshots)
        .filter(f => f.startsWith(featureName + '-') && f.endsWith('.md'))
        .sort();
      if (snaps.length) latestSnapshot = path.join(PATHS.snapshots, snaps[snaps.length - 1]);
    }

    // Open bugs (status: open) and changes (status: active) — exclude done/closed.
    // Returns [{ id, desc }] so /sf:status can list what's open, not just a count.
    const collectOpenMd = (dir, openStatus) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf8');
          const sm = content.match(/^status:\s*(\S+)/m);
          if (!sm || sm[1] !== openStatus) return null;
          const idm = content.match(/^id:\s*(\S+)/m);
          let desc = '';
          const dm = content.match(/^##\s*Description\s*$\n+([^\n]+)/m) || content.match(/^description:\s*(.+)$/m);
          if (dm) desc = dm[1].trim().replace(/^>+\s*/, '');
          if (!desc || /^TODO/i.test(desc)) desc = f.replace(/^\d+-(bug|change)-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
          return { id: idm ? idm[1] : f.replace(/\.md$/, ''), desc: desc.slice(0, 70) };
        } catch { return null; }
      }).filter(Boolean);
    };
    const bugsOpenList   = collectOpenMd(PATHS.bugs,    'open');
    const changesOpenList = collectOpenMd(PATHS.changes, 'active');
    const bugsOpen   = bugsOpenList.length;
    const changesOpen = changesOpenList.length;

    // Checkpoint — surface if mid-task context was saved
    let checkpoint = null;
    if (featureName) {
      const cpPath = path.join(process.cwd(), PATHS.specs, featureName, 'checkpoint.md');
      if (fs.existsSync(cpPath)) {
        try {
          const cpText = fs.readFileSync(cpPath, 'utf8');
          const taskM = cpText.match(/^task:\s*(.+)$/m);
          const phaseM = cpText.match(/^phase:\s*(.+)$/m);
          const nextM = cpText.match(/^## Next\s*\n([\s\S]*?)(?=\n##|$)/m);
          checkpoint = {
            task: taskM ? taskM[1].trim() : '(unknown)',
            phase: phaseM ? phaseM[1].trim() : null,
            next: nextM ? nextM[1].trim().slice(0, 120) : null,
          };
        } catch {}
      }
    }

    // Checklist status — quick scan without reusing checklist-status command to avoid coupling.
    // Reports: absent | scaffold (N TODO) | ready | (n/a — no feature)
    let checklistStatus = null; // null = no feature/SD context
    const checklistPath = featureName ? path.join(process.cwd(), PATHS.specs, featureName, 'CHECKLIST.yaml') : null;
    if (checklistPath) {
      if (!fs.existsSync(checklistPath)) {
        checklistStatus = 'absent';
      } else {
        try {
          const clText = fs.readFileSync(checklistPath, 'utf8');
          // Strip comments before counting — both full-line ("# Fill each test...") and
          // trailing ("all: | # TODO: DELETE test rows...") mention "TODO" in scaffold
          // hint prose, which is not an unfilled test. A `#` starts a comment when it's
          // at line-start or preceded by whitespace (same rule real YAML uses).
          const clNoComments = clText.split(/\r?\n/).map((ln) => ln.replace(/(^|\s)#.*$/, '$1')).join('\n');
          const clTodos = (clNoComments.match(/\bTODO\b/g) || []).length;
          checklistStatus = clTodos > 0 ? `scaffold (${clTodos} TODO)` : 'ready';
        } catch { checklistStatus = 'unreadable'; }
      }
    }

    // Next Step (same decision ladder as state-update, read-only)
    let nextStep;
    if (!featureName || !sdExists) {
      nextStep = 'No SD — run `/sf:ingest <srs>`.';
    } else if (sdTodos > 0) {
      nextStep = `SD has ${sdTodos} \`TODO:MANUAL-REVIEW\` — clear + approve, then \`/sf:checklist ${featureName}\`.`;
    } else {
      if (!trace) {
        nextStep = `SD clean but no \`trace.json\` — ingest didn't finish: run \`trace-build --sd .spec-flow/specs/${featureName}/SD.md --feature ${featureName}\`.`;
      } else if (checklistStatus === 'absent') {
        nextStep = `SD clean — \`/sf:checklist ${featureName}\`.`;
      } else if (checklistStatus && checklistStatus.startsWith('scaffold')) {
        nextStep = `Checklist has unfilled tests — fill from SD then \`/sf:phase ${featureName}\` (or \`/sf:manual-test ${featureName}\` if implementation is already done).`;
      } else if (taskCounts.total === 0) {
        nextStep = `\`/sf:phase ${featureName}\` — it seeds tasks (parse-prd, agent-run) then implements.`;
      } else if (taskCounts.pending + taskCounts.inProgress > 0) {
        nextStep = `\`/sf:phase ${featureName}\` — ${taskCounts.pending} pending · ${taskCounts.inProgress} wip${taskCounts.review ? ` · ${taskCounts.review} review (\`/sf:phase\` re-drives these first)` : ''}.`;
      } else if (taskCounts.review > 0) {
        nextStep = `${taskCounts.review} task(s) in \`review\` — \`/sf:phase ${featureName}\` picks them up first: re-runs each task's smoke → passed closes it, failed re-attempts (or halts to ask). \`next_task\` alone skips \`review\`, which is why re-running the loop is the right move, not a no-op.`;
      } else {
        const gapTail = verifiedGaps.length ? ` ${verifiedGaps.length} live gap(s) NOT verified live — confirm acceptable before merge.` : '';
        nextStep = verified
          ? `Done + verified — ship: stage, then \`commit\` skill (push).${gapTail}`
          : `Done — \`/sf:manual-test ${featureName}\` (runs smoke + regression + records VERIFICATION).${gapTail}`;
      }
    }

    // Checkpoint overrides nextStep when mid-task state was saved
    if (checkpoint && taskCounts.inProgress > 0) {
      const phasePart = checkpoint.phase ? ` [${checkpoint.phase}]` : '';
      nextStep = `Resume checkpoint: task ${checkpoint.task}${phasePart} — read \`.spec-flow/specs/${featureName}/checkpoint.md\` then continue. Or \`/sf:phase ${featureName}\` to let it re-drive.`;
    }

    // In-flight resume hints take priority — surface started-but-open bug/change
    // work with the exact resume command (id from the record → no guessing).
    const resume = [];
    if (bugsOpen) resume.push(bugsOpen === 1 ? `\`/sf:bug --resume ${bugsOpenList[0].id}\`` : `\`/sf:bug --resume <id>\` (${bugsOpen} open — see list)`);
    if (changesOpen) resume.push(changesOpen === 1 ? `\`/sf:change --resume ${changesOpenList[0].id}\`` : `\`/sf:change --resume <id>\` (${changesOpen} open)`);
    if (resume.length) nextStep = `Resume in-flight → ${resume.join(' · ')} — or: ${nextStep}`;

    return ok({
      project,
      branch,
      feature: featureName,
      sd: sdExists ? { path: sdPath, todos: sdTodos } : null,
      trace: trace ? { fr: frCount, tc: tcCount, nfr: nfrCount, links } : null,
      checkpoint,
      checklist: checklistStatus,
      tasks: taskCounts.total > 0 ? taskCounts : null,
      ready: ready.length > 0 ? ready : null,
      verified,
      verifiedGaps,
      latestSnapshot,
      bugsOpen,
      changesOpen,
      bugsOpenList,
      changesOpenList,
      nextStep,
    });
  },

  // -----------------------------------------------------------------------
  // taskmaster-model-plan  --role <main|research>
  //
  // Pure decision engine: reads .spec-flow/config.json and .taskmaster/config.json,
  // compares the configured model override against the current Task Master model,
  // and returns a decision object. NO subprocess calls, NO network calls.
  //
  // Returns one of:
  //   ok({needsChange: false})                          — configured null/absent/empty OR .taskmaster/config.json missing
  //   ok({needsChange: false, reason: "already-set"})  — configured === previous
  //   ok({needsChange: true, configured, previous})     — override needed
  //   err("INVALID_ROLE: ...")                          — bad --role argument
  // -----------------------------------------------------------------------
  'taskmaster-model-plan'(args) {
    const role = args.role;
    // Validate role: only 'main' or 'research' are allowed (§12.2 ERR_TM_PLAN_INVALID_ROLE).
    if (role !== 'main' && role !== 'research') {
      return err("INVALID_ROLE: must be 'main' or 'research'");
    }

    // Read .spec-flow/config.json → models.taskmaster.<role>
    const sfConfig = readJsonSafe(PATHS.config, {}) || {};
    const taskmasterModels = (sfConfig.models && sfConfig.models.taskmaster) || {};
    const configured = taskmasterModels[role];

    // FR-001: null, undefined, or empty/whitespace-only string → early return, never read TM config.
    if (configured == null || String(configured).trim() === '') {
      return ok({ needsChange: false });
    }

    // Read .taskmaster/config.json → models.<role>.modelId (FR-005: graceful on missing/unparseable)
    const tmConfigPath = path.join(process.cwd(), '.taskmaster', 'config.json');
    let tmConfig;
    try {
      const raw = fs.readFileSync(tmConfigPath, 'utf8');
      tmConfig = JSON.parse(raw);
    } catch (_e) {
      // File missing or unparseable → graceful (FR-005)
      return ok({ needsChange: false });
    }

    const previous = (tmConfig && tmConfig.models && tmConfig.models[role])
      ? tmConfig.models[role].modelId
      : undefined;

    // FR-002: configured === previous → no-op
    if (configured === previous) {
      return ok({ needsChange: false, reason: 'already-set' });
    }

    // FR-003: override needed
    return ok({ needsChange: true, configured, previous });
  },

  // ---------------------------------------------------------------------------
  // task-core wrappers (Task #9 — additive only; no existing command modified)
  //
  // Each wrapper: parse args with the existing parseArgs result, map to taskCore
  // function params, call inside try/catch, convert thrown Error with .code into
  // the err(message) result shape, and return ok(data) on success.
  //
  // HARD CONSTRAINTS: additive only — no existing command, the dispatcher, or any
  // existing behavior is changed. Existing callers behave identically.
  // ---------------------------------------------------------------------------

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

  // Preflight: does every Task Master role (main/research/fallback) have what it
  // needs to actually run? A role on a keyed provider (anthropic, perplexity, ...)
  // with no matching key in env/.env will fail (or silently no-op as "fallback")
  // the first time an AI-op reaches it — this catches that BEFORE the per-task
  // loop burns a task on it. `claude-code`/`ollama` are keyless — never flagged.
  'taskmaster-model-check'() {
    const KEY_ENV = {
      anthropic: 'ANTHROPIC_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GOOGLE_API_KEY',
      groq: 'GROQ_API_KEY',
      xai: 'XAI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      azure: 'AZURE_OPENAI_API_KEY',
    };

    const tmConfigPath = path.join(process.cwd(), '.taskmaster', 'config.json');
    let tmConfig;
    try {
      tmConfig = JSON.parse(fs.readFileSync(tmConfigPath, 'utf8'));
    } catch (_e) {
      return ok({ checked: false, note: '.taskmaster/config.json not found or unparseable — nothing to check yet.' });
    }

    // Approximate what the CLI subprocess will see: process env + a hand-parsed .env
    // (best-effort — not a full dotenv parser, just KEY=VALUE lines).
    const envKeys = new Set(Object.keys(process.env));
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      try {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
          if (m && m[2].trim()) envKeys.add(m[1]);
        }
      } catch (_e) { /* best-effort */ }
    }

    const models = (tmConfig && tmConfig.models) || {};
    const problems = [];
    for (const role of ['main', 'research', 'fallback']) {
      const r = models[role];
      if (!r || !r.provider) continue;
      const requiredKey = KEY_ENV[r.provider];
      if (requiredKey && !envKeys.has(requiredKey)) {
        problems.push(`${role}: provider "${r.provider}" (model "${r.modelId || '?'}") needs ${requiredKey} — not found in env or .env. This role will fail at the first AI op that reaches it.`);
      }
    }
    return ok({ checked: true, clean: problems.length === 0, problems });
  },
};

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  let result;
  if (!cmd) result = err('NO_COMMAND: usage: flow-tools.cjs <command> [--key value]');
  else if (!commands[cmd]) result = err(`UNKNOWN_COMMAND: ${cmd}`);
  else { try { result = commands[cmd](args); } catch (e) { result = err(`INTERNAL: ${e && e.message ? e.message : String(e)}`); } }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}
main();
