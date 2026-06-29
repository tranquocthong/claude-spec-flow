---
description: "Save mid-task state to disk so a fresh agent can resume exactly where you left off."
argument-hint: "[<feature>]"
allowed-tools: Bash, Read
---

# /sf:checkpoint — save in-progress state

Writes `.spec-flow/specs/<feature>/checkpoint.md` (single overwritable file — not a log). Call this when:
- **Context is running low** and you're mid-task (implementation, testing, checklist fill)
- **Stopping voluntarily** before a task is finished
- **Agent auto-triggers** when it notices context depth is high

The checkpoint file is the first thing the next agent reads when it sees a `wip` task.

## Steps

1. Identify the active feature and current `wip` task:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs status-report
   ```

2. Assess current state:
   - What phase are you in? (`RED` / `GREEN` / `REFACTOR` / `CHECKLIST` / `VERIFY`)
   - What files have been written/modified this session? (`git diff --name-only`)
   - What is the exact next action needed?
   - Any non-obvious decisions made (approach chosen, pattern followed)?

3. Write the checkpoint:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs checkpoint-write \
     --feature <feature> \
     --task "<id> — <title>" \
     --phase <RED|GREEN|REFACTOR|CHECKLIST|VERIFY> \
     --done "<file1>, <file2>" \
     --next "<exact next action>" \
     --decision "<key decisions made>"
   ```

4. Confirm to the user: "Checkpoint saved — next session run `/sf:status` to resume."

## Resume (next session)

`/sf:status` surfaces the checkpoint automatically when a `wip` task exists. The next agent:
1. Reads `.spec-flow/specs/<feature>/checkpoint.md`
2. Continues from the `## Next` section
3. Clears checkpoint when the task reaches `done`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs checkpoint-clear --feature <feature>
   ```

## Auto-trigger rule (for agents)

When you are mid-task and notice any of:
- Many consecutive tool calls in this session
- You are about to stop without finishing the task
- The user explicitly runs `/sf:checkpoint`

→ Run this command before stopping. Do not wait for the user to ask.
