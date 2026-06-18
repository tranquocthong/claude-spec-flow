#!/usr/bin/env bash
# lint-checklist.sh — pre-flight gate for run-checklist.sh
#
# Refuses to allow execution when CHECKLIST.yaml still has unfilled scaffolding:
#   - "TODO" markers (description, expect.note, verify.expect, cleanup.all)
#   - "SELECT 1 -- TODO" placeholder verify queries
#   - request.path containing `{` (unresolved path templates from scaffolding)
#   - Empty `tests:` array
#
# Exits 0 if checklist is clean, 1 otherwise with structured error list.
#
# Usage:
#   lint-checklist.sh <feature>
#   lint-checklist.sh <path/to/CHECKLIST.yaml>
set -euo pipefail

err() { echo "ERROR: $*" >&2; }

resolve_checklist() {
  local arg="$1"
  if [[ -f "$arg" ]]; then echo "$arg"; return 0; fi
  local p=".claude/docs/manual-tests/features/$arg/CHECKLIST.yaml"
  if [[ -f "$p" ]]; then echo "$p"; return 0; fi
  err "checklist not found: $arg (tried as path and as feature name)"
  return 1
}

if [[ $# -lt 1 ]]; then
  err "usage: lint-checklist.sh <feature|path>"
  exit 2
fi

CHECKLIST=$(resolve_checklist "$1") || exit 2

# Use python for robust YAML parsing rather than regex
python3 - "$CHECKLIST" <<'PY'
import sys, re
try:
    import yaml
except ImportError:
    print("ERROR: PyYAML required. Install: pip3 install pyyaml", file=sys.stderr)
    sys.exit(2)

path = sys.argv[1]
with open(path) as f:
    raw = f.read()
    doc = yaml.safe_load(raw) or {}

issues = []

def walk(node, where):
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, f"{where}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{where}[{i}]")
    elif isinstance(node, str):
        if re.search(r"\bTODO\b", node):
            issues.append(f"{where}: contains 'TODO' marker → fill in or remove")
        if re.search(r"SELECT\s+1\s*--", node, re.IGNORECASE):
            issues.append(f"{where}: placeholder 'SELECT 1 --' verify query — replace with real SQL")

walk(doc, "$")

suites = doc.get("suites", [])
if not suites:
    issues.append("$.suites: no suites defined — checklist is empty")
for si, suite in enumerate(suites):
    tests = suite.get("tests") or []
    if not tests:
        issues.append(f"$.suites[{si}].tests: no tests defined")
    for ti, t in enumerate(tests):
        req_path = (t.get("request") or {}).get("path", "")
        # Reject {PARAM} style (unresolved scaffold placeholder) but allow ${VAR} (runtime captured variable).
        # Pattern: a bare { not preceded by $ indicates an unfilled template from checklist-init.sh.
        if isinstance(req_path, str) and re.search(r"(?<!\$)\{", req_path):
            issues.append(f"$.suites[{si}].tests[{ti}].request.path: unresolved template '{req_path}' — replace path variables with real IDs")
        # Require an assertion. Any of these counts as a real check:
        #   expect.body (content_*/root_*/field), expect.body_contains/_not_contains,
        #   expect.json_path, expect.poll (async settle), a verify[] block, or [no-verify].
        # A response-body assertion is a valid PASS — masking / projection / read
        # features have no DB delta to assert (see test-rigor.md MUST-2 carve-out).
        exp = t.get("expect") or {}
        body = exp.get("body")
        has_body = isinstance(body, (dict, list)) and len(body) > 0
        has_assert = bool(
            exp.get("body_contains") or exp.get("body_not_contains")
            or exp.get("json_path") or exp.get("poll")
        )
        has_verify = bool(t.get("verify"))
        # Carve-out tags: no-verify (assertion-only/status-only/pure-unit) and live-e2e
        # (no synchronous HTTP surface — verified by a live run, not curl). Same source of
        # truth as checklist-status: a bare tag in the tests[].tags list.
        _tags = t.get("tags") or []
        _carved = ("no-verify" in _tags) or ("live-e2e" in _tags)
        if not (has_verify or has_body or has_assert) and not _carved:
            has_status = "status" in exp
            hint = "a bare expect.status is not a sufficient assertion — also assert the response body" if has_status else "add an assertion"
            issues.append(f"$.suites[{si}].tests[{ti}] ({t.get('id','?')}): {hint}. Use expect.body / body_contains / json_path (incl. error-body for rejection tests), a verify: block (mutation), expect.poll (async), OR tag the test no-verify (assertion-only) / live-e2e (no HTTP surface).")

if issues:
    for it in issues:
        print(f"  ✗ {it}", file=sys.stderr)
    sys.exit(1)

print("  ✓ checklist clean — no scaffold markers, all paths resolved", file=sys.stderr)
PY

rc=$?
if [[ $rc -ne 0 ]]; then
  echo "" >&2
  echo "lint-checklist FAILED — fix the above before running tests." >&2
  echo "Checklist: $CHECKLIST" >&2
  exit "$rc"
fi

echo "lint-checklist OK: $CHECKLIST" >&2
exit 0
