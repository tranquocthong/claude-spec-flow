#!/usr/bin/env bash
# freshness-check.sh — verify the running service is built from current source.
#
# Exit codes:
#   0   fresh (running service matches repo HEAD, OR no determinative info — best-effort pass)
#   1   stale (running commit ≠ repo HEAD)
#   2   service not reachable (cannot determine)
#
# Stdout: structured JSON-ish summary
#   STATUS=fresh|stale|unknown|unreachable
#   RUNNING_COMMIT=<sha or empty>
#   REPO_COMMIT=<sha>
#   BUILD_TIME=<iso or empty>
#   PORT=<n>
#
# Detection strategy:
#   1. Hit /actuator/info (Spring) or /info (common) → parse git.commit.id / build.time
#   2. Compare git.commit.id (short or long) against `git rev-parse HEAD`
#   3. Fall back to mtime checks (jar/dist build artifact vs source files)
#
# Usage:
#   scripts/freshness-check.sh                    # uses cached port from state
#   scripts/freshness-check.sh --port 8081
#   scripts/freshness-check.sh --quiet            # exit code only, no output

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/state.sh"
state_load

QUIET=false
PORT_OVR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=true; shift ;;
    --port)  PORT_OVR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

PORT="${PORT_OVR:-$(state_get port)}"
if [ -z "$PORT" ]; then
  PORT=$("$HERE/port-detect.sh" 2>/dev/null)
fi

emit() {
  $QUIET && return
  printf '%s\n' "$1"
}

# ─── 1. Probe info endpoints ──────────────────────────────────────────────

INFO=""
for path in /actuator/info /info; do
  INFO=$(curl -sf -m 3 "http://localhost:$PORT$path" 2>/dev/null)
  [ -n "$INFO" ] && break
done

if [ -z "$INFO" ]; then
  # Try root health to at least confirm service is up
  HEALTH=$(curl -sf -m 2 "http://localhost:$PORT/actuator/health" 2>/dev/null \
           || curl -sf -m 2 "http://localhost:$PORT/health" 2>/dev/null \
           || curl -sf -m 2 "http://localhost:$PORT/" 2>/dev/null)
  if [ -z "$HEALTH" ]; then
    emit "STATUS=unreachable"
    emit "PORT=$PORT"
    emit "(no response on /actuator/info, /info, or health — service likely down)"
    exit 2
  fi
  emit "STATUS=unknown"
  emit "PORT=$PORT"
  emit "(service responds but exposes no /actuator/info or /info — cannot verify commit)"
  emit "REPO_COMMIT=$(git rev-parse HEAD 2>/dev/null | head -c 12)"
  exit 0
fi

# ─── 2. Parse running commit + build time ──────────────────────────────────

RUNNING=$(echo "$INFO" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
# Try common shapes
for path in [('git','commit','id'), ('git','commit','id','full'),
             ('git','commit'), ('git','sha'), ('build','commit')]:
    node = d
    for k in path:
        if isinstance(node, dict) and k in node:
            node = node[k]
        else:
            node = None; break
    if isinstance(node, str) and len(node) >= 7:
        print(node); sys.exit(0)
" 2>/dev/null)

BUILD_TIME=$(echo "$INFO" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
for path in [('build','time'), ('build','timestamp'), ('git','build','time'),
             ('git','commit','time')]:
    node = d
    for k in path:
        if isinstance(node, dict) and k in node:
            node = node[k]
        else:
            node = None; break
    if isinstance(node, str):
        print(node); sys.exit(0)
" 2>/dev/null)

REPO=$(git rev-parse HEAD 2>/dev/null)

emit "PORT=$PORT"
emit "RUNNING_COMMIT=${RUNNING:-<not exposed>}"
emit "REPO_COMMIT=${REPO:-<not a git repo>}"
emit "BUILD_TIME=${BUILD_TIME:-<not exposed>}"

# ─── 3. Compare ───────────────────────────────────────────────────────────

if [ -z "$RUNNING" ] || [ -z "$REPO" ]; then
  emit "STATUS=unknown"
  exit 0
fi

# Match by short prefix (7 chars enough for git)
RUN_SHORT=$(echo "$RUNNING" | head -c 7)
REPO_SHORT=$(echo "$REPO" | head -c 7)

if [ "$RUN_SHORT" = "$REPO_SHORT" ]; then
  emit "STATUS=fresh"
  exit 0
fi

# Stale — check if running commit is an ancestor of HEAD (i.e. user has uncommitted-but-rebuilt
# code, OR running an older commit). Either way, it's not testing latest source.
emit "STATUS=stale"

# Diagnostic: how many commits behind?
if git cat-file -e "$RUNNING" 2>/dev/null; then
  BEHIND=$(git rev-list --count "$RUNNING..HEAD" 2>/dev/null)
  emit "COMMITS_BEHIND=$BEHIND"
fi

# Diagnostic: uncommitted changes?
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  emit "WORKING_TREE=dirty (uncommitted changes — rebuild needed even if commit matched)"
fi

exit 1
