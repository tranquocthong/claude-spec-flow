"""Variable store + ${VAR} expansion for the checklist runner.

Layered resolution: captured/generated vars > os.environ > inline `${VAR:-default}`.
Generates a stable per-run ${TEST_CORRELATION_ID} and a per-test ${TEST_START}
(UTC ISO-8601, refreshed via new_test_start()).
"""
import os
import re
import uuid
from datetime import datetime, timezone

# Matches ${VAR} and ${VAR:-default}. Python's expandvars doesn't handle ':-'.
_BASH_VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}", re.IGNORECASE)


class VarStore:
    def __init__(self):
        self.vars = {}
        # Stable per-run correlation id (honor a caller-set env override).
        self.vars["TEST_CORRELATION_ID"] = (
            os.environ.get("TEST_CORRELATION_ID") or f"TEST-{uuid.uuid4().hex[:12]}"
        )
        self.new_test_start()

    def new_test_start(self):
        """Refresh ${TEST_START} to now() in UTC. Call at the start of each test.

        Format matches Postgres `now()::text` (`YYYY-MM-DD HH:MM:SS.ffffff+00`)
        so lexicographic `updated_at > ${TEST_START}` SQL comparisons hold.
        """
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00")
        self.vars["TEST_START"] = ts
        return ts

    def set(self, name, value):
        self.vars[name] = "" if value is None else str(value)

    def get(self, name):
        if name in self.vars:
            return self.vars[name]
        return os.environ.get(name)

    def expand(self, s):
        if not isinstance(s, str):
            return s

        def repl(m):
            name, default = m.group(1), m.group(2)
            val = self.get(name)
            if val:
                return val
            return default if default is not None else ""

        return _BASH_VAR_RE.sub(repl, s)

    def expand_obj(self, obj):
        """Deep-expand strings inside a dict/list/str structure."""
        if isinstance(obj, str):
            return self.expand(obj)
        if isinstance(obj, dict):
            return {k: self.expand_obj(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self.expand_obj(v) for v in obj]
        return obj
