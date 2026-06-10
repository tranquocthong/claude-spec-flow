# Stack-Specific Discovery

The skill auto-detects stack via `scripts/detect-stack.sh` → `java-spring | node | python | go | dotnet | unknown`. Per-stack scripts handle the 80% case deterministically. **When detection is uncertain, fall back to agent grep** — recipes below.

The Java/Spring path is the deepest because the skill grew up there. Other stacks rely more on generic patterns + agent-driven grep. That's by design — bash detection doesn't need to handle every framework if Claude can grep on demand.

## Java + Spring Boot

### DB creds
`db-creds.sh` parses `src/main/resources/application.yml` for `spring.r2dbc.*` / `spring.datasource.*` / `spring.flyway.*`, resolves `${ENV_VAR:default}` against `.env`.

### Endpoint discovery
`@RequestMapping` (class-level) + `@GetMapping`/`@PostMapping`/... (method-level). `warm-up.sh` already prints both.

### Auth
- Summer Framework → `references/auth.md` (Path A X-Userinfo / Path B Keycloak ROPC)
- Plain Spring JWT → `references/auth-jwt-basic.md`

### Kafka
- Listeners: `grep -rn "@KafkaListener\|KafkaReceiver" src/main/java`
- Producers: `grep -rn "KafkaTemplate\|KafkaSender" src/main/java`

---

## Node.js

### Project shape
- Express / Fastify / Koa / Hapi — flat route definitions: `app.get('/...', handler)`
- NestJS — decorator-based: `@Controller('/path') @Get(':id')`
- Next.js / Nuxt — file-system routing (`pages/`, `app/`, `routes/`)

### DB creds
- Connection string in `.env` as `DATABASE_URL=postgres://user:pass@host:port/db` — `db-creds.sh` parses this directly.
- ORMs:
  - **Prisma**: `prisma/schema.prisma` → `datasource db { url = env("DATABASE_URL") }`
  - **TypeORM**: `ormconfig.json`, `data-source.ts`
  - **Sequelize**: `config/config.json`
  - **Knex**: `knexfile.js`

### Endpoint discovery
```bash
# Express / Fastify / Koa
grep -rnE "(app|router|fastify|server)\.(get|post|put|delete|patch|head)\s*\(" \
  --include="*.js" --include="*.mjs" --include="*.ts" src/ app/ routes/ api/

# NestJS
grep -rnE "@(Controller|Get|Post|Put|Delete|Patch)\b" --include="*.ts" src/
```

### Auth
- JWT: `passport-jwt`, `express-jwt`, `jsonwebtoken`, `jose`, `@nestjs/jwt`, `@fastify/jwt`, `next-auth`
- Session: `express-session`, `@fastify/session`, `cookie-session`, `iron-session`

Fetch JWT pattern (typical):
```bash
JWT=$(curl -sf -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"...","password":"..."}' \
  | jq -r '.access_token // .token // .jwt')
```

Most Node JWTs are signed with a symmetric secret (HS256) from `.env` — you can mint locally without hitting login (see `references/auth-jwt-basic.md` → Pattern 3).

### Kafka
- Library: `kafkajs` (`new Kafka({...}).consumer({groupId})`, `consumer.run({eachMessage})`)
- Discovery: `grep -rnE "consumer\.run|new Kafka|kafkajs" src/`

---

## Python

### Project shape
- **FastAPI/Starlette** — `@app.get("/...")` decorators on functions returning Pydantic models
- **Flask** — `@app.route("/...")` or blueprints (`@bp.route`)
- **Django** — `urlpatterns = [path("...", view)]` in `urls.py`
- **DRF (Django REST)** — `routers.DefaultRouter().register(...)`

### DB creds
- `.env` with `DATABASE_URL` (12-factor convention) — `db-creds.sh` handles this
- **SQLAlchemy**: `engine = create_engine(os.getenv("DATABASE_URL"))`
- **Django**: `settings.py` → `DATABASES = {'default': {...}}` — sometimes loaded from `os.environ`
- **Alembic**: `alembic.ini` → `sqlalchemy.url`
- Common env names: `DATABASE_URL`, `DB_HOST`, `POSTGRES_*`

### Endpoint discovery
```bash
# FastAPI / Starlette
grep -rnE "@(app|router)\.(get|post|put|delete|patch)\s*\(" --include="*.py" .

# Flask
grep -rnE "@(app|bp|blueprint)\.route\s*\(|add_url_rule\s*\(" --include="*.py" .

# Django
find . -name "urls.py" -not -path "*/.venv/*"
# Then read each to see urlpatterns
```

### Auth
- JWT: `python-jose`, `pyjwt`, `authlib`, `fastapi.security.OAuth2PasswordBearer`, `djangorestframework-simplejwt`
- Session: Django default; Flask-Login; Starlette `SessionMiddleware`

Fetch JWT (FastAPI typical):
```bash
JWT=$(curl -sf -X POST http://localhost:8000/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=...&password=..." \
  | jq -r '.access_token')
```

### Kafka
- Libraries: `confluent-kafka`, `aiokafka`, `kafka-python`
- Discovery: `grep -rnE "Consumer\(|consumer\.poll|aiokafka|confluent_kafka" --include="*.py" .`

---

## Go

### Project shape
- **Gin**: `r := gin.New(); r.GET("/path", handler)`
- **Echo**: `e := echo.New(); e.GET("/path", handler)`
- **Fiber**: `app := fiber.New(); app.Get("/path", handler)`
- **Chi / Mux**: `r := chi.NewRouter(); r.Get("/path", handler)`
- **net/http**: `http.HandleFunc("/path", handler)`

### DB creds
- Connection string in `.env` as `DATABASE_URL` or `POSTGRES_*` — `db-creds.sh` handles
- Typical: `db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))`
- ORMs: GORM, sqlx, ent

### Endpoint discovery
```bash
grep -rnE "\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\"|HandleFunc\s*\(\"" \
  --include="*.go" .
```

### Auth
- JWT: `github.com/golang-jwt/jwt`, `github.com/lestrrat-go/jwx`, `github.com/coreos/go-oidc`
- Session: `github.com/gorilla/sessions`, `github.com/alexedwards/scs`

### Kafka
- Libraries: `segmentio/kafka-go`, `confluent-kafka-go`, `Shopify/sarama`
- Discovery: `grep -rnE "kafka\.NewConsumer|kafka\.NewReader|sarama\.NewConsumer" --include="*.go" .`

---

## .NET (ASP.NET Core)

### Project shape
- Attribute routing: `[HttpGet("/path")]` on controller actions
- Minimal API: `app.MapGet("/path", handler)`

### DB creds
- `appsettings.json` → `ConnectionStrings:DefaultConnection`
- Env override: `ConnectionStrings__DefaultConnection`
- EF Core typically reads `DefaultConnection`

### Endpoint discovery
```bash
grep -rnE "\[(Http(Get|Post|Put|Delete|Patch)|Route)\(" --include="*.cs" .
grep -rnE "app\.Map(Get|Post|Put|Delete|Patch)\s*\(" --include="*.cs" .
```

### Auth
- JWT: `Microsoft.AspNetCore.Authentication.JwtBearer`
- Cookie: `Microsoft.AspNetCore.Authentication.Cookies`

---

## Unknown / Mixed Stacks

When `detect-stack.sh` returns `unknown`, look in this order:

1. **`Dockerfile`** — `FROM openjdk` / `node` / `python` / `golang` / `mcr.microsoft.com/dotnet` identifies runtime.
2. **`docker-compose.yml`** — `image:` lines on services point at base images.
3. **`README.md`** — usually mentions stack in the first few paragraphs.
4. **Manifest hunt:**
   ```bash
   find . -maxdepth 3 -type f \( -name "*.csproj" -o -name "*.sbt" -o -name "Cargo.toml" \
     -o -name "mix.exs" -o -name "Gemfile" -o -name "composer.json" \) 2>/dev/null
   ```
5. **Listening sockets** — `lsof -i -P -n | grep LISTEN` (if app is running). Map the PID to a process name.

For DB/route/auth — once stack is identified manually, jump to the matching section above.

## Agent-Search Fallback Principle

The bash scripts are deterministic for common cases. When they fall short:

1. Script prints `unknown` + structured hints to stderr (already does this).
2. Claude reads the hints and uses `Grep` / `Glob` tools to investigate.
3. Once the right pattern is identified, Claude can either run the test inline OR contribute a patch back into the per-stack section here.

Don't try to make bash exhaustive. The agent is the fallback by design.
