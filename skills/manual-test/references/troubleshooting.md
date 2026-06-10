# Troubleshooting

## Response Interpretation

### Success indicators

| Response | Meaning |
|----------|---------|
| 200 + business data | Full success |
| Downstream service error after local validation | Local logic PASSED, external stub missing / misconfigured — may be expected locally |

### Error indicators

| Response | Meaning |
|----------|---------|
| `com.unauthorized.access` (401) | Missing/invalid auth. Path A: X-Userinfo rejected or malformed. **If Path A always 401 with a valid token → service doesn't trust local X-Userinfo (Summer 0.3.x BO); switch to Path B (Keycloak ROPC + Bearer).** Also check token has no `\n` — use `tr -d '\n'`. |
| `com.access.denied` (403) | Token valid but roles insufficient. Path A: Redis seed missing / wrong / stale (wait 60s for L1 cache or restart app). Path B: user's Keycloak group lacks required role. |
| `com.invalid.request` (400) | Bean Validation failed — check `details[]` array |
| `*.limit.exceeded` | Limit / quota check working correctly |
| `*.not.found` (404) | Entity doesn't exist — may need seeding |
| `com.conflict.occurred` (409) | Optimistic lock — stale `version` |

## Stub Failures (connection refused / unexpected 404)

If external service calls fail during manual testing:

1. Check `stub-services` is running: `curl -s http://localhost:8830/__admin/health` (200).
2. Check `.env` `*_URL` values match the port map (`references/ports.md`).
3. Check stub mappings: `../stub-services/src/main/resources/wiremock/<SERVICE>/mappings/`.
4. **Don't use the automated-test stub task** — if the repo has a separate stub task for automated/blackbox tests, those stubs are for automated runs only.

## Common Gotchas

### Date/time parameter format

Both directions of this trap exist. Always check the DTO field type **before** constructing query params:

```bash
grep -B1 -E "LocalDate|LocalDateTime" src/main/java/**/*Controller.java | grep -A1 RequestParam
```

| DTO field type | Required format | Wrong format → result |
|----------------|-----------------|-----------------------|
| `LocalDateTime` | Full ISO-8601: `2026-03-01T00:00:00` | Date-only `2026-03-01` → 400 |
| `LocalDate` | Date-only: `2026-03-01` | Full ISO `2026-03-01T00:00:00` → 400 `Type mismatch` |

The mismatch is silent — `400 com.invalid.request` with `"issue":"Type mismatch."` and no hint about the expected format. Inspect the `@RequestParam` annotation to know which type is expected.

### Custom ID formats

Some services expose IDs in a different format than DB storage (hex-encoded, base62, stripped dashes). When testing search by ID:

- Check how the ID appears in API responses vs DB columns
- Use the **API-side format** in search requests — the service expects what it outputs

Example: an ID stored as UUID `019d65f2-985b-7485-6476-b98fe4c58211` may be exposed as `019D65F2985B74856476B98FE4C58211` (32-char hex, no dashes). Searching with the UUID format won't match.

### Verify endpoint path before testing (Path Discovery Rule)

Wrong path wastes time. **Full endpoint path = class-level `@RequestMapping` + method-level mapping.**

```java
@RequestMapping("/bo/api/v1/entities")  // ← class base
public class BackOfficeEntityController {
  @GetMapping("/{id}")                   // ← method suffix
  ...
}
// Full path: /bo/api/v1/entities/{id}
// NOT: /bo/api/v1/entity/list  ← don't infer from class name
```

**Wrong:** grep for a keyword in method annotations — the keyword usually lives in class-level base.
**Right:** read class `@RequestMapping` first, then concatenate with method mapping.

Discovery one-liner (also in `scripts/warm-up.sh`):

```bash
for f in $(find src/main/java -name "*Controller.java"); do
  class_path=$(grep -E "^@RequestMapping" $f | sed -E 's/.*"([^"]+)".*/\1/')
  echo "=== $f → base: $class_path ==="
  grep -nE "@GetMapping|@PostMapping|@PutMapping|@DeleteMapping" $f | head -10
done
```

BO endpoints (`/bo/api/v1/...`) and end-user endpoints (`/api/v1/...`) are separate controllers — don't assume the sub-path matches the service name.

### macOS base64 wraps long lines silently → 401

Always:

```bash
TOKEN=$(echo -n '{...}' | base64 | tr -d '\n')
```

Without `tr -d '\n'`, the encoded token has embedded newlines and the server returns 401 with no useful message.
