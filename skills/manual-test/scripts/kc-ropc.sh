#!/usr/bin/env bash
# kc-ropc.sh — fetch Bearer JWT from local Keycloak via ROPC grant
# Usage: scripts/kc-ropc.sh <realm> <client-id> <username> <password> [client-secret] [keycloak-url]
# Prints the access_token to stdout. Errors go to stderr with exit code 1.

set -u
REALM="${1:-}"
CLIENT_ID="${2:-}"
USERNAME="${3:-}"
PASSWORD="${4:-}"
CLIENT_SECRET="${5:-}"
KC_URL="${6:-http://localhost:8180}"

if [ -z "$REALM" ] || [ -z "$CLIENT_ID" ] || [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  cat >&2 <<EOF
Usage: $0 <realm> <client-id> <username> <password> [client-secret] [keycloak-url]
  realm          e.g. myapp_backoffice_dev
  client-id      e.g. <client-id>
  client-secret  optional, required if client is confidential
  keycloak-url   defaults to http://localhost:8180
EOF
  exit 1
fi

DATA="grant_type=password&client_id=${CLIENT_ID}&username=${USERNAME}&password=${PASSWORD}"
if [ -n "$CLIENT_SECRET" ]; then
  DATA="${DATA}&client_secret=${CLIENT_SECRET}"
fi

RESPONSE=$(curl -sf -X POST \
  "${KC_URL}/realms/${REALM}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "$DATA" 2>&1)

if [ $? -ne 0 ]; then
  echo "Keycloak request failed:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

TOKEN=$(echo "$RESPONSE" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
if [ -z "$TOKEN" ]; then
  echo "No access_token in response:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

echo "$TOKEN"
