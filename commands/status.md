---
description: "Show current project status: feature, phase, tasks, trace, next step."
argument-hint: "[--feature <f>]"
allowed-tools: Bash
---

# /sf:status — project status

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs status-report $ARGUMENTS
```

Parse `{ ok, data }`. If `!ok`: report the error and stop.

Present a compact status block:

---

**`{data.project}`** [`{data.branch || 'detached HEAD'}`]

| Field | Value |
|---|---|
| Feature | `{data.feature}` (or `(none)` if null) |
| SD | If `data.sd`: `{data.sd.path}` with, if `data.trace` exists: `FR:{data.trace.fr} TC:{data.trace.tc} NFR:{data.trace.nfr} TODO:{data.sd.todos}` — else just TODO count. If null: `(none)` |
| SRS snapshot | `{data.latestSnapshot}` or `(none)` |
| Tasks | If `data.tasks`: `done:{data.tasks.done} wip:{data.tasks.inProgress} pending:{data.tasks.pending} review:{data.tasks.review} total:{data.tasks.total}` — else `(no tasks seeded)` |
| Ready now | If `data.ready`: list each task as `#{id} "{title}"` — else `(none)` |
| Verified | `passed` if `data.verified === true`; `not yet` if `false`; `(no run yet)` if null. If `data.verifiedGaps` is non-empty, append ` · {N} live gap(s)` |
| Open bugs/changes | `{data.bugsOpen}` bugs · `{data.changesOpen}` changes |

If `data.bugsOpenList` or `data.changesOpenList` is non-empty, list each open item under the table so the user sees *what* is open (not just a count):

**Open bugs** — for each in `data.bugsOpenList`: `- {id} — {desc}`
**Open changes** — for each in `data.changesOpenList`: `- {id} — {desc}`

If `data.verifiedGaps` is non-empty, list them so a verified-adhoc ship's un-verified-live items are visible (not forgotten at merge):
**Live gaps (not verified live)** — for each in `data.verifiedGaps`: `- {gap}`

(Omit a list when its array is empty.)

**Next:** {data.nextStep}

---

Notes:
- `data.trace` is null when `trace-build` has not been run yet (SD exists but no trace).
- `data.tasks` is null when no Task Master tasks have been seeded (`parse-prd` not run yet).
- `data.ready` is null when all pending tasks have unmet dependencies, or no pending tasks exist.
