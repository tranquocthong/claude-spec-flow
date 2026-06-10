#!/usr/bin/env python3
"""Checklist test runner entry point — invoked by run-checklist.sh.

The implementation lives in the `checklist_lib/` package (one module per concern:
vars, jsonpath, auth, http, sql, kafka, assertions, setup, runner). This shim only
makes the package importable and delegates to runner.main().

Refuses to bypass — the only way to add a test is to add a YAML block.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from checklist_lib.runner import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
