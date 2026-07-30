# Checklist-Driven Testing

When the project defines a `CHECKLIST.yaml`, drive `/manual-test` from it instead of writing curl ad-hoc. The checklist is the source of truth for what gets tested, in what order, and how state is restored.

## Discovery Order

1. `.claude/docs/manual-tests/features/*/CHECKLIST.yaml` — feature-scoped (preferred)
2. `.claude/docs/manual-tests/CHECKLIST.yaml` — project-level fallback

Sister directory of `.claude/docs/plans/` and `.claude/docs/specs/`, if your project uses that layout.

If multiple feature checklists are found, list them and ask the user which to run (or run all when invoked with `regression`).

## Run Flow

When `/manual-test [args]` is invoked:

1. **Load checklist** — glob using discovery order above.
2. **Resolve variables** — auto-discover entities from DB (find main entity table from `application.yml` / Flyway migrations, query for an active record):
   ```bash
   PGPASSWORD=<pass> psql -h <host> -p <port> -U <user> -d <db> \
     -c "SELECT * FROM <main_entity_table> WHERE status='ACTIVE' LIMIT 1"
   ```
3. **Generate tokens** — base64-encode token payloads from the `tokens` section, substituting resolved variables (always `tr -d '\n'`).
4. **Filter tests by argument:**

   | Argument | Effect |
   |----------|--------|
   | (none) or `smoke` | Run tests tagged `smoke` |
   | `regression` | Run ALL tests |
   | `suite:NAME` | Run named suite, e.g. `suite:limits-runtime` |
   | `id:RT-003` | Run a single test by ID |

5. **For each test:**
   1. Run `setup` (`sql` | `seed` ref | `http`+`capture` | `redis` | `exec` | `vars`)
   2. Execute `request` via curl (`http`) or `produce-event.sh` (`kafka`)
   3. Check `expect` (see Assertion Grammar below)
   4. Run `verify` SQL/Kafka queries (if present)
   5. Run `teardown` to restore state
   6. Report PASS / FAIL with details
6. **Run global `cleanup.all`** after all suites complete.
7. **Output results** in markdown table — see `references/results.md`.

## Assertion Grammar (what the runner actually checks)

These are machine-enforced by `_checklist_runner.py` (→ `checklist_lib/`). Anything
not listed here is NOT asserted — don't rely on prose `note:` for a pass/fail.

Under `expect:`
| Key | Meaning |
|-----|---------|
| `status: N` | exact HTTP status |
| `body_contains: "x"` or `[..]` | substring(s) present in the raw response body |
| `body_not_contains: "x"` or `[..]` | substring(s) absent |
| `json_path: "$.a == \"x\""` or `[..]` | JSONPath-lite expr(s): `== != > < >= <= contains exists`. Wildcards (`$[*].f`) require ALL matches to satisfy. |
| `poll: { sql, until, interval_ms, timeout_ms }` | async: poll the query until its scalar result equals `until` |
| `body:` (object — Page envelope) | `<field>: v` · `content_length: N` · `content: []` · `content_all_match: {}` · `content_contains: [{}]` |
| `body:` (bare top-level JSON array) | `root_length: N` · `root_all_match: {}` · `root_contains: [{}]` |

> A bare-array endpoint (`GET .../linked-cards` → `[{...},{...}]`) is asserted via
> `root_*`, `body_contains`, or `json_path: "$[*].field ..."` — NOT `content_*`
> (those reach into `body.content` of an object).

Under `verify:`
- `- sql: "..."  expect: <scalar | "<op> value">` → **HARD** assertion vs the scalar
  result (single column/row). A **dict** `expect:` (multi-column) is printed for
  context only (descriptive) — `db-query.sh -t` has no headers to map by name, so
  assert each column as its own scalar row, or via `json_path` on the API response.
- `- kafka_consumer_lag / kafka_dlt / kafka_topic` → **best-effort**: runs when `kcat`
  or a kafka docker container is present, otherwise **SKIP** (not FAIL) with a note.

Auto-injected vars: `${TEST_CORRELATION_ID}` (stable per run) and `${TEST_START}`
(refreshed per test, UTC in Postgres `now()::text` format so lexicographic
`updated_at > ${TEST_START}` comparisons hold). `capture:` extracts a var from an
`http` setup response (`{VAR: "$.id"}`, JSONPath) or a `sql` setup (first scalar).

## YAML Structure

The canonical, runnable, fully-annotated example is **`templates/CHECKLIST.yaml`**
(copy it to start a new checklist). The top-level shape:

```yaml
config:   { base_url, db: {database, ...}, redis: {host, port}, vars: {NAME: value} }
tokens:   { <name>: { payload | auth: keycloak_ropc | type: keycloak-client-credentials } }
seed:     { <name>: <SQL snippet> }      # referenced from setup via `- seed: <name>`
cleanup:  { all: <SQL> }                 # runs once after all suites
suites:
  - id: <suite>
    setup: [...]                         # sql | seed | http(+capture) | redis | exec | vars
    tests:
      - id: <TEST-ID>
        tags: [smoke, ...]
        setup: [...]                     # per-test
        request:                         # exactly ONE of http / kafka:
          method/path/token/body         #   http
          kafka: {topic, payload|payload_file, key, headers}
        expect: { ... }                  # see Assertion Grammar above
        verify: [ {sql, expect} | {kafka_consumer_lag|kafka_dlt|kafka_topic} ]
        teardown: [...]
```

Field-by-field meaning lives inline in `templates/CHECKLIST.yaml`; what each `expect`
/`verify` key actually asserts is the Assertion Grammar table above. (No `wait_ms` —
async settling is `expect.poll`.)

## Request Block — HTTP vs Kafka

Each test has exactly one `request` block. Pick the shape that matches the feature:

| Field | HTTP | Kafka |
|-------|------|-------|
| `method` + `path` + `token` + `body` | ✅ | — |
| `token: none` (or omit `token:`) → **send no auth header** | ✅ | — |
| `kafka.topic` + `kafka.payload` (or `payload_file`) | — | ✅ |
| `kafka.key` (partition key) | — | optional |
| `kafka.headers` (e.g. `userinfo`, `traceparent`) | — | optional |

`token:` names an entry in the top-level `tokens:` map. **For an unauthenticated
request — the 401/anonymous-access tests — write `token: none` or leave `token:` out
entirely.** Both send zero auth headers. Any other unmatched name is a real error
(the runner lists the declared token names so you can spot the typo).

For Kafka tests, `expect` has no HTTP `status` — use `poll` (poll DB/Redis until the expected state) to settle the async consumer.

`verify` extends with three Kafka-specific checks:
- `kafka_consumer_lag` — confirm consumer group offset advanced (`expect: 0`)
- `kafka_topic` — consume last N messages from an output topic and assert content
- `kafka_dlt` — assert DLT topic is empty (no poison-pill) or contains expected failure

Full Kafka mechanics + helpers: `references/kafka-events.md`.

## Variable Resolution

`${VAR}` placeholders resolve in this order:

1. `config.vars:` declared in the checklist (loaded first; values are themselves
   expanded, so `FOO: ${FOO:-default}` keeps an env override possible)
2. Auto-discovered values from DB query
3. Test-level `- vars: {NAME: value}` steps in setup blocks (and `capture:` vars)
4. Environment variables (`${VAR:-default}` inline defaults as last resort)

## Execution Notes

- Seed shared dependencies (parent records, FKs) once at the start of the suite.
- Run global `cleanup` ONLY AFTER all suites complete — shared seed data is needed across suites.
- Each test cleans up its own counter/usage rows in `setup` instead of relying on global cleanup.

## Starting a New Checklist — Auto-generation (preferred)

Use `checklist-init.sh` to auto-generate a scaffold instead of copying the template manually:

```bash
scripts/checklist-init.sh <feature-name>
# With path filter (narrows endpoint scan):
scripts/checklist-init.sh <feature-name> --path /api/v1/feature-prefix
```

What it does:
1. Detects stack from PROJECT_CONTEXT.yaml (or runs detection if missing)
2. Scans `src/main/` for controller/handler files matching the feature name or `--path`
3. Extracts full endpoint paths (class-level `@RequestMapping` + method-level `@GetMapping`, etc.; Summer `@Handler`)
4. Generates one placeholder test per discovered endpoint, auto-picking token by path prefix (`/bo/` → `bo_admin_mode_b`, `/internal/` → no auth)
5. Writes scaffold to `.claude/docs/manual-tests/features/<feature>/CHECKLIST.yaml`

After generation, **always review the file** and fill in the `TODO` markers before running tests:
- `setup` SQL seed queries
- `expect.note` — real expected behaviour
- `verify` SQL queries
- `teardown` — state restoration

If no endpoints are found, a single placeholder test is emitted with clear `TODO` markers.

### Manual fallback (if auto-gen can't discover endpoints)

```bash
mkdir -p .claude/docs/manual-tests/features/<feature>
cp <skill-dir>/templates/CHECKLIST.yaml .claude/docs/manual-tests/features/<feature>/CHECKLIST.yaml
# Then fill in the suites manually.
```
