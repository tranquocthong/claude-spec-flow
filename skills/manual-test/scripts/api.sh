#!/usr/bin/env bash
# api.sh — auto-auth curl wrapper. The "lazy mode" entry point.
#
# Usage:
#   scripts/api.sh GET  /api/v1/wallet/accounts
#   scripts/api.sh POST /api/v1/wallet/transfers/preview -d '{"amount":100}'
#   scripts/api.sh GET  /bo/api/v1/transactions -q 'page=0&size=5'
#   scripts/api.sh GET  /internal/api/v1/...      # auto skips auth
#   scripts/api.sh PRIME [--refresh]              # one-shot discovery & cache (reads PROJECT_CONTEXT.yaml if fresh)
#   scripts/api.sh CONTEXT [--refresh]            # print or refresh PROJECT_CONTEXT.yaml
#   scripts/api.sh REPEAT                         # re-run last request
#   scripts/api.sh STATE                          # print cached state
#   scripts/api.sh CLEAR                          # clear state + JWT cache
#
# Flags:
#   -d 'body'         JSON body
#   -q 'k=v&k2=v2'    Query string
#   -a bo|eu|none     Force auth audience (default: auto from path)
#   -H 'Header: val'  Extra header (repeatable)
#   --raw             Don't jq-pretty the response
#   --port PORT       Override detected port
#
# Auto-magic:
#   - Detects stack + port + auth-mode (cached in ~/.cache/manual-test/<hash>/)
#   - On PRIME: reads PROJECT_CONTEXT.yaml if fresh (< 7 days) to skip re-discovery
#   - After full discovery: writes PROJECT_CONTEXT.yaml for future sessions
#   - Fetches and caches JWT for Path B / C (TTL via $JWT_TTL, default 240s)
#   - Picks auth audience by path: /bo/ → bo, /internal/ → none, else → eu
#   - On non-2xx response, prints likely-cause hint from troubleshooting matchers
#   - Saves response to <cache>/last-response.json for REPEAT / inspection

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/state.sh"
. "$HERE/context.sh"

# ─── Special subcommands ────────────────────────────────────────────────────

cmd="${1:-}"
case "$cmd" in
  PRIME)
    FORCE_REFRESH="${2:-}"
    state_load

    # Try loading from PROJECT_CONTEXT.yaml first (skip re-discovery if fresh)
    if [ "$FORCE_REFRESH" != "--refresh" ] && context_is_fresh; then
      echo "[PRIME] PROJECT_CONTEXT.yaml is fresh — loading cached context (use PRIME --refresh to re-discover)." >&2
      context_load
      STACK="${CTX_STACK:-}"
      AUTH="${CTX_AUTH:-}"
      PORT="${CTX_PORT:-}"
      [ -n "$STACK" ] && state_set stack "$STACK"
      [ -n "$AUTH"  ] && state_set auth_mode "$AUTH"
      [ -n "$PORT"  ] && state_set port "$PORT"
      [ -n "$PORT"  ] && state_set base_url "http://localhost:$PORT"
      [ -n "${CTX_DB_HOST:-}" ] && { state_set pg.host "$CTX_DB_HOST"; state_set pg.port "${CTX_DB_PORT:-5432}"; state_set pg.db "${CTX_DB_NAME:-}"; state_set pg.user "${CTX_DB_USER:-postgres}"; }
      [ -n "${CTX_REDIS_HOST:-}" ] && { state_set redis.host "$CTX_REDIS_HOST"; state_set redis.port "${CTX_REDIS_PORT:-6379}"; }
      [ -n "${CTX_KC_BO_REALM:-}" ] && { state_set kc.realm_bo "$CTX_KC_BO_REALM"; state_set kc.client_bo "${CTX_KC_BO_CLIENT:-}"; }
      [ -n "${CTX_KC_EU_REALM:-}" ] && { state_set kc.realm_eu "$CTX_KC_EU_REALM"; state_set kc.client_eu "${CTX_KC_EU_CLIENT:-}"; }
      [ -n "${CTX_BO_USER:-}" ] && state_set bo_user.username "$CTX_BO_USER"
    else
      # Full discovery
      echo "[PRIME] Running full discovery..." >&2
      STACK=$("$HERE/detect-stack.sh" 2>/dev/null); state_set stack "$STACK"
      AUTH=$("$HERE/detect-auth.sh" 2>/dev/null);   state_set auth_mode "$AUTH"
      PORT=$("$HERE/port-detect.sh");                state_set port "$PORT"
      state_set base_url "http://localhost:$PORT"
      eval "$("$HERE/db-creds.sh" 2>/dev/null)"
      state_set pg.host "${PG_HOST:-}"; state_set pg.port "${PG_PORT:-5432}"
      state_set pg.db "${PG_DB:-}"; state_set pg.user "${PG_USER:-postgres}"
      state_set redis.host "${REDIS_HOST:-localhost}"; state_set redis.port "${REDIS_PORT:-6379}"

      # Persist to PROJECT_CONTEXT.yaml for future sessions
      CTX_STACK="$STACK"; CTX_AUTH="$AUTH"; CTX_PORT="$PORT"
      CTX_DB_HOST="${PG_HOST:-localhost}"; CTX_DB_PORT="${PG_PORT:-5432}"
      CTX_DB_NAME="${PG_DB:-}"; CTX_DB_USER="${PG_USER:-postgres}"
      CTX_REDIS_HOST="${REDIS_HOST:-localhost}"; CTX_REDIS_PORT="${REDIS_PORT:-6379}"
      context_write 2>/dev/null || true
    fi

    {
      echo "Primed manual-test cache:"
      state_print
      echo
      echo "── Freshness check ──"
      "$HERE/freshness-check.sh" --port "$PORT" 2>&1 | sed 's/^/  /'
      FRESH_RC="${PIPESTATUS[0]}"
      case "$FRESH_RC" in
        0) echo "  → OK to test." ;;
        1) cat <<EOF

  ⚠️  RUNNING SERVICE IS STALE.
  Tests will hit OLD code. Two options:
    a) Manual restart:   scripts/restart-service.sh           (asks before kill)
    b) Auto restart:     scripts/restart-service.sh --auto    (no prompt)
    c) Accept stale:     proceed (results may not reflect current source)
EOF
           ;;
        2) echo "  → Service unreachable on port $PORT. Start it first or override --port." ;;
      esac
    } >&2
    exit 0
    ;;

  CONTEXT)
    shift
    if [ "${1:-}" = "--refresh" ]; then
      exec "$0" PRIME --refresh
    fi
    if [ -f "$CONTEXT_FILE" ]; then
      cat "$CONTEXT_FILE"
    else
      echo "No PROJECT_CONTEXT.yaml found at: $CONTEXT_FILE" >&2
      echo "Run: scripts/api.sh PRIME" >&2
      exit 1
    fi
    exit 0
    ;;

  RESTART)
    shift
    exec "$HERE/restart-service.sh" "$@"
    ;;

  FRESH)
    shift
    state_load
    PORT_ARG="$(state_get port)"
    [ -z "$PORT_ARG" ] && PORT_ARG=$("$HERE/port-detect.sh")
    exec "$HERE/freshness-check.sh" --port "$PORT_ARG" "$@"
    ;;
  REPEAT)
    state_load
    LAST=$(state_get last_request)
    [ -z "$LAST" ] && { echo "No previous request cached." >&2; exit 1; }
    # last_request is shell-quoted argv string
    eval set -- $LAST
    ;;
  STATE)
    state_print; exit 0
    ;;
  CLEAR)
    state_clear; exit 0
    ;;
  ""|-h|--help)
    sed -n '2,30p' "$0" >&2
    exit 0
    ;;
esac

# ─── Parse args ────────────────────────────────────────────────────────────

METHOD="${1:-GET}"; shift
PATH_ARG=""
BODY=""
QUERY=""
AUTH_AUD=""
RAW=false
PORT_OVR=""
EXTRA_HEADERS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -d)        BODY="$2"; shift 2 ;;
    -q)        QUERY="$2"; shift 2 ;;
    -a)        AUTH_AUD="$2"; shift 2 ;;
    -H)        EXTRA_HEADERS+=("$2"); shift 2 ;;
    --raw)     RAW=true; shift ;;
    --port)    PORT_OVR="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) [ -z "$PATH_ARG" ] && PATH_ARG="$1" || { echo "Extra arg: $1" >&2; exit 1; }; shift ;;
  esac
done

if [ -z "$PATH_ARG" ]; then
  echo "Usage: $0 METHOD PATH [-d body] [-q query] [-a bo|eu|none] [-H 'K: v'] [--raw] [--port N]" >&2
  exit 1
fi

# ─── Load / prime state ────────────────────────────────────────────────────

state_load
PORT=$(state_get port)
STACK=$(state_get stack)
AUTH_MODE=$(state_get auth_mode)
if [ -z "$PORT" ] || [ -z "$STACK" ] || [ -z "$AUTH_MODE" ]; then
  STACK=$("$HERE/detect-stack.sh" 2>/dev/null); state_set stack "$STACK"
  AUTH_MODE=$("$HERE/detect-auth.sh" 2>/dev/null); state_set auth_mode "$AUTH_MODE"
  PORT=$("$HERE/port-detect.sh"); state_set port "$PORT"
fi
[ -n "$PORT_OVR" ] && PORT="$PORT_OVR"
BASE_URL="http://localhost:$PORT"

# Save argv for REPEAT
QUOTED_ARGV=$(printf "'%s' " "$METHOD" "$PATH_ARG" "$@" )
state_set last_request "$QUOTED_ARGV"

# ─── Pick auth audience ────────────────────────────────────────────────────

if [ -z "$AUTH_AUD" ]; then
  case "$PATH_ARG" in
    /internal/*|internal/*) AUTH_AUD="none" ;;
    /bo/*|bo/*)             AUTH_AUD="bo" ;;
    *)                      AUTH_AUD="eu" ;;
  esac
fi

# ─── Resolve JWT ───────────────────────────────────────────────────────────

JWT=""
if [ "$AUTH_AUD" != "none" ] && [ "$AUTH_MODE" != "no-auth" ]; then
  JWT=$(jwt_get "$AUTH_AUD" 2>/dev/null || true)

  if [ -z "$JWT" ]; then
    # Build kc-ropc args from cached creds
    REALM=$(state_get "kc.realm_$AUTH_AUD")
    CLIENT=$(state_get "kc.client_$AUTH_AUD")
    SECRET=$(state_get "kc.secret_$AUTH_AUD")
    USERNAME=""
    PASSWORD=""
    if [ "$AUTH_AUD" = "bo" ]; then
      USERNAME=$(state_get bo_user.username)
      PASSWORD=$(state_get bo_user.password)
    else
      USERNAME=$(state_get test_user.username)
      PASSWORD=$(state_get test_user.password)
    fi

    if [ -z "$REALM" ] || [ -z "$CLIENT" ] || [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
      cat >&2 <<EOF
[api.sh] Cannot mint JWT for audience '$AUTH_AUD' — missing cache entries:
  kc.realm_$AUTH_AUD     = '$REALM'
  kc.client_$AUTH_AUD    = '$CLIENT'
  kc.secret_$AUTH_AUD    = '<set?>'
  ${AUTH_AUD}_user.username = '$USERNAME'

Prime these first with state_set OR pass JWT via -H 'Authorization: Bearer <token>'.
Example:
  . scripts/state.sh && state_load
  state_set kc.realm_bo myapp_backoffice_dev
  state_set kc.client_bo <client-id>
  state_set kc.secret_bo <client-secret>
  state_set bo_user.username bo-admin
  state_set bo_user.password '<password>'
EOF
      exit 2
    fi

    JWT=$("$HERE/kc-ropc.sh" "$REALM" "$CLIENT" "$USERNAME" "$PASSWORD" "$SECRET" 2>&1)
    if [ ${#JWT} -lt 100 ]; then
      echo "[api.sh] kc-ropc.sh failed: $JWT" >&2
      exit 3
    fi
    jwt_set "$AUTH_AUD" "$JWT"
    echo "[api.sh] minted + cached fresh JWT for $AUTH_AUD" >&2
  fi
fi

# ─── Build curl ────────────────────────────────────────────────────────────

URL="$BASE_URL$PATH_ARG"
[ -n "$QUERY" ] && URL="$URL?$QUERY"

CURL_ARGS=(-sS -m 15 -X "$METHOD" "$URL")

[ -n "$JWT" ] && CURL_ARGS+=(-H "Authorization: Bearer $JWT")
[ -n "$BODY" ] && CURL_ARGS+=(-H "Content-Type: application/json" -d "$BODY")
for h in "${EXTRA_HEADERS[@]+"${EXTRA_HEADERS[@]}"}"; do
  CURL_ARGS+=(-H "$h")
done

LAST_RESP="$(last_response_path)"
HTTP_CODE=$(curl "${CURL_ARGS[@]}" -o "$LAST_RESP" -w "%{http_code}")

# ─── Display ───────────────────────────────────────────────────────────────

echo "HTTP=$HTTP_CODE  $METHOD  $URL  (auth=$AUTH_AUD)" >&2

if [ "$RAW" = "false" ] && command -v jq >/dev/null 2>&1 && \
   head -c 1 "$LAST_RESP" 2>/dev/null | grep -qE '[{\[]'; then
  jq . "$LAST_RESP" 2>/dev/null || cat "$LAST_RESP"
else
  cat "$LAST_RESP"
fi
echo

# ─── Gotcha matcher (on failure) ───────────────────────────────────────────

if [ "${HTTP_CODE:0:1}" != "2" ]; then
  BODY_TEXT=$(cat "$LAST_RESP")
  HINTS=""
  if echo "$BODY_TEXT" | grep -q "com.unauthorized.access"; then
    if [ "$AUTH_MODE" = "summer" ]; then
      HINTS="$HINTS
  - 401 com.unauthorized.access on Summer 0.3.x → X-Userinfo not trusted locally.
    Path B (Keycloak ROPC + Bearer JWT) required. JWT cache may be stale; \`api.sh CLEAR\` to refresh."
    else
      HINTS="$HINTS
  - 401 → missing/expired token. JWT TTL exceeded? Try \`api.sh CLEAR\` then re-run."
    fi
  fi
  if echo "$BODY_TEXT" | grep -q "com.access.denied"; then
    HINTS="$HINTS
  - 403 → token valid but roles insufficient. Path A: Redis seed missing/stale.
    Path B: Keycloak user's group lacks needed role. See references/auth.md → role testing matrix."
  fi
  if echo "$BODY_TEXT" | grep -qi "Type mismatch"; then
    HINTS="$HINTS
  - 400 'Type mismatch' → query-param date format. LocalDate wants '2026-04-01',
    LocalDateTime wants '2026-04-01T00:00:00'. Inspect @RequestParam type.
    See references/troubleshooting.md → Date/time."
  fi
  if echo "$BODY_TEXT" | grep -qi "Required.*not present"; then
    PARAM=$(echo "$BODY_TEXT" | grep -oE "'[^']+' is not present" | head -1)
    HINTS="$HINTS
  - 400 missing required query param $PARAM. Add to -q 'key=value' flag."
  fi
  if echo "$BODY_TEXT" | grep -qi "external.server.error\|Failed to retrieve.*from.*service"; then
    HINTS="$HINTS
  - 503 downstream-service error → local validation OK, but external stub down.
    Check stub-services running OR .env URLs (see references/ports.md, references/troubleshooting.md)."
  fi
  if echo "$BODY_TEXT" | grep -qi "com.conflict.occurred"; then
    HINTS="$HINTS
  - 409 → optimistic lock conflict, stale 'version'. Fetch latest version field first."
  fi
  if echo "$BODY_TEXT" | grep -qi "unauthorized_client.*Invalid client"; then
    HINTS="$HINTS
  - Keycloak 'unauthorized_client' → confidential client needs client_secret. Set state via:
    state_set kc.secret_$AUTH_AUD '<secret-from-.env>'"
  fi
  if [ -n "$HINTS" ]; then
    echo "──────── Likely cause: ────────$HINTS" >&2
  fi
fi
