#!/usr/bin/env bash
# UserPromptSubmit hook — re-anchor the spec-flow position, but ONLY when the user
# is actually invoking the flow. Silent on every other prompt (no context pollution).
#
# Why: in long conversations the flow's command docs get summarized out of context
# and the agent forgets where it is. This re-injects the position + next step from
# .spec-flow/STATE.md exactly when the user touches the flow — and nothing otherwise.
#
# Standalone: pure bash, no jq/node dependency. Always exits 0 (never blocks a prompt).

STATE_FILE=".spec-flow/STATE.md"
[ -f "$STATE_FILE" ] || exit 0   # not a spec-flow project → nothing to anchor

input="$(cat)"   # UserPromptSubmit passes the prompt (JSON) on stdin

# Fire only when the prompt clearly references the spec-flow flow.
if echo "$input" | grep -qiE '/sf:|spec-flow|sf flow|srs|solution design'; then
  feature="$(grep -m1 '^- Feature:' "$STATE_FILE" 2>/dev/null | sed 's/^- //')"
  progress="$(grep -m1 '^- Progress:' "$STATE_FILE" 2>/dev/null | sed 's/^- //')"
  nextstep="$(awk '/^## Next Step/{f=1;next} f&&/^- /{sub(/^- /,"");print;exit}' "$STATE_FILE" 2>/dev/null)"
  echo "[spec-flow] re-anchor (from .spec-flow/STATE.md):"
  echo "  ${feature} · ${progress}"
  echo "  NEXT: ${nextstep}"
  echo "  Gates: SD-first · CHECKLIST before build · manual-test before done · regression before ship."
fi
exit 0
