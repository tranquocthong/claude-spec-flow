"""Setup/teardown step executor.

Each step is one of:
  - sql: "..."            run SQL (optional `capture: {VAR: ...}` → first scalar)
  - seed: name            run the named snippet from the top-level `seed:` map
  - http: {...}           call an endpoint (optional `capture: {VAR: "$.json.path"}`)
  - redis: |              run redis-cli line(s)
  - exec: "cmd"           run a project command; capture stdout into vars
                          (optional `capture: {VAR: "$.json.path"}` if the command
                          prints JSON, else `{VAR: stdout}` captures the whole output).
                          Generic escape hatch: request signing, token minting, any
                          pre-compute lives in the PROJECT's script — not in this runner.

`ctx` carries: db, scripts_dir, base_url, varstore, tokens, doc.
"""
import json
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
    elif "exec" in sb:
        _do_exec(sb, ctx, dry_run)


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
    for hk, hv in (h.get("headers") or {}).items():
        headers[hk] = vs.expand(str(hv))
    body = vs.expand_obj(h.get("body"))
    ref = h.get("base_url_ref")
    base = (ctx.get("base_urls") or {}).get(ref) if ref else ctx["base_url"]
    if ref and not base:
        raise RuntimeError(f"unknown base_url_ref '{ref}' — define it under config.base_urls")
    url = http.build_url(base, path, vs.expand_obj(h.get("query") or {}))
    status, jbody, _ = http.do_request(method, url, headers, body)
    if status >= 400:
        raise RuntimeError(f"setup http {method} {path} → {status}")
    for var, expr in (h.get("capture") or {}).items():
        vals = jsonpath.resolve(vs.expand(expr), jbody) if jbody is not None else []
        vs.set(var, vals[0] if vals else "")


def _do_exec(sb, ctx, dry_run):
    if dry_run:
        return
    vs = ctx["varstore"]
    cmd = vs.expand(sb["exec"])
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"setup exec failed ({proc.returncode}): {cmd}\n{(proc.stderr or '').strip()[:200]}")
    out = (proc.stdout or "").strip()
    cap = sb.get("capture") or {}
    parsed = None
    if any(isinstance(e, str) and e.startswith("$") for e in cap.values()):
        try:
            parsed = json.loads(out)
        except Exception:
            parsed = None
    for var, expr in cap.items():
        if isinstance(expr, str) and expr.startswith("$") and parsed is not None:
            vals = jsonpath.resolve(vs.expand(expr), parsed)
            vs.set(var, vals[0] if vals else "")
        else:
            vs.set(var, out)  # capture whole stdout


def _do_redis(sb, ctx, dry_run):
    if dry_run:
        return
    for line in ctx["varstore"].expand(sb["redis"]).splitlines():
        line = line.strip()
        if not line:
            continue
        cmd = line if line.startswith("redis-cli") else f"redis-cli {line}"
        subprocess.run(cmd, shell=True, capture_output=True)
