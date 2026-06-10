---
name: manual-test
description: >
  Guide for manual testing backend services locally via curl OR Kafka event
  triggers, with direct DB/Redis verification. Polymorphic by stack:
  java-spring (Summer Framework X-Userinfo + Keycloak ROPC, plain Spring JWT),
  node, python, go, dotnet. Use this skill when: testing APIs locally,
  creating auth tokens, seeding test data, verifying callback webhooks,
  producing Kafka events to trigger consumers, or debugging API responses.
  Also trigger when user says: "manual test", "test locally", "curl test",
  "seed data", "produce event", or wants to verify a fix.
invoke: user
args: "[smoke|regression|suite:NAME] — default: smoke"
---

# Manual Testing Backend Services

Test backend services locally via curl OR by producing Kafka events, with direct DB/Redis verification. Works across stacks (Java/Spring, Node, Python, Go, .NET) via per-stack discovery scripts.

Per-stack coverage is deepest for **Java + Spring (especially Summer Framework)** — the rest cover the common 80% and **fall back to agent grep** for anything not deterministically detectable. See `references/stacks.md`.

This file is the entry point. Detail lives in `references/*.md` (read on-demand) and runnable helpers in `scripts/*.sh` (Claude executes; user does nothing extra).

## Lazy Mode (default path) — 5 commands

```bash
scripts/api.sh PRIME                           # detect stack + auth + port + creds + FRESHNESS check
                                               # (reads PROJECT_CONTEXT.yaml if fresh — skips re-discovery)
scripts/test-user.sh                           # auto-pick + cache active test user (DB + Keycloak realm)
scripts/checklist-init.sh <feature>            # REQUIRED if no CHECKLIST.yaml exists — generates scaffold
scripts/lint-checklist.sh <feature>            # gate: refuses TODO/SELECT-1 markers + unresolved templates
scripts/run-checklist.sh  <feature> [--tag smoke|regression] [--id TEST-ID]
                                               # THE entry point for executing tests. Lints first, runs
                                               # setup precondition SQL, fires each test, asserts body
                                               # + status, runs verify SQL, prints PASS/FAIL/SKIP.
                                               # Ad-hoc curl is NOT a substitute — add a test instead.
```

`PRIME` reads `.claude/docs/manual-tests/PROJECT_CONTEXT.yaml` on subsequent sessions — skips re-discovery if < 7 days old. Force re-discovery with `PRIME --refresh`.

`PRIME` also runs `freshness-check.sh` — compares the running service's `/actuator/info` git commit against repo HEAD. If stale, it tells you how to restart:

```bash
scripts/api.sh RESTART                         # interactive: confirms before kill+restart
scripts/api.sh RESTART --auto                  # /manual-test auto mode: no prompt
scripts/api.sh FRESH                           # re-check freshness anytime
scripts/api.sh CONTEXT                         # print current PROJECT_CONTEXT.yaml
scripts/api.sh CONTEXT --refresh               # force re-discover + rewrite context
```

Cache lives in `~/.cache/manual-test/<project-hash>/`. JWT TTL 240s (override `JWT_TTL`). On non-2xx, `api.sh` prints likely-cause hints from the troubleshooting matchers. Full cheatsheet: `references/lazy-mode.md`.

## Hard Rules — NEVER violate

1. **Always verify code freshness before testing.** Run `scripts/api.sh PRIME` (calls `freshness-check.sh`). If running service ≠ repo HEAD or working tree is dirty, the test result is meaningless against current code.
   - **Manual mode (default):** ask user "App đang chạy commit X, repo ở Y, restart?" — DO NOT kill/restart without explicit yes.
   - **Auto mode** (`scripts/api.sh RESTART --auto` OR `/manual-test --auto`): allowed to kill + restart without prompt. ONLY when user invoked auto explicitly.
   - **Never** run `./gradlew bootRun` / `npm start` / `dotnet run` without going through `scripts/restart-service.sh` (it confirms intent and shows the exact command first).
2. **Never delete `.env` lines.** Comment with `#` only — lines may be needed again.
3. **Use `tr -d '\n'` when base64-encoding tokens** on macOS — `base64` wraps long output silently → 401.
4. **Don't use your automated-test stub task for manual testing.** If the repo has a stub task for automated/blackbox runs (on its own ports), those are for automated tests. Manual testing uses the real services + your manual stub project (see `references/ports.md`).
5. **Every setup mutation MUST be reversed in teardown** — even if the test fails midway. See `references/seeding.md` → State Restoration.
6. **Every test MUST be executed via `scripts/run-checklist.sh`. Ad-hoc curl as the primary test method is FORBIDDEN — this is enforced by code, not convention.**
   - CHECKLIST.yaml exists → `scripts/run-checklist.sh <feature> [--tag smoke]`.
   - CHECKLIST.yaml missing → `scripts/checklist-init.sh <feature>` → fill TODOs → `scripts/lint-checklist.sh <feature>` → `scripts/run-checklist.sh <feature>`.
   - The runner lints first and refuses to execute if TODO markers, placeholder `SELECT 1 --`, unresolved `{paramName}` templates, or missing `verify:` blocks are present. Tag a test `[no-verify]` to acknowledge an HTTP-only assertion is intentional.
   - "Just running one curl to check" still has to be a test in the YAML. If the curl is worth running, it's worth keeping as regression coverage.
   - Place checklists at: `.claude/docs/manual-tests/features/<feature>/CHECKLIST.yaml`
7. **Test rigor — MUST follow `references/test-rigor.md`.** Every test MUST:
   - **Reproduce its precondition via the real entry point** (user journey, not direct `INSERT` of end states). When shortcutting, mirror every ambient write (`audit_log`, `outbox_events`, `version`, derived columns) and comment why.
   - **Verify a side-effect / delta**, not just HTTP status. Status 200 alone is never a PASS.
   - **Use a unique correlation ID per run** (`${TEST_CORRELATION_ID}`), not stable `TEST-001`.
   - **Use `poll until` with a timestamp filter for async**, never `wait_ms` + single check.
   - Before reporting PASS, run the **sanity-fail probe** (break one seed → that test must fail). See test-rigor.md § Post-run audit.
   - SHOULD rules (realistic seed shape, no pre-set derived fields, isolation-row seed, negative-control sibling) apply for regression / depth.

## Workflow Overview

```
-1. CHECKLIST     → glob .claude/docs/manual-tests/features/*/CHECKLIST.yaml
                    → found?   load and proceed to step 0
                    → missing? scripts/checklist-init.sh <feature> → review → confirm
0. PRIME          → scripts/api.sh PRIME
                    → PROJECT_CONTEXT.yaml fresh (<7d)? load from it (skip steps 1-2)
                    → stale / missing?  run steps 1-2, then write PROJECT_CONTEXT.yaml
1. DETECT-STACK   → scripts/detect-stack.sh → java-spring | node | python | go | dotnet | unknown
2. DISCOVERY      → scripts/detect-auth.sh  → summer | jwt-basic | session | no-auth | unknown
                    scripts/warm-up.sh      (health, DB list, endpoints — branches by stack)
                    scripts/db-creds.sh     (auto-discover PG/Redis creds; yml for Spring, .env for others)
                    scripts/port-detect.sh  (env override > yml > probe — mirrors Spring's real resolution)
2b. FRESHNESS     → scripts/freshness-check.sh
                    → fresh   = proceed
                    → stale   = scripts/restart-service.sh (manual: confirm | auto: no prompt)
                    → unknown = service exposes no /info, agent decides
3. AUTH           → quick-probe → Path A / B / C (see Authentication below)
4. SEED           → CHECKLIST.yaml setup blocks → scripts/db-query.sh
5. TRIGGER        → CHECKLIST.yaml request blocks → curl OR scripts/produce-event.sh
6. VERIFY         → CHECKLIST.yaml verify blocks → scripts/db-query.sh + Redis + consumer-lag
                    (references/results.md, references/kafka-events.md)
7. TEARDOWN       → CHECKLIST.yaml teardown blocks → restore every mutation
```

**Agent-search fallback (important):** Scripts cover the common 80% case deterministically. When a script returns `unknown` or guidance is missing for the detected stack, the script prints structured hints to stderr — Claude uses `Grep` / `Glob` to investigate manually. See `references/stacks.md`.

**Trigger type depends on the feature:**

| Feature shape | Trigger in CHECKLIST.yaml | Reference |
|---------------|--------------------------|-----------|
| HTTP-exposed (`@RestController`, handler) | `request.method` + `request.path` | `references/patterns.md` |
| Event-driven (`@KafkaListener`, `KafkaReceiver`) | `request.kafka.topic` + `kafka.payload` | `references/kafka-events.md` |
| Both (HTTP triggers internal Kafka emit) | HTTP request, then verify both DB + output topic | both files |

## Discovery

Run discovery before testing:

```bash
scripts/warm-up.sh
```

Prints: health probes for known ports, all DB names, controller `@RequestMapping` + method paths.

**Path discovery rule (critical):** full endpoint path = class-level `@RequestMapping` + method-level mapping (`@GetMapping`, etc.). Don't infer from class name. Full detail + examples: `references/troubleshooting.md`.

## Authentication — Decision Tree

First, classify the project:

```bash
scripts/detect-auth.sh
# → summer | jwt-basic | no-auth | unknown
```

| Detect result | Path | Reference |
|---------------|------|-----------|
| `summer` | Path A or B (decide via quick-probe below) | `references/auth.md` |
| `jwt-basic` | **Path C** — standard `Authorization: Bearer <jwt>` | `references/auth-jwt-basic.md` |
| `no-auth` | No auth needed | — |
| `unknown` | Inspect SecurityFilterChain manually | — |

### Summer projects — quick-probe Path A vs B

```bash
# 1. Build minimal X-Userinfo token
QUICK_TOKEN=$(echo -n '{"iat":1772680061,"exp":2088040061,"sub":"probe"}' | base64 | tr -d '\n')

# 2. Hit any real endpoint
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" \
  "http://localhost:PORT/api/v1/..." -H "X-Userinfo: $QUICK_TOKEN"
```

| Probe result | Path |
|---|---|
| 400 / 404 / 200 (anything ≠ 401) | **Path A** — X-Userinfo direct. Build Mode A or Mode B token. |
| 401 `com.unauthorized.access` | **Path B** — X-Userinfo not trusted. Use Keycloak ROPC + Bearer JWT. |

Common cause of Path B: `summer-platform ≥ 0.3.0` BO endpoints — the `summer-apisix` filter only trusts X-Userinfo behind a trusted upstream. Locally there is no upstream → 401.

**Heuristic:** if `/bo/...` returns 401, go straight to Path B. Don't waste time tuning Mode A token.

### Path A — quick start

```bash
TOKEN=$(echo -n '{"iat":1772680061,"exp":2088040061,"sub":"USER_ID"}' | base64 | tr -d '\n')
curl -s http://localhost:PORT/api/v1/... -H "X-Userinfo: $TOKEN"
```

End-user vs BO token formats, Mode A vs Mode B (resource_access vs role_groups), Redis seed for group-role: `references/auth.md`.

### Path B — quick start

```bash
JWT=$(scripts/kc-ropc.sh <realm> <client> <user> <pass> [client-secret])
curl -s http://localhost:PORT/bo/api/v1/... -H "Authorization: Bearer $JWT"
```

Verify JWT roles before testing endpoint:

```bash
scripts/decode-jwt.sh "$JWT"
```

Keycloak realm/client discovery, JWT role verification, alternative-user search, UAT-dumped data pattern, role testing matrix: `references/auth.md`.

### Path C — quick start (plain JWT, non-Summer)

```bash
# Option 1: app's own login endpoint
JWT=$(curl -sf -X POST http://localhost:PORT/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"...","password":"..."}' \
  | sed -n 's/.*"\(access_token\|token\)":"\([^"]*\)".*/\2/p')

# Option 2: external IDP (Keycloak / Auth0 / etc.) — kc-ropc.sh works for any OIDC token endpoint
JWT=$(scripts/kc-ropc.sh <realm> <client> <user> <pass> [secret] [token-url])

curl -s http://localhost:PORT/api/v1/... -H "Authorization: Bearer $JWT"
```

Login endpoint discovery, static-signed JWT minting, `@PreAuthorize` / `hasRole` claim mapping, gotchas: `references/auth-jwt-basic.md`.

## Internal Endpoints

`/internal/api/v1/...` — no auth (`permitAll`). Used for service-to-service calls and webhooks.

## Reference Index

Open the relevant file when you hit the topic — don't preload.

| Topic | File |
|-------|------|
| **Test rigor — 5 MUST + 5 SHOULD rules, BAD vs GOOD example** | `references/test-rigor.md` |
| **Lazy mode — 3 commands, auto-auth wrapper, gotcha matcher** | `references/lazy-mode.md` |
| **Per-stack discovery cheatsheet + agent-search fallback recipes** | `references/stacks.md` |
| `CHECKLIST.yaml` driven runs | `references/checklist.md` |
| Port map template (example layout — replace with your project's) | `references/ports.md` |
| Summer auth — Path A (X-Userinfo) + Path B (Keycloak ROPC) | `references/auth.md` |
| Plain JWT auth (any stack) — login endpoints, claim mapping, static signing | `references/auth-jwt-basic.md` |
| Kafka event-triggered testing — produce, consume, lag, DLT, replay | `references/kafka-events.md` |
| DB seed patterns, Redis, pg_notify, state restoration | `references/seeding.md` |
| 6 HTTP testing patterns (boundary, isolation, callback, config, fail-safe, restoration) | `references/patterns.md` |
| Response codes, stub failures, gotchas (date format, custom ID, path) | `references/troubleshooting.md` |
| Post-test verification, output format, pre-test checklist | `references/results.md` |

## Helper Scripts

| Script | Purpose |
|--------|---------|
| **`scripts/run-checklist.sh <feature> [--tag T] [--id ID]`** | **Test executor — the ONLY supported way to run tests.** Lints, resolves tokens, runs setup SQL, fires each test (HTTP), asserts status + body, runs verify SQL, prints pass/fail summary. Exit non-zero on any failure. Hard Rule #6 enforcement lives here. |
| **`scripts/lint-checklist.sh <feature>`** | Pre-flight gate. Fails on `TODO` markers, placeholder `SELECT 1 --`, unresolved `{paramName}` path templates, missing `verify:` blocks (unless tagged `no-verify`). Always run before `run-checklist.sh`; the runner calls it implicitly too. |
| **`scripts/api.sh PRIME [--refresh] \| CONTEXT [--refresh] \| RESTART \| FRESH \| REPEAT \| STATE \| CLEAR \| METHOD PATH [...]`** | **Discovery + freshness entry point.** On PRIME: reads PROJECT_CONTEXT.yaml if fresh, else runs full discovery and writes context. `METHOD PATH` is for one-off probes during DISCOVERY only — NOT a substitute for `run-checklist.sh`. See `references/lazy-mode.md`. |
| **`scripts/checklist-init.sh <feature> [--path /api/v1/prefix]`** | **Generate CHECKLIST.yaml scaffold** for a feature. Scans codebase for matching endpoints (Java: `@GetMapping` etc.; Summer: `@Handler`). Writes to `.claude/docs/manual-tests/features/<feature>/CHECKLIST.yaml`. Run when no checklist exists. |
| **`scripts/test-user.sh`** | Auto-pick active test entity from DB + match Keycloak realm + cache password from realm export. |
| **`scripts/freshness-check.sh [--port N] [--quiet]`** | Compare running service git commit vs repo HEAD. Exit 0=fresh / 1=stale / 2=unreachable. |
| **`scripts/restart-service.sh [--auto] [--kill-only] [--port N] [--cmd 'cmd']`** | Polymorphic kill + restart (lsof PID, SIGTERM/KILL, start by stack, wait health). Interactive by default; `--auto` skips prompt. |
| `scripts/context.sh` (sourceable) | PROJECT_CONTEXT.yaml library: `context_load`/`context_write`/`context_get`/`context_set`/`context_is_fresh`. Used by `api.sh PRIME`. |
| `scripts/detect-stack.sh [project-root]` | Classify stack: `java-spring` / `node` / `python` / `go` / `dotnet` / `unknown` |
| `scripts/detect-auth.sh [project-root]` | Classify auth: `summer` / `jwt-basic` / `session` / `no-auth` / `unknown` (polymorphic by stack) |
| `scripts/port-detect.sh [project-root]` | Resolve server port from yml/env/compose/probe. Used by `api.sh PRIME`. |
| `scripts/warm-up.sh` | Health probes + DB list + endpoint discovery (branches by stack) |
| `scripts/state.sh` (sourceable) | Session cache library: `state_set`/`state_get`/`jwt_get`/`jwt_set`. Used by `api.sh` + `test-user.sh`. |
| `scripts/db-creds.sh [--print] [project-root]` | Discover PG + Redis creds from `.env` + `application.yml`. `eval $(...)` exports `PG_HOST PG_PORT PG_DB PG_USER PG_PASS REDIS_HOST REDIS_PORT REDIS_PASS`. |
| `scripts/db-query.sh "<sql>" [-d DB] [-f FILE] [-t] [-r root]` | 1-shot psql with auto-discovered creds. Use for seed / verify / inspect. |
| `scripts/decode-jwt.sh "$JWT"` | Print JWT payload (handles macOS base64 padding) |
| `scripts/kc-ropc.sh <realm> <client> <user> <pass> [secret] [token-url]` | Fetch Bearer JWT from Keycloak or any OIDC IDP |
| `scripts/produce-event.sh <topic> <payload-file\|-> [-k KEY] [-H name=val] [-b BROKER]` | Produce Kafka event (kcat or docker fallback) |

## Templates

| File | Purpose |
|------|---------|
| `templates/CHECKLIST.yaml` | Boilerplate per-feature checklist — used by `checklist-init.sh` as base. Can also be copied manually to `.claude/docs/manual-tests/features/<feature>/CHECKLIST.yaml`. |
