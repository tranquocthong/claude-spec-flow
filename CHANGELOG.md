# Changelog

All notable changes to spec-flow. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are git tags on `main`.

## [0.14.0] — 2026-10-01

### Changed

- **The pre-ship code review is now off by default.** It was documented as optional, but the default `ask` left the decision to the orchestrating agent, which in practice ran it without asking. Now `config.phase.codeReview` absent, `null` or unreadable resolves to `off`: `review-scope` returns `gate: off`, and `/sf:phase` step 3b and `/sf:change` step 6 skip it without offering. `ask` and `always` still work and are the opt-in; `ask` now has to be a real `AskUserQuestion` prompt, and anything but an explicit yes (no answer, no prompt shown, auto-mode) counts as no. `init-project` seeds and back-fills `off`, and `/sf:phase` now says in plain words that nothing but `gate: ask|always` authorises a review. Projects whose config already says `ask` (an earlier back-fill wrote it) keep asking until the key is set to `off`.

### Added

- **`expect_status:` on `http` setup steps.** A setup step aborted the whole test on any status >= 400, so a case that has to fail on purpose before its assertion (a wrong OTP submitted 2-4 times to reach a lockout, each answered 401) could never get past setup, and a capture on such a step never ran. A step can now declare the status it is meant to get: an int, a list (`[400, 401]`) or `any`, nested in `http:` or beside it. Undeclared steps behave as before. A declared step still fails on any other status, so it cannot go green on a 200 or a 500, and `any` accepts every real response but not "no response". `lint-checklist.sh` rejects a malformed value before the run, using the same parser as the runner.

## [0.13.1] — 2026-09-25

### Fixed

- **`/sf:bug` and `/sf:change` skipped the coding-rules gate that 0.13.0 added to `/sf:phase`.** `/sf:bug` spawns `hybrid-executor` directly rather than through `/sf:phase`, so a bug fix got no `## Code Rules` bullets in its prompt, no compliance table was checked, and its verify step ran only the repro and regression checklists, never `verify-code`. `/sf:change` re-implements through `/sf:phase`, but its re-verify ran only the smoke checklist, and no code review looked at the change as a whole.
  - `/sf:bug` STEP 4a now pastes the `## Code Rules` bullets verbatim into the executor prompt and sends back a summary with a missing table, a missing row or an open `violated` row, the same as `/sf:phase` step 2. STEP 5 runs `verify-code --feature` (including `code-rules`) before the repro, and a failing gate loops back to 4a.
  - `/sf:change` step 6 runs `verify-code --feature` over the whole change after the sync to the base branch and before the smoke checklist. On a green checklist it runs the `/sf:phase` step 3b code review under the same `config.phase.codeReview` setting, so a `project-rule` finding blocks the close unless `review-accept` overrides it.
  - Contract tests for both commands added to `test/code-rules-contract.test.cjs`.

## [0.13.0] — 2026-09-24

### Added

- **Coding rules in `project-author.md` are now enforced, not suggested.** A team's rules reached the code only as a paragraph the executor was told to "read if present". Nothing checked them, and the pre-ship reviewer was even told "House style is not a finding", so violations reached the team's own reviewers and the PR was rejected there. Four gaps, four fixes:
  - **`verify.rules`, a diff-scoped rule gate.** `forbiddenPatterns` scans the whole tree on every task, so adding a rule to a project whose old code already breaks it failed every task, and in practice nobody added one. `verify-code` now has a `code-rules` check that fails only on lines this branch added or changed (merge-base with `branching.base`, uncommitted and untracked included) and reports the old violations as a `preexisting` count. Rules can be scoped by `glob`, and besides `forbid` they can say "a file with A must also have B" (`when` + `require`), for rules like "`@Scheduled` needs `@SchedulerLock`". A broken rule is skipped with a warning and never fails the gate. `forbiddenPatterns` is unchanged.
  - **The executor answers every rule.** `/sf:phase` pastes the `## Code Rules` bullets verbatim into each executor prompt, and the executor must return a `pass | n/a | violated` row per bullet. A missing table or an open `violated` row is sent back, like missing TDD evidence.
  - **The reviewer checks every rule, and a violation blocks.** The "house style is not a finding" instruction is gone. Each `## Code Rules` bullet is a checklist item, and a violation is a `project-rule` finding: `review-collect` raises it to at least `medium` and treats it as blocking, with `review-accept` as the override. Taste outside `## Code Rules` stays `low`.
  - `/sf:doctor` validates `verify.rules`, and new projects get an empty `## Code Rules` section in `project-author.md` (existing files are not touched).
- **Backlog is now a record type, not a folder of free-form notes.** `.spec-flow/backlog/` was a convention nothing read: no order, no status, and `/sf:status` reported "nothing pending" while deferred work sat there. `backlog-new --title --priority high|medium|low [--desc] [--feature] [--epic]` writes `NNN-bl-<slug>.md` (id `bl-NNN`, numbered from the highest existing prefix, like `bug-new`). Priority is required and has no silent default, since a defaulted priority carries no information. `backlog-list` sorts high > medium > low > unset, then oldest first, and filters by `--status` (default `open`), `--epic`, `--feature`. `backlog-set` changes priority or status (`open|done|dropped`) in place, leaving the rest of the file byte-for-byte.
  - Existing hand-written backlog files keep working: without the record marker they are listed as `legacy` with priority `unset`, and a list never rewrites them. `/sf:doctor` warns about them (and about records with no priority) with the `backlog-set` command that fixes each.
  - After a ship, the "nothing pending" next step now names the top open backlog item, and `/sf:status` shows the open count and the top three. With no open backlog both outputs are unchanged.
- **An epic is now a directory, not a single file.** An epic spans many specs and many months, and the documents that belong to it belong to no single spec: the per-phase SRS, cross-phase decisions, environment state (SIT, UAT, handoff), gotchas, e2e mocks. `epic-new` used to write one `.spec-flow/epics/<slug>.md` with a hand-written `status: pending` that was wrong after the first phase, and sub-features were grouped only by a name prefix. In practice teams skipped it and built their own `epics/` folder outside `.spec-flow/`.
  - `epic-new` creates `.spec-flow/epics/<slug>/` with `EPIC.md` and conventional `srs/ decisions/ state/ assets/` subdirectories. The subdirectories are a convention; nothing is enforced.
  - `epic-attach --epic --feature` adds a feature to an epic and writes `specs/<feature>/EPIC` as the back link. A feature belongs to at most one epic (`EPIC_CONFLICT` otherwise). `/sf:ingest <srs> --epic <slug>` attaches as it ingests, creating the epic if needed, which fits the common case: phases ingested one at a time over months rather than split once.
  - `epic-list` and the new `epic-show` compute progress from each sub-feature's real tasks and ship record (`done`, `total`, `shipped`) instead of trusting a written status. `/sf:status` shows the epic's progress when the active feature belongs to one.
  - SD, tasks, checklist and verification stay in `specs/<feature>/`; the epic directory holds only cross-phase material.
  - Single-file epics still list and show (`legacy: true`); `epic-attach` refuses them with the one-line conversion command, and nothing is migrated automatically.
  - `/sf:doctor` warns (never fails) about single-file epics, links that disagree in either direction, and files in an epic directory whose names look like secrets (`priv_key`, `secret`, `.pem`, `.env`…) and that git does not ignore, since `.spec-flow/` is usually committed.

## [0.12.1] — 2026-09-24

### Fixed

- **`bug-new` numbered its next id by counting files, not by reading the highest existing id.** A count collides with a real id whenever the working tree doesn't have every file 1..N locally — e.g. `bug-004` already created on an unmerged branch/MR, while the current branch only sees 3 files and recomputes `004` for its own new bug. It now scans the `NNN-bug-` prefixes already on disk and assigns `max + 1`. Regression test added in `test/flow-tools.test.cjs`.

## [0.12.0] — 2026-09-22

### Added

- **An optional code-review gate in the ship step.** The agents that wrote a feature cannot review it — they are inside their own reasoning. `/sf:phase` close-out now offers one independent pass over the finished diff, in a context that never wrote a line of it, immediately before the commit.
  - `config.phase.codeReview` decides whether it runs. Three states, because the default is a question rather than a behaviour: `ask` (default — `/sf:phase` asks yes/no once per ship), `always` (no prompt), `off` (skip entirely). `init-project` back-fills the key into existing configs without changing behaviour, since absent already read as `ask`.
  - `review-scope` computes the scope deterministically: the base branch, `<base>...HEAD` (null when branching is off, when you are on base, or when the base ref will not resolve — never a bogus range), the files the executors actually wrote from `file-links.json`, and the repo roots on a multi-repo feature, where those files are the only reliable scope. It also reports a prior verdict and whether HEAD has moved past it, so an unchanged tip re-uses its review instead of paying for a second pass.
  - The reviewer is a sub-agent, read-only, pinned by `config.models.codeReviewer` (default `sonnet`). It reports — it never fixes. Fixing is a decision the user makes afterwards, and a post-review fix re-enters the verification gates.
  - **The gate is built against its real failure mode, which is a noisy reviewer rather than a lazy one.** A model handed a bare diff cannot tell a defect from a deliberate decision, so it reports both at the same severity, and after two such reviews the user declines forever and the gate is dead. So `review-scope` also returns a `contextPack` — the SD, `CONTEXT.md`, the checklist, `VERIFICATION.md` (including gaps already known and accepted), `project-author.md` and the trace — and the step's standing rules make the reviewer check every critical/high against the spec before writing it, cap taste at `low`, and name the inputs and wrong result that a blocking finding produces. A `critical`/`high` must carry `checkedAgainst` (the FR or TC it was tested against); `review-collect` returns any that do not as `uncheckedBlocking`, and `/sf:phase` sends those back for a re-rate instead of halting a ship on an unchecked claim.
  - `review-collect` turns the findings into `specs/<feature>/CODE-REVIEW.md` and a deterministic verdict: `clean`, `advisory`, or `blocking` on any critical/high. Blocking halts the ship and hands the user three choices — fix now, ship anyway, or abort.
  - `review-accept --note` records a human's "ship anyway" on disk. Without it the override would live only in a transcript, and the next session would read an unresolved blocker. `/sf:status` surfaces an unaccepted blocking verdict in its next step.
  - Codex: the `code-review` skill is a Claude Code built-in and is not part of the package. The Codex runtime contract tells the host to perform the review itself against the same output contract when it has no equivalent, and keeps the gate's shape either way — a review that was performed but never collected did not happen.

- **`/sf:doctor` now catches a stale local plugin install (`plugin-source-sync`).** A plugin installed from a *local directory* marketplace does not run from the source repo: Claude Code copies it into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and runs that. The cache path is keyed by version, so while the version string holds still — exactly what a careful maintainer does between releases — edits to the source never reach the running plugin. The failure is silent and total: a new engine command answers `UNKNOWN_COMMAND`, an edited command doc is simply the old one. Nothing in doctor said so, and finding it by hand costs a session. The check compares the runtime surface (`bin`, `lib`, `commands`, `agents`, `skills`, `templates`, `hooks`) by content hash, names the differing files, explains why `/plugin update` will not fix it, and hands over a copy-pasteable `rsync`. It is silent for a normal github install, and for a contributor running the engine straight from a checkout.

### Notes

- The gate is optional; the hard gates are unchanged. `verify-code`, the regression sweep, and `VERIFICATION.md: status: passed` still guard the ship on their own, and declining the review is a silent, recorded-nowhere no-op rather than a clean verdict.

## [0.11.1] — 2026-09-15

### Added

- Codex support through a generated `spec-flow-codex` plugin distribution. It preserves the shared `.spec-flow/`, `.taskmaster/`, and legacy manual-test artifacts while adapting skill entry points, host detection, and hooks for Codex.
- A reproducible build, distribution validation, compatibility tests, and GitHub Actions release artifact (`spec-flow-codex.tar.gz`).

### Notes

- Codex uses the active session for `agent-native` task generation. Existing explicit provider configurations are retained unchanged.
- Codex hooks must be reviewed and trusted through `/hooks` on each client.

## [0.11.0] — 2026-09-15

**The manual-test gate could report a green run having executed nothing, and this release makes that impossible to say.** Found by auditing a downstream project's 842 test cases across 33 features, then reproduced against the runner in two lines of YAML. The plugin's own backlog note (`run-checklist-no-verify-false-green.md`, filed 2026-09-10) described one symptom of it; this is the root cause and the fix.

### The defect

`runner.py` decides the outcome of a test with `if errs: FAIL else: PASS`. **`PASS` means "no assertion reported an error" — not "an assertion passed."** A test with nothing to send and nothing to assert produces no errors, so it passes without executing anything:

```yaml
suites:
  - name: probe
    tests:
      - {id: TC-001, tags: [live-e2e, regression]}
      - {id: TC-002, tags: [no-verify, regression]}
```

```
run-checklist.sh probe.yaml --tag regression --json
  TC-001  GET
    ✓ PASS  status=0          <-- no request ever left the machine
  total: 2   passed: 2   failed: 0
{"passed": ["TC-001", "TC-002"], "failed": []}          exit 0
```

`verify-collect` then believed that count and wrote `status: passed` with `- TC-001: verified` under it. `status=0` was the only tell, and it reads like a status code.

The 0.10.x lint already refuses a decorative `expect:` (a bare `{n: 3}` cannot fail a test, so it is not an assertion), but its own message offers the way around itself — *"OR tag the test no-verify / live-e2e"*. Those tags mark a placeholder for a hand-run step, and in practice they are written alongside `regression`, so `--tag regression` selected them and counted them green. The carve-out in the lint was the entrance to the false green.

### The fix

- **`runner.py` now separates *executed* from *passed*.** A test with no `request`, no `verify`, no asserting `expect` key and no executing `setup` step is reported under a new `notVerified` group — named in the console summary, and emitted as `"notVerified": [{id, reason}]` in the `--json` line. It is never counted as passed. Exit code is unchanged, so nothing that shells out to the runner breaks.
- **`verify-collect` refuses to record evidence it does not have.** An id under `notVerified` never becomes a `- TC-xxx: verified` truth. Its presence holds the status at **`incomplete`** — deliberately not `verified-adhoc`, which `VERIFIED_STATUS_RE` accepts as shippable *because it asserts a human verified out of loop*. Nobody has, yet. `incomplete` matches no gate, so G3 stays shut until someone runs those cases, writes down what they saw, and sets `verified-adhoc` themselves. The generated file names each owed case under `## Not verified` with the reason.
- **The runner no longer synthesises a GET for a test with no `request` block.** It used to send an empty request to `base_url` and print `GET  / status=0`, which reads as a real HTTP check that passed — one downstream VERIFICATION.md had already recorded the confusion (`for TC-013 the runner printed GET / status=404 / PASS`). Against a live environment that stray call could also touch a real endpoint. Such a test is now labelled `— asserted by setup/verify`, and only its `expect.poll` still runs.
- **Lint gained a negative-path coverage warning.** The per-test rule asks whether a test asserts anything; it never asked whether the checklist ever exercises a rejection. In the audited project **14 of 33 features had zero test cases asserting `status >= 400`** — every error code and guard clause unexercised while every gate read green. A warning, not a failure: it is a signal about the SD's §13.2 test cases, and existing checklists must stay runnable.

**A correction worth recording, because the first two passes of this audit were wrong.** An initial sweep called 228 of 842 test cases empty and flagged seven features as false-green. Both numbers were inflated. `setup:` steps carrying `exec:`/`sql:` **are** assertions — `run_steps` aborts on the first failure and the caller turns that into a FAIL, so `exec: ... exit 1` asserts perfectly well without an `expect` block, and one feature's 26 test cases were built entirely that way. And most flagged VERIFICATION files carried real hand-written evidence (`verified-live — 400 auth.invalid.otp, attemptsRemaining 5→4`) that a `status:`-line check could not see. After both corrections: **zero genuine false-greens on disk.** The mechanism is real and reproducible; in that project humans had caught every instance by hand. What this release removes is the need to.

### Task engine: MCP surface removed, CLI only

`.mcp.json` is deleted. The plugin declares **no MCP server** — every task operation goes through the bundled CLI (`bin/flow-tools.cjs` `task-add` / `task-get` / `task-list` / `task-set-status` / `task-next`, and `bin/task-master` for the AI ops). The native engine was already the only binding and the CLI twins have shipped since 0.8.x; what is gone is a second way in that could fail to connect, bind a stale surface, or shadow the engine from a project `.mcp.json`.

- `commands/init.md` no longer prefers an `initialize_project` MCP tool — the CLI bin is the only path.
- `agents/hybrid-executor.md` names `flow-tools.cjs task-get` instead of `mcp__task-master-ai__get_task`.
- `/sf:doctor` `dep-lock` now verifies the CLI entry points exist and warns if an `.mcp.json` reappears at the plugin root. `mcp-shadow` now warns about **any** project-level `task-master-ai` entry, including the old "native" shape: with no server shipped, such an entry binds a separate implementation writing the same `.taskmaster/` files.

`bin/mcp-server.js` and `lib/mcp-server.cjs` are retained but no longer referenced by any binding — the rollback and cutover machinery still exercises them on temp files. Removing them is a separate cleanup.

Full suite green: 910 engine tests (`node --test test/*.test.cjs`, +3) and 80 checklist-runner tests (`python3 -m unittest checklist_lib.tests.test_checklist_lib`, +8).

## [0.10.1] — 2026-09-11

Four bugs surfaced by running `/sf:ingest` against a real SRS in a downstream project, all in the Pass-1 deterministic harvest and the traceability engine. None block a fix directly in code — `bin/flow-tools.cjs`, `lib/core.cjs`, `lib/trace.cjs`.

- **Pass-1 silently truncated harvested FR/TC/NFR cells at a hard 200/220-char cap.** Measured on a real SRS: every requirement sentence past ~220 chars got cut mid-word with no `…` and no signal — several lost only the closing period, reading as a complete sentence. The cap is now a generous backstop (2000 chars) meant only for a genuinely pathological row; ordinary harvested text (verified up to 357 chars) now survives whole. A cell that still hits the backstop is named in `data.warnings` (`TRUNCATED: ...`) instead of disappearing silently.
- **§5.2 NFR harvest read columns positionally, not by header.** A heading-harvested NFR table assumed the bare `Requirement | Target` shape (`r[0]`/`r[1]`); a richer `ID | Category | Requirement | Target` table — the SD's own §5.2 convention — got its ID column read as the requirement text, its real Category dumped into Target next to the actual target value, and every row force-labeled `Perf/Sec` regardless of its real category (Resilience, Regression, ...). Columns now resolve by header keyword (English + Vietnamese lang packs), falling back to the old positional read only for a genuinely unlabeled 2-3 col table.
- **`trace-build`'s §10.4 header-drift check false-positived on a repurposed section.** A `### 10.4` section kept its number but retitled to unrelated content (e.g. an OUTBOX vs DIRECT route comparison — sd-template.md explicitly allows deleting/repurposing §10.4 when a feature has no state machine) was reported as a "state table header mismatch" even though the table was never meant to be a state table. The check now also requires the heading title to still carry the word "state" before warning.
- **Switching the active feature's global `trace.json`/`STATE.md` mirror was silent.** `trace-build` and `state-update` already computed `switchedFrom` but returned it as inert JSON metadata with no severity — easy for a caller that only checks `data.warnings` to miss entirely. Both now push an `ACTIVE FEATURE SWITCHED` warning when the feature being switched away from has no ship record (still-open work); switching away from an already-shipped feature stays silent (expected churn).

All four fixed with regression tests (8 added to `test/core.test.cjs` + `test/flow-tools.test.cjs`); full suite 907/907.

## [0.10.0] — 2026-09-10

**One dogfooding session aimed at speed, which then found ten bugs — seven of them older than this release.** The intent was narrow: cut the token cost of the implement loop and the size of the artifacts it writes. Measured against four months of real use (37 features, 408 tasks, 31 tags in one 16-repo project). What made the bug count high is that the cuts forced every command to actually be RUN, and several code paths turned out never to have executed end to end. Fixing one layer kept exposing the next.

### Group 1 — false-green / wrong state

- **The ship gate could be opened by a document forbidding the ship.** `verified` was decided by `/status:\s*passed/i` tested against the WHOLE `VERIFICATION.md` — a substring match. A file whose status line reads `failed` and whose body reads "Do NOT ship. 12 regression tests are red. This must not be recorded as `status: passed`" reported `verified: true`. G3 (do not ship unless VERIFICATION reads status: passed) was therefore satisfiable by prose. It now matches only a real `status:` line.
- **`verified-adhoc` never counted as verified — and that has been live.** The same substring regex only looked for `passed`, so eight already-shipped features in a real project have been reading as NOT verified: `/sf:status` said so, and G3 would have blocked them. `/sf:phase` close-out step 4 has always treated `verified-adhoc` as shippable. Both statuses are now accepted, checked against 30 real VERIFICATION files (eight flip false→true, none flip true→false).
- **`update-task --append` never appended.** The flag appeared in its own handler's signature comment and was read by nothing, so every call replaced `notes` wholesale and only the most recent entry survived. Verified before the fix: two successive appends left only the second.
- **`drift-check` read a field nothing writes.** `update-task` stores `notes`, `task-baseline --apply` stores `details`, and drift-check read only `details` — so its task-log source was structurally blind to every note the implement loop ever wrote. It now reads both, on tasks and subtasks.
- **`drift-check` answered "clean" having read nothing.** Its only source was those task logs, which are opt-in since this release and had never worked anyway (see Group 4), so it returned `clean: true` with zero input — a false negative sitting behind a gate meant to catch SD mismatch. The primary source is now the shipped CODE, scanned deterministically. With no source at all the answer is `clean: null` (undetermined).
- **`drift-check` scoping needed to be asymmetric, and a first attempt got it wrong.** Scoping the scan to `file-links.json` produced a false positive on a real feature: it reported `transaction.auth.limit.exceeded` missing from §12.2's implementation when that code sits in four files of a sibling repo, simply absent from that feature's own 28-entry file-links. Absence has to be PROVEN, so `spec-not-evidenced` now searches wide (scanPath plus every `config.repos` sibling); authorship is narrow, so `impl-not-specced` still searches only the files this feature wrote — a wide search there attributed 39 neighbouring error codes to one feature.

### Group 2 — speed, which was the point

- **`commands/phase.md`: 274 → 171 lines, ~7,718 → ~3,642 tokens (−53%).** Removed the CLI-vs-MCP preamble, the MCP→CLI fallback table, the `use-tag`/`currentTag` workaround, every `models --set-*` + `trap` restore dance, and the verbose agent-native handoff prose. All twelve engine gates verified intact by diff; every referenced command resolves; no section lost. Removing the `use-tag` block was validated by pointing `currentTag` at the wrong feature and confirming all seven task ops still write to the right tag.
- **`analyze-complexity` removed from the loop.** An AI op per feature whose output no consumer read — routing is and always was driven by the deterministic `route --sd`. `route` output is byte-identical on four real SDs before and after. The engine op definition stays, so manual invocation still works.
- **`update-task --append` is opt-in behind `config.phase.taskNotes` (default `false`).** One AI subprocess per task, 13.2 tasks per feature on average, for human-readable history that is not the source of truth. `trace-link` and the task status stay unconditional. An absent key reads as `false`, so existing projects get the speedup without editing config.
- **`trace.json`: 1,166 → 434 lines per feature (−63%).** It was 36% of all planning-artifact churn while carrying data fully re-derivable from stores already persisted separately — 63.2% of 4,051 links and 40.9% of 3,166 nodes across 31 real features. `core.hydrateTrace()` rebuilds them at read time. Links are now serialized one per line, so a changed link is one diff line rather than a five-line block. `generatedFrom` is stored relative to the repo root; the absolute path produced a spurious diff on every rebuild on every machine.
- **`templates/sd-template.md`: 1,032 → 720 lines (−30%).** Removed the sections 34 shipped SDs never use: Message Queue 0/34, Security Considerations 0/34, Risks & Mitigations 0/34, Stakeholders 1/34, Table of Contents 0/34, Document Information 0/34. Revision History (35/34) is kept. §7 "Database Design" becomes "Data Model", which 25 of 34 real SDs already renamed it to. The Glossary is emitted only when the SRS defines terms — it was 904 dead lines, mostly an empty placeholder row. §9.2 keeps one worked endpoint instead of a five-verb CRUD catalogue; §9.4 and §10.8 keep one sequence diagram each.
- **Section numbering is NOT renumbered.** Renumbering would have touched 1,833 references — 337 inside spec-flow and 1,496 across already-shipped SDs — plus five number-keyed cross-checks in `lib/trace.cjs`, in exchange for a contiguous sequence. Gapped numbering is already the working reality. A note at the top of the template explains the gaps so nobody "fixes" them.
- **`commands/` overall: 25,626 → ~20,800 tokens.** `ingest.md` lost a 30-line block that duplicated `/sf:phase` Step 0 verbatim while `/sf:ingest` does not seed tasks at all. `change.md` and `resync.md` now call the deterministic task ops directly instead of presenting them as an MCP fallback.

### Group 3 — the shipped template could not be parsed by the shipped parser

Pass-1's whole purpose is to hand sd-author a pre-filled draft. It silently produced 0 FR / 0 TC / 0 NFR for anyone following the shipped SRS template. Measured on 33 real SRSs: 22 harvest zero FRs, yet those features shipped SDs carrying 15–29 FRs each — sd-author derived all of it, at the most expensive point in the flow.

- `parseUserStories` now accepts both forms a story can be written in: an ATX heading (`### US-01: name`), which real SRSs use, and a whole-line bold paragraph (`**US-1: name**`), which the template used. Mixed forms dedupe first-wins, and an inline `**US-1**` mid-sentence is prose, not an anchor.
- `tableByIdPrefix` locates ids by cell content instead of hardcoding column 0, and reports the matched column as `idCol` — a leading `STT`/`No.`/`#` column no longer hides an entire table.
- `srs-template.md`: the user story becomes an ATX heading, the NFR table gains an ID column, and the acceptance/edge-case sections now SHOW example bullets instead of describing them in prose — those bullets are exactly what Pass-1 turns into FR and TC rows. Harvest on the shipped template: 0/0/0/0 → 1 story, 5 FR, 4 NFR, 2 error codes, 5 TC.
- New `EMPTY_HARVEST` warning names the empty buckets and the shape each expects. Its condition was narrowed after measurement: warning on any empty bucket fired on 30/33 real SRSs including one with a healthy 49 FR / 60 TC, because writing FR tables without user stories is a legitimate style. It fires only when `fr == 0`, or `fr > 0` with `tc == 0` — 22/33, all genuine. Advisory, never blocks.

### Group 4 — commands documented in a form the CLI rejects

None of these had ever run as written, and all predate this release:

```
task-master update-task --id=<id> --append       -> exit 1, "--id is required"
task-master update-task --id <id> --tag <f> ...  -> exit 0, "Task 2 updated."
```

The parser wants a space, not an equals sign, and without `--tag` the tag resolves to `undefined` and the op fails `ERR_TASK_NOT_FOUND`. The same defect applied to `expand --id=<id>` and, in `resync.md`, `update --from=<id>`. **The `expand` case matters most: complexity 4–7 routes to `expand`, so the middle tier of the adaptive loop has been silently failing** — `route --sd` sends 25 of 34 FRs down that path on a typical feature. Fixed in `phase.md`, `change.md`, `resync.md` and `agents/hybrid-executor.md`.

This also corrects a claim: the ~14 AI calls per feature credited to `phase.taskNotes` were mostly failed subprocesses, not AI calls. One real AI op was removed (`analyze-complexity`, which did work because it passes `--tag`).

### Group 5 — noise and discoverability

- **A multi-repo run with no repo scope now says what to do.** `verify-code --feature X --task 1` on a 16-repo hub scanned every configured repo and returned `scope: null` with 64 check rows, most of them failures from repos the feature had never touched. Declaring the targets with `trace-repos --set` takes the same run to 4 checks — it just was not discoverable from the failure. An `UNSCOPED` warning now names `trace-repos --set`, `--repos`, and the `trace-link --repo` route.
- **`resync.md` pointed the anchor-blind path at the query that cannot resolve it.** `trace-impact --changeset` seeds from FR-/TC-/ERR_ ids found INSIDE the changed text, and prose acceptance criteria carry none. On a real SRS revision (15 added / 9 removed bullets) the changeset path resolved `impacted: {}` — nothing — while `--keywords` resolved 13 FR, 34 TC, 8 tasks and 23 files. The doc now says which query suits which SRS shape, with the measured comparison.
- **`checklist-gen` warning text follows the §7 rename.** Detection is by section NUMBER, so "Data Model" was never affected; only the message said otherwise. Three stale references to SD §8 (Message Queue, removed above) also fixed.

### Fixed within this release

- **`hydrateTrace` threw when a trace was read without a feature.** Introduced by the trace change itself: `fileLinksPathFor(null)` throws on `path.join`, and the global mirror is read with no feature all over the flow — including `state-update --note "..."`, which every command's re-anchor line tells the agent to run after each step. It went from `ok: true` to `INTERNAL: The "path" argument must be of type string`. The function's contract is never to throw; it now falls back to the trace's own feature and skips the file-links half when there is none. The other four commands that read a trace without `--feature` were swept and had no equivalent crash.

### Behaviour changes to be aware of

- **`trace.json` format.** Old fat traces are read normally and self-slim on the next `trace-build` — no migration script, no user action. Anything reading `nodes.files` / `nodes.tasks` / `task-file` / `fr-file` / `fr-task` straight off disk must call `core.hydrateTrace()` instead. Equivalence checked with 210 `trace-impact` comparisons across 35 real features: zero differences.
- **`drift-check` can return `clean: null`.** Scripts keying on `clean === true` should treat null as undetermined, not clean.
- **`config.phase.taskNotes` defaults to `false`.** Projects that relied on per-task narrative history must set it to `true`; note that it never actually worked before Group 4.
- **Four SD template sections are gone.** Existing SDs are unaffected — only newly generated ones follow the trimmed template, and old section numbers still parse.

### Rolling back to 0.9.0

Tested, and safe with one required step. No command crashes: 0.9.0 reads a slim `trace.json` without error, and one `trace-build` per feature restores the fat format.

**Until you run that rebuild, impact analysis silently under-reports.** 0.9.0 has no `hydrateTrace`, so the derived half is simply absent: on a real feature, `trace-impact --ids FR-010` returned 0 files and 0 tasks against the slim trace where 0.10.0 returns 17 and 5; `--keywords cert` lost 6 tasks and 21 files. A `/sf:change` on that FR would resolve to zero tasks and read as "nothing to reopen". `STATE.md` also reports the persisted link count rather than the full one (41 instead of 245 on one feature).

So if you roll back, immediately run for each feature:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build --sd .spec-flow/specs/<feature>/SD.md --feature <feature>
```

### Known gaps

- All 41 test cases of this release's own feature are `no-verify`: the manual-test runner supports `request` / `request.kafka` / `verify: SQL` and this was a CLI change with no HTTP surface. Evidence is 900+ unit tests plus the 210-probe equivalence run, not a checklist sweep. `run-checklist --json` still counts `no-verify` tests as `passed`, which is a false green recorded in backlog.
- `commands/phase.md` was executed step by step against a real project's state, but never LOADED by the plugin runtime — the marketplace serves command markdown from a pinned cache. First real `/sf:phase` after this release is the remaining test.

## [0.9.0] — 2026-09-08

**Nineteen rough edges from one real dogfooding session (an eid-gateway feature and a 26-FR/47-TC phase), grouped by what they actually cost.** Group 1 is false-green / lost-evidence: a command reports success, or asserts nothing, while the thing it claims to check never happened. Group 2 is noise that wastes time without corrupting the result. Both groups share one theme this release keeps hitting: an engine that silently drops the SECOND (or third, or fourth) matching thing — a table, a repo, an FR, a stderr stream — instead of merging or naming what it dropped.

**Group 1 — false-green / lost evidence**
- **`verify-collect` never wrote `VERIFICATION.md`.** It computed `{status, passed, failed, truths}` and returned them as JSON only — `commands/manual-test.md` step 4 says "This writes VERIFICATION.md," but nothing did. `status-report`, `doctor`'s verify-integrity check, and `task-baseline` all read that file to decide a feature is verified; a full 68/68 pass reported `status:"passed"` on stdout while the feature stayed "not verified" forever and the ship gate never opened. It now actually writes the file, in the `status: passed|failed` + `- TC-xxx: verified` shape those readers already expect. Also fixed in the same command: `--results` only accepted a file path, but the doc's own worked example passes the JSON result line inline — now accepts either. `--feature` is required (no inference from the shared active-feature mirror — the same write-safety rule `trace-link` already enforces).
- **A dict `expect:` on a SQL `verify:`/`setup:`/`teardown:` step was never asserted.** `db-query.sh -t` has no column headers to match a dict key by, so `check_scalar()` treated a dict expect as purely descriptive — which is also the MOST NATURAL way to write a multi-column assertion (it's exactly how `expect.body` works for HTTP). A real bug in one of those columns printed green. `lint-checklist.sh` now flags it before the run: split into one scalar `verify:` row per column, or assert via the HTTP response's `json_path`.
- **`expect:` had no `contains` operator.** `expect: "contains idx_foo"` fell to the exact-string fallback — the whole (often multi-line) scalar result compared against the literal string `"contains idx_foo"`, never equal, so an EXPLAIN-plan-has-this-index assertion always failed regardless of whether the index was actually there. Added `contains` / `not contains` (substring match) to `check_scalar`/`cmp`, matching what `json_path:` assertions already supported.
- **A failed `teardown:` step vanished into console-only output.** `teardown:` is deliberately best-effort (never aborts the run), but a teardown step is often RECOVERY — undo a mutation, restore a row — and a failed recovery only printed a line to stdout; the caller had no way to know it happened. Its dirty leftover state then broke a LATER, unrelated test with no link back to the real cause. `setup.run_steps()` now returns the warning list instead of swallowing it; `run-checklist.sh --json` reports it as `teardownWarnings`, and `verify-collect` records it in `VERIFICATION.md` under its own heading — visible, not misattributed.
- **`sd-skeleton` harvested only the FIRST FR-prefixed table.** An SRS with FRs split across several sub-tables (one per module — 26 FRs across 4 tables is a real, common shape) reported `fr: 6` and silently dropped the rest. Same bug for the TC/NFR ID-prefix fallbacks. `tableByIdPrefix` now merges every matching table's rows instead of `.find()`-ing the first.
- **`sd-skeleton`'s §12.2 error-code harvest never read the SRS's own §6.2 "Error & Notification Messages" table** — only per-story Edge Cases bullets, even though the generated §12.2 fallback text has said "derive from SRS §6.2" since Pass-1 existed. A project that lists its error codes in that dedicated table (rather than as story edge-case prose) harvested 0, with no signal. It's now read and merged, with the table's own Message column used as the real user-facing message instead of a TODO.
- **`trace-build` built tables purely by content-matched header keywords, with no cross-check against the section NUMBER.** A `§12.2` (or `§5.1`/`§13.2`/`§10.4`/`§5.2`) table whose column headers drifted — translated, renamed — silently produced 0 nodes for that whole section: the SD reads complete, the trace quietly drops it. Now warns by name when the numbered section exists with a table the content-matcher didn't recognize, quoting the actual headers found.
- **`trace-build` never flagged an FR with zero linked TCs.** An orphaned requirement — present in §5.1, uncovered by any §13.2 test — built a valid-looking trace. Now warned by FR id.
- **`checklist-gen`'s auth detection scanned the WHOLE multi-repo hub**, majority-voting across every `config.repos` entry — a feature scoped to one no-auth/HMAC repo in a hub of Summer/APISIX services got the hub's `summer` classification and 401'd every generated test. Now resolves the feature's own repo scope first (`--repos` > declared `trace-repos` > file-links inference — the same precedence `verify-code` already uses) and detects against that one repo when it resolves unambiguously.
- **`detect-auth.sh` defaulted an unrecognized custom scheme to `no-auth`.** A gateway verifying its own HMAC/signature header (no Spring Security dep, no `Authorization: Bearer`) has real access control, and `no-auth` scaffolds unsigned tests that never exercise it. Added an HMAC/signature-pattern check (`X-Signature`, `Mac.getInstance("Hmac...")`, `crypto.createHmac`, …) that now classifies as `unknown` instead — same safe-default fix as the 0.7.4 Summer/`X-Userinfo` flip, one auth family later.
- **`parse-prd`/`expand`, run as a bare CLI subcommand, look like they finish in one shot — they don't.** Default `taskCore.aiMode` is `agent-native`: the command prints a `GenerationSpec` and exits 0 without calling an LLM (zero-network by design). `commands/ingest.md` and `commands/phase.md` presented it as a single self-sufficient bash command; the agent could read exit 0 + a large JSON blob as "done," run `use-tag` successfully, and leave `tasks.json` with zero tasks for that tag — silent, textbook false-success. Both docs now spell out the handoff: parse the printed spec, generate the `Task[]` yourself (Phase 2), then `tasks-import --file <path>` (Phase 3) — `{"imported": N}` is the real signal, not the Phase 1 exit code.

**Group 2 — noise, not wrong**
- **`srs-snapshot`'s filename-derived-slug warning only fired for a date-prefixed filename.** Any other filename shape (`phase-3-agentgw-client.md`, drifting from a project's own naming convention) was silently adopted. Now warns whenever the slug came from the filename at all (no `Feature:` line, no `--feature`).
- **`checklist-gen` leaked `detect-auth.sh`'s stderr diagnostics into a caller that merges stdout+stderr.** The engine's own stdout stayed pure JSON, but `execFileSync`'s default `stdio` inherits the child's stderr straight into this process's — any `2>&1` capture (or a tool wrapper that combines streams) saw prose land BEFORE the JSON and failed to parse it, even though the command had already succeeded. Now explicitly captured and discarded.
- **`checklist-gen` always scaffolded `config.db`/`config.redis`/`cleanup:`, even for a phase with no persistence at all.** `sd-template.md`'s own §7 convention is "no DB change → delete this section" — now honored: no §7 (or a §7 that says N/A/stateless/no database), no db/redis/cleanup block, with a warning explaining why.
- **`checklist-gen` silently degenerated to one suite per test.** When every §13.2 TC row carries a distinct `Flow` value (common for business-rule-derived TCs — 26 rules, 28 suites), grouping-by-Flow produces 28 singleton suites, and a singleton suite's lone test is ALWAYS tagged `smoke`, never `regression` (the rule needs ≥2 tests per flow to ever emit a `regression` tag) — so `--tag regression` silently skips the entire checklist with no error. Now warned by name, with the count.
- **`genSd`'s §10.4 State Management forced a `TODO:MANUAL-REVIEW` marker on every internal/hybrid phase, even one with no state machine at all.** `sd-template.md`'s own convention is "no state → delete this sub-section," the same carve-out §7 gets — but Pass-1 never offered it, so a plain batch job or pure transform carried a permanently unresolvable marker blocking approval until someone hand-deleted the section. Now a plain advisory note, not a TODO.

857 Node tests green (15 new), 68 Python `checklist_lib` unit tests green (3 new).

## [0.8.10] — 2026-09-07

**Four false-greens found in one audit pass, all the same shape: an engine trusts a narrow pattern, then reads "no match" as "no problem."** Same family as the `verify.testCommand` singleton fixed in 0.8.9. None of these throw or error — each one silently reports a clean result while the actual work is still undone.

- **The SD approval gate missed every `TODO:MANUAL-REVIEW` marker embedded in a table cell or list item.** `countSdTodos` anchored to `^>` (blockquote at line start), but `sd-skeleton`'s own zero-count placeholders — an unparsed §5.1 FR row, an unresolved §5.2 NFR, the §12.2 generic error code, an unresolved §13.2 TC — are written *inside* a `| ... |` table row or a `- ` list item, which never starts with `>`. The gate reported **0 unresolved** on a draft that still had real placeholders in it. One spot was worse: the per-edge §12.2 error-message marker was built with a second `.replace()` that stripped the bold marker text itself, not just the leading `>` — no trace of it survived at all. Fixed: markers embedded inline now drop the (meaningless, mid-line) `> ` via a new `TODO_INLINE()` helper, and the gate now matches the bold `**TODO:MANUAL-REVIEW**` form anywhere in the document — still correctly ignoring the plain-text preamble banner, the sd-author Pass-2 summary, and revision-history prose, none of which bold the phrase. `agents/sd-author.md` now states the exact literal form the gate requires, so a human/LLM-authored marker doesn't silently drift into a third, gate-invisible style.
- **`srs-diff` was blind to content edits inside an ID-prefixed FR/TC/NFR table.** `parseSrs`'s language-independent fallback (`frTable`/`tcTable`/`nfrTable` — used when an SRS has no user stories or keyword-matched headings, i.e. a plain `| FR-1 | ... |` table) was harvested for `sd-skeleton` but never compared by `srs-diff`. Editing an FR row's requirement text, an error-code mapping, or a validation limit read as 0 changes. All three tables are now diffed the same way NFR/business-logic/state rows already were.
- **An SRS could fail to round-trip against its own snapshot, defeating the `emptyChangeset` wrong-input guard with pure noise.** `norm()` lowercased and collapsed whitespace but never Unicode-normalized. The same visible Vietnamese (or any diacritic-heavy) text encoded as precomposed (NFC) vs decomposed (NFD) combining characters — routine when a snapshot copy and the later working SRS pass through different editors — compared as different strings: every affected bullet surfaced as a phantom removed+added pair, and a document nobody had touched came back "this IS a revision." `norm()` now normalizes to NFC before comparing.
- **`config.repos["x"]` in the object form (introduced in 0.8.9) broke multi-repo auth detection.** `detect-auth.sh`'s repo-list builder string-concatenated the config value directly (`n + "\t" + p`); the plain-path form works, but the object form (`{ path, stack, verify }`) stringified to the literal text `[object Object]` — a path that never exists, so the repo silently fell into the "does not exist; skipped" branch and detection fell through to classifying the hub instead, with no error.
- 842 Node tests green (4 new).

## [0.8.9] — 2026-09-07

**A Maven repo in a Gradle hub failed the verify gate for a reason that had nothing to do with its code.** `config.stack` and `config.verify.testCommand` are project-wide singletons, and `verify-code` read them once for every repo root — so the moment a hub's sibling repos stopped sharing one build tool (four Gradle services, then a Maven gateway), `./gradlew test` ran in a directory with no `gradlew` and the gate reported a failure whose message pointed nowhere near the cause. Same family as the `currentTag` and `trace.repos` singletons of 0.8.5–0.8.7: one global standing in for something that is genuinely per-scope.

- **The workaround that this replaces, and why it is worse than it looks.** Flipping both keys to `mvn -q test` + `java-maven` for the duration of a Maven feature does work, and it costs two edits. What it also does is arm a trap: the next Gradle feature fails the gate with a message about a missing `pom.xml`, `/sf:doctor` reports all-green while it does, and nothing on disk records that the config is mid-flip. A shared singleton flipped by hand is a debt with no due date attached.
- **`config.repos` entries may now be objects.** `"eid-gateway": { "path": "../eid-gateway", "stack": "java-maven", "verify": { "testCommand": "./mvnw -q test" } }` — `stack` and any `verify` key override the project-wide value **for that root only**; everything omitted inherits. The plain string form (`"wallet-ms": "../wallet-ms"`) is unchanged and untouched, so no existing config moves.
- **Unconfigured roots auto-resolve, and say so.** When a root has no override and the inherited `testCommand` *provably* cannot run there, `verify-code` fingerprints the root (`core.detectRepoStack`: gradle → maven → node → python → go, by marker file) and uses that tool instead. "Provably" is deliberately narrow (`core.commandRunsIn`): a repo-local launcher missing from disk, or a PATH build tool whose project file is absent. An unrecognized command — a shell one-liner, an absolute path — is never second-guessed. Every swap is reported in the check detail and in `result.repoResolution`; the gate never runs a command different from the one the config states without saying which and why.
- **Scoped test filters follow the root's stack, not the project's.** `--tests "FQCN"` is Gradle-only syntax; a Maven root scoped with it dies on an unknown option. `buildScopedTestCommand` now resolves per root, so the same task can filter `--tests` in one repo and `-Dtest=` in another.
- **`/sf:doctor` stops reporting green on a mixed-toolchain hub.** The `repos` check validated only that a path exists and is a git tree. It now also asks whether that repo can actually run the configured test command, and when it cannot, the fix line is the exact override object to paste — including the detected stack and command.
- 838 Node tests green (12 new: both `config.repos` spellings, the five build-tool fingerprints, gradle-wins-over-maven, the three `commandRunsIn` verdict classes, override-beats-detection, detection-when-unrunnable, runnable-left-alone, unknown-tool-noted-not-swapped, and four CLI cases against a real mixed hub — auto-resolution, explicit override, per-root filter syntax, and the doctor warning).

## [0.8.8] — 2026-08-27

**The marketplace advertised a version nobody was running, for 18 releases.** Found while auditing tag placement across the repo's history. `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are two hand-edited files that must move together on every release, and nothing checked that they did.

- **The drift, measured across every tag:** `v0.5.8` through `v0.8.1` — eighteen consecutive tags — carry `marketplace.json` `metadata.version` of **0.5.5** while `plugin.json` climbs to 0.8.1. `v0.8.2` and `v0.8.3` then lag by exactly one release (marketplace 0.8.1 and 0.8.2). `v0.8.4` onward are correct. Note what this means for a fix: for the 18-tag stretch, no commit in that range holds a correct `marketplace.json`, so no amount of tag-moving repairs it — only a history rewrite would, which is not worth doing to released versions. Those tags stay as they are; the record is here instead.
- **New `/sf:doctor` check: `version-sync`.** Same shape as the `current-tag` drift check — compare the two real sources rather than trusting that a manual release step ran. Four outcomes, deliberately distinguished: versions equal → `ok`; versions differ → `warn` naming both and stating *which one users actually see*; a version field absent or non-string → `warn` naming the offending field; a file unreadable or missing → `warn` that says **unreadable**, not drift, because a partial install is not a release defect and pointing that reader at a version field would send them to fix the wrong thing.
- **The comparison is `core.versionSyncStatus()`, a pure function.** Doctor resolves the two paths under `PLUGIN_ROOT` (never the project cwd — doctor runs inside the *user's* repo) and hands the parsed objects over. Keeping the logic pure is what makes all four branches testable without fabricating a plugin tree; doctor's own test then pins only the wiring.
- 824 Node tests green (7 new: the four branches, the historical 0.8.1-vs-0.5.5 case, the one-release lag that `v0.8.2`/`v0.8.3` show, and doctor emitting the check against the real plugin tree).

## [0.8.7] — 2026-08-27

**`bin/flow-tools.cjs` split into `lib/` modules, plus one bug the 0.8.6 ship marker exposed.** The pre-commit hook had been warning for two releases straight (2785 LOC at 0.8.5, 2826 at 0.8.6, against a 3000 cap), and both of those releases added to that file.

- **Three modules extracted, behaviour unchanged.** `lib/trace.cjs` (`trace-link`, `trace-build`, `trace-repos`, `trace-impact`), `lib/verify.cjs` (`verify-collect`, `verify-code`), `lib/task-cli.cjs` (the 11 `task-*` wrappers over task-core / tag-manager / dependency-manager / subtask-manager / expand-hook). They follow the pattern `lib/maintenance.cjs` and `lib/drift.cjs` already set: each exports a plain object of command methods, spread into the one flat `commands` table the dispatcher reads, so the CLI contract is byte-identical. `SD_COLS` moved to `lib/core.cjs` — it is a shared data spec, and `route` (still in flow-tools) and `trace-build` (now in trace.cjs) must agree on which cell is the Requirement. `bin/flow-tools.cjs` drops **2826 → 1563 LOC**; no file involved exceeds 750. Verified by diffing the resolved command set before and after: 41 commands both sides, identical names, no collisions across modules.
- **`/sf:doctor` nagged about `currentTag` drift on a feature that had already shipped.** Exposed by this repo's own post-ship doctor run: `native-task-manager-cutover` shipped, `currentTag` had correctly moved on, and doctor kept saying to `use-tag` it back. The hazard the check exists for is state ops landing on the wrong tag *mid-implementation* — a shipped feature has none left to land, so `currentTag` pointing elsewhere is the correct end state, and warning about it is noise that trains the reader to ignore the check. It now reads the 0.8.6 ship marker and reports `ok` for a shipped active feature. An unshipped feature with the identical setup still warns.
- 817 Node tests green (2 new). No test changed to accommodate the split — the same 815 that passed against the single file pass against the modules, which is the point.

## [0.8.6] — 2026-08-27

**The Next Step ladder had no rung for a feature that already shipped.** `verified` was its last one, so `state-update` kept answering *"Done + verified — ship: stage, then `commit` skill (push)"* to a feature whose code was long since on `main`. The session re-anchor hook reads that line and replays it every turn, and no artifact on disk could contradict it — this repo's own `native-task-manager-cutover` was being told to ship for weeks after it had.

- **`state-update --shipped [--ref <sha>]` records the ship** in `specs/<feature>/ship.json`, and the ladder gains a terminal rung above `verified`: *"Shipped `<date>` (`<ref>`) — nothing pending. Revise it with `/sf:change <feature>`, or start the next feature with `/sf:ingest`."* The marker needs its own file because STATE.md is regenerated wholesale on every run — a flag written into it would not survive the next update. Re-running `--shipped` keeps the original `shippedAt` and refreshes `lastShipUpdate`: a feature ships once, then gets revised. `--shipped` requires an explicit `--feature`, same rule as `trace-link` — it is a per-feature write. STATE.md shows a `Shipped:` line, and `state-update` / `status-report` both carry the marker in their Result.
- **Fixed alongside: `trace-build` silently dropped the repo subset declared by `trace-repos --set`.** `trace.repos` is *declared intent* — a multi-repo feature stating which services it targets — and it is the per-feature source of truth that `branch-ensure` reads at branch time (before any code exists, when file-links inference cannot help) and that `verify-code` ranks above file-links evidence. But `trace-build` constructed a fresh trace object on every rebuild with no carry-over, so any `trace-build` after a `trace-repos --set` erased it, and both callers silently fell back to *all* configured repos — widening a feature's branch and gate scope to services it never touched. Same family as the 0.8.5 singletons: durable per-feature data destroyed by an unrelated rebuild. The subset is now carried forward.
- 815 Node tests green (7 new: the unshipped ladder still asking, the marker written and the ladder falling silent, the marker surviving a later plain `state-update`, an idempotent re-ship, the missing-`--feature` refusal, `status-report` surfacing it, and `repos` surviving a `trace-build`).

## [0.8.5] — 2026-08-25

**The per-feature trace fix of 0.7.x cured the file it was aimed at and left every other shared singleton in place.** Raised by a peer agent that saw `trace-build` report `switchedFrom: "bo-txn-export-scale-up"`, found only an `SD.md` in that feature's spec dir, and concluded a parallel session's trace had just been destroyed. It had not — a global trace naming a feature cannot exist without `specs/<feature>/trace.json`, because both writes live in one `try` block, and that dir's mtime proved nothing was ever written into it. The alarm was wrong; the instinct behind it was not. Three neighbours of `trace.json` were still single-copy shared state, and one of them corrupts silently.

- **`trace-link` inferred its write scope from the shared mirror.** `--feature` fell back to `.spec-flow/trace.json`'s active feature — a file any concurrent session rewrites on every `trace-build`. So session B's `trace-link` appended its task→file links into whatever feature session A had built last, and **nothing downstream can detect it afterwards**: Task Master task ids repeat across features, so the foreign entries look native in the victim's `file-links.json`, and from there they reach `verify-code`'s repo scoping and `/sf:change`'s FR→task reopen. The fallback is gone — `--feature` is now required, with an error that says why. Every documented caller (`commands/phase.md`, `agents/hybrid-executor.md`) already passed it; only the undocumented drift path was at risk. `task-baseline --apply` gets the same rule, for the same reason: it writes task statuses. Its dry-run proposal still infers, and reports `featureSource`.
- **`.spec-flow/STATE.md` had no durable copy at all.** `trace.json` got its per-feature twin in 0.7.x; STATE.md never did, so `state-update --feature B` overwrote feature A's position with nothing to restore from — and the session re-anchor hook reads that mirror, which is precisely how a parallel session gets re-anchored onto someone else's feature mid-task. `state-update` now writes the durable `specs/<feature>/STATE.md` **and** the mirror, and returns `switchedFrom` naming the displaced feature, matching what `trace-build` has reported since 0.7.x. `state-update --feature A` restores A's view from A's durable trace at any time. (README's merge-conflict note claimed this was already true of STATE.md. It is now.)
- **`hooks/sd-drift-detect.sh` graded edits against the mirror.** With two features in play the hook checked whichever one was built last, so an edit inside feature A matched nothing while A's trace sat on disk — a silent false negative in a defense layer whose whole job is catching drift. It now scans every `specs/*/trace.json` and matches by file path, which is both mirror-independent and more correct; only a trace that actually owns the edited file contributes FR/task context, so an unrelated feature can never colour a warning. The warning names the owning feature. The global mirror stays a fallback for projects predating per-feature traces.
- **`/sf:doctor`'s `trace-health` reported the mirror as "the" trace.** It now reads the active feature's durable trace, names that feature in the detail line, and says when the name was inferred rather than passed. The three other ad-hoc mirror reads in doctor (`sd-gate`, `current-tag`, `verify-integrity`) collapse into the same resolution.
- **New in `lib/core.cjs`: `resolveActiveFeature()`.** One rule in one place, with the reasoning attached: an explicit `--feature` always wins; reads may fall back to the mirror **but must report `featureSource`** (`explicit` | `mirror` | `none`) so a wrong-feature answer looks wrong instead of authoritative; writes may not fall back at all. `status-report`, `checklist-status`, `wave-plan`, `verify-code`, and `task-baseline` now carry `featureSource` in their Result.
- 808 Node tests green (11 new: 7 pinning the write refusals, the durable STATE.md, `switchedFrom`, and `featureSource`; 4 in a new `test/sd-drift-hook.test.cjs` covering the hook's cross-feature match, its silence on untracked files, the legacy fallback, and a project with no `.spec-flow/`).

## [0.8.4] — 2026-08-25

**The `/sf:doctor` check written to catch `currentTag` drift never read `currentTag`.** Surfaced by a peer agent that found its own project sitting at `currentTag=wcm-vm-p11-face-verify-cert-pay-v2` while `.spec-flow/STATE.md` pointed at `user-re-ekyc-bo-history`, asked whether doctor should warn about that, and was told it already did. It does not.

- **`current-tag` (W3) guessed from the `tasks.json` key list instead of opening `.taskmaster/state.json`.** The check's own comment admitted the shortcut — *"currentTag is stored in TM state, not tasks.json; best-effort"* — and its logic was `tags.includes(activeFeature) && tags.length > 1 → warn, else → ok`. Two failures fall out of that. It **warned whenever a second tag merely existed**, even with `currentTag` already correct, which is noise. Worse, it reported **`ok` "TM tag aligned" for any feature not yet through `parse-prd`**: an unseeded feature owns no tag, so `tags.includes(activeFeature)` is false and the check fell through to its `else`. That is the entire `/sf:ingest` → `/sf:phase` window — the stretch where the SD exists, no tasks do, and doctor is run most — reporting green on a genuinely drifted pointer. A false green is worse than the silence it replaced: 0.8.1 shipped `mcp-shadow` for exactly this failure mode one release earlier, and this check had the same shape. It now calls `task-core._getCurrentTag()` (already written, already exported, previously unused here) and compares the real value: absent → warn, mismatched → warn naming both sides, equal → ok. The `tags.length` heuristic is gone.
- Why it matters beyond a tidier report: `commands/phase.md` writes **CRITICAL** over this exact hazard, because Task Master MCP state ops bind to the global `currentTag` and may ignore a per-call `tag:` param — so a stale pointer makes `set_task_status` / `update-subtask` land on another feature's tag **silently**, with no error. Note the blast radius stops there: `status-report` reads the active feature from `.spec-flow/trace.json` and `checklist-gen` derives it from the SD path, so `/sf:status` and `/sf:checklist` were never affected. Only the TM side reads `currentTag`.
- 797 Node tests green (4 new, covering the pre-`parse-prd` false green, the multi-tag false positive, an unset `currentTag`, and a project with no `.taskmaster/` where the check is skipped entirely).

## [0.8.3] — 2026-08-21

**A dogfooding finding from two parallel worktrees on the same feature.** Two SDs of one epic (`wcm-vm-p10`, `wcm-vm-p11`) were being implemented in separate git worktrees at once. One suspected bug turned out not to be one; the other was real.

- **Ruled out: shared `.taskmaster/state.json` across worktrees.** `/sf:status` in the P10 worktree started reporting P11's `currentTag`. Audited every read/write of `.taskmaster/state.json`, `tasks.json`, and `.spec-flow/STATE.md` in `task-core.cjs` and `flow-tools.cjs`: all of them resolve strictly off `process.cwd()`, with no upward directory search and no `git rev-parse --git-common-dir` shortcut that would collapse two worktrees onto one root. Two genuinely separate `git worktree` directories cannot cross-write through this code — the symptom is environmental (most likely a long-lived MCP `task-master-ai` server whose cwd was pinned at spawn and did not follow a later worktree switch), not a spec-flow defect. No code change; noted here so the investigation isn't repeated.
- **Real bug: `parse-prd` had no code-level SD-approval gate.** `commands/ingest.md` STEP 8 tells the agent "refuse to call `parse_prd` while any `TODO:MANUAL-REVIEW` remains ... STOP and hand back to the human" — but that was prose only. `lib/maintenance.cjs`'s `sd-gate` doctor check only ever `warn`s, and `_handleParsePrd` had zero check against the SD's TODO markers or an approval flag. The P11 SD, not yet approved and missing its last four changes, still got `parse-prd`'d into 13 seeded tasks in the other worktree, because nothing in the tool stopped the call. `_handleParsePrd` now counts `TODO:MANUAL-REVIEW` markers in the `--input` file via the existing `core.countSdTodos()` and refuses with `SD_NOT_APPROVED` unless `--force` is passed — same override convention `sd-skeleton`/`checklist-gen` already use.
- 793 Node tests green (3 new).

## [0.8.2] — 2026-08-13

**A `|` inside an SD table cell silently corrupted the trace built from it.** Found reviewing an SD whose §5.1 describes a signature payload joined by `|` and whose §12.2 trigger names a status enum — both perfectly ordinary things for a requirement to say, and both unreadable to the engine.

- **`splitRow()` split on every `|`, including an escaped `\|`.** The escape is what markdown requires to keep a literal pipe inside a cell, so a correctly-written SD was exactly the case that broke: the row gained columns, and every reader after the pipe landed one cell off. This repo's own `contract-shim` SD is the demonstration — its `ERR_INVALID_STATUS` row parsed as **12 cells against a 6-column header**, with `Trigger` cut short at ``…tập `pending`` and the rest of the enum scattered across columns that do not exist. Downstream, `trace-build` stored the truncated requirement and read `priority`/`source` out of their neighbours, and `route` scored complexity on the cut-short text before picking fast/expand/deep. `splitRow` now splits on `(?<!\\)\|` and **unescapes `\|` → `|`** on read, so the value that reaches code, YAML, or a payload is the plain U+007C character — the backslash is a rendering artifact and never leaves the document.
- **Pass-1 was the source: `genSd` interpolated raw SRS prose straight into cells.** New `core.mdCell()` escapes on write at all 13 interpolation sites (revision history, §5.1 from AC / edges / BL rules / the ID-prefix fallback, §5.2 NFR, §10.4 state, §12.2 error triggers, §13.2 TC, glossary). It round-trips losslessly with `splitRow` and does not double-escape an SRS that already writes `\|` itself. The generated §5.1 now carries a one-line note that the escape is markdown-only and the value is U+007C — a `\` copy-pasted out of a rendered cell into code is a silent data bug that no test catches.
- **`trace-build` resolved all five SD tables by column position.** New `core.resolveCols(table, spec)` claims each column by header name, falling back to the canonical Pass-1 position (and never to `-1`, which would read undefined cells). Applied to the FR / TC / error / state / NFR tables in `trace-build` and to `route`, which was destructuring `[id, req, prio, src]`. The 0.8.0 `tcExpIdx` special case folds into it, keeping its length-aware fallback (6-col enriched → index 4, 4-col skeleton → 3). `route` and `trace-build` now share one FR column spec (`SD_COLS`): they must agree on which cell is the Requirement, or a routed FR and its trace node describe different things.
- **A shape-broken table now says so.** `core.tableShapeWarnings()` flags any row whose cell count differs from its header — naming the offending row id and its real count, and pointing at the unescaped `|` — surfaced by `trace-build` (all five tables) and `route` (§5.1). It warns, never blocks: the SD stays readable to a human, and the trace built from it is wrong without looking wrong, which is the half nobody catches by eye. `route`'s Result gains a `warnings` field.
- **The rule is written down where SDs are authored.** `agents/sd-author.md` now requires escaping a literal `|` as `\|` in cell content, *and* requires a line under the table whenever a requirement or payload genuinely uses `|` as a delimiter, stating that the delimiter is the plain character. `templates/sd-template.md` §5.1 carries the same convention for hand-written SDs.
- README's test counts were stale (88 engine / 44 checklist-runner).
- 790 Node tests green (8 new), 65 Python tests green (unchanged).

## [0.8.1] — 2026-08-05

**A dogfooding finding: `/sf:change` dead-ended on a missing MCP tool it never needed.** An agent running `/sf:change` had to add a task for a net-new FR, found no `add_task` in the MCP surface, found no `add-task` in `bin/task-master` either, and handed the work back to the user as "tooling unavailable". Two separate defects made that dead end reachable.

- **The command docs pointed at exactly one way to add a task, and it was the fragile one.** `commands/change.md` step 4 named `mcp__task-master-ai__add_task` with no alternative, and `commands/phase.md`'s Task Master note scoped its CLI fallback to a single trigger — *"if any MCP TM call errors with a missing API key"* — which does not cover a tool that is simply absent from the surface. Meanwhile the deterministic twin had shipped with the native engine all along: `flow-tools.cjs` `task-add` / `task-get` / `task-list` / `task-set-status` / `task-next` write the same `.taskmaster/tasks/tasks.json` with no AI and no MCP, and **none of them were documented anywhere** — not in the command files, not in the README engine table. The agent's conclusion was correct given what it could read. `commands/phase.md` now carries the full MCP-op → engine-CLI mapping table and a fallback that fires on *absent tool* as well as provider error; `change.md` and `resync.md` inline the two ops they actually need (`task-add`, `task-set-status`) and state that a missing MCP tool is never a reason to stop; the README documents all five commands. Note the twins live in `flow-tools.cjs`, **not** in `bin/task-master` — that CLI deliberately carries only AI ops plus `use-tag`/`init`/`models`/`tasks-import`, which is the other half of why the agent's search came up empty.
- **`/sf:doctor` could not see the actual cause: a project-level `.mcp.json` shadowing the bundled server.** The target project still had its own `mcpServers["task-master-ai"]` entry (`npx task-master-ai`, `TASK_MASTER_TOOLS=core`) left over from a pre-cutover `task-master init`. That entry wins over the plugin's manifest, so the session was talking to a legacy core-tier server whose 7-tool surface has no `add_task`. The existing `dep-lock` check reads `.mcp.json` at the **plugin root** only, so it cheerfully reported "native task engine bound" while the live binding was legacy — a green check on a broken surface. New `mcp-shadow` check reads `.mcp.json` in the **project cwd** and warns when a `task-master-ai` entry there is not the native binding, naming the tier and the two fixes (drop the entry, or point it at `${CLAUDE_PLUGIN_ROOT}/bin/mcp-server.js`); it is skipped when cwd *is* the plugin root, so the repo-as-project case does not false-positive.
- 782 Node tests green (2 new).

## [0.8.0] — 2026-08-03

**Five dogfooding findings from an external multi-repo, multi-database project.** The first is a test-integrity bug; the rest are gaps that forced manual workarounds.

- **`setup:` / `teardown:` sql `expect:` was silently ignored — every pre-state guard was decoration.** `checklist_lib/setup.py` `_do_sql()` captured the scalar and returned; it never looked at `expect:`. Meanwhile `templates/CHECKLIST.yaml` and `references/test-rigor.md` both ship the exact form (`expect: CREATED  # pre-state confirmed`) as the recommended way to confirm a seed landed. This is worse than having no guard: a checklist written from the template *looks* baseline-verified, so a wrong seed lets the test run anyway and PASS for an unrelated reason. Scalar `expect:` is now a hard assertion that aborts the setup (mismatch → the test FAILs with the query and both values); dict `expect:` stays descriptive, same rule as a `verify:` block; in `teardown` it degrades to a warning like every other teardown failure. `sql._check_scalar` → `sql.check_scalar` (now used by two modules). Documented in `references/checklist.md`. 6 new Python tests.
- **`db_ref:` — multi-database support, the DB-side twin of `base_url_ref:`.** `ctx["db"]` was one database name for the whole run while HTTP already had `base_urls` + `base_url_ref`, so a feature spanning two services could only be SQL-verified on the near side; the far side had to be inferred from an HTTP side-channel (`GET /{id}/status → 404`), which is a weaker assertion than reading the row. New `config.databases` declares named alternates — either a plain database name (same server) or a mapping of `database`/`host`/`port`/`user`/`password` — and `db_ref: <name>` selects one on any sql step: `setup`, `teardown`, `seed`, a `verify[]` item, `expect.poll`, and `cleanup`. Fields left unset still come from `db-creds.sh` discovery, so a second database on the same server needs only its name. An **undefined ref fails** rather than falling back to the default database — a silent fallback would query the wrong server and report a green PASS. `db-query.sh` gained `--host/--port/--user/--password` (the existing `-d` only ever overrode the database *name*, which is why a service on another port was unreachable). `lint-checklist.sh` now rejects an undeclared `db_ref` *or* `base_url_ref` at lint time instead of mid-suite. 11 new Python tests.
  - Related, same class as the `expect:` bug: `templates/CHECKLIST.yaml` advertised `config.db.host/port/username/password`, none of which the runner reads — credentials always come from `db-creds.sh`. The template now declares only `database:` and says where the rest comes from. Precedence is deliberately unchanged: honouring those fields would let the template's `${DB_PASS:-postgres}` placeholder override a correct `application.yml` discovery on exactly the primary supported stack.
- **`detect-auth.sh` ignored `config.repos`, so multi-repo projects got an inverted answer.** The detector ran against the cwd. In a spec-flow hub that holds only the SRS/SD while the services live in sibling repos, there is no service code to fingerprint — so a Summer/APISIX project classified as a custom-Bearer one, i.e. exactly backwards, and every generated test 401s. It now reads `.spec-flow/config.json` → `repos`, classifies each declared repo, and reconciles: one signal wins (and that repo's own hints are forwarded); repos that genuinely disagree report `CONFLICT` and fall back to `unknown` rather than picking a scaffold that is wrong for the others; a missing repo path is reported and skipped. Single-repo projects take the unchanged path. Also fixes a latent bug this exposed — `HERE` was computed *after* `cd "$ROOT"`, resolving a relative `$0` against the wrong directory.
- **`checklist-gen` tagged nearly every test `smoke`.** The rule was `Edge:`-prefixed test-case name → `regression`, everything else → `smoke`, so an SD whose §13.2 doesn't use that naming convention (most of them) produced an all-smoke checklist: `--tag smoke` ran the entire set and the smoke → regression escalation the skill documents stopped meaning anything. Now the **first non-edge TC of each Flow** is that flow's smoke test and every other TC is regression — one smoke test per user story. Suite tags reflect what their tests actually carry.
  - Found while testing the above: `hasApiSection` (`/^#{2,3}\s*9(\.\d+)?\s+API/`) did not match `## 9. API Design` — the exact heading `templates/sd-template.md` emits — only the `### 9.2 API Endpoints` subsection. An SD with §9 but no §9.x subsection silently classified as `internal` and got the live-e2e scaffold instead of an HTTP stub.
- **`TODO:MANUAL-REVIEW` counting had one loose copy left, and the command docs told the agent to grep by hand.** 0.7.1 anchored the regex in `status-report` and `doctor`, but `genSd`'s own `stats.todoManualReview` still used a line-wise `/TODO:MANUAL-REVIEW/` — which matches the Pass-1 preamble banner it emits two lines earlier. Worse, `commands/{ingest,resync}.md` just said "count remaining markers", so the agent ran a bare grep and counted revision-history entries and sd-author's `TODO:MANUAL-REVIEW remaining: 0` summary as unresolved — a clean, approved SD reported 3 outstanding TODOs and the gate blocked work that was ready. The regex now lives once, as `core.countSdTodos()`, used by all four call sites; the command docs give the anchored `grep -cE '^> \*\*TODO:MANUAL-REVIEW\*\*'` and point at the reported count instead.
- 780 Node tests green (2 new), 65 Python tests green (17 new).

## [0.7.4] — 2026-07-31

**Three dogfooding bugs**, all found running spec-flow against an external Node/Express project (`claude-code-provider` / `tenant-usage-monitoring`). None are in the target project's code — all three are spec-flow defects that cost real debugging time.

- **`bin/task-master` was invoked cwd-relative in the skill instructions.** `commands/{phase,ingest,init,change,resync}.md` and `agents/hybrid-executor.md` told the agent to run `node bin/task-master …`, but those commands execute in the *user's* project, which has no `bin/task-master` — the binary lives in the plugin. Result: `MODULE_NOT_FOUND`, and the agent had to hand-resolve the plugin's absolute path to continue. Now `node ${CLAUDE_PLUGIN_ROOT}/bin/task-master …`, matching how every `flow-tools.cjs` invocation was already written. Root cause: `scripts/cutover.cjs`'s `NATIVE_CLI_PREFIX` (v0.7.0) rewrote the old `npx` invocations to a relative path. The cutover/rollback script pair is left as-is — it is one-shot historical migration tooling and the legacy dependency it targets is already removed. `docs/` invocations are unchanged: those are run from the spec-flow repo root, where the relative path is correct.
- **`detect-auth.sh` missed custom `Authorization: Bearer` schemes, and `checklist-gen` defaulted the wrong way.** Two compounding bugs. (1) The detector classifies by *dependency* fingerprint (`jsonwebtoken`, `jjwt`, `pyjwt`, …), so a service that reads the `Authorization` header itself and validates an opaque API key — no JWT library anywhere — fell through to `unknown`. It now also greps the source for header-read + `Bearer ` prefix, across every stack, and reports `jwt-basic` (same wire form; only how you mint the token differs). (2) `checklist-gen` treated the Summer/APISIX `payload:`/`X-Userinfo` form as the *default* and `bearer:` as the special case — exactly backwards. `X-Userinfo` is a Summer/APISIX-specific convention that is only trusted behind a real gateway upstream; an unclassified project got a scaffold that 401s **every** generated test with a failure that reads like an app bug. Now inverted: only an explicitly-detected `summer` project gets `payload:`; `jwt-basic`, `session`, `no-auth`, and `unknown` all scaffold `bearer: "${TOKEN}"` with an advisory comment naming the detected type. (Hit twice in one session, on two different projects.)
- **`token: none` failed instead of sending an unauthenticated request.** The natural way to write a 401 / public-endpoint test — `token: none` — was looked up as a token *named* `"none"` in the `tokens:` map, missed, and failed the test with `unknown token 'none'`. The working spelling (omit the `token:` line entirely) was documented nowhere. `checklist_lib/runner.py` now treats `none` / `null` / `no-auth` / `noauth` / `anonymous` / `false` / `-` as "send no auth header", while a token genuinely declared under that name still wins (backward-compatible). The error for a real typo now lists the declared token names and points at the no-auth spelling. Documented in `references/checklist.md`, `templates/CHECKLIST.yaml`, `commands/checklist.md`, and the generated scaffold's own header comment.
- **`.mcp.json` made plugin-root-absolute too** (same root cause as the first item): the bundled MCP server entry was `["bin/mcp-server.js"]`, now `["${CLAUDE_PLUGIN_ROOT}/bin/mcp-server.js"]`. Caveat: `${CLAUDE_PLUGIN_ROOT}` is only defined when the file is loaded as a *plugin* manifest — opening the spec-flow repo directly as a project no longer resolves it. Plugin distribution is the primary path, so that is the right trade; revert this one line if you need the repo-as-project case back.
- 778 Node tests green (assertions updated for the flipped auth default), 48 Python tests green (5 new).

## [0.7.3] — 2026-07-30

**`checklist-gen` bugfix** — unrelated to the native-task-manager cutover, found while dogfooding a plain-JWT project.

- `bin/flow-tools.cjs` `checklist-gen` always scaffolded the `tokens:` block with the Summer/APISIX `payload:` form (base64 → `X-Userinfo` header), regardless of the target project's real auth model. A plain REST + JWT project (Spring OAuth2 resource server, or any Node/Python/Go/dotnet JWT setup) got a scaffold that 401s on every single test, since those apps expect `Authorization: Bearer`, not `X-Userinfo` (which is only trusted behind a real APISIX gateway upstream to begin with — see `references/auth.md`).
- Now reuses the manual-test skill's existing `scripts/detect-auth.sh` (the same heuristic already used to route which auth reference doc to read) to classify the project; `jwt-basic` scaffolds `bearer: "${JWT}"` instead. `--auth <type>` overrides detection explicitly; anything else (`summer`, `session`, `no-auth`, `unknown`) keeps the prior `payload:`/`X-Userinfo` default, with an advisory comment pointing at the `bearer:` alternative when the detected type isn't `summer`.
- `commands/checklist.md` documents the auto-detection and the `--auth` override.
- 778 tests green (2 new).

## [0.7.2] — 2026-07-29

Patch follow-up to 0.7.1 — no behavior change.

- **`/sf:doctor` drops the stale `npx-available` check** (`lib/maintenance.cjs`): native is zero-network and never shells out to `npx`; the check was a leftover from the pre-cutover era. Also removes the now-unused `execSync`/`child_process` require in `doctor()`.

## [0.7.1] — 2026-07-29

Follow-up cleanup for the 0.7.0 native cutover — no behavior change, docs/metadata only.

- **`.claude-plugin/marketplace.json`**: `_notes` still described the task engine as "auto-fetched via `npx -y task-master-ai`" — the text shown in plugin info/marketplace listings. Updated to describe the bundled, zero-network native engine.
- **Bare `task-master` mentions fixed**: `commands/change.md`, `commands/resync.md`, `commands/phase.md`, and `docs/ai-hybrid-usage.md` had a few inline mentions of `task-master <subcommand>` / `npx task-master <subcommand>` without the `node bin/` prefix. `scripts/cutover.cjs`'s regex only rewrote the exact `npx -y -p task-master-ai@0.43.1 task-master ...` invocation form; these were prose mentions in a different shape that slipped through. Confirmed via a live incident: a bare `task-master` on `$PATH` resolves to whatever global npm/homebrew install exists on the machine (a real, separate `task-master-ai` install) — not this plugin's own `bin/task-master` — so an agent following the un-prefixed doc text could silently call the wrong, unrelated binary.

## [0.7.0] — 2026-07-29

**native-task-manager cutover — official release.** The native engine shipped dark-launch in 0.6.0 (opt-in, default `legacy`); this release makes it the sole, unconditional default and removes the third-party dependency it replaces. Skipped the planned C-6 real-feature soak — this is a direct-to-native cutover.

- **Default flipped to native**: `.mcp.json` and the `parse-prd`/`analyze-complexity`/`update`/`use-tag` invocations in `commands/{ingest,init,phase,resync}.md` now point at the bundled `bin/mcp-server.js` / `bin/task-master` (`node`, not `npx`). `engine-selector.cjs` / `engine-router.cjs` now default to `'native'` when `taskCore.engine` is absent or unset (previously defaulted to `'legacy'`); an unrecognised `taskCore.engine` value also now falls back to `'native'` (never legacy, a removed dependency).
- **`task-master-ai@0.43.1` removed**: dropped the pin from `DEPENDENCIES.md`; no `.mcp.json` or CLI invocation fetches it anymore. `lib/maintenance.cjs`'s `/sf:doctor` `dep-lock` check now verifies the native binding instead of a task-master-ai version pin.
- **Rollback kept as an escape hatch** (not removed): `taskCore.engine: "legacy"` is still a supported explicit value — `engine-router.cjs` returns the `ERR_LEGACY_MODE` fail-open envelope for it — and `scripts/rollback.cjs` / `scripts/cutover.cjs` still work for emergency recovery. Since the soak (C-6) never ran, this is deliberate insurance.
- Docs updated (`README.md`, `DEPENDENCIES.md`, `agents/hybrid-executor.md`, `skills/srs-to-sd/SKILL.md`) to drop "auto-fetched via npx" framing in favor of "bundled, zero-network".
- Verified: 776 unit tests green (updated default-engine assertions across `engine-selector`, `engine-router`, `engine-bootstrap`, `remove-legacy-dep`, `integration-contract` test suites), `equivalence-verify` (C-2) and `doctor-contract` (C-4) gates both pass.

## [0.6.0] — 2026-07-28

**native-task-manager** — a self-built, zero-dependency drop-in replacement for the third-party `task-master-ai@0.43.1` task engine. Shipped **dark-launch**: `taskCore.engine` defaults to `legacy`, so nothing changes until a project opts in with `taskCore.engine: "native"`. Removing the old package (`DEPENDENCIES.md` pin + `.mcp.json` entry) is deferred until the native engine has soaked through real features — the rollback safety net stays.

- **storage-core** (`lib/task-core.cjs`): atomic tag-keyed `tasks.json` store + 6 CRUD ops, byte-compatible with the legacy schema (reads legacy files with zero migration).
- **tags-deps** (`lib/tag-manager.cjs`, `dependency-manager.cjs`, `subtask-manager.cjs`, `expand-hook.cjs`): tag isolation, dependency graph with cycle detection, subtasks.
- **contract-shim** (`lib/mcp-server.cjs`, `engine-router.cjs`, `cli-dispatcher.cjs`): dependency-free JSON-RPC MCP server (5 tools) + 9-subcommand CLI + `models` no-op shim, byte-compatible with the legacy surface. No MCP SDK — pure Node, honoring the repo's zero-dependency convention.
- **ai-hybrid** (`lib/ai-router.cjs`, `agent-native-driver.cjs`, `task-importer.cjs`, `headless-fallback-provider.cjs`, `two-phase.cjs`): agent-native AI ops (parse-prd/expand/analyze/research) driven by the orchestrator host as the LLM — zero-network core, host detected via `CLAUDECODE` / `SPEC_FLOW_HOST_AGENT`; optional minimal headless HTTP fallback (off by default). `ERR_AI_HOST_REQUIRED` instead of silently seeding zero tasks.
- **cutover** (`lib/engine-selector.cjs`, `engine-bootstrap.cjs`, `equivalence-verify.cjs`, `doctor-contract.cjs`, `cutover-monitor.cjs` + `scripts/{cutover,rollback,remove-legacy-dep}.cjs`, `docs/cutover-runbook.md`): opt-in engine flip with a one-commit / one-revert flip, equivalence-verify go/no-go gate, `/sf:doctor` contract check, and instant rollback (shared schema, zero data loss).
- Verified: 776 unit tests; live equivalence diff vs the real legacy CLI; sandbox flip→doctor→rollback rehearsal. Benchmarked **~29× faster per task op** (`~2.8s` npx-spawn per legacy CLI call → `~95ms` native).

## [0.5.18] — 2026-07-21

New token-def form for `/sf:manual-test` auth, for services that expect a pre-minted JWT rather than a grant flow.

- **`skills/manual-test/scripts/checklist_lib/auth.py`**: fourth token form `bearer: '<jwt-or-${ENV_VAR}>'` — resolves a literal token straight to an `Authorization: Bearer <token>` header (override the header name with `header:`). String fields are still `${VAR}`-expanded, so a token can be injected from the environment. Fails loudly (`RuntimeError`) when the value resolves empty, so a missing env var can never be sent as an empty `Bearer` header. Joins the existing `keycloak_ropc` / `keycloak-client-credentials` / `payload` forms.

## [0.5.17] — 2026-07-21

- **`skills/manual-test/scripts/checklist_lib/setup.py`**: `_do_http` read the `capture:` map off `h` (the headers dict) instead of `sb` (the setup step block), so any `capture:` declared on a setup HTTP step silently resolved nothing — captured vars were never set. Read the map off `sb`. No behavior change for steps without `capture:`.

## [0.5.16] — 2026-07-21

Per-feature verification state was being read from a single global file, so one feature's close-out leaked into another's status.

- **`bin/flow-tools.cjs` / `lib/maintenance.cjs`**: `status-report`, `state-update`, and doctor's `verify-integrity` check all read a single global `.spec-flow/VERIFICATION.md`. With per-feature specs, that surfaced a prior feature's `verified` flag and live gaps as the active feature's status (e.g. `wiki-core` showed `platform-foundation`'s leftover gaps). All three now read `.spec-flow/specs/<feature>/VERIFICATION.md`, matching the per-feature path `task-baseline` already used; `status-report` guards a null feature. Regression test asserts a stale global file does not leak. Tests: 117.

## [0.5.15] — 2026-07-20

The single biggest cost on a multi-task SD: `verify-code`'s `tests` check ran the **full** `testCommand` on every task close (up to a 10-minute timeout, N times for N tasks) — for a Java/Gradle project this can dominate total phase wall-clock. Explicit tradeoff accepted for this fix: per-task speed over per-task full-regression coverage — a regression introduced by task 3 may now only surface at phase close-out instead of immediately; you fix it there instead of paying the full-suite tax on every task.

- **`verify-code`**: new opt-in `--task <id>` and `--files "a,b"` flags. `--task` looks up the files `trace-link` recorded for that task (`file-links.json`) and derives a scoped test filter; `--files` takes an explicit list directly (for the RED-phase call, which runs *before* `trace-link` has anything to look up). `java-spring`/`java-maven` convert `src/test/(java|kotlin)/...` paths to FQCNs and append `--tests "<fqcn>"` (Gradle) / `-Dtest=<fqcn,...>` (Maven) to the configured `testCommand`. Other stacks need an explicit `config.verify.taskTestCommand` template (a `{files}` placeholder) or fall back to the full suite — never breaks, never silently mis-scopes; the result's `testsScoped`/`scopeNoteTests` fields say which happened. No `--task`/`--files` at all → byte-identical to the old behavior. Multi-repo: file-root matching strips the `<repo>/` prefix before deriving the FQCN, so scoping is correct per-repo. 7 new tests.
- **`commands/phase.md` step 4 (Automated quality gate)**: now always passes `--task <id>`.
- **`agents/hybrid-executor.md` step 3 (RED confirm)**: now passes `--files "<the test file(s) just written>"` instead of running the full suite to confirm one new test is red.
- **`commands/phase.md` Phase close-out**: new step 1a runs `verify-code` **once**, unscoped (no `--task`), before the existing checklist regression sweep (renumbered 1b) — this is where cross-task regressions the per-task scoped checks couldn't see get caught, now that the full suite no longer runs on every task.
- Tests: 117 (110 + 7 new).

## [0.5.14] — 2026-07-20

Found live in a project running `/sf:phase` on a 15-task SD: `.taskmaster/config.json` had drifted to `main`/`research` = `claude-code`/`opus` (process exited code 1 on every call — plan/account likely doesn't have Opus enabled for that session) with `fallback` = `anthropic` and no `ANTHROPIC_API_KEY` anywhere. All three roles in the retry chain failed, `update-task --append` errored outright, and the failure only surfaced after burning a task's worth of time on retries — the per-task loop had no way to see this coming.

- **New engine command `taskmaster-model-check`** (`bin/flow-tools.cjs`): pure, zero-subprocess preflight. Reads `.taskmaster/config.json`, and for each role (`main`/`research`/`fallback`) on a keyed provider (`anthropic`, `perplexity`, `openai`, `google`, `groq`, `xai`, `openrouter`, `mistral`, `azure`) checks that its required `*_API_KEY` is present in `process.env` or a project `.env` file. `claude-code`/`ollama` are keyless and never flagged. Returns `{checked, clean, problems[]}` — `checked:false` (no `.taskmaster/config.json` yet) means nothing to check. 6 new tests.
- **`commands/phase.md`**: wired `taskmaster-model-check` in right after `use-tag`, before any per-task AI-op — a broken role is now surfaced once, up front, instead of discovered mid-phase.
- **`commands/phase.md` Per-task loop, step 3**: `update-task --append` failures are now explicitly **non-blocking** — on error, surface it once and proceed straight to `trace-link`/`set_task_status` (the actual disk facts) instead of retrying in a loop or halting the phase over what is documented as optional history.
- **`commands/phase.md` Per-task loop, step 1**: `wave-plan`'s ready (dependency-satisfied) set is now checked before `next_task`; if ≥2 ready tasks look file-disjoint (judged from `title`/`details` — `wave-plan` itself has no file data to prove disjointness, since files aren't known until a task is implemented), the orchestrator spawns one `hybrid-executor` per task in the same turn instead of working strictly one-at-a-time. Removed the old passive "Tip" line this replaces.
- No change to `taskmaster-model-plan`'s own behavior or tests. Tests: 110 (104 + 6 new).

Follow-up to `0.5.12`: one `node -e` JSON re-parse site was missed.

- **`commands/phase.md`**: the `update-task --append` override block (Per-task loop, step 3) still chained two `node -e "JSON.parse(...)"` calls to pull `configured`/`previous` — the grep pass for `0.5.12` covered the other 4 call sites (`parse-prd` x2, `analyze-complexity` x2, `expand`, `research`) but missed this one. Same fix applied: the agent reads `taskmaster-model-plan`'s JSON directly and substitutes `configured`/`previous` as literal values into the `trap`-guarded block. Verified via full-repo grep — zero `node -e "console.log(JSON.parse` sites remain.
- No behavior change. Tests: 104 (unchanged).

## [0.5.12] — 2026-07-10

Two pattern-consistency fixes found while auditing `0.5.11`'s own diff against project conventions.

- **`commands/ingest.md` / `commands/phase.md`**: the `taskmaster-model-plan` override blocks (5 call sites: `parse-prd`, `analyze-complexity`, `expand`, `research`, `update-task`) each re-parsed the plan's JSON via three chained `node -e "JSON.parse(...)"` calls to pull `needsChange`/`configured`/`previous` into shell variables — the only place in the entire command set that shells out to parse a `flow-tools.cjs` result instead of having the agent read the JSON directly. Removed all 15 `node -e` calls; the agent now reads the plan's JSON itself and substitutes `configured`/`previous` as literal values into the (still `trap`-guarded) set → op → restore block.
- **`agents/hybrid-executor.md`**: the only guidance for matching the target project's existing code conventions was one generic line ("Follow existing project patterns" / "Match surrounding code style") — no concrete action, unlike `sd-author.md`'s error-code rule ("grep the codebase for existing error enums and mirror their shape"). Added a required step: before writing any new file or function, find the closest existing analog already in the repo (same kind — controller/service/repository/test) and mirror its concrete conventions (naming, layering, error handling, import order, test structure); also now reads `project-author.md` for stack conventions, not just `config.json → stack`.
- No behavior change to `taskmaster-model-plan` itself or its test suite — this release only touches how the command docs and the executor agent are worded. Tests: 104 (unchanged).

## [0.5.11] — 2026-07-08

`config.json → models.taskmaster` — project-scoped model override for Task Master's own CLI (`parse-prd`, `analyze-complexity`, `expand`, `research`, `update-task`), not just Agent-tool spawns.

- **Gap: no lever for Task Master's own model.** `models.sdAuthor`/`hybridExecutor` (0.5.9) only affect Agent-tool spawns inside the session — Task Master CLI (`npx task-master-ai`) is a separate subprocess with its own `.taskmaster/config.json`, untouched by that mechanism. A project wanting "always opus for AI-ops" had no way to apply it automatically.
- **Live-tested and ruled out: env-var injection.** `TASKMASTER_MODEL_MAIN`/`RESEARCH`/`FALLBACK` exist in Task Master's source (`EnvironmentConfigProvider`) but were confirmed via direct testing (baseline vs. override `parse-prd` runs, telemetry compared) to have **no effect** on the local file-storage CLI path — likely wired only for a newer cloud-sync storage mode. A full implementation built on this mechanism was reverted mid-session once proven false; do not reintroduce it.
- **Live-verified mechanism that actually works:** `task-master models --set-main/--set-research <model> --claude-code` writes directly to `.taskmaster/config.json`, confirmed twice independently (file content before/after, plus `parse-prd` telemetry showing the overridden model).
- **New engine command `taskmaster-model-plan --role <main|research>`** (`bin/flow-tools.cjs`): pure — reads `config.json → models.taskmaster.<role>` and `.taskmaster/config.json → models.<role>.modelId`, returns `{needsChange, configured, previous}`. No subprocess, no network, <50ms.
- **`commands/ingest.md` / `commands/phase.md`** wrap every Task Master AI-op call site: plan → conditional `models --set-<role>` → the AI-op → **unconditional** restore via bash `trap ... EXIT` (fires even if the AI-op fails) — no `jq` dependency, uses `node -e` for JSON field extraction.
- **`config.json → models.taskmaster`**: `{main: "sonnet", research: "sonnet"}` seeded by `/sf:init`, patched into existing configs. No `fallback` key — no CLI op selects that role via a direct flag.
- **Three unrelated bugs fixed along the way** (found while filling this feature's own CHECKLIST.yaml — all pre-existing, unrelated to `models.taskmaster`):
  - `checklist-status`: classification scanned the whole test body including checklist-gen's own scaffold-hint comments (which mention both `[no-verify]` and `[live-e2e]` in prose), so a genuinely `live-e2e` test always misclassified as `no-verify`. Now strips comment lines before matching — only the real `tags:` line drives classification.
  - `status-report`: the checklist summary counted raw `TODO` text anywhere in the file, including checklist-gen's own header comment and the default cleanup stub — a fully-filled checklist could still read `scaffold (N TODO)`. Now strips comments before counting.
  - `verify-code` (`forbidden-patterns`): scanning `scanPath: "."` hit a markdown doc's own `node -e "console.log(...)"` CLI-usage example — a real code sample, not leftover debug code. `.md`/`.mdx` files are now excluded from this JS-code-smell check.
- Tests: 88 → 104 (`taskmaster-model-plan` decision matrix incl. no-subprocess proof; `init-project` seed/patch/idempotency; the three fixes above each got a regression test).

## [0.5.10] — 2026-07-03

Checklist runner: `config.vars:` and the `- vars:` setup step actually work.

- **Bug: the runner ignored `config.vars:` entirely.** `runner.main` only read `config.base_url`, `config.base_urls`, and `config.db` — variables declared under `config.vars:` never reached the `VarStore`, so `${VAR}` expansion silently fell through to `os.environ` (empty string if unset). The docs' "Variable Resolution" order promised config values resolve first; the code never implemented it.
- **Fix (`checklist_lib/runner.py`):** `config.vars:` entries load into the `VarStore` first — before `base_url`/`db` expansion, so those can reference them. Values are themselves expanded on load, so `FOO: ${FOO:-default}` keeps an env override possible and later vars can reference earlier ones.
- **Same-family gap: "test-level `vars` in setup blocks"** (docs resolution step 3) had no corresponding setup step — `setup._run_one` only handled `sql | seed | http | redis | exec`. New `- vars: {NAME: value}` step sets variables inline (expanded), and runs on dry-run too (inert, and later step labels may reference the vars).
- Docs (`references/checklist.md`): Variable Resolution section rewritten to match the implemented order; setup-step lists and the `config:` shape line now include `exec` and `vars`. Template `CHECKLIST.yaml` gains a commented `config.vars:` example.
- Tests: 40 → 44 (config.vars expands into `base_url` via dry-run `runner.main`; env-override pattern; `vars` setup step expansion; dry-run behavior).

## [0.5.9] — 2026-07-02

Per-agent model overrides move from hardcoded frontmatter to project config.

- **`sd-author` no longer pins `model: sonnet`** — it now inherits whatever model is driving the main session, matching how every other prompt-level agent behaves by default.
- **New `config.json → models` block** (seeded by `/sf:init`, patched into existing configs): `{ "sdAuthor": null, "hybridExecutor": "sonnet" }`. `null` = inherit the main session's model; a string pins that agent to a specific model regardless of the agent file's own frontmatter default.
- **`/sf:ingest`, `/sf:resync`** — the sd-author spawn step now reads `models.sdAuthor` and passes it as the Agent tool's `model` param when set.
- **`/sf:phase`** — the hybrid-executor spawn step now reads `models.hybridExecutor` (still `sonnet` by default) and passes it the same way.
- Tests: 86 → 88 (`config.models` seeded on fresh init; patched into a pre-existing `config.json` missing it).

## [0.5.8] — 2026-07-02

`config.language` goes session-wide.

- **Bug: the language directive only fired on flow-referencing prompts.** The anchor hook gated BOTH the language directive and the STATE re-anchor behind the `/sf:|spec-flow|srs|solution design` prompt filter — so a project with `language: vi` still got English replies on ordinary questions (docker, debugging, anything not naming the flow). A user who sets a language expects every reply in the project to use it.
- **Fix (`hooks/spec-flow-anchor.sh`):** the language directive now fires on **every prompt** in a spec-flow project (still only when `config.language` is set and ≠ `en`), compacted to a single injected line to keep per-prompt noise minimal. The verbose STATE re-anchor keeps the flow-referencing gate unchanged. Code-stays-English carve-outs (comments, identifiers, log/error messages, error codes, test names, commit messages, SD headings/IDs) preserved verbatim.
- **`commands/init.md`** — effect (2) wording updated: session-wide, not just `/sf:*` turns.
- Housekeeping: `.claude-plugin/plugin.json` version bumped 0.5.5 → 0.5.8 (had lagged since 0.5.6); README hook line synced.

## [0.5.7] — 2026-07-02

`task-baseline` — the backfill bridge: evidence-driven `done` for features implemented before their SD existed.

- **Gap: backfilled features had no task-status ledger.** Ingesting an SD for already-shipped code, then seeding tasks (`parse-prd`), marks EVERYTHING `pending` — a later `/sf:phase` executor has no way to know which scope already ships and could re-implement or overwrite working code.
- **New engine command `task-baseline --feature <f> [--apply]`** — marks tasks `done` from EVIDENCE only: a task qualifies iff its evidence set (the TCs of every FR it implements, plus TCs named in its own text) is non-empty and every one is recorded `verified` in `VERIFICATION.md` (the `/sf:manual-test` gate output). SD prose/status labels are never consulted — done means evidence, not claim. Task→FR mapping: trace `fr-task` links first, deterministic FR/TC-id text scan as fallback (backfilled features have no trace-link history); the report names the mapping source per task. Dry-run by default (proposal for human review), `--apply` writes `status=done` + an evidence note to `details`; only `pending` tasks move; unmapped/partially-verified tasks are skipped with explicit reasons. No `VERIFICATION.md` → baselines nothing and routes to `/sf:manual-test` — the manual-test gate stays the only door to `done`.
- **`commands/ingest.md`** — backfill note after the seeding step: manual-test the shipped scope first, then `task-baseline` (dry-run → review → `--apply`).
- Tests: 83 → 86.

## [0.5.6] — 2026-07-02

Close the prose-SRS blind spot in resync: `srs-diff` gets a prose-level fallback layer, and `trace-impact` finally understands `srs-diff`'s own output.

- **Bug: `srs-diff` returned a deceptive 0/0/0 for real revisions of prose-form SRS.** The anchor diff only compares user stories (US-id) and NFR/BL/state table rows. An SRS written as prose bullets (`- Hệ thống PHẢI ...`) parses to empty structures on BOTH sides → any revision, however large, diffed 0/0/0 → the resync wrong-input guard mis-routed a genuine edit to "not a revision". Hit in production on openproxy (9 prose SRS; an 11-bullet revision read as empty).
- **Fix: prose fallback layer.** New `parseProseBullets()` in core (bullets/numbered items grouped by nearest heading, table rows excluded) + `srs-diff` now always computes a per-section bullet set-diff. Output adds `prose {added, removed}` (entries `{kind:'prose', section, text}`), `proseCounts`, `proseSections`, and `anchors {old, new}` diagnostics. `emptyChangeset` is now true only when BOTH layers see nothing; a dedicated hint distinguishes **parser-blind** (anchor 0/0/0 + prose changes → "this IS a revision, feed data.prose to sd-author") from **genuinely empty** (wrong-input routing unchanged).
- **Bug: the documented `srs-diff → trace-impact --changeset` pipe never seeded anything.** `trace-impact` only understood `{ids, keywords}` or a flat array; `srs-diff`'s `{changeset:{added,changed,removed}}` shape was silently ignored (0 seeds, empty impact — a no-op that looked like success).
- **Fix: `trace-impact` accepts the srs-diff result file directly** — full `{changeset, prose}` data or bare `{added, changed, removed}`. Harvests `entry.id` plus any `FR-/TC-/US-/NFR-/AC-/BR-\d+` and `ERR_*` ids mentioned inside the changed text (`text`, `oldText`, `row`, `oldRow`), then walks the trace transitively as before. `{ids, keywords}` inputs unchanged.
- **`commands/resync.md`** — step-1 guard rewritten: three cases (empty / anchor-blind / anchored) with explicit routing; step-2 notes the result file is directly consumable.
- Tests: 80 → 83 (prose-fallback rescue + identical-doc stays empty; srs-diff-shape ingestion with transitive walk; `parseProseBullets` unit).

## [0.5.5] — 2026-06-30

Add `/sf:manual-test`, `/sf:checkpoint`, checklist clobber guard, and clearer `/sf:status`.

- **New command `/sf:manual-test <feature>`** — run the feature's `CHECKLIST.yaml` (smoke → regression) and record `VERIFICATION.md`. Flags: `--smoke-only`, `--regression-only`.
- **New command `/sf:checkpoint [feature]`** — save mid-task state to disk when context is running low or stopping voluntarily. Writes `.spec-flow/specs/<feature>/checkpoint.md` (single overwritable file, not a log). Agent auto-triggers when mid-task and context is deep; user can also trigger manually. `/sf:status` surfaces the checkpoint and overrides Next Step with an exact resume hint. `checkpoint-clear` runs automatically in phase step 6 when task reaches `done`.
- **Engine: `checkpoint-write` + `checkpoint-clear`** — two new commands (~45 LOC). `checkpoint-write` records task, phase, done files, next action, decisions. `checkpoint-clear` removes the file (no-op if absent).
- **`checklist-gen` clobber guard** — returns `CHECKLIST_EXISTS` if `CHECKLIST.yaml` already exists. Pass `--force` to regenerate from SD (overwrites filled assertions).
- **`/sf:status` enhancements** — new Checkpoint row (shown when mid-task state saved); new Checklist row (`absent` / `scaffold (N TODO)` / `ready`); Next Step now says `/sf:manual-test <feature>` instead of raw `run-checklist ... → verify-collect`.
- Tests: 78 → 80.

## [0.5.4] — 2026-06-29

Fix the #1 resume trap — `/sf:phase` re-seeding tasks from scratch in a new session.

- **Bug: `/sf:phase` Step 0 re-ran `parse-prd` on an already-seeded feature after a session restart.** You seed tasks, exit, open a fresh session, run `/sf:phase` again — and it regenerates the task list from scratch (the user had to cancel and say "tasks already generated" before it noticed). Root cause: Step 0 decided "seeded?" via MCP `get_tasks` with a per-call `tag:`, but MCP state ops bind to the global `currentTag` and may ignore that param. In a fresh session `currentTag` still points at `master`/a prior feature → `get_tasks` returns the wrong tag's (empty) list → the agent concludes "not seeded" → destructively re-seeds.
- **Fix (doc-only, no engine change):** Step 0 now detects seeded-state through the engine's `status-report --feature <feature>`, which reads `.taskmaster/tasks/tasks.json` scoped to the feature's own tag (currentTag-immune). Non-null `tasks` → already seeded → run `use-tag` and skip straight to Routing; never re-`parse-prd`. Bare `/sf:phase` (no feature arg) resolves the active feature from the same call.

## [0.5.3] — 2026-06-29

Per-feature repo scope — stop multi-repo branching from fanning out to every service.

- **Bug: `branch-ensure` branched ALL `config.repos`.** A feature whose code lives in one sibling service (the "spec in hub, code in sibling repo" model) got stray `feat/<feature>` branches on unrelated services — and a feature targeting a repo absent from the list missed it entirely. The gate already self-scoped via file-links; branch-ensure had no escape hatch (and can't infer — it runs before any code exists).
- **`branch-ensure --repos "a,b"`** (engine): comma-separated repo-name filter (same semantics as `verify-code --repos`). Narrows the fan-out; unknown name → `REPO_NOT_CONFIGURED` instead of a silent misbranch. No filter → all repos (back-compat); single-repo → harmless no-op.
- **`trace-repos --feature <f> [--set "a,b" | --get]`** (engine): declares the repo subset a feature targets, stored as `trace.json.repos[]` — the single source of truth read at branch time (before file-links exist) and by the gate. Validates names ∈ `config.repos`.
- **Precedence** — `branch-ensure`: `--repos` flag > declared `trace.json.repos` > all repos. `verify-code`: `--repos` > declared > file-links inference > all. Declared (intent) sits above file-links (evidence); a declared repo with zero file-links raises a `scopeWarnings` "forgotten work?" note (does not fail the gate).
- **Commands**: `/sf:ingest` declares repos via `trace-repos` after `trace-build` (derived from SD "(service)" labels); `/sf:bug`, `/sf:change`, `/sf:phase` documented to scope branching. Two stale phase.md claims ("loops over all" / "EVERY config.repos") corrected.
- **+4 tests** (`test/flow-tools.test.cjs`): `--repos` scoping + unknown-name error, trace-repos round-trip + validation, branch-ensure trace fallback, gate declared-precedence + zero-link warning. 51/51 pass in flow-tools suite.
- Engine: bin +~70 LOC (1873 → 1961). Under the 3000 per-file cap.

## [0.5.2] — 2026-06-25

TDD RED-phase gate — enforce write-test-first with machine confirmation.

- **`verify-code --expect fail`** (engine): new RED-phase mode. Runs `testCommand` and inverts pass/fail semantics — a failing test returns `gate: "red-confirmed"` (proceed to implement); a passing test returns `gate: "fail"` (test is trivially green, fix it first). All other checks (coverage, forbidden-patterns, secret-scan) are skipped in RED-phase (production code doesn't exist yet). No testCommand → `gate: "skipped"` (RED unconfirmable, not blocking).
- **`hybrid-executor.md`**: TDD is now unconditional — step 3 is the RED phase (write test, run `verify-code --expect fail`, confirm `red-confirmed`) and step 4 is the GREEN phase (implement). Was conditional on `testCommand` being set and had no enforcement to actually run and see the test fail. Hard rule added: "Do NOT write production code before the test is confirmed failing."
- **`phase.md`**: orchestrator now checks TDD evidence in the executor's return summary — feature tasks must mention test path + RED gate output; chore tasks must say "RED phase skipped".
- **+3 tests** (`test/flow-tools.test.cjs`): RED confirmed (failing test), RED not confirmed (passing test), no testCommand. 74/74 pass.
- Engine: bin +19 LOC (1854 → 1873). No other file changes.

## [0.5.1] — 2026-06-19

Fix `config.language` bleeding into code.

- **Bug: `config.language` ≠ `en` made the executor write code comments in that language.** The anchor hook injected a session-wide "Respond in `<lang>`" directive whose only carve-out was *code identifiers* — comments, log/error strings, error codes, test names, and commit messages were unprotected, so the model in (e.g.) Vietnamese mode wrote Vietnamese comments. `config.language` is meant for conversation + authored docs (SD/CONTEXT prose) only, never code.
- **Fix at the two enforcement points:** the anchor hook (`hooks/spec-flow-anchor.sh`) now states the language directive applies only to conversation + docs and that all code stays English (comments, identifiers, log/error messages, error codes, test names, commit messages); `agents/hybrid-executor.md` carries the same as an inline hard rule. `commands/phase.md` notes it at executor-spawn time.
- Doc + hook only — **no engine change** (engine unchanged; cap untouched).

## [0.5.0] — 2026-06-18

G1 — Layer-2 semantic drift-check (closes the #1 design debt: the advertised "early SD-mismatch detection" that didn't really exist).

- **New `drift-check --feature [--tasks]`** (in new module `lib/drift.cjs`). The structural `sd-drift-detect` hook only checked file-in-trace; this is the SEMANTIC layer: it diffs the **actual** error codes the executor logged via `update-task --append` (in `tasks.json` task/subtask details) against the SD §12.2 codes (via the trace), and flags:
  - `spec-not-evidenced` — an SD §12.2 error code with no mention in any task log (spec'd, no evidence it was built / logged).
  - `impl-not-specced` — an error-code token in the logs that the SD §12.2 doesn't document (built but undocumented → update the SD).
- **Scope (v1): error codes** — the high-signal, deterministically-extractable contract element (honors the configured `errorCodePrefix` / `errorCodePattern`). §9.2 field-name and §10.4 state drift are intentionally deferred (their "actual" form in free-prose logs is too noisy to diff without false positives). Honest framing: absence in logs = "no evidence", not "definitely unimplemented". Advisory, never blocks; returns `clean: true` (or a "no logs yet" note) when there's nothing to flag.
- `/sf:phase` runs it before next_task (new step 6b) and surfaces `data.drift`. README + the "non-negotiable gates" layer-2 note updated.
- +4 tests in new `test/drift.test.cjs` (71 total). New `lib/drift.cjs` (95 LOC).

## [0.4.1] — 2026-06-18

Ingest→checklist→phase UX fixes from real session friction, plus per-lib unit tests.

- **#1 checklist-gen is design-type aware.** It used to scaffold `GET /api/v1/TODO` for every test even on a library/internal/event-driven feature with no HTTP surface (forcing a full manual rewrite). It now reads the SD's `Design type: **...**` preamble (or `--type`, or absence of a §9 API section) and, for non-HTTP features, emits a `live-e2e`-tagged scaffold instead of a fake HTTP stub. API/hybrid features keep the HTTP stub.
- **#2 sd-skeleton harvests FR/NFR/TC by ID-prefix (language-independent).** A structured SRS table like `| FR-1 | MUST | ... |` under a non-English heading harvested 0 rows (detection was purely heading/header-keyword based) and dumped everything on sd-author. Since FR-/NFR-/TC- IDs are always English-canonical, `parseSrs` now also finds a table by its first-column ID prefix as a fallback, and `genSd` harvests those rows.
- **#3 init-project auto-detects the stack.** With `--stack` omitted it now detects from build markers (`build.gradle`→java-spring, `pom.xml`→java-maven with `mvn test`, `package.json`→node, `go.mod`→go, `requirements.txt`/`pyproject.toml`→python, `*.csproj`→dotnet) so the verify gate isn't silently empty. New `java-maven` preset. Explicit `--stack` still wins; no markers → `unknown` (unchanged).
- **#4 one source of truth for `no-verify`/`live-e2e`.** `checklist-status` matched the bracketed `[no-verify]` literal while `lint-checklist` read the bare `no-verify` tag — so a `tags: [..., live-e2e]` entry could be recognized by one tool but not the other. Both now key on the bare token in the `tags:` list; `checklist.md` documents the tags-list as the single canonical place.
- **#5 no `srs-` slug drift.** An H1 like `# SRS: Outbox CDC` derived a `srs-outbox-cdc` feature slug that drifted from the `--feature outbox-cdc` the rest of the flow used. `parseSrs` now strips a leading `SRS:` doc-type prefix from the derived feature name.
- **Tests:** engine split into per-lib suites — new `test/core.test.cjs` (15, direct-require unit tests for the parsers/helpers) and `test/maintenance.test.cjs` (8, the static commands) alongside `test/flow-tools.test.cjs` (44, CLI integration). 67 total. Run all: `node --test test/*.test.cjs`.

## [0.4.0] — 2026-06-18

Engine modularization — static commands split out of the monolith (no behavior change).

- **`bin/flow-tools.cjs` (2914 LOC monolith) split into 3 modules:**
  - `lib/core.cjs` (~545) — shared infra (PATHS, Result helpers, repo/trace resolvers) + deterministic SRS/SD parsers + `genSd`. No command logic.
  - `lib/maintenance.cjs` (~572) — static, non-workflow commands: `init`, `init-project`, `learn`, `doctor` (setup + health + meta).
  - `bin/flow-tools.cjs` (~1826) — thin CLI entry + the workflow commands (trace/verify/checklist/state/bug/epic/branch/status). Requires the two libs and dispatches.
- The CLI contract is unchanged — `node bin/flow-tools.cjs <command>` works exactly as before (all 39 tests, which drive the real CLI seam, pass untouched). `PLUGIN_ROOT` resolves identically from `lib/` (one level under repo root, same as `bin/`).
- **Charter §0b #8 reinterpreted:** the 3000-LOC ceiling is now **per engine file** (no single file becomes a monolith) rather than one monolith cap. The pre-commit hook guards `bin/flow-tools.cjs` + `lib/*.cjs` individually. bin is now well under the 2700 warn line, leaving room to grow the engine modularly (e.g. the deferred G1 drift-check).
- No test count change (39). Workflow commands staying in `bin` can be split into their own lib module later if desired.

## [0.3.16] — 2026-06-18

Enforce the project's error-code pattern (deterministic, opt-in).

- **New `conventions.errorCodePattern` (config DATA) + `trace-build` enforcement.** Set a regex (e.g. `"^ERR_[A-Z]+_\\d{3}$"`, `"^[a-z]+(\\.[a-z]+)+$"`, `"^[A-Z]+-\\d{4}$"`) and `trace-build` warns (in `data.warnings`) on every §12.2 error code that violates it — catching house-convention drift (like a stacked `ERR_WEBHOOK_PGMS_LOOKUP_002`) right at ingest/resync instead of by eye at review. Warn, not block (style issue, user decides). Unset (default `null`) → no enforcement. `/sf:ingest` surfaces the warning; `sd-author §C` is told to match the pattern when set.
- +1 test (39 total). Engine 2894 → 2914 LOC.

## [0.3.15] — 2026-06-18

Live-gap transparency, project-aware error codes, and a cost note on per-task logging.

- **`status-report` surfaces declared live gaps (#4).** A `verified-adhoc` ship's "not verified live" items (event-driven delivery, cross-service flows, `[live-e2e]` TCs) were free prose, easy to forget at merge. Now `status-report` reads bullets under a `## Not verified live` / `## Deferred` / `## Live gaps` heading in `VERIFICATION.md` and returns `verifiedGaps[]`; `/sf:status` shows "N live gap(s)" and lists them. `/sf:phase` close-out documents the convention. No new command (transparent, lightweight).
- **Error codes follow the project pattern (sd-author §C).** sd-author no longer imposes a fixed `ERR_<DOMAIN>_<NNN>`; it now mirrors the project's existing error-code shape (grep brownfield enums; honor `conventions.errorCodePrefix` / `project-author.md`), falling back to a single-token `ERR_<DOMAIN>_<NNN>` only when no pattern exists (avoids stacked names like `ERR_WEBHOOK_PGMS_LOOKUP_002`).
- **Per-task `update-task --append` documented as optional (#5).** Clarified in `/sf:phase` + `hybrid-executor` that the AI-op note is human-readable history, not the source of truth (`trace-link` + `set_task_status` are the deterministic disk facts) — batch at task close or skip if AI latency over many tasks is a problem. No new machinery (Task Master is external).
- +1 test (38 total). Engine 2878 → 2894 LOC.

## [0.3.14] — 2026-06-18

New `checklist-status` command — know what's ready without eyeballing the YAML.

- **`checklist-status [--feature <f>] [--file <path>]`** classifies every test in a CHECKLIST.yaml: `filled` / `scaffold` (still has the generator tripwires `path: /api/v1/TODO` or `_assert: TODO`) / `no-verify` / `live-e2e` (tagged), and reports `ready` (no scaffold stubs left). Previously you had to read the file and guess.
- `/sf:checklist` doc now points at it, and documents tagging an **event-driven / cross-service** TC (no synchronous HTTP surface — outbox→CDC→publisher→callback) as `[live-e2e]` instead of leaving a fake HTTP stub.
- +1 test (37 total). Engine 2835 → 2878 LOC.

## [0.3.13] — 2026-06-18

`trace-impact` now reaches the task that implemented a changed FR (fr→task link).

- **Problem:** a changed FR resolved to `tasks=[]` because no `fr→task` link existed — `trace-impact` only walked `fr-tc`. `/sf:change` could not auto-reopen the implementing task, so the FR→task mapping had to be done by hand, defeating trace's purpose in the change loop.
- **Fix:** `trace-build` now emits a `fr-task` link for every `file-links.json` entry carrying both `task` and `fr` (seeded by `trace-link --fr <id> --task <id>`), and `trace-impact` walks it so an impacted FR reaches its task(s). `/sf:phase` + `hybrid-executor` now always pass `--fr` to `trace-link` (only omit for a pure infra/chore task with no FR).
- +1 test (36 total). Engine 2820 → 2835 LOC.

## [0.3.12] — 2026-06-18

`verify-code` can scope to the repos a feature actually touched (multi-repo false-fail fix).

- **Problem:** `verify-code` ran in EVERY `config.repos` repo and the gate was worst-wins, so an unrelated repo on a red WIP branch failed a clean feature's gate (observed: a change touching only one service failed because a sibling service had unrelated red tests).
- **Fix:** `verify-code` now accepts `--repos "a,b"` (explicit) or `--feature X` (auto — reads the repo prefixes from `X`'s `file-links.json`, populated by `trace-link --repo`). The scan narrows to those repos; the result reports `scope` and the `repos` that ran. No filter, single-repo, or no match → scans all (full backward compat). `/sf:phase` step 4 now always passes `--feature`.
- +2 tests (35 total).

## [0.3.11] — 2026-06-18

Backlog cleanup: test coverage + dead-code removal (no behavior change).

- **Test coverage 16/22 → 22/22 commands.** Added focused tests for the 6 previously-uncovered engine commands: `init`, `learn`, `checklist-gen`, `trace-impact`, `state-update`, `wave-plan`. Test count 27 → 33.
- **Dead code removed:** unused `PATHS.srs` + `PATHS.gitignore` keys (init-project uses path literals, not these), and the captured-but-never-read `want` / `soThat` fields in `parseUserStories`. Engine 2794 → 2790 LOC.
- Backlog items closed-with-rationale (no code change): the "language pack = data" item is effectively done (residual `|| [literal]` lead-in fallbacks are intentional defensive guards that fire only if the pack is missing; the primary path is fully pack-driven), and the `change`-record id-collision risk is a marginal single-user race with a rare deletion premise — not worth a new engine command near the LOC cap.

## [0.3.10] — 2026-06-18

Two P1 fixes from a multi-feature session: trace data-loss and a silent wrong-input resync.

### Fixed
- **Per-feature trace (data-loss fix).** There was a single global `.spec-flow/trace.json`, so `trace-build --feature B` overwrote feature A's trace entirely (observed: 103 links → 21 when switching features). `trace-build` now writes a **durable per-feature copy at `specs/<feature>/trace.json`** (keyed by the feature dir → can never be clobbered cross-feature) and keeps the global `trace.json` as an **active-feature mirror** (rewritten each build so bare `/sf:status` knows what's active). `trace-impact`, `status-report`, and `state-update` resolve the per-feature durable trace when a `--feature` is known, falling back to the mirror. `trace-build` now returns `perFeatureTrace` and `switchedFrom` (the prior active feature, for transparency). STATE.md stays a single regenerable view — `state-update --feature X` rebuilds it from X's durable trace.
- **resync wrong-input guard.** `srs-diff` now returns `emptyChangeset: true` + a `hint` when the diff vs the latest snapshot is 0/0/0 — a strong signal the input is not a revision of the tracked SRS. `/sf:resync` step 1 STOPS on this and routes the user to `/sf:ingest` (new feature) or `/sf:change` (spec tweak) instead of silently running the whole pipeline as a no-op.
- +2 regression tests (27 total). Engine 2758 → 2794 LOC.

## [0.3.9] — 2026-06-18

Two rough-edge fixes found during real ingest usage.

- **`srs-snapshot`: warn on date-prefixed slug** — when the SRS has no `Feature:` header and the filename starts with a date (`2026-06-18-feature-name.md`), the derived slug includes the date and mismatches the SD slug. The snapshot still succeeds, but `data.warnings` now includes a message suggesting to move the SRS to `.spec-flow/srs/<clean-name>.md` or pass `--feature <slug>`.
- **TODO count: match actual marker blockquotes only** — `status-report` and `doctor` used a raw `/TODO:MANUAL-REVIEW/g` regex that counted every mention of the string, including the sd-skeleton banner, sd-author's own Pass-2 summary comment (`TODO remaining: 0`), and any changelog prose in the SD. The gate falsely reported unresolved TODOs on a clean SD. Fixed to `/^>\s*\*\*TODO:MANUAL-REVIEW\*\*/gm` — matches only the actual placeholder blockquote format emitted by `TODO()`.

## [0.3.8] — 2026-06-17

Two trace-build link fixes — FR↔TC links now use the explicit FR-ref column when present,
and src-fr links work for embedded source refs like "SRS §5.1 FR-N".

- **`tcIdsForReq`: resolve FR column by header name** — on 6-col TC tables (`TC ID|Flow|Test Case|Input|Expected|FR`), the old positional `tr[2]` pointed at the "Test Case" description column, not the FR ref column; fuzzy text match always returned 0 links on real SDs whose TC descriptions don't echo the FR requirement text verbatim. Fix: find the "FR" column by header name and match `fr.id` explicitly; falls back to fuzzy text match when no FR column exists or returns no hits.
- **`src-fr`: match embedded FR/US/BL refs in source field** — the old regex `/^(US|BL|NFR)-?\d+/i` silently skipped source values like `"SRS §5.1 FR-1"` (starts with "SRS"). Fix: use `\b(US|BL|NFR|FR|AC)-?\d+` to extract any traceable ID from the source text.
- +2 regression tests (25 total).

## [0.3.7] — 2026-06-12

Two runner usability fixes (from feedback that surfaced while running on a stale standalone copy).

- **`run-checklist.sh <feature>` now resolves `.spec-flow/specs/<feature>/CHECKLIST.yaml`** — previously only a literal path or `.claude/docs/manual-tests/features/<feature>/` resolved, so passing the bare feature name (as the spec-flow docs/STATE do) errored `checklist not found`.
- **Lint message for status-only tests** is clearer: a bare `expect.status` is flagged as insufficient with explicit migration guidance (assert the error body for rejection tests, or tag `[no-verify]`).

## [0.3.6] — 2026-06-12

Manual-test runner: per-request `base_url_ref` for multi-service flows.

- The runner always hit `config.base_url`, so a test for a second service (e.g. an `auth-ms` lookup while the default base is `va-ms`) went to the wrong host → 404. Multi-repo (v0.2.0) let you plan/build across services, but the runner could only *test* one.
- New **`config.base_urls: {<name>: <url>}`** + per-test/setup **`base_url_ref: <name>`** selects an alternate base; default stays `base_url`. An undefined ref is a hard error (not a silent wrong-host call). Works for both request and `http:` setup steps. +3 runner tests (37 → 40). No engine change.

## [0.3.5] — 2026-06-12

Manual-test runner: forward a test's `request.headers` to the HTTP call (critical).

- `_send_request` only ever attached the token header — it **never read `request.headers`**, so every custom header (`X-Client-Id`, `X-Timestamp`, `X-Signature`, …) was silently dropped. Signed-request suites failed with `signature.missing`; only the TCs that *expect* a missing signature passed. This made the v0.3.4 `exec:` signing hook unusable end-to-end.
- Custom headers are now merged (var-expanded) after the token, so an explicit per-test header wins. +1 runner test (36 → 37). No engine change.

## [0.3.4] — 2026-06-12

Manual-test runner: generic `exec:` setup step (closes a real signed-request gap).

- The runner had no way to compute a value (e.g. an RSA/HMAC request signature) and inject it — only `sql`/`seed`/`http`/`redis` setup steps. A CHECKLIST that referenced a "signing helper" / `${sig:*}` therefore sent literal placeholders and the whole signed-request suite failed for tooling reasons (and honestly reported `verified: false`).
- New **`exec: "<cmd>"`** setup step runs a **project-provided** command and captures stdout into vars — whole stdout (`capture: {VAR: stdout}`) or a JSON path if the command prints JSON (`capture: {VAR: "$.signature"}`). Non-zero exit is an error; skipped on `--dry-run`.
- The runner stays **generic**: signing/canonical-string logic lives in the project's script, not the runner. Use `${VAR}` in headers — no magic `${sig:*}` syntax. +4 runner tests (32 → 36). No engine change.

## [0.3.3] — 2026-06-12

SRS-parsing keywords are now DATA, not engine logic (charter "generic, stack=data"; opens i18n).

- New **`templates/lang/{en,vi}.json`** hold the keyword lists for parsing a free-form SRS (heading roles, table headers, design-type, complexity groups, user-story lead-ins). The engine loads `en` as base and merges `config.language` on top (union); a project can add `.spec-flow/templates/lang/<lang>.json` to override/extend.
- Removed all hardcoded Vietnamese (and bilingual) literals from `flow-tools.cjs` — `ROLE_KW`, `COMPLEXITY_KEYWORDS`, `inferDesignType`, the `parseSrs` table-header regexes, and the `parseUserStories` lead-ins now come from the pack. A new language is a new JSON file, no engine edit.
- The generated **SD stays canonical English** — SD-side table parsing (`readSdTables`, `trace-build`) is unchanged; the pack covers SRS parsing only.
- +3 tests (VI heading harvested under `vi`; not under `en` — config-scoped; a project-local `xx.json` extends parsing with no engine change). Engine + runner tests 23 + 32.
- **Honest note:** this is a charter/i18n win, **not** a LOC cut — the loader (~+58) slightly outweighs the data moved out, so engine went 2704 → 2737. Real LOC convergence remains a separate, deferred effort.

## [0.3.2] — 2026-06-12

Engine convergence (make room under the LOC ceiling) + a runner/engine contract fix.

- **`run-checklist.sh --json`** — the manual-test runner now emits a final machine-readable `{passed,failed}` line (the human summary still prints above it).
- **`verify-collect` is JSON-only** — consumes that line (or a whole-file JSON), and errors `NO_JSON_RESULTS` if the runner wasn't run with `--json`, instead of silently scraping human text. The fragile 48-line text parser is gone. This also makes reality match the docs, which already said `runner-output.json`.
- Engine 2744 → 2704 LOC (back under the 2700 warn line). Tests 18 → 20; runner python tests still 32/32. Phase/bug/change docs updated to pipe `--json` into `verify-collect`.

## [0.3.1] — 2026-06-12

Workflow guidance fixes (doc-only, no engine change).

- **W5** — a chore/migration task with no FR trace now has explicit fallback guidance in `hybrid-executor` (anchor on the task's own details + existing patterns; flag, don't invent, behavior that should be specified).
- **W6** — the `verify-code: skipped` no-op message is surfaced **once per phase**, not on every task (was noise).
- **W7** — `/sf:split` STEP 5c documents per-sub-feature snapshots so a later `/sf:resync` can attribute SRS edits to the right sub-feature (a single shared epic snapshot defeats the feature-scoped `srs-diff`).

## [0.3.0] — 2026-06-11

Audit-hardening release (from a full external review). Bug fixes + workflow dead-end removal + transparency, no removed behavior.

### Fixed
- **branch-ensure** rejected a missing `--name`/`--id` instead of silently branching `feat` (a blank var collapsed `feat/{feature}` → `feat`).
- **verify-code** coverage parsing no longer reads a progress bar like `[80%]` as coverage — prefers a coverage-labelled line, else the last percentage.
- **branch-ensure** multi-repo: if every repo errors it now fails loudly (was `ok:true` with errors buried in the array); partial errors surface as `warnings`.
- **srs-diff** selects the latest snapshot **of the feature** by name/version, not the newest file by mtime across all features.
- **route** reports an empty/malformed FR table instead of a silent `count: 0`.
- Removed dead code in `verify-collect` (literal `\uXXXX` regex branches that never matched; an unused name lookup).
- **§10.4 state-table template** header is canonical English (`State | Meaning | Allowed Transitions | Entry Action`) so `trace-build` parses state nodes when the template is filled directly.

### Added
- **`/sf:phase` picks up `review` tasks first** — a smoke-failed task no longer dead-ends (`next_task` skips `review`); the loop re-runs its smoke, closes if passed, re-attempts if failed, halts to ask after two failures.
- **`/sf:resync` re-aligns all impacted tasks**, not just `done` ones — `in-progress` tasks (being built against the old spec) are flagged and reset; `pending` are listed in the blast radius.
- **doctor**: auto-detects the active feature's SD gate without `--sd`, validates `config.repos` paths (exist + git repo), and warns on Task Master tag drift.
- **Ship guards**: `/sf:phase` ship step hard-blocks unless `VERIFICATION` is `passed`/`verified-adhoc`, and tags the shipped feature.

## [0.2.0] — 2026-06-11
- **Multi-repo**: one SRS/SD across sibling service repos via `config.repos`. `verify-code`, `branch-ensure` loop every repo; `trace-link --repo` qualifies paths; `/sf:phase` cd's per task. Opt-in, backward compatible.

## [0.1.3] — 2026-06-11
- Per-feature tag scoping fixes (trace count drift), `use-tag` in `/sf:phase`, `update-task --append` for un-expanded tasks, honest `skipped` verify gate, deferrable smoke for no-surface tasks.

## [0.1.2] — 2026-06-11
- Adaptive SD sequence diagrams; wired diagrams to the implementer for multi-step/stateful tasks.

## [0.1.1] — 2026-06-10
- Enforce `config.language` for SD prose (explicit sd-author spawn directive) and session responses (anchor hook).

## [0.1.0] — 2026-06-10
- First official release. SRS → reviewed Solution Design → adaptive, traceable implementation; change-driven resync/change/bug loops; local-first manual-test verification; keyless via Task Master.
