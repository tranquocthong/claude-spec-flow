#!/usr/bin/env bash
# port-detect.sh — resolve the listening port for the project under test.
# Prints a single integer to stdout; hints to stderr.
#
# Resolution order:
#   1. application.yml → server.port (resolves ${SERVER_PORT:8080} via .env / OS env)
#   2. .env → SERVER_PORT / PORT / APP_PORT
#   3. package.json scripts → look for --port N or -p N
#   4. docker-compose.yml → host-side of a "ports: 8080:8080" mapping
#   5. probe common candidate ports against /actuator/health or /health
#   6. fail-soft: print 8080
#
# Usage: scripts/port-detect.sh [project-root]

set -u
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || { echo "Project root not found: $ROOT" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
STACK=$("$HERE/detect-stack.sh" "$ROOT" 2>/dev/null)

env_get() {
  local key="$1"
  [ -f .env ] || return
  grep -E "^${key}=" .env 2>/dev/null | tail -1 \
    | sed -E "s/^${key}=//; s/^['\"]//; s/['\"]$//"
}

resolve_placeholder() {
  local val="$1"
  [ -z "$val" ] && return
  if [[ "$val" =~ ^\$\{([^:}]+):?(.*)\}$ ]]; then
    local var="${BASH_REMATCH[1]}" def="${BASH_REMATCH[2]}"
    local got="${!var:-}"
    [ -z "$got" ] && got=$(env_get "$var")
    [ -z "$got" ] && got="$def"
    echo "$got"
  else
    echo "$val"
  fi
}

is_num() { [[ "$1" =~ ^[0-9]+$ ]]; }

# 1. OS env / .env (Spring Boot's actual override — beats yml literal AND placeholder default)
#    Spring resolves SERVER_PORT, PORT, etc. ahead of application.yml at runtime, so we mirror that.
PORT=""
for var in SERVER_PORT PORT APP_PORT HTTP_PORT; do
  cand="${!var:-}"
  [ -z "$cand" ] && cand=$(env_get "$var")
  if is_num "$cand"; then
    PORT="$cand"
    SRC="env:$var"
    break
  fi
done

# 2. application.yml server.port (lower priority than env override)
if [ -z "$PORT" ] && [ "$STACK" = "java-spring" ]; then
  for yml in src/main/resources/application.yml src/main/resources/application.yaml; do
    [ -f "$yml" ] || continue
    raw=$(python3 - "$yml" 2>/dev/null <<'PY'
import sys, re
with open(sys.argv[1]) as f:
    lines = f.readlines()
stack = []
for raw in lines:
    if not raw.strip() or raw.lstrip().startswith('#'): continue
    m = re.match(r'^(\s*)([A-Za-z0-9_\-]+)\s*:\s*(.*?)\s*$', raw.rstrip('\n'))
    if not m: continue
    indent, key, val = len(m.group(1)), m.group(2), m.group(3)
    while stack and stack[-1][0] >= indent: stack.pop()
    stack.append((indent, key))
    if [k for _, k in stack] == ['server', 'port'] and val:
        print(val.strip('"').strip("'")); sys.exit(0)
PY
)
    PORT=$(resolve_placeholder "$raw")
    is_num "$PORT" && { SRC="application.yml"; break; } || PORT=""
  done
fi

# 2b. .env again (covers non-Spring stacks where step 1 already would have hit, but kept for safety)
if [ -z "$PORT" ]; then
  for var in SERVER_PORT PORT APP_PORT HTTP_PORT; do
    cand=$(env_get "$var")
    if is_num "$cand"; then PORT="$cand"; break; fi
  done
fi

# 3. package.json scripts (Node)
if [ -z "$PORT" ] && [ -f package.json ]; then
  cand=$(grep -oE '"(start|dev|serve)"[^"]*"[^"]*--port[^0-9]+[0-9]+' package.json \
         | grep -oE '[0-9]+$' | head -1)
  is_num "$cand" && PORT="$cand"
  if [ -z "$PORT" ]; then
    cand=$(grep -oE '"(start|dev|serve)"[^"]*"[^"]*-p[^0-9]+[0-9]+' package.json \
           | grep -oE '[0-9]+$' | head -1)
    is_num "$cand" && PORT="$cand"
  fi
fi

# 4. docker-compose.yml (best-effort)
if [ -z "$PORT" ]; then
  for f in docker-compose.yml docker-compose.yaml compose.yaml compose.yml; do
    [ -f "$f" ] || continue
    cand=$(grep -E "^\s*-\s+['\"]?[0-9]+:[0-9]+['\"]?\s*$" "$f" 2>/dev/null \
           | head -1 | grep -oE "[0-9]+:" | head -1 | tr -d ':')
    if is_num "$cand"; then PORT="$cand"; break; fi
  done
fi

# 5. Probe common ports (last resort)
if [ -z "$PORT" ]; then
  for p in 8080 8081 8083 8086 8989 3000 3001 4000 5000 8000 8001; do
    CODE=$(curl -sS -o /dev/null -m 1 -w "%{http_code}" \
      "http://localhost:$p/actuator/health" 2>/dev/null)
    [ "$CODE" = "000" ] || [ -z "$CODE" ] && CODE=$(curl -sS -o /dev/null -m 1 -w "%{http_code}" \
      "http://localhost:$p/health" 2>/dev/null)
    if [ "$CODE" != "000" ] && [ -n "$CODE" ]; then
      PORT="$p"
      echo "(probed) running app found on $p" >&2
      break
    fi
  done
fi

# 6. Fail-soft
if [ -z "$PORT" ]; then
  echo "Could not detect port; defaulting to 8080. Override via SERVER_PORT env var." >&2
  PORT=8080
fi

echo "$PORT"
