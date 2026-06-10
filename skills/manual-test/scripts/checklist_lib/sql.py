"""SQL execution, scalar verify assertions, and poll-until helpers.

Runs through db-query.sh -t (tuples-only). A `verify` block's `expect`:
  - scalar (int / short string / "<op> value")  → HARD assertion vs the scalar result
  - dict (multi-column)                          → descriptive print (db-query.sh -t
    has no column headers to map by name; assert columns via separate scalar rows
    or json_path on the API response instead)
"""
import os
import re
import subprocess
import time

from . import jsonpath

_OP_RE = re.compile(r"^(>=|<=|!=|>|<|=)\s*(.+)$")


def run_sql(sql, db, scripts_dir):
    cmd = [os.path.join(scripts_dir, "db-query.sh"), sql, "-d", db, "-t"]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode()
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"db-query.sh failed (exit {e.returncode})") from e
    lines = [l for l in out.splitlines() if l and not l.startswith("[db-creds.sh]")]
    return "\n".join(lines).strip()


def _check_scalar(result, exp, varstore):
    """Return (ok|None, detail). None = descriptive (no assertion)."""
    if exp is None or isinstance(exp, dict):
        return None, ""
    s = str(varstore.expand(str(exp))).strip()
    m = _OP_RE.match(s)
    if m:
        op, rhs = m.group(1), m.group(2).strip()
        op = "==" if op == "=" else op
        return jsonpath.cmp(result, op, rhs), f"'{result}' {op} '{rhs}'"
    return jsonpath.cmp(result, "==", s), f"expected '{s}' got '{result}'"


def verify_sql(verify_block, db, scripts_dir, varstore):
    """Run sql verify items. Returns (ok, errs, info_msgs)."""
    errs, msgs = [], []
    for vb in verify_block:
        if "sql" not in vb:
            continue  # kafka_* items handled by kafka.check
        try:
            result = run_sql(varstore.expand(vb["sql"]), db, scripts_dir).strip()
        except Exception as e:
            errs.append(f"verify SQL failed: {e}")
            continue
        ok, detail = _check_scalar(result, vb.get("expect"), varstore)
        if ok is None:
            msgs.append(f"      verify: {result[:200]}  (expect: {vb.get('expect', '<unspecified>')})")
        elif ok:
            msgs.append(f"      verify OK: {detail}")
        else:
            errs.append(f"verify: {detail}")
    return (len(errs) == 0), errs, msgs


def poll(poll_def, db, scripts_dir, varstore):
    """Poll a SQL query until its scalar result equals `until`, or timeout."""
    sql = varstore.expand(poll_def.get("sql", ""))
    until = str(varstore.expand(str(poll_def.get("until", "")))).strip()
    interval = int(poll_def.get("interval_ms", 500)) / 1000.0
    timeout = int(poll_def.get("timeout_ms", 10000)) / 1000.0
    deadline = time.time() + timeout
    last = None
    while True:
        try:
            last = run_sql(sql, db, scripts_dir).strip()
        except Exception as e:
            return False, f"poll sql error: {e}"
        if last == until:
            return True, f"poll matched '{until}'"
        if time.time() >= deadline:
            return False, f"poll timeout: wanted '{until}' got '{last}'"
        time.sleep(interval)
