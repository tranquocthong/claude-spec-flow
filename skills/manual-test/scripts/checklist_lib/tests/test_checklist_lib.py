#!/usr/bin/env python3
"""Unit tests for the pure-logic checklist_lib modules — zero infra, stdlib only.

Covers jsonpath, assertions, vars, and sql scalar-verify (the regression-prone
logic). HTTP/Kafka/SQL execution and setup steps need real infra and are exercised
by the dry-run sweep + live runs, not here.

Run:  python3 -m unittest checklist_lib.tests.test_checklist_lib   (from scripts/)
  or: python3 checklist_lib/tests/test_checklist_lib.py
"""
import os
import re
import sys
import unittest

# Make `import checklist_lib` work regardless of cwd (scripts/ is two levels up).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from checklist_lib import assertions, jsonpath, runner, sql  # noqa: E402
from checklist_lib.vars import VarStore  # noqa: E402


class TestJsonPathResolve(unittest.TestCase):
    def setUp(self):
        self.obj = {"status": "PENDING",
                    "content": [{"id": 1, "masked": True}, {"id": 2, "masked": True}],
                    "items": [{"name": "a"}, {"name": "b"}]}
        self.arr = [{"cardNumber": "****1234"}, {"cardNumber": "****5678"}]

    def test_root_and_keys(self):
        self.assertEqual(jsonpath.resolve("$", self.obj), [self.obj])
        self.assertEqual(jsonpath.resolve("$.status", self.obj), ["PENDING"])

    def test_wildcard_projection(self):
        self.assertEqual(jsonpath.resolve("$.content[*].id", self.obj), [1, 2])
        self.assertEqual(jsonpath.resolve("$.items[*].name", self.obj), ["a", "b"])

    def test_index_positive_and_nested(self):
        self.assertEqual(jsonpath.resolve("$.content[0].masked", self.obj), [True])

    def test_bare_array_root(self):
        self.assertEqual(jsonpath.resolve("$[*].cardNumber", self.arr), ["****1234", "****5678"])
        self.assertEqual(jsonpath.resolve("$[0].cardNumber", self.arr), ["****1234"])
        self.assertEqual(jsonpath.resolve("$[-1].cardNumber", self.arr), ["****5678"])

    def test_no_match_returns_empty(self):
        self.assertEqual(jsonpath.resolve("$.nope", self.obj), [])
        self.assertEqual(jsonpath.resolve("$.content[9].id", self.obj), [])


class TestJsonPathExpr(unittest.TestCase):
    def setUp(self):
        self.obj = {"status": "PENDING", "amount": 150,
                    "content": [{"masked": True}, {"masked": True}]}
        self.arr = [{"cardNumber": "****1234"}, {"cardNumber": "****5678"}]

    def test_equality(self):
        self.assertTrue(jsonpath.evaluate_expr('$.status == "PENDING"', self.obj)[0])
        self.assertFalse(jsonpath.evaluate_expr('$.status == "DONE"', self.obj)[0])

    def test_not_equal(self):
        self.assertTrue(jsonpath.evaluate_expr('$.status != "DONE"', self.obj)[0])

    def test_numeric_compare(self):
        self.assertTrue(jsonpath.evaluate_expr("$.amount > 100", self.obj)[0])
        self.assertFalse(jsonpath.evaluate_expr("$.amount < 100", self.obj)[0])
        self.assertTrue(jsonpath.evaluate_expr("$.amount >= 150", self.obj)[0])

    def test_wildcard_all_must_satisfy(self):
        self.assertTrue(jsonpath.evaluate_expr("$.content[*].masked == true", self.obj)[0])
        self.obj["content"][1]["masked"] = False
        self.assertFalse(jsonpath.evaluate_expr("$.content[*].masked == true", self.obj)[0])

    def test_contains_string_and_array(self):
        self.assertTrue(jsonpath.evaluate_expr('$.status contains "PEND"', self.obj)[0])
        self.assertTrue(jsonpath.evaluate_expr('$[*].cardNumber contains "****"', self.arr)[0])

    def test_exists(self):
        self.assertTrue(jsonpath.evaluate_expr("$.status exists", self.obj)[0])
        self.assertFalse(jsonpath.evaluate_expr("$.missing exists", self.obj)[0])

    def test_no_match_is_false(self):
        self.assertFalse(jsonpath.evaluate_expr('$.missing == "x"', self.obj)[0])


class TestAssertBody(unittest.TestCase):
    def setUp(self):
        self.vs = VarStore()
        self.page = {"status": "OK", "content": [{"masked": True}, {"masked": True}]}
        self.arr = [{"cardNumber": "****1234"}, {"cardNumber": "****5678"}]

    def test_content_legacy_matchers(self):
        self.assertEqual(assertions.assert_body({"content_length": 2}, self.page, self.vs), [])
        self.assertNotEqual(assertions.assert_body({"content_length": 3}, self.page, self.vs), [])
        self.assertEqual(assertions.assert_body({"content_all_match": {"masked": True}}, self.page, self.vs), [])

    def test_content_empty(self):
        self.assertEqual(assertions.assert_body({"content": []}, {"content": []}, self.vs), [])
        self.assertNotEqual(assertions.assert_body({"content": []}, self.page, self.vs), [])

    def test_root_matchers_bare_array(self):
        # The original bug: bare arrays were unassertable. Now covered by root_*.
        self.assertEqual(assertions.assert_body({"root_length": 2}, self.arr, self.vs), [])
        self.assertNotEqual(assertions.assert_body({"root_length": 3}, self.arr, self.vs), [])
        self.assertEqual(assertions.assert_body({"root_contains": [{"cardNumber": "****5678"}]}, self.arr, self.vs), [])
        self.assertNotEqual(assertions.assert_body({"root_all_match": {"cardNumber": "****1234"}}, self.arr, self.vs), [])

    def test_content_matchers_reject_non_object_body(self):
        # content_* must NOT silently pass on a bare array (was the latent gap).
        self.assertNotEqual(assertions.assert_body({"content_length": 2}, self.arr, self.vs), [])

    def test_field_match_with_var_expansion(self):
        self.vs.set("WANT", "ACTIVE")
        self.assertEqual(assertions.assert_body({"status": "${WANT}"}, {"status": "ACTIVE"}, self.vs), [])
        self.assertNotEqual(assertions.assert_body({"status": "${WANT}"}, {"status": "OTHER"}, self.vs), [])


class TestAssertExpect(unittest.TestCase):
    def setUp(self):
        self.vs = VarStore()
        self.arr = [{"cardNumber": "****1234"}, {"cardNumber": "****5678"}]
        self.raw = '[{"cardNumber":"****1234"},{"cardNumber":"****5678"}]'

    def test_status_mismatch(self):
        self.assertEqual(assertions.assert_expect({"status": 200}, 200, {}, "{}", self.vs), [])
        self.assertNotEqual(assertions.assert_expect({"status": 200}, 404, {}, "{}", self.vs), [])

    def test_body_contains_and_not_contains(self):
        self.assertEqual(assertions.assert_expect({"body_contains": "****1234"}, 200, self.arr, self.raw, self.vs), [])
        self.assertNotEqual(assertions.assert_expect({"body_contains": "9999"}, 200, self.arr, self.raw, self.vs), [])
        self.assertEqual(assertions.assert_expect({"body_not_contains": "9999"}, 200, self.arr, self.raw, self.vs), [])
        self.assertNotEqual(assertions.assert_expect({"body_not_contains": "****1234"}, 200, self.arr, self.raw, self.vs), [])

    def test_body_contains_list(self):
        errs = assertions.assert_expect({"body_contains": ["****1234", "****5678"]}, 200, self.arr, self.raw, self.vs)
        self.assertEqual(errs, [])

    def test_json_path_against_bare_array(self):
        errs = assertions.assert_expect({"json_path": '$[*].cardNumber contains "****"'}, 200, self.arr, self.raw, self.vs)
        self.assertEqual(errs, [])

    def test_json_path_on_non_json_body(self):
        errs = assertions.assert_expect({"json_path": "$.x == 1"}, 200, None, "not json", self.vs)
        self.assertNotEqual(errs, [])


class TestVarStore(unittest.TestCase):
    def test_expand_and_default(self):
        vs = VarStore()
        vs.set("FOO", "bar")
        self.assertEqual(vs.expand("x=${FOO}"), "x=bar")
        self.assertEqual(vs.expand("x=${UNSET:-def}"), "x=def")
        self.assertEqual(vs.expand("x=${UNSET}"), "x=")

    def test_captured_overrides_default(self):
        vs = VarStore()
        vs.set("FOO", "captured")
        self.assertEqual(vs.expand("${FOO:-fallback}"), "captured")

    def test_correlation_id_stable_within_run(self):
        vs = VarStore()
        self.assertEqual(vs.get("TEST_CORRELATION_ID"), vs.get("TEST_CORRELATION_ID"))
        self.assertTrue(vs.get("TEST_CORRELATION_ID").startswith("TEST-"))

    def test_test_start_format(self):
        vs = VarStore()
        ts = vs.get("TEST_START")
        # Postgres now()::text shape: YYYY-MM-DD HH:MM:SS.ffffff+00
        self.assertRegex(ts, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\+00$")

    def test_expand_obj_deep(self):
        vs = VarStore()
        vs.set("ID", "42")
        out = vs.expand_obj({"a": ["${ID}", {"b": "v-${ID}"}], "c": 7})
        self.assertEqual(out, {"a": ["42", {"b": "v-42"}], "c": 7})


class TestSqlScalarVerify(unittest.TestCase):
    def setUp(self):
        self.vs = VarStore()

    def test_numeric_equality(self):
        self.assertTrue(sql.check_scalar("1", 1, self.vs)[0])
        self.assertFalse(sql.check_scalar("0", 1, self.vs)[0])

    def test_string_equality(self):
        self.assertTrue(sql.check_scalar("PENDING", "PENDING", self.vs)[0])
        self.assertFalse(sql.check_scalar("DONE", "PENDING", self.vs)[0])

    def test_operator_forms(self):
        self.assertTrue(sql.check_scalar("5", "> 3", self.vs)[0])
        self.assertFalse(sql.check_scalar("2", "> 3", self.vs)[0])
        self.assertTrue(sql.check_scalar("3", ">= 3", self.vs)[0])

    def test_timestamp_lexicographic_vs_test_start(self):
        later = "2099-01-01 00:00:00.000000+00"
        earlier = "2000-01-01 00:00:00.000000+00"
        self.assertTrue(sql.check_scalar(later, "> ${TEST_START}", self.vs)[0])
        self.assertFalse(sql.check_scalar(earlier, "> ${TEST_START}", self.vs)[0])

    def test_dict_and_none_are_descriptive(self):
        self.assertIsNone(sql.check_scalar("x", {"a": 1}, self.vs)[0])
        self.assertIsNone(sql.check_scalar("x", None, self.vs)[0])

    def test_contains_operator(self):
        # REGRESSION: pre-fix `expect: "contains idx_foo"` fell through to the
        # exact-string fallback — the WHOLE (often multi-line) scalar result compared
        # against the literal string "contains idx_foo", which is never equal, so an
        # EXPLAIN-plan-contains-this-index assertion always failed regardless of
        # whether the index was actually there.
        plan = "Index Scan using idx_eid_log_created_at on eid_log\n  Index Cond: ..."
        self.assertTrue(sql.check_scalar(plan, "contains idx_eid_log_created_at", self.vs)[0])
        self.assertFalse(sql.check_scalar(plan, "contains idx_nonexistent", self.vs)[0])
        self.assertTrue(sql.check_scalar(plan, "not contains idx_nonexistent", self.vs)[0])
        self.assertFalse(sql.check_scalar(plan, "not contains idx_eid_log_created_at", self.vs)[0])

    def test_contains_requires_a_separating_space(self):
        # "containsX" must NOT be parsed as op=contains, rhs="X" — a literal expected
        # string that happens to start with the word "contains" stays a literal.
        self.assertTrue(sql.check_scalar("containsX", "containsX", self.vs)[0])


class TestMultiDatabase(unittest.TestCase):
    """`db_ref:` is the DB-side twin of `base_url_ref:`. Without it a feature spanning
    two services shared ONE connection, so the far side could not be SQL-verified at
    all — tests had to infer a downstream write from an HTTP side-channel."""

    def setUp(self):
        self.vs = VarStore()
        self.dbs = {"wallet": "wallet_db", "payment": {"database": "payment_db", "port": 2432}}

    def test_flags_for_plain_name(self):
        self.assertEqual(sql.db_flags("wallet_db"), ["-d", "wallet_db"])

    def test_flags_for_connection_spec(self):
        flags = sql.db_flags({"database": "payment_db", "host": "db2", "port": 2432})
        self.assertEqual(flags, ["-d", "payment_db", "--host", "db2", "--port", "2432"])

    def test_unset_spec_fields_are_omitted_so_creds_discovery_still_applies(self):
        self.assertEqual(sql.db_flags({"database": "d", "host": "", "user": None}), ["-d", "d"])

    def test_resolve_default_when_no_ref(self):
        self.assertEqual(sql.resolve_db({}, "default_db", self.dbs), "default_db")

    def test_resolve_named_ref(self):
        self.assertEqual(sql.resolve_db({"db_ref": "wallet"}, "default_db", self.dbs), "wallet_db")

    def test_unknown_ref_raises_instead_of_falling_back(self):
        # Falling back to the default DB would query the WRONG server and PASS green.
        with self.assertRaises(RuntimeError) as cm:
            sql.resolve_db({"db_ref": "ledger"}, "default_db", self.dbs)
        self.assertIn("unknown db_ref 'ledger'", str(cm.exception))
        self.assertIn("payment, wallet", str(cm.exception))

    def test_setup_step_routes_to_the_referenced_db(self):
        from checklist_lib import setup, sql as sqlmod
        seen = []
        orig, sqlmod.run_sql = sqlmod.run_sql, lambda s, db, d: (seen.append(db), "1")[1]
        try:
            ctx = {"db": "default_db", "dbs": self.dbs, "scripts_dir": ".",
                   "base_url": "", "varstore": VarStore(), "tokens": {}, "doc": {}}
            err = setup.run_steps([{"sql": "SELECT 1", "db_ref": "payment"}], ctx)
        finally:
            sqlmod.run_sql = orig
        self.assertIsNone(err)
        self.assertEqual(seen, [{"database": "payment_db", "port": 2432}])

    def test_verify_item_routes_to_the_referenced_db(self):
        from checklist_lib import sql as sqlmod
        seen = []
        orig, sqlmod.run_sql = sqlmod.run_sql, lambda s, db, d: (seen.append(db), "OK")[1]
        try:
            ok, errs, _ = sqlmod.verify_sql(
                [{"sql": "SELECT status", "expect": "OK", "db_ref": "wallet"}],
                "default_db", ".", self.vs, self.dbs)
        finally:
            sqlmod.run_sql = orig
        self.assertTrue(ok, errs)
        self.assertEqual(seen, ["wallet_db"])

    def test_verify_unknown_ref_is_a_failure_not_a_silent_default(self):
        ok, errs, _ = sql.verify_sql([{"sql": "SELECT 1", "db_ref": "nope"}],
                                     "default_db", ".", self.vs, self.dbs)
        self.assertFalse(ok)
        self.assertIn("unknown db_ref 'nope'", errs[0])

    def test_poll_unknown_ref_fails_fast_without_looping(self):
        ok, detail = sql.poll({"sql": "SELECT 1", "until": "x", "db_ref": "nope"},
                              "default_db", ".", self.vs, self.dbs)
        self.assertFalse(ok)
        self.assertIn("unknown db_ref 'nope'", detail)

    def test_db_spec_normalization(self):
        from checklist_lib.runner import _db_spec
        self.assertEqual(_db_spec("other_db", self.vs, "default_db"), "other_db")
        # A mapping that overrides only the port still needs a database name.
        self.assertEqual(_db_spec({"port": 2432}, self.vs, "default_db"),
                         {"port": "2432", "database": "default_db"})


class TestSetupSqlGuard(unittest.TestCase):
    """`expect:` on a setup sql step is a pre-state GUARD. Silently ignoring it (the
    old behaviour) let a test run on an unconfirmed baseline and PASS for the wrong
    reason — the template advertises it as `# pre-state confirmed`."""

    def _ctx(self):
        return {"db": "d", "scripts_dir": ".", "base_url": "", "varstore": VarStore(), "tokens": {}, "doc": {}}

    def _run(self, step, sql_result, **kw):
        from checklist_lib import setup, sql as sqlmod
        orig, sqlmod.run_sql = sqlmod.run_sql, lambda *a, **k: sql_result
        try:
            ctx = self._ctx()
            return setup.run_steps([step], ctx, **kw), ctx
        finally:
            sqlmod.run_sql = orig

    def test_matching_expect_passes(self):
        err, _ = self._run({"sql": "SELECT status", "expect": "CREATED"}, "CREATED")
        self.assertIsNone(err)

    def test_mismatched_expect_aborts(self):
        err, _ = self._run({"sql": "SELECT status", "expect": "CREATED"}, "DRAFT")
        self.assertIsNotNone(err)
        self.assertIn("setup sql guard failed", err)

    def test_operator_form_and_capture_still_work(self):
        err, ctx = self._run({"sql": "SELECT count(*)", "expect": "> 0", "capture": {"N": "scalar"}}, "3")
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("N"), "3")

    def test_dict_expect_stays_descriptive(self):
        err, _ = self._run({"sql": "SELECT a, b", "expect": {"a": 1}}, "9|9")
        self.assertIsNone(err)

    def test_no_expect_is_a_no_op(self):
        err, _ = self._run({"sql": "SELECT 1"}, "anything")
        self.assertIsNone(err)

    def test_teardown_guard_warns_instead_of_aborting(self):
        warnings, _ = self._run({"sql": "SELECT status", "expect": "GONE"}, "STILL_THERE", warn_only=True)
        # warn_only never aborts — but the failure must not vanish either: it comes
        # back as a warning string so the caller can surface it (JSON result /
        # VERIFICATION.md), instead of only being printed to console and lost.
        self.assertEqual(len(warnings), 1)
        self.assertIn("setup sql guard failed", warnings[0])

    def test_teardown_no_failure_returns_empty_warnings(self):
        warnings, _ = self._run({"sql": "SELECT status", "expect": "GONE"}, "GONE", warn_only=True)
        self.assertEqual(warnings, [])


class TestExecSetupStep(unittest.TestCase):
    """exec: runs a project command, captures stdout (whole or JSON-path) into vars.
    Generic escape hatch for request signing / token minting — runner stays generic."""

    def _ctx(self):
        return {"db": "d", "scripts_dir": ".", "base_url": "", "varstore": VarStore(), "tokens": {}, "doc": {}}

    def test_capture_whole_stdout(self):
        from checklist_lib import setup
        ctx = self._ctx()
        err = setup.run_steps([{"exec": "printf SIGVAL", "capture": {"SIG": "stdout"}}], ctx)
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("SIG"), "SIGVAL")

    def test_capture_json_path(self):
        from checklist_lib import setup
        ctx = self._ctx()
        err = setup.run_steps(
            [{"exec": "printf '{\"signature\":\"abc\",\"timestamp\":\"123\"}'",
              "capture": {"SIG": "$.signature", "TS": "$.timestamp"}}], ctx)
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("SIG"), "abc")
        self.assertEqual(ctx["varstore"].get("TS"), "123")


class TestHttpSetupExpectStatus(unittest.TestCase):
    """A setup http step that is MEANT to fail (wrong-OTP attempts that end in a 401)
    used to abort the whole test on any status >= 400, before the assertion was ever
    reached. `expect_status:` declares the intended status; undeclared keeps the old
    rule, and a declared step still fails on any other status (no swallow-everything)."""

    def _run(self, step, status):
        from checklist_lib import setup, http
        orig = http.do_request
        http.do_request = lambda m, u, h, b: (status, {"id": "x"}, "")
        try:
            ctx = {"db": "d", "scripts_dir": ".", "base_url": "http://x",
                   "varstore": VarStore(), "tokens": {}, "doc": {}}
            return setup.run_steps([step], ctx), ctx
        finally:
            http.do_request = orig

    def test_undeclared_keeps_legacy_failure_on_4xx(self):
        err, _ = self._run({"http": {"method": "POST", "path": "/login"}}, 401)
        self.assertIn("→ 401", err)

    def test_declared_status_passes(self):
        err, _ = self._run({"http": {"method": "POST", "path": "/login"}, "expect_status": 401}, 401)
        self.assertIsNone(err)

    def test_nested_form_and_list_pass(self):
        err, _ = self._run({"http": {"method": "POST", "path": "/login", "expect_status": [400, 401]}}, 400)
        self.assertIsNone(err)

    def test_declared_but_different_status_still_fails(self):
        for got in (200, 500):
            err, _ = self._run({"http": {"method": "POST", "path": "/login"}, "expect_status": 401}, got)
            self.assertIn("expect_status: 401", err)
            self.assertIn(f"→ {got}", err)

    def test_any_accepts_errors_but_not_a_missing_response(self):
        err, _ = self._run({"http": {"method": "POST", "path": "/login"}, "expect_status": "any"}, 503)
        self.assertIsNone(err)
        err, _ = self._run({"http": {"method": "POST", "path": "/login"}, "expect_status": "any"}, 0)
        self.assertIn("any HTTP response", err)

    def test_invalid_value_is_rejected(self):
        for bad in ("nope", 99, 700, True, []):
            err, _ = self._run({"http": {"method": "POST", "path": "/login"}, "expect_status": bad}, 401)
            self.assertIn("invalid expect_status", err, repr(bad))

    def test_capture_still_runs_on_an_expected_error(self):
        err, ctx = self._run({"http": {"method": "POST", "path": "/login", "capture": {"ID": "$.id"}},
                              "expect_status": 401}, 401)
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("ID"), "x")


class TestHttpSetupCaptureStep(unittest.TestCase):
    """http: setup steps document (and the shipped templates use) `capture:` NESTED
    inside the `http:` block — unlike `exec`/`sql`, whose payload is a bare string
    with no nested mapping to put it in. `_do_http` read `sb.get("capture")`
    (sibling-of-step, exec/sql's convention) instead of `h.get("capture")`
    (nested-in-http, the one templates/CHECKLIST.yaml and every real checklist
    actually write), so an http-setup capture always silently resolved to "" —
    no exception, just a var that was never set. A checklist chaining setup calls
    (register a platform, capture its id, PUT it, POST a key against it — see
    templates/CHECKLIST.yaml's own worked TC-style examples) failed every
    downstream step against an empty-string path segment instead."""

    def _ctx(self):
        return {"db": "d", "scripts_dir": ".", "base_url": "http://x",
                "varstore": VarStore(), "tokens": {}, "doc": {}}

    def test_http_setup_capture_populates_var(self):
        from checklist_lib import setup, http
        orig = http.do_request
        http.do_request = lambda m, u, h, b: (201, {"id": "plat-123"}, "")
        try:
            ctx = self._ctx()
            err = setup.run_steps(
                [{"http": {"method": "POST", "path": "/v1/platforms",
                           "capture": {"PLATFORM_ID": "$.id"}}}], ctx)
        finally:
            http.do_request = orig
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("PLATFORM_ID"), "plat-123")

    def test_sibling_capture_is_still_honoured(self):
        """The other half of the same bug. Narrowing the read to the nested form
        only silently zeroed every capture written against the sibling form —
        one dogfood project had 33 across 7 features, and one feature fell from a real
        21/21 to 3/22 without one of its own lines changing. `sql:`/`exec:` put
        `capture:` at step level, so authors reach for it on `http:` too. Both
        forms resolve; the failure mode of getting this wrong is an empty var
        that blows up several steps later, looking like an app bug."""
        from checklist_lib import setup, http
        orig = http.do_request
        http.do_request = lambda m, u, h, b: (201, {"id": "plat-sibling"}, "")
        try:
            ctx = self._ctx()
            err = setup.run_steps(
                [{"http": {"method": "POST", "path": "/v1/platforms"},
                  "capture": {"PLATFORM_ID": "$.id"}}], ctx)
        finally:
            http.do_request = orig
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("PLATFORM_ID"), "plat-sibling")

    def test_nested_capture_wins_when_a_step_carries_both(self):
        from checklist_lib import setup, http
        orig = http.do_request
        http.do_request = lambda m, u, h, b: (201, {"id": "nested", "other": "sibling"}, "")
        try:
            ctx = self._ctx()
            err = setup.run_steps(
                [{"http": {"method": "POST", "path": "/v1/platforms",
                           "capture": {"PLATFORM_ID": "$.id"}},
                  "capture": {"PLATFORM_ID": "$.other"}}], ctx)
        finally:
            http.do_request = orig
        self.assertIsNone(err)
        self.assertEqual(ctx["varstore"].get("PLATFORM_ID"), "nested")

    def test_captured_platform_id_chains_into_a_later_setup_step(self):
        """The real-world shape: step 1 captures an id, step 2's path uses it. Before
        the fix, step 2 always saw an empty PLATFORM_ID (this is exactly what
        produced a 404 against `/v1/platforms/` with no id segment in production)."""
        from checklist_lib import setup, http
        seen_urls = []
        orig = http.do_request

        def fake(method, url, headers, body):
            seen_urls.append(url)
            if len(seen_urls) == 1:
                return (201, {"id": "plat-456"}, "")
            return (200, {}, "")

        http.do_request = fake
        try:
            ctx = self._ctx()
            err = setup.run_steps([
                {"http": {"method": "POST", "path": "/v1/platforms",
                          "capture": {"PLATFORM_ID": "$.id"}}},
                {"http": {"method": "PUT", "path": "/v1/platforms/${PLATFORM_ID}"}},
            ], ctx)
        finally:
            http.do_request = orig
        self.assertIsNone(err)
        self.assertTrue(seen_urls[1].endswith("/v1/platforms/plat-456"),
                         f"second setup step used url {seen_urls[1]!r}, want it to end with the captured id")

    def test_nonzero_exit_is_an_error(self):
        from checklist_lib import setup
        err = setup.run_steps([{"exec": "exit 7"}], self._ctx())
        self.assertIsNotNone(err)
        self.assertIn("exec failed", err)

    def test_dry_run_skips(self):
        from checklist_lib import setup
        ctx = self._ctx()
        err = setup.run_steps([{"exec": "exit 7"}], ctx, dry_run=True)
        self.assertIsNone(err)  # not executed under dry-run


class TestRequestHeaders(unittest.TestCase):
    """A test's request.headers must reach the HTTP call, var-expanded — without this
    signed requests silently lose X-Client-Id / X-Timestamp / X-Signature."""

    def test_custom_headers_forwarded_and_expanded(self):
        from checklist_lib import runner, http
        captured = {}

        def fake(method, url, headers, body):
            captured["headers"] = dict(headers)
            return (200, {}, "")

        orig = http.do_request
        http.do_request = fake
        try:
            vs = VarStore()
            vs.set("SIG", "abc123")
            ctx = {"db": "d", "scripts_dir": ".", "base_url": "http://x",
                   "varstore": vs, "tokens": {}, "doc": {}}
            req = {"method": "GET", "path": "/p",
                   "headers": {"X-Signature": "${SIG}", "X-Client-Id": "m1"}}
            runner._send_request(req, ctx)
        finally:
            http.do_request = orig
        self.assertEqual(captured["headers"].get("X-Signature"), "abc123")
        self.assertEqual(captured["headers"].get("X-Client-Id"), "m1")


class TestNoTokenSentinel(unittest.TestCase):
    """`token: none` means "send no auth header" — the natural way to write a 401 /
    public-endpoint test. It used to be looked up as a token NAMED "none", miss, and
    fail the test with `unknown token 'none'` instead of issuing the anonymous request."""

    def _ctx(self, tokens):
        return {"db": "d", "scripts_dir": ".", "base_url": "http://x",
                "varstore": VarStore(), "tokens": tokens, "doc": {}}

    def _send(self, req, tokens):
        from checklist_lib import runner, http
        captured = {}

        def fake(method, url, headers, body):
            captured["headers"] = dict(headers)
            return (200, {}, "")

        orig = http.do_request
        http.do_request = fake
        try:
            result = runner._send_request(req, self._ctx(tokens))
        finally:
            http.do_request = orig
        return result, captured

    def test_token_none_sends_no_auth_header(self):
        toks = {"user_token": ("Authorization", "Bearer abc")}
        for spelling in ("none", "None", " none ", "no-auth", "anonymous"):
            with self.subTest(spelling=spelling):
                res, cap = self._send({"method": "GET", "path": "/p", "token": spelling}, toks)
                self.assertEqual(res[0], "http", f"{spelling!r} must issue the request, not error")
                self.assertEqual(cap["headers"], {}, f"{spelling!r} must send no auth header")

    def test_omitted_token_sends_no_auth_header(self):
        res, cap = self._send({"method": "GET", "path": "/p"}, {})
        self.assertEqual(res[0], "http")
        self.assertEqual(cap["headers"], {})

    def test_declared_token_named_none_still_wins(self):
        """Backward-compat: an explicitly declared token literally named "none"
        is still resolved — the sentinel only applies when nothing declares it."""
        toks = {"none": ("Authorization", "Bearer real")}
        res, cap = self._send({"method": "GET", "path": "/p", "token": "none"}, toks)
        self.assertEqual(res[0], "http")
        self.assertEqual(cap["headers"].get("Authorization"), "Bearer real")

    def test_genuine_typo_still_errors_and_lists_known_tokens(self):
        from checklist_lib import runner
        kind, _, msg, _ = runner._send_request(
            {"method": "GET", "path": "/p", "token": "usr_token"},
            self._ctx({"user_token": ("Authorization", "Bearer abc")}),
        )
        self.assertEqual(kind, "error")
        self.assertIn("usr_token", msg)
        self.assertIn("user_token", msg, "error must list the declared token names")
        self.assertIn("token: none", msg, "error must point at the no-auth spelling")


class TestBaseUrlRef(unittest.TestCase):
    """A test/setup can target a named alternate service via base_url_ref (multi-service).
    Without it every request hits the default base_url → cross-service tests 404."""

    def _ctx(self):
        return {"db": "d", "scripts_dir": ".", "base_url": "http://billing-svc:8092",
                "base_urls": {"auth_base_url": "http://auth-svc:8081"},
                "varstore": VarStore(), "tokens": {}, "doc": {}}

    def test_ref_selects_alternate_base(self):
        from checklist_lib import runner, http
        captured = {}

        def fake(method, url, headers, body):
            captured["url"] = url
            return (200, {}, "")

        orig = http.do_request
        http.do_request = fake
        try:
            runner._send_request({"method": "GET", "path": "/keys", "base_url_ref": "auth_base_url"}, self._ctx())
        finally:
            http.do_request = orig
        self.assertIn("auth-svc:8081", captured["url"])

    def test_default_base_when_no_ref(self):
        from checklist_lib import runner, http
        captured = {}
        orig = http.do_request
        http.do_request = lambda m, u, h, b: (captured.__setitem__("url", u) or (200, {}, ""))
        try:
            runner._send_request({"method": "GET", "path": "/p"}, self._ctx())
        finally:
            http.do_request = orig
        self.assertIn("billing-svc:8092", captured["url"])

    def test_unknown_ref_is_an_error(self):
        from checklist_lib import runner
        kind, _, msg, _ = runner._send_request({"method": "GET", "path": "/p", "base_url_ref": "nope"}, self._ctx())
        self.assertEqual(kind, "error")
        self.assertIn("base_url_ref", msg)


class TestConfigVars(unittest.TestCase):
    """config.vars: + `- vars:` setup step — checklist-declared variables."""

    def test_config_vars_loaded_before_base_url(self):
        import contextlib
        import io
        import tempfile
        from checklist_lib import runner
        doc = ("config:\n"
               "  vars:\n"
               "    SVC_PORT: '9099'\n"
               "    GREETING: hello-${SVC_PORT}\n"
               "  base_url: http://localhost:${SVC_PORT}\n"
               "suites: []\n")
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(doc)
            path = f.name
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = runner.main(["--checklist", path, "--scripts-dir", ".", "--dry-run"])
        os.unlink(path)
        self.assertEqual(rc, 0)
        self.assertIn("http://localhost:9099", out.getvalue())

    def test_config_vars_value_keeps_env_override_pattern(self):
        vs = VarStore()
        os.environ["CFGVAR_TEST_X"] = "from-env"
        try:
            vs.set("X", vs.expand("${CFGVAR_TEST_X:-from-config}"))
            self.assertEqual(vs.get("X"), "from-env")
        finally:
            del os.environ["CFGVAR_TEST_X"]

    def test_vars_setup_step_sets_and_expands(self):
        from checklist_lib import setup
        vs = VarStore()
        vs.set("BASE", "abc")
        ctx = {"varstore": vs, "db": "d", "scripts_dir": ".", "base_url": "", "tokens": {}, "doc": {}}
        err = setup.run_steps([{"vars": {"DERIVED": "${BASE}-123", "N": 7}}], ctx)
        self.assertIsNone(err)
        self.assertEqual(vs.get("DERIVED"), "abc-123")
        self.assertEqual(vs.get("N"), "7")

    def test_vars_setup_step_runs_on_dry_run(self):
        from checklist_lib import setup
        vs = VarStore()
        ctx = {"varstore": vs, "db": "d", "scripts_dir": ".", "base_url": "", "tokens": {}, "doc": {}}
        setup.run_steps([{"vars": {"K": "v"}}], ctx, dry_run=True)
        self.assertEqual(vs.get("K"), "v")


class TestHttpRequestBodyViaStdin(unittest.TestCase):
    """A large body (TC-015: an 11MB base64 attachment) passed as a `-d <body>` argv
    element blew ARG_MAX ("Argument list too long") — an OSError from subprocess
    itself, so the *runner* died rather than the one test failing. The body must
    travel through curl's stdin (`-d @-` + `input=`), never argv, regardless of
    size — so there is one code path, not a small/large-body branch to keep in
    sync."""

    def test_body_never_appears_in_argv(self):
        from checklist_lib import http
        captured = {}

        class FakeResult:
            stdout = "\n__HTTP_STATUS__=200"

        def fake_run(cmd, capture_output, text, input=None):
            captured["cmd"] = cmd
            captured["input"] = input
            return FakeResult()

        orig = __import__("subprocess").run
        import subprocess as sp
        sp.run = fake_run
        try:
            big_body = {"content": "x" * 200}
            http.do_request("POST", "http://x/v1/messages", {}, big_body)
        finally:
            sp.run = orig

        self.assertIn("@-", captured["cmd"])
        for arg in captured["cmd"]:
            self.assertNotIn("xxxxxxxxxx", arg, "body content leaked into argv instead of stdin")
        self.assertIn('"content"', captured["input"])

    def test_no_body_sends_no_stdin(self):
        from checklist_lib import http
        captured = {}

        class FakeResult:
            stdout = "\n__HTTP_STATUS__=204"

        def fake_run(cmd, capture_output, text, input=None):
            captured["input"] = input
            return FakeResult()

        import subprocess as sp
        orig = sp.run
        sp.run = fake_run
        try:
            http.do_request("GET", "http://x/healthz", {})
        finally:
            sp.run = orig
        self.assertIsNone(captured["input"])


class TestUnexecutableTest(unittest.TestCase):
    """A test the runner cannot execute must not be reported as passed.

    PASS is "no assertion reported an error", so a placeholder with nothing to
    send and nothing to assert used to pass without executing anything — which is
    how a feature reached `status: passed` with no evidence behind it.
    """

    def test_placeholder_with_nothing_to_run_is_unexecutable(self):
        for tags in (["live-e2e", "regression"], ["no-verify", "smoke"], []):
            with self.subTest(tags=tags):
                reason = runner._unexecutable_reason({"id": "TC-001", "tags": tags})
                self.assertIsNotNone(reason)
                self.assertIn("no request", reason)

    def test_carve_out_tag_is_named_in_the_reason(self):
        reason = runner._unexecutable_reason({"id": "TC-001", "tags": ["live-e2e"]})
        self.assertIn("live-e2e", reason)

    def test_request_block_makes_it_executable(self):
        self.assertIsNone(runner._unexecutable_reason(
            {"id": "TC-001", "request": {"method": "GET", "path": "/x"}}))

    def test_setup_exec_is_an_assertion(self):
        # run_steps aborts on the first failing step and the caller turns that into
        # a FAIL, so `exec: ... exit 1` asserts even with no expect block at all.
        self.assertIsNone(runner._unexecutable_reason(
            {"id": "TC-001", "setup": [{"exec": "test -f build/app.jar"}]}))
        self.assertIsNone(runner._unexecutable_reason(
            {"id": "TC-002", "setup": [{"sql": "SELECT 1"}]}))

    def test_inert_setup_step_is_not_an_assertion(self):
        reason = runner._unexecutable_reason({"id": "TC-001", "setup": [{"sleep": 2}]})
        self.assertIsNotNone(reason)

    def test_verify_block_makes_it_executable(self):
        self.assertIsNone(runner._unexecutable_reason(
            {"id": "TC-001", "verify": [{"sql": "SELECT status", "expect": "= DONE"}]}))

    def test_asserting_expect_keys_make_it_executable(self):
        for key, value in (("status", 200), ("body_contains", "ok"),
                           ("json_path", "$.id"), ("body", {"id": 1}),
                           ("body_not_contains", "secret"), ("poll", {"sql": "x"})):
            with self.subTest(key=key):
                self.assertIsNone(runner._unexecutable_reason(
                    {"id": "TC-001", "expect": {key: value}}))

    def test_decorative_expect_key_does_not_count(self):
        # `{n: 3}` produces no error in assert_expect, so it can never fail a test.
        reason = runner._unexecutable_reason({"id": "TC-001", "expect": {"n": 3}})
        self.assertIsNotNone(reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)
