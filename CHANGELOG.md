# Changelog

All notable changes to spec-flow. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are git tags on `main`.

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
