"""Setup/teardown step executor.

Each step is one of:
  - sql: "..."            run SQL (optional `capture: {VAR: ...}` → first scalar)
  - seed: name            run the named snippet from the top-level `seed:` map
  - http: {...}           call an endpoint (optional `capture: {VAR: "$.json.path"}`)
  - redis: |              run redis-cli line(s)

`ctx` carries: db, scripts_dir, base_url, varstore, tokens, doc.
"""
import subprocess

from . import http, jsonpath, sql


def run_steps(steps, ctx, dry_run=False, warn_only=False):
    """Run a list of setup/teardown steps. Returns an error string or None.

    warn_only=True (teardown): never raises/aborts — best-effort, prints warnings.
    """
    for sb in steps or []:
        try:
            _run_one(sb, ctx, dry_run)
        except Exception as e:
            if warn_only:
                print(f"      teardown warning: {e}")
                continue
            return str(e)
    return None


def _run_one(sb, ctx, dry_run):
    if "sql" in sb:
        _do_sql(sb, ctx, dry_run)
    elif "seed" in sb:
        _do_seed(sb, ctx, dry_run)
    elif "http" in sb:
        _do_http(sb, ctx, dry_run)
    elif "redis" in sb:
        _do_redis(sb, ctx, dry_run)


def _do_sql(sb, ctx, dry_run):
    if dry_run:
        return
    vs = ctx["varstore"]
    result = sql.run_sql(vs.expand(sb["sql"]), ctx["db"], ctx["scripts_dir"])
    cap = sb.get("capture")
    if cap:
        scalar = result.splitlines()[0].strip() if result else ""
        # SQL capture is scalar: first column of the first row → each named var.
        for var in cap:
            vs.set(var, scalar)


def _do_seed(sb, ctx, dry_run):
    name = sb["seed"]
    snippet = (ctx["doc"].get("seed") or {}).get(name)
    if snippet is None:
        raise RuntimeError(f"seed '{name}' not defined in top-level seed:")
    if not dry_run:
        sql.run_sql(ctx["varstore"].expand(snippet), ctx["db"], ctx["scripts_dir"])


def _do_http(sb, ctx, dry_run):
    if dry_run:
        return
    vs, h = ctx["varstore"], sb["http"]
    method = (h.get("method") or "GET").upper()
    path = vs.expand(h.get("path", ""))
    headers = {}
    tname = h.get("token")
    if tname and tname in ctx["tokens"]:
        k, v = ctx["tokens"][tname]
        headers[k] = v
    body = h.get("body")
    if isinstance(body, str):
        body = vs.expand(body)
    url = http.build_url(ctx["base_url"], path, vs.expand_obj(h.get("query") or {}))
    status, jbody, _ = http.do_request(method, url, headers, body)
    if status >= 400:
        raise RuntimeError(f"setup http {method} {path} → {status}")
    for var, expr in (h.get("capture") or {}).items():
        vals = jsonpath.resolve(vs.expand(expr), jbody) if jbody is not None else []
        vs.set(var, vals[0] if vals else "")


def _do_redis(sb, ctx, dry_run):
    if dry_run:
        return
    for line in ctx["varstore"].expand(sb["redis"]).splitlines():
        line = line.strip()
        if not line:
            continue
        cmd = line if line.startswith("redis-cli") else f"redis-cli {line}"
        subprocess.run(cmd, shell=True, capture_output=True)
