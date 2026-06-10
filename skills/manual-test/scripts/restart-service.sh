#!/usr/bin/env bash
# restart-service.sh — polymorphic kill + restart for the project under test.
# Stack-aware via detect-stack.sh.
#
# Usage:
#   scripts/restart-service.sh                    # interactive: confirms before kill
#   scripts/restart-service.sh --auto             # no prompt, kill + restart
#   scripts/restart-service.sh --kill-only        # stop, don't restart
#   scripts/restart-service.sh --port 8081        # override port
#   scripts/restart-service.sh --cmd 'custom start command'   # override start cmd
#
# Behavior:
#   1. Locate PID listening on resolved port (lsof -ti :PORT)
#   2. SIGTERM, wait up to 15s for graceful shutdown, then SIGKILL
#   3. Start in background per stack (logs → ~/.cache/manual-test/<hash>/service.log)
#   4. Wait for health endpoint up to 90s (configurable via START_TIMEOUT)
#   5. Exit 0 on success, 1 on timeout, 2 on no-restart-recipe
#
# Hard rule: prints which command it will run BEFORE running, so user sees intent.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/state.sh"
state_load

AUTO=false
KILL_ONLY=false
PORT_OVR=""
CMD_OVR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --auto)       AUTO=true; shift ;;
    --kill-only)  KILL_ONLY=true; shift ;;
    --port)       PORT_OVR="$2"; shift 2 ;;
    --cmd)        CMD_OVR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" >&2; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

PORT="${PORT_OVR:-$(state_get port)}"
[ -z "$PORT" ] && PORT=$("$HERE/port-detect.sh" 2>/dev/null)
STACK=$(state_get stack)
[ -z "$STACK" ] && STACK=$("$HERE/detect-stack.sh" 2>/dev/null)
START_TIMEOUT="${START_TIMEOUT:-90}"

LOG="$STATE_DIR/service.log"

# ─── Pick start command per stack ─────────────────────────────────────────

start_cmd_for_stack() {
  if [ -n "$CMD_OVR" ]; then echo "$CMD_OVR"; return; fi
  case "$STACK" in
    java-spring)
      if [ -f gradlew ]; then echo "./gradlew bootRun"
      elif [ -f mvnw ]; then echo "./mvnw spring-boot:run"
      elif command -v gradle >/dev/null; then echo "gradle bootRun"
      elif command -v mvn >/dev/null; then echo "mvn spring-boot:run"
      else echo ""; fi
      ;;
    node)
      if [ -f package.json ]; then
        if grep -q '"dev"' package.json; then echo "npm run dev"
        elif grep -q '"start"' package.json; then echo "npm run start"
        else echo "node ."; fi
      else echo ""; fi
      ;;
    python)
      if [ -f manage.py ]; then echo "python manage.py runserver 0.0.0.0:$PORT"
      elif grep -qE "fastapi|uvicorn" pyproject.toml requirements.txt 2>/dev/null; then
        local mod
        mod=$(grep -rnE "^app\s*=\s*FastAPI|^app\s*=\s*Starlette" --include="*.py" . 2>/dev/null | head -1 | cut -d: -f1 | sed 's|^\./||; s|/|.|g; s|\.py$||')
        [ -z "$mod" ] && mod="app.main"
        echo "uvicorn $mod:app --host 0.0.0.0 --port $PORT --reload"
      elif grep -q "flask" requirements.txt pyproject.toml 2>/dev/null; then
        echo "flask run --host 0.0.0.0 --port $PORT"
      else echo ""; fi
      ;;
    go)
      if [ -f go.mod ]; then echo "go run ."
      else echo ""; fi
      ;;
    dotnet)
      if compgen -G "*.csproj" >/dev/null 2>&1 || compgen -G "*.sln" >/dev/null 2>&1; then
        echo "dotnet run --urls=http://localhost:$PORT"
      else echo ""; fi
      ;;
    *) echo "" ;;
  esac
}

START_CMD=$(start_cmd_for_stack)

# ─── Identify PID ──────────────────────────────────────────────────────────

PIDS=""
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti ":$PORT" 2>/dev/null | tr '\n' ' ')
elif command -v ss >/dev/null 2>&1; then
  PIDS=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | sed 's/pid=//' | tr '\n' ' ')
fi

echo "── restart-service.sh ────────────────────────"
echo "  stack       : $STACK"
echo "  port        : $PORT"
echo "  current PID : ${PIDS:-<none — service not running>}"
echo "  start cmd   : ${START_CMD:-<no recipe for stack $STACK>}"
echo "  log         : $LOG"
[ "$AUTO" = "true" ] && echo "  mode        : AUTO (no confirmation)"
echo "──────────────────────────────────────────────"

# Confirm unless --auto
if [ "$AUTO" != "true" ]; then
  printf "Proceed with kill%s? [y/N] " "$([ "$KILL_ONLY" = "true" ] || echo " + restart")"
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# ─── Kill ──────────────────────────────────────────────────────────────────

if [ -n "$PIDS" ]; then
  echo "Sending SIGTERM to: $PIDS"
  kill -TERM $PIDS 2>/dev/null || true
  # Wait up to 15s
  for i in $(seq 1 15); do
    STILL=""
    for p in $PIDS; do
      kill -0 "$p" 2>/dev/null && STILL="$STILL $p"
    done
    [ -z "$STILL" ] && break
    sleep 1
  done
  # Force-kill stragglers
  if [ -n "${STILL:-}" ]; then
    echo "SIGKILL stragglers:$STILL"
    kill -KILL $STILL 2>/dev/null || true
    sleep 1
  fi
  echo "Killed."
else
  echo "Nothing listening on port $PORT — proceeding."
fi

if [ "$KILL_ONLY" = "true" ]; then
  exit 0
fi

# ─── Start ────────────────────────────────────────────────────────────────

if [ -z "$START_CMD" ]; then
  echo "[restart-service] No start recipe for stack '$STACK'." >&2
  echo "Override with --cmd '<your start command>' or extend this script." >&2
  echo "Agent hints:" >&2
  echo "  - Inspect package.json 'scripts' / Makefile / docker-compose 'command'" >&2
  echo "  - README usually documents the dev-server command" >&2
  exit 2
fi

echo "Starting: $START_CMD"
echo "Log: $LOG"
nohup bash -c "$START_CMD" >"$LOG" 2>&1 &
NEW_PID=$!
disown 2>/dev/null || true
echo "Started PID=$NEW_PID — tailing health probe..."

# ─── Wait for health ──────────────────────────────────────────────────────

START_T=$(date +%s)
DEADLINE=$((START_T + START_TIMEOUT))
while true; do
  NOW=$(date +%s)
  if [ "$NOW" -gt "$DEADLINE" ]; then
    echo "Service did not become healthy within ${START_TIMEOUT}s." >&2
    echo "Tail of log:" >&2
    tail -30 "$LOG" >&2
    exit 1
  fi

  for path in /actuator/health /health /; do
    CODE=$(curl -sS -o /dev/null -m 2 -w "%{http_code}" "http://localhost:$PORT$path" 2>/dev/null)
    if [ -n "$CODE" ] && [ "$CODE" != "000" ] && [ "${CODE:0:1}" != "5" ]; then
      ELAPSED=$((NOW - START_T))
      echo "Service up on port $PORT (HTTP=$CODE on $path) after ${ELAPSED}s."
      exit 0
    fi
  done
  sleep 2
done
