#!/usr/bin/env bash
# state.sh — sourceable cache library for manual-test session state.
# NOT meant to be executed directly. Source from other scripts:
#
#   . "$(dirname "$0")/state.sh"
#   state_init                 # sets STATE_DIR, STATE_FILE based on cwd
#   state_load                 # ensure state.json exists, populate from cache file
#   state_set port 8081
#   state_get port
#   jwt_get bo                 # echoes cached BO JWT, fetching if missing/stale
#   jwt_set bo "<token>"
#
# Cache layout:
#   ~/.cache/manual-test/<project-hash>/
#     state.json               # discovered config (port, stack, creds-meta, test_user, ...)
#     jwt-bo.cache             # JWT + mtime determines TTL
#     jwt-eu.cache
#     last-response.json       # last api.sh response body
#
# State.json keys (string values; nested objects allowed):
#   project_root, project_name, stack, auth_mode, auth_path (A|B|C|none)
#   base_url, port
#   pg.host pg.port pg.db pg.user pg.pass        (pass NOT persisted by default; mask)
#   redis.host redis.port redis.pass
#   kc.realm_bo kc.client_bo kc.secret_bo
#   kc.realm_eu kc.client_eu kc.secret_eu
#   bo_user.username bo_user.password
#   test_user.id test_user.username test_user.password

set -u

# JWT default TTL in seconds (most Keycloak access tokens are 5 minutes)
JWT_TTL="${JWT_TTL:-240}"

state_init() {
  PROJECT_ROOT="$(pwd)"
  PROJECT_NAME="$(basename "$PROJECT_ROOT")"
  local hash
  hash=$(echo "$PROJECT_ROOT" | shasum 2>/dev/null | awk '{print $1}' | head -c 12)
  STATE_DIR="${MANUAL_TEST_CACHE:-$HOME/.cache/manual-test}/$hash"
  STATE_FILE="$STATE_DIR/state.json"
  mkdir -p "$STATE_DIR"
}

# Ensure state file exists with at least {project_root, project_name}.
state_load() {
  state_init
  if [ ! -f "$STATE_FILE" ]; then
    cat > "$STATE_FILE" <<EOF
{
  "project_root": "$PROJECT_ROOT",
  "project_name": "$PROJECT_NAME"
}
EOF
  fi
}

# Get a dotted key from state.json. Echo empty if missing.
state_get() {
  local key="$1"
  [ -f "$STATE_FILE" ] || return
  python3 - "$STATE_FILE" "$key" 2>/dev/null <<'PY'
import sys, json
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
for k in sys.argv[2].split('.'):
    if not isinstance(d, dict) or k not in d:
        sys.exit(0)
    d = d[k]
if d is None: sys.exit(0)
if isinstance(d, (dict, list)):
    print(json.dumps(d))
else:
    print(d)
PY
}

# Set a dotted key in state.json. Auto-creates intermediate dicts.
state_set() {
  local key="$1" val="$2"
  state_load
  python3 - "$STATE_FILE" "$key" "$val" <<'PY'
import sys, json, os
fp, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(fp) as f:
        d = json.load(f)
except Exception:
    d = {}
node = d
parts = key.split('.')
for k in parts[:-1]:
    if not isinstance(node.get(k), dict):
        node[k] = {}
    node = node[k]
node[parts[-1]] = val
tmp = fp + '.tmp'
with open(tmp, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
os.replace(tmp, fp)
PY
}

state_print() {
  state_load
  if command -v jq >/dev/null 2>&1; then
    jq . "$STATE_FILE"
  else
    cat "$STATE_FILE"
  fi
}

state_clear() {
  state_init
  rm -f "$STATE_DIR"/state.json "$STATE_DIR"/jwt-*.cache "$STATE_DIR"/last-response.json
  echo "Cleared: $STATE_DIR" >&2
}

# ─── JWT cache ──────────────────────────────────────────────────────────────
# jwt_get <audience>            audience = "bo" | "eu"
#   Returns cached token if file mtime is within JWT_TTL.
#   Otherwise echoes empty (caller should fetch + jwt_set).

jwt_path() {
  state_init
  echo "$STATE_DIR/jwt-$1.cache"
}

jwt_get() {
  local p; p=$(jwt_path "$1")
  [ -f "$p" ] || { return 1; }
  # File mtime check (BSD vs GNU stat)
  local mtime now
  mtime=$(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null)
  now=$(date +%s)
  [ -z "$mtime" ] && return 1
  if [ $((now - mtime)) -gt "$JWT_TTL" ]; then
    return 1   # stale
  fi
  cat "$p"
}

jwt_set() {
  local p; p=$(jwt_path "$1")
  printf '%s' "$2" > "$p"
  chmod 600 "$p" 2>/dev/null || true
}

jwt_clear() {
  state_init
  rm -f "$STATE_DIR"/jwt-*.cache
}

# Save last response body for inspection
last_response_path() {
  state_init
  echo "$STATE_DIR/last-response.json"
}
