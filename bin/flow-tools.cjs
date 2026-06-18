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
 *           trace-link, srs-diff, state-update, verify-collect, verify-code, wave-plan,
 *           epic-new, epic-list, bug-new, bug-list, branch-ensure,
 *           learn, doctor, status-report
 */

'use strict';
const fs = require('fs');
const path = require('path');

const STATE_DIR = '.spec-flow';
const PATHS = {
  stateDir: STATE_DIR,
  srs: path.join(STATE_DIR, 'srs'),
  snapshots: path.join(STATE_DIR, 'snapshots'),
  specs: path.join(STATE_DIR, 'specs'),
  trace: path.join(STATE_DIR, 'trace.json'),
  changes: path.join(STATE_DIR, 'changes'),
  bugs: path.join(STATE_DIR, 'bugs'),
  config: path.join(STATE_DIR, 'config.json'),
  projectAuthor: path.join(STATE_DIR, 'project-author.md'),
  gitignore: path.join(STATE_DIR, '.gitignore'),
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
    const want = (block.match(new RegExp(`(?:${(us.want || ['I want']).join('|')})\\s*[,:]?\\s*([^\\n…]+)`, 'i')) || [])[1];
    const soThat = (block.match(new RegExp(`(?:${(us.soThat || ['so that']).join('|')})\\s*[,:]?\\s*([^\\n…]+)`, 'i')) || [])[1];
    const edgeRe = kwRe(us.edgeStart || ['edge case']);
    const acceptance = extractBulletsAfter(block, kwRe(us.acceptanceStart || ['acceptance']), edgeRe);
    const edges = extractBulletsAfter(block, edgeRe, null);
    stories.push({ id: `US-${m[1]}`, name, role: trimOrNull(role), want: trimOrNull(want), soThat: trimOrNull(soThat), acceptance, edges });
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
  const feSec = findHeading(hs, 'frontend');
  const screens = feSec ? parseAllTables(bodyOf(lines, feSec)) : [];
  const flowSec = findHeading(hs, 'flow');
  const flowText = (flowSec ? bodyOf(lines, flowSec).join(' ') : '') + ' ' + stories.map(s => `${s.name} ${s.role || ''}`).join(' ');
  return {
    featureName: featureName ? featureName.replace(/[*#]/g, '').trim() : null,
    designType: inferDesignType(flowText),
    revision, glossary, stories, nfr, businessLogic, stateTable, screens,
    hasState: !!stateTable, hasSeq: !!flowSec,
  };
}

// =====================================================================
//  SD GENERATION (Pass-1 deterministic)
// =====================================================================

const TODO = (what) => `> **TODO:MANUAL-REVIEW** — ${what} _(Pass-2 / sd-author agent or human)_`;
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

  const todoCount = out.filter(l => /TODO:MANUAL-REVIEW/.test(l)).length;
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

// =====================================================================
//  COMMANDS
// =====================================================================
const commands = {
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
    const VALID_STACKS = ['java-spring', 'node', 'python', 'go', 'dotnet'];
    const VALID_DESIGN_TYPES = ['auto', 'api', 'internal', 'hybrid'];

    const projectName = args.name || path.basename(process.cwd());
    const stack = VALID_STACKS.includes(args.stack) ? args.stack : 'unknown';
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
        },
        verify: verifyPreset,
        branching: BRANCHING_DEFAULT,
        ...(repos ? { repos } : {}),
        // phase.confirmTasks: after Step 0 seeds the task list, /sf:phase pauses for a
        // one-time human review of the breakdown before implementing (parse-prd is an
        // AI op, not deterministic — "approve SD" does not cover the task list). Set
        // false to auto-implement straight through.
        phase: { confirmTasks: true },
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
    const q = (s) => '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

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
    L.push("    payload: '{\"iat\":1772680061,\"exp\":2088040061,\"sub\":\"${USER_ID}\"}'");
    L.push('cleanup:');
    L.push("  all: | # TODO: DELETE test rows (LIKE 'TEST-%')");
    L.push('suites:');
    let s = 0;
    for (const flow of Object.keys(byFlow)) {
      s++;
      L.push(`  - id: suite-${s}`);
      L.push(`    name: ${q(flow)}`);
      L.push('    tags: [smoke, regression]');
      L.push('    tests:');
      for (const t of byFlow[flow]) {
        const tag = t.isEdge ? 'regression' : 'smoke';
        // Expected goes in a COMMENT (free SD prose — never inside a YAML value,
        // which would break the parser on backticks/quotes). The lint tripwire is
        // the clean `path: /api/v1/TODO` + `_assert: TODO` tokens.
        const expTxt = String(t.expected || '').replace(/\s+/g, ' ').trim().slice(0, 110) || '(see SD §13.2)';
        L.push(`      - id: ${t.tcId}`);
        L.push(`        name: ${q(t.testCase)}`);
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
      }
    }
    const yaml = L.join('\n') + '\n';
    const outPath = args.out || path.join(PATHS.specs, feature, 'CHECKLIST.yaml');
    const todoCount = (yaml.match(/TODO/g) || []).length;
    if (args['dry-run']) return ok({ feature, suites: s, tests: tc.rows.length, todo: todoCount, preview: yaml.slice(0, 900) + '\n...[truncated]' });
    ensureDir(path.dirname(outPath));
    try { fs.writeFileSync(outPath, yaml); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    return ok({ feature, checklist: outPath, suites: s, tests: tc.rows.length, todo: todoCount });
  },

  // -----------------------------------------------------------------------
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

    try { fs.writeFileSync(PATHS.trace, JSON.stringify(trace, null, 2)); } catch (e) {
      return err(`WRITE_FAILED: ${e.message}`);
    }

    return ok({
      trace: PATHS.trace,
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
    });
  },

  // -----------------------------------------------------------------------
  // trace-impact  --changeset <json file>  |  --ids "FR-001,TC-003"  |  --keywords "callback,timeout"
  // Read .spec-flow/trace.json, resolve impacted nodes transitively.
  // Also walks task-file and fr-file links to populate impacted.files.
  // -----------------------------------------------------------------------
  'trace-impact'(args) {
    const trace = readJsonSafe(PATHS.trace, null);
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
    return ok({ changeset, counts, note: 'best-effort: SRS is free-form; treat as hint for sd-author. The SD is the authoritative controlled artifact.' });
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

    // Try to read trace for task counts and feature name
    const trace = readJsonSafe(PATHS.trace, null);
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
    const verificationPath = path.join(STATE_DIR, 'VERIFICATION.md');
    let nextStep;
    if (featureName === 'unknown' || !fs.existsSync(sdPath)) {
      nextStep = 'No SD — run `/sf:ingest <srs>`.';
    } else {
      let sdTodos = 0;
      try { sdTodos = (fs.readFileSync(sdPath, 'utf8').match(/^>\s*\*\*TODO:MANUAL-REVIEW\*\*/gm) || []).length; } catch {}
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
          : `Done — regression: \`run-checklist ${featureName} --tag regression\` → \`verify-collect\`.`;
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
  //               [--slug <slug>] [--type fix|enhance]
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
    if (roots.length === 1 && !roots[0].name) {
      const r = ensureIn(roots[0].root);
      if (r.error === 'NO_COMMITS') return err('NO_COMMITS: git repo has no commits yet — make an initial commit before branching');
      if (r.error === 'NOT_A_GIT_REPO') return err('NOT_A_GIT_REPO');
      if (r.error) return err(r.error);
      return ok({ ...r, base, mode: branching.mode });
    }
    const results = roots.map((rp) => ({ repo: rp.name, ...ensureIn(rp.root) }));
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
  // doctor  [--sd <SD.md>] [--feature <f>]
  // Health-check: env + plugin files + install state + project state + SD/trace consistency.
  // ALWAYS returns ok({ checks, summary }) — never err (a doctor reports, not fails).
  // status ∈ "ok"|"warn"|"fail"
  // -----------------------------------------------------------------------
  doctor(args) {
    const os = require('os');
    const { execSync } = require('child_process');
    const checks = [];

    const push = (name, status, detail, fix) => checks.push({ name, status, detail, fix: fix || null });

    // a. Node runtime
    push('node-runtime', 'ok', `Node.js ${process.version}`, null);

    // b. npx available (for Task Master MCP)
    try {
      execSync('command -v npx', { stdio: 'pipe', timeout: 3000 });
      push('npx-available', 'ok', 'npx found', null);
    } catch {
      push('npx-available', 'warn', 'npx not found in PATH', 'install Node/npm (https://nodejs.org) and ensure npx is on PATH');
    }

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
        const todoCount = (sdContent.match(/^>\s*\*\*TODO:MANUAL-REVIEW\*\*/gm) || []).length;
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

    // i. dep-lock — verify Task Master is pinned in .mcp.json (not floating @latest)
    const mcpJsonPath = path.join(PLUGIN_ROOT, '.mcp.json');
    try {
      if (!fs.existsSync(mcpJsonPath)) {
        push('dep-lock', 'warn', '.mcp.json not found — cannot verify Task Master pin', 'Ensure .mcp.json exists at the plugin root');
      } else {
        const mcpRaw = readJsonSafe(mcpJsonPath, null);
        const tmArgs = (mcpRaw && mcpRaw.mcpServers && mcpRaw.mcpServers['task-master-ai'] && mcpRaw.mcpServers['task-master-ai'].args) || [];
        const tmArg = tmArgs.find(a => String(a).startsWith('task-master-ai'));
        if (!tmArg) {
          push('dep-lock', 'warn', 'task-master-ai not found in .mcp.json args', 'Add task-master-ai@<version> to .mcp.json mcpServers.task-master-ai.args');
        } else {
          const versionMatch = String(tmArg).match(/^task-master-ai@(.+)$/);
          if (versionMatch) {
            push('dep-lock', 'ok', `Task Master pinned to ${versionMatch[1]} in .mcp.json`, null);
          } else {
            push('dep-lock', 'warn', 'Task Master not version-pinned in .mcp.json — floating @latest risks breakage; pin to a tested version (e.g. task-master-ai@0.43.1)', 'Edit .mcp.json: change "task-master-ai" to "task-master-ai@<version>"');
          }
        }
      }
    } catch (e) {
      push('dep-lock', 'warn', `dep-lock check error: ${e && e.message ? e.message : String(e)}`, null);
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
    const verifPath = path.join(STATE_DIR, 'VERIFICATION.md');
    if (fs.existsSync(verifPath)) {
      let verif = ''; try { verif = fs.readFileSync(verifPath, 'utf8'); } catch {}
      const passed = /status:\s*passed/i.test(verif);
      if (passed) {
        const trc = readJsonSafe(PATHS.trace, null);
        const feat = trc && trc.feature;
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

    // Build the check list for ONE repo root. `rootDir` scopes both the test/
    // coverage commands' cwd and the forbidden/secret filesystem scans.
    const runChecksInRoot = (rootDir) => {
      // Resolve scanPath per root: explicit → src if exists → '.'
      let scanPath = rawScanPath || null;
      if (!scanPath) {
        scanPath = fs.existsSync(path.join(rootDir, 'src')) ? 'src' : '.';
      }

      const checks = [];
      let testOutput = '';

    // ---- a. tests ---------------------------------------------------------
    if (!testCommand) {
      checks.push(makeCheck('tests', 'skipped', 'testCommand not set', null));
    } else {
      let testStatus = 'ok';
      let testDetail = '';
      let testFix = null;
      try {
        const result = spawnSync(testCommand, {
          shell: true,
          cwd: rootDir,
          timeout: 600000,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        const combined = (result.stdout || '') + (result.stderr || '');
        testOutput = combined;
        const exitCode = result.status;
        if (result.error) {
          // spawn-level error (command not found, timeout, etc.)
          testStatus = 'fail';
          testDetail = `Command error: ${result.error.message}`;
          testFix = `Check testCommand in .spec-flow/config.json: "${testCommand}"`;
        } else if (exitCode !== 0) {
          testStatus = 'fail';
          const lines = combined.split(/\r?\n/).filter(Boolean);
          const tail = lines.slice(-15).join('\n');
          testDetail = `Exit ${exitCode}. Last output:\n${tail}`;
          testFix = `Fix failing tests before proceeding. Command: ${testCommand}`;
        } else {
          testStatus = 'ok';
          testDetail = `Command exited 0: ${testCommand}`;
        }
      } catch (e) {
        testStatus = 'fail';
        testDetail = `Unexpected error running tests: ${e && e.message ? e.message : String(e)}`;
        testFix = `Check testCommand in .spec-flow/config.json`;
      }
      checks.push(makeCheck('tests', testStatus, testDetail, testFix));
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
    for (const rp of roots) {
      const got = runChecksInRoot(rp.root);
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
    const gate = summary.fail > 0 ? 'fail' : (ran === 0 ? 'skipped' : 'pass');

    return ok({ checks, summary, gate, repos: roots.map((r) => r.name).filter(Boolean) });
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

    // Feature — from arg or trace
    const trace = readJsonSafe(PATHS.trace, null);
    let featureName = args.feature || (trace && trace.feature) || null;
    // Fallback: an SD on disk with no trace.json yet (ingest interrupted before
    // trace-build) — detect the feature from specs/ so /sf:status can still resume it.
    if (!featureName && fs.existsSync(PATHS.specs)) {
      try {
        const sdDirs = fs.readdirSync(PATHS.specs).filter(d => fs.existsSync(path.join(PATHS.specs, d, 'SD.md')));
        if (sdDirs.length) featureName = sdDirs[sdDirs.length - 1];
      } catch {}
    }

    // SD info
    const sdPath = featureName ? path.join(PATHS.specs, featureName, 'SD.md') : null;
    let sdTodos = null;
    let sdExists = false;
    if (sdPath && fs.existsSync(sdPath)) {
      sdExists = true;
      try { sdTodos = (fs.readFileSync(sdPath, 'utf8').match(/^>\s*\*\*TODO:MANUAL-REVIEW\*\*/gm) || []).length; } catch {}
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

    // Verification status
    const verifPath = path.join(PATHS.stateDir, 'VERIFICATION.md');
    let verified = null;
    if (fs.existsSync(verifPath)) {
      try { verified = /status:\s*passed/i.test(fs.readFileSync(verifPath, 'utf8')); } catch {}
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

    // Next Step (same decision ladder as state-update, read-only)
    let nextStep;
    if (!featureName || !sdExists) {
      nextStep = 'No SD — run `/sf:ingest <srs>`.';
    } else if (sdTodos > 0) {
      nextStep = `SD has ${sdTodos} \`TODO:MANUAL-REVIEW\` — clear + approve, then \`/sf:checklist ${featureName}\`.`;
    } else {
      const checklistPath = path.join(process.cwd(), PATHS.specs, featureName, 'CHECKLIST.yaml');
      if (!trace) {
        nextStep = `SD clean but no \`trace.json\` — ingest didn't finish: run \`trace-build --sd .spec-flow/specs/${featureName}/SD.md --feature ${featureName}\`.`;
      } else if (!fs.existsSync(checklistPath)) {
        nextStep = `SD clean — \`/sf:checklist ${featureName}\`.`;
      } else if (taskCounts.total === 0) {
        nextStep = `\`/sf:phase ${featureName}\` — it seeds tasks (parse-prd, agent-run) then implements.`;
      } else if (taskCounts.pending + taskCounts.inProgress > 0) {
        nextStep = `\`/sf:phase ${featureName}\` — ${taskCounts.pending} pending · ${taskCounts.inProgress} wip${taskCounts.review ? ` · ${taskCounts.review} review (\`/sf:phase\` re-drives these first)` : ''}.`;
      } else if (taskCounts.review > 0) {
        nextStep = `${taskCounts.review} task(s) in \`review\` — \`/sf:phase ${featureName}\` picks them up first: re-runs each task's smoke → passed closes it, failed re-attempts (or halts to ask). \`next_task\` alone skips \`review\`, which is why re-running the loop is the right move, not a no-op.`;
      } else {
        nextStep = verified
          ? 'Done + verified — ship: stage, then `commit` skill (push).'
          : `Done — run regression: \`run-checklist ${featureName} --tag regression\` → \`verify-collect\`.`;
      }
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
      tasks: taskCounts.total > 0 ? taskCounts : null,
      ready: ready.length > 0 ? ready : null,
      verified,
      latestSnapshot,
      bugsOpen,
      changesOpen,
      bugsOpenList,
      changesOpenList,
      nextStep,
    });
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
