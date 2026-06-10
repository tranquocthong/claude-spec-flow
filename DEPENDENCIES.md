# spec-flow — Dependency Registry

> All dependencies are **pinned**. Updates are a deliberate, tested action — never automatic.
> This protects the flow from upstream breaking changes.

## Dependencies

| Name | Type | Pinned version | Why | Bump policy |
| --- | --- | --- | --- | --- |
| `task-master-ai` | Runtime MCP (pulled via `npx`) | `0.43.1` | Wired by `.mcp.json`; provides task management MCP tools (parse_prd, next_task, expand_task, …). | Bump deliberately: update the version in `.mcp.json`, re-run `/sf:doctor`, smoke test the full flow. **NEVER use floating `@latest`** — a bad Task Master release silently breaks the entire flow. |
| `manual-test` | Bundled (vendored in `skills/manual-test/`) | This plugin's version (no external fetch) | Shipped as part of the plugin; zero network dependency at runtime. | Update by re-vendoring intentionally: copy updated skill files, test, commit together with the plugin version bump. |
| `node` | Environment prerequisite | >= 18 (not lockable here) | `flow-tools.cjs` uses modern Node APIs (fs, path, child_process). Older versions are not tested. | Document only; enforced operationally. CI/dev machines should pin via `.nvmrc` or equivalent. |
| `npm / npx` | Environment prerequisite | Ships with node >= 18 | Required to pull `task-master-ai` via `.mcp.json`. | Comes with node; no separate pin needed. |

## Lock policy

Dependencies are **pinned**; updates are a deliberate, tested action, never automatic.

1. **Identify** the target version and its changelog.
2. **Update** the pin in the relevant file (`.mcp.json` for Task Master).
3. **Re-run** `/sf:doctor` — the `dep-lock` check confirms the new version is pinned.
4. **Smoke-test** the full flow end-to-end before committing.
5. **Commit** the pin change with a clear message (e.g. `chore: bump task-master-ai to 0.44.0`).

This ensures every team member and CI run uses the same verified toolchain.
