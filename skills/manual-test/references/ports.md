# Platform Port Map

> **Example only — replace with your project's port map.** If your repo keeps a canonical
> port list (e.g. a `PORT-MAP.md`), point to it here. The table below is illustrative.

## Microservices (run locally) — example

| Service | Port | DB |
|---------|------|----|
| service-a | 8080 | service_a_db |
| service-b | 8081 | service_b_db |
| service-c | 8083 | service_c_db |

## Infrastructure (docker-compose)

| Service | Port |
|---------|------|
| PostgreSQL | 5432 |
| Redis | 6379 |
| Kafka | 9095 |
| Keycloak | 8180 |
| MinIO API | 9000 |

## Local stubs (example — replace with your project's)

If your project mocks downstream services with a local stub project (e.g. WireMock-based), list it
here. Example layout:

```bash
cd ../stub-services && <your-run-command>   # e.g. ./gradlew bootRun, docker compose up, npm start
```

| Stub | Port | Mocks |
|------|------|-------|
| stub-a | 8800 | downstream A (e.g. notifications) |
| stub-b | 8801 | downstream B (e.g. compliance) |
| stub-auth | 8830 | JWKS / OTP / login |

> If your repo also has a **separate** stub task for automated/blackbox tests (on different ports),
> don't use it for manual testing — manual testing uses the real services + the manual stubs above.

## Cross-checking `.env`

Before testing endpoints that call external services, verify `.env` URLs match the port map:

```bash
grep _URL .env
```

Each URL should point to a real microservice port or a local-stub port. Mismatch → connection refused.

> `.env` edit rule: when editing, **never delete** lines. Comment with `#` only.

## Identifying Which External Services an Endpoint Calls

1. Check `.env` for `*_URL` vars
2. Check `application.yml` under `external-services.services.*`
3. Match each URL to the port map above

Endpoints that only do local validation (DB checks, limit checks) work without any stub. Endpoints that call downstream services fail with a downstream-service error until stubs are running.

## Stub Verification

```bash
curl -s http://localhost:8830/__admin/health   # WireMock health
```

Stub mappings live in `../stub-services/src/main/resources/wiremock/<SERVICE>/mappings/`.
