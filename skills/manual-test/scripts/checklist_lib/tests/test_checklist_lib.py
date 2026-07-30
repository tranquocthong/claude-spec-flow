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

from checklist_lib import assertions, jsonpath, sql  # noqa: E402
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
        self.assertTrue(sql._check_scalar("1", 1, self.vs)[0])
        self.assertFalse(sql._check_scalar("0", 1, self.vs)[0])

    def test_string_equality(self):
        self.assertTrue(sql._check_scalar("PENDING", "PENDING", self.vs)[0])
        self.assertFalse(sql._check_scalar("DONE", "PENDING", self.vs)[0])

    def test_operator_forms(self):
        self.assertTrue(sql._check_scalar("5", "> 3", self.vs)[0])
        self.assertFalse(sql._check_scalar("2", "> 3", self.vs)[0])
        self.assertTrue(sql._check_scalar("3", ">= 3", self.vs)[0])

    def test_timestamp_lexicographic_vs_test_start(self):
        later = "2099-01-01 00:00:00.000000+00"
        earlier = "2000-01-01 00:00:00.000000+00"
        self.assertTrue(sql._check_scalar(later, "> ${TEST_START}", self.vs)[0])
        self.assertFalse(sql._check_scalar(earlier, "> ${TEST_START}", self.vs)[0])

    def test_dict_and_none_are_descriptive(self):
        self.assertIsNone(sql._check_scalar("x", {"a": 1}, self.vs)[0])
        self.assertIsNone(sql._check_scalar("x", None, self.vs)[0])


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
