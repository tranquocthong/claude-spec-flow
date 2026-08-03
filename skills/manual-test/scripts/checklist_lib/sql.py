"""SQL execution, scalar verify assertions, and poll-until helpers.

Runs through db-query.sh -t (tuples-only). A `verify` block's `expect`
(same rules for a `setup:`/`teardown:` sql step's `expect`, see setup.py):
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


_DB_FLAGS = (("database", "-d"), ("host", "--host"), ("port", "--port"),
             ("user", "--user"), ("password", "--password"))


def db_flags(db):
    """A db is either a plain database NAME (str) or a full connection spec (dict:
    database/host/port/user/password). Unset dict fields stay unset, so db-creds.sh
    discovery still supplies them — a second database on the same server needs only
    `database:`."""
    if isinstance(db, dict):
        out = []
        for key, flag in _DB_FLAGS:
            val = db.get(key)
            if val is not None and str(val) != "":
                out += [flag, str(val)]
        return out
    return ["-d", str(db)]


def db_label(db):
    if not isinstance(db, dict):
        return str(db)
    name = db.get("database", "?")
    host, port = db.get("host"), db.get("port")
    return f"{name}@{host or 'default'}:{port}" if (host or port) else str(name)


def resolve_db(spec, default_db, dbs):
    """`db_ref: <name>` picks a named alternate from config.databases (multi-service),
    mirroring `base_url_ref` for HTTP. Default is config.db.

    An undefined ref RAISES rather than falling back: silently querying the default
    database would assert against the wrong server and report a green PASS."""
    ref = (spec or {}).get("db_ref")
    if not ref:
        return default_db
    got = (dbs or {}).get(ref)
    if not got:
        known = ", ".join(sorted(dbs or {})) or "(none declared)"
        raise RuntimeError(f"unknown db_ref '{ref}' — declared databases: {known}. "
                           f"Define it under config.databases.")
    return got


def run_sql(sql, db, scripts_dir):
    cmd = [os.path.join(scripts_dir, "db-query.sh"), sql, "-t"] + db_flags(db)
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode()
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"db-query.sh failed on '{db_label(db)}' (exit {e.returncode})") from e
    lines = [l for l in out.splitlines() if l and not l.startswith("[db-creds.sh]")]
    return "\n".join(lines).strip()


def check_scalar(result, exp, varstore):
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


def verify_sql(verify_block, db, scripts_dir, varstore, dbs=None):
    """Run sql verify items. Returns (ok, errs, info_msgs).

    Each item may carry `db_ref: <name>` to assert against another service's database."""
    errs, msgs = [], []
    for vb in verify_block:
        if "sql" not in vb:
            continue  # kafka_* items handled by kafka.check
        try:
            target = resolve_db(vb, db, dbs)
            result = run_sql(varstore.expand(vb["sql"]), target, scripts_dir).strip()
        except Exception as e:
            errs.append(f"verify SQL failed: {e}")
            continue
        ok, detail = check_scalar(result, vb.get("expect"), varstore)
        if ok is None:
            msgs.append(f"      verify: {result[:200]}  (expect: {vb.get('expect', '<unspecified>')})")
        elif ok:
            msgs.append(f"      verify OK: {detail}")
        else:
            errs.append(f"verify: {detail}")
    return (len(errs) == 0), errs, msgs


def poll(poll_def, db, scripts_dir, varstore, dbs=None):
    """Poll a SQL query until its scalar result equals `until`, or timeout.

    Accepts `db_ref: <name>` — an async settle often lands in the DOWNSTREAM service's
    database, which is exactly where the default db can't see it."""
    sql = varstore.expand(poll_def.get("sql", ""))
    until = str(varstore.expand(str(poll_def.get("until", "")))).strip()
    interval = int(poll_def.get("interval_ms", 500)) / 1000.0
    timeout = int(poll_def.get("timeout_ms", 10000)) / 1000.0
    try:
        target = resolve_db(poll_def, db, dbs)
    except Exception as e:
        return False, str(e)
    deadline = time.time() + timeout
    last = None
    while True:
        try:
            last = run_sql(sql, target, scripts_dir).strip()
        except Exception as e:
            return False, f"poll sql error: {e}"
        if last == until:
            return True, f"poll matched '{until}'"
        if time.time() >= deadline:
            return False, f"poll timeout: wanted '{until}' got '{last}'"
        time.sleep(interval)
