/**
 * trace.cjs — the traceability commands: trace-link, trace-build, trace-repos,
 * trace-impact. Extracted from bin/flow-tools.cjs (which was approaching its
 * 3000-LOC cap); behaviour is unchanged and the CLI contract is identical —
 * these are spread into the same `commands` object the dispatcher reads.
 *
 * Storage model (see core.traceFileFor): the DURABLE trace is per-feature at
 * specs/<feature>/trace.json; the global .spec-flow/trace.json is an
 * active-feature MIRROR shared by every concurrent session.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const {
  PATHS, SD_COLS, ok, err, readJsonSafe, ensureDir, slugify, readTmTasks, readTrace, traceFileFor,
  fileLinksPathFor, parseAllTables, parseSrs, resolveCols, tableShapeWarnings, tcIdsForReq,
} = require('./core.cjs');

module.exports = {
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

    // Feature scope: EXPLICIT --feature only. This is a write, and the old fallback
    // (the active feature from the global trace.json) was a silent cross-feature
    // corruption vector: the global trace is a shared mirror, so a concurrent
    // session's trace-build flips it and this call then appends into THAT feature's
    // file-links store. Nothing downstream can detect it afterwards — TM task ids
    // repeat across features, so the bogus entries look native. Reads may still fall
    // back to the mirror (they report featureSource); writes must state their scope.
    const flFeature = args.feature || null;
    if (!flFeature) {
      return err('MISSING_ARG: --feature <f> required — trace-link writes into specs/<feature>/file-links.json, and the global trace.json mirror is shared across concurrent sessions (it can point at another feature). Pass the feature you are implementing.');
    }
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

    // Build FR nodes (columns by header name — see SD_COLS)
    const frCols = resolveCols(frTable, SD_COLS.fr);
    const frNodes = frTable ? frTable.rows.map(r => ({
      id: (r[frCols.id] || '').trim(),
      text: (r[frCols.text] || '').trim(),
      priority: (r[frCols.priority] || '').trim(),
      source: (r[frCols.source] || '').trim(),
    })).filter(n => n.id) : [];

    // Build TC nodes. "Expected" keeps its length-aware fallback: the 6-col enriched
    // §13.2 puts it at index 4, the 4-col Pass-1 skeleton at index 3.
    const tcH = (tcTable && tcTable.headers ? tcTable.headers : []);
    const tcCols = resolveCols(tcTable, { ...SD_COLS.tc, expected: [/expected/i, tcH.length >= 5 ? 4 : 3] });
    const tcNodes = tcTable ? tcTable.rows.map(r => ({
      id: (r[tcCols.id] || '').trim(),
      flow: (r[tcCols.flow] || '').trim(),
      text: (r[tcCols.text] || '').trim(),
      expected: (r[tcCols.expected] || '').trim(),
    })).filter(n => n.id) : [];

    // Build error nodes
    const errCols = resolveCols(errTable, SD_COLS.err);
    const errorNodes = errTable ? errTable.rows.map(r => ({
      code: (r[errCols.code] || '').trim(),
      http: (r[errCols.http] || '').trim(),
      trigger: (r[errCols.trigger] || '').trim(),
    })).filter(n => n.code) : [];

    // Enforce the project's standard error-code pattern (opt-in: config.conventions
    // .errorCodePattern). WARN (not block) on §12.2 codes that don't match — surfaces
    // a drift from the house convention right at ingest/resync, not at review-by-eye.
    const warnings = [];

    // Table shape: a row that does not have the header's column count is almost always
    // an unescaped `|` in a cell (an enum spelling, a pipe-joined payload). It renders
    // as a shifted/truncated row for the reviewer, and the node built from it carries a
    // cut-short requirement or a value from the neighbouring column — a trace that is
    // wrong without looking wrong. Warn per table, naming the offending row ids.
    for (const [label, t] of [
      ['SD §5.1 FR table', frTable],
      ['SD §13.2 TC table', tcTable],
      ['SD §12.2 error table', errTable],
      ['SD §10.4 state table', stateTable],
      ['SD §5.2 NFR table', nfrTable],
    ]) warnings.push(...tableShapeWarnings(t, label));

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
    const stateCols = resolveCols(stateTable, SD_COLS.state);
    const stateNodes = stateTable ? stateTable.rows.map(r => ({
      name: (r[stateCols.name] || '').trim(),
      meaning: (r[stateCols.meaning] || '').trim(),
    })).filter(n => n.name) : [];

    // Build NFR nodes (§5.2)
    const nfrCols = resolveCols(nfrTable, SD_COLS.nfr);
    const nfrNodes = nfrTable ? nfrTable.rows.map(r => ({
      id: (r[nfrCols.id] || '').trim(),
      category: (r[nfrCols.category] || '').trim(),
      text: (r[nfrCols.text] || '').trim(),
      target: (r[nfrCols.target] || '').trim(),
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
    // Carry forward the declared repo subset (trace-repos --set). It is DECLARED
    // intent, not derived from the SD, so a rebuild has nothing to regenerate it
    // from — before this, `trace-repos --set` followed by any `trace-build` silently
    // dropped it, and branch-ensure/verify-code fell back to all repos.
    const priorTrace = readJsonSafe(traceFileFor(feature), null);
    const priorRepos = priorTrace && Array.isArray(priorTrace.repos) && priorTrace.repos.length
      ? priorTrace.repos : null;
    const trace = {
      feature,
      generatedFrom: path.resolve(sdPath),
      generatedAt: new Date().toISOString(),
      ...(priorRepos ? { repos: priorRepos } : {}),
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
};
