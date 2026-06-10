# Test Rigor — Avoiding False Positives & Seed/Reality Drift

Two silent failure modes in manual testing:

- **False positive** — test PASSES but didn't really verify anything (HTTP 200 with no side-effect check, generic substring match, async timing luck)
- **Seed/reality drift** — test passes against clean synthetic data, breaks in production where data has unicode, nulls, volume, derived fields, audit triggers

Apply MUST rules to every test. Apply SHOULD rules for regression / feature-completeness depth.

---

## 5 MUST rules — every test, no exceptions

### MUST-1. User journey first — reproduce preconditions through real entry points

Direct `INSERT` of an end state hides bugs in transitions, listeners, audit emit, outbox emit, derived columns. Reach the precondition the way a real user would.

| "Chống chế" shortcut | Natural flow |
|---|---|
| `INSERT INTO orders ... status='PAID'` then test refund | `POST /orders` → pay → THEN refund |
| `INSERT INTO audit_log` to test audit search | Perform the audited action; let the real listener write the row |
| Pre-fill Redis cache then test "cache hit" | Hit endpoint twice; assert 2nd is cached |
| Direct-set `status='APPROVED'` then test "view approved" | Submit → review → approve via real endpoints |

**You may shortcut when:** the precondition belongs to another bounded context tested separately, OR the entry point doesn't exist locally (external system).

**When you shortcut, you MUST** mirror every ambient write the real flow would have made (`audit_log`, `outbox_events`, `version`, `updated_by`, denormalized columns) and document why in a SQL comment.

### MUST-2. HTTP status is necessary, not sufficient

Status alone is never a PASS. Every mutating test needs a `verify` block asserting a side-effect:

- Mutated row state + `updated_at` advanced
- New `audit_log` row for this correlation ID
- New `outbox_events` row, or Kafka output topic message
- Counter / usage row delta
- Cache invalidated / updated

A request that succeeds doing nothing also returns 200.

**Carve-out — read / projection / transform features have no DB delta.** Some features mutate nothing: they transform the *response* (data masking, field redaction, projection/DTO shaping, computed read views). The PASS for these is a **response-body assertion** (`expect.body`), not a SQL delta — there is no persisted change to read back (stored values stay raw; only the response differs). Assert the exact transformed value in the body (e.g. `phone == "0987***567"`), and pair it with a negative control (a non-masked caller, or the same field for a non-PARTNER admin) so the assertion can actually fire (SHOULD-4). Reserve `verify:` SQL for features that DO write. A pure input→output unit transform with no endpoint is a unit test, not a manual test — keep it in BUILD.

### MUST-3. Assert deltas, not absolute state

```yaml
setup:
  - sql: "SELECT used_amount FROM usage WHERE entity_id='${ID}'"   # capture as ${BASELINE}
request: ...
verify:
  - sql: "SELECT used_amount - ${BASELINE} AS delta FROM usage WHERE entity_id='${ID}'"
    expect: 50
```

Absolute checks pass when prior runs left polluted state. Deltas catch real behaviour.

### MUST-4. Unique correlation ID per run

Generate once per run: `TEST_CORRELATION_ID=$(uuidgen)`. Thread it through:

- Request body (`idempotency_key`, `client_ref`, `trace_id`)
- Setup SQL (entity ref / external_id)
- Verify SQL `WHERE` clause

Stable IDs (`TEST-001`) collide across runs; leftover state gives false PASS. Unique IDs prove the row you assert on was created by THIS run.

### MUST-5. Async = `poll until` with a timestamp filter

```yaml
# BAD — coin flip; may pass via leftover state from earlier run
expect: { wait_ms: 2000 }
verify:
  - sql: "SELECT status FROM entity WHERE id='${ID}'"
    expect: PROCESSED

# GOOD — bounded poll, scoped to this run via ${TEST_START}
expect:
  poll:
    sql: "SELECT status FROM entity WHERE id='${ID}' AND updated_at > '${TEST_START}'"
    until: PROCESSED
    interval_ms: 500
    timeout_ms: 10000
```

The `updated_at > ${TEST_START}` filter is critical — without it, the poll may match a leftover row from a previous run.

---

## 5 SHOULD rules — apply for regression / depth

Smoke tests may skip these. Regression suites should apply them.

### SHOULD-1. Realistic seed shape

Seed must include the kinds of data production has:

- **Strings**: unicode (`Nguyễn Văn A`), apostrophes (`O'Brien`), trailing/leading whitespace, varying lengths
- **Timestamps**: spread (yesterday + today + tomorrow), not all `NOW()`
- **Nulls**: at least one NULL in every nullable column the feature reads
- **Enums**: every value, not just the ones the test path hits
- **Volume**: for list/search/pagination tests, enough rows to span ≥ 2 pages AND include non-matching distractors. Derive from the page size you're testing — not a magic number.

### SHOULD-2. Don't pre-set derived / computed fields

```sql
-- BAD — hides recompute bug
INSERT INTO orders (id, line_items, total) VALUES (..., '[...]', 500);

-- GOOD — seed inputs, let app compute outputs
INSERT INTO order_items (order_id, amount) VALUES (..., 100), (..., 400);
-- then trigger recompute via the real endpoint
```

If the app computes it, your seed must not pre-set it.

### SHOULD-3. Seed "out-of-scope" rows to test isolation filters

For features with filtering / scoping, seed rows that should be EXCLUDED:

- ≥ 1 soft-deleted row (tests `WHERE deleted_at IS NULL`)
- ≥ 1 row in non-active status
- ≥ 1 row in another tenant (tests `WHERE tenant_id = ?`)
- ≥ 1 row in another locale / region / currency

No rows on the other side of the filter → the filter is untested.

### SHOULD-4. Negative-control sibling for every happy-path test

For every PASS, a sibling that MUST FAIL with the same fixtures — proves the assertion can fire. If you can't construct a sibling that fails, the happy-path assertion is too loose.

```yaml
- id: HAPPY-001
  expect: { status: 200, json_path: "$.id == \"${VALID_ID}\"" }

- id: NEG-001                                # sibling
  request: { ..., path: /api/v1/entities/DOES-NOT-EXIST }
  expect: { status: 404, json_path: "$.code == \"entity.not.found\"" }
```

### SHOULD-5. Post-run audit before declaring PASS

After a suite passes, sweep before reporting:

1. **Sanity-fail probe** — break one seed row (wrong ID / missing parent). Re-run that test. It MUST fail. If still PASS → assertion is broken.
2. **Re-run determinism** — same suite twice in a row. Identical results = clean teardown. Different = leftover state.
3. **Log scan** — tail app logs during the run. Relevant log line per test must appear. Silence = code path not exercised.

---

## Concrete example — BAD vs GOOD

Feature: back-office endpoint that approves a loan application and emits an event.

### BAD — false-positive prone

```yaml
- id: BAD-001
  setup:
    - sql: |
        INSERT INTO applications (id, status, total_amount)
        VALUES ('TEST-001', 'APPROVED', 50000);    # already in end state; pre-set total
  request:
    method: POST
    path: /bo/api/v1/applications/TEST-001/approve
    token: bo_super_admin                          # over-privileged
  expect:
    status: 200
    body_contains: "approved"                      # matches too much
  # no verify, no teardown
```

What this misses:
- Approve handler may no-op on an already-APPROVED row → 200 + URL echoes "approved" → false PASS. Real bug (crash on already-approved) goes undetected.
- `total_amount` pre-set → recompute logic untested.
- `bo_super_admin` masks RBAC bugs.
- No outbox / audit verify → downstream consumer wiring untested.
- Stable `TEST-001` → second run reads stale APPROVED row.

### GOOD — natural flow + delta + correlation ID + side-effect verify

```yaml
- id: GOOD-001
  name: Approve transitions PENDING_REVIEW → APPROVED, emits event, writes audit
  setup:
    # Natural flow: create via real endpoint, submit, then approve.
    - http:
        method: POST
        path: /api/v1/applications
        token: user_token
        body: '{"correlation_id":"${TEST_CORRELATION_ID}","line_items":[{"amount":30000},{"amount":20000}]}'
        capture: { APP_ID: "$.id" }
    - http:
        method: POST
        path: /api/v1/applications/${APP_ID}/submit
        token: user_token
    - sql: "SELECT status FROM applications WHERE id='${APP_ID}'"
      expect: PENDING_REVIEW                       # pre-state confirmed
    - sql: "SELECT now() AS ts"                    # ${TEST_START} baseline
  request:
    method: POST
    path: /bo/api/v1/applications/${APP_ID}/approve
    token: bo_reviewer                             # least-privileged role that should work
  expect:
    status: 200
    json_path: "$.status == \"APPROVED\""
  verify:
    - sql: "SELECT status, total_amount, updated_at FROM applications WHERE id='${APP_ID}'"
      expect:
        status: APPROVED
        total_amount: 50000                        # app computed it; not pre-set
        updated_at: "> ${TEST_START}"              # delta proof
    - sql: |
        SELECT count(*) FROM audit_log
        WHERE entity_id='${APP_ID}'
          AND correlation_id='${TEST_CORRELATION_ID}'
          AND action='APPROVE'
      expect: 1
    - sql: |
        SELECT count(*) FROM outbox_events
        WHERE aggregate_id='${APP_ID}' AND event_type='application.approved'
      expect: 1
  teardown:
    - sql: "DELETE FROM outbox_events WHERE aggregate_id='${APP_ID}'"
    - sql: "DELETE FROM audit_log WHERE entity_id='${APP_ID}'"
    - sql: "DELETE FROM applications WHERE id='${APP_ID}'"

- id: GOOD-001-NEG                                  # sibling — SHOULD-4
  name: Approve with insufficient role → 403, state unchanged
  setup: [ ...same as GOOD-001 up to PENDING_REVIEW... ]
  request:
    method: POST
    path: /bo/api/v1/applications/${APP_ID}/approve
    token: bo_viewer                                # lacks approve permission
  expect:
    status: 403
  verify:
    - sql: "SELECT status FROM applications WHERE id='${APP_ID}'"
      expect: PENDING_REVIEW                        # unchanged → approve path didn't fire
```

---

## Cross-reference

- Setup / teardown mechanics, state restoration → `seeding.md`
- HTTP / Kafka assertion shapes → `checklist.md`
- Specific error codes, gotchas → `troubleshooting.md`
- Pre-test gate (apply MUST/SHOULD before running) → `results.md` § Pre-Test Checklist
