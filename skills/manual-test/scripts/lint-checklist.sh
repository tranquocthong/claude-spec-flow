#!/usr/bin/env bash
# lint-checklist.sh — pre-flight gate for run-checklist.sh
#
# Refuses to allow execution when CHECKLIST.yaml still has unfilled scaffolding:
#   - "TODO" markers (description, expect.note, verify.expect, cleanup.all)
#   - "SELECT 1 -- TODO" placeholder verify queries
#   - request.path containing `{` (unresolved path templates from scaffolding)
#   - Empty `tests:` array
#   - `db_ref` / `base_url_ref` naming something not declared in config
#   - a malformed `expect_status:` on an http step (int, list of ints, or "any")
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
python3 - "$CHECKLIST" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" <<'PY'
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

# Dict `expect:` on a SQL step (verify[] / setup[] / teardown[]) is NEVER asserted —
# db-query.sh -t runs tuples-only (no column headers to map a dict key by name), so
# checklist_lib/sql.py's check_scalar() treats a dict expect as purely descriptive
# and always returns "no assertion" (see that module's own docstring). A multi-column
# dict is the MOST NATURAL way to write it (it's exactly how expect.body works for an
# HTTP assertion) — which makes it the one spelling that silently asserts NOTHING: a
# real bug in that row prints green. Catch it before the run, not after a false pass.
def walk_sql_expect(node, where):
    if isinstance(node, dict):
        if "sql" in node and isinstance(node.get("expect"), dict) and node.get("expect"):
            issues.append(f"{where}.expect: a dict expect on a SQL step is never asserted (db-query.sh -t has no column headers to match keys by) — split into one scalar `verify:` row per column (`expect: \"col = value\"`), or assert via the HTTP response's json_path instead.")
        for k, v in node.items():
            walk_sql_expect(v, f"{where}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk_sql_expect(v, f"{where}[{i}]")

walk_sql_expect(doc, "$")

# `expect_status:` on an http step (setup / teardown). The runner rejects a malformed
# value only when the step executes, i.e. half-way through a suite. Same grammar as
# checklist_lib/setup.py's parse_expect_status: an int 100-599, a list of them, or "any".
sys.path.insert(0, sys.argv[2])
from checklist_lib.setup import parse_expect_status as _parse_expect_status  # noqa: E402
def walk_expect_status(node, where):
    if isinstance(node, dict):
        if isinstance(node.get("http"), dict):
            for holder, label in ((node["http"], "http"), (node, "")):
                if "expect_status" in holder:
                    v = holder["expect_status"]
                    if _parse_expect_status(v) is None:
                        issues.append(f"{where}.{label + '.' if label else ''}expect_status: invalid value {v!r} — use an int (e.g. 401), a list of ints (e.g. [400, 401]) or \"any\".")
        for k, v in node.items():
            walk_expect_status(v, f"{where}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk_expect_status(v, f"{where}[{i}]")

walk_expect_status(doc, "$")

# Undeclared db_ref / base_url_ref. Both fail the run anyway, but a typo'd ref that
# only surfaces once the suite is half-executed wastes a full manual-test cycle.
_cfg = doc.get("config") or {}
_refs = (("db_ref", set(_cfg.get("databases") or {}), "config.databases"),
         ("base_url_ref", set(_cfg.get("base_urls") or {}), "config.base_urls"))

def walk_refs(node, where):
    if isinstance(node, dict):
        for key, declared, cfg_key in _refs:
            ref = node.get(key)
            if ref and str(ref) not in declared:
                known = ", ".join(sorted(declared)) or "(none declared)"
                issues.append(f"{where}.{key}: unknown '{ref}' — declared: {known}. Add it under {cfg_key}.")
        for k, v in node.items():
            walk_refs(v, f"{where}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk_refs(v, f"{where}[{i}]")

walk_refs(doc, "$")

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

# Negative-path coverage. The per-test rule above asks "does this test assert
# anything"; it never asks "does this checklist ever exercise a rejection". A
# suite that only walks happy paths passes every gate while the error branches —
# where the error codes and the guard clauses live — are never touched once.
# A warning, not a failure: it is a coverage signal about the SD's test cases,
# and existing checklists must stay runnable while their SD §13.2 is filled in.
_total = sum(len(su.get("tests") or []) for su in suites)
_negative = 0
for _su in suites:
    for _t in _su.get("tests") or []:
        _e = _t.get("expect") or {}
        if isinstance(_e, dict) and isinstance(_e.get("status"), int) and _e["status"] >= 400:
            _negative += 1
if _total >= 5 and _negative == 0:
    print(f"  ! no negative-path test: none of {_total} test cases assert a rejection "
          f"(expect.status >= 400). Happy paths alone leave every error code and guard "
          f"clause unexercised — check SD §13.2 for the rejection cases and add them.",
          file=sys.stderr)

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
