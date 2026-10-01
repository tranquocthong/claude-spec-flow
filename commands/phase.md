---
description: Adaptive implement loop. Routes each task by complexity (fast / expand / deep), drives next_task -> implement -> manual-test -> done with state tracking.
argument-hint: [feature] [--task <id>]
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:phase — adaptive implement loop

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each task so the flow survives long sessions.

> **Checkpoint rule:** mid-task and context is running deep, or you must stop before finishing — run `/sf:checkpoint` first. The next agent reads `.spec-flow/specs/<feature>/checkpoint.md` on resume; step 6 clears it.

> **HARD RULE — "done" means synced disk, NOT a prose claim.** `/sf:status` derives everything from disk (task statuses, STATE.md, VERIFICATION.md). Anything you don't write back is LOST next session. You may NOT call a task/feature done unless, on disk: (1) its task is `done` (not left in `review`), (2) `state-update` has run, (3) at phase end VERIFICATION reflects the result. **This holds even when you verified out-of-loop** (ad-hoc / live E2E instead of `run-checklist`) — confirming it works ≠ recording that it's done.

> **Task ops — one engine, one form.** Every task operation is a deterministic `flow-tools.cjs` call, tag-scoped by `--tag <feature>`; none of them call a model:
> `task-next` · `task-list [--status <s>]` · `task-get --id <id>` · `task-set-status --id <id> --status <s>` · `task-add --title "<t>"` · `wave-plan`
> Each prints one `{"ok":true,"data":…}` line. The per-feature `--tag` keeps this feature's tasks isolated so a prior feature's (or bug's/change's) tasks never collide.

> **Multi-repo — one SRS/SD, code in sibling service repos.** Read `config.repos` from `.spec-flow/config.json`. When set, planning lives in THIS repo (the hub) but each task's code lives in a sibling repo; the SD labels every component/FR by service. Per task: `cd` into `config.repos[<service>]` to implement + test there, then `trace-link --repo <service> --files ...` so paths are stored repo-qualified. Always pass `--feature` to `verify-code` so an unrelated repo's red WIP can't fail this feature's gate. Absent `config.repos` → single-repo, nothing changes.

## Preconditions (hard gates)
- SD approved (0 `TODO:MANUAL-REVIEW`) — **the primary human gate**. After it the agent runs every step itself; the user runs nothing.
- `CHECKLIST.yaml` exists (run `/sf:checklist` if not).

Tasks need **not** be pre-seeded — Step 0 seeds them.

## Step 0 — Seed tasks if not already seeded

**Detect seeded state deterministically** — the #1 resume trap is seeding, exiting, and re-seeding from scratch next session:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs status-report --feature <feature>
```
No feature arg? Run it with none — it resolves the active feature and returns that feature's tag-scoped counts in the same call. **`tasks` non-null / total > 0 → already seeded, go to Step 0.5.** Total 0 → seed below.

**Seeding is a three-phase handoff to you** (default `taskCore.aiMode: agent-native`, zero-network by design — `docs/agent-native-two-phase.md`):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/task-master parse-prd --input .spec-flow/specs/<feature>/SD.md --tag <feature>
```
1. That prints a `GenerationSpec` and exits 0 **without seeding anything** — exit 0 proves nothing. Redirect it to a file and read only `instructions` + `taskSchema`; `inputContent` is the whole SD you already have (~10k tokens to re-read for nothing).
2. Generate the `Task[]` yourself per `instructions` + `taskSchema`. You are phase 2.
3. `task-master tasks-import --tag <feature> --file <generated.json>` — `{"imported": N}` from THAT is the real signal. Confirm with `task-list --tag <feature>`.

> If `config.taskCore.aiMode` is **not** `agent-native`, the AI ops call a real provider — run `flow-tools.cjs taskmaster-model-check` once first and fix any reported role before starting the loop.

## Step 0.5 — Confirm the task list (gate: `config.phase.confirmTasks`, default true)

`parse-prd` is not deterministic, and "approve the SD" does not mean "approve this task list".

- **`true` (default):** show the seeded tasks (`task-list --tag <feature>` — id, title, dependencies) and **pause** for the user to eyeball / drop / re-order. Proceed only on their go-ahead. Review-only; they run nothing.
  - **Skip the pause on resume:** any task already `done`/`in-progress` → go straight to the loop.
- **`false`:** go straight to Routing.

## Routing

```
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs route --sd .spec-flow/specs/<feature>/SD.md
```

Deterministic per-FR complexity (1–10) — this is the **only** complexity signal the loop uses:
- **1-3 → fast**: straight to the executor.
- **4-7 → expand**: `task-master expand --id <id> --tag <feature>` — same three-phase handoff as `parse-prd` (prints a `GenerationSpec`, you generate the subtasks, `tasks-import` persists them). Then run each subtask as fast. **Both flags are required and `--id=<id>` does NOT work** — the CLI's parser wants a space, and without `--tag` it resolves tag `undefined` and errors `ERR_TASK_NOT_FOUND`.
- **8-10 → deep**: if the task touches an external integration, run `task-master research "<query>"` first (pass the SD risk row as context), then spawn **hybrid-executor** with the extra planning notes.

## Per-task loop

0. **Pick up `review` tasks FIRST (no dead-end).** `task-list --tag <feature> --status review`. A task lands in `review` when smoke failed (step 5) or it was implemented but never closed — and `task-next` does **not** return them, so left alone they are a silent dead-end. Re-run its smoke (step 5): passed → close it (step 6); failed → set `in-progress`, re-spawn the executor with the FAIL output, fix, re-verify. **Same task fails smoke twice → STOP and ask the user** (likely needs `/sf:change` or `/sf:bug`); do not loop forever. Only when no `review` task remains, go to step 1.

1. **Next task(s) — check for parallelizable work first**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs wave-plan --feature <feature>
   ```
   Returns `ready` (dependencies all `done`). It does **not** prove file-disjointness — files touched aren't known until a task runs. If `ready` has ≥2 tasks, judge disjointness yourself from each `title`/`details` (`task-get --id <id>`): different component/layer/file, no shared entity → safe to batch. Same file or one extends the other → sequential. **When in doubt, sequential** — a wrong guess means two executors clobber the same file with no worktree isolation. Otherwise: `task-next --tag <feature>`.

2. **Spawn hybrid-executor** — one per task selected in step 1 (multiple Agent calls in ONE message when the batch is file-disjoint). Give it: task details + `CONTEXT.md` + the relevant SD section refs. Before spawning, extract the bullets under `## Code Rules` in `.spec-flow/project-author.md` (if any) and paste them **verbatim** into every executor prompt — binding, not "read if present". **Code stays English even when `config.language` ≠ `en`** (that setting is conversation + docs only). **Model:** `config.json → models.hybridExecutor`; non-null → pass as the Agent `model` param, else omit.

   **Parallel batch:** steps 3-6 still run once per task, in any order — safe only because you judged the batch file-disjoint. Do **not** parallelize `trace-build` (it rebuilds the whole file); run it once after every task in the batch has logged its `trace-link`.

   **Check TDD evidence in the executor's summary before proceeding.** Feature task: a test file written plus either `gate: "red-confirmed"` or an explicit note that testCommand is not configured — if neither, ask for the RED confirmation. Chore task: "chore — RED phase skipped" is expected.

   **Check the `## Code Rules` compliance table the same way.** `## Code Rules` had ≥1 bullet and the summary is missing the table, missing a bullet's row, or has any row `violated` → send it back, do not proceed. Zero bullets → no table expected.

3. **Record the disk facts — ALWAYS.** These are what `/sf:status` reads:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs task-set-status --tag <feature> --id <id> --status review
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-link \
     --task <id> --feature <feature> --fr <FR-id> [--repo <service>] \
     --files "<comma-separated relative paths changed>"
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build --sd .spec-flow/specs/<feature>/SD.md
   ```
   **Always pass `--fr <FR-id>`** — it seeds the `fr→task` link that lets a later `/sf:change` on that FR auto-reopen this exact task via `trace-impact`. Omit it and the FR change resolves to `tasks=[]`. Only drop it for a pure infra/chore task with no FR (say so when you do).

   **Optional narrative log — `config.phase.taskNotes` (default `false`).** Absent or `false` → **skip entirely**. `update-task --append` is one AI subprocess per task (measured 13.2 tasks/feature) producing only human-readable history — it is not the source of truth. Only when `true`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/task-master update-task --id <id> --tag <feature> --append --prompt "<files/approach/result>"
   ```
   **Both flags are required, and `--id=<id>` does NOT work** — the CLI's parser wants a
   space, and without `--tag` it resolves tag `undefined` and errors `ERR_TASK_NOT_FOUND`.
   Non-blocking: on error surface it once and continue — never halt the loop over a history write.

4. **Automated quality gate**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code --feature <feature> --task <id>
   ```
   **Always pass `--task <id>`** — it scopes `tests` to this task's own test file(s) (via step 3's `trace-link`) instead of the full suite; that is the main lever for phase speed on a multi-task SD (the full suite runs once, at close-out 1a). Static checks scan the whole scoped root regardless, including `code-rules` (from `config.verify.rules`) — a `code-rules` failure halts like any other static check. **Multi-repo: always also pass `--feature`.**
   - `gate: "fail"` → `task-set-status` → `review`; surface `detail` + `fix`; **halt**.
   - `gate: "pass"` → proceed. Confirms THIS task's tests + static checks, not the whole codebase.
   - `gate: "skipped"` → **nothing was verified** (no `verify` block). Do NOT report the code as verified. Say so **once per phase, on the first task only**, then stay silent on it.

5. **Manual-test gate** — for tasks that expose a testable surface.
   ```
   scripts/api.sh PRIME --auto
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag smoke
   ```
   exit 0 → step 6. Non-zero → `task-set-status` → `review`; surface FAIL lines; **halt**.

   **Defer smoke when the task has no surface yet** (a migration, a service wired but not exposed, a consumer with no broker). Do not fabricate a smoke pass and do not block on an N/A gate: close on build + unit-test evidence, note "smoke deferred — no endpoint yet", and let the smoke land on the task that exposes the endpoint, or on the close-out regression sweep.

6. **Close task + sync state**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs task-set-status --tag <feature> --id <id> --status done
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update --feature <feature> --note "task #<id> done"
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs checkpoint-clear --feature <feature>
   ```

6b. **Semantic drift-check (advisory)**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs drift-check --feature <feature>
   ```
   Diffs the error codes evidenced in task logs against SD §12.2. `spec-not-evidenced` → confirm the spec'd error is actually built. `impl-not-specced` → update SD §12.2, or fix the code to the spec'd one. Never blocks. (With `taskNotes: false` there are no logs to diff — it reports "no logs yet" and that is fine.)

7. **Repeat** until no pending tasks remain.

## Phase close-out

0. **Reconcile lingering `review` tasks.** `task-next` will NOT return them, so re-running `/sf:phase` does nothing for them. After the regression sweep passes, **confirm with the user**, then `task-set-status --status done` for every `review` task the regression covers. Never auto-close silently. `status-report` flags this ("N task(s) in review — reconcile").

1a. **Full unit-test suite — once.** Step 4 scoped each task to its own tests, so the full suite hasn't run since task 1:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code --feature <feature>
   ```
   A failure here is a **cross-task regression**. Fix it and re-run before the checklist sweep.

1b. **Regression sweep**
   ```
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag regression --json | tee .spec-flow/specs/<feature>/regression-results.txt
   ```

2. **Collect into VERIFICATION.md**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect --results .spec-flow/specs/<feature>/regression-results.txt
   ```
   `--json` is required in 1b or this errors `NO_JSON_RESULTS`. `status: passed` only when zero regression failures.

   **Live gaps are first-class.** Anything that shipped `verified-adhoc` or could not be machine-verified (event-driven delivery, cross-service flow, a `live-e2e` TC) gets one `- ` bullet under a `## Not verified live` heading. `/sf:status` surfaces these as "N live gap(s)" so they aren't lost at merge. Do NOT bury them in prose.

3. **Final state sync**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update --feature <feature> --note "phase complete — regression passed"
   ```

3b. **Code review — OPTIONAL gate (`config.phase.codeReview`, default `off`)**

   **Opt-in. Do NOT run, offer, or suggest a code review unless `review-scope` returns `gate: ask` or `gate: always`.** Nothing else authorises it: not a clean regression, not a large diff, not your own judgement that a review "would be prudent". `verify-code` is a different, mandatory gate and does not count as a review.

   The executors that wrote this code cannot review it: they are inside their own reasoning. This step buys one **independent** pass over the finished diff, in a context that never wrote a line of it, right before the code leaves the branch.

   **First, the same precondition as the ship itself:** `VERIFICATION.md` must read `status: passed` (or `verified-adhoc`). `failed`, `incomplete`, or missing → **skip the review entirely** and go to step 4, which halts. Reviewing code that step 4 is about to send back spends a pass on a diff that will change.

   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs review-scope --feature <feature>
   ```
   Returns `gate` · `model` · `range` (`<base>...HEAD`) · `files` (from `file-links.json`) · `repos` · `existing` · `stale`. Act on `gate`:
   - **`off`** (default, also when the key is absent or unreadable) → skip to step 4. Say nothing, ask nothing.
   - **`ask`** (the project opted in) → **the question must actually reach the user, as an `AskUserQuestion` tool call** with two options, `Yes, run the review` and `No, skip it` (question: *"Run an independent code review before shipping `<feature>`? (~N files / `<range>`)"*). Writing the question in prose, or deciding on the user's behalf, is not asking.
     - **Only an explicit `Yes, run the review` runs the review.** Every other outcome is **no**: `No`, a dismissed or empty answer, free text that is not a clear yes, the tool being unavailable, or a session running in auto-mode / unattended / non-interactive. Skip to step 4 and record nothing (an un-run review is not a clean one).
     - Silence is never consent. If you cannot show the prompt, treat the gate as `off` for this ship.
   - **`always`** (the project opted in) → run it, no prompt.
   - `existing` non-null and `stale: false` → that review already covers this exact HEAD. Re-use it; don't burn a second pass. `stale: true` → HEAD moved since; re-review.

   **Run it — one sub-agent, independent, read-only.** Spawn ONE agent with the `code-review` skill. **Model:** `review-scope → model` (default `sonnet`); non-null → pass as the Agent `model` param, else omit.

   > **The failure mode of this gate is a noisy reviewer, not a lazy one.** A model handed a bare diff cannot tell a real defect from a deliberate decision, so it reports both at the same severity, and after two such reviews the user answers "no" forever and the gate is dead. Everything below exists to prevent that. Do not shorten it.

   **Give it the context pack** — `review-scope → contextPack` returns only the paths that exist. Pass every one, and say what each is for:
   - `sd` — §5.1 FR rows, §12.2 error codes, and the architecture/decision sections. **This is the specification.** Code that matches the SD is correct even when it looks surprising.
   - `context` — why the feature exists, and the constraints it was built under.
   - `checklist` — the behaviours that already have a manual test.
   - `verification` — what ran green, and the `## Not verified live` gaps that are already **known and accepted**. Re-reporting a declared gap is noise.
   - `projectAuthor` — `## Code Rules` bullets are a mandatory checklist the reviewer must answer one by one; a violation is a finding with `category: "project-rule"`, `checkedAgainst` = the rule text, severity ≥ `medium`; `review-collect` treats every `project-rule` finding as blocking. Conventions outside `## Code Rules` (taste, naming) stay at most `low`, unchanged.
   - `trace` — the FR→TC links, for checking a claim against its coverage.

   **Give it the scope:** `range` when non-null, else the `files` list (multi-repo: always `files`, plus the `repos` roots — the hub repo holds no code). Tell it the diff may contain files outside this SD; **review only what this feature's FRs own**.

   **Give it the standing rules:**
   - **Read-only. Report, do not fix.** No edits, no staging, no commits. Fixing is a separate decision the user makes below.
   - **`verify-code` and the full regression already passed.** Do not report "this needs a test" for behaviour the checklist covers, and do not re-derive what the test suite proved.
   - **Before writing any `critical` or `high`, check it against the SD and the checklist.** Specified behaviour → not a finding. Covered by a TC → at most `low`. Only reachable through an input the FR forbids → at most `medium`.
   - **A `critical`/`high` must name a concrete failure:** the inputs or state that trigger it, and the wrong result that follows. **If you cannot write that sentence, it is not critical or high.** This single rule is what keeps the severity ladder meaningful — a vague worry cannot be phrased as a failure scenario.
   - **Taste is `low`.** Naming, structure, and "I would have written it differently" never exceed `low`, whatever their volume — unless it breaks a `## Code Rules` bullet, which is a `project-rule` finding and blocks the ship like a `high`.
   - **Empty `findings` is a valid, expected, and common answer.** An invented finding costs the user more than a missed one, because it spends the credibility the next real finding needs.

   **Output contract:**
   ```json
   {"findings":[{"severity":"critical|high|medium|low|info","title":"...","file":"path","line":12,"category":"correctness|security|spec-mismatch|simplification|efficiency|project-rule","detail":"concrete failure: inputs/state -> wrong result","suggestion":"...","checkedAgainst":"FR-007 / TC-014 / none"}]}
   ```
   `checkedAgainst` is required on every `critical`/`high`: the FR or TC the finding was tested against, or `none` when the behaviour is unspecified. **A blocking finding with no `checkedAgainst` was not checked** — send it back rather than collecting it.

   **Record the verdict — ALWAYS, the moment the agent returns.** A review that lives only in this transcript is gone next session:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs review-collect \
     --feature <feature> --findings <path-to-findings.json> [--target "<range-or-scope>"]
   ```
   Writes `specs/<feature>/CODE-REVIEW.md` and returns `status`:
   - **`clean`** / **`advisory`** → report the counts in one line, go to step 4. Advisory findings ship; they are written down, not acted on here.
   - **`uncheckedBlocking` non-empty** → those blocking findings carry no `checkedAgainst`, i.e. nobody tested them against the spec. **Send them back to the reviewer once** with the SD and checklist, and ask it to re-rate each against a named FR/TC. Re-collect the result. Do not halt a ship on an unchecked claim, and do not silently downgrade one either.
   - **`blocking`** (≥1 `critical`/`high`) → **HALT the ship.** Show each blocking finding, then ask the user to choose:
     1. **Fix now** → re-open the owning task(s) (`task-set-status --status in-progress`), re-spawn the executor, then **re-run 1a + 1b + 2** (a post-review fix is unverified code) and come back to 3b.
     2. **Ship anyway** → record the decision on disk before shipping, or the next session reads an unresolved blocker:
        ```
        node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs review-accept --feature <feature> --note "<why>"
        ```
     3. **Abort** → stop; `/sf:status` keeps surfacing the blocking review.

   This gate never invents a reason to run or to skip itself: `off`, and `ask` without an explicit yes, are the silent paths, and `verify-code` / regression remain the hard gates either way.

4. **Ship** — **HARD GUARD (G3): do NOT ship unless `VERIFICATION.md` reads `status: passed`** (or `verified-adhoc` for an out-of-loop live verify). `failed` or missing → STOP, go back to the regression sweep. Once passed: stage, then invoke the bundled **commit** skill in `push` mode (`skills/commit`) — it writes the conventional-commit message, commits on the current `feat/<feature>` branch (it refuses to commit on the base branch when `branching.mode != off`), pushes, and surfaces the MR/PR link. Report the link.
   - **Tag the ship (G2):** `git tag -a <feature>-v<n> -m "<feature> shipped"` then `git push --tags` — a durable, greppable record that this SD reached a verified ship. Skip only if `branching.mode: off`.
   - **Multi-repo:** run the commit skill once per repo with staged changes (`cd` into each) → one PR per service; tag each. Report all links together.
   - **Code review (soft guard):** if step 3b ran and left `status: blocking` with `accepted: no`, you did not finish 3b — go back. `clean`/`advisory`/`accepted: yes`/skipped all ship. Mention `CODE-REVIEW.md` in the report when it exists.

## Pipeline recap
```
parse-prd (3-phase) → route --sd → wave-plan → [task-next | parallel batch]
  → hybrid-executor (TDD RED) → task-set-status(review) + trace-link + trace-build
  → verify-code --task <id> → run-checklist smoke (deferrable) → task-set-status(done) → state-update
  → verify-code (full suite, once) → run-checklist regression → verify-collect → VERIFICATION.md
  → [optional gate] review-scope → code-review sub-agent → review-collect → CODE-REVIEW.md → ship
```
