#!/usr/bin/env bash
# test-user.sh — auto-discover an active test entity to use as the end-user `sub`.
#
# Heuristic — try each in order, use the first hit:
#   1. Read user_id pattern from project's main entity table (configurable)
#   2. Match against Keycloak realm users (UUID equality)
#   3. Inspect realm JSON exports for the user's password (dev seed scripts)
#   4. Cache into state.json: test_user.{id, username, password}
#
# Project-specific knobs (via env or args):
#   TEST_USER_TABLE       SQL table to scan (default: auto-detect among accounts, users, user, party, customer)
#   TEST_USER_ID_COL      Column holding the user-id UUID (default: user_id)
#   TEST_USER_FILTER      Extra WHERE clause (default: status='ACTIVE')
#   KC_URL                Keycloak base URL (default: http://localhost:8180)
#   KC_REALM_EU           End-user realm name (default: from state.json kc.realm_eu)
#   KC_REALM_SEED_FILE    Path to realm export JSON for password lookup
#                         (default: try common locations)
#
# Usage:
#   scripts/test-user.sh           # discover + cache; print summary
#   scripts/test-user.sh --print   # print cached entry without rediscovering

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/state.sh"
state_load

MODE="discover"
[ "${1:-}" = "--print" ] && MODE="print"

if [ "$MODE" = "print" ]; then
  echo "test_user.id       = $(state_get test_user.id)"
  echo "test_user.username = $(state_get test_user.username)"
  P=$(state_get test_user.password)
  echo "test_user.password = $(echo "$P" | sed 's/./*/g')"
  exit 0
fi

# Load DB creds
eval "$("$HERE/db-creds.sh" 2>/dev/null)"

# ─── 1. Find a candidate table ─────────────────────────────────────────────

PSQL() { PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tA "$@"; }

TABLE="${TEST_USER_TABLE:-}"
COL="${TEST_USER_ID_COL:-user_id}"
FILTER="${TEST_USER_FILTER:-status='ACTIVE'}"

if [ -z "$TABLE" ]; then
  for cand in accounts users user party customers customer; do
    EXISTS=$(PSQL -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$cand'" 2>/dev/null)
    if [ -n "$EXISTS" ]; then
      # Check if column exists too
      HAS_COL=$(PSQL -c "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$cand' AND column_name='$COL'" 2>/dev/null)
      if [ -n "$HAS_COL" ]; then
        TABLE="$cand"; break
      fi
    fi
  done
fi

if [ -z "$TABLE" ]; then
  echo "[test-user.sh] Could not find a table with column '$COL'." >&2
  echo "Override via TEST_USER_TABLE / TEST_USER_ID_COL env vars." >&2
  echo "Agent: inspect schema → scripts/db-query.sh \"\\dt\"" >&2
  exit 1
fi

# ─── 2. Query for an active UUID-format user ───────────────────────────────

UUID_LIKE="$COL ~ '^[0-9a-f]{8}-'"
USER_ID=$(PSQL -c "SELECT $COL FROM $TABLE WHERE $FILTER AND $UUID_LIKE LIMIT 1" 2>/dev/null | head -1)

if [ -z "$USER_ID" ]; then
  # Try without UUID filter — maybe app uses different ID format
  USER_ID=$(PSQL -c "SELECT $COL FROM $TABLE WHERE $FILTER LIMIT 1" 2>/dev/null | head -1)
fi

if [ -z "$USER_ID" ]; then
  echo "[test-user.sh] No active record in $TABLE (filter: $FILTER)." >&2
  exit 1
fi

echo "Found candidate user_id: $USER_ID (table=$TABLE)" >&2
state_set test_user.id "$USER_ID"

# ─── 3. Match against Keycloak end-user realm ──────────────────────────────

KC_URL="${KC_URL:-http://localhost:8180}"
REALM_EU="${KC_REALM_EU:-$(state_get kc.realm_eu)}"

USERNAME=""
if [ -n "$REALM_EU" ]; then
  KC_ADMIN_TOKEN=$(curl -sf "$KC_URL/realms/master/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" 2>/dev/null \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

  if [ -n "$KC_ADMIN_TOKEN" ]; then
    USERNAME=$(curl -sf "$KC_URL/admin/realms/$REALM_EU/users/$USER_ID" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null \
      | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('username',''))" 2>/dev/null)
  fi
fi

[ -n "$USERNAME" ] && state_set test_user.username "$USERNAME"

# ─── 4. Look up password from realm export JSON (dev seed convention) ──────

PWD_VAL=""
PWD_SEARCH_PATHS=(
  "${KC_REALM_SEED_FILE:-}"
  "$(find . -maxdepth 6 -name "*${REALM_EU}*realm*.json" 2>/dev/null | head -1)"
  "$(find .. -maxdepth 4 -name "*${REALM_EU}*.json" 2>/dev/null | head -1)"
)
for f in "${PWD_SEARCH_PATHS[@]}"; do
  [ -z "$f" ] || [ ! -f "$f" ] && continue
  if [ -n "$USERNAME" ]; then
    # Walk JSON to find this user's credentials
    PWD_VAL=$(python3 - "$f" "$USERNAME" 2>/dev/null <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
target = sys.argv[2]
for u in d.get('users', []):
    if u.get('username') == target:
        for c in u.get('credentials', []):
            if c.get('type') == 'password':
                print(c.get('value','')); sys.exit(0)
# Fallback: any first password credential in file
for u in d.get('users', []):
    for c in u.get('credentials', []):
        if c.get('type') == 'password':
            print(c.get('value','')); sys.exit(0)
PY
)
  fi
  [ -n "$PWD_VAL" ] && { echo "Password found in $f" >&2; break; }
done

[ -n "$PWD_VAL" ] && state_set test_user.password "$PWD_VAL"

# ─── Output ────────────────────────────────────────────────────────────────

cat <<EOF >&2

── Cached test_user ────────────────────────────────
  id       : $USER_ID
  username : ${USERNAME:-<unknown — pass via state_set test_user.username>}
  password : $([ -n "$PWD_VAL" ] && echo "***found***" || echo "<unknown — set via state_set test_user.password>")
  table    : $TABLE
  realm    : ${REALM_EU:-<set state kc.realm_eu>}

To fetch end-user JWT: scripts/api.sh GET /api/v1/...   (api.sh auto-mints)
EOF
