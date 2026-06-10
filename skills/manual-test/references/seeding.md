# Seeding, Caching, State Restoration

## Connection

Use `scripts/db-query.sh` — it auto-discovers PG creds from `.env` + `application.yml` (resolution order: `SPRING_R2DBC_*` → `SPRING_DATASOURCE_*` → `SPRING_FLYWAY_*` → defaults).

```bash
# 1-shot query (most common)
scripts/db-query.sh "SELECT 1"

# Multi-statement / large seed via file
scripts/db-query.sh -f path/to/seed.sql

# Tuples-only (no headers, for scripted parsing)
scripts/db-query.sh -t "SELECT id FROM entity LIMIT 1"

# Override DB name (e.g. cross-DB inspection)
scripts/db-query.sh -d app_db "SELECT * FROM account LIMIT 1"
```

Inspect discovered creds (password masked):

```bash
scripts/db-creds.sh --print
```

If you need raw `psql` (e.g. interactive `\d`, `\dt`):

```bash
eval $(scripts/db-creds.sh)
PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB"
```

> Hardcoding `PGPASSWORD=postgres` + `-U postgres` works in default dev compose but fails in any project that uses per-service DB roles (e.g. `app_user` for `app_db`). Always go through `db-query.sh` / `db-creds.sh`.

## DB Seeding — Seed → Test → Cleanup

```bash
# Idempotent seed
scripts/db-query.sh "
INSERT INTO table (...) VALUES (...)
ON CONFLICT (unique_key) DO UPDATE SET column = value;"

# Dynamic date keys (time-based partitions)
# TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')   -- daily:   '2026-03-23'
# TO_CHAR(CURRENT_DATE, 'YYYY-MM')      -- monthly: '2026-03'

# Always cleanup after tests
scripts/db-query.sh "DELETE FROM table WHERE <identifier> LIKE 'TEST_%';"
```

## Common Seed Patterns

### Accumulation / counter — seed near a threshold boundary

```sql
INSERT INTO usage_table (entity_id, category, period_key, used_amount, ...)
VALUES ('ENTITY', 'CATEGORY', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), <near_limit_value>, ...)
ON CONFLICT (...) DO UPDATE SET used_amount = <near_limit_value>;
```

### Status-driven — seed entity in specific state for callback/transition tests

```sql
INSERT INTO entity_table (id, ref_id, status, ...)
VALUES (gen_random_uuid(), 'TEST-REF-001', 'PENDING', ...);
```

### FK dependency — seed parent before child

```sql
INSERT INTO parent_table (...) VALUES (...) ON CONFLICT DO NOTHING;
INSERT INTO child_table (...)  VALUES (...) ON CONFLICT DO NOTHING;
```

## Redis Cache Manipulation

```bash
# Flush all cache (force app to reload from DB)
redis-cli FLUSHDB

# Delete specific keys
redis-cli DEL "cache:key:name"

# Inspect
redis-cli KEYS "*pattern*"
redis-cli GET  "cache:key:name"
```

**When to flush Redis:**

- After updating data cached in Redis (rate limits, entity cache).
- **NOT for in-memory config cache** — those use pg_notify or app restart, not Redis flush.

## In-Memory Config Cache (pg_notify)

Config tables use PostgreSQL `LISTEN/NOTIFY` to push invalidation to an in-memory cache. **Redis FLUSHDB does NOT evict in-memory config cache. Only pg_notify does.**

```bash
# Option A — Update via API (DB trigger fires pg_notify automatically)
curl -s -X PUT .../bo/api/v1/.../config/ID \
  -H "X-Userinfo: $BO_TOKEN" \
  -d '{"value":NEW_VALUE,"version":CURRENT_VERSION}'
sleep 2  # wait for pg_notify → cache refresh

# Option B — Direct SQL UPDATE (DB trigger fires automatically)
psql -c "UPDATE config_table SET status = 'INACTIVE' WHERE code = 'SOME_CONFIG'"
sleep 2

# Option C — Manual pg_notify (when DB trigger can't fire, e.g. table renamed)
# Find channel name from trigger definition first.
psql -c "SELECT pg_notify('<channel_name>', '<table_name>')"
```

Common mistake: guessing the channel name. Check the actual trigger definition.

---

## State Restoration — Leave Env As You Found It

**Core rule:** every mutation in `setup` MUST be reversed in `teardown` — even if the test fails midway.

### Why this matters

- Next test runs against polluted config → cascading false-positives/negatives.
- Shared env (local DB, Redis) — other developers or test suites see corrupted state.
- CI re-runs → flaky behavior depending on previous test order.

### Minimum contract

| Setup action | Required teardown action |
|--------------|--------------------------|
| `UPDATE config SET status='INACTIVE'` | `UPDATE config SET status='ACTIVE'` |
| `UPDATE config SET value=X` | `UPDATE config SET value=<original>` |
| `ALTER TABLE x RENAME TO x_backup` | `ALTER TABLE x_backup RENAME TO x` |
| `SET feature_flag=false` | `SET feature_flag=<original>` |
| `redis SET key value` (non-TTL) | `redis DEL key` |
| `INSERT` seed with stable ID | `DELETE WHERE id=<seed_id>` |

**Config tables with `version` column:** increment version on every UPDATE (both disable AND restore) — optimistic locking relies on it. Always `pg_notify` after, to refresh the in-memory cache.

### Template

```yaml
setup:
  - sql: "<mutate config/state — e.g. disable interfering rule>"
  - sql: "SELECT pg_notify('<channel>', '<table>')"  # if cache-backed
  - wait: 5s                                          # if cache refresh is async

request:
  # test execution

expect:
  # assertions

verify:
  # post-action DB check — confirm expected side effects

teardown:
  # MUST undo every setup mutation, in reverse order
  - sql: "<restore config/state to original>"
  - sql: "SELECT pg_notify('<channel>', '<table>')"
```

### Anti-patterns

- ❌ Skip teardown because "the next test will clean up" — assumes test order, breaks isolation
- ❌ Teardown only on success — flaky failures leave env polluted
- ❌ Restore without `pg_notify` — cache keeps stale disabled state
- ❌ Restore without version increment — optimistic lock rejects future updates
- ❌ Non-idempotent teardown — re-running test corrupts data
