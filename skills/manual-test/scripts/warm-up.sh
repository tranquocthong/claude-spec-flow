#!/usr/bin/env bash
# warm-up.sh — discover stack, DBs, endpoints in one shot. Polymorphic by stack.
# Usage: scripts/warm-up.sh [project-root]

set -u
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || { echo "Project root not found: $ROOT" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
STACK=$("$HERE/detect-stack.sh" "$ROOT" 2>/dev/null)

echo "=== Stack: $STACK ==="
echo

echo "=== 1. Health probes (common ports) ==="
PROBE_PORTS="8080 8081 8083 8086 8989 3000 3001 4000 5000 8000 8001"
for port in $PROBE_PORTS; do
  CODE=$(curl -sS -o /dev/null -m 1 -w "%{http_code}" \
    "http://localhost:$port/actuator/health" 2>/dev/null)
  if [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
    CODE=$(curl -sS -o /dev/null -m 1 -w "%{http_code}" \
      "http://localhost:$port/health" 2>/dev/null)
  fi
  if [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
    CODE=$(curl -sS -o /dev/null -m 1 -w "%{http_code}" \
      "http://localhost:$port/" 2>/dev/null)
  fi
  [ "$CODE" = "000" ] && CODE="down"
  printf "  %-5s %s\n" "$port" "$CODE"
done

echo
echo "=== 2. Postgres DBs (superuser scan, needs PGPASSWORD or postgres trust) ==="
PGPASSWORD="${PGPASSWORD:-postgres}" psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" \
  -lqt 2>/dev/null \
  | cut -d\| -f1 | grep -v "^$" | sed 's/ *$//' | sed 's/^/  /' \
  || echo "  (psql unavailable or no superuser access — db-creds.sh will still find this project's DB)"

echo
echo "=== 3. Resolved creds for this project ==="
"$HERE/db-creds.sh" --print "$ROOT" 2>&1 | sed 's/^/  /'

echo
echo "=== 4. Endpoint discovery ==="
case "$STACK" in
  java-spring)
    if [ -d src/main/java ]; then
      while IFS= read -r -d '' f; do
        cp=$(grep -E "^@RequestMapping" "$f" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
        [ -z "$cp" ] && cp="(no class @RequestMapping)"
        echo "  --- $f → base: $cp"
        grep -nE "@(Get|Post|Put|Delete|Patch)Mapping" "$f" | head -10 | sed 's/^/    /'
      done < <(find src/main/java -name "*Controller.java" -print0)
    else
      echo "  (src/main/java missing — non-standard layout, agent: grep '@RestController' . )"
    fi
    ;;

  node)
    echo "  Express / Fastify / Koa route definitions:"
    grep -rnE "(app|router|fastify|server)\.(get|post|put|delete|patch|head|options)\s*\(" \
      --include="*.js" --include="*.mjs" --include="*.ts" \
      src/ app/ routes/ api/ 2>/dev/null | head -30 | sed 's/^/    /' \
      || echo "    (no matches — agent: grep route patterns specific to framework)"
    echo
    echo "  NestJS decorators:"
    grep -rnE "@(Controller|Get|Post|Put|Delete|Patch)\b" \
      --include="*.ts" src/ 2>/dev/null | head -20 | sed 's/^/    /' \
      || true
    ;;

  python)
    echo "  FastAPI / Starlette routes:"
    grep -rnE "@(app|router)\.(get|post|put|delete|patch|head|options)\s*\(" \
      --include="*.py" . 2>/dev/null | grep -v "__pycache__\|.venv\|venv/" | head -30 | sed 's/^/    /' \
      || echo "    (no matches)"
    echo
    echo "  Flask routes:"
    grep -rnE "@(app|bp|blueprint)\.route\s*\(|add_url_rule\s*\(" \
      --include="*.py" . 2>/dev/null | grep -v "__pycache__\|.venv\|venv/" | head -20 | sed 's/^/    /' \
      || true
    echo
    echo "  Django urlpatterns (urls.py):"
    find . -name "urls.py" -not -path "*/.venv/*" -not -path "*/venv/*" 2>/dev/null \
      | head -5 | sed 's/^/    /'
    ;;

  go)
    echo "  Route registrations (Gin / Echo / Fiber / Chi / Mux / net.http):"
    grep -rnE "\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\"|HandleFunc\s*\(\"" \
      --include="*.go" . 2>/dev/null | head -30 | sed 's/^/    /' \
      || echo "    (no matches — agent: grep specific router type)"
    ;;

  dotnet)
    echo "  ASP.NET attribute routes:"
    grep -rnE "\[(Http(Get|Post|Put|Delete|Patch)|Route)\(" \
      --include="*.cs" . 2>/dev/null | head -30 | sed 's/^/    /' \
      || true
    echo
    echo "  Minimal API:"
    grep -rnE "app\.Map(Get|Post|Put|Delete|Patch)\s*\(" \
      --include="*.cs" . 2>/dev/null | head -20 | sed 's/^/    /' \
      || true
    ;;

  *)
    echo "  Stack=$STACK — per-stack discovery not built in."
    echo "  Agent fallback:"
    echo "    - Read references/stacks.md for manual discovery recipes per language."
    echo "    - Inspect Dockerfile, README, and docker-compose.yml for routing hints."
    ;;
esac

echo
echo "=== Done. ==="
echo "Reminder: full endpoint path = class/base-route prefix + method-route suffix (varies by framework)."
