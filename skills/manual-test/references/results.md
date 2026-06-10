# Verification, Output, Pre-Test Checklist

## Post-Test Verification

After each test, verify the expected state change actually happened — don't trust the response alone. Use `db-query.sh` (auto-discovers creds from `.env` + `application.yml`).

```bash
# Entity state
scripts/db-query.sh "SELECT id, status, updated_at FROM <entity_table> WHERE <ref_col> = '<test_ref>'"

# Counter / usage side effects
scripts/db-query.sh "SELECT category, period_key, used_amount FROM <usage_table> WHERE entity_id = '<id>'"

# Redis cache state (creds also auto-discovered)
eval $(scripts/db-creds.sh)
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ${REDIS_PASS:+-a "$REDIS_PASS"} KEYS "*<entity_id>*"
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ${REDIS_PASS:+-a "$REDIS_PASS"} GET  "<cache_key>"
```

For async/callback flows — verify both the primary entity AND its side effects (counters, events, linked records):

```bash
# After a FAILED callback: counters/usage should be rolled back to pre-test values
scripts/db-query.sh -t \
  "SELECT used_amount FROM <usage_table> WHERE entity_id='<id>' AND period_key=CURRENT_DATE::text"
# → should equal the seeded value, not seeded + transaction amount
```

## Auto-Discover Test Entities

```bash
# Main entity table — table name from Flyway migrations or application.yml
scripts/db-query.sh "SELECT * FROM <main_table> WHERE status='ACTIVE' LIMIT 2"

# Config / rule tables
scripts/db-query.sh -t "SELECT id, code, version FROM <config_table> LIMIT 10"

# Cross-database inspection (e.g. looking up a row in another service's DB)
scripts/db-query.sh -d app_db "SELECT account_no FROM account WHERE owner='<id>'"
```

## Output Format

Record results in markdown table format:

```markdown
## Phase N: Feature Name — X/Y PASS

| # | Test | Expected | Result |
|---|------|----------|--------|
| 1 | Description | Expected response | PASS/FAIL |

**Bugs found:** description + fix
**Notes:** special setup or caveats
```

## Pre-Test Checklist

Before running any manual test:

### Infrastructure & discovery

1. [ ] Docker containers running (PostgreSQL + Redis + Keycloak if BO testing)
2. [ ] `stub-services` running on 88xx ports (only if endpoints call external services)
3. [ ] **Ask user if app is running** — never auto-start
4. [ ] Correct port identified from `application.yml` `server.port`
5. [ ] `.env` service URLs verified against port map (`grep _URL .env`, see `references/ports.md`)
6. [ ] Endpoint paths confirmed via controller grep — class `@RequestMapping` + method mapping
7. [ ] **Auth quick-probe done** — Path A vs Path B decided BEFORE building tokens
8. [ ] Tokens generated with `tr -d '\n'` (macOS base64 wraps silently → 401)
9. [ ] Path B: Keycloak realm/client identified from `application.yml`; BO user exists (`<your-keycloak-seed-script>`)

### Rigor — MUST (see `references/test-rigor.md`)

10. [ ] Each test reaches its precondition via the real entry point (user journey, not shortcut INSERT). When shortcutting, ambient writes mirrored + commented (MUST-1)
11. [ ] Every mutating test has a `verify` block asserting a side-effect / delta — not just HTTP status (MUST-2, MUST-3)
12. [ ] `${TEST_CORRELATION_ID}` used everywhere, not stable `TEST-001` (MUST-4)
13. [ ] Async assertions use `poll until` with `updated_at > ${TEST_START}` filter (MUST-5)
14. [ ] Required seed data inserted; previous test data cleaned up

### Rigor — SHOULD (apply for regression / depth)

15. [ ] Seed shape realistic: unicode, nulls, time spread, every enum value, volume that spans ≥ 2 pages (SHOULD-1)
16. [ ] No pre-set derived/computed fields — app computes them (SHOULD-2)
17. [ ] Out-of-scope rows seeded (soft-deleted, other tenant, other status) to test isolation filters (SHOULD-3)
18. [ ] Negative-control sibling exists for happy-path tests (SHOULD-4)

### Post-run gate (before marking suite PASS — SHOULD-5)

19. [ ] Sanity-fail probe done (broke one seed → that test failed as expected)
20. [ ] Suite re-run twice → identical results
21. [ ] App logs tailed → expected log lines appeared (code path actually exercised)
