# Testing Patterns

Pick the pattern that fits the behavior being verified. Most tests are a combination.

## Pattern 1 — Boundary / Edge Case

Test values at, just below, and just above thresholds:

```bash
curl -s ... -d '{"amount": <limit_minus_1>}'   # just under  → pass
curl -s ... -d '{"amount": <limit>}'           # at limit    → pass or fail (business rule)
curl -s ... -d '{"amount": <limit_plus_1>}'    # over limit  → fail
curl -s ... -d '{"amount": 0}'                 # below min   → 400 validation
```

## Pattern 2 — Isolation

Verify that different categories/entities don't interfere with each other.

```bash
# Seed category A near its limit
# Test operation on category B → should be unaffected
# Test operation on category A → should hit limit
```

## Pattern 3 — Callback / Webhook

Test async status transitions via internal endpoints.

```bash
# 1. Seed entity in PENDING state
# 2. Send callback
curl -s -X POST http://localhost:PORT/internal/api/v1/.../callback \
  -H "Content-Type: application/json" \
  -d '{"id":"TEST-REF-001","status":"FAILED"}'

# 3. Verify: entity status changed + any side effects rolled back
```

## Pattern 4 — Config Change (pg_notify + In-Memory Cache)

Config changes propagate via PostgreSQL `LISTEN/NOTIFY` → in-memory cache refresh.

```bash
# Option A — API update (DB trigger fires pg_notify automatically)
curl -s -X PUT .../bo/api/v1/.../config/ID \
  -H "X-Userinfo: $BO_TOKEN" \
  -d '{"value":NEW_VALUE,"version":CURRENT_VERSION}'
sleep 2

# Option B — Direct SQL (DB trigger fires automatically)
psql -c "UPDATE config_table SET status='INACTIVE' WHERE code='SOME_CONFIG'"
sleep 2

# Option C — Manual pg_notify (when trigger can't fire, e.g. table renamed)
psql -c "SELECT pg_notify('<channel_name>', '<table_name>')"
```

Full pg_notify mechanics + channel discovery: `references/seeding.md`.

## Pattern 5 — Fail-Safe

Simulate infrastructure failure to verify the app degrades gracefully.

```sql
-- 1. Rename config table to simulate DB unavailability
ALTER TABLE config_table RENAME TO config_table_backup;

-- 2. Manually evict in-memory cache (trigger can't fire — table is gone)
SELECT pg_notify('<channel_name>', 'config_table');

-- 3. Test → verify app returns fail-safe response (reject / default behavior)

-- 4. Restore
ALTER TABLE config_table_backup RENAME TO config_table;
SELECT pg_notify('<channel_name>', 'config_table');
```

## Pattern 6 — State Restoration

Every mutation in `setup` must be reversed in `teardown`. Full template + anti-patterns: `references/seeding.md` → State Restoration.
