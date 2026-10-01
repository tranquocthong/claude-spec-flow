/**
 * Grep-style contract tests for code-rules-gate task 4 — makes `## Code Rules`
 * bullets binding in the agent/command contract (SD §5.1 FR-007..FR-010, §6.3 D5/D6).
 *
 * These assert on the literal prose of agents/hybrid-executor.md and
 * commands/phase.md (the agent prompt contracts), plus lib/review.cjs's
 * contextPack comment, rather than behavior — the "behavior" here is what an
 * LLM reads before acting, so the contract text itself is the testable surface.
 *
 * Run:  node --test test/code-rules-contract.test.cjs   (or: node --test test/*.test.cjs)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const phaseMd = fs.readFileSync(path.join(root, 'commands/phase.md'), 'utf8');
const executorMd = fs.readFileSync(path.join(root, 'agents/hybrid-executor.md'), 'utf8');
const reviewCjs = fs.readFileSync(path.join(root, 'lib/review.cjs'), 'utf8');
const bugMd = fs.readFileSync(path.join(root, 'commands/bug.md'), 'utf8');
const changeMd = fs.readFileSync(path.join(root, 'commands/change.md'), 'utf8');

test('commands/phase.md: "House style is not a finding" is gone (TC-026)', () => {
  assert.doesNotMatch(phaseMd, /House style is not a finding/);
});

test('commands/phase.md: projectAuthor line makes ## Code Rules a mandatory checklist with project-rule category + medium floor (FR-009)', () => {
  const idx = phaseMd.indexOf('`projectAuthor`');
  assert.ok(idx >= 0, 'projectAuthor context-pack line should still exist');
  const line = phaseMd.slice(idx, idx + 400);
  assert.match(line, /## Code Rules/);
  assert.match(line, /mandatory checklist/);
  assert.match(line, /project-rule/);
  assert.match(line, /checkedAgainst/);
  assert.match(line, /medium/);
});

test('commands/phase.md: taste/naming outside ## Code Rules stays low (FR-010)', () => {
  const idx = phaseMd.indexOf('`projectAuthor`');
  const line = phaseMd.slice(idx, idx + 400);
  assert.match(line, /outside `## Code Rules`[\s\S]*low/);
});

test('commands/phase.md: reviewer output contract accepts category "project-rule"', () => {
  const idx = phaseMd.indexOf('"findings":[{"severity"');
  assert.ok(idx >= 0, 'output contract JSON example should exist');
  const line = phaseMd.slice(idx, idx + 300);
  assert.match(line, /project-rule/);
});

test('commands/phase.md step 2: orchestrator pastes ## Code Rules bullets verbatim into the executor prompt (FR-008)', () => {
  assert.match(phaseMd, /## Code Rules.*verbatim/);
});

test('commands/phase.md step 2: orchestrator rejects a summary missing the rule compliance table (FR-008, TC-025)', () => {
  const idx = phaseMd.indexOf('Check the `## Code Rules` compliance table');
  assert.ok(idx >= 0, 'orchestrator must check the rule compliance table like TDD evidence');
  const block = phaseMd.slice(idx, idx + 400);
  assert.match(block, /violated/);
  assert.match(block, /send it back/);
});

test('commands/phase.md step 4: code-rules failures halt the gate like other static checks', () => {
  const idx = phaseMd.indexOf('Automated quality gate');
  assert.ok(idx >= 0);
  const block = phaseMd.slice(idx, idx + 900);
  assert.match(block, /code-rules/);
  assert.match(block, /config\.verify\.rules/);
});

test('agents/hybrid-executor.md Inputs: ## Code Rules bullets are binding, not "read if present" (FR-007)', () => {
  const idx = executorMd.indexOf('## Inputs');
  assert.ok(idx >= 0);
  const block = executorMd.slice(idx, idx + 1200);
  assert.match(block, /## Code Rules/);
  assert.match(block, /binding/);
});

test('agents/hybrid-executor.md step 5: self-check requires Rule | Status | Notes table with pass/n/a/violated (FR-007, TC-023, TC-024)', () => {
  const idx = executorMd.indexOf('Self-check diff against SD');
  assert.ok(idx >= 0);
  const block = executorMd.slice(idx, idx + 1200);
  assert.match(block, /Rule\s*\|\s*Status\s*\|\s*Notes/);
  assert.match(block, /\bpass\b/);
  assert.match(block, /\bn\/a\b/);
  assert.match(block, /violated/);
  assert.match(block, /fix it before returning|must be fixed before/i);
});

test('agents/hybrid-executor.md GREEN phase: runs verify-code and fixes any code-rules failure', () => {
  const idx = executorMd.indexOf('GREEN phase');
  assert.ok(idx >= 0);
  const block = executorMd.slice(idx, idx + 900);
  assert.match(block, /verify-code/);
  assert.match(block, /code-rules/);
  assert.match(block, /config\.verify\.rules/);
});

// /sf:bug spawns hybrid-executor directly (not via /sf:phase), so it must carry
// the same Code Rules contract itself or a bug fix bypasses the rules.
function section(md, startMarker, endMarker) {
  const start = md.indexOf(startMarker);
  assert.ok(start >= 0, `missing section marker: ${startMarker}`);
  const end = md.indexOf(endMarker, start + startMarker.length);
  return md.slice(start, end < 0 ? undefined : end);
}

test('commands/bug.md STEP 4a: pastes ## Code Rules verbatim and checks the compliance table', () => {
  const block = section(bugMd, '## STEP 4a', '## STEP 5');
  assert.match(block, /## Code Rules[\s\S]*verbatim/);
  assert.match(block, /Rule \| Status \| Notes/);
  assert.match(block, /violated/);
  assert.match(block, /send it back/);
});

test('commands/bug.md STEP 5: runs verify-code (incl. code-rules) before the repro, failing loops back to 4a', () => {
  const block = section(bugMd, '## STEP 5', '## STEP 6');
  const gate = block.indexOf('verify-code --feature');
  const repro = block.indexOf('run-checklist.sh');
  assert.ok(gate >= 0, 'STEP 5 must run verify-code');
  assert.ok(gate < repro, 'verify-code must run before the repro checklist');
  assert.match(block, /code-rules/);
  assert.match(block, /config\.verify\.rules/);
  assert.match(block, /loop back to STEP 4a/);
});

test('commands/change.md step 6: runs verify-code (incl. code-rules) over the whole change before the checklist', () => {
  const block = section(changeMd, '6. **Re-verify**', '7. **State sync**');
  const gate = block.indexOf('verify-code --feature');
  const smoke = block.indexOf('run-checklist.sh');
  assert.ok(gate >= 0, 'step 6 must run verify-code');
  assert.ok(gate < smoke, 'verify-code must run before the smoke checklist');
  assert.match(block, /code-rules/);
  assert.match(block, /config\.verify\.rules/);
});

test('commands/change.md step 6: routes through the phase code review (3b) so project-rule findings block', () => {
  const block = section(changeMd, '6. **Re-verify**', '7. **State sync**');
  assert.match(block, /step 3b/);
  assert.match(block, /review-collect/);
  assert.match(block, /config\.phase\.codeReview/);
  assert.match(block, /project-rule/);
  assert.match(block, /review-accept/);
});

test('lib/review.cjs: contextPack comment no longer says house style is not a finding', () => {
  assert.doesNotMatch(reviewCjs, /house style is not a finding/i);
});

test('lib/review.cjs: contextPack comment reflects project-rule / medium floor for projectAuthor', () => {
  const idx = reviewCjs.indexOf('projectAuthor —');
  assert.ok(idx >= 0, 'projectAuthor comment line should exist');
  const line = reviewCjs.slice(idx, idx + 200);
  assert.match(line, /project-rule/);
});

test('review-collect: a project-rule finding blocks the ship even at medium (the team reviewer would reject it)', () => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const review = require('../lib/review.cjs');
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-code-rules-contract-'));
  try {
    process.chdir(dir);
    fs.mkdirSync('.spec-flow/specs/demo', { recursive: true });
    execFileSync('git', ['init', '-q']);
    const findings = {
      findings: [
        {
          severity: 'medium',
          title: 'Missing @SchedulerLock',
          file: 'src/Job.java',
          line: 10,
          category: 'project-rule',
          checkedAgainst: '@Scheduled must have @SchedulerLock',
          detail: '@Scheduled method with no @SchedulerLock -> not safe across pods',
        },
      ],
    };
    const r = review['review-collect']({ feature: 'demo', findings: JSON.stringify(findings) });
    assert.equal(r.ok, true);
    assert.equal(r.data.status, 'blocking');
    assert.equal(r.data.blocking, 1);
    const md = fs.readFileSync('.spec-flow/specs/demo/CODE-REVIEW.md', 'utf8');
    assert.match(md, /project-rule/);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review-collect: a project-rule finding rated low is raised to the medium floor', () => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const review = require('../lib/review.cjs');
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-code-rules-floor-'));
  try {
    process.chdir(dir);
    fs.mkdirSync('.spec-flow/specs/demo', { recursive: true });
    execFileSync('git', ['init', '-q']);
    const findings = [
      { severity: 'low', title: 'ResponseEntity in controller', category: 'project-rule', checkedAgainst: 'use @ResponseStatus, not ResponseEntity' },
      { severity: 'low', title: 'rename var', category: 'simplification' },
    ];
    const r = review['review-collect']({ feature: 'demo', findings: JSON.stringify(findings) });
    assert.equal(r.ok, true);
    assert.equal(r.data.status, 'blocking');
    assert.equal(r.data.blocking, 1, 'only the project-rule finding blocks; taste stays advisory');
    const md = fs.readFileSync('.spec-flow/specs/demo/CODE-REVIEW.md', 'utf8');
    assert.match(md, /medium/);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commands/phase.md step 3b: the code review is opt-in, default off, never self-started', () => {
  const start = phaseMd.indexOf('3b. **Code review');
  const block = phaseMd.slice(start, phaseMd.indexOf('4. **Ship**', start));
  assert.match(block, /default `off`/);
  assert.match(block, /Do NOT run, offer, or suggest a code review unless `review-scope` returns `gate: ask` or `gate: always`/);
  assert.doesNotMatch(block, /\*\*`ask`\*\* \(default\)/);
});

test('commands/phase.md step 3b: gate ask is a real AskUserQuestion and only an explicit yes runs the review', () => {
  const start = phaseMd.indexOf('3b. **Code review');
  const block = phaseMd.slice(start, phaseMd.indexOf('4. **Ship**', start));
  assert.match(block, /`AskUserQuestion` tool call/);
  assert.match(block, /Only an explicit `Yes, run the review` runs the review/);
  assert.match(block, /Silence is never consent/);
  assert.match(block, /auto-mode/);
});
