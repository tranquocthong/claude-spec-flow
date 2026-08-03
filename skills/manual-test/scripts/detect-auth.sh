#!/usr/bin/env bash
# detect-auth.sh — classify a project's auth model. Polymorphic by stack.
# Prints one of:  summer | jwt-basic | session | no-auth | unknown
# Plus diagnostic hints to stderr.
#
# Usage: scripts/detect-auth.sh [project-root]
#
# Multi-repo aware: if the root is a spec-flow hub whose .spec-flow/config.json
# declares `repos`, the SERVICE repos are classified instead of the hub.

set -u
# Resolve HERE BEFORE cd'ing into the project: $0 is usually relative, so computing
# it afterwards resolves against the wrong directory (harmless while nothing used
# HERE across the cd, fatal once this script re-invokes itself for multi-repo).
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || { echo "Project root not found: $ROOT" >&2; exit 1; }

# ─── Multi-repo hub (.spec-flow/config.json → repos) ──────────────────────────
# A spec-flow hub repo can hold only the docs (SRS/SD) while the services it
# describes live in sibling repos declared under `config.repos`. Classifying the
# hub answers a question about the wrong tree: there is no service code there, so
# every dependency check and source grep below falls through and the detector
# reports a CONFIDENT WRONG type (a Summer/APISIX project reads as custom-Bearer,
# i.e. exactly inverted). Classify each declared repo and reconcile instead.
# SF_AUTH_CHILD guards the recursion; anything unresolvable degrades to the plain
# single-repo path below, so a non-hub project is unaffected.
TAB="$(printf '\t')"
if [ -z "${SF_AUTH_CHILD:-}" ] && [ -f .spec-flow/config.json ] && command -v node >/dev/null 2>&1; then
  REPO_LIST="$(node -e '
    try {
      const c = require(process.cwd() + "/.spec-flow/config.json");
      const r = (c && typeof c.repos === "object" && c.repos) || {};
      for (const [n, p] of Object.entries(r)) if (n && p) console.log(n + "\t" + p);
    } catch (e) { /* unreadable config → single-repo path */ }
  ' 2>/dev/null)"

  RESULTS=""   # one line per repo: name<TAB>type<TAB>stderr-file
  if [ -n "$REPO_LIST" ]; then
    while IFS="$TAB" read -r RNAME RPATH; do
      [ -n "${RNAME:-}" ] && [ -n "${RPATH:-}" ] || continue
      case "$RPATH" in /*) RDIR="$RPATH" ;; *) RDIR="$PWD/$RPATH" ;; esac
      [ -d "$RDIR" ] || {
        echo "config.repos[\"$RNAME\"] → $RPATH does not exist; skipped for auth detection." >&2
        continue
      }
      RERR="$(mktemp)"
      RTYPE="$(SF_AUTH_CHILD=1 "$HERE/detect-auth.sh" "$RDIR" 2>"$RERR")"
      RESULTS="${RESULTS}${RNAME}${TAB}${RTYPE:-unknown}${TAB}${RERR}
"
    done <<EOF
$REPO_LIST
EOF
  fi

  if [ -n "$RESULTS" ]; then
    SIGNALS=""   # space-delimited distinct classifications that carry signal
    ALL_NO_AUTH=1
    echo "Multi-repo: classified the service repos from .spec-flow/config.json, not this hub." >&2
    while IFS="$TAB" read -r RNAME RTYPE RERR; do
      [ -n "${RNAME:-}" ] || continue
      echo "  - $RNAME → $RTYPE" >&2
      [ "$RTYPE" = "no-auth" ] || ALL_NO_AUTH=0
      case "$RTYPE" in
        unknown|no-auth) ;;
        *) case " $SIGNALS " in *" $RTYPE "*) ;; *) SIGNALS="$SIGNALS $RTYPE" ;; esac ;;
      esac
    done <<EOF
$RESULTS
EOF

    # shellcheck disable=SC2086
    set -- $SIGNALS
    if [ "$#" -eq 1 ]; then
      # One repo carries the signal (or they all agree) → that is the answer, and
      # the winning repo's own hints are the ones worth forwarding.
      echo "$1"
      while IFS="$TAB" read -r RNAME RTYPE RERR; do
        [ "${RTYPE:-}" = "$1" ] || continue
        echo >&2; cat "$RERR" >&2; break
      done <<EOF
$RESULTS
EOF
    elif [ "$#" -eq 0 ]; then
      [ "$ALL_NO_AUTH" -eq 1 ] && echo "no-auth" || echo "unknown"
      echo "No repo carried an auth signal — treat the classification as a guess." >&2
    else
      # Genuinely different models across services. Picking one scaffolds a token
      # that 401s every test on the others, so say so instead of guessing.
      echo "unknown"
      {
        echo
        echo "CONFLICT: the declared repos disagree on the auth model (${SIGNALS# })."
        echo "No single scaffold is right for all of them. Pick per feature:"
        echo "  checklist-gen --auth <type>   (or hand-edit tokens.user_token)"
      } >&2
    fi

    while IFS="$TAB" read -r RNAME RTYPE RERR; do
      [ -n "${RERR:-}" ] && rm -f "$RERR"
    done <<EOF
$RESULTS
EOF
    exit 0
  fi
fi

STACK=$("$HERE/detect-stack.sh" "$ROOT" 2>/dev/null)

# Cross-stack fallback: a hand-rolled `Authorization: Bearer <token>` scheme has
# NO library fingerprint (no jsonwebtoken / jjwt / pyjwt dep), so every per-stack
# dependency check above misses it — a Node/Express service validating a static
# `Bearer <api_key>` looked exactly like "no auth" and got the Summer/APISIX
# X-Userinfo scaffold, which 401s every generated test.
# What the checklist actually needs is the WIRE contract, not the token format:
# code that reads the Authorization header AND strips a "Bearer " prefix means
# `Authorization: Bearer <token>` — same as `jwt-basic`, whether the token is a
# real JWT or an opaque API key (how to OBTAIN it stays a TODO either way).
SRC_INCLUDES=(--include='*.js' --include='*.mjs' --include='*.cjs' --include='*.ts'
              --include='*.py' --include='*.go' --include='*.java' --include='*.kt'
              --include='*.cs' --include='*.rb' --include='*.php')
SRC_EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
              --exclude-dir=build --exclude-dir=target --exclude-dir=vendor
              --exclude-dir=.venv --exclude-dir=venv)

try_custom_bearer() {
  grep -rqiE "(headers?\[['\"]authorization|headers\.authorization|\.get\(['\"]authorization|getHeader\(['\"]Authorization|HTTP_AUTHORIZATION|Header\.Get\(['\"]Authorization)" \
    "${SRC_INCLUDES[@]}" "${SRC_EXCLUDES[@]}" . 2>/dev/null || return 1
  grep -rqE "['\"]Bearer[ '\"]" "${SRC_INCLUDES[@]}" "${SRC_EXCLUDES[@]}" . 2>/dev/null || return 1

  echo "jwt-basic"
  {
    echo "Detected: custom Authorization: Bearer scheme (no JWT/session library on $STACK)."
    echo "The token may be an opaque API key or a static secret, not a signed JWT —"
    echo "the wire form is the same, only how you MINT it differs."
    echo "→ Use references/auth-jwt-basic.md; checklist token form: bearer: \"\${TOKEN}\""
    echo
    echo "Agent: find where the header is validated →"
    echo "  grep -rniE \"authorization|bearer\" --include='*.js' --include='*.ts' --include='*.py' --include='*.go' . | head -10"
  } >&2
  return 0
}

emit_unknown() {
  try_custom_bearer && return 0
  echo "unknown"
  {
    echo "Stack=$STACK — auth model not classified."
    echo "Agent fallback (grep for any of these):"
    echo "  - JWT validation middleware (anywhere named 'auth', 'jwt', 'token')"
    echo "  - OAuth2 / OIDC client setup"
    echo "  - Session middleware (express-session, flask-session, etc.)"
    echo "  - Custom header / API-key filters"
  } >&2
}

case "$STACK" in
  java-spring)
    BUILD_FILES=()
    for f in build.gradle build.gradle.kts pom.xml; do
      [ -f "$f" ] && BUILD_FILES+=("$f")
    done

    APP_YML=""
    for f in src/main/resources/application.yml src/main/resources/application.yaml src/main/resources/application.properties; do
      [ -f "$f" ] && APP_YML="$f" && break
    done

    # Summer
    if grep -qE "io\.f8a\.summer:summer-platform|io\.f8a\.summer:summer-rest" "${BUILD_FILES[@]}" 2>/dev/null; then
      echo "summer"
      {
        echo "Detected: Summer Framework (io.f8a.summer:summer-platform)"
        echo "→ Use references/auth.md"
        echo
        echo "Quick-probe Path A vs Path B:"
        echo "  QUICK_TOKEN=\$(echo -n '{\"iat\":1772680061,\"exp\":2088040061,\"sub\":\"probe\"}' | base64 | tr -d '\\n')"
        echo "  curl -sS -o /dev/null -w 'HTTP=%{http_code}\\n' http://localhost:PORT/api/v1/... -H \"X-Userinfo: \$QUICK_TOKEN\""
        echo "  401 → Path B (scripts/kc-ropc.sh); anything else → Path A."
      } >&2
      exit 0
    fi

    # Plain Spring JWT
    if grep -qE "spring-boot-starter-oauth2-resource-server|spring-security-oauth2-jose|jjwt|java-jwt|nimbus-jose-jwt" "${BUILD_FILES[@]}" 2>/dev/null \
       || { [ -n "$APP_YML" ] && grep -qE "issuer-uri|jwk-set-uri|jwt:" "$APP_YML" 2>/dev/null; }; then
      echo "jwt-basic"
      {
        echo "Detected: Plain Spring Boot JWT"
        echo "→ Use references/auth-jwt-basic.md"
      } >&2
      exit 0
    fi

    # Session/basic
    if grep -qE "spring-boot-starter-security" "${BUILD_FILES[@]}" 2>/dev/null; then
      echo "session"
      echo "Detected: Spring Security present but no JWT lib → likely session/basic." >&2
      exit 0
    fi

    # No security dep ≠ no auth: a plain servlet Filter / HandlerInterceptor can
    # read Authorization: Bearer itself. Check the source before declaring no-auth.
    try_custom_bearer && exit 0
    echo "no-auth"
    echo "Detected: No Spring Security / JWT deps, and no custom Authorization: Bearer handling in source." >&2
    exit 0
    ;;

  node)
    DEPS=""
    [ -f package.json ] && DEPS=$(cat package.json)
    if echo "$DEPS" | grep -qE '"(passport-jwt|express-jwt|jsonwebtoken|jose|@nestjs/jwt|@nestjs/passport|fastify-jwt|@fastify/jwt)"'; then
      echo "jwt-basic"
      {
        echo "Detected: Node JWT library"
        echo "→ Use references/auth-jwt-basic.md"
        echo
        echo "Hints from package.json:"
        echo "$DEPS" | grep -E '"(passport|jwt|jose|@nestjs/(jwt|passport)|next-auth)"' | head -5
        echo
        echo "Agent: find login endpoint → grep -rnE '(login|signin|token).*POST|app\\.post\\(\"?/auth' src/ app/"
      } >&2
      exit 0
    fi
    if echo "$DEPS" | grep -qE '"(express-session|@fastify/session|cookie-session|next-auth|iron-session)"'; then
      echo "session"
      echo "Detected: Node session middleware → cookie-based auth. References/auth-jwt-basic.md still useful if dual-mode." >&2
      exit 0
    fi
    emit_unknown
    ;;

  python)
    DEPS=""
    for f in pyproject.toml requirements.txt Pipfile requirements/*.txt; do
      [ -f "$f" ] && DEPS="$DEPS $(cat "$f" 2>/dev/null)"
    done
    if echo "$DEPS" | grep -qiE "(python-jose|pyjwt|authlib|fastapi-jwt|fastapi.security|django-rest-framework-simplejwt|drf-yasg|djangorestframework-simplejwt)"; then
      echo "jwt-basic"
      {
        echo "Detected: Python JWT library"
        echo "→ Use references/auth-jwt-basic.md"
        echo
        echo "Agent: find login endpoint →"
        echo "  FastAPI:  grep -rnE '@.*\\.post\\(.*(login|token)' --include='*.py'"
        echo "  Django:   grep -rn 'TokenObtainPairView\\|SimpleJWT' --include='*.py'"
        echo "  Flask:    grep -rnE '@.*\\.route\\(.*(login|token)' --include='*.py'"
      } >&2
      exit 0
    fi
    if [ -f manage.py ] || echo "$DEPS" | grep -qi "django"; then
      echo "session"
      echo "Detected: Django default = session-based auth. JWT lib not seen." >&2
      exit 0
    fi
    emit_unknown
    ;;

  go)
    if [ -f go.mod ]; then
      if grep -qE "golang-jwt/jwt|dgrijalva/jwt-go|go-jose|lestrrat-go/jwx|coreos/go-oidc" go.mod 2>/dev/null; then
        echo "jwt-basic"
        echo "Detected: Go JWT library. → references/auth-jwt-basic.md" >&2
        exit 0
      fi
      if grep -qE "gorilla/sessions|alexedwards/scs" go.mod 2>/dev/null; then
        echo "session"
        echo "Detected: Go session middleware." >&2
        exit 0
      fi
    fi
    emit_unknown
    ;;

  dotnet)
    if grep -rqE "AddJwtBearer|UseAuthentication.*Jwt|Microsoft\\.AspNetCore\\.Authentication\\.JwtBearer" \
         --include="*.cs" --include="*.csproj" . 2>/dev/null; then
      echo "jwt-basic"
      echo "Detected: ASP.NET JwtBearer. → references/auth-jwt-basic.md" >&2
      exit 0
    fi
    if grep -rqE "AddCookie|UseAuthentication.*Cookie" --include="*.cs" . 2>/dev/null; then
      echo "session"
      echo "Detected: ASP.NET cookie auth." >&2
      exit 0
    fi
    emit_unknown
    ;;

  *)
    emit_unknown
    ;;
esac
