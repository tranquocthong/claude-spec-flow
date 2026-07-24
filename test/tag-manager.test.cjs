/**
 * Unit tests for lib/tag-manager.cjs — TagManager module.
 *
 * Covers FR-001 (tag isolation), FR-002 (useTag / getCurrentTag / resolveTag),
 * FR-003 (auto-create namespace on write), FR-004 (ERR_TAG_NOT_FOUND on read).
 *
 * Each test uses its own mkdtemp-isolated tmp dir with injected _paths so the
 * real .taskmaster/ is NEVER touched during testing.
 *
 * Run:  node test/tag-manager.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Module import — RED phase: module does not exist yet → will fail here
// ---------------------------------------------------------------------------

let tagManager;
test('tag-manager module imports without throwing', () => {
  tagManager = require('../lib/tag-manager.cjs');
});

// ---------------------------------------------------------------------------
// Helper — each test gets its own isolated tmp directory so no shared state
// leaks between tests.
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tag-manager-test-'));
}

function makePaths(tmpDir) {
  return {
    tasksFile: path.join(tmpDir, '.taskmaster', 'tasks', 'tasks.json'),
    stateFile: path.join(tmpDir, '.taskmaster', 'state.json'),
  };
}

// ---------------------------------------------------------------------------
// Test 1: getCurrentTag returns the tag string when state.json has currentTag
// (FR-002, TC-003)
// ---------------------------------------------------------------------------

test('getCurrentTag returns the tag string when state.json has currentTag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Write state.json with a currentTag
  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ currentTag: 'feat-alpha', extra: 'keep' }), 'utf8');

  const tag = tagManager.getCurrentTag(_paths);
  assert.equal(tag, 'feat-alpha', 'getCurrentTag must return "feat-alpha"');
});

// ---------------------------------------------------------------------------
// Test 2: getCurrentTag throws ERR_NO_CURRENT_TAG when state.json is absent
// (FR-002)
// ---------------------------------------------------------------------------

test('getCurrentTag throws ERR_NO_CURRENT_TAG when state.json does not exist', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // state.json does not exist in tmpDir

  let thrown;
  try {
    tagManager.getCurrentTag(_paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'getCurrentTag must throw when state.json is absent');
  assert.equal(thrown.code, 'ERR_NO_CURRENT_TAG', 'error .code must be ERR_NO_CURRENT_TAG');
});

// ---------------------------------------------------------------------------
// Test 3: getCurrentTag throws ERR_NO_CURRENT_TAG when state.json has no currentTag
// (FR-002)
// ---------------------------------------------------------------------------

test('getCurrentTag throws ERR_NO_CURRENT_TAG when state.json has no currentTag field', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ otherField: 'value' }), 'utf8');

  let thrown;
  try {
    tagManager.getCurrentTag(_paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'getCurrentTag must throw when currentTag is absent from state.json');
  assert.equal(thrown.code, 'ERR_NO_CURRENT_TAG', 'error .code must be ERR_NO_CURRENT_TAG');
});

// ---------------------------------------------------------------------------
// Test 4: useTag writes currentTag into state.json and merges (does not overwrite
// other fields already present). (FR-002, TC-002, SD §6 D6 merge)
// ---------------------------------------------------------------------------

test('useTag writes currentTag to state.json and merges without overwriting other fields', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Pre-populate state.json with an extra field that must survive the merge
  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ existingField: 'keep-me' }), 'utf8');

  tagManager.useTag('feat-x', _paths);

  const state = JSON.parse(fs.readFileSync(_paths.stateFile, 'utf8'));
  assert.equal(state.currentTag, 'feat-x', 'state.json must have currentTag="feat-x"');
  assert.equal(state.existingField, 'keep-me',
    'pre-existing fields must survive the useTag merge (not overwrite the whole file)');
});

// ---------------------------------------------------------------------------
// Test 5: useTag auto-creates tag namespace in tasks.json when the tag is absent
// (FR-003, TC-004)
// ---------------------------------------------------------------------------

test('useTag auto-creates tasks.json[tag] = {tasks:[], metadata:{}} when tag does not exist', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // tasks.json does not exist yet

  tagManager.useTag('brand-new', _paths);

  assert.ok(fs.existsSync(_paths.tasksFile), 'tasks.json must be created by useTag');
  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  assert.ok(data['brand-new'], 'tasks.json must contain the "brand-new" namespace');
  assert.deepEqual(data['brand-new'], { tasks: [], metadata: {} },
    'auto-created namespace must be {tasks:[], metadata:{}}');
});

// ---------------------------------------------------------------------------
// Test 6: resolveTag returns the explicit tag when one is provided; tag isolation
// means explicit tag is always honoured (FR-001, FR-002)
// ---------------------------------------------------------------------------

test('resolveTag returns the explicit tag when truthy, ignoring state.json', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // state.json has a different currentTag — explicit tag must win
  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ currentTag: 'state-tag' }), 'utf8');

  const resolved = tagManager.resolveTag('explicit-tag', _paths);
  assert.equal(resolved, 'explicit-tag',
    'resolveTag must return the explicit tag and never fall back to state.json when explicit is given');
});

// ---------------------------------------------------------------------------
// Test 7: resolveTag falls back to getCurrentTag when explicit tag is falsy
// (FR-002, TC-003)
// ---------------------------------------------------------------------------

test('resolveTag falls back to getCurrentTag when explicit tag is not provided', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ currentTag: 'feat-fallback' }), 'utf8');

  const resolved = tagManager.resolveTag(null, _paths);
  assert.equal(resolved, 'feat-fallback',
    'resolveTag must fall back to state.json currentTag when explicit tag is null');
});

// ---------------------------------------------------------------------------
// Test 8a: ensureTagExists(tag, false) throws ERR_TAG_NOT_FOUND for a nonexistent tag
// (FR-004, TC-006)
// ---------------------------------------------------------------------------

test('ensureTagExists with forWrite=false throws ERR_TAG_NOT_FOUND for nonexistent tag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // tasks.json is absent — tag definitely does not exist

  let thrown;
  try {
    tagManager.ensureTagExists('ghost-tag', false, _paths);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'ensureTagExists(forWrite=false) must throw for a nonexistent tag');
  assert.equal(thrown.code, 'ERR_TAG_NOT_FOUND', 'error .code must be ERR_TAG_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Test 8b: ensureTagExists(tag, true) auto-creates namespace when tag is absent
// (FR-003, TC-005)
// ---------------------------------------------------------------------------

test('ensureTagExists with forWrite=true auto-creates namespace when tag is absent', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);
  // tasks.json is absent

  assert.doesNotThrow(
    () => tagManager.ensureTagExists('new-tag', true, _paths),
    'ensureTagExists(forWrite=true) must not throw for a nonexistent tag'
  );

  assert.ok(fs.existsSync(_paths.tasksFile), 'tasks.json must be created');
  const data = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  assert.ok(data['new-tag'], 'tasks.json must contain the "new-tag" namespace');
  assert.deepEqual(data['new-tag'], { tasks: [], metadata: {} },
    'auto-created namespace must be {tasks:[], metadata:{}}');
});

// ---------------------------------------------------------------------------
// TC-001 — Tag isolation: tasks of tag A must not appear in tag B's namespace
// (FR-001, SD §3.1 Goals — "cô lập tag tuyệt đối")
//
// Seed tasks.json with tagA + tagB each having distinct tasks; verify that
// each tag namespace contains only its own tasks — no cross-contamination.
// ---------------------------------------------------------------------------

test('TC-001 tag isolation: tasks in tagA namespace are separate from tasks in tagB namespace', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Seed tasks.json with two distinct tag namespaces, each with unique tasks.
  const tasksData = {
    'tag-alpha': {
      tasks: [
        { id: '1', title: 'Task in alpha', status: 'pending', dependencies: [], subtasks: [] },
        { id: '2', title: 'Also in alpha', status: 'pending', dependencies: [], subtasks: [] },
      ],
      metadata: {},
    },
    'tag-beta': {
      tasks: [
        { id: '10', title: 'Task in beta', status: 'pending', dependencies: [], subtasks: [] },
      ],
      metadata: {},
    },
  };
  fs.mkdirSync(path.dirname(_paths.tasksFile), { recursive: true });
  fs.writeFileSync(_paths.tasksFile, JSON.stringify(tasksData, null, 2), 'utf8');

  // ensureTagExists(forWrite=false) must succeed for both — they both exist.
  assert.doesNotThrow(
    () => tagManager.ensureTagExists('tag-alpha', false, _paths),
    'ensureTagExists must succeed for tag-alpha'
  );
  assert.doesNotThrow(
    () => tagManager.ensureTagExists('tag-beta', false, _paths),
    'ensureTagExists must succeed for tag-beta'
  );

  // Read back and verify that tag-alpha contains only its own tasks.
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  const alphaIds = stored['tag-alpha'].tasks.map((t) => t.id);
  const betaIds = stored['tag-beta'].tasks.map((t) => t.id);

  assert.ok(alphaIds.includes('1'), 'tag-alpha must contain task "1"');
  assert.ok(alphaIds.includes('2'), 'tag-alpha must contain task "2"');
  assert.ok(!alphaIds.includes('10'), 'tag-alpha must NOT contain task "10" from tag-beta');

  assert.ok(betaIds.includes('10'), 'tag-beta must contain task "10"');
  assert.ok(!betaIds.includes('1'), 'tag-beta must NOT contain task "1" from tag-alpha');
  assert.ok(!betaIds.includes('2'), 'tag-beta must NOT contain task "2" from tag-alpha');
});

// ---------------------------------------------------------------------------
// TC-001 extension: useTag switches between two tags without contaminating either
// namespace. After useTag("tag-alpha"), getCurrentTag returns "tag-alpha" and
// tasks.json["tag-beta"] is unmodified.
// (FR-001, FR-002)
// ---------------------------------------------------------------------------

test('useTag switching between tags does not contaminate either tag namespace', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Create two tags via useTag; verify each write leaves the other intact.
  tagManager.useTag('tag-one', _paths);
  tagManager.useTag('tag-two', _paths);

  // Switch to tag-one and verify getCurrentTag returns it.
  tagManager.useTag('tag-one', _paths);
  const currentTag = tagManager.getCurrentTag(_paths);
  assert.equal(currentTag, 'tag-one', 'getCurrentTag must return tag-one after useTag("tag-one")');

  // Both namespaces must still exist and be independent {tasks:[], metadata:{}}.
  const stored = JSON.parse(fs.readFileSync(_paths.tasksFile, 'utf8'));
  assert.ok(stored['tag-one'], 'tag-one namespace must still exist after switching');
  assert.ok(stored['tag-two'], 'tag-two namespace must still exist after switching to tag-one');
  assert.deepEqual(stored['tag-one'], { tasks: [], metadata: {} },
    'tag-one must have empty isolated namespace');
  assert.deepEqual(stored['tag-two'], { tasks: [], metadata: {} },
    'tag-two must have empty isolated namespace — not overwritten by tag-one');
});

// ---------------------------------------------------------------------------
// Edge case: malformed state.json (invalid JSON) → getCurrentTag must throw
// ERR_NO_CURRENT_TAG gracefully, not a raw JSON parse error.
// (SD §6 D6 — resilient read: "malformed JSON → treat as empty")
// ---------------------------------------------------------------------------

test('getCurrentTag throws ERR_NO_CURRENT_TAG gracefully when state.json contains malformed JSON', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Write deliberately invalid JSON to state.json — must be handled gracefully.
  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, 'this is not valid json {{{', 'utf8');

  let thrown;
  try {
    tagManager.getCurrentTag(_paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'getCurrentTag must throw when state.json is malformed');
  assert.equal(thrown.code, 'ERR_NO_CURRENT_TAG',
    'error .code must be ERR_NO_CURRENT_TAG (not a raw JSON parse error) — resilient read');
});

// ---------------------------------------------------------------------------
// Edge case: empty string currentTag in state.json → getCurrentTag must throw
// ERR_NO_CURRENT_TAG (empty string is not a valid tag name).
// (FR-002, SD §9.1 getCurrentTag — "typeof stateData.currentTag !== 'string' || !stateData.currentTag")
// ---------------------------------------------------------------------------

test('getCurrentTag throws ERR_NO_CURRENT_TAG when state.json has currentTag = "" (empty string)', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ currentTag: '' }), 'utf8');

  let thrown;
  try {
    tagManager.getCurrentTag(_paths);
  } catch (e) {
    thrown = e;
  }

  assert.ok(thrown, 'getCurrentTag must throw when currentTag is an empty string');
  assert.equal(thrown.code, 'ERR_NO_CURRENT_TAG',
    'error .code must be ERR_NO_CURRENT_TAG — empty string is not a valid tag');
});

// ---------------------------------------------------------------------------
// Edge case: resolveTag with empty string explicit tag falls back to getCurrentTag
// (FR-002 — empty string is falsy, so resolveTag treats it as "no explicit tag")
// ---------------------------------------------------------------------------

test('resolveTag treats empty string as falsy and falls back to getCurrentTag', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  fs.mkdirSync(path.dirname(_paths.stateFile), { recursive: true });
  fs.writeFileSync(_paths.stateFile, JSON.stringify({ currentTag: 'fallback-tag' }), 'utf8');

  // Empty string must be treated as "no explicit tag" — falls back to state.json.
  const resolved = tagManager.resolveTag('', _paths);
  assert.equal(resolved, 'fallback-tag',
    'resolveTag("") must fall back to state.json currentTag — empty string is falsy');
});

// ---------------------------------------------------------------------------
// Edge case: missing parent dirs auto-created on write.
// useTag must create the full directory tree (.taskmaster/tasks/ and .taskmaster/)
// when neither directory exists yet, and successfully write both state.json and
// tasks.json. (NFR-004 reliability + FR-003 auto-create)
// ---------------------------------------------------------------------------

test('useTag auto-creates the full .taskmaster/tasks/ directory tree when directories are absent', () => {
  const tmpDir = makeTmpDir();
  const _paths = makePaths(tmpDir);

  // Confirm that neither .taskmaster/ nor .taskmaster/tasks/ exist yet.
  const taskmasterDir = path.dirname(_paths.stateFile);
  const tasksDir = path.dirname(_paths.tasksFile);
  assert.ok(!fs.existsSync(taskmasterDir),
    'precondition: .taskmaster/ must not exist before useTag');
  assert.ok(!fs.existsSync(tasksDir),
    'precondition: .taskmaster/tasks/ must not exist before useTag');

  // useTag must not throw — it must create all required directories.
  assert.doesNotThrow(
    () => tagManager.useTag('auto-dirs-tag', _paths),
    'useTag must not throw even when parent directories are completely absent'
  );

  assert.ok(fs.existsSync(_paths.stateFile),
    'state.json must exist after useTag even though parent dirs were absent');
  assert.ok(fs.existsSync(_paths.tasksFile),
    'tasks.json must exist after useTag even though parent dirs were absent');

  const state = JSON.parse(fs.readFileSync(_paths.stateFile, 'utf8'));
  assert.equal(state.currentTag, 'auto-dirs-tag',
    'state.json.currentTag must be "auto-dirs-tag" after useTag');
});
