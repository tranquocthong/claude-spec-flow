# spec-flow guide

The full reference behind the [README](../README.md): every flow step by step, the gates,
the files it writes, configuration, Codex, and the engine commands.

- [The flows](#the-flows)
- [Gates that never move](#gates-that-never-move)
- [What lands in your repo](#what-lands-in-your-repo)
- [Configuration](#configuration)
- [Codex](#codex)
- [Engine reference](#engine-reference)
- [Repository layout](#repository-layout)
- [Status, tests and contributing](#status-tests-and-contributing)

## The flows

### Flow 1. New feature from an SRS or an idea

No SRS is the normal case. Run `/sf:ingest` bare and it asks about the actor, the behaviors, the rules and error cases, and the acceptance criteria, then writes `.spec-flow/srs/<feature>.md` for you. Prefer to write it yourself? A rough markdown file is fine. Behaviors become FRs, rules and errors become TCs and error codes, acceptance criteria become TCs. Spend your effort on behaviors and error cases. That is the part the AI cannot invent.

```
/sf:ingest <srs.md>
   srs-snapshot        frozen baseline for future diffs
   sd-skeleton         deterministic harvest into the SD template (dirty by design)
   sd-author (AI)      cleans the harvest into atomic FR/TC, fills architecture, API, state
   trace-build         FR <-> TC <-> error <-> state links in trace.json
   state-update        STATE.md with a deterministic next step
        |
   GATE  clear TODO:MANUAL-REVIEW markers, review, approve      <- your only control point
        |
/sf:checklist <feature>          SD section 13.2 -> CHECKLIST.yaml, co-located with the SD
        |
/sf:phase <feature>
   parse-prd            seeds one task per FR under a per-feature tag (only after 0 TODO)
   route --sd           scores each FR 1-10:  1-3 fast  |  4-7 expand into subtasks  |  8-10 research first
   per task             hybrid-executor writes code -> trace-link records files -> smoke run
                        PASS: done + state-update      FAIL: halt and surface
        |
   regression run       checklist-to-verification hook writes VERIFICATION.md
        |
   code review          OPTIONAL gate, off unless you enable it: an independent sub-agent
                        reviews the branch diff, review-collect writes CODE-REVIEW.md
                        critical/high halts the ship and hands you the decision
        |
   ship                 commit + push on the feature branch, PR/MR link surfaced
```

The SRS harvest is intentionally dirty. Judge the SD after `sd-author`, not the skeleton.

### Flow 1b. Epic split

When `/sf:ingest` reports `epicScale: true` (more than 25 FRs or 800 generated lines), run `/sf:split <srs.md>`. `sd-author` proposes two to five sub-features grouped by user-story range or bounded context. You approve or adjust the grouping. It is never auto-committed, because it is a design decision. Each sub-feature then gets its own SD, linked through the trace, and runs the normal pipeline independently. A later `/sf:resync` scopes impact to the affected sub-features only.

### Flow 2. Product changed the SRS (top-down)

```
/sf:resync <srs_v2.md>
   srs-diff        changeset against the last snapshot (anchored ids and tables, prose fallback)
   trace-impact    exact FR / TC / error / task ids touched
   sd-author       updates only the impacted SD sections
   GATE            review the delta, approve
   cascade         re-open impacted done tasks, regenerate impacted checklist rows
   srs-snapshot    new baseline, trace-build, state-update
/sf:phase <feature>   re-implement the re-opened tasks, re-test, close
```

This defends against "fix one place, forget three". Every touched task must pass manual-test again.

### Flow 3. You want to change the spec after implementation (bottom-up)

```
/sf:change "<description>" --type fix|enhance
   1. open .spec-flow/changes/<NNN>-change-<slug>.md          audit trail
   2. edit the SD section first, never patch code blind
   3. trace-impact -> impacted tasks, re-open them
   4. /sf:phase -> executor edits code -> smoke run
   5. satisfied: change done, VERIFICATION.md updated. Not satisfied: back to 2
```

Fast path: when the impact is one FR/TC and one task, the change record is one line, you edit the SD row directly, and only that TC is verified. Full regression runs at close. `/sf:change` requires an existing SD. If there is no SD, or the code simply misbehaves against a correct SD, it is a bug.

### Flow 4. Bug

A bug is not always a spec change. Triage decides the route:

| Kind | Criteria | Route |
| --- | --- | --- |
| Code bug | SD is right, code is wrong | Fix code only. Never edit the SD. Repro test stays as regression coverage |
| Spec bug | SD is wrong or incomplete | Hand off to `/sf:change --type fix` |
| SRS-level | Requirement misunderstanding | Hand off to `/sf:resync` |

**Repro first.** A failing `CHECKLIST.yaml` entry is written and confirmed red before any code changes. After the fix it turns green and stays.

**SD optional.** On a project or feature with no SD, `/sf:bug` skips triage and treats it as a code bug. The repro test plus expected/actual is the contract.

### Refactor and brownfield

A refactor is ordinary work. A substantial one gets an SRS whose requirements are the behaviors that must stay identical, and the checklist becomes the characterization suite. Capture those tests from the running system, not from prose you might misremember. A trivial one is just done.

For code written before you adopted spec-flow, do not retro-generate an SD. The SRS says as-specified, the code says as-built, and an SD that matches neither is worse than none because the whole model trusts it. Fix legacy bugs with `/sf:bug`. Spec only the delta for legacy changes with a focused `/sf:ingest`. Adopt forward, not backward.

## Gates that never move

1. **`/sf:ingest` never implements.** It stops at the SD review gate. Discussing a feature is not permission to build it.
2. **No task seeding while the SD has a `TODO:MANUAL-REVIEW` marker.** Layer 2 is `drift-check` (error codes in code versus SD section 12.2) and the `sd-drift-detect` hook (file edits outside the trace). Both advisory.
3. **`CHECKLIST.yaml` exists before the first task is implemented.**
4. **`verify-code` runs before every smoke run.** Tests, coverage threshold, forbidden patterns, secret scan, driven by config. Unconfigured means skipped, not blocked.
5. **`review` becomes `done` only after smoke passes.** A feature ships only when regression passes and `VERIFICATION.md` reads `status: passed`. A test that executed nothing is `notVerified`, and holds the status at `incomplete`.
6. **The pre-ship code review is optional, but its verdict is not.** `config.phase.codeReview` decides whether it runs (`off` by default: it never runs and never asks. Set `ask` to be asked once per ship, or `always` to run it every ship). Skipping it is silent. Running it and finding critical or high issues halts the ship until you fix them or record the override with `review-accept`, and `/sf:status` keeps surfacing an unaccepted blocking verdict across sessions.
7. **The SD is the source of truth.** Change the SD, then propagate. Never patch code without patching the SD.

## What lands in your repo

spec-flow is a two-tier overlay. The plugin is the engine and never changes per project. The project's `.spec-flow/` directory is the living profile, committed by default so the spec history travels with the code.

```
.spec-flow/
  config.json                 stack, conventions, branching, models, verify, language
  project-author.md           SD-authoring rules that accumulate via `learn`
  srs/<feature>.md            the live input: a formal SRS or your idea
  specs/<feature>/
    SD.md                     the Solution Design, your control point
    CHECKLIST.yaml            manual tests, permanent regression coverage
    trace.json                durable per-feature traceability matrix
    file-links.json           task -> file and FR -> file evidence, survives rebuilds
    STATE.md                  per-feature state with a deterministic next step
    checkpoint.md             mid-task checkpoint, cleared when the task is done
    ship.json                 written at ship, retires the next step
  snapshots/                  frozen SRS baselines, never hand-edited
  bugs/  changes/  epics/     records for the change loops
  trace.json  STATE.md  VERIFICATION.md    mirrors of the active feature
.taskmaster/                  tasks.json (one tag per feature) + state.json
CONTEXT.md                    locked decisions, fed to every agent
```

Per-feature files are keyed by the feature directory, so two features can never clobber each other. The root mirrors are derived and regenerated on every `trace-build` or `state-update`. A merge conflict on a mirror is benign: take either side and rebuild.

## Configuration

Everything policy-shaped lives as data in `.spec-flow/config.json`, seeded by `/sf:init`.

**Branching.** One SD is one branch. `/sf:ingest` creates `feat/<feature>`. Bugs and changes get `fix/<id>-<slug>` and `<type>/<id>-<slug>`. The bundled commit skill refuses to commit on the base branch unless `mode` is `off`. Works the same on GitHub and GitLab.

```json
"branching": {
  "mode": "per-sd",
  "base": "main",
  "templates": { "sd": "feat/{feature}", "bug": "fix/{id}-{slug}", "change": "{type}/{id}-{slug}" }
}
```

**Models.** Which model spawns each agent is config, not hardcoded. `null` inherits the session's model.

```json
"models": { "sdAuthor": null, "hybridExecutor": "sonnet" }
```

**AI mode for task generation.** Default is `agent-native`: the active Claude Code or Codex session fulfils a generation spec and the engine validates and imports the result. For CI or cron with no host agent, set `taskCore.headlessFallback` to an HTTP endpoint, model and key from the environment. Off by default, and the engine opens no HTTP client unless it is configured. Details in [docs/ai-hybrid-usage.md](ai-hybrid-usage.md).

**Verification gate.** `verify.testCommand`, `coverageThreshold`, `forbiddenPatterns`, `secretScan`, per repo when a feature spans several repositories (`config.repos`).

**Code rules.** Team coding rules are enforced in two layers.

- *Machine-checkable* rules go in `verify.rules`. `verify-code` runs them on every task and fails on a violation **in the code this branch added or changed** (against the merge-base with `branching.base`, uncommitted and untracked files included). Violations already in old code do not fail; they are counted as `preexisting` so the debt stays visible. That is what makes a rule safe to add to a project that already breaks it. Each rule has an `id`, a `message`, an optional `glob`/`exclude`, and either `forbid` (a line regex) or `when` + `require` (a file that matches `when` must also match `require`). `scope: "all"` checks the whole tree instead, once a team has cleaned up. A malformed rule is skipped with a warning and never fails the gate; `/sf:doctor` lists what is wrong with it.

  ```json
  "rules": [
    { "id": "no-response-entity", "glob": "**/*Controller.java", "forbid": "ResponseEntity<",
      "message": "Use @ResponseStatus and return the body" },
    { "id": "scheduled-needs-shedlock", "glob": "**/*.java", "when": "@Scheduled", "require": "@SchedulerLock",
      "message": "Multi-pod: every @Scheduled job needs @SchedulerLock" },
    { "id": "timestamptz", "glob": "**/migration/*.sql", "forbid": "\\btimestamp\\b(?!\\s+with\\s+time\\s+zone)",
      "message": "Use timestamptz" }
  ]
  ```

- *Judgment* rules go as bullets under `## Code Rules` in `project-author.md`. `/sf:phase` pastes them verbatim into every executor prompt, and the executor must return one `pass | n/a | violated` row per bullet; a missing table or an open `violated` row is sent back. The pre-ship reviewer answers each bullet as a checklist item, and any violation is a `project-rule` finding that **blocks the ship** (severity at least `medium`), with `review-accept` as the explicit override.

`forbiddenPatterns` keeps its old behaviour (whole `scanPath`, every task) for existing projects; new rules belong in `verify.rules`.

**Language.** `language: "vi"` makes the agent reply and author SD prose in Vietnamese. Code, identifiers, commit messages, section headings and FR/TC ids stay English. SRS harvesting understands English and Vietnamese keyword packs.

**Phase.** `phase.confirmTasks` asks before seeding tasks. `phase.taskNotes` turns on per-task AI progress notes (off by default, they cost one AI call per task).

**Evolving the authoring rules.** When `sd-author` learns a reusable team convention, it is appended to `project-author.md` with a timestamp:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs learn --note "Always include audit_log in the data model" --category always
```

Commit it and the whole team inherits the rule.

## Codex

The Codex plugin is generated from the same sources, so there is no second copy of the workflow to maintain. Build and validate locally:

```sh
node scripts/build-codex.cjs
node scripts/validate-codex.cjs
codex plugin marketplace add ./dist/codex
codex plugin add sf@spec-flow-codex
```

Then, in the target project, trust the three hooks through `/hooks` and run `$sf-status`. Every `/sf:<name>` command maps to `$sf-<name>`. Project artifacts under `.spec-flow/` and `.taskmaster/` are shared byte for byte, so a feature started in Claude Code continues in Codex from the same checkpoint, and back.

The release workflow runs the Node and Python suites on Node 18 and 22, builds and validates the distribution, and attaches `spec-flow-codex.tar.gz` to each GitHub release. Full guide: [docs/codex.md](codex.md).

## Engine reference

Two CLIs ship in `bin/`. Both are zero-network and print one JSON line per call.

`bin/flow-tools.cjs` is the deterministic workflow engine, 41 subcommands. `bin/task-master` is the task engine with AI-shaped operations (`parse-prd`, `expand`, `update`, `research`) that are fulfilled by the host session.

<details><summary><code>flow-tools.cjs</code> subcommands</summary>

| Group | Command | Does |
| --- | --- | --- |
| Project | `init` | bootstrap `.spec-flow/` dirs and read config |
| | `init-project [--name] [--stack] [--design-type]` | idempotent per-project init, auto-detects stack from `build.gradle`, `pom.xml`, `package.json`, `go.mod`, `pyproject.toml`, `*.csproj` |
| | `learn --note --category` | append a timestamped rule to `project-author.md` |
| | `doctor [--sd] [--feature]` | env, plugin files, version sync, install state, trace health, SD gate, task-engine binding |
| | `status-report [--feature]` | pure-read aggregate behind `/sf:status`, with a deterministic `nextStep` |
| SRS to SD | `srs-snapshot --srs` | freeze an SRS baseline |
| | `sd-skeleton --srs --feature [--type]` | harvest SRS into the SD template |
| | `srs-diff --new [--old]` | changeset between SRS versions, anchored ids plus prose fallback |
| | `route --sd` | score each FR 1-10 into fast, expand, deep |
| Checklist | `checklist-gen --sd --feature [--type]` | SD section 13.2 into `CHECKLIST.yaml`, HTTP stub for api/hybrid, `live-e2e` scaffold otherwise |
| | `checklist-status --feature` | classify each test as filled, scaffold, no-verify or live-e2e |
| Trace | `trace-build --sd [--feature] [--tasks]` | build the per-feature trace, merge `file-links.json`, write the mirror |
| | `trace-link --task --feature --files [--fr]` | record task-to-file and FR-to-file evidence |
| | `trace-impact --ids / --keywords / --changeset` | impacted FR, TC, error, task and file nodes |
| | `trace-repos --feature [--set]` | declare or read the repo subset a feature targets |
| | `drift-check --feature` | error codes in code versus SD section 12.2, `spec-not-evidenced` and `impl-not-specced` |
| Verify | `verify-collect --results` | runner output into `VERIFICATION.md` truths, `notVerified` holds status at `incomplete` |
| | `verify-code [--feature] [--repos]` | tests, coverage, forbidden patterns, secret scan, scoped to the repos a feature touched |
| Review | `review-scope [--feature]` | whether the optional pre-ship review runs (`config.phase.codeReview`: off by default, or ask, always) and over what: base branch, `<base>...HEAD`, the files from `file-links.json`, plus any prior verdict and whether HEAD moved past it |
| | `review-collect --feature --findings [--target]` | reviewer findings into `CODE-REVIEW.md`, verdict `clean`, `advisory` or `blocking` (any critical/high) |
| | `review-accept --feature --note` | record that a human chose to ship with open blocking findings |
| State | `state-update --feature [--note] [--shipped]` | refresh per-feature `STATE.md` plus the mirror |
| | `checkpoint-write` / `checkpoint-clear` | mid-task checkpoint |
| | `task-baseline --feature [--apply]` | mark tasks done from verification evidence only, dry-run by default |
| | `wave-plan [--max]` | ready set of pending tasks whose dependencies are done |
| Records | `bug-new` / `bug-list` | bug records in `.spec-flow/bugs/` |
| | `backlog-new --title --priority high\|medium\|low` / `backlog-list [--status] [--epic] [--feature]` / `backlog-set --id [--priority] [--status]` | deferred-work records in `.spec-flow/backlog/`, listed in priority order; priority is required on create; hand-written files without the record marker are still listed (`legacy`, priority `unset`) and never rewritten by a list |
| | `epic-new --name [--subs]` / `epic-attach --epic --feature` / `epic-list` / `epic-show --epic` | epic workspaces: `.spec-flow/epics/<slug>/` with `EPIC.md` plus `srs/ decisions/ state/ assets/` for cross-phase docs; a feature joins one epic (`specs/<feature>/EPIC` points back); progress is computed from each sub-feature's tasks and ship record; single-file epics still read, never auto-migrated |
| | `branch-ensure --kind sd\|bug\|change` | create or switch the work branch from config templates, no-op off base |
| Tasks | `task-add`, `task-get`, `task-list`, `task-next`, `task-set-status`, `task-update` | CRUD on `.taskmaster/tasks/tasks.json` per tag |
| | `task-use-tag`, `task-add-dep`, `task-remove-dep`, `task-add-subtask`, `task-expand` | tag switching, dependencies with cycle detection, subtasks |
| Models | `taskmaster-model-plan`, `taskmaster-model-check` | decide whether a model change is needed for a role, and check provider keys are present |

</details>

<details><summary><code>task-master</code> subcommands</summary>

```
init [--yes]                              initialise .taskmaster/
use-tag <tagName>                         switch the tag namespace
parse-prd --input <file> [--tag]          SD into tasks (AI, agent-native)
analyze-complexity [--tag]                complexity report (AI, not used by the loop)
expand --id <id> [--tag]                  task into subtasks (AI)
update --from <id> [--prompt]             cascade a changeset into tasks (AI)
update-task --id <id> [--prompt] [--tag]  update one task
research <query> [--tag]                  research a query (AI)
tasks-import --tag [--file]               validate and import AI-generated task JSON
models [flags]                            kept for compatibility, no-op
```

</details>

## Repository layout

```
.claude-plugin/    plugin.json, marketplace.json
commands/          12 slash commands: init ingest checklist manual-test phase resync change bug split checkpoint status doctor
agents/            sd-author (SRS to clean SD), hybrid-executor (implements one task)
skills/            srs-to-sd (intent routing), manual-test (checklist runner, Python), commit (conventional commit + push)
hooks/             spec-flow-anchor (UserPromptSubmit), sd-drift-detect (PreToolUse), checklist-to-verification (PostToolUse)
bin/               flow-tools.cjs, task-master
lib/               core, trace, verify, drift, maintenance, task-core, tag/dependency/subtask managers, ai-router, two-phase
templates/         sd-template.md, srs-template.md, lang/{en,vi}.json
adapters/codex/    Codex adapter sources.   scripts/build-codex.cjs generates dist/codex/
docs/              guide.md, codex.md, ai-hybrid-usage.md, agent-native-two-phase.md, cutover-runbook.md
test/              node --test test/*.test.cjs
```

## Status, tests and contributing

Current release: see [releases](https://github.com/tranquocthong/spec-flow/releases). Every version is a git tag on `main` and has an entry in [CHANGELOG.md](../CHANGELOG.md), which records the bugs each release found and how they were verified.

```sh
node --test test/*.test.cjs                                     # 961 engine tests
cd skills/manual-test/scripts && python3 -m unittest checklist_lib.tests.test_checklist_lib   # 82 runner tests
node scripts/build-codex.cjs && node scripts/validate-codex.cjs # Codex distribution
```

spec-flow is in active dogfooding on real multi-repo projects. Fixes ship from live-use feedback, and the changelog is candid about what was wrong. Before a team-wide rollout, expect one or two tuning passes of the `sd-author` prompt on your own SRSs via `project-author.md`.

Contributing: after cloning, run `git config core.hooksPath .githooks` once. The pre-commit hook enforces the per-file line ceiling on the engine. Dependencies are pinned and documented in [DEPENDENCIES.md](../DEPENDENCIES.md).

MIT. See [LICENSE](../LICENSE).
