---
description: "Product changed the SRS (top-down): diff vs snapshot, propagate a delta to SD + tasks + checklist via the traceability matrix, re-open impacted tasks. No full regen. Bottom-up counterpart is /sf:change."
argument-hint: <path/to/srs_v2.md>
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:resync — propagate an SRS change (surgical, not regen)

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each step so the flow survives long sessions.

Input: `$ARGUMENTS` (new SRS file path). Change only what changed — the traceability matrix identifies exactly which SD sections, tasks, checklist tests, and files an SRS edit touches.

## Preconditions
- `.spec-flow/snapshots/` has at least one baseline (created by `/sf:ingest`).
- `.spec-flow/trace.json` exists (run `trace-build` if missing).

## Steps

1. **Diff SRS versions**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs srs-diff --new <srs_v2.md>
   ```
   Auto-resolves the latest snapshot (or `--old <snapshot.md>` for a specific version). Outputs CHANGESET `{ added, changed, removed }` keyed by SRS anchors (US, AC, NFR, BL, state). Treat as a hint for sd-author; SD remains the authoritative artifact.

2. **Resolve impact**
   Write the changeset JSON to a temp file, then:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-impact \
     --changeset <changeset.json>
   ```
   Returns `{ impacted: { fr, tc, errors, tasks }, reasons }`. Use `--ids "FR-007,TC-012"` or `--keywords "callback,timeout"` for ad-hoc changesets.

3. **Update SD delta only**
   - Re-run `sd-skeleton --srs <srs_v2.md> --force` (the `--force` is required — sd-skeleton refuses to overwrite an existing SD otherwise; resync deliberately re-derives the impacted deterministic sections: §5.1 FR, §12.2 errors, §13.2 TC rows for impacted IDs).
   - Spawn **sd-author** with: new SRS + current SD + impacted FR/TC IDs from step 2 + `CONTEXT.md`. sd-author re-derives only impacted reasoning sections; marks touched sections `TODO:MANUAL-REVIEW`.

4. **Gate — wait for review**
   Report SD delta diff + remaining `TODO:MANUAL-REVIEW` count. **Refuse to cascade tasks while any TODO marker remains.**

5. **Cascade tasks** (AI op → CLI, not MCP — MCP fails on a stale-cached provider)
   ```
   npx -y -p task-master-ai@0.43.1 task-master update --from=<lowest impacted task id> \
     --prompt="<changeset summary>"
   ```
   Only if the CLI genuinely errors on a missing provider/key do you ask the user to run it in their terminal.

6. **Re-open impacted done tasks**
   For each task ID in `impacted.tasks` with status `done`:
   ```
   mcp__task-master-ai__set_task_status --id=<id> --status=review
   ```

7. **Regenerate impacted checklist entries**
   Run `/sf:checklist` for the feature, preserving filled verify SQL for unaffected TCs. Re-scaffold only rows whose TC IDs appear in `impacted.tc`.

8. **New snapshot + rebuild trace**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs srs-snapshot --srs <srs_v2.md>
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build --sd .spec-flow/specs/<feature>/SD.md --feature <feature>
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update --feature <feature> \
     --note "srs-resync: <summary of changeset>"
   ```

Run `/sf:phase <feature>` to re-implement the `review` tasks → manual-test → `done`.

## Pipeline recap
```
srs-diff → trace-impact → SD delta via sd-author → CLI `task-master update --from` cascade
  → re-open impacted done tasks → regenerate impacted checklist
  → srs-snapshot (new baseline) → trace-build → state-update
```
