---
description: Adaptive implement loop. Routes each task by complexity (fast / expand / deep), drives next_task -> implement -> manual-test -> done with state tracking.
argument-hint: [feature] [--task <id>]
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:phase — adaptive implement loop

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each task so the flow survives long sessions.

> **HARD RULE — "done" means synced disk, NOT a prose claim.** `/sf:status` derives everything from disk (TM task statuses, STATE.md, VERIFICATION.md). Anything you don't write back is LOST next session — the user will open `/sf:status` and see "not implemented" even though you finished. So you may NOT tell the user a task/feature is done unless, on disk: (1) its TM task is `done` (not left in `review`), (2) `state-update` has run (STATE.md current), and (3) at phase end VERIFICATION reflects the result. **If you verified out-of-loop (ad-hoc / live E2E instead of `run-checklist`), you STILL MUST do (1)–(3) before reporting done** — confirming it works ≠ recording that it's done. A prose "done" with stale state is the failure mode this rule exists to stop.

> **Task Master — CLI for AI ops, MCP for state ops.** Any AI-calling op (`parse-prd`,
> `analyze-complexity`, `expand`, `research`, `update`/`update-subtask`) MUST run via the **CLI** so it
> reads `.taskmaster/config.json` fresh and uses the keyless `claude-code` provider:
> `npx -y -p task-master-ai@0.43.1 task-master <cmd> …`. The long-running MCP server caches the
> provider from startup and fails AI ops with a stale `PERPLEXITY_API_KEY`/`ANTHROPIC_API_KEY` error.
> State ops (`next_task`, `set_task_status`, `get_tasks`, `add_task`) call no provider → keep the
> `mcp__task-master-ai__*` tools. **Fallback:** if any MCP TM call errors with a missing API key, re-run it as the CLI equivalent.

> **Per-feature tag — task isolation.** EVERY TM op in this flow operates on tag `<feature>` (the feature slug): add `--tag <feature>` to CLI ops, `tag: "<feature>"` to MCP ops. This keeps each feature in its own task space, so a prior feature's (or bug/change's) tasks never collide with or block the next — the same per-feature rule as file-links. `parse-prd --tag <feature>` creates the tag; state ops are lenient (a not-yet-seeded tag just returns empty, no error).

> **Multi-repo — one SRS/SD, code in sibling service repos.** Read `config.repos` from `.spec-flow/config.json` (e.g. `{ "auth-svc": "../auth-svc", "billing-svc": "../billing-svc" }`). When set, the planning `.spec-flow/` lives in THIS repo (the hub) but each task's code lives in a sibling repo. The SD labels every component/FR by service (e.g. "(auth-svc)", "(billing-svc)") — use that to pick the target repo. For each task: **`cd` into `config.repos[<service>]` to implement + build/test there**, then record the change with **`trace-link --repo <service> --files ...`** so the path is stored repo-qualified (`auth-svc/src/...`). `verify-code` scopes to the repos THIS feature touched when you pass `--feature <feature>` (it reads the repo prefixes from `file-links.json`) — always pass it so an unrelated repo's red WIP can't fail this feature's gate; `branch-ensure` still loops over all `config.repos`. You do not call them per repo. Absent `config.repos` → single-repo (everything in cwd), nothing changes.

## Preconditions (hard gates)
- SD approved (0 `TODO:MANUAL-REVIEW`) — **the primary human gate**. After it, the agent runs every CLI step itself; the user never runs one. (A second, lightweight review pause may follow Step 0 — see Step 0.5 — but the user still runs nothing, only eyeballs the seeded task list.)
- `CHECKLIST.yaml` exists (run `/sf:checklist` if not).

Tasks need **not** be pre-seeded — **Step 0 seeds them.** "Approve the SD" is all the user does; seeding + implementation are the agent's job.

## Step 0 — Seed tasks if not already seeded
Check the feature's task space first (state op, no provider): `mcp__task-master-ai__get_tasks` with `tag: "<feature>"`. If it already has tasks → skip to Routing. If empty, **the agent seeds them itself** (do NOT hand this to the user) — CLI AI ops, same as every other AI op in this flow; the keyless `claude-code` provider reaches the Claude binary via `CLAUDE_CODE_EXECPATH` (set by the host), so `which claude` printing nothing does not block it:
```
npx -y -p task-master-ai@0.43.1 task-master parse-prd --input .spec-flow/specs/<feature>/SD.md --tag <feature>
npx -y -p task-master-ai@0.43.1 task-master analyze-complexity --tag <feature> --research
npx -y -p task-master-ai@0.43.1 task-master use-tag <feature>
```
Use a **per-feature `--tag`** so this feature's tasks stay isolated. Only if the CLI genuinely errors on a missing provider/key do you ask the user to run these two lines in their terminal.

> **CRITICAL — set the global current tag (`use-tag`).** Task Master MCP state ops (`next_task`, `set_task_status`, `update-subtask`) bind to the **global `currentTag`** in `tasks.json` and may **ignore** a per-call `tag:` param. If `currentTag` still points at a prior feature, every state op silently operates on the wrong tag — executors fail to log ("wrong tag … requires parentId.subtaskId"), and trace counts read another feature's tasks. So **always run `use-tag <feature>` right after seeding** (and again on resume if you switched features) so `currentTag` == this feature. The engine's `trace-build`/`trace-link`/`state-update`/`status-report` are already tag-scoped via `--feature` and do not depend on `currentTag`.

## Step 0.5 — Confirm the task list (gate: `config.phase.confirmTasks`, default true)

Read `config.phase.confirmTasks` from `.spec-flow/config.json` (absent → treat as **true**). `parse-prd` is an AI op — the breakdown is not deterministic, and "approve the SD" does not mean "approve this task list." So before implementing:

- **`true` (default):** show the seeded tasks (`get_tasks` for `tag: "<feature>"` — id, title, brief, dependencies) and **pause**. Let the user eyeball / drop / re-order / `expand` tasks before any code is written. Proceed to Routing only on their go-ahead. The user still runs nothing — you ran the seeding; this is review-only (transparency, not punting work).
  - **Skip the pause on resume:** if any task is already `done` / `in-progress`, implementation has started — go straight to the per-task loop, do not re-gate.
- **`false`:** auto-implement straight through — skip this pause, go to Routing.

## Routing

```
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs route --sd .spec-flow/specs/<feature>/SD.md
```

Returns per-FR complexity scores (1–10):
- **1-3 → fast**: skip research/plan; go straight to executor.
- **4-7 → expand**: CLI `npx -y -p task-master-ai@0.43.1 task-master expand --id=<id>` (AI op — CLI, not MCP), then run each subtask as fast.
- **8-10 → deep**: CLI `npx -y -p task-master-ai@0.43.1 task-master research "<query>"` first if the task touches an external integration (pass the SD §14 risk row as context), then spawn **hybrid-executor** with extra planning notes.

## Per-task loop

0. **Pick up `review` tasks FIRST (no dead-end).** Before `next_task`, check for tasks stuck in `review` (`get_tasks` `status=review`, `tag: "<feature>"`). A task lands in `review` two ways: (a) smoke **failed** (step 5 halted it), or (b) it was implemented but never closed. `next_task` does **not** return `review` tasks, so left alone they are a silent dead-end. For each `review` task: re-run its smoke suite (step 5). **Passed** → close it (step 6). **Failed** → re-attempt: set it back to `in-progress`, re-spawn the executor with the FAIL output as context, fix, re-verify. If the same task fails smoke **twice in a row**, STOP and ask the user (it likely needs a spec change → `/sf:change`, or a bug fix → `/sf:bug`) — do not loop forever. Only when no `review` task remains, proceed to step 1.

1. **Next task**
   ```
   mcp__task-master-ai__next_task   # tag: "<feature>"  (see per-feature tag rule above — applies to every TM op below)
   ```

2. **Spawn hybrid-executor** with: task details + `CONTEXT.md` + relevant SD section refs (from `.spec-flow/trace.json` FR→TC links).

3. **Code + log**
   ```
   npx -y -p task-master-ai@0.43.1 task-master update-task --id=<id> --append --prompt="<files/approach/result>"   # AI op → CLI
   mcp__task-master-ai__set_task_status --id=<id> --status=review                                                  # state op → MCP
   ```
   Use **`update-task --append`** (logs onto the task itself), NOT `update-subtask --id=<id>`: `update-subtask` requires a `parent.sub` id and fails for any task that was not expanded into subtasks (the common solo/fast-path case — "requires parentId.subtaskId"). `--append` works for both expanded and un-expanded tasks.
   **Cost note:** `update-task --append` is an AI op (one CLI call per task — slow over many tasks). It is **optional human-readable history**, not the source of truth: the deterministic record is `trace-link` (files touched — a zero-AI state op) + `state-update` + the TM status. If per-task AI latency is a problem, **batch one note at task close** or skip it; do NOT skip `trace-link`/`set_task_status` (those are the disk facts `/sf:status` reads).
   If executor did not call `trace-link`, run it from the executor's reported file list:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-link \
     --task <id> --feature <feature> --fr <FR-id> [--repo <service>] \
     --files "<comma-separated relative paths changed>"
   ```
   **Always pass `--fr <FR-id>`** — the task implements an FR row in the SD (the SD/route output tells you which). This seeds the `fr→task` link that lets a later `/sf:change` on that FR **auto-reopen this exact task** via `trace-impact`; omit it and the FR change resolves to `tasks=[]` and someone has to map FR→task by hand. Only drop `--fr` for a pure infra/chore task with no FR (then say so).
   Multi-repo: pass `--repo <service>` (the repo the files live in) so paths are stored qualified.
   Then rebuild trace:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build --sd .spec-flow/specs/<feature>/SD.md
   ```

4. **Automated quality gate**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code --feature <feature>
   ```
   **Multi-repo: ALWAYS pass `--feature`** (or `--repos "a,b"`). It scopes the scan to the repos this feature actually wrote to (read from `file-links.json`), so an unrelated repo sitting on a red WIP branch can't poison this feature's gate. Single-repo → `--feature` is harmless (one root). The result includes `scope` (what it narrowed to) and `repos` (what ran).
   Parse returned JSON:
   - `gate: "fail"` → `set_task_status` → `review`; surface `detail` and `fix`; **halt**.
   - `gate: "pass"` → at least one real check ran and none failed → proceed to step 5.
   - `gate: "skipped"` → **nothing was actually verified** (no `verify` block configured). Do NOT report the code as verified. Surface the `note` **once per phase, on the first task only** — repeating "verify not configured" on every task is noise; say it once ("verify not configured — the automated gate checks nothing this run; re-run `/sf:init --stack <stack>` to seed a real preset"), then stay silent on it for the remaining tasks. It does not block — but it is honestly a no-op, not a pass.
   Generic and config-driven — Java teams configure gradle + forbidden patterns; a project with no verify block is `skipped` (surfaced as a no-op), never a silent pass.

5. **Manual-test gate** — applies to tasks that expose a testable surface.
   ```
   scripts/api.sh PRIME --auto
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag smoke
   ```
   - exit 0 → proceed to step 6.
   - non-zero → `set_task_status` → `review`; surface FAIL lines; **halt**.

   **Defer smoke when the task has no HTTP surface yet.** Background/infrastructure tasks (a DB migration, a service/repository wired but not yet exposed, an internal filter, a consumer with no running broker) have nothing to smoke — and the service may not even be running. Do NOT fabricate a smoke pass and do NOT block on an N/A gate. Instead: complete the task on **build + unit-test** evidence (the `verify-code` gate + the executor's TDD test), note "smoke deferred — no endpoint yet", and let the smoke run land on the later task that exposes the endpoint (or at the close-out **regression** sweep, which runs the full checklist once the surface exists). The rule the gate protects — "nothing claimed done without a real check" — is satisfied by the unit/build evidence now and the deferred e2e smoke later; it is not satisfied by pretending a no-surface task smoked.

6. **Close task + sync state**
   ```
   mcp__task-master-ai__set_task_status --id=<id> --status=done
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
     --feature <feature> --note "task #<id> done"
   ```

7. **Repeat** until no pending tasks remain.

> Tip: `flow-tools wave-plan` lists the tasks whose dependencies are all done (the workable set). The
> model may choose to work file-disjoint ready tasks concurrently — but anything that shares files
> must be done sequentially to avoid clobbering (no worktree isolation here).

## Phase close-out

0. **Reconcile lingering `review` tasks.** Tasks land in `review` (step 5) and only flip to `done` in step 6. If work was completed outside this loop (a prior session, a manual/live verify), tasks can sit stuck in `review` — and `next_task` will NOT return them, so re-running `/sf:phase` does nothing for them. After the regression sweep below passes, **confirm with the user** then `set_task_status --status=done` for every `review` task whose behavior the regression covers (decision stays the user's — parallels bug/change close-out; never auto-close silently). `status-report` flags this state ("N task(s) in review — reconcile").

1. **Regression sweep** — pass `--json` so the runner emits a machine-readable result line for `verify-collect`, and capture it:
   ```
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag regression --json | tee .spec-flow/specs/<feature>/regression-results.txt
   ```

2. **Collect results into VERIFICATION.md**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect --results .spec-flow/specs/<feature>/regression-results.txt
   ```
   `verify-collect` reads the runner's final `{passed,failed}` JSON line (it errors `NO_JSON_RESULTS` if you forgot `--json`). Append `truths[]` to `VERIFICATION.md must_haves.truths`. `VERIFICATION.md status: passed` only when zero regression failures.

   **Live gaps — make them first-class.** If anything shipped on `verified-adhoc` / could NOT be machine-verified (event-driven delivery, cross-service flow, a `[live-e2e]` TC), list each under a `## Not verified live` heading in `VERIFICATION.md`, one `- ` bullet per gap. `status-report` reads these and `/sf:status` shows "N live gap(s)" so they are not forgotten at merge. Do NOT bury them in prose.

3. **Final state sync**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
     --feature <feature> --note "phase complete — regression passed"
   ```

4. **Ship** — **HARD GUARD first (G3):** do NOT ship unless `VERIFICATION.md` reads `status: passed` (or `verified-adhoc` for an out-of-loop live verify). If it is `failed` or missing, STOP — go back to the regression sweep; shipping unverified defeats the whole gate. Once passed: stage the change, then invoke the bundled **commit** skill in `push` mode (`skills/commit`). It generates the conventional-commit message, commits on the current `feat/<feature>` branch (created earlier by `/sf:ingest` via `branch-ensure`; it refuses to commit on the base branch when `branching.mode != off`), pushes, and surfaces the MR/PR link (GitLab merge-request URL / GitHub compare URL or `gh pr create`). Report the link back to the user.
   - **Tag the shipped feature (G2):** after the PR is up, create a lightweight, annotated git tag marking the shippable point — `git tag -a <feature>-v<n> -m "<feature> shipped"` then `git push --tags`. This is spec-flow's lightweight replacement for milestone archival: the tag is a durable, greppable record that this SD reached a verified ship, independent of branch/PR lifecycle. Skip only if the project opts out (`branching.mode: off`).
   - **Multi-repo:** `branch-ensure` already created `feat/<feature>` in EVERY `config.repos` service. Run the commit skill **once per repo that has staged changes** (`cd` into each), producing one PR per service, and tag each repo. Report all PR links + tags together so reviewers see the full cross-service change set.

## Pipeline recap
```
parse-prd → use-tag → route --sd → next_task → hybrid-executor → update-task --append → set_status(review)
  → verify-code (skipped=no-op if unconfigured) → PRIME → run-checklist smoke (deferrable if no surface) → state-update (per task)
  → run-checklist regression → verify-collect → VERIFICATION.md → state-update (phase)
```
