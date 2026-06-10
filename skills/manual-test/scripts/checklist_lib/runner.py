"""Orchestrator — drives every test in a CHECKLIST.yaml.

Per test: per-test setup → request (http | kafka) → expect (status/body/json_path
/poll) → verify (sql scalar + kafka best-effort) → teardown. Global `cleanup.all`
runs after all suites complete. Refuses to bypass: the only way to add a test is
to add a YAML block.
"""
import argparse
import sys

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML required. Install: pip3 install pyyaml", file=sys.stderr)
    sys.exit(2)

from . import assertions, auth, http, kafka, setup, sql
from .vars import VarStore

GREEN, RED, YELLOW, RESET, BOLD = "\033[32m", "\033[31m", "\033[33m", "\033[0m", "\033[1m"


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--checklist", required=True)
    p.add_argument("--scripts-dir", required=True)
    p.add_argument("--tag", default=None)
    p.add_argument("--id", dest="test_id", default=None)
    p.add_argument("--base-url", default=None)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def _send_request(req, ctx):
    """Execute the request. Returns (kind, status, body, raw) or kafka (ok, msg)."""
    vs = ctx["varstore"]
    if req.get("kafka"):
        ok, msg = kafka.produce(req["kafka"], ctx["scripts_dir"], vs)
        return ("kafka", ok, msg, None)

    method = (req.get("method") or "GET").upper()
    path = vs.expand(req.get("path", ""))
    headers = {}
    tname = req.get("token")
    if tname:
        if tname not in ctx["tokens"]:
            return ("error", None, f"unknown token '{tname}'", None)
        k, v = ctx["tokens"][tname]
        headers[k] = v
    body = req.get("body")
    if isinstance(body, str):
        body = vs.expand(body)
    url = http.build_url(ctx["base_url"], path, vs.expand_obj(req.get("query") or {}))
    status, jbody, raw = http.do_request(method, url, headers, body)
    return ("http", status, jbody, raw)


def _run_verify(verify_block, ctx, errs, msgs):
    sql_items = [v for v in verify_block if "sql" in v]
    if sql_items:
        ok, verrs, vmsgs = sql.verify_sql(sql_items, ctx["db"], ctx["scripts_dir"], ctx["varstore"])
        errs.extend(verrs)
        msgs.extend(vmsgs)
    for vb in verify_block:
        if "sql" in vb:
            continue
        status, detail = kafka.check(vb, ctx["varstore"])
        if status is None:
            msgs.append(f"      {YELLOW}skip:{RESET} {detail}")
        elif status:
            msgs.append(f"      verify OK: {detail}")
        else:
            errs.append(f"kafka verify: {detail}")


def main(argv=None):
    args = parse_args(argv)
    try:
        with open(args.checklist) as f:
            doc = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        print(f"{RED}invalid YAML in {args.checklist}: {e}{RESET}")
        print(f"{YELLOW}hint: quote ${{VAR}} inside flow mappings, or use block style "
              f"(db:\\n  database: \"${{DB_NAME}}\").{RESET}")
        return 2

    vs = VarStore()
    cfg = doc.get("config", {}) or {}
    base_url = args.base_url or vs.expand(cfg.get("base_url", "http://localhost:8081"))
    db_name = vs.expand(str((cfg.get("db") or {}).get("database", "${DB_NAME:-postgres}")))

    ctx = {"db": db_name, "scripts_dir": args.scripts_dir, "base_url": base_url,
           "varstore": vs, "tokens": {}, "doc": doc}

    print(f"checklist: {args.checklist}")
    print(f"base_url:  {base_url}")
    print(f"db:        {db_name}")
    print(f"corr-id:   {vs.get('TEST_CORRELATION_ID')}")
    if args.tag:
        print(f"filter:    tag={args.tag}")
    if args.test_id:
        print(f"filter:    id={args.test_id}")
    print()

    # Resolve tokens up front (fail fast on auth issues). Skip on dry-run —
    # resolution makes external calls (kc-ropc/OAuth) and dry-run must be inert.
    if not args.dry_run:
        for name, td in (doc.get("tokens", {}) or {}).items():
            try:
                ctx["tokens"][name] = auth.resolve_token(td, args.scripts_dir, vs)
            except Exception as e:
                print(f"{RED}token '{name}' resolution failed: {e}{RESET}")
                return 2

    total = passed = failed = skipped = 0

    for suite in doc.get("suites", []) or []:
        print(f"{BOLD}── suite: {suite.get('id', '?')} ──{RESET}")

        if not args.dry_run:
            err = setup.run_steps(suite.get("setup", []), ctx)
            if err:
                print(f"  {RED}suite setup failed: {err}{RESET}")
                return 2

        for test in suite.get("tests", []) or []:
            tid = test.get("id", "?")
            tags = test.get("tags", []) or []
            if args.tag and args.tag not in tags:
                skipped += 1
                continue
            if args.test_id and args.test_id != tid:
                skipped += 1
                continue

            total += 1
            vs.new_test_start()

            err = setup.run_steps(test.get("setup", []), ctx, dry_run=args.dry_run)
            if err:
                print(f"  {RED}✗ {tid}: setup failed: {err}{RESET}")
                failed += 1
                continue

            req = test.get("request") or {}
            exp = test.get("expect") or {}
            label = "kafka" if req.get("kafka") else f"{(req.get('method') or 'GET').upper()} {vs.expand(req.get('path', ''))}"
            print(f"  {tid}  {label}")

            if args.dry_run:
                print("    → DRY_RUN (request/SQL skipped)")
                continue

            kind, a, b, c = _send_request(req, ctx)
            errs, msgs = [], []

            if kind == "error":
                errs.append(b)
            elif kind == "kafka":
                if not a:
                    errs.append(f"kafka produce: {b}")
                else:
                    msgs.append(f"      {b}")
                    poll_def = exp.get("poll")
                    if poll_def:
                        ok, detail = sql.poll(poll_def, db_name, args.scripts_dir, vs)
                        (msgs if ok else errs).append(f"      poll: {detail}" if ok else f"poll: {detail}")
            else:  # http
                status, body, raw = a, b, c
                if exp.get("poll"):
                    ok, detail = sql.poll(exp["poll"], db_name, args.scripts_dir, vs)
                    (msgs if ok else errs).append(f"      poll: {detail}" if ok else f"poll: {detail}")
                a_errs = assertions.assert_expect(exp, status, body, raw, vs)
                if a_errs and body is None and (exp.get("json_path") or exp.get("body")):
                    a_errs.append(f"raw body: {(raw or '')[:200]}")
                errs.extend(a_errs)

            verify_block = test.get("verify") or []
            if verify_block:
                _run_verify(verify_block, ctx, errs, msgs)

            if errs:
                print(f"    {RED}✗ FAIL{RESET}")
                for e in errs:
                    print(f"      {e}")
                failed += 1
            else:
                tail = f"  status={a}" if kind == "http" else ""
                print(f"    {GREEN}✓ PASS{RESET}{tail}")
                for m in msgs:
                    print(m)
                passed += 1

            setup.run_steps(test.get("teardown", []), ctx, warn_only=True)

    # Global cleanup (after all suites).
    cleanup_all = (doc.get("cleanup") or {}).get("all")
    if cleanup_all and not args.dry_run:
        try:
            sql.run_sql(vs.expand(cleanup_all), db_name, args.scripts_dir)
            print(f"\n{BOLD}cleanup:{RESET} ran global cleanup")
        except Exception as e:
            print(f"\n{YELLOW}cleanup warning: {e}{RESET}")

    print(f"\n{BOLD}── summary ──{RESET}")
    print(f"  total:   {total}")
    print(f"  {GREEN}passed:  {passed}{RESET}")
    print(f"  {RED}failed:  {failed}{RESET}")
    print(f"  skipped: {skipped}")
    return 0 if failed == 0 else 1
