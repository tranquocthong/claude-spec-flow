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


if __name__ == "__main__":
    unittest.main(verbosity=2)
