---
description: Ingest an approved SRS into a Solution Design (SD) draft + CONTEXT.md + tasks seed + traceability. Replaces manual "convert SRS to SD" prompting. No file / just an idea? Bare invocation interviews you and writes the SRS first (AI-elicited input beats hand-typed prose).
argument-hint: "[<path/to/srs.md> | --idea \"<seed>\"] [--type api|internal|hybrid|auto]"
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:ingest — SRS → SD (one-way bootstrap)

> **Re-anchor:** the flow's position lives in `.spec-flow/STATE.md` (see its **Next Step**). Run `state-update` after each step so the flow survives long sessions.

> 🛑 **HARD GATE — `/sf:ingest` produces a SPEC, NEVER code.** Your only outputs are `.spec-flow/srs/<feature>.md` (Mode 0) and the SD + `trace.json` from the Steps. **Do NOT write or edit application code, do NOT run builds, do NOT implement anything** — not even if the interview made the solution obvious, not even if another loaded skill (e.g. a build/TDD skill) pushes you to implement. ingest **ENDS at STEP 8** (the SD review gate): report the SD and **STOP**, hand back to the user. Implementation happens later and ONLY via `/sf:phase`, after a human approves the SD. **If you are about to edit any file outside `.spec-flow/`, STOP — you have left the flow.** Discussing the feature in Mode 0 is NOT permission to build it.

Input: `$ARGUMENTS` (SRS file path + optional `--type`). Recommended home for the input: `.spec-flow/srs/<feature>.md` (a formal SRS *or* just your idea/description — it plays the SRS role; created by `/sf:init`). Any path works; `srs/` is convention. When requirements change later, edit that same file and run `/sf:resync` on it.
Output: SD draft ready for leader review + scaffolding for the rest of the workflow.

## Mode 0 — no input file? Interview to author the SRS first

If `$ARGUMENTS` carries **no file path** (bare `/sf:ingest`, or `--idea "<seed>"`), do **not** tell the user to go write a doc — **interview them and write it yourself**. AI elicitation produces better-structured input than hand-typed prose, and it still lands in the same place (`srs/<feature>.md`) so the rest of the flow is unchanged.

1. Pick/confirm a `<feature>` slug (kebab-case).
2. Ask in 1–2 compact rounds (skip anything already clear from the `--idea` seed):
   - **What & why** — what it does, the problem it solves
   - **Actor** — who / what system calls it
   - **Trigger** — API endpoint? event? screen/action?
   - **Behaviors** — the happy path as concrete steps → become **FRs**
   - **Rules / errors** — validations, edge + failure cases, limits → become **TCs + §12.2 error codes**
   - **Data** — entities/fields touched (feeds §6/§7)
   - **Out of scope** — explicit non-goals
   - **Done when** — acceptance criteria → become **TCs**
   - **NFR** — perf / security / etc., only if relevant
3. Write `.spec-flow/srs/<feature>.md` in that structure (it plays the SRS role).
4. **Show it and get the user's confirmation** — this is their first control point; edit until approved. (You are writing a SPEC file here — still no code.)
5. Run the **Steps below** with `path = .spec-flow/srs/<feature>.md` → produces the SD + trace, then **STOP at the STEP 8 gate**. The interview does NOT flow into implementation — coding is `/sf:phase`, later, after SD approval.

With a file path given, skip Mode 0 and go straight to the Steps.

> **Resume (interrupted ingest).** Re-running on a feature that already has artifacts = a RESUME, not a restart: **skip every step whose output already exists.** Do NOT re-run `srs-snapshot` (it would add a dup baseline) and do NOT re-run `sd-skeleton` on an existing SD — the engine **refuses to overwrite an existing SD without `--force`** (that protects sd-author's / your cleaned SD). Continue from the first **missing** artifact: SD still has TODOs → re-spawn **sd-author**; no `trace.json` → `trace-build`; trace exists → the STEP 8 gate. `/sf:status` reads the disk and tells you the exact missing step.

## Steps

1. **Bootstrap state**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs init
   ```
   Confirm `.spec-flow/` directories exist; read `config.json` (mode, smokeTag, regressionTag).

2. **Snapshot SRS** (baseline for future `/sf:resync` diffs)
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs srs-snapshot --srs <path>
   ```
   Writes `.spec-flow/snapshots/<feature>-001.md`. Required before any `srs-diff` call.

   Then create the work branch (per `config.json → branching`):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs branch-ensure --kind sd --name <feature>
   ```
   Creates/switches `feat/<feature>` when on the base branch (no-op if already on a work branch or `mode: off`). Keeps the whole SD → implement → ship lifecycle on one branch. **Multi-repo (`config.repos` set):** by default this branches **every** configured service repo. If this feature only targets a subset (the common case — the SD labels components by service), scope it: append **`--repos "auth-svc,billing-svc"`** (comma-separated repo names) so unrelated services don't get stray `feat/<feature>` branches. An unconfigured name errors (`REPO_NOT_CONFIGURED`) instead of misbranching.

3. **Pass-1 — deterministic harvest**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs sd-skeleton \
     --srs <path> --type <type|auto> --out .spec-flow/specs/<feature>/SD.md
   ```
   Fills revision history, glossary, §5.1 FR (MoSCoW from AC), §5.2 NFR, §12.2 error codes, §13.2 TC. Marks AI-needed sections `TODO:MANUAL-REVIEW`. Intentionally dirty — sd-author (Pass-2) is the intelligence layer.

   Check `data.warnings` in the result: if `epicScale: true`, surface the warning to the user and note the two options — (a) split into sub-feature SDs (each its own SD, linked via trace.json), or (b) have sd-author author section-by-section.

4. **Pass-2 — spawn sd-author**
   First read `config.language` (default `en`):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs status-report   # or grep "language" .spec-flow/config.json
   ```
   Spawn **sd-author** with: SRS path + SD draft from step 3 + `CONTEXT.md` (if present) + `--type` **+ an explicit first line of the spawn prompt: `Author all SD/CONTEXT prose in language: <config.language>` (e.g. `vi`).** Pass this even though sd-author also reads `config.json` — surfacing it explicitly is what makes the language actually take effect (a buried rule the sub-agent may skip is not enough). If `config.language` is `en`, no directive needed. **Model:** read `config.json → models.sdAuthor`; if set to a non-null value, pass it as the Agent tool's `model` param. If absent/`null` (the default), omit the param — sd-author inherits the main session's model.

   sd-author will:
   - Merge fragmented/list-intro FR rows into atomic requirements; drop non-requirements.
   - Derive TC rows from BL failure rules + corresponding §12.2 error codes.
   - Fill §6 Architecture, §9.4/§10.8 Sequence Diagrams, §10.4 State Management.
   - Leave `TODO:MANUAL-REVIEW` only where genuinely ambiguous.

5. **Write CONTEXT.md**
   Extract locked decisions from SRS §4 AC + §5.1 User Journey. Feeds all downstream agents.

6. **Build traceability index**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build \
     --sd .spec-flow/specs/<feature>/SD.md --feature <feature>
   ```
   Writes `.spec-flow/trace.json`: nodes (FR, TC, errors, states) + links (fr-tc, src-fr, fr-task). **Check `data.warnings`** — if `conventions.errorCodePattern` is set and any §12.2 code violates it, the warning lists the offending codes; surface it and fix the SD codes to the project's standard before the gate.

   **Multi-repo (`config.repos` set) — declare which repos this feature targets.** The SD labels every component/FR by service ("(auth-svc)", "(billing-svc)"). Collect the distinct services and record them as the feature's repo scope:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-repos --feature <feature> --set "auth-svc,billing-svc"
   ```
   This is the single source of truth read by both `branch-ensure` (so a later re-branch / `/sf:bug` / `/sf:change` scopes automatically, no `--repos` flag needed) and `verify-code` (declared intent scopes the gate above file-links). Skip on single-repo projects. If you scoped the early STEP 2 branch with `--repos`, declare the same set here so it persists.

7. **Update state**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
     --feature <feature> --note "srs-ingest complete"
   ```

8. **Gate — SD approval is the human control point; do NOT seed tasks yet**
   Count remaining `TODO:MANUAL-REVIEW` markers. Report: SD path, design type, section coverage (FR count, TC count, unresolved TODOs), and the full list of each TODO location and reason. **Refuse to call `parse_prd` while any `TODO:MANUAL-REVIEW` remains.** Then **STOP and hand back to the human** to review + get leader approval — this is the one gate that is theirs.

   **After the human approves, the rest is the AGENT's job — not a list of CLI chores for the user.** When you run `/sf:checklist` (scaffolds `CHECKLIST.yaml`) and then `/sf:phase`, the agent seeds tasks itself with a **per-feature `--tag`** (isolates this feature's tasks from any other feature/bug/change). Before each AI op, run `taskmaster-model-plan --role <role>` and read the returned JSON yourself — no need to re-parse it. If `needsChange: false`, run the AI op directly. If `needsChange: true`, substitute `configured`/`previous` as literal values into one combined shell block (set → op → `trap` restore, kept in one Bash call so the `trap` stays active for the AI op):

   `parse-prd` (role `main`):
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/task-master models --set-main "<configured>" --claude-code
   trap "node ${CLAUDE_PLUGIN_ROOT}/bin/task-master models --set-main '<previous>' --claude-code" EXIT
   node ${CLAUDE_PLUGIN_ROOT}/bin/task-master parse-prd --input .spec-flow/specs/<feature>/SD.md --tag <feature>
   ```

   `analyze-complexity` (role `research`):
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/task-master models --set-research "<configured>" --claude-code
   trap "node ${CLAUDE_PLUGIN_ROOT}/bin/task-master models --set-research '<previous>' --claude-code" EXIT
   node ${CLAUDE_PLUGIN_ROOT}/bin/task-master analyze-complexity --tag <feature> --research
   ```
   **The agent CAN run these** (same as every other CLI AI op in `/sf:phase`): the keyless `claude-code` provider reaches the Claude binary via `CLAUDE_CODE_EXECPATH` (set by the host), so `which claude` printing nothing on the Bash PATH does *not* mean it can't run. Use the **CLI** form above (reads `.taskmaster/config.json` fresh); the MCP `parse_prd` tool can fail on a stale-cached provider (see the Task Master note in `/sf:phase`). Only if the CLI genuinely errors on a missing provider/key do you ask the user to run it in their terminal.

   **Backfill ingest (the feature was implemented BEFORE this SD existed):** `parse-prd` seeds EVERYTHING as `pending` — including scope that already ships — so a later `/sf:phase` could re-implement working code. After the shipped scope has passed `/sf:manual-test` (VERIFICATION.md exists), run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs task-baseline --feature <feature>            # dry-run proposal
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs task-baseline --feature <feature> --apply    # after review
   ```
   It marks a task `done` ONLY when its full evidence set (TCs of the FRs it implements) is recorded `verified` in VERIFICATION.md — SD prose/status labels are never trusted. No VERIFICATION yet → it baselines nothing and points you to `/sf:manual-test`; the manual-test gate stays the only door to `done`.

## Output
- `.spec-flow/specs/<feature>/SD.md` (draft — Pass-1 harvest + Pass-2 clean)
- `CONTEXT.md` (locked decisions)
- `.spec-flow/trace.json` (FR/TC/error/state nodes + links)
- `.spec-flow/snapshots/<feature>-001.md` (SRS baseline)
- `.spec-flow/STATE.md` (position index)
- Summary: section coverage, unresolved `TODO:MANUAL-REVIEW` list, inferred design type.

## Pipeline recap
```
srs-snapshot → sd-skeleton (harvest) → sd-author (clean) → trace-build → trace-repos (multi-repo) → state-update
```
No `parse_prd` until SD has zero `TODO:MANUAL-REVIEW`.
