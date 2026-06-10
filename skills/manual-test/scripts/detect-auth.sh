#!/usr/bin/env bash
# detect-auth.sh — classify a project's auth model. Polymorphic by stack.
# Prints one of:  summer | jwt-basic | session | no-auth | unknown
# Plus diagnostic hints to stderr.
#
# Usage: scripts/detect-auth.sh [project-root]

set -u
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || { echo "Project root not found: $ROOT" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
STACK=$("$HERE/detect-stack.sh" "$ROOT" 2>/dev/null)

emit_unknown() {
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

    echo "no-auth"
    echo "Detected: No Spring Security / JWT deps." >&2
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
