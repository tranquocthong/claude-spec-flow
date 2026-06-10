---
description: "Decompose an epic-scale feature into sub-feature SDs linked via trace"
argument-hint: "<path/to/srs.md | feature>"
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:split — epic decomposition flow

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each step so the flow survives long sessions.

Input: `$ARGUMENTS` (SRS file path or feature name for an already-ingested epic).

**Key rule:** The agent PROPOSES the grouping; the human APPROVES it. The split is never committed silently or automatically. This is a design decision.

---

## STEP 1 — ASSESS epic scale

Run sd-skeleton (or read an existing harvest if already run):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs sd-skeleton \
  --srs <srs-path> --dry-run
```

Check `data.stats.epicScale` in the result.

- If `epicScale: false` (≤25 FRs AND ≤800 lines): tell the user the feature is **not epic-scale** — a split is not needed and would add unnecessary overhead. Stop here and suggest running `/sf:ingest` directly.
- If `epicScale: true`: continue to STEP 2.

---

## STEP 2 — PROPOSE a grouping (sd-author)

Spawn **sd-author** with the full SRS and the following instruction:

> "Read the SRS in full. Do NOT produce the SD yet. Instead, PROPOSE a decomposition into cohesive sub-features:
>
> - Group by User Story range, SRS section, or bounded-context (functional cohesion, minimal cross-sub-feature coupling).
> - Give each sub-feature a short name and list the FR/US range it covers.
> - Present the proposal as a numbered list with: sub-feature name, FR/US scope, one-sentence rationale.
> - Aim for 2–5 sub-features; avoid over-splitting.
>
> This is a PROPOSAL only — do not write any SD files."

Present sd-author's grouping proposal to the user clearly.

---

## STEP 3 — GATE: human approves the grouping

**Do NOT proceed past this point without explicit user approval.**

Ask the user:

> "Here is the proposed decomposition. Please review the sub-feature grouping:
>
> <sd-author proposal>
>
> Options:
> 1. Approve as-is — proceed with this grouping.
> 2. Adjust — provide your preferred grouping (names + FR/US scope).
> 3. Cancel — abort the split (you can run /sf:ingest instead for section-by-section authoring).
>
> Reply with your choice."

Wait for explicit approval or adjustment before continuing. This is a design decision that belongs to the team.

---

## STEP 4 — Register the epic

Once the user approves a grouping, register it:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs epic-new \
  --name "<epic-name>" \
  --subs "<approved sub-feature names comma-separated>"
```

Confirm the result: `ok({ epic, path, subs })`. The epic record is written to `.spec-flow/epics/<slug>.md`.

---

## STEP 5 — Generate per-sub-feature SDs

For EACH approved sub-feature (run sequentially — each may be large):

**5a. Spawn sd-author for that sub-feature's scope only:**

Spawn **sd-author** with:
- Full SRS file path
- Instruction: `"Produce the SD for ONLY the sub-feature '<sub-name>', covering FRs/US in scope: <scope>. Do not include requirements or design for the other sub-features. Output to .spec-flow/specs/<epic-slug>-<sub-slug>/SD.md."`
- Output path: `.spec-flow/specs/<epic-slug>-<sub-slug>/SD.md`

**5b. Build traceability for that sub-feature:**

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build \
  --sd .spec-flow/specs/<epic-slug>-<sub-slug>/SD.md \
  --feature <epic-slug>-<sub-slug>
```

**5c. Snapshot the SRS (once, shared across all sub-features):**

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs srs-snapshot --srs <srs-path>
```

(Only needed once — skip if already snapshotted.)

---

## STEP 6 — Update state + report

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
  --feature <epic-slug> \
  --note "epic split complete: <N> sub-features"
```

Report to the user:

- Epic record: `.spec-flow/epics/<slug>.md`
- Sub-feature SD paths (one per sub-feature)
- Trace files built (one per sub-feature)
- Next steps (see below)

---

## Next steps after split

Each sub-feature then runs the **normal pipeline independently**:

```
/sf:checklist <sub-feature>   → CHECKLIST.yaml for that sub-feature
/sf:phase <sub-feature>       → adaptive implement loop for that sub-feature
```

When the SRS changes later, `/sf:resync` uses `trace-impact` to identify which sub-feature(s) are affected — only those sub-features need to be re-synced. This is the blast-radius reduction the split achieves.

---

## Pipeline recap

```
/sf:split <srs-or-feature>
     │
     ▼
STEP 1  ASSESS      sd-skeleton --dry-run → epicScale?
     │              no → tell user split not needed, stop
     ▼              yes → continue
STEP 2  PROPOSE     sd-author → grouping proposal (names + FR/US scope)
     │
     ▼
STEP 3  GATE        present proposal → wait for human APPROVE / ADJUST / CANCEL
     │              (never auto-commit the split — this is a design decision)
     ▼
STEP 4  REGISTER    epic-new --name <epic> --subs "<approved subs>"
     │
     ▼
STEP 5  SUB-SDs     for each sub-feature:
     │                sd-author (scoped: ONLY this sub's FRs/US) → .spec-flow/specs/<epic>-<sub>/SD.md
     │                trace-build --sd .spec-flow/specs/<epic>-<sub>/SD.md
     ▼
STEP 6  STATE       state-update + report epic + sub-SD paths

Each sub-feature then: /sf:checklist → /sf:phase → ... (independent pipeline)
/sf:resync later: trace-impact scopes to affected sub-feature(s) only
```
