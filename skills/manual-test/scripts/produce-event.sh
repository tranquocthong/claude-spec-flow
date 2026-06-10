#!/usr/bin/env bash
# produce-event.sh — produce a Kafka event for manual testing.
# Usage: produce-event.sh <topic> <payload-file|-> [-k KEY] [-H name=value ...] [-b BROKER]
#   <topic>         Kafka topic name
#   <payload-file>  path to JSON file, or "-" to read from stdin
#   -k KEY          partition key (optional)
#   -H name=value   message header, repeatable (optional)
#   -b BROKER       broker address, default localhost:9095
#
# Prefers `kcat`; falls back to `kafka-console-producer` inside the kafka docker container.

set -u
TOPIC="${1:-}"
PAYLOAD_ARG="${2:-}"
shift 2 2>/dev/null || true

if [ -z "$TOPIC" ] || [ -z "$PAYLOAD_ARG" ]; then
  cat >&2 <<EOF
Usage: $0 <topic> <payload-file|-> [-k KEY] [-H name=value ...] [-b BROKER]
EOF
  exit 1
fi

KEY=""
BROKER="localhost:9095"
HEADERS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -k) KEY="$2"; shift 2 ;;
    -H) HEADERS+=("$2"); shift 2 ;;
    -b) BROKER="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Resolve payload to a temp file (so we can re-read it for both backends)
TMP_PAYLOAD=$(mktemp)
trap 'rm -f "$TMP_PAYLOAD"' EXIT
if [ "$PAYLOAD_ARG" = "-" ]; then
  cat > "$TMP_PAYLOAD"
elif [ -f "$PAYLOAD_ARG" ]; then
  cp "$PAYLOAD_ARG" "$TMP_PAYLOAD"
else
  echo "Payload file not found: $PAYLOAD_ARG" >&2
  exit 1
fi

# Prefer kcat
if command -v kcat >/dev/null 2>&1; then
  CMD=(kcat -b "$BROKER" -t "$TOPIC" -P)
  [ -n "$KEY" ] && CMD+=(-k "$KEY")
  for h in "${HEADERS[@]+"${HEADERS[@]}"}"; do
    CMD+=(-H "$h")
  done
  "${CMD[@]}" < "$TMP_PAYLOAD"
  echo "Produced to $TOPIC via kcat (broker=$BROKER, key=${KEY:-none}, headers=${#HEADERS[@]})" >&2
  exit 0
fi

# Fallback: docker exec kafka-console-producer
KAFKA_CID=$(docker ps -qf name=kafka | head -1)
if [ -z "$KAFKA_CID" ]; then
  echo "kcat not installed AND no kafka docker container running." >&2
  echo "Install kcat (brew install kcat) or start the kafka container." >&2
  exit 2
fi

if [ ${#HEADERS[@]} -gt 0 ]; then
  echo "WARNING: kafka-console-producer doesn't support custom headers via CLI." >&2
  echo "         Headers will be DROPPED. Install kcat for full header support." >&2
fi

# kafka-console-producer reads stdin; for key, use parse.key=true + separator
if [ -n "$KEY" ]; then
  printf '%s:%s\n' "$KEY" "$(cat "$TMP_PAYLOAD")" \
    | docker exec -i "$KAFKA_CID" kafka-console-producer \
        --bootstrap-server localhost:9092 --topic "$TOPIC" \
        --property "parse.key=true" --property "key.separator=:"
else
  docker exec -i "$KAFKA_CID" kafka-console-producer \
    --bootstrap-server localhost:9092 --topic "$TOPIC" \
    < "$TMP_PAYLOAD"
fi
echo "Produced to $TOPIC via docker exec kafka-console-producer (key=${KEY:-none})" >&2
