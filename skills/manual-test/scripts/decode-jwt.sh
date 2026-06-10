#!/usr/bin/env bash
# decode-jwt.sh — print JWT payload as JSON
# Usage: scripts/decode-jwt.sh "$JWT"
# Handles macOS base64 padding silently.

set -u
JWT="${1:-}"
if [ -z "$JWT" ]; then
  echo "Usage: $0 <jwt-string>" >&2
  exit 1
fi

PAYLOAD=$(
  echo "$JWT" \
    | cut -d. -f2 \
    | awk '{n=length($0)%4; if(n>0) for(i=n;i<4;i++) $0=$0"="; print}' \
    | base64 -d 2>/dev/null
)

if [ -z "$PAYLOAD" ]; then
  echo "Failed to decode JWT payload" >&2
  exit 2
fi

if command -v python3 >/dev/null 2>&1; then
  echo "$PAYLOAD" | python3 -m json.tool
else
  echo "$PAYLOAD"
fi
