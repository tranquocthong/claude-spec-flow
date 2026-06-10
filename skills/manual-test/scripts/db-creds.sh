#!/usr/bin/env bash
# db-creds.sh — discover Postgres + Redis credentials, polymorphic by stack.
# Prints export statements; intended for: `eval $(scripts/db-creds.sh)`
#
# Stack handling:
#   java-spring  → parse application.yml (resolves ${ENV_VAR:default}) + .env fallback
#   node|python|go|dotnet → .env only + common env-name guesses (DATABASE_URL etc.)
#   unknown      → .env scan + agent hints to stderr
#
# Common env names probed regardless of stack:
#   DATABASE_URL, POSTGRES_URL, DB_URL (full URL form)
#   DB_HOST/PORT/USER/PASSWORD/NAME, POSTGRES_*, PG*
#   REDIS_URL, REDIS_HOST/PORT/PASSWORD
#
# Usage:
#   eval $(scripts/db-creds.sh)           # export vars into current shell
#   scripts/db-creds.sh --print           # human-readable summary (to stderr)
#   scripts/db-creds.sh [project-root]    # operate against another project dir

set -u
MODE="export"
ROOT="."
for arg in "$@"; do
  case "$arg" in
    --print) MODE="print" ;;
    -*) ;;
    *) ROOT="$arg" ;;
  esac
done
cd "$ROOT" 2>/dev/null || { echo "Project root not found: $ROOT" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
STACK=$("$HERE/detect-stack.sh" "$ROOT" 2>/dev/null)

# ─── helpers ──────────────────────────────────────────────────────────────────

# Look up KEY in .env (line: KEY=value). Strips surrounding quotes.
env_get() {
  local key="$1"
  [ -f .env ] || return
  grep -E "^${key}=" .env 2>/dev/null | tail -1 \
    | sed -E "s/^${key}=//; s/^['\"]//; s/['\"]$//"
}

# Resolve `${ENV_NAME:default}` placeholder. Order: OS env > .env file > literal default.
resolve_placeholder() {
  local val="$1"
  [ -z "$val" ] && return
  if [[ "$val" =~ ^\$\{([^:}]+):?(.*)\}$ ]]; then
    local var="${BASH_REMATCH[1]}"
    local def="${BASH_REMATCH[2]}"
    local got="${!var:-}"
    [ -z "$got" ] && got=$(env_get "$var")
    [ -z "$got" ] && got="$def"
    echo "$got"
  else
    echo "$val"
  fi
}

# Find leaf value at indented dotted yml path. (Spring projects only.)
yml_value() {
  local path="$1" yml="$2"
  python3 - "$yml" "$path" 2>/dev/null <<'PY'
import sys, re
path = sys.argv[2].split('.')
with open(sys.argv[1]) as f:
    lines = f.readlines()
stack = []
for raw in lines:
    if not raw.strip() or raw.lstrip().startswith('#'):
        continue
    m = re.match(r'^(\s*)([A-Za-z0-9_\-]+)\s*:\s*(.*?)\s*$', raw.rstrip('\n'))
    if not m: continue
    indent, key, val = len(m.group(1)), m.group(2), m.group(3)
    while stack and stack[-1][0] >= indent:
        stack.pop()
    stack.append((indent, key))
    if [k for _, k in stack] == path and val:
        print(val.strip('"').strip("'")); sys.exit(0)
PY
}

resolve_yml_any() {
  local yml="$1"; shift
  [ -z "$yml" ] && return
  local p raw resolved
  for p in "$@"; do
    raw=$(yml_value "$p" "$yml")
    resolved=$(resolve_placeholder "$raw")
    [ -n "$resolved" ] && { echo "$resolved"; return; }
  done
}

env_any() {
  local v got
  for v in "$@"; do
    got="${!v:-}"
    [ -z "$got" ] && got=$(env_get "$v")
    [ -n "$got" ] && { echo "$got"; return; }
  done
}

# Parse a Postgres URL → "HOST PORT DB USER PASS"
# Handles: postgres://user:pass@host:port/db, postgresql://, r2dbc:postgresql://
parse_pg_url() {
  python3 - "$1" 2>/dev/null <<'PY'
import sys, re
url = sys.argv[1]
url = re.sub(r'^[^:]+:postgresql://', '', url)   # r2dbc:postgresql://...
url = re.sub(r'^postgres(ql)?://', '', url)
url = url.split('?')[0]
user = pwd = ''
if '@' in url:
    creds, rest = url.split('@', 1)
    if ':' in creds:
        user, pwd = creds.split(':', 1)
    else:
        user = creds
    url = rest
host = port = db = ''
if '/' in url:
    hostport, db = url.split('/', 1)
else:
    hostport = url
if ':' in hostport:
    host, port = hostport.split(':', 1)
else:
    host = hostport
print(host, port or '5432', db, user, pwd)
PY
}

parse_redis_url() {
  python3 - "$1" 2>/dev/null <<'PY'
import sys, re
url = sys.argv[1]
url = re.sub(r'^rediss?://', '', url).split('?')[0]
pwd = ''
if '@' in url:
    creds, rest = url.split('@', 1)
    pwd = creds.split(':', 1)[-1] if ':' in creds else creds
    url = rest
host = port = ''
if '/' in url:
    url = url.split('/', 1)[0]
if ':' in url:
    host, port = url.split(':', 1)
else:
    host = url
print(host, port or '6379', pwd)
PY
}

# ─── Postgres discovery ───────────────────────────────────────────────────────

PG_HOST="" PG_PORT="" PG_DB="" PG_USER="" PG_PASS=""

# 1. Spring path: parse application.yml
if [ "$STACK" = "java-spring" ]; then
  APP_YML=""
  for f in src/main/resources/application.yml src/main/resources/application.yaml; do
    [ -f "$f" ] && APP_YML="$f" && break
  done
  if [ -n "$APP_YML" ]; then
    PG_URL=$(resolve_yml_any "$APP_YML" \
      "spring.r2dbc.url" "spring.datasource.url" "spring.flyway.url" \
      "datasource.url" "r2dbc.url")
    PG_USER=$(resolve_yml_any "$APP_YML" \
      "spring.r2dbc.username" "spring.datasource.username" \
      "spring.flyway.user" "spring.flyway.username" "datasource.username")
    PG_PASS=$(resolve_yml_any "$APP_YML" \
      "spring.r2dbc.password" "spring.datasource.password" \
      "spring.flyway.password" "datasource.password")
    if [ -n "$PG_URL" ]; then
      read -r PG_HOST PG_PORT PG_DB PG_USER_URL PG_PASS_URL <<< "$(parse_pg_url "$PG_URL")"
      # URL creds take priority over yml fields only if yml empty
      [ -z "$PG_USER" ] && PG_USER="$PG_USER_URL"
      [ -z "$PG_PASS" ] && PG_PASS="$PG_PASS_URL"
    fi
  fi
fi

# 2. Generic path: DATABASE_URL / common env names
if [ -z "$PG_HOST" ] || [ -z "$PG_DB" ]; then
  GEN_URL=$(env_any DATABASE_URL POSTGRES_URL DB_URL)
  if [ -n "$GEN_URL" ]; then
    read -r G_HOST G_PORT G_DB G_USER G_PASS <<< "$(parse_pg_url "$GEN_URL")"
    [ -z "$PG_HOST" ] && PG_HOST="$G_HOST"
    [ -z "$PG_PORT" ] && PG_PORT="$G_PORT"
    [ -z "$PG_DB" ]   && PG_DB="$G_DB"
    [ -z "$PG_USER" ] && PG_USER="$G_USER"
    [ -z "$PG_PASS" ] && PG_PASS="$G_PASS"
  fi
fi

# 3. Per-field env names (any stack)
[ -z "$PG_HOST" ] && PG_HOST=$(env_any DB_HOST POSTGRES_HOST PGHOST)
[ -z "$PG_PORT" ] && PG_PORT=$(env_any DB_PORT POSTGRES_PORT PGPORT)
[ -z "$PG_DB" ]   && PG_DB=$(env_any DB_NAME DB_DATABASE POSTGRES_DB PGDATABASE)
[ -z "$PG_USER" ] && PG_USER=$(env_any DB_USER DB_USERNAME POSTGRES_USER PGUSER)
[ -z "$PG_PASS" ] && PG_PASS=$(env_any DB_PASSWORD DB_PASS POSTGRES_PASSWORD PGPASSWORD)

# 4. Final defaults
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_PASS="${PG_PASS:-postgres}"
PG_DB="${PG_DB:-postgres}"

# ─── Redis discovery ──────────────────────────────────────────────────────────

REDIS_HOST="" REDIS_PORT="" REDIS_PASS=""

if [ "$STACK" = "java-spring" ] && [ -n "${APP_YML:-}" ]; then
  REDIS_HOST=$(resolve_yml_any "$APP_YML" \
    "spring.data.redis.host" "spring.redis.host" "redis.host")
  REDIS_PORT=$(resolve_yml_any "$APP_YML" \
    "spring.data.redis.port" "spring.redis.port" "redis.port")
  REDIS_PASS=$(resolve_yml_any "$APP_YML" \
    "spring.data.redis.password" "spring.redis.password" "redis.password")
fi

if [ -z "$REDIS_HOST" ]; then
  REDIS_URL=$(env_any REDIS_URL CACHE_URL)
  if [ -n "$REDIS_URL" ]; then
    read -r R_HOST R_PORT R_PASS <<< "$(parse_redis_url "$REDIS_URL")"
    REDIS_HOST="$R_HOST"; REDIS_PORT="$R_PORT"; REDIS_PASS="$R_PASS"
  fi
fi

[ -z "$REDIS_HOST" ] && REDIS_HOST=$(env_any REDIS_HOST)
[ -z "$REDIS_PORT" ] && REDIS_PORT=$(env_any REDIS_PORT)
[ -z "$REDIS_PASS" ] && REDIS_PASS=$(env_any REDIS_PASSWORD REDIS_PASS)

REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

# ─── Hints to agent when discovery looks weak ─────────────────────────────────

emit_hints() {
  {
    echo "[db-creds.sh] Stack=$STACK"
    if [ "$STACK" = "unknown" ]; then
      echo "  Discovery is best-effort. If creds wrong, agent please:"
      echo "  - grep -rE 'DATABASE_URL|POSTGRES_URL|DB_HOST|REDIS_URL' .env* config/ src/"
      echo "  - inspect ORM config (prisma/schema.prisma, alembic.ini, ormconfig, knexfile.js)"
      echo "  - inspect docker-compose.yml for env section of the service"
    fi
  } >&2
}

# ─── Output ───────────────────────────────────────────────────────────────────

mask() { echo "$1" | sed 's/./*/g'; }

if [ "$MODE" = "print" ]; then
  {
    echo "=== Stack: $STACK ==="
    echo
    echo "=== Postgres ==="
    echo "  PG_HOST=$PG_HOST"
    echo "  PG_PORT=$PG_PORT"
    echo "  PG_DB=$PG_DB"
    echo "  PG_USER=$PG_USER"
    [ -n "$PG_PASS" ] && echo "  PG_PASS=$(mask "$PG_PASS")"
    echo "  → PGPASSWORD=*** psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DB"
    echo
    echo "=== Redis ==="
    echo "  REDIS_HOST=$REDIS_HOST"
    echo "  REDIS_PORT=$REDIS_PORT"
    [ -n "$REDIS_PASS" ] && echo "  REDIS_PASS=$(mask "$REDIS_PASS")"
    echo "  → redis-cli -h $REDIS_HOST -p $REDIS_PORT${REDIS_PASS:+ -a '***'}"
  } >&2
  emit_hints
  exit 0
fi

emit_hints
cat <<EOF
export STACK='$STACK'
export PG_HOST='$PG_HOST'
export PG_PORT='$PG_PORT'
export PG_DB='$PG_DB'
export PG_USER='$PG_USER'
export PG_PASS='$PG_PASS'
export REDIS_HOST='$REDIS_HOST'
export REDIS_PORT='$REDIS_PORT'
export REDIS_PASS='$REDIS_PASS'
EOF
