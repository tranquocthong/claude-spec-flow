# spec-flow

**Turn a messy SRS — or just an idea — into a reviewed Solution Design, then implementation that traces back to every line of it.** Spec-driven, but *adaptive*: small changes skip the ceremony, big ones get the rigor. A standalone **Claude Code plugin**.

```
SRS / idea  →  SD  →  (adaptive) implement  →  manual-test verify  →  ship
 │             ▲                                                       │
 │             └──────── /sf:resync  (Product changed the SRS) ────────┘
 └─────────────────────  /sf:change  (you change your mind) ───────────
```

[![release](https://img.shields.io/github/v/release/tranquocthong/claude-spec-flow)](https://github.com/tranquocthong/claude-spec-flow/releases)

## What you get

- **SRS or just an idea → a clean SD**, AI-shaped and gated on *your* approval. The SD is the single source of truth; everything downstream traces to it.
- **Adaptive implement** — each requirement is scored and routed *fast / expand / deep* by complexity. No fixed phase tax on small work.
- **Real traceability** — SRS§ → SD → FR/TC → task → **source file**. Change one thing and see everything it touches.
- **Change-driven loops** — Product edits the SRS → `resync`; you change your mind → `change`; a bug → `bug` (works even with **no SD**, for brownfield).
- **Local-first verification** — the bundled manual-test harness (curl/Kafka + DB/Redis) gates every task; nothing reaches `done` unverified.
- **Yours, portable** — per-project state is plain markdown/json committed with your repo. No DB, no server, no lock-in. Keyless by default (runs through your Claude Code session).

## Install

```
/plugin marketplace add tranquocthong/claude-spec-flow
/plugin install sf@claude-spec-flow
```
Reload Claude Code, then verify: **`/sf:doctor`**. Prereqs: node ≥ 18; python3 + PyYAML (`pip3 install pyyaml`) for the manual-test checklist runner. **No API key, no network fetch** — the task engine is bundled (native, zero-dependency); `/sf:init` sets it to the keyless `claude-code` provider.

<details><summary>Team install · zero-install engine</summary>

```
# Team (private marketplace)
/plugin marketplace add git@<your-git-host>:<org>/claude-spec-flow.git
/plugin install sf

# Zero-install — the engine is plain Node, runnable without the plugin:
node <path>/claude-spec-flow/bin/flow-tools.cjs doctor
node <path>/claude-spec-flow/bin/flow-tools.cjs sd-skeleton --srs <your-srs.md> --feature demo
```
`ANTHROPIC_API_KEY` / `PERPLEXITY_API_KEY` are optional — only if you prefer your own provider.
</details>

## Which command do I run?

| You have / want… | Run |
| --- | --- |
| First time in this repo | `/sf:init` |
| A new feature from an **SRS** | `/sf:ingest <srs.md>` |
| Just an **idea**, no SRS file | `/sf:ingest` — it **interviews you** and writes the SRS |
| **Product changed** the SRS | `/sf:resync <srs_v2.md>` |
| **You** want to change / enhance an implemented feature | `/sf:change "<desc>"` |
| A **bug** to fix (even on legacy / no-SD code) | `/sf:bug "<desc>"` |
| A **refactor / cleanup** | Normal pipeline, adaptive by size — `/sf:ingest` if substantial, just do it if trivial ([details](#refactor--cleanup)) |
| An SRS too big for one SD (>25 FRs) | `/sf:split <srs.md>` |
| Where am I? / is the install healthy? | `/sf:status` · `/sf:doctor` |
| **Coming back** (new session) — pick up in-progress work | `/sf:status` — reads the disk and hands you the exact next step: open bugs/changes (`/sf:bug --resume <id>` · `/sf:change --resume <id>`), pending tasks (`/sf:phase`), or an **interrupted ingest** (the missing `sd-author` / `trace-build` step). Re-running `/sf:ingest` is safe — it skips done steps and won't clobber an authored SD. |
| **Checklist filled** — run the tests | `/sf:manual-test <feature>` — smoke → regression → records `VERIFICATION.md` |
| **Context running out** mid-task / stopping voluntarily | `/sf:checkpoint` — saves task/phase/done/next to disk; next session `/sf:status` shows the exact resume hint |

## Quickstart

```
# 1. once per project (repo root)
/sf:init --stack java-spring        # node | python | go | dotnet | (omit for generic)
#   → seeds .spec-flow/ and asks: commit it, or keep local?

# 2. per feature
/sf:ingest <path/to/srs.md>     # (or bare /sf:ingest to be interviewed) → SD draft + trace + snapshot
#   → review the SD, clear TODO:MANUAL-REVIEW, get leader approval   ← your only control point
#   → after you approve, the agent drives the rest — you don't type the steps below
/sf:checklist <feature>         # SD §13.2 Test Cases → manual-test CHECKLIST.yaml (agent fills request + assertion)
#   → agent seeds tasks: parse-prd --tag <feature> + analyze-complexity --tag <feature>   (only after 0 TODO; keyless CLI)
/sf:phase <feature>             # adaptive implement → manual-test → done
#   → ship: commit + git push (surfaces the MR/PR link)
```

---

## How it works

### Why the SD is the control point

> **SRS is uncontrolled** — product writes it however they want, every time different.
> **SD is your only control point.**

So: deterministic code only **harvests** raw material from the SRS (accepts "dirty" output); the **`sd-author` AI agent** does the shape-robust SRS→SD mapping; all deterministic rigor (routing, checklist, traceability, tasks) lives **downstream of the SD**, which follows a template you control and a human approves. An SD that doesn't match reality is worse than none — so spec-flow never fakes one (see *Brownfield* below).

### Flow 1 — New feature from an SRS  (the main path)

> **No SRS — just an idea / your own description?** That's the *normal* case. **Easiest:** run **`/sf:ingest`** with no file (or `/sf:ingest --idea "<seed>"`) — it **interviews you** and writes `.spec-flow/srs/<feature>.md` for you (AI-elicited structure beats hand-typed prose), then ingests. Prefer to write it yourself? Drop a rough `.md` (prose/bullets fine) at `.spec-flow/srs/<feature>.md` and `/sf:ingest` it. Either way `sd-author` shapes it and you review the SD at the gate. The doc the interview targets / you fill:
> ```markdown
> # <feature name>
> ## What & why        — 1–2 lines: what it does, problem it solves
> ## Actor             — who / what system calls it
> ## Behaviors         — happy-path bullets        → become FRs
> ## Rules / errors    — validations, failure cases → become TCs + error codes
> ## Done when         — acceptance criteria        → become TCs
> ```
> List the **behaviors + error cases** well — that's the part the AI can't invent. Everything else (architecture, sequences) `sd-author` infers and you correct at the SD gate. Tiny idea with no real contract? Skip the flow — edit + `commit`. Idea too big (>25 FRs)? `/sf:ingest` flags `epicScale` → `/sf:split`.

```
[Product gives you SRS — or your own idea doc]
        │
        ▼
/sf:ingest <path/to/srs.md>
   • srs-snapshot      → .spec-flow/snapshots/<feature>-001.md (baseline for future diffs)
   • sd-skeleton       → .spec-flow/specs/<feature>/SD.md  (deterministic HARVEST — dirty, that's fine)
   • sd-author (AI)    → cleans harvest into atomic FR/TC, fills architecture/API/state
   • trace-build       → .spec-flow/trace.json (FR↔TC↔error↔state links)
   • state-update      → .spec-flow/STATE.md
        │
        ▼  GATE: SD still has TODO:MANUAL-REVIEW?  → you fill the few ambiguous spots
[You review SD  +  leader approves]            ← your only control point; after this the agent drives
        │
        ▼
/sf:checklist <feature>            → .spec-flow/specs/<feature>/CHECKLIST.yaml  (co-located with the SD)
   • agent fills request + assertion per test: `expect.body` for read/transform (e.g. masking), `verify` SQL for mutations
        │
        ▼
agent seeds tasks: parse-prd --tag <feature> + analyze-complexity --tag <feature>   ← per-feature tag = isolated task space; only AFTER 0 TODO (keyless CLI, not MCP — agent runs it, not you)
        │
        ▼
/sf:phase <feature>            ← adaptive implement loop
   route --sd .spec-flow/specs/<feature>/SD.md      → each FR scored 1–10:
        1-3 fast    → straight to executor
        4-7 expand  → expand_task → subtasks
        8-10 deep   → research first, executor with planning notes
   per task:  next_task → hybrid-executor writes code → update_subtask
              → set_status(review) → run-checklist smoke
              → PASS: set_status(done) + state-update   |   FAIL: halt, surface
        │
        ▼
run-checklist <feature> --tag regression
   → checklist-to-verification hook writes .spec-flow/VERIFICATION.md (status: passed only if 0 fail)
        │
        ▼
ship:  commit + git push → open MR/PR
       (GitLab prints the MR link on push · GitHub: gh pr create or the compare URL)
```

### Flow 1b — Epic split (when Flow 1 returns `epicScale: true`)

Use this when the SRS is too large for a single reviewable SD (>25 FRs or >800 generated lines).

```
/sf:split <path/to/srs.md>
      │
      ▼
PROPOSE   sd-author reads the full SRS and proposes a grouping
          (2–5 sub-features, grouped by User Story range / bounded-context)
      │
      ▼
 GATE     HUMAN reviews + approves (or adjusts) the grouping
          ← never auto-committed: this is a design decision
      │
      ▼
REGISTER  epic-new --name <epic> --subs "<approved sub names>"
          → .spec-flow/epics/<slug>.md
      │
      ▼
SUB-SDs   for each approved sub-feature:
          sd-author (scoped to ONLY that sub's FRs/US) → .spec-flow/specs/<epic>-<sub>/SD.md
          trace-build → linked via trace.json
      │
      ▼
Each sub-feature then runs the normal pipeline independently:
  /sf:checklist → /sf:phase → regression → ship
/sf:resync later: trace-impact scopes to affected sub-feature(s) only
```

### Flow 2 — Product changed the SRS  (top-down resync, surgical)

```
[Product sends SRS v2]
        ▼
/sf:resync <path/to/srs_v2.md>
   • srs-diff           → diff vs last snapshot → CHANGESET (anchor layer + prose-bullet fallback)
   • trace-impact       → exact FR / TC / error / task IDs touched (via trace.json)
   • sd-author          → updates ONLY impacted SD sections (not a full regen)
        │ GATE: review the delta + leader approves
        ▼
   • (Task Master CLI) update --from=<task> --prompt="<changeset>"   → cascade downstream tasks
   • re-open impacted done tasks → review
   • regenerate impacted CHECKLIST rows
   • srs-snapshot (new baseline) + trace-build + state-update
        ▼
/sf:phase <feature>            → re-implement the review tasks → manual-test → done
```
> Defends "fix one place, forget three": trace.json finds every impacted node; cascade propagates; every touched task must pass manual-test again.

### Flow 3 — You want to change the spec / enhance after impl  (bottom-up loop)

```
/sf:change "<description>" --type fix|enhance
   1. open .spec-flow/changes/<NNN>-change-<slug>.md  (audit trail; id: change-NNN)
   2. edit the SD section (or sd-author proposes a diff)   ← SD first, never patch code blind
   3. trace-impact (--ids / --keywords) → impacted tasks
   4. re-open tasks → review  (+ add_task if net-new work)
   5. /sf:phase → executor edits code → run-checklist
   6. PASS + satisfied → change done + verify-collect → VERIFICATION.md
      not satisfied / still failing → loop back to step 2
   repeat until every open change is done
```
`fix` vs `enhance` differ only in MoSCoW weight + test tag (`smoke` vs `regression`).
**Wrong command?** `/sf:change` needs an existing SD; if there's no SD or the code just misbehaves vs a correct SD → it's a code-bug → `/sf:bug`.
**Fast path:** if trace-impact hits one FR/TC + one task (e.g. `status`→`statuses`, reformat a field), the change record is one line, edit the SD row directly (no sd-author), and verify only that TC — full regression runs at close.

### Flow 4 — Bug report / fix bug

A bug is **NOT** always a spec change. There are 3 kinds, each routed differently:

| Kind | Criteria | Route |
| --- | --- | --- |
| **CODE bug** | SD is correct; code behaves wrong | Fix code to match SD. **Never edit SD.** Add permanent regression test. |
| **SPEC bug** | SD itself is wrong or incomplete | Hand off to `/sf:change "<desc>" --type fix` (SD-first edit). |
| **SRS-level** | Product/requirement misunderstanding | Hand off to `/sf:resync <srs.md>`. |

**SD-optional (brownfield):** on a project with no SD (spec-flow adopted mid-stream, feature never ingested), `/sf:bug` skips triage and treats it as a **code-bug** — the repro test + expected/actual are the contract. Legacy features get tracked fixes without forcing a full SD on them.

Key technique — **REPRO-FIRST**: write a `CHECKLIST.yaml` entry that *fails* (reproduces the bug) **before** touching any code. After the fix it turns green and stays as permanent regression coverage.

```
/sf:bug "<desc>" [--severity low|med|high|critical] [--repro "..."] [--expected "..."] [--actual "..."] [--feature <f>]
        │
        ▼
INTAKE       flow-tools bug-new → .spec-flow/bugs/<NNN>-bug-<slug>.md
        │
        ▼
REPRO-FIRST  add CHECKLIST entry → run → confirm FAILS before fixing
        │
        ▼
TRIAGE       trace-impact → SD section → decide: code-bug | spec-bug | srs-level
        │
        ├─ spec-bug  ──→  /sf:change (SD-first)
        ├─ srs-level ──→  /sf:resync
        │
        └─ code-bug → hybrid-executor (code only, SD unchanged)
                │
                ▼
           VERIFY   repro test must PASS; if FAIL → loop back to fix
                │
                ▼
           REGRESS  test stays permanently; bug status=done; VERIFICATION updated
```

### Refactor / cleanup

A refactor is just work — it runs through the **normal pipeline, adaptive by size**, like any feature. There's nothing special and no separate `/sf:refactor`:

- **Substantial** (split a service, restructure a module, migrate a pattern) → `/sf:ingest` an SRS whose *goal is the restructure* and whose requirements are **the behaviors that must stay identical**. The SD's body is the target architecture (§6) plus those preservation tests; `/sf:phase` implements the restructure steps; the checklist then verifies behavior is unchanged — which, for a refactor, is exactly the acceptance criterion.
- **Trivial** (rename, drop a dead method) → skip the ceremony and just do it. The adaptive charter applies to all small work, not only refactors.

One nuance: a refactor's tests assert *"same as before,"* and *before* lives in the **running code** — capture them as characterization tests from the real system (real responses / golden output), not from prose you might misremember.

### Brownfield — adopting spec-flow into an existing codebase

spec-flow is **forward** (SRS → SD → build). For features built *before* you adopt it — code exists, no SD — **do not retro-generate a full SD.** The SRS describes *as-specified*; the code has drifted to *as-built*; an SD from either won't match the running code — and **an SD that doesn't match code is worse than none** (it lies, and the whole model trusts the SD as truth). So:

- **Bug on legacy code** → `/sf:bug` — SD-optional: no SD needed, the repro test + expected/actual are the contract.
- **Change / enhance legacy** → forward-spec **only the delta**: `/sf:ingest` a focused SRS/idea for *the new behavior*, then build + verify just that. The surrounding legacy code is context, not something to reverse-spec.
- **Really want a full, accurate SD for a legacy feature?** You must reconcile it to the code yourself — spec-flow won't fake one. Usually only worth it right before a heavy rewrite.

New features (post-adoption) get the full flow from day one. **Adopt forward, not backward** — never reverse-spec working code into an SD you then can't trust.

## Command reference

| Command | Purpose | Type |
| --- | --- | --- |
| `/sf:init` | **One-time** project init — writes `.spec-flow/` committed profile (config, project-author, .gitignore) | flow |
| `/sf:ingest <srs>` | SRS → SD draft (harvest + AI clean) + CONTEXT.md + trace + snapshot. Bare = interview mode | flow |
| `/sf:checklist <feature>` | SD §13.2 Test Cases → manual-test `CHECKLIST.yaml` scaffold (clobber-safe: won't overwrite a filled checklist without `--force`) | flow |
| `/sf:manual-test <feature>` | Run `CHECKLIST.yaml` — smoke → regression → record `VERIFICATION.md`. Flags: `--smoke-only`, `--regression-only` | flow |
| `/sf:checkpoint [feature]` | Save mid-task state (task / phase / done files / next action) when context is running low or stopping mid-task. `/sf:status` surfaces the checkpoint and overrides Next Step with a resume hint. Auto-cleared when task reaches `done` | utility |
| `/sf:phase <feature>` | Adaptive implement loop (fast / expand / deep by complexity) | flow |
| `/sf:resync <srs_v2>` | Flow 2 — propagate an SRS change as a surgical delta | flow |
| `/sf:change "<desc>"` · `--resume <id>` | Flow 3 — dev fix/enhance loop, SD-first, until done. `--resume` continues an open change (id from `/sf:status`) | flow |
| `/sf:bug "<desc>"` · `--resume <id>` | Flow 4 — bug report/fix: repro-first → triage → code-fix → regress (SD-optional). `--resume` continues an open bug instead of duplicating | flow |
| `/sf:split <srs-or-feature>` | **Epic decomposition**: propose → approve → generate per-sub-feature SDs linked via trace | flow |
| `/sf:status` | **Project status / resume**: feature, phase, tasks, trace, **open bugs/changes (with ids)**, next step — and hands you the exact resume command. Orient + pick up in-progress work in any session | utility |
| `/sf:doctor` | **Health check**: env, install, project, SD/trace consistency — the single health surface | utility |

<details><summary><code>flow-tools.cjs</code> — the deterministic engine (callable directly)</summary>

| Cmd | Does |
| --- | --- |
| `init` | bootstrap `.spec-flow/` dirs + read config |
| `init-project [--name] [--stack] [--design-type]` | **idempotent** per-project init: write `config.json` + `project-author.md` + `.gitignore`. **Auto-detects the stack** from build markers (`build.gradle`→java-spring, `pom.xml`→java-maven, `package.json`→node, `go.mod`→go, `pyproject.toml`/`requirements.txt`→python, `*.csproj`→dotnet) when `--stack` is omitted → seeds the matching `verify` preset |
| `learn --note "<rule>" [--category writing\|always\|pitfall]` | evolve write-back: append timestamped rule to `project-author.md` |
| `srs-snapshot --srs` | save SRS baseline for diffing |
| `sd-skeleton --srs --feature [--type] [--out]` | harvest SRS → SD skeleton (dirty, by design) |
| `route --sd` | score each FR 1–10 → fast/expand/deep |
| `checklist-gen --sd --feature [--type]` | SD §13.2 → CHECKLIST.yaml scaffold. **Design-type aware**: api/hybrid (or an SD with a §9 API section) → HTTP request/expect stub; library/internal/event-driven → `live-e2e`-tagged scaffold (no fake HTTP stub) |
| `checkpoint-write --feature --task [--phase] [--done] [--next] [--decision]` | save mid-task state to `specs/<feature>/checkpoint.md` (overwrite, not append) |
| `checkpoint-clear --feature` | remove `checkpoint.md` when task reaches done (no-op if absent) |
| `checklist-status --feature [--file]` | classify each CHECKLIST test `filled` / `scaffold` (still has TODO stubs) / `no-verify` / `live-e2e` + a `ready` flag — know what's runnable without eyeballing the YAML |
| `trace-link --task <id> --feature <f> [--fr <FR-id>] --files "p1,p2,..."` | record task→file (and FR→file / FR→task when `--fr` given) links into `.spec-flow/specs/<feature>/file-links.json` (per-feature; `--feature` is **required** — a write never infers its scope from the shared `trace.json` mirror); deduplicated, persistent across `trace-build` rebuilds |
| `trace-repos --feature <f> [--set "a,b"]` | declare/read the repo subset a feature targets (`trace.json.repos[]`, validated against `config.repos`) — read by `branch-ensure` and `verify-code` before any file-links evidence exists; no `--set` = read |
| `trace-build --sd [--feature] [--tasks]` | build the feature's trace; merges `file-links.json` → adds `nodes.files` + `task-file`/`fr-file`/**`fr-task`** links. Writes a **durable per-feature copy** at `specs/<feature>/trace.json` + an active-feature mirror at `.spec-flow/trace.json`. Warns on §12.2 codes that violate `conventions.errorCodePattern` |
| `trace-impact --ids/--keywords/--changeset [--feature]` | resolve impacted FR/TC/error nodes + **tasks** (via `fr-task`) + `impacted.files` — so `/sf:change` auto-reopens the task that implemented a changed FR |
| `drift-check --feature [--tasks]` | **Layer-2 semantic SD-mismatch check**: diffs the actual error codes in the executor's `update-task` logs vs SD §12.2 → flags `spec-not-evidenced` (spec'd, no log evidence) and `impl-not-specced` (built but undocumented). Advisory; `/sf:phase` runs it before next_task |
| `srs-diff --new [--old]` | best-effort CHANGESET between two SRS versions — two layers: anchored ids/tables + per-section prose-bullet fallback (`prose`, `anchors` diagnostics), so a prose-form SRS revision never reads as an empty changeset; output is directly consumable by `trace-impact --changeset` |
| `verify-collect --results` | parse run-checklist output → VERIFICATION truths[] |
| `state-update --feature [--note]` | refresh the feature's STATE (<100 lines) — incl. a deterministic Next Step. Writes the durable `specs/<feature>/STATE.md` **and** the `.spec-flow/STATE.md` active-feature mirror; returns `switchedFrom` when the mirror previously held another feature |
| `task-baseline --feature [--apply]` | backfill bridge: mark tasks `done` from EVIDENCE only (every TC in the task's evidence set recorded `verified` in VERIFICATION.md; task→FR via trace `fr-task` links, fallback FR/TC ids in task text). Dry-run by default; `--apply` writes. No VERIFICATION → baselines nothing — manual-test stays the only door to `done` |
| `wave-plan [--max <n>]` | dependency-aware visibility: the ready-set of pending tasks whose deps are all done (what's workable now); reads `.taskmaster/tasks/tasks.json` (tagged or flat) |
| `bug-new --desc [--severity] [--repro] [--expected] [--actual] [--feature]` | create `.spec-flow/bugs/<NNN>-bug-<slug>.md` bug record (id: bug-NNN); returns `{ id, path, severity }` |
| `bug-list` | list `.spec-flow/bugs/*.md` with `{ id, status, severity, feature, desc }` |
| `branch-ensure --kind sd\|bug\|change [--name\|--id\|--slug\|--type]` | create/switch the work branch from `config.json → branching` templates; only acts when on the base branch (safe no-op otherwise); `mode: off` → skipped |
| `epic-new --name <epic> [--subs "subA,subB,subC"]` | create `.spec-flow/epics/<slug>.md` with sub-feature list; idempotent (reports `alreadyExists` if run twice) |
| `epic-list` | list `.spec-flow/epics/*.md` with `{ id, name, status, subCount }` |
| `verify-code [--feature <f>] [--repos "a,b"]` | **generic quality gate**: run tests, check coverage threshold, scan for forbidden patterns + secrets — driven by `.spec-flow/config.json → verify`; skips gracefully when unconfigured. **Multi-repo:** `--feature`/`--repos` scopes the scan to the repos that feature touched (from `file-links.json`) so an unrelated repo's red WIP can't poison the gate |
| `status-report [--feature <f>]` | pure-read status aggregate: project, branch, feature, SD, tasks, trace, ready-set, verification, open bugs/changes, latest snapshot + a deterministic `nextStep` — the data source behind `/sf:status` |
| `doctor [--sd <SD.md>] [--feature <f>]` | **health check**: env · plugin files · install state · project init · trace health · SD gate · tasks info · task-engine MCP binding (warns when a project `.mcp.json` shadows the bundled native server) |
| `task-add --title <t> [--tag <tag>] [--description <d>] [--details <d>] [--priority high\|medium\|low]` | create a task in the tag (id auto-assigned); the deterministic twin of MCP `add_task` — use it when a project `.mcp.json` shadows the bundled server with a core-tier `task-master-ai` that has no `add_task`. Omitted `--tag` falls back to `.taskmaster/state.json → currentTag` |
| `task-get --tag <tag> --id <id>` | read one task (twin of MCP `get_task`); returns `data:null` when not found, never an error |
| `task-list --tag <tag> [--status <s>]` | list a tag's tasks + stats (twin of MCP `get_tasks`) |
| `task-set-status --tag <tag> --id <id> --status <s>` | set a task/subtask status (twin of MCP `set_task_status`) |
| `task-next [--tag <tag>]` | next actionable pending task, deps all `done` (twin of MCP `next_task`) |
| `task-use-tag --tag <tagName>` | set the current tag in `.taskmaster/state.json`; auto-creates the tag namespace `{tasks:[],metadata:{}}` in `tasks.json` when absent — ops that omit `--tag` fall back to this tag (FR-002, FR-003) |
| `task-add-dep --task-id <id> --dep-id <depId> --tag <tag>` | add `depId` to `taskId.dependencies[]` with full validation: tag exists, depId exists in tag, no cycle (iterative DFS); no-op if already present (FR-005..FR-007) |
| `task-remove-dep --task-id <id> --dep-id <depId> --tag <tag>` | remove `depId` from `taskId.dependencies[]`; no-op if absent, no error (FR-008) |
| `task-add-subtask --parent-id <id> --title <t> --tag <tag> [--description <d>] [--details <d>]` | append a subtask to the parent's `subtasks[]`; id derived as `<parentId>.<n>` (n = current subtask count + 1); returns the created subtask (FR-010) |
| `task-expand --task-id <id> --subtasks <json-file> --tag <tag>` | read a JSON array `[{title, description?, ...}]` from file and append all entries to the parent's `subtasks[]` with sequentially derived ids; existing subtasks are preserved — append-only (FR-012, FR-013) |

</details>

---

## Under the hood

<details><summary><b>Project layout &amp; lifecycle</b> — the two-tier overlay model, init, evolve via <code>learn</code></summary>

spec-flow uses a **two-tier overlay model**. The global plugin is the engine — it never changes per project. The project's `.spec-flow/` directory is the living, committed profile that evolves with the project.

```
GLOBAL plugin (installed in Claude Code)
  = flow-tools.cjs engine + default templates + base agent prompts
  = updated via /plugin update  →  shared across every project
  = NEVER project-specific

PROJECT .spec-flow/  (committed by default — your spec history travels with the repo)
  = config.json          project profile: stack, conventions, design type
  = project-author.md    SD-authoring overrides — where learnings accumulate
  = specs/<feature>/SD.md  the Solution Design — follows your commit choice
  = srs/<feature>.md (live inputs — idea or SRS), trace.json, STATE.md, VERIFICATION.md, snapshots/, bugs/, changes/
  Resolution: project-local overrides win; global plugin is the fallback
```

**One-time setup** (run once per project):
```
/sf:init [--name <n>] [--stack java-spring|java-maven|node|python|go|dotnet] [--design-type auto|api|internal|hybrid]
```
`--stack` is **auto-detected from build markers** when omitted (gradle/maven/node/go/python/dotnet). Writes `.spec-flow/config.json` + `.spec-flow/project-author.md`, then **asks how to track it**:
- **Commit (default)** — `.spec-flow/` is tracked; its git log is the spec-evolution history. Then `git add .spec-flow/ && git commit`.
- **Keep local** — adds `.spec-flow/` to the project `.gitignore`; nothing committed. (Flag: `/sf:init --no-commit-docs`.)

**Evolve via `learn`** — when sd-author hits a reusable rule (team convention, pitfall, always-include section):
```
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs learn --note "Always include audit_log table in §7 DB Design" --category always
```
Categories: `writing` · `always` · `pitfall` · `learned`. Each rule is timestamped and appended under the matching section in `.spec-flow/project-author.md`; commit it → the whole team inherits the learning. sd-author reads this file at the start of every run and treats its rules as authoritative overlays on the base prompt.
</details>

<details><summary><b>Branch model</b> — branch-per-SD, VCS-agnostic</summary>

spec-flow is branch-aware and **VCS-agnostic** (GitHub + GitLab). The policy lives as DATA in `.spec-flow/config.json → branching` (seeded by `/sf:init`); the engine just substitutes templates.

```json
"branching": {
  "mode": "per-sd",                                   // per-sd | per-sd+bug | off
  "base": "main",                                     // your integration branch (auto-detected at init)
  "templates": { "sd": "feat/{feature}", "bug": "fix/{id}-{slug}", "change": "{type}/{id}-{slug}" }
}
```

- **1 SD = 1 branch.** `/sf:ingest` calls `branch-ensure --kind sd` → `feat/<feature>`; the whole SD → implement → ship lifecycle lives on that one branch (a clean, reviewable PR).
- **Bugs / changes** get `fix/<id>-<slug>` and `<type>/<id>-<slug>` via the same engine command.
- **No commit on base.** `branch-ensure` only creates/switches when you're on `base`; on a work branch it's a safe no-op (never switches a dirty tree). The bundled **commit** skill refuses to commit on `base` while `mode != off`, generates the conventional-commit message, pushes, and surfaces the MR/PR link. Set `mode: off` to opt out (commit on current branch).

**Merge-conflict note.** Each feature's trace and state are durable at `specs/<feature>/trace.json` and `specs/<feature>/STATE.md` (keyed by the feature dir → working feature B can never clobber feature A). The global `.spec-flow/trace.json` + `STATE.md` are just an *active-feature mirror* (regenerated by `trace-build` / `state-update --feature <f>`). Sequential work never conflicts; parallel branches can collide only on the mirror — a **benign** derived-artifact conflict (take either side, re-run `trace-build`). (Heavy-parallel teams can gitignore the volatile mirror and keep the per-feature copies.)
</details>

<details><summary><b>Model overrides</b> — per-agent model, config-driven</summary>

Which model spawns **sd-author** and **hybrid-executor** is DATA in `.spec-flow/config.json → models` (seeded by `/sf:init`), not hardcoded in the agent files:

```json
"models": {
  "sdAuthor": null,          // null = inherit the main session's model
  "hybridExecutor": "sonnet", // fixed model — overrides the agent's own frontmatter default
  "taskmaster": { "main": "sonnet", "research": "sonnet" } // Task Master CLI's own model, per role
}
```

`/sf:ingest` and `/sf:resync` read `models.sdAuthor` before spawning sd-author; `/sf:phase` reads `models.hybridExecutor` before spawning hybrid-executor. A non-null value is passed as the Agent tool's `model` param (wins over the agent's packaged frontmatter default); `null`/absent omits the param so the agent inherits the main session's model.

**`models.taskmaster` is a different mechanism** — `sdAuthor`/`hybridExecutor` control Agent-tool spawns inside this session; `taskmaster.{main,research}` controls the *Task Master CLI's own* model for `parse-prd`/`analyze-complexity`/`expand`/`research`/`update-task` (a separate subprocess with its own `.taskmaster/config.json`, not reachable via the Agent tool's `model` param). Env-var overrides for Task Master (`TASKMASTER_MODEL_MAIN` etc.) do **not** work against its local file-storage CLI — live-verified. The only mechanism that actually works is `task-master models --set-<role> <model> --claude-code`, which writes directly to `.taskmaster/config.json`. Before each AI-op, `taskmaster-model-plan --role <main|research>` (pure, no subprocess) decides whether a change is needed; if so, the orchestrator sets the model, runs the op, then restores the previous value **unconditionally** via a bash `trap ... EXIT` — even if the op fails. `null`/absent (default `"sonnet"`, matching Task Master's own default) → no-op, zero behavior change. No `fallback` key — no CLI op selects that role directly.
</details>

<details><summary><b>Non-negotiable gates</b></summary>

1. **`/sf:ingest` never implements** — ingest (incl. interview mode) outputs only the SRS + SD + trace, then STOPS at the SD review gate. Discussing a feature is not permission to code it; implementation is `/sf:phase`, after the SD is approved.
2. **No `parse_prd`** while the SD has any `TODO:MANUAL-REVIEW` marker (SD-mismatch defense, layer 1). Layer 2 = `drift-check` (semantic: logged error codes vs SD §12.2) + the `sd-drift-detect` hook (structural: file-in-trace) — advisory, surfaced during `/sf:phase`.
3. **CHECKLIST.yaml exists** before the first task is implemented.
4. **`verify-code` gate** runs before every manual-test smoke run (generic config-driven: tests, coverage, forbidden patterns, secret scan; stack specifics live in `.spec-flow/config.json → verify`; unconfigured → skips without blocking).
5. **`review → done`** only after manual-test smoke passes; a phase ships only when regression passes (`VERIFICATION.md status: passed`).
6. **SD is the source of truth** — change the SD first, then propagate via trace + cascade. Never patch code without patching the SD.
</details>

<details><summary><b>Files &amp; artifacts</b> — repo layout + what gets created in your project</summary>

**Plugin layout**
```
.claude-plugin/   plugin.json, marketplace.json
commands/         ingest · checklist · manual-test · checkpoint · phase · resync · change · bug · init · doctor · status · split
skills/srs-to-sd/ entry-point skill (intent routing + gates)
skills/manual-test/ bundled local-test harness (CHECKLIST.yaml, run-checklist.sh, ...)
skills/commit/     bundled conventional-commit + push skill (VCS-agnostic, base-branch guard)
agents/           sd-author (SRS→clean SD) · hybrid-executor (impl one task)
hooks/            checklist-to-verification (PostToolUse) · sd-drift-detect (PreToolUse) · spec-flow-anchor (UserPromptSubmit: session-wide config.language + flow re-anchor)
bin/flow-tools.cjs  thin CLI entry + workflow commands (trace/verify/checklist/state/bug/epic/branch/status)
lib/core.cjs             shared infra + SRS/SD parsers + genSd (no command logic)
lib/maintenance.cjs      static, non-workflow commands: init · init-project · learn · doctor
lib/drift.cjs            Layer-2 semantic drift-check (drift-check command)
lib/task-core.cjs        native task storage + CRUD — zero-network, drop-in StorageCore (sub 1/5)
lib/tag-manager.cjs      TagManager — tag resolution, state.json read/write, namespace auto-create (sub 2/5)
lib/dependency-manager.cjs  DependencyManager — add/remove deps, iterative DFS cycle detection, intra-tag (sub 2/5)
lib/subtask-manager.cjs  SubtaskManager — hierarchical id derivation, computeCompletion (sub 2/5)
lib/expand-hook.cjs      ExpandHook — validate + delegate structured subtask lists to SubtaskManager (sub 2/5)
templates/        sd-template.md · srs-template.md · lang/{en,vi}.json (SRS-parse keyword packs)
test/             *.test.cjs — flow-tools (CLI) · core · maintenance unit suites (`node --test test/*.test.cjs`)
.mcp.json         wires the native task engine MCP server (bin/mcp-server.js, zero-network)
```

**Created in the target project**
- `.spec-flow/srs/<feature>.md` — the live, editable input (a formal SRS *or* just your idea). Its home; you edit this, `/sf:resync` diffs it. Convention, not enforced — ingest accepts any path.
- `.spec-flow/specs/<feature>/SD.md` — the Solution Design (your control point).
- `.spec-flow/specs/<feature>/CHECKLIST.yaml` — manual-test checklist, co-located with the SD; persistent regression coverage. (Driven via the bundled manual-test skill, which spec-flow calls with this explicit path; the skill itself stays generic.)
- `.spec-flow/specs/<feature>/file-links.json` — **per-feature** task→file and FR→file mappings (written by `trace-link`); scoped per feature so traces stay bounded + unambiguous; survives `trace-build` rebuilds.
- `.spec-flow/specs/<feature>/trace.json` — **durable per-feature** traceability matrix: SRS§ → SD§ → FR/TC/NFR → error → state → task → **source FILE**. Backbone of the change loops. `.spec-flow/trace.json` is an active-feature mirror of the last-built one.
- `.spec-flow/snapshots/` — immutable SRS baselines frozen at each ingest/resync, for diffing (never hand-edit).
- `.spec-flow/changes/` — dev fix/enhance loop audit trail · `.spec-flow/bugs/` — bug records (triage, resolution log, regression-test link).
- `.spec-flow/specs/<feature>/checkpoint.md` — mid-task checkpoint (single overwritable file written by `/sf:checkpoint`; `/sf:status` surfaces it; auto-cleared when task reaches `done`).
- `.spec-flow/STATE.md` — <100-line living index (resume after `/clear`) · `.spec-flow/VERIFICATION.md` — goal-backward verification, fed by manual-test results.
- `CONTEXT.md` — locked decisions, fed to every agent.
</details>

<details><summary><b>Dependencies</b> (locked)</summary>

All dependencies are pinned — updates are deliberate and tested, never automatic. The task engine (`bin/mcp-server.js`, `bin/task-master`) is a self-built, zero-network, zero-external-dependency core — no `task-master-ai` package is fetched or installed.

| Dependency | How | Pinned version |
| --- | --- | --- |
| `manual-test` | Bundled (vendored in `skills/manual-test/`) | this plugin's version |
| `node` | Environment prereq | >= 18 |

See [DEPENDENCIES.md](DEPENDENCIES.md) for the full lock policy.
</details>

## Status & known limits

- Engine (28 `flow-tools` cmds, modular: `bin/flow-tools.cjs` + `lib/core.cjs` + `lib/maintenance.cjs`) + hooks + commands + agents: **built & verified** by 790 engine tests (`node --test test/*.test.cjs` — CLI integration + per-lib unit suites) + 65 checklist-runner tests (`python3 -m unittest checklist_lib.tests.test_checklist_lib`, from `skills/manual-test/scripts/`).
- **Contributing / dev setup:** the engine LOC ceiling (charter §0b #8, now **per file**) is enforced by a pre-commit hook in `.githooks/`. After cloning, activate it once: `git config core.hooksPath .githooks` (git does not run committed hooks without this).
- **In active dogfooding** — used on real projects; fixes ship straight from live-use feedback (recent: per-feature durable trace, multi-repo verify-code scoping, design-type-aware checklist-gen, ID-prefix SRS harvest for non-English specs). Not yet a confident team-wide release.
- SRS harvest is intentionally dirty; `sd-author` (AI) cleans it — don't judge the harvest output directly.
- Needs **1–2 finetune loops on a real SRS** (adjust the `sd-author` prompt to your team's writing) before a confident team release.
- **Large features**: SDs with >25 FRs or >800 generated lines are flagged epic-scale — `sd-skeleton` returns an advisory (never blocking) to `/sf:split`.
