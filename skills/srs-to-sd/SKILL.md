---
name: srs-to-sd
description: >
  Convert an approved SRS into a Solution Design and drive the hybrid spec-flow.
  Use this skill when the user mentions an SRS, a Solution Design (SD), "convert SRS to SD",
  starting a feature from a spec, re-syncing after Product changed the SRS, or running a
  fix/enhance loop on an implemented feature. Routes to the right spec-flow command.
---

# spec-flow — SRS → SD → implement → verify → ship

Routes to the right command and enforces the gates.

## Route by intent

| User intent | Command |
| --- | --- |
| "convert this SRS to SD", start a feature from an SRS | `/sf:ingest <srs>` |
| have only an idea/description, no SRS file | `/sf:ingest` (no file) or `/sf:ingest --idea "<seed>"` — it interviews you, writes `srs/<feature>.md`, then ingests |
| generate manual-test checklist from the SD | `/sf:checklist <feature>` |
| implement the feature | `/sf:phase <feature>` |
| Product changed the SRS, propagate it | `/sf:resync <srs_v2>` |
| want to change the spec / enhance after impl | `/sf:change "<desc>" --type fix\|enhance` |

## Non-negotiable gates
0. **`/sf:ingest` NEVER implements** — ingest (incl. its interview mode) outputs only the SRS + SD + trace, then STOPS at the SD review gate. Discussing a feature is not permission to code it. Application code happens only in `/sf:phase`, after the SD is approved. If a build/TDD skill is also loaded, this gate wins for the ingest step.
1. **No tasks before approval** — never `parse_prd` while SD has `TODO:MANUAL-REVIEW` markers.
2. **CHECKLIST before BUILD** — every feature has a `CHECKLIST.yaml` before the first task is implemented.
3. **manual-test before done** — task goes `review → done` only after `run-checklist.sh` smoke passes; phase ships only when regression passes (`VERIFICATION.md status: passed`).
4. **SD is the source of truth** — change SD first, then let trace + `update --from` propagate. Never patch code without patching the SD.

## Dependencies
- **Bundled**: manual-test skill (`skills/manual-test/scripts/*`) and `bin/flow-tools.cjs`.
- **Auto-fetched at runtime**: Task Master MCP via `npx -y task-master-ai` (`.mcp.json`) — needs node + first-run network; uses the keyless `claude-code` provider by default (no API key).
