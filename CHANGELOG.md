# Changelog

All notable changes to spec-flow. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are git tags on `main`.

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
