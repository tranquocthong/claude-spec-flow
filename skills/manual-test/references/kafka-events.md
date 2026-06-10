# Kafka Event-Triggered Testing

For features that run via `@KafkaListener` / `KafkaReceiver` handlers (no HTTP endpoint), the test pattern shifts:

```
SEED → PRODUCE event → WAIT for consumer → VERIFY (DB + Redis + output topic + lag) → TEARDOWN
```

Pre-req: Kafka running on `localhost:9095` (see `references/ports.md`) and consumer is up.

## 1. Discovery — Topics, Consumer Group, Payload

### Find handlers

```bash
# Listeners + their topics
grep -rn "@KafkaListener\|KafkaReceiver" src/main/java | head -20
grep -rn "topics\s*=\|topicPattern" src/main/java | head -20
```

### Find consumer group ID

```bash
grep -E "group-id|groupId" src/main/resources/application.yml .env 2>/dev/null
# → spring.kafka.consumer.group-id: ${KAFKA_CONSUMER_GROUP_ID:my-service-cg}
```

### Find payload DTO

The `@KafkaListener` method signature (or `KafkaReceiver<K,V>` generic) names the deserialized type — inspect its fields (`@JsonProperty`, required vs optional) to build a valid payload.

```java
@KafkaListener(topics = "entity.events", groupId = "${...}")
public Mono<Void> onEntityEvent(EntityEvent event) { ... }
                                // ↑ build payload to match this DTO
```

### Confirm topic exists in broker

```bash
docker exec -it $(docker ps -qf name=kafka) \
  kafka-topics --bootstrap-server localhost:9092 --list | grep <topic>
```

## 2. Produce Test Event

Use the helper (wraps `kcat` if available, else falls back to `docker exec kafka-console-producer`):

```bash
# Payload from file
scripts/produce-event.sh <topic> <payload-file.json>

# Payload from stdin
echo '{"id":"TEST-001","status":"PENDING"}' | scripts/produce-event.sh <topic> -

# With headers (Summer propagates X-Userinfo via header `userinfo`)
scripts/produce-event.sh <topic> payload.json -H "userinfo=$BASE64_USERINFO"

# With a partition key (forces deterministic partition routing)
scripts/produce-event.sh <topic> payload.json -k "TEST-001"
```

### Manual fallback (no helper)

```bash
# kcat (preferred)
kcat -b localhost:9095 -t <topic> -P -k "TEST-001" -H "userinfo=$BASE64_USERINFO" < payload.json

# kafka-console-producer (bundled)
docker exec -i $(docker ps -qf name=kafka) kafka-console-producer \
  --bootstrap-server localhost:9092 --topic <topic> \
  --property "parse.key=true" --property "key.separator=:" \
  <<< "TEST-001:$(cat payload.json)"
```

## 3. Wait for Consumer

Consumer processing is async — don't verify immediately. Poll until expected state appears (more robust than fixed sleep):

```bash
sleep 2   # baseline for fast in-memory handlers
sleep 5   # if handler calls downstream services or Redis
```

Or poll explicitly:

```bash
for i in {1..10}; do
  STATUS=$(psql -t -c "SELECT status FROM entity WHERE ref_id='TEST-001'" | tr -d ' ')
  [ "$STATUS" = "PROCESSED" ] && break
  sleep 1
done
```

## 4. Verify Consumer Processed the Message

### a. DB / Redis state

Same patterns as HTTP — see `references/results.md`.

### b. Consumer group lag (confirm offset advanced)

```bash
docker exec -it $(docker ps -qf name=kafka) kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group <consumer-group> \
  --describe
# → LAG column should be 0 after processing
```

`LAG > 0` long after producing → consumer not running / stuck / topic name wrong.

### c. Output topic (if handler emits downstream event)

```bash
# Consume last N messages from output topic (non-blocking)
kcat -b localhost:9095 -t <output-topic> -C -o -5 -e

# Or via docker
docker exec -it $(docker ps -qf name=kafka) kafka-console-consumer \
  --bootstrap-server localhost:9092 --topic <output-topic> \
  --from-beginning --max-messages 5 --timeout-ms 5000
```

## 5. DLT / Poison-Pill Testing

Producer produces malformed JSON → consumer fails → message lands in DLT topic.

```bash
# 1. Find DLT topic (Summer Kafka default: <original>.DLT)
grep -rn "DEFAULT_LOG_AND_DLT\|DLT\|dead-letter" src/main/java src/main/resources | head

# 2. Produce malformed payload
echo 'not-json' | scripts/produce-event.sh <topic> -

# 3. Verify DLT received it
kcat -b localhost:9095 -t <topic>.DLT -C -o -5 -e
```

Check DLT headers for failure reason: `kafka_dlt-exception-message`, `kafka_dlt-original-topic`, `kafka_dlt-exception-stacktrace`.

```bash
kcat -b localhost:9095 -t <topic>.DLT -C -o -1 -e -f '%h\nPAYLOAD: %s\n'
```

## 6. Replay — Reset Offset

To re-process events (e.g. after fixing a bug, or to re-run a test without producing again):

```bash
# Reset to beginning of topic for this consumer group
# IMPORTANT: stop the app first — Kafka refuses offset reset while group is active
docker exec -it $(docker ps -qf name=kafka) kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group <consumer-group> --topic <topic> \
  --reset-offsets --to-earliest --execute

# Or to a specific offset
... --reset-offsets --to-offset 1234 --execute

# Or to a timestamp (ms since epoch)
... --reset-offsets --to-datetime 2026-05-20T00:00:00.000 --execute

# Then restart the app — consumer re-reads from new offset.
```

## 7. Auth Propagation Across Events

Summer Kafka relays identity via the `userinfo` message header (base64, same payload as X-Userinfo). Without it, audit fields (`createdBy`, `updatedBy`) are null → NPE on write paths.

```bash
USERINFO=$(echo -n '{"iat":1772680061,"exp":2088040061,"sub":"USER_ID","email":"u@example.com"}' | base64 | tr -d '\n')
scripts/produce-event.sh <topic> payload.json -H "userinfo=$USERINFO"
```

For BO handler events: include `email` + `resource_access` / `role_groups` (see `references/auth.md`).

## 8. Idempotency Testing

Produce the same message (same partition key) twice — handler should process once.

```bash
scripts/produce-event.sh <topic> payload.json -k "DUP-001"
sleep 3
scripts/produce-event.sh <topic> payload.json -k "DUP-001"

# Verify counter incremented by 1, not 2
psql -c "SELECT used_amount FROM usage_table WHERE entity_id='X'"
```

Mechanism varies: Redis dedup key, DB unique constraint, or in-memory `Set` (lost on restart).

## Common Gotchas

| Symptom | Likely cause |
|---------|--------------|
| Producer succeeds, consumer doesn't fire | Wrong topic name; consumer not started; consumer group already past the new offset |
| `LAG = 0` but no DB change | Listener exists but isn't subscribed to that topic; check `topics =` value |
| Always lands in DLT | Payload doesn't match DTO (missing required field, wrong type); inspect DLT exception header |
| Handler ran but `updatedBy` is null | `userinfo` header missing in produced message |
| Replay doesn't re-process | App is running — must stop app, reset offsets, restart |
| Duplicate processing on replay | Idempotency layer (Redis dedup) still has the key — flush before replay |

## When to Use the Internal Endpoint Instead

If the service exposes `/internal/api/v1/.../trigger` (synchronous handler invocation), prefer it. Use the Kafka path only when:

1. Verifying the **wire path** (serialization, header propagation, error → DLT routing).
2. The handler is **only** wired via `@KafkaListener` — no internal endpoint exists.
3. Testing **batch / partitioned ordering** behavior.
