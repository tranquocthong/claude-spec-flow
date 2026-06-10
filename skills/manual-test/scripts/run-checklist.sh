#!/usr/bin/env bash
# run-checklist.sh — drive every test from CHECKLIST.yaml (enforces Hard Rule #6)
#
# This is THE entry point for test execution. Ad-hoc curl is not allowed; if you
# find yourself wanting to bypass this runner, add a test to the checklist instead.
#
# Implementation lives in the checklist_lib/ package (one module per concern);
# _checklist_runner.py is a thin shim. See that package for the full grammar.
#
# Workflow:
#   1. Lint checklist (refuses TODO/scaffold markers; requires an assertion per test)
#   2. Resolve tokens (keycloak_ropc | client_credentials | `payload` X-Userinfo)
#   3. Per suite: run suite `setup` (sql | seed | http+capture | redis)
#   4. Per test: setup → request (http | kafka) → expect → verify → teardown
#   5. Global `cleanup.all` after all suites; summary with PASS/FAIL/SKIP counts
#
# `expect` assertions:
#   status: N                     → exact HTTP status
#   body_contains: "x" | [..]     → substring(s) present in raw response body
#   body_not_contains: "x" | [..] → substring(s) absent
#   json_path: "$.a == \"x\"" | [..] → JSONPath-lite expr(s): == != > < >= <= contains exists
#   poll: { sql, until, ... }     → async: poll a query until it equals `until`
#   body:                         → object/array matchers:
#     <field>: <value>            exact match on a top-level field
#     content_length / content: [] / content_all_match: {} / content_contains: [{}]   (Page envelope)
#     root_length / root_all_match: {} / root_contains: [{}]                            (bare JSON array)
#
# `verify` items:
#   - sql: "..."  expect: <scalar|op>   → HARD assert vs the scalar result (dict expect = descriptive)
#   - kafka_consumer_lag / kafka_dlt / kafka_topic   → best-effort (SKIP if kcat/docker absent)
#
# Per-run ${TEST_CORRELATION_ID} and per-test ${TEST_START} (UTC, Postgres now() format)
# are auto-injected. Extend the grammar in checklist_lib/, not by inventing new YAML shapes.
#
# Usage:
#   run-checklist.sh <feature> [--tag smoke|regression|...] [--id TEST-ID]
#   run-checklist.sh <path/to/CHECKLIST.yaml> [--tag smoke]
#
# Env:
#   BASE_URL   override base_url (default from checklist.config.base_url)
#   DRY_RUN=1  print plan, don't execute requests/SQL
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

err() { echo "ERROR: $*" >&2; }

if [[ $# -lt 1 ]]; then
  err "usage: run-checklist.sh <feature|path> [--tag smoke] [--id TEST-ID]"
  exit 2
fi

ARG="$1"; shift || true
TAG_FILTER=""
ID_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG_FILTER="$2"; shift 2 ;;
    --id)  ID_FILTER="$2";  shift 2 ;;
    *) err "unknown arg: $1"; exit 2 ;;
  esac
done

# Resolve checklist path
if [[ -f "$ARG" ]]; then
  CHECKLIST="$ARG"
elif [[ -f ".claude/docs/manual-tests/features/$ARG/CHECKLIST.yaml" ]]; then
  CHECKLIST=".claude/docs/manual-tests/features/$ARG/CHECKLIST.yaml"
else
  err "checklist not found: $ARG"
  exit 2
fi

# Step 1: lint
echo "── lint ──────────────────────────────────────"
if ! "$SCRIPT_DIR/lint-checklist.sh" "$CHECKLIST"; then
  exit 1
fi

# Step 2+: run via python
echo ""
echo "── run ───────────────────────────────────────"
exec python3 "$SCRIPT_DIR/_checklist_runner.py" \
  --checklist "$CHECKLIST" \
  --scripts-dir "$SCRIPT_DIR" \
  ${TAG_FILTER:+--tag "$TAG_FILTER"} \
  ${ID_FILTER:+--id "$ID_FILTER"} \
  ${BASE_URL:+--base-url "$BASE_URL"} \
  ${DRY_RUN:+--dry-run}
