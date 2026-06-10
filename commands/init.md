---
description: One-time init that attaches spec-flow to a project — writes the committed .spec-flow/ profile (config.json, project-author.md) so spec-flow lives with the project lifecycle and evolves per project.
argument-hint: "[--name <project-name>] [--stack java-spring|node|python|go|dotnet] [--design-type auto|api|internal|hybrid] [--language en|vi|...]"
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
---

# /sf:init — attach spec-flow to this project (run once)

Input: `$ARGUMENTS` (all optional; spec-flow auto-detects project name from the working directory).

## Steps

1. **Ask how to track `.spec-flow/`** — use AskUserQuestion (popup), header "Track in git":
   - **Commit (default)** — `.spec-flow/` is tracked (profile + state); evolves with the repo, git log = spec-evolution history.
   - **Keep local** — init adds `.spec-flow/` to the project `.gitignore`; state stays on this machine only.

1b. **Ask the doc language** (skip if `--language` already in `$ARGUMENTS`) — use AskUserQuestion (popup), header "Doc language": *"What language should generated Solution Designs be written in?"*
   - **English (default)** → `--language en`
   - **Tiếng Việt** → `--language vi`
   - (Other) → pass the user's value as `--language <code>`

   This sets `config.language`, which the **sd-author** agent reads to author the SD/CONTEXT **prose** in that language. Note (tell the user): only narrative prose + table-cell content is localized; section headings, table column headers, IDs (`FR-`/`TC-`), and code identifiers stay canonical English so the engine can still parse the SD — and `/sf:*` command output stays English (short/technical). Editable later in `.spec-flow/config.json` → `language`.

2. **Bootstrap the project profile** (append `--no-commit-docs` ONLY if the user chose "Keep local"; append `--language <code>` from step 1b):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs init-project $ARGUMENTS [--no-commit-docs] [--language <code>]
   ```
   Creates (idempotent — existing files left untouched): `.spec-flow/config.json`, `.spec-flow/project-author.md`, and the `srs/`, `snapshots/`, `changes/`, `bugs/` dirs. With `--no-commit-docs` it also appends `.spec-flow/` to the project `.gitignore`.

   `srs/` is the recommended home for input docs — one live, editable file per feature, `.spec-flow/srs/<feature>.md` (a formal SRS *or* just your idea/description; it plays the SRS role). You edit this file; `srs-snapshot` freezes immutable baselines into `snapshots/` at each ingest/resync. `/sf:ingest` and `/sf:resync` still accept any path — `srs/` is convention, not enforced.

3. **Set up Task Master** (delegated to Task Master's own CLI — idempotent + **fail-isolated**)
   Task Master is the task engine `/sf:phase` drives via `parse_prd`. spec-flow does **not** own its
   config — it just calls Task Master's public commands. **This step must never abort `/sf:init`:** the
   `.spec-flow/` profile from step 2 has already succeeded. If any command below fails (no network for
   `npx`, no `claude` CLI, etc.), print the commands for the user to run later and **continue**.

   a. **Init** — skip if `.taskmaster/` already exists; otherwise scaffold via Task Master's own init:
      - Preferred: MCP tool `initialize_project` (projectRoot = cwd, `yes: true`).
      - Fallback: `npx -y -p task-master-ai@0.43.1 task-master init --yes` (the `task-master` CLI bin — NOT `npx task-master-ai`, which is the MCP server).

   b. **Default to the keyless `claude-code` provider** (uses the Claude Code CLI auth — **no API key**):
      ```
      npx -y -p task-master-ai@0.43.1 task-master models --set-main sonnet --claude-code
      npx -y -p task-master-ai@0.43.1 task-master models --set-fallback sonnet --claude-code
      npx -y -p task-master-ai@0.43.1 task-master models --set-research sonnet --claude-code
      ```
      **Use the `task-master` CLI binary** (via `-p <pkg> task-master`), NOT `npx task-master-ai …` — the
      `task-master-ai` bin is the MCP server and would just launch the server, silently ignoring `models`.
      Task Master writes its own `.taskmaster/config.json` — spec-flow does not touch it. Verify with
      `npx -y -p task-master-ai@0.43.1 task-master models` (all three roles should read `claude-code`).

4. **Report** `created` / `alreadyExisted` and the `commitPolicy` from tool output, plus Task Master status (initialised / already present / **deferred** with the manual commands if it failed).

5. **Next**:
   - Commit chosen → tell the user: `git add .spec-flow/ .taskmaster/ && git commit -m "chore: init spec-flow profile"`.
   - Keep local → note `.spec-flow/` was added to `.gitignore`; nothing to commit.
   - **Provider:** default is **`claude-code` — no API key required** (`parse_prd` / `analyze_complexity` run through your Claude Code session). Only if you prefer your own provider: add `ANTHROPIC_API_KEY` (and `PERPLEXITY_API_KEY` for research) to your environment or `.mcp.json` and switch with `npx -y -p task-master-ai@0.43.1 task-master models --set-main <model> --<provider>`.

6. **Explain the two-tier OVERLAY model**
   ```
   GLOBAL plugin (spec-flow installed in Claude Code)
     = engine (flow-tools.cjs) + default templates + base agent prompts
     = updated via /plugin update  →  shared across all projects

   PROJECT .spec-flow/  (committed by default; or kept local if you chose that)
     = config.json       project profile (stack, conventions, design type)
     = project-author.md SD-authoring overrides — where learnings accumulate
     = srs/<feature>.md (live inputs), trace.json, STATE.md, VERIFICATION.md, specs/<feature>/SD.md, snapshots/, bugs/, changes/
     = project-local overrides win; global plugin is fallback
   ```

7. **Offer a tiny `## spec-flow` pointer in `CLAUDE.md`** (opt-in)
   `CLAUDE.md` loads every turn, so keep it to the ONE load-bearing line. The **sd-author agent already reads** `project-author.md` + `config.json` itself — this pointer only covers the main agent editing an SD *directly* (in `/sf:change`/`/sf:resync`). Ask; if confirmed, add **exactly** (no more):
   ```markdown
   ## spec-flow
   Before editing/reviewing a Solution Design directly, read `.spec-flow/project-author.md` + `.spec-flow/config.json` (project SD overrides: ID prefixes, conventions, learned pitfalls). Evolve via `flow-tools.cjs learn`.
   ```
   Do NOT add the marketing blurb, repo link, or the full `learn` recipe — those live in the docs, not in every-turn context.

## Notes
- **Run once per project.** Existing `config.json` and `project-author.md` are never overwritten.
- **Evolve via `learn`:** add rules with `flow-tools.cjs learn`; commit the result.
- **Templates stay global** (project can override by adding `.spec-flow/templates/<name>`).
