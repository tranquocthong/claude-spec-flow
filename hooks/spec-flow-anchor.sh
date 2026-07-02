#!/usr/bin/env bash
# UserPromptSubmit hook — enforce the project's configured language on EVERY prompt,
# and re-anchor the spec-flow position ONLY when the user is actually invoking the flow.
#
# Why: in long conversations the flow's command docs get summarized out of context
# and the agent forgets where it is (and what language to speak). The language
# directive is session-wide (a user who set `language: vi` expects Vietnamese for
# every reply in the project, not just /sf:* turns) and is one short line, so it
# fires on every prompt. The STATE re-anchor is verbose, so it stays gated to
# flow-referencing prompts (no context pollution).
#
# Standalone: pure bash, no jq/node dependency. Always exits 0 (never blocks a prompt).

CONFIG_FILE=".spec-flow/config.json"
STATE_FILE=".spec-flow/STATE.md"
# not a spec-flow project at all → nothing to do
[ -f "$CONFIG_FILE" ] || [ -f "$STATE_FILE" ] || exit 0

input="$(cat)"   # UserPromptSubmit passes the prompt (JSON) on stdin

# (1) Language — make the SESSION speak the project's configured language, on every
# prompt. Only when set and not English (avoid noise on default-en projects). This is
# the conversation-level directive; the SD's own prose language is driven by the
# sd-author spawn (see ingest.md / resync.md), and the SD STRUCTURE stays English.
if [ -f "$CONFIG_FILE" ]; then
  language="$(grep -m1 '"language"[[:space:]]*:' "$CONFIG_FILE" 2>/dev/null \
    | sed -n 's/.*"language"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -n "$language" ] && [ "$language" != "en" ]; then
    echo "[spec-flow] Respond to the user in: ${language} (project config.language). Applies to conversational replies and authored docs (SD/CONTEXT prose). ALL code stays English (comments, identifiers, log/error messages, error codes, test names, commit messages); SD section headings, table column headers, and FR/TC/NFR IDs stay canonical English."
  fi
fi

# (2) Re-anchor position from STATE.md — only when the prompt clearly references the flow.
echo "$input" | grep -qiE '/sf:|spec-flow|sf flow|srs|solution design' || exit 0
if [ -f "$STATE_FILE" ]; then
  feature="$(grep -m1 '^- Feature:' "$STATE_FILE" 2>/dev/null | sed 's/^- //')"
  progress="$(grep -m1 '^- Progress:' "$STATE_FILE" 2>/dev/null | sed 's/^- //')"
  nextstep="$(awk '/^## Next Step/{f=1;next} f&&/^- /{sub(/^- /,"");print;exit}' "$STATE_FILE" 2>/dev/null)"
  echo "[spec-flow] re-anchor (from .spec-flow/STATE.md):"
  echo "  ${feature} · ${progress}"
  echo "  NEXT: ${nextstep}"
  echo "  Gates: SD-first · CHECKLIST before build · manual-test before done · regression before ship."
fi
exit 0
