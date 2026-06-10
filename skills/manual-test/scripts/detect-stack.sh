#!/usr/bin/env bash
# detect-stack.sh — classify project stack for manual-test routing.
# Prints one of:
#   java-spring | node | python | go | dotnet | unknown
# Hints + diagnostics go to stderr.
#
# Usage: scripts/detect-stack.sh [project-root]
#
# Detection is shallow + cheap (build/manifest files only). When ambiguous,
# returns "unknown" and prints suggestions for agent grep — see references/stacks.md.

set -u
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || { echo "Project root not found: $ROOT" >&2; exit 1; }

# --- Java/Spring ---
if [ -f build.gradle ] || [ -f build.gradle.kts ] || [ -f pom.xml ]; then
  # Spring? (vs plain Java)
  if grep -qE "org\.springframework\.boot|spring-boot-starter" \
      build.gradle build.gradle.kts pom.xml 2>/dev/null; then
    echo "java-spring"
    echo "Stack: Java + Spring Boot (build file found)" >&2
    exit 0
  fi
  # Plain Java — treat as java-spring for endpoint discovery? Better unknown.
  echo "unknown"
  echo "Stack: Java but no Spring Boot detected." >&2
  echo "Agent: grep for framework hints (Quarkus, Micronaut, Vert.x, Helidon)." >&2
  exit 0
fi

# --- Node.js ---
if [ -f package.json ]; then
  echo "node"
  framework="unknown framework"
  for fw in "@nestjs/core" "express" "fastify" "koa" "hapi" "@hapi/hapi" "next" "nuxt"; do
    if grep -q "\"$fw\"" package.json 2>/dev/null; then framework="$fw"; break; fi
  done
  echo "Stack: Node.js ($framework)" >&2
  echo "Agent hints: route discovery → grep -rE 'app\\.(get|post|put|delete|patch)\\(|router\\.(get|post|put|delete|patch)\\(|@(Get|Post|Put|Delete|Patch)Mapping|@(Controller|Get|Post|Put|Delete)\\b' src/ app/" >&2
  exit 0
fi

# --- Python ---
PY_DEP=""
for f in pyproject.toml requirements.txt requirements/*.txt setup.py Pipfile; do
  [ -f "$f" ] && PY_DEP="$f" && break
done
if [ -n "$PY_DEP" ] || [ -f manage.py ]; then
  echo "python"
  framework="unknown framework"
  if [ -f manage.py ]; then
    framework="Django"
  elif [ -n "$PY_DEP" ]; then
    for fw in fastapi flask django starlette sanic aiohttp tornado; do
      if grep -qi "^\\s*${fw}\\b" "$PY_DEP" 2>/dev/null \
         || grep -qiE "\"${fw}\"|'${fw}'" "$PY_DEP" 2>/dev/null; then
        framework="$fw"; break
      fi
    done
  fi
  echo "Stack: Python ($framework)" >&2
  echo "Agent hints: route discovery →" >&2
  echo "  FastAPI/Starlette: grep -rnE '@(app|router)\\.(get|post|put|delete|patch)'" >&2
  echo "  Flask:             grep -rnE '@(app|bp)\\.route|add_url_rule'" >&2
  echo "  Django:            grep -rn 'urlpatterns' --include='urls.py'" >&2
  exit 0
fi

# --- Go ---
if [ -f go.mod ]; then
  echo "go"
  framework="unknown framework"
  for fw in "gin-gonic/gin" "labstack/echo" "gofiber/fiber" "go-chi/chi" "gorilla/mux" "net/http"; do
    if grep -q "$fw" go.mod 2>/dev/null; then framework="$fw"; break; fi
  done
  echo "Stack: Go ($framework)" >&2
  echo "Agent hints: route discovery → grep -rE '\\.(GET|POST|PUT|DELETE|PATCH|HEAD)\\s*\\(\"|HandleFunc\\(\"' --include='*.go'" >&2
  exit 0
fi

# --- .NET ---
if compgen -G "*.csproj" >/dev/null 2>&1 || [ -f global.json ] || compgen -G "*.sln" >/dev/null 2>&1; then
  echo "dotnet"
  echo "Stack: .NET (csproj/sln found)" >&2
  echo "Agent hints: route discovery →" >&2
  echo "  Web API: grep -rnE '\\[Http(Get|Post|Put|Delete|Patch)|\\[Route' --include='*.cs'" >&2
  echo "  Minimal: grep -rnE 'app\\.Map(Get|Post|Put|Delete)' --include='*.cs'" >&2
  exit 0
fi

# --- Ruby ---
if [ -f Gemfile ] || [ -f config.ru ]; then
  echo "unknown"
  echo "Stack: Ruby project (Gemfile found) — not yet covered by per-stack scripts." >&2
  echo "Agent hints: Rails routes → cat config/routes.rb" >&2
  echo "             Sinatra    → grep -rnE 'get|post|put|delete \"/'" >&2
  exit 0
fi

# --- Unknown ---
echo "unknown"
{
  echo "Stack: no manifest detected (no build.gradle/pom.xml, package.json, pyproject/requirements, go.mod, *.csproj)."
  echo "Agent fallback:"
  echo "  - Look for Dockerfile / docker-compose.yml to identify runtime"
  echo "  - Check README for stack mention"
  echo "  - grep -rE 'FROM (openjdk|node|python|golang|mcr.microsoft.com/dotnet)' Dockerfile* 2>/dev/null"
  echo "  - See references/stacks.md for manual discovery recipes"
} >&2
