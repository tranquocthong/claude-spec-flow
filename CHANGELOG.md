# Changelog

All notable changes to spec-flow. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are git tags on `main`.

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
