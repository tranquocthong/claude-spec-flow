/**
 * review.cjs — the OPTIONAL pre-ship code-review gate.
 *
 * /sf:phase close-out runs an independent reviewer (a sub-agent, in a context that
 * never wrote the code) right before the ship step. This module is the deterministic
 * half of that: it computes WHAT to review (review-scope), turns the reviewer's
 * findings into a durable artifact + a gate verdict (review-collect), and records a
 * human's explicit "ship anyway" (review-accept).
 *
 * Why an engine command at all, when the reviewer is a model?
 *   - The gate verdict must be deterministic. "Are there blocking findings?" is a
 *     count over severities, not a judgement call the ship step re-litigates.
 *   - Disk is the source of truth in spec-flow (/sf:status derives everything from
 *     it). A review that lives only in a transcript is LOST next session — so the
 *     findings land in specs/<feature>/CODE-REVIEW.md, exactly like VERIFICATION.md.
 *   - The scope (base branch, diff range, touched files) is already knowable from
 *     config + file-links.json; computing it here keeps the orchestrator from
 *     guessing, and keeps multi-repo working.
 *
 * Commands: review-scope, review-collect, review-accept.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PATHS, ok, err, readJsonSafe, resolveActiveFeature, resolveRepos, fileLinksPathFor, ensureDir,
} = require('./core.cjs');

// Severity ladder. `critical`/`high` are BLOCKING — they halt the ship step and hand
// the decision to the user. Everything else is advisory: recorded, never blocking.
// Anything unrecognised degrades to `low` rather than being dropped, so a reviewer
// that invents a severity word cannot silently delete its own finding.
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const BLOCKING = new Set(['critical', 'high']);

function normSeverity(s) {
  const v = String(s || '').trim().toLowerCase();
  if (SEVERITIES.includes(v)) return v;
  // Common synonyms from generic review tooling.
  if (v === 'blocker' || v === 'severe') return 'critical';
  if (v === 'major' || v === 'warning') return 'high';
  if (v === 'minor' || v === 'nit' || v === 'suggestion') return 'low';
  return 'low';
}

/** `.spec-flow/specs/<feature>/CODE-REVIEW.md` */
function reviewPathFor(feature) { return path.join(PATHS.specs, feature, 'CODE-REVIEW.md'); }

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd: cwd || process.cwd(), stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
  } catch { return null; }
}

/**
 * Read the gate setting. Three states, not a boolean: "ask the human" cannot be
 * expressed by a boolean (true would mean "always run"). The gate is OPT-IN, so
 * the default (absent, null, or an unreadable value) is "off": nothing runs and
 * nothing is asked unless the project turned it on.
 *   "off"    — skip entirely, no prompt (DEFAULT, incl. when absent or invalid)
 *   "ask"    — /sf:phase asks yes/no (AskUserQuestion) before shipping; only an
 *              explicit yes runs it, no answer / no prompt means no
 *   "always" — run the review every ship, no prompt
 */
function resolveGate(cfg) {
  const raw = cfg && cfg.phase ? cfg.phase.codeReview : undefined;
  if (raw === undefined || raw === null) return { gate: 'off', source: 'default' };
  if (raw === false) return { gate: 'off', source: 'config' };
  if (raw === true) return { gate: 'always', source: 'config' };
  const v = String(raw).trim().toLowerCase();
  if (v === 'ask' || v === 'always' || v === 'off') return { gate: v, source: 'config' };
  return { gate: 'off', source: 'invalid', invalid: String(raw) };
}

/** Parse the header block CODE-REVIEW.md writes, so a later read is deterministic. */
function readExistingReview(feature) {
  const p = reviewPathFor(feature);
  if (!fs.existsSync(p)) return null;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const field = (name) => {
    const m = text.match(new RegExp('^' + name + ':[ \\t]*(.*)$', 'im'));
    return m ? m[1].trim() : null;
  };
  const counts = {};
  for (const s of SEVERITIES) {
    const m = text.match(new RegExp('^[ \\t]*-[ \\t]*' + s + ':[ \\t]*(\\d+)', 'im'));
    counts[s] = m ? Number(m[1]) : 0;
  }
  return {
    path: p,
    status: field('status'),
    head: field('head'),
    reviewedAt: field('reviewed'),
    reviewer: field('reviewer'),
    accepted: /^accepted:[ \t]*yes\b/im.test(text),
    counts,
  };
}

module.exports = {
  // -----------------------------------------------------------------------
  // review-scope  [--feature <f>]
  //
  // Pure read. Answers "should the pre-ship review run, and over what?" so the
  // orchestrator never has to derive the diff range or the file set by hand.
  // Returns ok({ feature, gate, gateSource, model, base, branch, range, onBase,
  //              files, repos, contextPack, reviewPath, existing, head, stale }).
  //
  // `contextPack` is the set of spec artifacts that exist for this feature. It is
  // what keeps the review honest: a reviewer given only a diff cannot distinguish a
  // real defect from a deliberate decision, so it flags both and the gate turns into
  // noise. See the inline note at the assignment.
  //
  // `range` is the review target for a single-repo project: `<base>...HEAD`
  // (three dots — the branch's own commits, not base-side churn). It is null when
  // branching is off or the base ref cannot be resolved; the caller then falls
  // back to `files`, which come from file-links.json (what the executors actually
  // wrote, recorded by trace-link). `files` is always returned — on a multi-repo
  // feature it is the ONLY reliable scope, since the hub repo holds no code.
  // -----------------------------------------------------------------------
  'review-scope'(args) {
    const { feature, source } = resolveActiveFeature(args.feature);
    if (!feature) return err('NO_FEATURE: pass --feature <f> (no active feature in trace.json)');

    const cfg = readJsonSafe(PATHS.config, {}) || {};
    const { gate, source: gateSource, invalid } = resolveGate(cfg);

    // Model override for the reviewer sub-agent, same convention as
    // models.hybridExecutor: null/absent = inherit the session's model.
    const model = (cfg.models && cfg.models.codeReviewer !== undefined) ? cfg.models.codeReviewer : 'sonnet';

    const branching = cfg.branching || {};
    const base = branching.base || 'main';
    const branchingOff = String(branching.mode || '').toLowerCase() === 'off';
    const branch = git(['branch', '--show-current']);
    const head = git(['rev-parse', 'HEAD']);
    const onBase = !!branch && branch === base;

    // Resolve the base ref locally first, then origin/. A range against a ref that
    // does not exist would make the reviewer silently review nothing.
    let baseRef = null;
    if (!branchingOff && !onBase) {
      for (const ref of [base, `origin/${base}`]) {
        if (git(['rev-parse', '--verify', '--quiet', ref])) { baseRef = ref; break; }
      }
    }
    const range = baseRef ? `${baseRef}...HEAD` : null;

    // Files this feature actually wrote (repo-qualified on multi-repo).
    const flPath = fileLinksPathFor(feature);
    const fl = fs.existsSync(flPath) ? readJsonSafe(flPath, null) : null;
    const files = fl && Array.isArray(fl.links)
      ? [...new Set(fl.links.map((l) => String((l && l.file) || '')).filter(Boolean))].sort()
      : [];

    const repos = resolveRepos(cfg).map((r) => ({ name: r.name, root: r.root }));
    const multiRepo = repos.length > 1 || (repos.length === 1 && repos[0].name !== null);

    // CONTEXT PACK — the single biggest lever against a noisy review.
    //
    // A reviewer handed nothing but a diff has no way to tell "missing null check"
    // from "null is impossible here, FR-007 says the caller validates" — so it
    // reports both, at the same severity, and the gate loses its credibility. Every
    // path below already exists in a spec-flow project and answers one specific
    // class of false positive:
    //   sd            — what the code is SUPPOSED to do (and the decisions behind it)
    //   context       — why the feature exists at all
    //   checklist     — which behaviours already have a manual test
    //   verification  — what actually ran green, and which gaps are KNOWN + accepted
    //   projectAuthor — `## Code Rules` bullets are a mandatory checklist (category
    //                   "project-rule", severity floor medium); other conventions stay low
    //   trace         — the FR -> TC links, to check a claim against its coverage
    // Only existing paths are returned: the caller reads what is here, and nothing
    // about a missing file needs explaining.
    const specDir = path.join(PATHS.specs, feature);
    const contextPack = {};
    for (const [key, p] of Object.entries({
      sd: path.join(specDir, 'SD.md'),
      context: path.join(specDir, 'CONTEXT.md'),
      checklist: path.join(specDir, 'CHECKLIST.yaml'),
      verification: path.join(specDir, 'VERIFICATION.md'),
      trace: path.join(specDir, 'trace.json'),
      projectAuthor: PATHS.projectAuthor,
    })) {
      if (fs.existsSync(p)) contextPack[key] = p;
    }

    // A prior review is stale once HEAD moved past it — re-review rather than
    // letting an old clean verdict wave through commits it never saw.
    const existing = readExistingReview(feature);
    const stale = !!(existing && existing.head && head && existing.head !== head);

    return ok({
      feature,
      featureSource: source,
      gate,
      gateSource,
      ...(invalid ? { invalidGateValue: invalid } : {}),
      model,
      base,
      branch,
      head,
      onBase,
      branchingOff,
      range,
      files,
      fileCount: files.length,
      repos,
      multiRepo,
      contextPack,
      reviewPath: reviewPathFor(feature),
      existing,
      stale,
    });
  },

  // -----------------------------------------------------------------------
  // review-collect  --feature <f> --findings <file-or-inline-json> [--reviewer <s>]
  //                 [--target <s>]
  //
  // Consume the reviewer's findings, write specs/<feature>/CODE-REVIEW.md, and
  // return the gate verdict. Accepted input shapes:
  //   { "findings": [ ... ] }   |   [ ... ]
  // Each finding: { severity, file?, line?, title, detail?, category?, suggestion?,
  //                  checkedAgainst? }
  //
  // Verdict:
  //   "clean"    — zero findings
  //   "advisory" — findings, none blocking → recorded, ship proceeds
  //   "blocking" — >=1 critical/high, or any project-rule finding → /sf:phase HALTS and asks the user
  // -----------------------------------------------------------------------
  'review-collect'(args) {
    const feature = args.feature;
    if (!feature) return err('MISSING_ARG: --feature <f> — CODE-REVIEW.md is written per-feature (specs/<feature>/CODE-REVIEW.md); never inferred from the active-feature mirror, which a concurrent session can point elsewhere.');
    const src = args.findings;
    if (src === undefined || src === null || src === '') return err('MISSING_ARG: --findings <file-or-inline-json>');

    let raw;
    if (typeof src === 'string' && fs.existsSync(src)) {
      try { raw = fs.readFileSync(src, 'utf8'); } catch (e) { return err(`READ_FAILED: ${e.message}`); }
    } else {
      raw = String(src);
    }

    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      // Tolerate a fenced or prose-wrapped blob — reviewers are models, and the
      // alternative is losing a whole review to a stray ``` line.
      const m = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!m) return err(`BAD_JSON: ${e.message}`);
      try { parsed = JSON.parse(m[1]); } catch (e2) { return err(`BAD_JSON: ${e2.message}`); }
    }

    const list = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.findings) ? parsed.findings : null);
    if (!list) return err('BAD_SHAPE: expected {"findings":[...]} or a bare [...] array');

    const findings = list.map((f, i) => {
      const o = (f && typeof f === 'object') ? f : { title: String(f) };
      return {
        severity: normSeverity(o.severity),
        title: String(o.title || o.summary || o.short_summary || `finding ${i + 1}`).trim(),
        file: o.file ? String(o.file).trim() : null,
        line: Number.isFinite(Number(o.line)) ? Number(o.line) : null,
        category: o.category ? String(o.category).trim() : null,
        detail: String(o.detail || o.failure_scenario || o.description || '').trim(),
        suggestion: o.suggestion ? String(o.suggestion).trim() : null,
        // Which FR/TC the reviewer checked the finding against before blocking on it.
        // Recorded verbatim (incl. "none") so a human can audit the reasoning rather
        // than take the severity on faith — see the standing rules in /sf:phase 3b.
        checkedAgainst: o.checkedAgainst ? String(o.checkedAgainst).trim() : null,
      };
    });
    // A `project-rule` finding is a violation of a rule the team wrote under
    // `## Code Rules`. The team's own reviewers fail a PR on exactly these, so
    // shipping one as "advisory" only moves the rejection downstream. Enforce the
    // severity floor here (a reviewer's `low` is raised to `medium`) and treat every
    // project-rule finding as blocking below — `review-accept` is still the way out.
    for (const f of findings) {
      if (f.category === 'project-rule' && SEVERITIES.indexOf(f.severity) > SEVERITIES.indexOf('medium')) f.severity = 'medium';
    }
    findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const f of findings) counts[f.severity]++;
    const blocking = findings.filter((f) => BLOCKING.has(f.severity) || f.category === 'project-rule');
    const status = findings.length === 0 ? 'clean' : (blocking.length ? 'blocking' : 'advisory');

    const reviewer = args.reviewer ? String(args.reviewer) : 'sub-agent (code-review)';
    const target = args.target ? String(args.target) : (parsed && parsed.target ? String(parsed.target) : null);
    const head = git(['rev-parse', 'HEAD']);
    const now = new Date().toISOString();

    const md = [];
    md.push(`# Code review — ${feature}`);
    md.push('');
    md.push('<!-- Written by `flow-tools.cjs review-collect`. The header block is machine-read');
    md.push('     by review-scope / status-report — edit the prose, not the field names. -->');
    md.push('');
    md.push(`status: ${status}`);
    md.push(`reviewed: ${now}`);
    md.push(`reviewer: ${reviewer}`);
    md.push(`head: ${head || '(unknown)'}`);
    if (target) md.push(`target: ${target}`);
    md.push('accepted: no');
    md.push('');
    md.push('## Counts');
    md.push('');
    for (const s of SEVERITIES) md.push(`- ${s}: ${counts[s]}`);
    md.push('');
    if (!findings.length) {
      md.push('## Findings');
      md.push('');
      md.push('None. The reviewer found nothing to report at this scope.');
      md.push('');
    } else {
      md.push('## Findings');
      md.push('');
      for (const [i, f] of findings.entries()) {
        const loc = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
        md.push(`### ${i + 1}. [${f.severity}] ${f.title}${loc}`);
        md.push('');
        if (f.category) md.push(`- category: ${f.category}`);
        if (f.checkedAgainst) md.push(`- checked against: ${f.checkedAgainst}`);
        if (f.detail) { md.push(''); md.push(f.detail); }
        if (f.suggestion) { md.push(''); md.push(`**Suggested fix:** ${f.suggestion}`); }
        md.push('');
      }
    }
    if (blocking.length) {
      md.push('## Ship decision');
      md.push('');
      md.push(`${blocking.length} blocking finding(s) (critical/high, or a \`## Code Rules\` violation). \`/sf:phase\` halts the ship step and asks the user:`);
      md.push('fix now, ship anyway (`review-accept` records the decision here), or abort.');
      md.push('');
    }

    const out = reviewPathFor(feature);
    ensureDir(path.dirname(out));
    try { fs.writeFileSync(out, md.join('\n')); }
    catch (e) { return err(`WRITE_FAILED: ${e.message}`); }

    // A blocking finding with no `checkedAgainst` was never tested against the spec.
    // Reported, not rejected: the artifact is still written (losing a real finding to
    // a missing field would be worse), but /sf:phase is told to send those back before
    // halting a ship on them.
    const uncheckedBlocking = blocking.filter((f) => !f.checkedAgainst).map((f) => f.title);

    return ok({
      feature, status, counts, total: findings.length,
      blocking: blocking.length,
      blockingTitles: blocking.map((f) => f.title).slice(0, 10),
      uncheckedBlocking,
      path: out, head, reviewedAt: now,
    });
  },

  // -----------------------------------------------------------------------
  // review-accept  --feature <f> --note "<why>"
  //
  // Record that a HUMAN chose to ship despite blocking findings. Without this the
  // override lives only in the transcript, and the next session reads CODE-REVIEW.md
  // as an unresolved blocker. Flips `accepted: no` -> `yes` and appends the reason.
  // Refuses when there is no review, so it cannot be used to fake one.
  // -----------------------------------------------------------------------
  'review-accept'(args) {
    const feature = args.feature;
    if (!feature) return err('MISSING_ARG: --feature <f>');
    const note = args.note ? String(args.note).trim() : '';
    if (!note) return err('MISSING_ARG: --note "<why the user accepted the blocking findings>"');

    const out = reviewPathFor(feature);
    if (!fs.existsSync(out)) return err(`NOT_FOUND: ${out} — run review-collect first; acceptance without a review is not a decision.`);

    let text;
    try { text = fs.readFileSync(out, 'utf8'); } catch (e) { return err(`READ_FAILED: ${e.message}`); }
    const now = new Date().toISOString();
    if (/^accepted:[ \t]*/im.test(text)) text = text.replace(/^accepted:[ \t]*.*$/im, 'accepted: yes');
    else text = text.replace(/^(head:.*)$/im, '$1\naccepted: yes');
    text = text.replace(/\s*$/, '\n');
    text += `\n## Accepted\n\n- ${now} — shipped with open findings: ${note}\n`;

    try { fs.writeFileSync(out, text); } catch (e) { return err(`WRITE_FAILED: ${e.message}`); }
    return ok({ feature, accepted: true, path: out, at: now, note });
  },
};

// Helpers for status-report and the tests. Attached NON-ENUMERABLY: flow-tools.cjs
// builds its command table by spreading this module, and an enumerable non-function
// key there would surface as a callable command that throws.
Object.defineProperty(module.exports, 'internals', {
  value: { reviewPathFor, readExistingReview, normSeverity, resolveGate, SEVERITIES, BLOCKING },
  enumerable: false,
});
