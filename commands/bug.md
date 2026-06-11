---
description: "Bug report / fix-bug flow. Routes a bug through REPRODUCE-FIRST → triage (code-bug | spec-bug | srs-level) → fix → regress. Code-bugs are fixed in code only; spec-bugs hand off to /sf:change; srs-level hands off to /sf:resync. SD-optional: works on brownfield / no-SD projects (no SD ⇒ always code-bug, the repro test is the contract)."
argument-hint: "\"<description>\" [--severity low|med|high|critical] [--repro \"<steps>\"] [--expected \"<>\"] [--actual \"<>\"] [--feature <f>]  |  --resume <id>"
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:bug — bug report / fix-bug flow

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each step so the flow survives long sessions.

Input: `$ARGUMENTS`. Severity defaults to `med` if omitted.

**One-line rule:** Code-bug → fix code only. Spec-bug → `/sf:change`. SRS-level → `/sf:resync`. **No SD (brownfield) → always code-bug** (no spec to be wrong — the repro test + expected/actual are the contract).

> **Resume an open bug — don't re-report it.** `/sf:bug --resume <id>` (the `id`, e.g. `bug-001`, comes straight from `/sf:status`, which lists open bugs). **Skip STEP 1 INTAKE** (do NOT run `bug-new` — that would create a duplicate `bug-002`); read the existing `.spec-flow/bugs/*-<id>-*.md` record and **continue from its current step**: Triage filled but no fix → STEP 4; fix logged but repro not green → STEP 5; green → STEP 6 (confirm + close). Never create a new record for an id that already exists.

---

## STEP 1 — INTAKE

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs bug-new \
  --desc    "$DESCRIPTION" \
  --severity "$SEVERITY" \
  --repro   "$REPRO" \
  --expected "$EXPECTED" \
  --actual  "$ACTUAL" \
  --feature "$FEATURE"
```

Returns `{ ok: true, data: { id, path, severity } }`. The file is `.spec-flow/bugs/<NNN>-bug-<slug>.md` (e.g. `001-bug-login-returns-500.md`); the `id` field inside stays `bug-NNN`. Confirm fields at the returned `path`.

Then create the fix branch (per `config.json → branching`):
```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs branch-ensure --kind bug --id <id> --slug "<short-desc>"
```
Creates/switches `fix/<id>-<slug>` when on the base branch (no-op if already on a work branch or `mode: off`). Use the bug `id` from the previous step and a short slug from `$DESCRIPTION`.

---

## STEP 2 — REPRO-FIRST (write the failing test BEFORE fixing)

Using the **manual-test** skill (`skills/manual-test`):

1. Add an entry to `CHECKLIST.yaml` (`.spec-flow/specs/<feature>/CHECKLIST.yaml`):
   - `id:` — use the bug id (e.g. `bug-001`) for traceability.
   - `tags: [regression]` — stays in the suite permanently.
   - Fill `request:` and `verify:` to reproduce the bug scenario.

2. **Run and confirm FAILS before writing any fix:**
   ```bash
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --id <bug-id>
   ```
   If it passes, re-examine reproduction steps. Do not proceed until the test genuinely fails.

3. Record failure output in the bug record's "Resolution log:" with a timestamp.

---

## STEP 3 — TRIAGE

**No SD? (brownfield / never ingested) — skip triage, it's a code-bug.**
If `.spec-flow/specs/<feature>/SD.md` doesn't exist, or `trace-impact` returns `NO_TRACE`, there is no spec to be wrong → it is a **code-bug by definition**. Skip the table below and the spec-bug/srs-level routes; the **bug report (expected/actual) + repro test ARE the contract**. Set Triage to `code-bug` with `SD section: n/a (no SD)` and go straight to STEP 4a. (`/sf:change` and `/sf:resync` only apply once an SD exists.)

Otherwise (an SD exists), resolve impact:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-impact \
  --keywords "<comma-separated terms from the bug description>"
```

Examine impacted FR/TC nodes and the relevant SD section. Decide:

| Decision | Criteria | Next step |
| --- | --- | --- |
| **CODE bug** | SD is correct; code behaves wrong | → STEP 4a |
| **SPEC bug** | SD is wrong or incomplete | → STOP → `/sf:change` |
| **SRS-level** | Product/requirement misunderstanding | → STOP → `/sf:resync` |

Update "## Triage" section in the bug record:
```
## Triage (code-bug | spec-bug | srs-level): <DECISION>
- SD section: <ref e.g. SD §5.1 FR-007>
- Linked files (if known): <paths>
- Reason: <one line>
```
Update "## Linked (FR/TC/file):" with trace-impact output.

**If SPEC bug:** `/sf:change "<bug description>" --type fix` — close this flow.

**If SRS-level:** `/sf:resync <srs.md>` — close this flow.

---

## STEP 4a — CODE-FIX PATH (code-bug only — do NOT edit the SD)

Spawn **hybrid-executor** with:

> "Fix the code to MATCH SD section `<ref>`. Do NOT change the SD.
>  Bug: `<id>` — `<description>`.
>  Failing repro test: `<bug-id>` in `CHECKLIST.yaml`.
>  Impacted nodes: `<impacted FR/TC from trace-impact>`."

**No SD?** Substitute the contract: replace "MATCH SD section `<ref>`" with "match the **expected behavior** in the bug report (expected/actual) + the failing repro test"; drop the "Impacted nodes" line. Everything else (do-not-touch-other-behavior, minimal diff) stays.

Log the fix attempt in "## Resolution log:" with a timestamp and summary of changes.

---

## STEP 5 — VERIFY (repro test must PASS)

```bash
scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --id <bug-id> --json | tee .spec-flow/specs/<feature>/bug-<bug-id>-results.txt
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect \
  --results .spec-flow/specs/<feature>/bug-<bug-id>-results.txt
```

**Still FAILING** → append failure to "Resolution log:", loop back to STEP 4a.

**PASSING** → run broader regression:
```bash
scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag regression --json | tee .spec-flow/specs/<feature>/regression-results.txt
```

---

## STEP 6 — REGRESS + CLOSE

1. Keep the repro test permanently in `CHECKLIST.yaml` (tagged `regression`).
2. **Confirm the close with the user — the user is the source of truth for "done".** The moment repro + regression are green, **announce and ask** (do not auto-close, do not silently move on):
   > `bug-<id>` — repro PASS + regression PASS. Close it (set `status: done`), or keep open?
   - **User confirms** → set the record's `status: open` → `status: done` and append a `Resolution log:` line (`- <date> — closed: <one-line summary> [commit/PR if any]`).
   - **User defers / wants more checks** → leave `status: open`. `/sf:status` keeps surfacing it; re-ask next time it's verified.

   Ask **now**, in this session (right after the fix verifies) — that is when the user is present and remembers. **A bug is not done until its record reads `status: done`.** (Don't rely on the user remembering to close it later — but the decision is still theirs.)
3. Append truths to `VERIFICATION.md`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect \
     --results .spec-flow/specs/<feature>/regression-results.txt
   ```
   Append `truths[]` to `must_haves.truths`.
4. Refresh state:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update \
     --feature <feature> --note "bug closed: <id>"
   ```

---

## Pipeline recap

```
/sf:bug "<desc>" [--severity ...]
     │
     ▼
STEP 1  INTAKE       flow-tools bug-new → .spec-flow/bugs/<NNN>-bug-<slug>.md
     │
     ▼
STEP 2  REPRO-FIRST  add CHECKLIST entry → run → confirm FAILS
     │
     ▼
STEP 3  TRIAGE       trace-impact → SD section → decide type
     │
     ├─ spec-bug  ──→  /sf:change "<desc>" --type fix
     ├─ srs-level ──→  /sf:resync <srs.md>
     │
     └─ code-bug (SD correct)
          │
          ▼
     STEP 4a  CODE-FIX  hybrid-executor (code only, SD untouched)
          │
          ▼
     STEP 5   VERIFY     run repro test → must PASS; if FAIL → loop 4a
          │
          ▼
     STEP 6   REGRESS    test stays; bug status=done; VERIFICATION updated
```
