#!/usr/bin/env bash
# checklist-init.sh — generate CHECKLIST.yaml scaffold for a feature.
#
# Usage:
#   scripts/checklist-init.sh <feature-name> [--path /api/v1/prefix]
#
# What it does:
#   1. Detects stack and auth mode
#   2. Scans codebase for endpoints matching feature name or --path prefix
#   3. Generates CHECKLIST.yaml scaffold at:
#        .claude/docs/manual-tests/features/<feature>/CHECKLIST.yaml
#   4. Prints path for user review before running
#
# The generated checklist is a scaffold — review and fill in SQL seeds,
# expected responses, and teardown before running /manual-test.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/state.sh"
. "$HERE/context.sh"

FEATURE="${1:-}"
if [ -z "$FEATURE" ]; then
  echo "Usage: $0 <feature-name> [--path /api/v1/prefix]" >&2
  exit 1
fi
shift

PATH_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATH_FILTER="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

DEST_DIR=".claude/docs/manual-tests/features/$FEATURE"
DEST_FILE="$DEST_DIR/CHECKLIST.yaml"

if [ -f "$DEST_FILE" ]; then
  echo "CHECKLIST.yaml already exists: $DEST_FILE" >&2
  echo "Edit it directly or delete it first to regenerate." >&2
  exit 0
fi

# ─── Detect stack + auth ───────────────────────────────────────────────────

context_load "$CONTEXT_FILE" 2>/dev/null || true
STACK="${CTX_STACK:-}"
AUTH="${CTX_AUTH:-}"

[ -z "$STACK" ] && STACK=$("$HERE/detect-stack.sh" 2>/dev/null || echo "unknown")
[ -z "$AUTH"  ] && AUTH=$("$HERE/detect-auth.sh"   2>/dev/null || echo "unknown")

PORT="${CTX_PORT:-8080}"
[ -z "$PORT" ] && PORT=$("$HERE/port-detect.sh" 2>/dev/null || echo "8080")

# ─── Discover endpoints ────────────────────────────────────────────────────

ENDPOINTS_TSV=""

if [ "$STACK" = "java-spring" ] && [ -d "src/main" ]; then
  # Heredoc-in-$(…) is not portable to bash 3.2 (macOS default).
  # Write the parser to a temp file, then invoke it.
  _PY=$(mktemp -t scanendpoints.XXXXXX) || _PY=""
  if [ -n "$_PY" ]; then
    cat > "$_PY" <<'PY'
import os, re, sys

feature = sys.argv[1].lower().replace('-', '').replace('_', '')
path_filter = sys.argv[2] if len(sys.argv) > 2 else ""
results = []

for dirpath, _, files in os.walk("src/main"):
    for fn in files:
        if not fn.endswith('.java'):
            continue
        filepath = os.path.join(dirpath, fn)
        try:
            content = open(filepath, errors='replace').read()
        except Exception:
            continue

        # Relevance check — match feature or path_filter
        fn_lower = fn.lower().replace('-', '').replace('_', '')
        content_lower = content.lower()
        if feature not in fn_lower and feature not in content_lower:
            if not path_filter or path_filter not in content:
                continue

        # Class-level @RequestMapping path
        cm = re.search(r'@RequestMapping\s*\(\s*(?:value\s*=\s*)?["\{]([^"\'}\)]+)["\}]', content)
        class_path = cm.group(1).strip() if cm else ""
        # Remove Spring EL like ${...}
        class_path = re.sub(r'\$\{[^}]+\}', '', class_path).strip('/')

        # Method-level mappings
        method_map = {'Get': 'GET', 'Post': 'POST', 'Put': 'PUT',
                      'Delete': 'DELETE', 'Patch': 'PATCH'}
        for prefix, http_method in method_map.items():
            for m in re.finditer(
                rf'@{prefix}Mapping\s*\(\s*(?:value\s*=\s*)?["\']([^"\']+)["\']',
                content
            ):
                mpath = m.group(1).lstrip('/')
                full = ('/' + class_path + '/' + mpath).replace('//', '/').rstrip('/')
                if not path_filter or full.startswith(path_filter):
                    results.append(f"{http_method}\t{full}\t{fn}")

        # @Handler (Summer framework)
        for m in re.finditer(
            r'@Handler\s*\(\s*(?:value\s*=\s*)?["\']([^"\']+)["\']', content
        ):
            full = ('/' + class_path + '/' + m.group(1).lstrip('/')).replace('//', '/').rstrip('/')
            if not path_filter or full.startswith(path_filter):
                results.append(f"POST\t{full}\t{fn} (@Handler)")

# Deduplicate
seen = set()
for r in results:
    if r not in seen:
        seen.add(r)
        print(r)
PY
    ENDPOINTS_TSV=$(python3 "$_PY" "$FEATURE" "$PATH_FILTER")
    rm -f "$_PY"
  fi
fi

# ─── Build token section based on auth type ────────────────────────────────

RESOURCE_NAME=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
FEATURE_SLUG=$(echo "$FEATURE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
FEATURE_SLUG_UPPER=$(echo "$FEATURE_SLUG" | tr '[:lower:]' '[:upper:]')   # portable replacement for ${VAR^^} (bash 4+)

case "$AUTH" in
  summer)
    TOKENS_YAML="tokens:
  user_token:
    payload: '{\"iat\":1772680061,\"exp\":2088040061,\"sub\":\"\${USER_ID}\"}'
    note: End-user X-Userinfo token. USER_ID auto-discovered from main entity table.

  bo_admin_mode_b:
    payload: '{\"iat\":1772680061,\"exp\":2088040061,\"sub\":\"bo-admin\",\"email\":\"bo-admin@example.com\",\"role_groups\":[\"test-admin\"]}'
    note: Mode B BO token — requires Redis group-role seed in setup."
    ;;
  jwt-basic)
    TOKENS_YAML="tokens:
  user_token:
    payload: '{\"sub\":\"\${USER_ID}\",\"roles\":[\"USER\"]}'
    note: Plain JWT — mint via app login endpoint or static signing. See references/auth-jwt-basic.md."
    ;;
  *)
    TOKENS_YAML="tokens:
  user_token:
    payload: '{\"sub\":\"\${USER_ID}\"}'
    note: Adjust payload to match your auth scheme."
    ;;
esac

# ─── Build suites from discovered endpoints ────────────────────────────────

generate_tests() {
  if [ -z "$ENDPOINTS_TSV" ]; then
    # No endpoints discovered — emit one placeholder test
    cat <<YAML
  - id: ${FEATURE_SLUG}-suite
    name: ${FEATURE} — happy path
    tags: [smoke, regression]
    setup: []
    tests:
      - id: ${FEATURE_SLUG_UPPER}-001
        name: TODO — describe this test
        tags: [smoke]
        setup: []
        request:
          method: GET
          path: /api/v1/${FEATURE_SLUG}/TODO
          token: user_token
        expect:
          status: 200
          note: TODO — describe expected response.
        verify:
          - sql: "SELECT 1 -- TODO: add verification query"
            expect: "TODO"
        teardown: []
YAML
    return
  fi

  TEST_IDX=1
  echo "  - id: ${FEATURE_SLUG}-suite"
  echo "    name: ${FEATURE} tests"
  echo "    tags: [smoke, regression]"
  echo "    setup: []"
  echo "    tests:"

  while IFS=$'\t' read -r method path src; do
    [ -z "$method" ] && continue
    TEST_ID=$(printf '%s-%03d' "$FEATURE_SLUG_UPPER" "$TEST_IDX")
    # Determine expected status by method
    case "$method" in
      POST)   EXPECT_STATUS=201 ;;
      DELETE) EXPECT_STATUS=204 ;;
      *)      EXPECT_STATUS=200 ;;
    esac
    # Auto-pick token by path
    if echo "$path" | grep -q "^/bo/"; then
      TOKEN="bo_admin_mode_b"
    elif echo "$path" | grep -q "^/internal/"; then
      TOKEN=""  # no auth
    else
      TOKEN="user_token"
    fi
    TOKEN_LINE=""
    [ -n "$TOKEN" ] && TOKEN_LINE="          token: $TOKEN"

    cat <<YAML
      - id: $TEST_ID
        name: $method $path
        tags: [smoke]
        # source: $src
        setup: []
        request:
          method: $method
          path: $path
${TOKEN_LINE:+$TOKEN_LINE}
        expect:
          status: $EXPECT_STATUS
          note: TODO — describe expected response.
        verify:
          - sql: "SELECT 1 -- TODO: add verification query"
            expect: "TODO"
        teardown: []
YAML
    TEST_IDX=$(( TEST_IDX + 1 ))
  done <<< "$ENDPOINTS_TSV"
}

SUITES_YAML=$(generate_tests)

# ─── Write CHECKLIST.yaml ──────────────────────────────────────────────────

mkdir -p "$DEST_DIR"
cat > "$DEST_FILE" <<EOF
# CHECKLIST.yaml — $FEATURE
# Auto-generated by scripts/checklist-init.sh on $(date '+%Y-%m-%d').
# REVIEW THIS FILE before running /manual-test:
#   1. Fill in SQL seed queries in setup blocks
#   2. Update expect.note with real expected behaviour
#   3. Add verify SQL queries
#   4. Fill teardown to restore state
# See skill references/checklist.md for full schema reference.

config:
  base_url: http://localhost:\${SERVER_PORT:-$PORT}
  db:
    host: \${CTX_DB_HOST:-localhost}
    port: \${CTX_DB_PORT:-5432}
    database: \${CTX_DB_NAME:-\${DB_NAME}}
    username: \${CTX_DB_USER:-postgres}
    password: \${DB_PASS:-postgres}
  redis:
    host: \${CTX_REDIS_HOST:-localhost}
    port: \${CTX_REDIS_PORT:-6379}

$TOKENS_YAML

seed:
  # Add reusable INSERT snippets here, referenced from setup blocks via 'seed: name'.
  # example_parent: |
  #   INSERT INTO parent (id, code, status) VALUES ('\${PARENT_ID}', 'TEST-PARENT', 'ACTIVE')
  #   ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

cleanup:
  all: |
    -- TODO: DELETE test rows created by this feature's tests
    -- DELETE FROM your_table WHERE ref_id LIKE 'TEST-$FEATURE_SLUG-%';

suites:
$SUITES_YAML
EOF

echo ""
echo "Generated: $DEST_FILE"
if [ -n "$ENDPOINTS_TSV" ]; then
  ENDPOINT_COUNT=$(echo "$ENDPOINTS_TSV" | wc -l | tr -d ' ')
  echo "Discovered $ENDPOINT_COUNT endpoint(s) from codebase."
else
  echo "No endpoints auto-discovered — placeholder test added."
  echo "Tip: pass --path /api/v1/$FEATURE_SLUG to narrow the search."
fi
echo ""
echo "Next steps:"
echo "  1. Review and fill in TODOs in: $DEST_FILE"
echo "  2. Run: /manual-test $FEATURE smoke"
