/**
 * Unit tests for lib/review.cjs — the OPTIONAL pre-ship code-review gate
 * (review-scope / review-collect / review-accept). Direct-require, chdir-to-tmp
 * (the commands read .spec-flow/ relative to cwd).
 *
 * Run:  node --test test/review.test.cjs   (or: node --test test/*.test.cjs)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const review = require('../lib/review.cjs');

function inTmp(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-review-'));
  try { process.chdir(dir); return fn(fs.realpathSync(dir)); }
  finally { process.chdir(prev); }
}

function writeConfig(cfg) {
  fs.mkdirSync('.spec-flow', { recursive: true });
  fs.writeFileSync('.spec-flow/config.json', JSON.stringify(cfg, null, 2));
}
function writeTrace(feature) {
  fs.mkdirSync(path.join('.spec-flow/specs', feature), { recursive: true });
  fs.writeFileSync('.spec-flow/trace.json', JSON.stringify({ feature }));
}
function writeFileLinks(feature, files) {
  fs.mkdirSync(path.join('.spec-flow/specs', feature), { recursive: true });
  fs.writeFileSync(
    path.join('.spec-flow/specs', feature, 'file-links.json'),
    JSON.stringify({ links: files.map((f, i) => ({ task: String(i + 1), fr: 'FR-001', file: f })) })
  );
}
/** A real git repo with a base branch and one commit on a work branch. */
function initRepo(base = 'main') {
  const g = (...a) => execFileSync('git', a, { stdio: 'pipe' });
  g('init', '-q', '-b', base);
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync('seed.txt', 'seed\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'seed');
  g('checkout', '-q', '-b', 'feat/demo');
  fs.writeFileSync('impl.js', 'module.exports = 1;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'impl');
}

// --------------------------------------------------------------------------
// review-scope — gate resolution
// --------------------------------------------------------------------------

test('review-scope: NO_FEATURE when nothing resolves', () => {
  inTmp(() => {
    writeConfig({ project: 'p' });
    const r = review['review-scope']({});
    assert.equal(r.ok, false);
    assert.match(r.error, /NO_FEATURE/);
  });
});

test('review-scope: absent config.phase.codeReview defaults to off (opt-in gate)', () => {
  inTmp(() => {
    writeConfig({ project: 'p', phase: { confirmTasks: true } });
    writeTrace('demo');
    const r = review['review-scope']({});
    assert.equal(r.ok, true);
    assert.equal(r.data.gate, 'off');
    assert.equal(r.data.gateSource, 'default');
    assert.equal(r.data.feature, 'demo');
  });
});

test('review-scope: gate honours off / always / ask', () => {
  for (const [value, expected] of [['off', 'off'], ['always', 'always'], ['ask', 'ask'], ['ALWAYS', 'always']]) {
    inTmp(() => {
      writeConfig({ phase: { codeReview: value } });
      writeTrace('demo');
      const r = review['review-scope']({ feature: 'demo' });
      assert.equal(r.data.gate, expected, `codeReview: ${value}`);
      assert.equal(r.data.gateSource, 'config');
    });
  }
});

test('review-scope: booleans are accepted as the obvious shorthand', () => {
  inTmp(() => {
    writeConfig({ phase: { codeReview: false } });
    writeTrace('demo');
    assert.equal(review['review-scope']({ feature: 'demo' }).data.gate, 'off');
  });
  inTmp(() => {
    writeConfig({ phase: { codeReview: true } });
    writeTrace('demo');
    assert.equal(review['review-scope']({ feature: 'demo' }).data.gate, 'always');
  });
});

test('review-scope: a nonsense gate value falls back to off and says so', () => {
  inTmp(() => {
    writeConfig({ phase: { codeReview: 'maybe' } });
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.gate, 'off');
    assert.equal(r.data.gateSource, 'invalid');
    assert.equal(r.data.invalidGateValue, 'maybe');
  });
});

test('review-scope: model defaults to sonnet, honours an explicit null', () => {
  inTmp(() => {
    writeConfig({ phase: { codeReview: 'ask' } });
    writeTrace('demo');
    assert.equal(review['review-scope']({ feature: 'demo' }).data.model, 'sonnet');
  });
  inTmp(() => {
    writeConfig({ models: { codeReviewer: null } });
    writeTrace('demo');
    assert.equal(review['review-scope']({ feature: 'demo' }).data.model, null);
  });
});

// --------------------------------------------------------------------------
// review-scope — scope derivation
// --------------------------------------------------------------------------

test('review-scope: files come from file-links.json, deduped and sorted', () => {
  inTmp(() => {
    writeConfig({});
    writeTrace('demo');
    writeFileLinks('demo', ['src/b.js', 'src/a.js', 'src/b.js']);
    const r = review['review-scope']({ feature: 'demo' });
    assert.deepEqual(r.data.files, ['src/a.js', 'src/b.js']);
    assert.equal(r.data.fileCount, 2);
  });
});

test('review-scope: range is <base>...HEAD on a work branch', () => {
  inTmp(() => {
    initRepo('main');
    writeConfig({ branching: { mode: 'per-sd', base: 'main' } });
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.branch, 'feat/demo');
    assert.equal(r.data.base, 'main');
    assert.equal(r.data.onBase, false);
    assert.equal(r.data.range, 'main...HEAD');
  });
});

test('review-scope: no range when branching is off or we are on base', () => {
  inTmp(() => {
    initRepo('main');
    execFileSync('git', ['checkout', '-q', 'main'], { stdio: 'pipe' });
    writeConfig({ branching: { mode: 'per-sd', base: 'main' } });
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.onBase, true);
    assert.equal(r.data.range, null, 'on base there is no branch diff to review');
  });
  inTmp(() => {
    initRepo('main');
    writeConfig({ branching: { mode: 'off', base: 'main' } });
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.branchingOff, true);
    assert.equal(r.data.range, null);
  });
});

test('review-scope: an unresolvable base ref yields range null, not a bogus range', () => {
  inTmp(() => {
    initRepo('main');
    writeConfig({ branching: { mode: 'per-sd', base: 'trunk' } });
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.range, null);
  });
});

test('review-scope: multi-repo reports each repo root', () => {
  inTmp((dir) => {
    fs.mkdirSync(path.join(dir, '..', path.basename(dir) + '-svc'), { recursive: true });
    writeConfig({ repos: { 'svc-a': '../' + path.basename(dir) + '-svc' } });
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.multiRepo, true);
    assert.deepEqual(r.data.repos.map((x) => x.name), ['svc-a']);
  });
});

test('review-scope: contextPack returns only the spec artifacts that exist', () => {
  inTmp(() => {
    writeConfig({});
    writeTrace('demo');
    const dir = path.join('.spec-flow/specs', 'demo');
    fs.writeFileSync(path.join(dir, 'SD.md'), '# SD\n');
    fs.writeFileSync(path.join(dir, 'CHECKLIST.yaml'), 'suites: []\n');
    fs.writeFileSync('.spec-flow/project-author.md', '# conventions\n');
    const r = review['review-scope']({ feature: 'demo' });
    assert.deepEqual(Object.keys(r.data.contextPack).sort(), ['checklist', 'projectAuthor', 'sd']);
    assert.equal(r.data.contextPack.sd, path.join(dir, 'SD.md'));
    // CONTEXT.md / VERIFICATION.md were never written — absent, not null-valued.
    assert.ok(!('context' in r.data.contextPack));
    assert.ok(!('verification' in r.data.contextPack));
  });
});

test('review-scope: contextPack is empty, not an error, on a feature with no artifacts yet', () => {
  inTmp(() => {
    writeConfig({});
    writeTrace('demo');
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.contextPack, {});
  });
});

// --------------------------------------------------------------------------
// review-collect — verdict + artifact
// --------------------------------------------------------------------------

test('review-collect: --feature is required (never inferred from the shared mirror)', () => {
  inTmp(() => {
    writeTrace('demo');
    const r = review['review-collect']({ findings: '{"findings":[]}' });
    assert.equal(r.ok, false);
    assert.match(r.error, /MISSING_ARG: --feature/);
  });
});

test('review-collect: zero findings is clean, and writes the artifact anyway', () => {
  inTmp(() => {
    writeTrace('demo');
    const r = review['review-collect']({ feature: 'demo', findings: '{"findings":[]}' });
    assert.equal(r.ok, true);
    assert.equal(r.data.status, 'clean');
    assert.equal(r.data.total, 0);
    const md = fs.readFileSync('.spec-flow/specs/demo/CODE-REVIEW.md', 'utf8');
    assert.match(md, /^status: clean$/m);
    assert.match(md, /^accepted: no$/m);
  });
});

test('review-collect: medium/low only is advisory, not blocking', () => {
  inTmp(() => {
    writeTrace('demo');
    const findings = JSON.stringify({ findings: [
      { severity: 'medium', title: 'duplicated parser' },
      { severity: 'low', title: 'stale comment' },
    ] });
    const r = review['review-collect']({ feature: 'demo', findings });
    assert.equal(r.data.status, 'advisory');
    assert.equal(r.data.blocking, 0);
    assert.equal(r.data.counts.medium, 1);
    assert.equal(r.data.counts.low, 1);
  });
});

test('review-collect: any critical/high makes the verdict blocking', () => {
  inTmp(() => {
    writeTrace('demo');
    const findings = JSON.stringify({ findings: [
      { severity: 'low', title: 'nit' },
      { severity: 'high', title: 'unchecked null on the refund path', file: 'src/pay.js', line: 42 },
    ] });
    const r = review['review-collect']({ feature: 'demo', findings });
    assert.equal(r.data.status, 'blocking');
    assert.equal(r.data.blocking, 1);
    assert.deepEqual(r.data.blockingTitles, ['unchecked null on the refund path']);
    const md = fs.readFileSync(r.data.path, 'utf8');
    // Blocking findings sort to the top so a human reads them first.
    assert.ok(md.indexOf('[high]') < md.indexOf('[low]'));
    assert.match(md, /src\/pay\.js:42/);
    assert.match(md, /## Ship decision/);
  });
});

test('review-collect: an unknown severity degrades to low instead of vanishing', () => {
  inTmp(() => {
    writeTrace('demo');
    const r = review['review-collect']({ feature: 'demo', findings: '{"findings":[{"severity":"spicy","title":"x"}]}' });
    assert.equal(r.data.total, 1);
    assert.equal(r.data.counts.low, 1);
    assert.equal(r.data.status, 'advisory');
  });
});

test('review-collect: blocker/major synonyms map onto the blocking severities', () => {
  inTmp(() => {
    writeTrace('demo');
    const r = review['review-collect']({ feature: 'demo', findings: '{"findings":[{"severity":"blocker","title":"a"},{"severity":"major","title":"b"}]}' });
    assert.equal(r.data.counts.critical, 1);
    assert.equal(r.data.counts.high, 1);
    assert.equal(r.data.status, 'blocking');
  });
});

test('review-collect: reads findings from a file and tolerates a fenced blob', () => {
  inTmp(() => {
    writeTrace('demo');
    fs.writeFileSync('f.json', '```json\n{"findings":[{"severity":"high","title":"boom"}]}\n```\n');
    const r = review['review-collect']({ feature: 'demo', findings: 'f.json' });
    assert.equal(r.ok, true);
    assert.equal(r.data.status, 'blocking');
  });
});

test('review-collect: a bare array is accepted; garbage is rejected', () => {
  inTmp(() => {
    writeTrace('demo');
    assert.equal(review['review-collect']({ feature: 'demo', findings: '[{"severity":"low","title":"x"}]' }).data.total, 1);
    const bad = review['review-collect']({ feature: 'demo', findings: 'not json at all' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /BAD_JSON/);
    const shape = review['review-collect']({ feature: 'demo', findings: '{"notFindings":1}' });
    assert.equal(shape.ok, false);
    assert.match(shape.error, /BAD_SHAPE/);
  });
});

test('review-collect: a blocking finding without checkedAgainst is flagged, not dropped', () => {
  inTmp(() => {
    writeTrace('demo');
    const findings = JSON.stringify({ findings: [
      { severity: 'high', title: 'vague worry' },
      { severity: 'critical', title: 'refund double-spend', checkedAgainst: 'FR-007' },
    ] });
    const r = review['review-collect']({ feature: 'demo', findings });
    // Still blocking, still written down — losing a real finding to a missing
    // field would be worse than surfacing it for a second pass.
    assert.equal(r.data.status, 'blocking');
    assert.equal(r.data.blocking, 2);
    assert.deepEqual(r.data.uncheckedBlocking, ['vague worry']);
    assert.match(fs.readFileSync(r.data.path, 'utf8'), /- checked against: FR-007/);
  });
});

test('review-collect: advisory findings never populate uncheckedBlocking', () => {
  inTmp(() => {
    writeTrace('demo');
    const r = review['review-collect']({ feature: 'demo', findings: '{"findings":[{"severity":"low","title":"naming"}]}' });
    assert.deepEqual(r.data.uncheckedBlocking, []);
  });
});

// --------------------------------------------------------------------------
// review-accept
// --------------------------------------------------------------------------

test('review-accept: refuses without a prior review — acceptance is not a review', () => {
  inTmp(() => {
    writeTrace('demo');
    const r = review['review-accept']({ feature: 'demo', note: 'ship it' });
    assert.equal(r.ok, false);
    assert.match(r.error, /NOT_FOUND/);
  });
});

test('review-accept: requires a reason', () => {
  inTmp(() => {
    writeTrace('demo');
    review['review-collect']({ feature: 'demo', findings: '{"findings":[{"severity":"high","title":"x"}]}' });
    const r = review['review-accept']({ feature: 'demo' });
    assert.equal(r.ok, false);
    assert.match(r.error, /MISSING_ARG: --note/);
  });
});

test('review-accept: flips accepted and appends the reason', () => {
  inTmp(() => {
    writeTrace('demo');
    review['review-collect']({ feature: 'demo', findings: '{"findings":[{"severity":"high","title":"x"}]}' });
    const r = review['review-accept']({ feature: 'demo', note: 'false positive, covered by TC-014' });
    assert.equal(r.ok, true);
    const md = fs.readFileSync(r.data.path, 'utf8');
    assert.match(md, /^accepted: yes$/m);
    assert.match(md, /false positive, covered by TC-014/);
    assert.equal(review.internals.readExistingReview('demo').accepted, true);
  });
});

// --------------------------------------------------------------------------
// Round-trip: scope sees what collect wrote
// --------------------------------------------------------------------------

test('review-scope: surfaces a prior review and flags it stale once HEAD moves', () => {
  inTmp(() => {
    initRepo('main');
    writeConfig({ branching: { mode: 'per-sd', base: 'main' } });
    writeTrace('demo');
    review['review-collect']({ feature: 'demo', findings: '{"findings":[{"severity":"high","title":"x"}]}' });

    let r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.existing.status, 'blocking');
    assert.equal(r.data.existing.counts.high, 1);
    assert.equal(r.data.stale, false, 'same HEAD — the review still covers the tip');

    fs.writeFileSync('more.js', 'x\n');
    execFileSync('git', ['add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'more'], { stdio: 'pipe' });

    r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.data.stale, true, 'HEAD moved — the old verdict no longer covers it');
  });
});

test('review module exports only callable commands (internals stay non-enumerable)', () => {
  for (const [name, value] of Object.entries(review)) {
    assert.equal(typeof value, 'function', `${name} must be a command function`);
  }
  assert.ok(review.internals, 'internals still reachable for status-report');
  assert.ok(!Object.keys(review).includes('internals'));
});
