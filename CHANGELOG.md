# Changelog

All notable changes to spec-flow. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are git tags on `main`.

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
