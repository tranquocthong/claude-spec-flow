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

## Preconditions (hard gates)
- SD approved (0 `TODO:MANUAL-REVIEW`) — **the primary human gate**. After it, the agent runs every CLI step itself; the user never runs one. (A second, lightweight review pause may follow Step 0 — see Step 0.5 — but the user still runs nothing, only eyeballs the seeded task list.)
- `CHECKLIST.yaml` exists (run `/sf:checklist` if not).

Tasks need **not** be pre-seeded — **Step 0 seeds them.** "Approve the SD" is all the user does; seeding + implementation are the agent's job.

## Step 0 — Seed tasks if not already seeded
Check the feature's task space first (state op, no provider): `mcp__task-master-ai__get_tasks` with `tag: "<feature>"`. If it already has tasks → skip to Routing. If empty, **the agent seeds them itself** (do NOT hand this to the user) — CLI AI ops, same as every other AI op in this flow; the keyless `claude-code` provider reaches the Claude binary via `CLAUDE_CODE_EXECPATH` (set by the host), so `which claude` printing nothing does not block it:
```
npx -y -p task-master-ai@0.43.1 task-master parse-prd --input .spec-flow/specs/<feature>/SD.md --tag <feature>
npx -y -p task-master-ai@0.43.1 task-master analyze-complexity --tag <feature> --research
```
Use a **per-feature `--tag`** so this feature's tasks stay isolated. Only if the CLI genuinely errors on a missing provider/key do you ask the user to run these two lines in their terminal.

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

1. **Next task**
   ```
   mcp__task-master-ai__next_task   # tag: "<feature>"  (see per-feature tag rule above — applies to every TM op below)
   ```

2. **Spawn hybrid-executor** with: task details + `CONTEXT.md` + relevant SD section refs (from `.spec-flow/trace.json` FR→TC links).

3. **Code + log**
   ```
   npx -y -p task-master-ai@0.43.1 task-master update-subtask --id=<id> --prompt="<files/approach/result>"   # AI op → CLI
   mcp__task-master-ai__set_task_status --id=<id> --status=review                                              # state op → MCP
   ```
   If executor did not call `trace-link`, run it from the executor's reported file list:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-link \
     --task <id> --feature <feature> [--fr <FR-id-if-known>] \
     --files "<comma-separated relative paths changed>"
   ```
   Then rebuild trace:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build --sd .spec-flow/specs/<feature>/SD.md
   ```

4. **Automated quality gate**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code [--feature <feature>]
   ```
   Parse returned JSON: `gate: "fail"` → `set_task_status` → `review`; surface `detail` and `fix`; **halt**.
   `gate: "pass"` (including all-skipped when unconfigured) → proceed to step 5.
   Generic and config-driven — Java teams configure gradle + forbidden patterns; a project with no verify block skips without blocking.

5. **Manual-test gate**
   ```
   scripts/api.sh PRIME --auto
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag smoke
   ```
   - exit 0 → proceed to step 6.
   - non-zero → `set_task_status` → `review`; surface FAIL lines; **halt**.

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

1. **Regression sweep**
   ```
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag regression
   ```

2. **Collect results into VERIFICATION.md**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect --results <runner-output.json>
   ```
   Append `truths[]` to `VERIFICATION.md must_haves.truths`. `VERIFICATION.md status: passed` only when zero regression failures.

3. **Final state sync**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
     --feature <feature> --note "phase complete — regression passed"
   ```

4. **Ship**: stage the change, then invoke the bundled **commit** skill in `push` mode (`skills/commit`). It generates the conventional-commit message, commits on the current `feat/<feature>` branch (created earlier by `/sf:ingest` via `branch-ensure`; it refuses to commit on the base branch when `branching.mode != off`), pushes, and surfaces the MR/PR link (GitLab merge-request URL / GitHub compare URL or `gh pr create`). Report the link back to the user.

## Pipeline recap
```
route --sd → next_task → hybrid-executor → update_subtask → set_status(review)
  → verify-code (skips if unconfigured) → PRIME → run-checklist smoke → state-update (per task)
  → run-checklist regression → verify-collect → VERIFICATION.md → state-update (phase)
```
