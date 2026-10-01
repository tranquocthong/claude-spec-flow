---
description: "Developer-initiated change to an already-implemented feature (bottom-up): edit the SD spec first, re-route impacted tasks via the trace, re-implement + re-verify. Loops fix/enhance until done. Top-down counterpart is /sf:resync (Product changed the SRS)."
argument-hint: "<description>" [--type fix|enhance]  |  --resume <id>
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:change — revise the spec (fix / enhance) until done

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each step so the flow survives long sessions.

Input: `$ARGUMENTS` (change description + optional `--type fix|enhance`).

Same machinery as `/sf:resync`, but the change originates from the **developer** (bottom-up) rather than from Product changing the SRS (top-down). `fix` vs `enhance` differs only in MoSCoW weight and test tag (`smoke` for fix, `regression` for enhance).

> **Resume an open change — don't re-open it.** `/sf:change --resume <id>` (the `id`, e.g. `change-001`, comes from `/sf:status`, which lists open changes). **Skip Step 1** (do NOT create a new record); read the existing `.spec-flow/changes/*-<id>-*.md` and **continue from its current step** (SD edited but tasks not re-routed → Step 3-4; re-implementing → Step 5; verified → Step 6 confirm + close). Never create a new record for an id that already exists.

> **Wrong command?** `/sf:change` edits an existing **SD** (a *spec* change). **No SD in `.spec-flow/specs/`?** Don't retro-spec the legacy feature — an SD that doesn't match drifted code is worse than none. Instead: code is wrong → **`/sf:bug`** (SD-optional, the repro test is the contract); want new/changed behavior → forward-spec **only the delta** via **`/sf:ingest --idea "<the new behavior>"`** (a focused mini-SD for just the change, never the whole legacy feature). If the SD exists and only the code misbehaves → **`/sf:bug`**. Mirror of `/sf:bug`'s own triage (code-bug → fix code · spec-bug → `/sf:change` · srs-level → `/sf:resync`).

## Fast path (trivial change)

If `trace-impact` (step 3) resolves to **one FR/TC and one task** — e.g. rename a filter param (`status` → `statuses`), reformat one output field — collapse the ceremony; the SD still leads, just lighter:

- **Step 1** — change record = a single line (skip the per-iteration loop block); still create the work branch.
- **Step 2** — edit the SD row directly; do **not** spawn sd-author.
- **Step 5** — `/sf:phase` will route the one task to **fast**.
- **Step 6** — verify only the impacted TC (`run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --id <TC>`); run the full regression/smoke tag only at close.

If impact spans multiple nodes, or you're unsure, run the full steps below.

## Steps

1. **Open change record + work branch**
   Write `.spec-flow/changes/<NNN>-change-<slug>.md` (number-first so files sort in creation order; `slug` = first ~6 words of the description). Pick `NNN` as `(count of existing .md in changes/) + 1`, zero-padded to 3. Inside, set `id: change-<NNN>` (the short, stable handle for traceability refs) plus `status: active`, `type`, `description`, linked SD section. Audit trail for each loop iteration.

   Then create the work branch (per `config.json → branching`):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs branch-ensure --kind change --id change-<NNN> --slug "<slug>" --type <fix|enhance>
   ```
   Creates/switches `<type>/change-<NNN>-<slug>` when on the base branch (no-op if already on a work branch or `mode: off`). **Multi-repo (`config.repos` set):** append **`--repos "<service>,..."`** to scope the branch to the repos this change actually touches (else all configured repos branch). Unknown name → `REPO_NOT_CONFIGURED`.

2. **Edit the SD spec**
   Update the relevant SD section, or spawn **sd-author** to propose a diff.
   - Never patch code without patching SD first — SD is always the source of truth.
   - Mark edited rows/sections `TODO:MANUAL-REVIEW` for non-trivial changes; clear once approved.
   - `fix`: update the FR row or §12.2 error code. `enhance`: add a new FR row (next `FR-xxx` ID) + corresponding §13.2 TC row.

   **Sync CHECKLIST.yaml after any §13.2 change:**
   - TCs removed → remove the corresponding suites from CHECKLIST.yaml.
   - TCs added → add new suites (see below).
   - How to add: if CHECKLIST is all-TODO (scaffold), run `/sf:checklist` to regen in full — safe. If CHECKLIST is partially filled (real request/assertion data present), add the new suites manually to avoid wiping filled tests.

3. **Resolve impact from the edited SD section**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-impact \
     --ids "<FR-xxx,TC-xxx,ERR_xxx>"
   ```
   Returns `{ impacted: { fr, tc, errors, tasks }, reasons }`. Use `--keywords "<term>"` for concept-based impact.

   > **Scope reduction on an implemented feature:** If this change *removes* behavior AND `STATE.md` shows the feature is already implemented/verified, then `impacted.tasks = []` does NOT mean no code changes are needed. The removed behavior may exist in code even without its own TM task (written as part of a broader task). Before concluding no code work is needed: confirm the removed nodes have no corresponding code. If code exists → add a cleanup task in Step 4 (`task-add`) before closing.

4. **Re-route impacted tasks**
   **Per-feature tag:** every task op takes `--tag <feature>` so you re-open *this* feature's tasks, not another's. For each task ID in `impacted.tasks`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs task-set-status --tag <feature> --id <id> --status review
   ```
   Net-new work not covered by an existing task → add one:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs task-add --tag <feature> --title "<title>" \
     [--description "<d>"] [--details "<d>"] [--priority high|medium|low]
   ```
   These are deterministic state ops on `.taskmaster/tasks/tasks.json` — no model, no MCP.

5. **Re-implement**
   Run `/sf:phase` over the `review` tasks:
   - `route --sd .spec-flow/specs/<feature>/SD.md` routes each affected FR to fast/expand/deep.
   - Executor edits code. Narrative logging (`task-master update-task --id <id> --tag <feature> --append`) is opt-in behind `config.phase.taskNotes` (default `false`) — see `/sf:phase` step 3; `trace-link` is the durable record either way.
   - **TDD (optional, recommended):** when the change is isolable in code and the stack has a unit harness, drive each task RED→GREEN→REFACTOR — failing unit test first, minimal change to green, then clean the diff without altering behavior. The durable regression anchor stays the §13.2 TC / CHECKLIST suite (stack-agnostic); the unit test is the fast inner loop, not a replacement.
   - `task-set-status --status review` after each code change.
   - Manual-test gate (step 6) before each task advances to `done`.

6. **Re-verify**
   > **Golden rule — verify against latest `main`, never a stale branch base.** The re-verify gate MUST run on top of the latest base branch (`config.json → branching.base`, default `main`) **plus** your change — not the possibly-stale base the `change/*` branch was cut from (this matters most on `--resume`, where the branch is often behind `main`). Before running the checklist below, sync the work branch to latest base:
   > ```bash
   > BASE=$(node -e "try{console.log(require('./.spec-flow/config.json').branching?.base||'main')}catch(e){console.log('main')}")
   > git fetch origin "$BASE" && git rebase "origin/$BASE"   # or: git merge "origin/$BASE" if the project prefers merge
   > ```
   > Resolve any conflicts, then re-run the change's build/unit tests before proceeding. Skip only when `branching.mode: off`. **Rationale:** a green result on a stale base can pass a change that breaks once merged onto current `main`; anchoring verification to main-latest + the change makes green reflect what will actually ship.

   **Automated quality gate over the whole change, after the sync.** Step 5 ran `verify-code --task` per task; the rebase and a multi-task change are not covered by that. Run it once unscoped, which also runs `code-rules` (from `config.verify.rules`, diff-scoped to what this branch added or changed):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code --feature <feature>
   ```
   `gate: "fail"` → surface `detail` + `fix`, loop back to step 5. Do not run the checklist on a change that fails the gate.
   ```
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag smoke --json | tee .spec-flow/specs/<feature>/change-results.txt
   ```
   On PASS, collect results (`verify-collect` reads the runner's `--json` result line):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect --results .spec-flow/specs/<feature>/change-results.txt
   ```
   - **Still failing** → loop back to step 2 (update SD → re-trace → re-implement → re-verify). Record each iteration in the change `.md`.
   - **PASS, before closing: code review.** Run `/sf:phase` close-out step 3b (`review-scope` → reviewer → `review-collect`) over this change's diff, under the same `config.phase.codeReview` setting (default `off`: when `review-scope` returns `gate: off`, skip it silently, do not offer it; `gate: ask` needs the explicit `AskUserQuestion` yes from step 3b, anything else is no). Every `## Code Rules` bullet is checked there and a `project-rule` finding blocks, so a change cannot bypass the rules the reviewer enforces on a phase. `blocking` → fix (loop back to step 5) or `review-accept` with a note.
   - **PASS** → **confirm the close with the user** (the user is the source of truth for "done"). Announce + ask, right now in this session: *`change-<id>` — verified green. Close it (`status: active` → `done`), or keep open?* On confirm → set `status: done` + append `truths[]` to `VERIFICATION.md must_haves.truths`. On defer → leave `status: active` (`/sf:status` keeps surfacing it). Don't auto-close, don't rely on the user remembering later — but the decision is theirs. A change isn't done until its record reads `status: done`.

7. **State sync** after each task closes:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
     --feature <feature> --note "change-loop: <change-id> iteration N"
   ```

8. **Loop** — repeat steps 2–7 for each remaining open change in `.spec-flow/changes/`.

## Output
- `.spec-flow/changes/<NNN>-change-<slug>.md` (audit trail per iteration; internal `id: change-<NNN>`)
- Updated SD + tasks + CHECKLIST + VERIFICATION, kept in sync via trace.
- `.spec-flow/STATE.md` refreshed after each task closes.

## Pipeline recap
```
trace-impact (from edited SD section) → re-open tasks → /sf:phase → verify-code (incl. code-rules)
  → run-checklist → [optional gate] code review (phase step 3b)
  → verify-collect feeds VERIFICATION.md → loop back if not satisfied
```
