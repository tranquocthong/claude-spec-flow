# Coding standards (generic, all languages)

The baseline every spec-flow executor applies when writing code, in **any** language or
stack. Deliberately short — the agent already knows how to write clean code; this only
states the things it would otherwise get wrong or that are spec-flow-specific.

## 1. Language of code is ENGLISH — always (HARD RULE)

Every artifact that lives *inside the code* is written in **English**, regardless of
`config.language`: comments, identifiers, log/error messages, error codes, test names,
and commit messages.

`config.language` governs **only** human-facing prose — the SD / CONTEXT documents and
the agent's conversational replies. It does **not** reach the code. A non-English comment
in a source file is a defect — fix it.

## 2. Follow the project before any generic preference

Match the surrounding file's naming, formatting, structure, and idioms; reuse existing
helpers instead of inventing parallel ones; run the project's configured formatter/linter
if there is one. Where the codebase and a generic habit disagree, **the codebase wins.**

## 3. Stay in scope

Make the smallest change that satisfies the task's FR / SD section. Don't refactor
unrelated code or expand beyond the spec — that belongs in `/sf:change`, not here.
