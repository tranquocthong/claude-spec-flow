# Plain JWT Auth — Non-Summer Spring Boot

Use this path when the project is **not** Summer Framework (no `io.f8a.summer:summer-platform` dependency) and uses standard Spring Boot JWT — typically `spring-boot-starter-oauth2-resource-server` or a custom JWT filter.

For Summer Framework projects, use `references/auth.md` instead. Detection: `scripts/detect-auth.sh`.

## Telltale Signs of Plain-JWT Project

```bash
# Spring's OAuth2 resource server (validates JWT, no custom header magic)
grep -E "spring-boot-starter-oauth2-resource-server|spring-security-oauth2-jose" build.gradle build.gradle.kts pom.xml 2>/dev/null

# JWT library directly
grep -E "jjwt|java-jwt|nimbus-jose-jwt" build.gradle build.gradle.kts pom.xml 2>/dev/null

# Issuer / JWK config
grep -E "issuer-uri|jwk-set-uri|jwt:" src/main/resources/application.yml
```

If any matches AND no `summer-apisix` / `summer-platform` → plain JWT.

## Token Acquisition — 3 Common Patterns

### Pattern 1 — App has its own `/login` endpoint

```bash
# Discover login endpoint
grep -rn "@PostMapping.*login\|/auth/login\|/token" src/main/java | head -5

# Exchange creds for JWT
JWT=$(curl -sf -X POST http://localhost:PORT/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test@example.com","password":"Test@1234"}' \
  | sed -n 's/.*"\(access_token\|token\|jwt\)":"\([^"]*\)".*/\2/p')

# Use it
curl -s http://localhost:PORT/api/v1/... -H "Authorization: Bearer $JWT"
```

### Pattern 2 — External IDP (Keycloak / Auth0 / Cognito) — OAuth2 Resource Server

```bash
# Discover issuer from application.yml
grep -E "issuer-uri|jwk-set-uri" src/main/resources/application.yml
# → issuer-uri: http://localhost:8180/realms/my-realm

# Fetch JWT via ROPC (if external IDP is local Keycloak — reuse the Summer helper)
JWT=$(scripts/kc-ropc.sh <realm> <client-id> <username> <password> [client-secret] [keycloak-url])

curl -s http://localhost:PORT/api/v1/... -H "Authorization: Bearer $JWT"
```

The same `kc-ropc.sh` works — it's IDP-agnostic, just hits the standard OIDC token endpoint.

For non-Keycloak IDPs (Auth0, Cognito, Okta), substitute the token-URL:

```bash
# Auth0 example
JWT=$(curl -sf -X POST "https://<tenant>.auth0.com/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"password","client_id":"...","username":"...","password":"...","audience":"..."}' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
```

### Pattern 3 — Static-signed JWT (dev / shared-secret HS256)

If the project signs JWTs with a static secret (common in `spring.security.oauth2.resourceserver.jwt.secret` or custom filter), you can mint one locally without hitting any login endpoint.

```bash
# Find the signing secret
grep -E "secret:|hmac|HS256|signing-key" src/main/resources/application.yml .env 2>/dev/null

# Mint with python (needs pyjwt: pip install pyjwt)
JWT=$(python3 -c "
import jwt, time
secret = 'YOUR_SECRET_HERE'
payload = {
  'sub': 'test-user',
  'iat': int(time.time()),
  'exp': int(time.time()) + 3600,
  'roles': ['USER','ADMIN'],
  'email': 'test@example.com'
}
print(jwt.encode(payload, secret, algorithm='HS256'))
")

curl -s http://localhost:PORT/api/v1/... -H "Authorization: Bearer $JWT"
```

For RS256 (asymmetric), you need the private key — usually not in the repo. Fall back to Pattern 1 or 2.

## Verify JWT Has Required Roles / Claims

Same as Summer Path B — use the universal decoder:

```bash
scripts/decode-jwt.sh "$JWT"
```

## Detect How Roles Are Authorized

Plain Spring Boot has several authorization patterns. Inspect the controller and security config:

```bash
# Method-level
grep -rn "@PreAuthorize\|@Secured\|@RolesAllowed" src/main/java | head -10

# Filter / config-level
grep -rn "hasAuthority\|hasRole\|authorities" src/main/java/**/config/ 2>/dev/null | head -10
```

| Expression | Token claim it reads |
|------------|---------------------|
| `@PreAuthorize("hasRole('ADMIN')")` | `roles` or `authorities` claim, **prefixed `ROLE_`** internally |
| `@PreAuthorize("hasAuthority('SCOPE_read')")` | `scope` claim, joined with `SCOPE_` prefix |
| `@PreAuthorize("hasAuthority('ADMIN')")` | `authorities` claim, no prefix |
| `@PreAuthorize("@authz.canAccess(...)")` | Custom SpEL → read the bean's source |

> **Spring Security quirk:** `hasRole('X')` expects the authority `ROLE_X` to be in the principal. If you mint your own JWT with `"roles":["ADMIN"]`, the JWT converter must map it to `ROLE_ADMIN` — otherwise `hasRole` returns false even though the role is "present".

Read the `JwtAuthenticationConverter` / `JwtGrantedAuthoritiesConverter` config to know which claim it reads and how it prefixes:

```bash
grep -rn "JwtAuthenticationConverter\|setAuthoritiesClaimName\|setAuthorityPrefix" src/main/java
```

## Quick-Probe (Plain JWT)

```bash
# 1. Hit endpoint with no auth — expect 401
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" "http://localhost:PORT/api/v1/..."
# → 401 expected

# 2. Hit with a dummy Bearer — expect 401 (bad token)
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" \
  "http://localhost:PORT/api/v1/..." -H "Authorization: Bearer not.a.jwt"
# → 401 (signature/format invalid)

# 3. Hit with valid JWT — expect 200 / 403 / 404 (anything ≠ 401)
JWT=...  # from Pattern 1, 2, or 3
curl -sS -o /dev/null -w "HTTP=%{http_code}\n" \
  "http://localhost:PORT/api/v1/..." -H "Authorization: Bearer $JWT"
```

If step 3 still returns 401: signing key mismatch, expired token, wrong issuer, or audience claim missing. Decode and inspect:

```bash
scripts/decode-jwt.sh "$JWT"
# Check: iss, aud, exp vs current time, alg
```

## Role Testing Matrix (Plain JWT)

| Scenario | Expected |
|----------|----------|
| No Authorization header | 401 (Spring's default unauthenticated response) |
| Malformed token | 401 |
| Expired token | 401 with `WWW-Authenticate: Bearer error="invalid_token"` |
| Valid token, wrong role | 403 (Spring's `AccessDeniedHandler`) |
| Valid token, correct role | 200 |

## Common Gotchas (Plain JWT)

| Symptom | Cause |
|---------|-------|
| 401 even with valid-looking JWT | Wrong `iss` / `aud`; signing key drift; clock skew (`exp` validation strict) |
| 403 despite `roles` claim present | `JwtAuthenticationConverter` reads a different claim, or `hasRole` expects `ROLE_` prefix not present in token |
| Works in Postman, fails in curl | Trailing newline in `$JWT` — use `tr -d '\n'` if you piped through `base64` |
| Login endpoint returns 200 but token doesn't work | Sometimes login returns refresh-token instead of access-token; check `decode-jwt.sh` output for `typ` and `iss` |
