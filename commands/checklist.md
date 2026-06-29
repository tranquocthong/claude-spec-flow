---
description: Generate a manual-test CHECKLIST.yaml scaffold from the SD's §13.2 Test Cases. Bridges SD to the manual-test skill.
argument-hint: <feature>
allowed-tools: Read, Write, Bash
---

# /sf:checklist — SD §13.2 → CHECKLIST.yaml

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each step so the flow survives long sessions.

Input: `$ARGUMENTS` (feature name; SD read via trace).

Generates `.spec-flow/specs/<feature>/CHECKLIST.yaml` — **co-located with the SD** (one home per feature: SD + CHECKLIST + file-links together). spec-flow always passes this full path to `run-checklist.sh`, so the bundled **manual-test skill stays generic and unchanged** (its own scripts still default to `.claude/docs/manual-tests/` for standalone use outside spec-flow). Each §13.2 TC row → one checklist test (TC id → `test.id`; Flow → suite; Test Case → `name`; Expected Result → assertion hint).

The engine emits a **scaffold** — it cannot know endpoint paths or the right assertion shape. Those are filled in the next step, by **you (the agent), from the SD** — not by the user. SD approval was the only human gate; the user reviews your filled checklist, they do not hand-fill 153 TODOs.

## Steps
1. `node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs checklist-gen --sd .spec-flow/specs/<feature>/SD.md --feature <feature>` — writes the scaffold. **If a CHECKLIST.yaml already exists the engine returns `CHECKLIST_EXISTS` and stops** — pass `--force` only to deliberately regenerate from SD (this overwrites all filled assertions; only do it when §13.2 changed substantially via `/sf:resync` and the old checklist is no longer valid).
2. **Fill every test from the SD yourself.** For each test: set `request` (method/path/token) from SD §9.2 / §8, then choose the assertion by feature type:
   - **read / transform** (e.g. masking, projection — no DB write): assert `expect.body` field(s) == the SD §13.2 Expected Result value. This IS a valid PASS; do NOT invent a `verify:` SQL block where nothing is persisted.
   - **mutation** (writes a row/event): delete the `body` stub and add a `verify:` SQL block asserting the real DB/Redis delta (SD §7.2 columns), per `test-rigor.md` MUST-2/3.
   - **pure unit transform** (a TC with no endpoint — e.g. a util `maskPhone("x")→"y"` case): this is a unit test owned by BUILD, not a manual test. Tag it `no-verify` or remove it from the checklist; do NOT fabricate a `/api/v1/...` endpoint for it.
   - **event-driven / cross-service** (no synchronous HTTP surface — e.g. outbox → CDC → publisher → callback): not curl-able as a request/expect. Tag it `live-e2e` (verified by a live run, surfaced as a VERIFICATION gap) rather than leaving a fake HTTP stub.
   > **Carve-out tag — ONE place:** put `no-verify` / `live-e2e` in the test's **`tags:` list** (e.g. `tags: [regression, live-e2e]`). That single source is read by BOTH `checklist-status` and `lint-checklist`. (For a non-HTTP feature, `checklist-gen` already emits the `live-e2e` tag for you — see step 1.) You do NOT also need it in the name.
3. Check progress any time: `node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs checklist-status --feature <feature>` — classifies each test `filled` / `scaffold` (still has TODO stubs) / `no-verify` / `live-e2e` and reports `ready` (no scaffold left). Use it instead of eyeballing the file.
4. Run `scripts/lint-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml` (must pass: no TODO markers, every test has an assertion). Then present the filled checklist to the user for review before `/sf:phase`.

> Deterministic scaffold (no subagent); the agent fills it from the SD.

> **To run the checklist** (after it's filled): use `/sf:manual-test <feature>` — not this command.
