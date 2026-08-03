/**
 * core.cjs — shared infra + SRS/SD parsers for spec-flow (extracted from flow-tools.cjs).
 * Pure helpers + deterministic parsers, no command logic. Required by bin/flow-tools.cjs
 * (workflow commands) and lib/maintenance.cjs (static commands). NEVER throws by contract.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_DIR = '.spec-flow';
const PATHS = {
  stateDir: STATE_DIR,
  snapshots: path.join(STATE_DIR, 'snapshots'),
  specs: path.join(STATE_DIR, 'specs'),
  trace: path.join(STATE_DIR, 'trace.json'),
  changes: path.join(STATE_DIR, 'changes'),
  bugs: path.join(STATE_DIR, 'bugs'),
  config: path.join(STATE_DIR, 'config.json'),
  projectAuthor: path.join(STATE_DIR, 'project-author.md'),
};

// Plugin root (for resolveTemplate fallback)
const PLUGIN_ROOT = path.join(__dirname, '..');

// ---- result helpers (pure: never throw) -----------------------------------
const ok = (data) => ({ ok: true, data });
const err = (message) => ({ ok: false, error: message });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
// Trace storage: the DURABLE source of truth is per-feature at specs/<feature>/trace.json
// (keyed by the feature dir → building feature B can never clobber feature A's trace).
// The global .spec-flow/trace.json is an "active feature" MIRROR, rewritten on each
// trace-build to reflect the last-built feature (so bare `/sf:status` knows what's active).
function traceFileFor(feature) { return feature ? path.join(PATHS.specs, feature, 'trace.json') : PATHS.trace; }
function readTrace(feature) {
  if (feature) { const pf = path.join(PATHS.specs, feature, 'trace.json'); if (fs.existsSync(pf)) return readJsonSafe(pf, null); }
  return readJsonSafe(PATHS.trace, null);
}
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature'; }
// Read Task Master tasks from a parsed tasks.json — handles flat ({tasks:[]}), a
// bare array, and the TAGGED shape ({ master: { tasks:[] }, <tag>: {...} }).
// preferredTag: when set (the active feature slug), read THAT tag's tasks for
// per-feature isolation. If the tag is absent, the feature has no tasks yet →
// return [] rather than leaking another tag's (e.g. master) carry-over counts,
// which would make /sf:status report a stale "done" for an unseeded feature.
function readTmTasks(tm, preferredTag) {
  if (!tm) return [];
  if (Array.isArray(tm)) return tm;
  if (Array.isArray(tm.tasks)) return tm.tasks;
  if (preferredTag) {
    return tm[preferredTag] && Array.isArray(tm[preferredTag].tasks) ? tm[preferredTag].tasks : [];
  }
  const tag = tm.master ? 'master' : Object.keys(tm).find((k) => tm[k] && Array.isArray(tm[k].tasks));
  return tag && Array.isArray(tm[tag].tasks) ? tm[tag].tasks : [];
}
// Per-feature file-links store. Scoped so each feature's trace is bounded and
// unambiguous — Task Master task ids repeat across features, so a single global
// store would collide and cross-contaminate traces.
function fileLinksPathFor(feature) { return path.join(STATE_DIR, 'specs', feature, 'file-links.json'); }
// Multi-repo: a feature's code may live in sibling service repos (config.repos =
// { "<name>": "<relative-path-from-this-repo>" }). resolveRepos returns the code
// roots to operate on. Absent/empty → single-repo mode: one root at cwd, name null
// (full backward compat — every existing single-repo project keeps working).
function resolveRepos(cfg) {
  const repos = cfg && cfg.repos && typeof cfg.repos === 'object' ? cfg.repos : null;
  if (!repos || !Object.keys(repos).length) return [{ name: null, root: process.cwd() }];
  return Object.entries(repos).map(([name, rel]) => ({
    name,
    root: path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), String(rel)),
  }));
}
// Parse a --repos "name=../path,other=../other" value into a {name:path} map.
function parseReposArg(val) {
  if (typeof val !== 'string' || !val.trim()) return null;
  const out = {};
  for (const pair of val.split(',')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    const p = pair.slice(i + 1).trim();
    if (name && p) out[name] = p;
  }
  return Object.keys(out).length ? out : null;
}

// Directories to skip when walking source trees (build outputs, caches, VCS, deps).
// Generic — applies to any stack; no stack-specific logic.
const SKIP_SCAN_DIRS = new Set(['.git', 'node_modules', '.spec-flow', 'build', 'dist', 'target', '.gradle', '__pycache__', '.next', '.nuxt', 'vendor']);

// =====================================================================
//  SRS PARSING (markdown -> structured)
// =====================================================================

/** Strip markdown emphasis/heading noise from a heading line. */
function cleanHeading(line) {
  return line.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/^\s+|\s+$/g, '');
}

/** Split a markdown doc into top-level "## N." sections keyed by their number. */
function parseHeadings(md) {
  const lines = md.split(/\r?\n/);
  const hs = [];
  lines.forEach((l, i) => { const m = l.match(/^(#{1,6})\s+/); if (m) hs.push({ level: m[1].length, title: cleanHeading(l), line: i }); });
  hs.forEach((h, i) => { h.bodyStart = h.line + 1; h.bodyEnd = (i + 1 < hs.length) ? hs[i + 1].line : lines.length; });
  return { lines, hs };
}
const bodyOf = (lines, h) => lines.slice(h.bodyStart, h.bodyEnd);
// ---- Language pack (SRS-parsing keywords = DATA, not engine logic) -------
// An SRS is free-form and in the user's language. Keyword lists for parsing it
// live in templates/lang/<lang>.json (project .spec-flow/templates/lang/ wins).
// Load `en` as base, merge config.language on top (union). New language = new
// JSON file, no engine edit. (The generated SD is canonical English → SD-side
// table parsing stays hardcoded; this pack is SRS-only.)
let _LANG = null;
function langPack() {
  if (_LANG) return _LANG;
  const loadFor = (l) => {
    for (const dir of [path.join(STATE_DIR, 'templates', 'lang'), path.join(PLUGIN_ROOT, 'templates', 'lang')]) {
      const j = readJsonSafe(path.join(dir, `${l}.json`), null);
      if (j) return j;
    }
    return {};
  };
  const lang = (readJsonSafe(PATHS.config, null) || {}).language || 'en';
  const base = loadFor('en');
  const over = lang && lang !== 'en' ? loadFor(lang) : {};
  // Deep-union the two packs (arrays concatenated, nested objects merged).
  const merge = (a, b) => {
    const out = {};
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const av = (a || {})[k], bv = (b || {})[k];
      if (Array.isArray(av) || Array.isArray(bv)) out[k] = [...(av || []), ...(bv || [])];
      else if (av && typeof av === 'object') out[k] = merge(av, bv || {});
      else out[k] = bv !== undefined ? bv : av;
    }
    return out;
  };
  _LANG = merge(base, over);
  return _LANG;
}
// Build a case-insensitive alternation regex from a keyword list (never-match if empty).
function kwRe(list, flags = 'i') { return (list && list.length) ? new RegExp(list.join('|'), flags) : /(?!)/; }

// SRS numbering is unreliable — classify headings by keyword (from the lang pack) instead.
function classifyHeading(title) {
  const roles = langPack().headingRoles || {};
  for (const role of Object.keys(roles)) if (kwRe(roles[role]).test(title)) return role;
  return null;
}
function findHeading(hs, role) { return hs.find(h => classifyHeading(h.title) === role) || null; }
function findTableByHeader(tables, re) { return tables.find(t => re.test(t.headers.join(' '))) || null; }

/** Parse the first markdown table found in a block of lines -> {headers[], rows[][]}. */
function parseFirstTable(lines, { skipEmpty = true } = {}) {
  const tables = parseAllTables(lines);
  if (!skipEmpty) return tables[0] || null;
  return tables.find(t => t.rows.length > 0) || tables[0] || null;
}
function parseAllTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const headers = splitRow(lines[i]);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        if (cells.some(c => c.trim() !== '')) rows.push(cells);
        i++;
      }
      tables.push({ headers, rows });
    } else i++;
  }
  return tables;
}
function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

/**
 * BEST-EFFORT user-story capture. SRS is uncontrolled (product writes freely),
 * so this only succeeds when the SRS happens to be structured. When it doesn't,
 * the sd-author AI agent fills these sections from the raw SRS instead. We NEVER
 * rely on this regex for correctness — the SD (which we DO control) is the gate.
 */
function parseUserStories(md) {
  const { lines, hs } = parseHeadings(md);
  const stories = [];
  for (let i = 0; i < hs.length; i++) {
    const m = hs[i].title.match(/US[-\s]?(\d+)\s*[:.\-]?\s*(.*)$/i);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < hs.length; j++) { if (hs[j].level <= hs[i].level) { end = hs[j].line; break; } }
    const block = lines.slice(hs[i].line, end).join('\n');
    const name = (m[2] || '').replace(/\**/g, '').trim() || `US-${m[1]}`;
    const us = langPack().userStory || {};
    const role = (block.match(new RegExp(`(?:${(us.role || ['As an?']).join('|')})\\s+([^,\\n…]+?)\\s*,`, 'i')) || [])[1];
    const edgeRe = kwRe(us.edgeStart || ['edge case']);
    const acceptance = extractBulletsAfter(block, kwRe(us.acceptanceStart || ['acceptance']), edgeRe);
    const edges = extractBulletsAfter(block, edgeRe, null);
    stories.push({ id: `US-${m[1]}`, name, role: trimOrNull(role), acceptance, edges });
  }
  return stories;
}
function trimOrNull(s) { return s && s.trim() ? s.trim() : null; }
function extractBulletsAfter(block, startRe, endRe) {
  const lines = block.split(/\r?\n/);
  let started = false; const out = [];
  for (const l of lines) {
    if (!started) { if (startRe.test(l)) started = true; continue; }
    if (endRe && endRe.test(l)) break;
    const m = l.match(/^\s*[-*+]\s+(.*\S)\s*$/) || l.match(/^\s*\d+[.)]\s+(.*\S)\s*$/);
    if (m) { const t = m[1].replace(/^<|>$/g, '').trim(); if (t && !/^</.test(t)) out.push(t); }
  }
  return out;
}

/** Infer design type from flow text + story names (numbering-agnostic). */
function inferDesignType(text) {
  const t = (text || '');
  const dt = langPack().designType || {};
  const internal = kwRe(dt.internal || []).test(t);
  const api = kwRe(dt.api || []).test(t);
  if (internal && api) return 'hybrid';
  if (internal) return 'internal';
  if (api) return 'api';
  return 'hybrid';
}

/**
 * Capture from a free-form SRS only what is SAFE regardless of how product wrote it:
 * tables identified by header keyword (revision, glossary, NFR, business-logic, state),
 * plus best-effort user stories. Everything semantic is left to the sd-author AI agent.
 */
function parseSrs(md) {
  const { lines, hs } = parseHeadings(md);
  const tables = parseAllTables(lines);
  let featureName = (md.match(/Feature:\s*([^\n#*]+)/i) || [])[1];
  if (!featureName && hs[0]) featureName = hs[0].title;
  const th = langPack().tableHeaders || {};
  const stateRe = new RegExp(`(?:${(th.stateName || ['state']).join('|')}).*(?:${(th.stateMeaning || ['meaning', 'description']).join('|')})`, 'i');
  const revision = findTableByHeader(tables, kwRe(th.revision || ['version']));
  const glossary = findTableByHeader(tables, kwRe(th.glossary || ['term']));
  const stateTable = findTableByHeader(tables, stateRe);
  const businessLogic = findTableByHeader(tables, kwRe(th.businessLogic || ['business logic']));
  const stories = parseUserStories(md);
  const nfrSec = findHeading(hs, 'nfr');
  const nfr = nfrSec ? parseFirstTable(bodyOf(lines, nfrSec)) : null;
  // ID-prefix harvest (language-INDEPENDENT): FR-/NFR-/TC- IDs are always English-
  // canonical, so a structured table is harvestable by its first-column ID even when
  // the heading/header prose is in another language or matches no keyword pack. genSd
  // uses these only as a fallback when the keyword/story paths harvested nothing.
  const tableByIdPrefix = (re) => tables.find(t => t.rows.length && re.test((t.rows[0][0] || '').trim()));
  const frTable = tableByIdPrefix(/^FR-?\d+/i);
  const tcTable = tableByIdPrefix(/^TC-?\d+/i);
  const nfrTable = tableByIdPrefix(/^NFR-?\d+/i);
  const feSec = findHeading(hs, 'frontend');
  const screens = feSec ? parseAllTables(bodyOf(lines, feSec)) : [];
  const flowSec = findHeading(hs, 'flow');
  const flowText = (flowSec ? bodyOf(lines, flowSec).join(' ') : '') + ' ' + stories.map(s => `${s.name} ${s.role || ''}`).join(' ');
  return {
    // Strip a leading "SRS"/"SRS:" doc-type prefix so the derived slug + SD title are
    // clean (an H1 like "SRS: Outbox CDC" must not yield a `srs-outbox-cdc` feature slug
    // that drifts from the `--feature outbox-cdc` the rest of the flow uses).
    featureName: featureName ? featureName.replace(/[*#]/g, '').replace(/^\s*SRS\b[:\-\s]*/i, '').trim() || null : null,
    designType: inferDesignType(flowText),
    revision, glossary, stories, nfr, businessLogic, stateTable, screens,
    frTable, tcTable, nfrTable,
    hasState: !!stateTable, hasSeq: !!flowSec,
  };
}

/**
 * Prose-level harvest for a free-form SRS: bullet / numbered items grouped by the
 * nearest heading above them. An SRS written as prose bullets (no US-/FR- anchored
 * ids, no keyword tables) is invisible to parseSrs()'s anchor diff — this gives
 * srs-diff a fallback signal so a real revision never reads as an empty changeset.
 * Table rows are skipped (the anchor diff owns those).
 * Returns Map<sectionTitle, string[] bullets (whitespace-collapsed)>.
 */
function parseProseBullets(md) {
  const { lines, hs } = parseHeadings(md);
  const sections = new Map();
  let title = '(preamble)';
  let hi = 0;
  lines.forEach((ln, i) => {
    while (hi < hs.length && hs[hi].line <= i) { title = hs[hi].title; hi++; }
    const t = ln.trim();
    if (t.startsWith('|')) return; // table row — anchor diff territory
    const m = t.match(/^(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (!m) return;
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text.length < 4) return; // separators / noise
    if (!sections.has(title)) sections.set(title, []);
    sections.get(title).push(text);
  });
  return sections;
}

// =====================================================================
//  SD GENERATION (Pass-1 deterministic)
// =====================================================================

const TODO = (what) => `> **TODO:MANUAL-REVIEW** — ${what} _(Pass-2 / sd-author agent or human)_`;

// The ONE way to count unresolved SD markers. Anchored to the exact blockquote form
// `TODO()` emits, because the string itself legitimately appears in prose the SD is
// supposed to contain: the Pass-1 preamble banner, sd-author's own Pass-2 summary
// ("TODO:MANUAL-REVIEW remaining: 0"), and revision-history entries describing the
// markers that were cleared. A loose /TODO:MANUAL-REVIEW/ counts all of those and
// reports a clean, approved SD as still gated — the gate then blocks work that is
// actually ready, which trains everyone to ignore it.
const SD_TODO_RE = /^>\s*\*\*TODO:MANUAL-REVIEW\*\*/gm;
const countSdTodos = (text) => (String(text || '').match(SD_TODO_RE) || []).length;
const pad3 = (n) => String(n).padStart(3, '0');

function moscowFor(acIndex, total) {
  if (acIndex === 0) return 'Must Have';
  if (acIndex < Math.ceil(total / 2)) return 'Should Have';
  return 'Could Have';
}

function genSd(srs, opts) {
  const name = srs.featureName || opts.feature || 'Feature';
  const dt = opts.type && opts.type !== 'auto' ? opts.type : srs.designType;
  const out = [];
  const W = (s) => out.push(s);

  W(`# Solution Design: ${name}`);
  W('');
  W(`> Generated by spec-flow Pass-1 from SRS. Design type: **${dt}**. Sections marked TODO:MANUAL-REVIEW need Pass-2 (sd-author) or human input before approval.`);
  W('');

  // Revision History
  W('### Revision History');
  W('');
  W('| Version | Author | Date | Changes |');
  W('| --- | --- | --- | --- |');
  if (srs.revision && srs.revision.rows.length) {
    for (const r of srs.revision.rows) W(`| ${r[0] || ''} | ${r[1] || ''} | ${r[2] || ''} | ${r[3] || ''} |`);
  } else W('| 0.1 | | | Initial draft (Pass-1 from SRS) |');
  W('');

  // §1 Overview
  W('## 1. Overview');
  W('');
  W(`- **Design Type:** ${dt === 'api' ? 'API Service' : dt === 'internal' ? 'Internal Process' : 'Hybrid'}`);
  W('- **Change Type:** ' + TODO('classify (new feature / enhancement / bugfix)').replace(/^> /, ''));
  W(TODO('write 3-5 sentence summary from SRS §1 scope + §5.1 user journey'));
  W('');

  // §2 Background
  W('## 2. Background & Problem Statement');
  W('');
  W(TODO('fill §2.1 Context / §2.2 Problem / §2.3 Proposed Solution from SRS §1 scope + §5.1 journey'));
  W('');

  // §3 Goals / Non-Goals
  W('## 3. Goals & Non-Goals');
  W('');
  W('### 3.1 Goals');
  W('');
  let goalN = 0;
  for (const us of srs.stories) {
    if (us.name || us.acceptance[0]) { goalN++; W(`- **${us.name || us.id}**: ${us.acceptance[0] || ''}`); }
  }
  if (!goalN) W('- ' + TODO('list goals from SRS §1 scope + §3').replace(/^> /, ''));
  W('');
  W('### 3.2 Non-Goals');
  W('');
  W(TODO('sd-author: derive from SRS exclusions / deferred items / stated boundaries — list each explicitly out-of-scope behavior'));
  W('');

  // §5.1 Functional Requirements (from AC)
  W('## 5. Requirements');
  W('');
  W('### 5.1 Functional Requirements');
  W('');
  W('| ID | Requirement | Priority (MoSCoW) | Source |');
  W('| --- | --- | --- | --- |');
  let frN = 0;
  for (const us of srs.stories) {
    const total = us.acceptance.length;
    us.acceptance.forEach((ac, i) => { frN++; W(`| FR-${pad3(frN)} | ${ac} | ${moscowFor(i, total)} | ${us.id} |`); });
    // edges -> lower priority FRs
    us.edges.forEach((e) => { frN++; W(`| FR-${pad3(frN)} | Handle edge: ${e} | Could Have | ${us.id} (edge) |`); });
  }
  // Business-logic rules (BL-xx) — the authoritative functional spec when the SRS has them.
  if (srs.businessLogic && srs.businessLogic.rows.length) {
    for (const r of srs.businessLogic.rows) {
      frN++;
      const blName = (r[0] || '').replace(/\s+/g, ' ').trim();
      const rule = (r[3] || r[1] || '').replace(/<br\s*\/?>/gi, '; ').replace(/\s+/g, ' ').trim();
      const blId = (blName.match(/BL-\d+/i) || ['BL'])[0];
      W(`| FR-${pad3(frN)} | ${blName.replace(/—.*$/, '').trim() || blId}: ${rule.slice(0, 200)} | Must Have | ${blId} |`);
    }
  }
  // ID-prefix fallback: a structured | FR-1 | ... | table the keyword/story paths missed
  // (e.g. a non-English SRS). Harvest by ID so a clean table doesn't dump 14 TODOs on sd-author.
  if (!frN && srs.frTable && srs.frTable.rows.length) {
    const moscowRe = /\b(must|should|could|won'?t)\b/i;
    const mosc = (c) => /must/i.test(c) ? 'Must Have' : /should/i.test(c) ? 'Should Have' : /could/i.test(c) ? 'Could Have' : "Won't Have";
    for (const r of srs.frTable.rows) {
      const id0 = (r[0] || '').trim();
      if (!/^FR-?\d+/i.test(id0)) continue;
      frN++;
      const rest = r.slice(1).map(c => (c || '').replace(/<br\s*\/?>/gi, '; ').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const prio = rest.find(c => c.length < 16 && moscowRe.test(c));
      const req = rest.filter(c => c !== prio).join(' — ').slice(0, 220) || id0;
      W(`| FR-${pad3(frN)} | ${req} | ${prio ? mosc(prio) : 'Must Have'} | ${id0} |`);
    }
  }
  if (!frN) W('| FR-001 | ' + TODO('SRS not auto-parsable (free-form) — sd-author: derive FRs from raw SRS').replace(/^> /, '') + ' | | |');
  W('');

  // §5.2 NFR (from SRS §6.1)
  W('### 5.2 Non-Functional Requirements');
  W('');
  W('| ID | Category | Requirement | Target |');
  W('| --- | --- | --- | --- |');
  let nfrN = 0;
  if (srs.nfr && srs.nfr.rows.length) {
    for (const r of srs.nfr.rows) { nfrN++; W(`| NFR-${pad3(nfrN)} | ${r[1] ? 'Perf/Sec' : 'General'} | ${r[0] || ''} | ${r[1] || ''} ${r[2] ? '(' + r[2] + ')' : ''} |`); }
  }
  // ID-prefix fallback: a structured | NFR-1 | ... | table (first col = ID, unlike the
  // heading-harvested table whose first col is the requirement text).
  if (!nfrN && srs.nfrTable && srs.nfrTable.rows.length) {
    for (const r of srs.nfrTable.rows) {
      const id0 = (r[0] || '').trim();
      if (!/^NFR-?\d+/i.test(id0)) continue;
      nfrN++;
      const rest = r.slice(1).map(c => (c || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      W(`| NFR-${pad3(nfrN)} | General | ${rest.join(' — ').slice(0, 220) || id0} | |`);
    }
  }
  if (!nfrN) W('| NFR-001 | | ' + TODO('fill from SRS §6.1 security & performance').replace(/^> /, '') + ' | |');
  W('');

  // §6 Architecture (AI)
  W('## 6. Architecture Overview');
  W('');
  W(TODO('§6.1 Mermaid graph TB + §6.2 component table — derive from SRS §2 sequence diagram (sd-author)'));
  W('');

  // Part B/C depending on design type
  if (dt === 'api' || dt === 'hybrid') {
    W('## 9. API Design');
    W('');
    W(TODO('§9.1 base/auth + §9.2 endpoints from SRS §5.2 screen fields (Label->field, Mandatory=Yes->required) + §9.4 sequence diagrams (sd-author)'));
    if (srs.screens.length) {
      W('');
      W('<!-- Pass-1 captured SRS §5.2 screen fields for reference: -->');
      srs.screens.forEach((t, idx) => {
        W(`<!-- Screen table ${idx + 1}: ${t.headers.join(' | ')} (${t.rows.length} fields) -->`);
      });
    }
    W('');
  }
  if (dt === 'internal' || dt === 'hybrid') {
    W('## 10. Internal Process Design');
    W('');
    W(TODO('§10.2 process flow + §10.8 sequence diagrams (sd-author)'));
    W('');
    W('### 10.4 State Management');
    W('');
    if (srs.stateTable && srs.stateTable.rows.length) {
      W('_Captured from SRS. sd-author: add allowed transitions + entry actions + stateDiagram-v2._');
      W('');
      W('| State | Meaning |');
      W('| --- | --- |');
      for (const r of srs.stateTable.rows) W(`| ${(r[0] || '').replace(/\*\*/g, '').trim()} | ${(r[1] || '').replace(/\s+/g, ' ').trim()} |`);
    } else W(TODO('no state table found in SRS — sd-author: derive states + transitions if applicable'));
    W('');
  }

  // §12.2 Domain Error Codes (from edge cases)
  W('## 12. Error Handling & Resilience');
  W('');
  W('### 12.2 Domain Error Codes');
  W('');
  W('| Error Code | HTTP | Trigger | User Message |');
  W('| --- | --- | --- | --- |');
  let ecN = 0;
  for (const us of srs.stories) {
    us.edges.forEach((e) => {
      ecN++;
      const code = `ERR_${slugify(us.name || us.id).toUpperCase().replace(/-/g, '_').slice(0, 16)}_${pad3(ecN)}`;
      W(`| ${code} | 422 | ${e} | ${TODO('user-facing message from SRS §6.2').replace(/^> .*— /, '').replace(/ _.*$/, '')} |`);
    });
  }
  if (!ecN) W('| ERR_GENERIC_001 | 400 | ' + TODO('derive from SRS §4 edge cases + §6.2 message rules').replace(/^> /, '') + ' | |');
  W('');

  // §13.2 Test Cases (from AC + edges) -> drives CHECKLIST.yaml later
  W('## 13. Testing Strategy');
  W('');
  W('### 13.2 Test Cases (Critical)');
  W('');
  W('| TC ID | Flow | Test Case | Expected |');
  W('| --- | --- | --- | --- |');
  let tcN = 0;
  for (const us of srs.stories) {
    us.acceptance.forEach((ac) => { tcN++; W(`| TC-${pad3(tcN)} | ${us.name || us.id} | ${ac} | Pass (happy path) |`); });
    us.edges.forEach((e) => { tcN++; W(`| TC-${pad3(tcN)} | ${us.name || us.id} | Edge: ${e} | Handled gracefully (error code returned) |`); });
  }
  // ID-prefix fallback: a structured | TC-1 | ... | table in the SRS (the story path
  // harvested nothing). Expected is left descriptive (sd-author fills the real assertion).
  if (!tcN && srs.tcTable && srs.tcTable.rows.length) {
    for (const r of srs.tcTable.rows) {
      const id0 = (r[0] || '').trim();
      if (!/^TC-?\d+/i.test(id0)) continue;
      tcN++;
      const rest = r.slice(1).map(c => (c || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      W(`| TC-${pad3(tcN)} | harvested | ${rest.join(' — ').slice(0, 200) || id0} | Pass (confirm vs SRS) |`);
    }
  }
  if (!tcN) W('| TC-001 | | ' + TODO('derive from SRS §4 AC + edge cases').replace(/^> /, '') + ' | |');
  W('');

  // Appendix Glossary (from SRS §1 glossary)
  W('## Appendix: Glossary');
  W('');
  W('| Term | Meaning |');
  W('| --- | --- |');
  if (srs.glossary && srs.glossary.rows.length) {
    for (const r of srs.glossary.rows) W(`| ${r[0] || ''} | ${r[1] || ''} |`);
  } else W('| | |');
  W('');

  const todoCount = countSdTodos(out.join('\n'));
  const lineCount = out.length;
  // Epic-scale thresholds: advisory only, never blocks.
  const EPIC_FR_THRESHOLD = 25;   // FR count above which a feature is considered epic-scale
  const EPIC_LINE_THRESHOLD = 800; // Generated SD line count above which it is epic-scale
  const epicScale = frN > EPIC_FR_THRESHOLD || lineCount > EPIC_LINE_THRESHOLD;
  const warnings = epicScale
    ? [`EPIC-SCALE: ${frN} FRs / ${lineCount} lines. Consider splitting into sub-feature SDs (each linked via trace.json) for reviewable units + isolated change blast-radius; or have sd-author author section-by-section.`]
    : [];
  return { sd: out.join('\n'), stats: { designType: dt, userStories: srs.stories.length, fr: frN, nfr: nfrN, errorCodes: ecN, testCases: tcN, todoManualReview: todoCount, lineCount, epicScale }, warnings };
}

// =====================================================================
//  SD-DERIVED HELPERS (spec-flow's value-add ON TOP of Task Master)
//  Task Master core is fine and stays (glued via MCP). spec-flow only
//  fills what TM lacks: adaptive routing, SD->checklist, traceability,
//  and the STATE.md it has no concept of. These helpers read the SD we
//  generated (§5.1 FR + §13.2 TC tables) deterministically.
// =====================================================================
const STATE_FILE = path.join(STATE_DIR, 'STATE.md');

/** Find the §5.1 FR table and §13.2 TC table inside a generated SD. */
function readSdTables(sdPath) {
  const lines = fs.readFileSync(sdPath, 'utf8').split(/\r?\n/);
  const tables = parseAllTables(lines);
  const fr = tables.find(t => /requirement/i.test(t.headers.join(' ')) && /priority|moscow/i.test(t.headers.join(' ')));
  const tc = tables.find(t => /tc\s*id/i.test(t.headers.join(' ')) || /test case/i.test(t.headers.join(' ')));
  return { fr, tc };
}
function scoreComplexity(text) {
  let s = 2;
  // complexity is a list of GROUPS (synonyms); each group present adds 1 point —
  // mirrors the prior per-regex scoring where "integration|gateway" counted once.
  for (const group of (langPack().complexity || [])) { if (kwRe(group).test(text)) s += 1; }
  if (text.length > 80) s += 1;
  if (text.length > 140) s += 1;
  return Math.max(1, Math.min(10, s));
}
/** Map a 1-10 complexity score to an adaptive route (the bit TM lacks). */
function routeFor(score) {
  if (score <= 3) return 'fast';
  if (score <= 7) return 'expand';
  return 'deep';
}
/** Link TC ids to an FR requirement.
 *  Prefers explicit FR-ref column match (when the TC table has a dedicated "FR" column)
 *  over fuzzy text match, which mis-fires on 6-col tables where tr[2] is "Test Case"
 *  description, not the FR id. Falls back to fuzzy if no FR column or no explicit match.
 */
function tcIdsForReq(tc, req, frId) {
  if (!tc) return [];
  // Explicit match via FR-ref column (header named "FR", "FR Ref", "FR ID", etc.)
  const headers = (tc.headers || []).map(h => String(h || '').toLowerCase().trim());
  const frColIdx = headers.findIndex(h => /^fr(\s*(ref|id|#))?$/.test(h));
  if (frId && frColIdx >= 0) {
    const explicit = tc.rows.filter(tr => {
      const cell = (tr[frColIdx] || '').trim();
      return cell.split(/[,;\s]+/).map(s => s.trim()).some(s => s.toLowerCase() === frId.toLowerCase());
    }).map(tr => tr[0]);
    if (explicit.length > 0) return explicit;
  }
  // Fallback: fuzzy text match against "Test Case" column (index 2)
  const core = req.replace(/^handle edge:\s*/i, '').trim().toLowerCase();
  return tc.rows.filter(tr => {
    const t = (tr[2] || '').replace(/^edge:\s*/i, '').trim().toLowerCase();
    return t && core && (t === core || t.includes(core) || core.includes(t));
  }).map(tr => tr[0]);
}

// =====================================================================
//  TEMPLATE RESOLUTION (overlay: project-local first, plugin default fallback)
// =====================================================================
/**
 * resolveTemplate(name) — returns the path to a named template.
 * Checks `.spec-flow/templates/<name>` first (project override); falls back
 * to `<pluginRoot>/templates/<name>` (global plugin default).
 */
function resolveTemplate(name) {
  const projectOverride = path.join(STATE_DIR, 'templates', name);
  if (fs.existsSync(projectOverride)) return projectOverride;
  return path.join(PLUGIN_ROOT, 'templates', name);
}

module.exports = {
  STATE_DIR, PATHS, PLUGIN_ROOT, STATE_FILE, SKIP_SCAN_DIRS, ok, err, parseArgs, readJsonSafe, traceFileFor, readTrace, ensureDir, slugify, pad3, readTmTasks, fileLinksPathFor, resolveRepos, parseReposArg, langPack, kwRe, cleanHeading, parseHeadings, bodyOf, classifyHeading, findHeading, findTableByHeader, parseFirstTable, parseAllTables, splitRow, parseUserStories, trimOrNull, extractBulletsAfter, inferDesignType, parseSrs, parseProseBullets, TODO, countSdTodos, moscowFor, genSd, readSdTables, scoreComplexity, routeFor, tcIdsForReq, resolveTemplate
};
