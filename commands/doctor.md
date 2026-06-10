---
description: "Health check: env, install, project, SD/trace consistency"
argument-hint: "[--sd <SD.md>] [--feature <f>]"
allowed-tools: Read, Bash
---

# /sf:doctor — health check

Utility command — the single health surface for spec-flow, replaces `verify-install.sh`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs doctor $ARGUMENTS
```

## Present results

Parse `{ ok, data: { checks, summary } }`. Group by status:

**Failures (`fail`) — must fix**
- **`{name}`** — {detail} / Fix: `{fix}`

**Warnings (`warn`) — review**
- **`{name}`** — {detail} / Fix: `{fix}`

**OK (`ok`)**
- **`{name}`** — {detail}

## Verdict (one line)
- `summary.fail > 0`: **FAIL — {fail} issue(s) need fixing before spec-flow works correctly.**
- `summary.warn > 0`: **WARN — {warn} advisory item(s); spec-flow is usable but review the warnings.**
- else: **OK — all {ok} checks passed. spec-flow is healthy.**

## Notes
- `doctor` always reports, even when problems are found.
- Zero-install: `node /path/to/spec-flow/bin/flow-tools.cjs doctor [--sd <SD.md>]`
- `--sd`: also counts `TODO:MANUAL-REVIEW` markers in the SD (SD gate check).
- `--feature`: reserved for future feature-scoped checks; currently unused.
