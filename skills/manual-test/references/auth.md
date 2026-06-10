# Authentication — Full Detail

Decision tree (quick-probe → Path A or Path B) lives in `SKILL.md`. This file covers the detail once a path is chosen.

## Why X-Userinfo Fails on Summer 0.3.x BO Endpoints

The `summer-apisix` filter only trusts `X-Userinfo` when the request transits a trusted upstream (APISIX gateway). Locally there is no upstream → header is rejected → 401.

> **Security note:** services trust `X-Userinfo` only from the trusted upstream, which strips any client-supplied header — a forged header sent outside the gateway is rejected. Never expose a service port directly to an untrusted network. This is why local testing uses real Bearer tokens (Path B).

A separate, narrower bug exists in `summer-apisix` 0.2.4+: `getDecoder()` vs `getUrlDecoder()` breaks payloads containing `_` / `-` chars on the Bearer path. X-Userinfo failure is the more fundamental issue.

## Token Formats by Endpoint Type

### End-user endpoints (`/api/v1/...`)

```json
{"iat":1772680061,"exp":2088040061,"sub":"USER_UUID"}
```

- `sub` = userId (UUID from the user identity column in the main entity table)
- `iat` / `exp` = far-future timestamps to avoid expiry

### Backoffice endpoints (`/bo/api/v1/...`)

Two modes depending on `group-role-authorization` config — see "Path A — Mode Detection" below.

### Internal endpoints (`/internal/api/v1/...`)

No auth needed (`permitAll` in `SecurityConfig`). Used for service-to-service and webhooks.

---

## Path A — X-Userinfo Direct Injection

### Step 1 — Detect auth mode (run once per project)

**Don't trust `.env` flag alone — verify against Redis state.** A service can have `GROUP_ROLE_AUTHORIZATION_ENABLED=false` but still resolve roles via Redis `role_groups` (Mode mixed).

```bash
# 1a. Check .env flag (informational only — NOT authoritative)
grep "GROUP_ROLE_AUTHORIZATION_ENABLED" .env

# 1b. Check application.yml default
grep -A1 "group-role-authorization:" src/main/resources/application.yml | grep enabled

# 1c. AUTHORITATIVE — check Redis for seeded group-role mappings
redis-cli KEYS "auth-group-role:*" | head -5
```

| Signal | Implication |
|--------|-------------|
| `.env=false` + Redis empty | **Mode A pure** — `resource_access` in X-Userinfo works |
| `.env=false` + Redis has `auth-group-role:*` keys | **Mode mixed** — Path B (Keycloak ROPC) required, not Mode A |
| `.env=true` + Redis populated | **Mode B** — Path B required |

**Practical heuristic:** if quick-probe returns 401 on a `/bo/...` endpoint, go straight to Path B.

### Step 2 — Detect resource name + roles

```bash
find src -name "*Roles.java" -o -name "*Role.java" | head -5
grep -E "@ResourceDef|code = " src/main/java/**/config/security/*Roles.java | head -5
# → code = "myservice"  ← resource name used in tokens
```

### Step 3a — Mode A token (`group-role-authorization: false`)

```json
{
  "iat":1772680061,"exp":2088040061,"sub":"bo-admin",
  "email":"bo-admin@example.com",
  "resource_access":{
    "{resource_name}":{
      "roles":["{feature_code}:{action}", ...]
    }
  }
}
```

- Role value = strip `"{resource_name}:"` prefix from the constant.
  Example: `MY_FEATURE_VIEW = "myservice:my_feature:view"` → put `"my_feature:view"` in `roles[]`.
- **`email` is required for write endpoints** — used for `updatedBy` audit trail. Missing → NPE (500).

```bash
BO_TOKEN=$(echo -n '{"iat":1772680061,"exp":2088040061,"sub":"bo-admin","email":"bo-admin@example.com","resource_access":{"{resource_name}":{"roles":["{feature}:{action}"]}}}' | base64 | tr -d '\n')
```

### Step 3b — Mode B token (`group-role-authorization: true`) + Redis seed

```bash
# 1. Get Redis key prefix
grep "key-prefix" src/main/resources/application.yml
# → key-prefix: "auth-group-role:"

# 2. Seed group → roles into Redis (full format: {resource}:{feature}:{action})
redis-cli SADD "{key-prefix}test-admin" \
  "{resource}:{feature}:{action}" \
  "{resource}:{feature2}:{action2}"
redis-cli EXPIRE "{key-prefix}test-admin" 3600

# 3. Generate token with role_groups claim
BO_TOKEN=$(echo -n '{"iat":1772680061,"exp":2088040061,"sub":"bo-admin","email":"bo-admin@example.com","role_groups":["test-admin"]}' | base64 | tr -d '\n')
```

> **L1 Caffeine cache (default TTL 60s):** after Redis seed, wait up to 60s or restart app.
> Still 403 after waiting? Confirm seed: `redis-cli SMEMBERS "{key-prefix}test-admin"`.

---

## Path B — Keycloak ROPC + Bearer JWT

Use when quick-probe returns 401 with X-Userinfo direct injection.

### Prerequisites

1. Keycloak running locally: `docker ps | grep keycloak`
2. BO realm exists (typically `myapp_backoffice_dev`)
3. BO user seeded — check `<your-keycloak-seed-script>` for project-standard credentials (e.g. `bo-admin / <password>`)
4. Client has `directAccessGrantsEnabled=true` (ROPC) — the seed script ensures this for `<client-id>`

### Fetch JWT

```bash
# 1. Discover realm + client + secret (env wins over yml default)
grep -E "realm|client-id|client.secret|CLIENT_SECRET" \
  src/main/resources/application.yml .env 2>/dev/null | head -10
# → realm:         ${KEYCLOAK_BACKOFFICE_REALM:myapp_backoffice_dev}
# → client-id:     ${KEYCLOAK_BACKOFFICE_CLIENT_ID:<client-id>}
# → client-secret: ${KEYCLOAK_BACKOFFICE_CLIENT_SECRET}   ← MUST come from .env
# → .env: KEYCLOAK_BACKOFFICE_CLIENT_SECRET=<client-secret>

# 2. Fetch (use the helper). Pass the secret unless you confirmed it's a public client.
JWT=$(scripts/kc-ropc.sh <realm> <client> <user> <pass> <client-secret>)

# 3. Call endpoint with Authorization: Bearer (NOT X-Userinfo)
curl -s "http://localhost:PORT/bo/api/v1/..." \
  -H "Authorization: Bearer $JWT"
```

> **Confidential vs public clients (very common mis-step):**
> Most Summer BO and end-user clients (`<client-id>`, `<enduser-client-id>`) are **confidential** — they require `client_secret` in the ROPC call. Omitting it returns `401 {"error":"unauthorized_client","error_description":"Invalid client or Invalid client credentials"}`. The secret is in `.env` (`KEYCLOAK_*_CLIENT_SECRET`), never in `application.yml`. If kc-ropc.sh returns empty / errors with "Keycloak request failed", the missing secret is the #1 suspect.

### Verify JWT actually has the roles you need

The default `bo-admin / <password>` user from `<your-keycloak-seed-script>` may only have `realm-management` roles, not application `resource_access` or `role_groups`. Decode before assuming:

```bash
scripts/decode-jwt.sh "$JWT"
```

| What you see | Action |
|--------------|--------|
| Only `resource_access.realm-management` | Wrong user — find another with `role_groups` matching Redis seed |
| `role_groups: ["/super-admin"]` only | Check `redis-cli SMEMBERS "{key-prefix}{group-path}"` covers the needed role |
| `role_groups: ["/your-admin-group", ...]` | Likely OK — if the group carries full role coverage for the needed permissions |

### Find an alternative user when the default is insufficient

```bash
KC_ADMIN_TOKEN=$(curl -sf "http://localhost:8180/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
curl -sf "http://localhost:8180/admin/realms/myapp_backoffice_dev/users" \
  -H "Authorization: Bearer $KC_ADMIN_TOKEN" | python3 -m json.tool | grep -E '"username"|"email"'
```

### Path B notes

- Role mapping is via Keycloak groups → `role_groups` claim in JWT. Seed script assigns user to a super-admin group whose member roles cover all the backoffice clients your app defines.
- For **role denial (403) tests**: create a second user in a group with reduced roles — can't strip roles from JWT after issuance.
- For **end-user endpoints** (`/api/v1/...`): same ROPC pattern, different realm (typically `myapp_dev`) + different user.
- Don't mix paths within one test run. Switching mid-suite causes confusing 401/403 mixes.

---

## Path B — UAT-Dumped Data Pattern

When data was dumped from UAT into local DB (user_id, external_ref all FK to entities that may NOT exist in local Keycloak), **don't** build a Path A token with `sub=<dump_user_id>` — that user doesn't exist locally, the token will 401.

Instead: use a Path B service-role JWT (e.g. `bo-admin` or any user with the needed view role). BO endpoints are designed for cross-user inspection — the endpoint loads the record from DB regardless of who the record "belongs to".

```bash
# DB is source of truth — find dumped record directly
PGPASSWORD=postgres psql -h localhost -U postgres -d app_db -t -c \
  "SELECT id, external_ref FROM entities ORDER BY created_at DESC LIMIT 5"

# Service JWT — NOT user-scoped
JWT=$(scripts/kc-ropc.sh myapp_backoffice_dev <client-id> "$BO_USER" "$BO_PASS" "$SECRET")

curl -s "http://localhost:<service-port>/bo/api/v1/entities/$DUMPED_ID" \
  -H "Authorization: Bearer $JWT"
```

---

## Role Testing Matrix

Always test these combinations:

| Scenario | Path A expected | Path B expected |
|----------|-----------------|-----------------|
| No auth header | 401 `com.unauthorized.access` | 401 `com.unauthorized.access` |
| Wrong / missing roles | 403 `com.access.denied` | 403 (use second Keycloak user with reduced role group) |
| View-only role on write endpoint | 403 | 403 |
| Valid roles | 200 | 200 |
