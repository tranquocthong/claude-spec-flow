---
description: Adaptive implement loop. Routes each task by complexity (fast / expand / deep), drives next_task -> implement -> manual-test -> done with state tracking.
argument-hint: [feature] [--task <id>]
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:phase — adaptive implement loop

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each task so the flow survives long sessions.

> **Checkpoint rule:** if you are mid-task and notice context is running deep (many tool calls, long session) or you must stop before finishing — run `/sf:checkpoint` before stopping. The next agent reads `.spec-flow/specs/<feature>/checkpoint.md` on resume. Clear it automatically in step 6 (`checkpoint-clear`). User can also trigger manually: `/sf:checkpoint`.

> **HARD RULE — "done" means synced disk, NOT a prose claim.** `/sf:status` derives everything from disk (TM task statuses, STATE.md, VERIFICATION.md). Anything you don't write back is LOST next session — the user will open `/sf:status` and see "not implemented" even though you finished. So you may NOT tell the user a task/feature is done unless, on disk: (1) its TM task is `done` (not left in `review`), (2) `state-update` has run (STATE.md current), and (3) at phase end VERIFICATION reflects the result. **If you verified out-of-loop (ad-hoc / live E2E instead of `run-checklist`), you STILL MUST do (1)–(3) before reporting done** — confirming it works ≠ recording that it's done. A prose "done" with stale state is the failure mode this rule exists to stop.

> **Task Master — CLI for AI ops, MCP for state ops.** Any AI-calling op (`parse-prd`,
> `analyze-complexity`, `expand`, `research`, `update`/`update-subtask`) MUST run via the **CLI** so it
> reads `.taskmaster/config.json` fresh and uses the keyless `claude-code` provider:
> `npx -y -p task-master-ai@0.43.1 task-master <cmd> …`. The long-running MCP server caches the
> provider from startup and fails AI ops with a stale `PERPLEXITY_API_KEY`/`ANTHROPIC_API_KEY` error.
> State ops (`next_task`, `set_task_status`, `get_tasks`, `add_task`) call no provider → keep the
> `mcp__task-master-ai__*` tools. **Fallback:** if any MCP TM call errors with a missing API key, re-run it as the CLI equivalent.

> **Per-feature tag — task isolation.** EVERY TM op in this flow operates on tag `<feature>` (the feature slug): add `--tag <feature>` to CLI ops, `tag: "<feature>"` to MCP ops. This keeps each feature in its own task space, so a prior feature's (or bug/change's) tasks never collide with or block the next — the same per-feature rule as file-links. `parse-prd --tag <feature>` creates the tag; state ops are lenient (a not-yet-seeded tag just returns empty, no error).

> **Multi-repo — one SRS/SD, code in sibling service repos.** Read `config.repos` from `.spec-flow/config.json` (e.g. `{ "auth-svc": "../auth-svc", "billing-svc": "../billing-svc" }`). When set, the planning `.spec-flow/` lives in THIS repo (the hub) but each task's code lives in a sibling repo. The SD labels every component/FR by service (e.g. "(auth-svc)", "(billing-svc)") — use that to pick the target repo. For each task: **`cd` into `config.repos[<service>]` to implement + build/test there**, then record the change with **`trace-link --repo <service> --files ...`** so the path is stored repo-qualified (`auth-svc/src/...`). `verify-code` scopes to the repos THIS feature touched when you pass `--feature <feature>` (it reads the repo prefixes from `file-links.json`) — always pass it so an unrelated repo's red WIP can't fail this feature's gate; `branch-ensure` defaults to all `config.repos` but accepts `--repos "a,b"` to scope branching to the services this feature targets. You do not call them per repo. Absent `config.repos` → single-repo (everything in cwd), nothing changes.

## Preconditions (hard gates)
- SD approved (0 `TODO:MANUAL-REVIEW`) — **the primary human gate**. After it, the agent runs every CLI step itself; the user never runs one. (A second, lightweight review pause may follow Step 0 — see Step 0.5 — but the user still runs nothing, only eyeballs the seeded task list.)
- `CHECKLIST.yaml` exists (run `/sf:checklist` if not).

Tasks need **not** be pre-seeded — **Step 0 seeds them.** "Approve the SD" is all the user does; seeding + implementation are the agent's job.

## Step 0 — Seed tasks if not already seeded

> **FIRST detect seeded-state DETERMINISTICALLY — never re-seed an already-seeded feature.** This is the #1 resume trap: you seed tasks, exit, open a new session, run `/sf:phase` again, and it re-runs `parse-prd` from scratch. Root cause: do **NOT** decide this with MCP `mcp__task-master-ai__get_tasks` — it binds to the global `currentTag` (see the CRITICAL note below) and may ignore the per-call `tag:`, so in a **fresh session** (currentTag still `master`/a prior feature) it returns the wrong tag's tasks → you wrongly conclude "not seeded" → destructively re-`parse-prd`. Use the engine's tag-scoped count instead:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs status-report --feature <feature>
```

If `/sf:phase` was invoked with **no feature arg** (common on a fresh session), run `status-report` with no `--feature` first — it resolves the active feature (from the trace mirror, else the latest SD in `specs/`) and returns that feature's tag-scoped task counts in the same call; use the resolved `feature` for everything below. This reads `.taskmaster/tasks/tasks.json` scoped to **this feature's tag** (currentTag-immune). In the returned JSON:
- **`tasks` non-null / total > 0 → ALREADY SEEDED.** Do **NOT** run `parse-prd`. Run `use-tag <feature>` (so MCP state ops bind to the right tag), then go straight to **Step 0.5 / Routing**. (`nextStep` will read "`/sf:phase` — N pending · M wip …".)
- **`tasks` null / total 0 → NOT seeded.** Seed now (below). (`nextStep` will read "it seeds tasks (parse-prd) then implements.")

When not seeded, **the agent seeds them itself** (do NOT hand this to the user) — CLI AI ops, same as every other AI op in this flow; the keyless `claude-code` provider reaches the Claude binary via `CLAUDE_CODE_EXECPATH` (set by the host), so `which claude` printing nothing does not block it. Before each AI op, run `taskmaster-model-plan --role <role>` and read the returned JSON yourself — no need to re-parse it. If `needsChange: false`, run the AI op directly. If `needsChange: true`, substitute `configured`/`previous` as literal values into one combined shell block (set → op → `trap` restore, kept in one Bash call so the `trap` stays active for the AI op):

`parse-prd` (role `main`):
```bash
npx -y -p task-master-ai@0.43.1 task-master models --set-main "<configured>" --claude-code
trap "npx -y -p task-master-ai@0.43.1 task-master models --set-main '<previous>' --claude-code" EXIT
npx -y -p task-master-ai@0.43.1 task-master parse-prd --input .spec-flow/specs/<feature>/SD.md --tag <feature>
```

`analyze-complexity` (role `research`):
```bash
npx -y -p task-master-ai@0.43.1 task-master models --set-research "<configured>" --claude-code
trap "npx -y -p task-master-ai@0.43.1 task-master models --set-research '<previous>' --claude-code" EXIT
npx -y -p task-master-ai@0.43.1 task-master analyze-complexity --tag <feature> --research
```

Then run the state op (no model involved) separately:
```
npx -y -p task-master-ai@0.43.1 task-master use-tag <feature>
```

Use a **per-feature `--tag`** so this feature's tasks stay isolated. Only if the CLI genuinely errors on a missing provider/key do you ask the user to run these in their terminal.

> **Preflight — Task Master model/provider sanity check.** Run once, right after `use-tag`, before any per-task AI-op:
> ```
> node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs taskmaster-model-check
> ```
> This is a zero-cost static check: for each role (`main`/`research`/`fallback`) it confirms a keyed provider (`anthropic`, `perplexity`, ...) actually has its required key in env/`.env`. `claude-code`/`ollama` never need a key. If `problems` is non-empty, **do not silently proceed** — surface each problem to the user once, and fix the role before starting the loop (either `task-master models --set-<role> sonnet --claude-code`, the keyless default `/sf:init` seeds, or add the missing key). Skipping this lets a broken role (e.g. `fallback` pointed at `anthropic` with no `ANTHROPIC_API_KEY`) sit invisible until the exact moment `main` fails mid-phase and the fallback chain has nothing to fall back to — which then burns the per-task loop's time on failed retries instead of doing work. `checked: false` (no `.taskmaster/config.json` yet) → nothing to check, proceed.

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
- **4-7 → expand**: AI op (CLI, not MCP) — apply the `taskmaster-model-plan` override (role `main`) before running: read the JSON from `taskmaster-model-plan --role main`; if `needsChange: true`, substitute `configured`/`previous` as literal values below (else run the AI op directly):
  ```bash
  npx -y -p task-master-ai@0.43.1 task-master models --set-main "<configured>" --claude-code
  trap "npx -y -p task-master-ai@0.43.1 task-master models --set-main '<previous>' --claude-code" EXIT
  npx -y -p task-master-ai@0.43.1 task-master expand --id=<id>
  ```
  Then run each subtask as fast.
- **8-10 → deep**: if the task touches an external integration, run the research AI op first (pass the SD §14 risk row as context) with the override (role `research`) — read the JSON from `taskmaster-model-plan --role research`; if `needsChange: true`, substitute `configured`/`previous` as literal values below (else run the AI op directly):
  ```bash
  npx -y -p task-master-ai@0.43.1 task-master models --set-research "<configured>" --claude-code
  trap "npx -y -p task-master-ai@0.43.1 task-master models --set-research '<previous>' --claude-code" EXIT
  npx -y -p task-master-ai@0.43.1 task-master research "<query>"
  ```
  Then spawn **hybrid-executor** with extra planning notes.

## Per-task loop

0. **Pick up `review` tasks FIRST (no dead-end).** Before `next_task`, check for tasks stuck in `review` (`get_tasks` `status=review`, `tag: "<feature>"`). A task lands in `review` two ways: (a) smoke **failed** (step 5 halted it), or (b) it was implemented but never closed. `next_task` does **not** return `review` tasks, so left alone they are a silent dead-end. For each `review` task: re-run its smoke suite (step 5). **Passed** → close it (step 6). **Failed** → re-attempt: set it back to `in-progress`, re-spawn the executor with the FAIL output as context, fix, re-verify. If the same task fails smoke **twice in a row**, STOP and ask the user (it likely needs a spec change → `/sf:change`, or a bug fix → `/sf:bug`) — do not loop forever. Only when no `review` task remains, proceed to step 1.

1. **Next task(s) — check for parallelizable work first**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs wave-plan --feature <feature>
   ```
   This returns `ready`: the tasks whose dependencies are all `done` (the workable set) — it does **not** prove file-disjointness (files touched aren't known until a task is actually implemented, so the tool has nothing to compare yet). If `ready` has ≥2 tasks, **you** judge disjointness from each task's `title`/`details` (get the full text via `mcp__task-master-ai__get_task`): different component/layer/file mentioned, no shared entity → likely safe to batch. Same file, same class, one obviously extends the other → keep sequential. When in doubt, sequential — a wrong parallel guess risks two executors clobbering the same file with no worktree isolation here.
   **If you judge ≥2 ready tasks file-disjoint, spawn one `hybrid-executor` per task in the SAME message** (multiple Agent tool calls in one turn — see step 2) instead of taking them one at a time. Otherwise fall back to:
   ```
   mcp__task-master-ai__next_task   # tag: "<feature>"  (see per-feature tag rule above — applies to every TM op below)
   ```

2. **Spawn hybrid-executor** (one per task selected in step 1 — in parallel when step 1 found a file-disjoint batch, in a single call otherwise) with: task details + `CONTEXT.md` + relevant SD section refs (from `.spec-flow/trace.json` FR→TC links). Note that **code stays English even when `config.language` ≠ `en`** (that setting is for conversation + docs only). **Model:** read `config.json → models.hybridExecutor`; if set to a non-null value, pass it as the Agent tool's `model` param (overrides the agent's packaged `sonnet` default). If absent/`null`, omit the param — the agent falls back to its own frontmatter.

   **When a batch ran in parallel:** steps 3-6 below still run once per task, in any order — this is safe only because you already judged the batch file-disjoint in step 1 (no two tasks touch the same file, so their `trace-link`/`verify-code`/`set_task_status` calls cannot clobber each other). Do not parallelize `trace-build` itself (it rebuilds the whole trace file) — run it once after all tasks in the batch have logged their `trace-link`.

   After it returns, **check TDD evidence in its summary before proceeding**:
   - For a feature task: the summary must mention a test file written and either `gate: "red-confirmed"` (testCommand ran and confirmed RED) or an explicit note that testCommand is not configured. If neither appears, ask the executor to show the RED confirmation before treating the task as implemented.
   - For a chore task: "chore — RED phase skipped" is the expected note. Accept it.

3. **Code + log**

   `update-task --append` (role `main`) — read the JSON from `taskmaster-model-plan --role main`; if `needsChange: true`, substitute `configured`/`previous` as literal values below and run as one combined shell command so the `trap` stays active (else run the AI op directly):
   ```bash
   npx -y -p task-master-ai@0.43.1 task-master models --set-main "<configured>" --claude-code
   trap "npx -y -p task-master-ai@0.43.1 task-master models --set-main '<previous>' --claude-code" EXIT
   npx -y -p task-master-ai@0.43.1 task-master update-task --id=<id> --append --prompt="<files/approach/result>"
   ```

   Then, separately (state op — no model involved, do NOT fold into the bash block above):
   ```
   mcp__task-master-ai__set_task_status --id=<id> --status=review
   ```
   Use **`update-task --append`** (logs onto the task itself), NOT `update-subtask --id=<id>`: `update-subtask` requires a `parent.sub` id and fails for any task that was not expanded into subtasks (the common solo/fast-path case — "requires parentId.subtaskId"). `--append` works for both expanded and un-expanded tasks.
   **Cost note:** `update-task --append` is an AI op (one CLI call per task — slow over many tasks). It is **optional human-readable history**, not the source of truth: the deterministic record is `trace-link` (files touched — a zero-AI state op) + `state-update` + the TM status. If per-task AI latency is a problem, **batch one note at task close** or skip it; do NOT skip `trace-link`/`set_task_status` (those are the disk facts `/sf:status` reads).
   **Non-blocking on failure.** This is an AI-op subprocess (provider outage, a misconfigured role the preflight missed, a transient CLI crash) — it can fail for reasons that have nothing to do with the task's actual code. If it errors or exits non-zero: do **not** retry it in a loop and do **not** halt the per-task loop over it. Surface the failure once, then proceed straight to `trace-link` + `set_task_status` below — those are the disk facts that matter; the append is nice-to-have history. Fix the underlying provider config (re-run `taskmaster-model-check`) at your convenience, not mid-loop.
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
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code --feature <feature> --task <id>
   ```
   **Always pass `--task <id>`.** It scopes the `tests` check to just this task's own test file(s) (via `trace-link` recorded in step 3) instead of the full suite — java-spring/java-maven derive a `--tests`/`-Dtest=` filter automatically; other stacks need `config.verify.taskTestCommand` (a template with a `{files}` placeholder) or fall back to the full suite (never breaks — check `testsScoped`/`scopeNoteTests` in the result to see which happened). This is the main lever for phase speed on a multi-task SD: the full suite no longer runs N times, it runs once (see Phase close-out step 1a). Forbidden-patterns/secret-scan/coverage are unaffected — those already scan the whole scoped repo root regardless of `--task`.
   **Multi-repo: ALWAYS also pass `--feature`** (or `--repos "a,b"`). It scopes the scan to the repos this feature actually wrote to (read from `file-links.json`), so an unrelated repo sitting on a red WIP branch can't poison this feature's gate. Single-repo → `--feature` is harmless (one root). The result includes `scope` (what it narrowed to) and `repos` (what ran).
   Parse returned JSON:
   - `gate: "fail"` → `set_task_status` → `review`; surface `detail` and `fix`; **halt**. A failure here caught by the SCOPED test still means this task's own test is red — treat it exactly as before.
   - `gate: "pass"` → at least one real check ran and none failed → proceed to step 5. Remember: with scoping active, "pass" confirms THIS task's test(s) and static checks, not that nothing else in the codebase broke — that's what the full-suite run at phase close-out is for.
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
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs checkpoint-clear --feature <feature>
   ```
   The `checkpoint-clear` is a no-op if no checkpoint exists — always safe to run.

6b. **Semantic drift-check (advisory, before next_task)**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs drift-check --feature <feature>
   ```
   Layer-2 SD-mismatch defense: diffs the **actual** error codes in your `update-task` logs (step 3) against the SD §12.2 codes (via trace). Parse `data.drift`:
   - `spec-not-evidenced` → an SD §12.2 code with no mention in any task log: confirm it's implemented, or that you logged the actual code (step 3 must record real error codes). Don't silently leave a spec'd error unbuilt.
   - `impl-not-specced` → a code in the logs the SD doesn't document: **update SD §12.2** (or fix the code to the spec'd one) — the SD is the source of truth.
   Advisory, never blocks. `clean: true` (or a "no logs yet" note) → nothing to surface. This is why step 3 logging the **real** error codes matters — it's the signal drift-check reads.

7. **Repeat** until no pending tasks remain.

## Phase close-out

0. **Reconcile lingering `review` tasks.** Tasks land in `review` (step 5) and only flip to `done` in step 6. If work was completed outside this loop (a prior session, a manual/live verify), tasks can sit stuck in `review` — and `next_task` will NOT return them, so re-running `/sf:phase` does nothing for them. After the regression sweep below passes, **confirm with the user** then `set_task_status --status=done` for every `review` task whose behavior the regression covers (decision stays the user's — parallels bug/change close-out; never auto-close silently). `status-report` flags this state ("N task(s) in review — reconcile").

1a. **Full unit-test suite — once.** Per-task step 4 scoped `verify-code` to each task's own test(s) (speed), which means the full suite hasn't run since task 1. Run it now, unscoped, to catch any cross-task regression before the checklist sweep:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-code --feature <feature>
   ```
   (no `--task` → full `testCommand`, exactly like the pre-scoping gate). `gate: "fail"` here is a **cross-task regression** — something task N broke that its own scoped test didn't cover. Fix it, re-run this step, then continue; don't skip ahead to the checklist sweep on a failing full suite.

1b. **Regression sweep (checklist)** — pass `--json` so the runner emits a machine-readable result line for `verify-collect`, and capture it:
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
   - **Multi-repo:** `branch-ensure` already created `feat/<feature>` in the targeted `config.repos` services (all of them, or the `--repos` subset if scoped). Run the commit skill **once per repo that has staged changes** (`cd` into each), producing one PR per service, and tag each repo. Report all PR links + tags together so reviewers see the full cross-service change set.

## Pipeline recap
```
parse-prd → use-tag → taskmaster-model-check → route --sd → wave-plan → [next_task | parallel batch]
  → hybrid-executor (RED via verify-code --files, scoped) → update-task --append (non-blocking) → set_status(review)
  → verify-code --task <id> (scoped; skipped=no-op if unconfigured) → PRIME → run-checklist smoke (deferrable if no surface) → state-update (per task)
  → verify-code (full suite, once) → run-checklist regression → verify-collect → VERIFICATION.md → state-update (phase)
```
