# Lazy Mode — 3 commands to run a test

## TL;DR

```bash
# Once per project (or after a long break — JWT TTL = 240s):
scripts/api.sh PRIME                    # detect stack + auth + port + creds + FRESHNESS check
scripts/test-user.sh                    # auto-pick + cache an active test user

# Then for every test:
scripts/api.sh GET /api/v1/entities
scripts/api.sh POST /api/v1/entities/preview -d '{"amount":1000}'
scripts/api.sh GET /bo/api/v1/transactions -q 'page=0&size=5'
```

`api.sh` auto-detects port, auto-picks audience (`bo` for `/bo/`, `none` for `/internal/`, `eu` otherwise), auto-fetches and caches the JWT, pretty-prints with jq, and saves the last response.

## Freshness

`PRIME` runs `freshness-check.sh` automatically. It hits `/actuator/info` (or `/info`) and compares `git.commit.id` to `HEAD`.

| Status | Meaning | Action |
|--------|---------|--------|
| `fresh` | Running commit = HEAD AND working tree clean | Proceed |
| `stale` | Running commit ≠ HEAD, OR working tree dirty | **Restart before testing** |
| `unknown` | Service responds but no `/info` endpoint | Decide manually |
| `unreachable` | No HTTP response on the port | Start the service first |

### Restart paths

```bash
scripts/api.sh RESTART                 # confirms before kill (default)
scripts/api.sh RESTART --auto          # no prompt (only with /manual-test --auto)
scripts/api.sh RESTART --kill-only     # kill without restart
scripts/api.sh RESTART --cmd './gradlew bootRun --args="--server.port=8081"'
scripts/api.sh FRESH                   # re-check freshness later
```

Start commands per stack:
- `java-spring`: `./gradlew bootRun` → `./mvnw spring-boot:run` → `gradle bootRun` → `mvn spring-boot:run`
- `node`: `npm run dev` → `npm run start` → `node .`
- `python`: `python manage.py runserver` (Django) → `uvicorn` (FastAPI) → `flask run`
- `go`: `go run .`
- `dotnet`: `dotnet run --urls=http://localhost:$PORT`

Restart waits up to `START_TIMEOUT` seconds (default 90). Logs: `~/.cache/manual-test/<hash>/service.log`.

### Port resolution order

1. OS env `SERVER_PORT` / `PORT` / `APP_PORT` / `HTTP_PORT`
2. `.env` file (same keys)
3. `application.yml` → `server.port` (resolves `${...}` placeholders)
4. `package.json` script flags (`--port`, `-p`)
5. `docker-compose.yml` host-port mapping
6. Probe common candidate ports against `/health`

Override: `scripts/api.sh GET /... --port 9090`.

## Before vs After

**Before:**
```bash
JWT=$(curl -sf -X POST "http://localhost:8180/realms/myapp_backoffice_dev/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=<client-id>&client_secret=<client-secret>&username=bo-admin&password=<password>" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
curl -sS "http://localhost:8081/bo/api/v1/transactions?page=0&size=5" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" | jq .
```

**After:**
```bash
scripts/api.sh GET /bo/api/v1/transactions -q 'page=0&size=5'
```

## Auth Audience Auto-Picker

| Path prefix | Audience | Token source |
|-------------|----------|--------------|
| `/internal/*` | `none` | No auth header |
| `/bo/*` | `bo` | `kc.realm_bo` / `kc.client_bo` / `bo_user.*` |
| (anything else) | `eu` | `kc.realm_eu` / `kc.client_eu` / `test_user.*` |
| (override) | `-a bo\|eu\|none` | Explicit |

## PROJECT_CONTEXT.yaml

On first `PRIME`, discovered config is written to `.claude/docs/manual-tests/PROJECT_CONTEXT.yaml`. Subsequent `PRIME` reads this file — making startup near-instant. No secrets stored.

```yaml
generated_at: 2026-05-25T10:00:00Z
stack: java-spring
auth: summer
port: 8081
health_endpoint: /actuator/health
db_host: localhost
db_port: 5432
db_name: myapp_db
db_user: postgres
redis_host: localhost
redis_port: 6379
kc_bo_realm: myapp_backoffice_dev
kc_bo_client: <client-id>
kc_eu_realm: myapp_dev
kc_eu_client: <enduser-client-id>
kafka_broker: localhost:9092
bo_user: bo-admin
```

Secrets (passwords, client secrets) are **never stored here** — read from `.env` at runtime.

```bash
scripts/api.sh CONTEXT              # print current PROJECT_CONTEXT.yaml
scripts/api.sh CONTEXT --refresh    # force re-discover + rewrite
scripts/api.sh PRIME --refresh      # full re-prime + rewrite context
```

Freshness TTL: **7 days**. Safe to commit — no secrets. Gitignore if port/DB names differ per developer.

## Session Cache

Ephemeral per-session cache at `~/.cache/manual-test/<project-hash>/`:

```
state.json              # runtime state (port, stack, auth, test_user, kc.* — including secrets)
jwt-bo.cache            # BO JWT, mtime → TTL (240s default; override via JWT_TTL)
jwt-eu.cache            # End-user JWT, same TTL
last-response.json      # body of last api.sh call
```

```bash
scripts/api.sh STATE    # pretty-print state.json
scripts/api.sh CLEAR    # wipe state + JWT cache (forces full re-prime)
scripts/api.sh REPEAT   # re-run the last request
JWT_TTL=3600 scripts/api.sh GET /api/v1/...   # cache JWT for 1 hour
```

## Manually Setting State

```bash
. scripts/state.sh && state_load

state_set kc.realm_bo    myapp_backoffice_dev
state_set kc.client_bo   <client-id>
state_set kc.secret_bo   <client-secret>
state_set bo_user.username  bo-admin
state_set bo_user.password '<password>'

state_set kc.realm_eu    myapp_dev
state_set kc.client_eu   <enduser-client-id>
state_set kc.secret_eu   <client-secret>
# test_user.* populated by test-user.sh
```

Or pass JWT explicitly:

```bash
scripts/api.sh GET /bo/api/v1/... -H "Authorization: Bearer $MY_TOKEN" -a none
```

## Inline Gotcha Matcher

Non-2xx responses are scanned for known failure patterns:

> **Note:** The error codes below (`com.*`) are Summer Framework conventions. Other stacks will use different error code formats — adapt the patterns to match your framework's error response shape.

| Body pattern | Hint |
|--------------|------|
| `com.unauthorized.access` | "401 → token stale or wrong path. CLEAR cache to refresh." |
| `com.access.denied` | "403 → role missing; check Redis seed or KC group." |
| `Type mismatch` | "400 → LocalDate vs LocalDateTime format. Inspect @RequestParam." |
| `Required.*not present` | "400 → missing required query param `<name>`. Add to -q." |
| `external.server.error` | "503 → downstream stub down. Check stub-services / .env URLs." |
| `com.conflict.occurred` | "409 → optimistic lock; refresh `version`." |
| `unauthorized_client` from KC | "Confidential client needs `kc.secret_<aud>`." |

## Common Idioms

| Goal | Command |
|------|---------|
| Quick sanity check | `scripts/api.sh GET /actuator/health -a none` |
| Test BO list endpoint | `scripts/api.sh GET /bo/api/v1/X -q 'page=0&size=5'` |
| Test end-user create | `scripts/api.sh POST /api/v1/X -d '{"...":"..."}'` |
| Test internal callback | `scripts/api.sh POST /internal/api/v1/X/callback -d '{...}'` |
| Replay last call | `scripts/api.sh REPEAT` |
| Inspect cached state | `scripts/api.sh STATE` |
| Reset everything | `scripts/api.sh CLEAR` |
| Raw body (skip jq) | `scripts/api.sh GET /... --raw` |
| Force port | `scripts/api.sh GET /... --port 9090` |
| Custom header | `scripts/api.sh GET /... -H 'X-Trace-Id: t-1'` |
| DB peek | `scripts/db-query.sh -d app_db "SELECT * FROM entity WHERE id='...'"` |

## Non-Spring Projects

For non-Keycloak auth (e.g. Node `/auth/login`):

```bash
JWT=$(curl -sf -X POST http://localhost:3000/auth/login \
  -d '{"email":"...","password":"..."}' | jq -r '.token')
scripts/api.sh GET /api/users -H "Authorization: Bearer $JWT" -a none
```
Or extend `api.sh` to call your project's login endpoint when audience='eu' is uncached.
