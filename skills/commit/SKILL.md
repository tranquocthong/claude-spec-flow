---
name: commit
description: >
  spec-flow SHIP step: conventional-commit + push + surface the merge/pull-request link,
  VCS-agnostic (GitHub + GitLab), with a base-branch guard. Branch creation is owned by the
  lifecycle commands (/sf:ingest, /sf:bug, /sf:change) via the engine's branch-ensure; this skill
  commits on the current work branch and refuses to commit on the configured base branch.
  Invoke ONLY in spec-flow context — explicitly as /sf:commit, or from the /sf:phase ship step.
  Do NOT auto-trigger on a bare "commit"/"commit push" request — that is the user's own commit
  workflow, not this skill.
invoke: user
args: "[push] — empty = commit only; push = commit + push + surface MR/PR"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# commit — conventional commit + push (spec-flow)

Turn the staged diff into a clean conventional commit, push, and surface the MR/PR link.
This skill is **convention only** — no personal style, no stack assumptions. Branch policy
lives in `.spec-flow/config.json → branching` and is created by the lifecycle commands, not here.

## Modes

| Invocation | Behavior |
|------------|----------|
| `commit` | Commit staged changes on the current branch |
| `commit push` | Commit + push + surface MR/PR link |

## Process

### Step 1 — Gather context (run in parallel)

```bash
git status --short
git diff --cached --stat
git diff --stat
git log --oneline -5
git rev-parse --abbrev-ref HEAD
```

Collect: current branch, staged files (`git diff --cached --name-only`), unstaged/untracked
(informational), and the repo's recent commit style.

### Step 2 — Base-branch guard (spec-flow)

If `.spec-flow/config.json` exists, read its `branching` block (`mode`, `base`).

- If `branching.mode` is **not** `off` **and** the current branch **equals** `branching.base`
  (e.g. `main`): **STOP. Do not commit.** Tell the user:
  > You're on the base branch `<base>`. spec-flow creates the work branch at `/sf:ingest` (per SD),
  > `/sf:bug`, or `/sf:change` — run the relevant one first, then re-run commit. (Or set
  > `branching.mode: "off"` in `.spec-flow/config.json` to allow commits on `<base>`.)
- If `mode: off`, or there is no `.spec-flow/` (non-spec-flow repo), or already on a work
  branch → proceed normally.

Branch creation is the engine's job (`branch-ensure`, called by the lifecycle commands) — a single
source of truth for naming. This skill never runs `git checkout -b`.

### Step 3 — Scan staged changes

Work from the **staged set only**. **Never `git add`** — the user decides what enters the index.

1. Read `git diff --cached` to understand intent.
2. Nothing staged → stop (see Edge Cases).
3. If something staged looks unrelated, you MAY `git restore --staged <file>` to drop it (working-tree
   change stays intact). Never add new files.

### Step 4 — Detect type and scope (language-agnostic, from staged diff)

**Type** (first match wins):

| Type | When |
|------|------|
| `feat` | New files / new capability / new endpoint, command, or public function |
| `fix` | Corrects wrong behavior, error handling, or an incorrect value |
| `refactor` | Rename / move / restructure with no behavior change |
| `chore` | Build files, dependencies, config, generated artifacts, formatting |
| `docs` | Only docs / comments (`.md`, doc-comments) changed |
| `test` | Only test files changed (any `*test*` / `*spec*` path the repo uses) |

**Scope**: the primary module/feature affected, derived from the common directory or filename
of the staged files (e.g. `auth`, `bug`, `snapshot`, `init`). Omit scope if changes span many
unrelated areas.

### Step 5 — Commit (staged only)

```
{type}({scope}): {subject}

{body — only when multiple distinct changes or non-obvious}
```

Rules: `subject` imperative, ≤72 chars, no trailing period; `body` bullets only when needed;
match the repo's existing style from Step 1. Plain text only — no emoji.

```bash
git commit -m "$(cat <<'EOF'
{type}({scope}): {subject}

{optional body}
EOF
)"
```

### Step 6 — Push + surface MR/PR (`push` mode)

```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
```

(`-u` on first push sets upstream; later pushes can be plain `git push`.) Then surface the review link,
VCS-agnostic:
- **GitLab**: the push output prints a `remote: ... merge_requests/new?...` URL — report it.
- **GitHub**: report the compare URL from the push output, or run `gh pr create` if the user wants the
  PR opened. (Ask before running `gh` if approval is required in this environment.)

### Step 7 — Report

```
Branch: {current-branch}
Commit: {short-hash} — {subject}
Files:  {count} changed
```

Add `Push: origin/{branch}` and the MR/PR link when pushed. **Always list unstaged/untracked files**
left out, so the user knows what wasn't committed.

## Edge Cases

- **Nothing staged** → stop: "No staged changes. `git add <files>` then re-run." List unstaged/untracked. Do NOT auto-stage.
- **On base branch with `mode != off`** → refuse (Step 2). Point to lifecycle commands.
- **Unstaged files alongside staged** → commit only staged; list the rest in the report.
- **Amend** → only if the user explicitly asks, and never amend an already-pushed commit.
