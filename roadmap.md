# URL Shortener — Implementation Roadmap

## Stack

- **API**: NestJS (TypeScript)
- **Database**: PostgreSQL (local → AWS RDS)
- **Cache**: Redis (local → AWS ElastiCache Redis Cluster)
- **Infra**: Docker → AWS ECS Fargate
- **CDN**: AWS CloudFront + Lambda@Edge

---

## Phase 1 — Project Scaffold & Data Model ✅

**Goal**: Working NestJS project with database schema and migrations in place. No business logic yet.

### Tasks

- [x] Initialize NestJS app with `@nestjs/config`, `@nestjs/typeorm`, `pg`, `ioredis`, `class-validator`
- [x] `docker-compose.yml` with Postgres + Redis containers for local development
- [x] Design and migrate the core schema:
  - `users` — id, email, password_hash, created_at
  - `urls` — id, short_code (unique index), original_url, user_id (nullable FK), custom_alias, expires_at, is_active, created_at
  - `url_stats` — id, url_id (unique FK → OneToOne), click_count (BIGINT), last_accessed_at
- [x] Environment config module (`.env` with DB creds, Redis URL, app port)
- [x] TypeORM migrations setup via `data-source.ts`; initial migration applied

### Decisions Made

- **ORM**: TypeORM (native NestJS module integration)
- **HTTP adapter**: Express (Fastify dropped — ecosystem friction not worth sub-ms gains given Redis is the real bottleneck)
- **Short code generation**: Redis `INCR` → base62 encode. No batching needed — write throughput is ~1 RPS avg, direct `INCR` per request is fine
- **Analytics storage**: `url_stats` (one row per URL, `click_count BIGINT`) — NOT a per-click row table. Redis absorbs write bursts; flush to Postgres every ~1s
- **Auth on POST /urls**: Not required — `user_id` is nullable on `urls` table
- **Click count consistency**: Eventually consistent is acceptable

---

## Phase 2 — Core API (Create & Redirect) ✅

**Goal**: Users can shorten a URL and be redirected using the short code. Redis cache-aside included.

### Tasks

- [x] `POST /urls` — accept `{ original_url, custom_alias?, expires_at? }`, return `{ short_url }`
  - Validate that `original_url` is a real URL (`class-validator` `@IsUrl`)
  - Short code generation: Redis `INCR url:counter` → Knuth shuffle → base62 encode
  - If `custom_alias` provided, use it directly; return `409 Conflict` if taken
  - Create a corresponding `url_stats` row (click_count = 0) in the same transaction
- [x] `GET /:code` — cache-aside lookup (Redis first, Postgres on miss), respond `302`
  - Return `410 Gone` if not found, `is_active = false`, or past `expires_at`
- [x] `DELETE /urls/:id` — soft-delete: Redis DEL first, then Postgres `is_active = false`
- [x] Global `ValidationPipe` registered in `main.ts` (`whitelist: true, transform: true`)
- [x] Global `RedisModule` wired as NestJS provider (`REDIS_CLIENT` injection token)

### Module Structure

- **Monolith** with two independently testable modules:
  - `UrlsModule` — `POST /urls`, `DELETE /urls/:id`; exports `UrlsService`
  - `RedirectModule` — `GET /:code`; imports `UrlsModule`, delegates DB/cache to `UrlsService`
- Single `Url` repository owned by `UrlsModule`; `RedirectModule` never touches it directly

### Decisions Made

- **302** (not 301) — browser must not cache; every redirect must hit the server for click tracking
- **No auth** on any endpoint — `user_id` nullable; will revisit in Phase 5 hardening
- **`expires_at` default** — `null` = lives forever; expiry check: `expires_at !== null && expires_at < now`
- **Custom alias conflict** — `409 Conflict` (explicit, no silent fallback)
- **Short code generation** — Redis `INCR` → Knuth multiplicative shuffle (`counter × 2147483647 mod SPACE_SIZE`) → base62 encode with `62^6` offset → always 7 chars, looks random, bijective (no collisions)
- **Cache TTL** — expiring URLs: `expires_at - now` seconds; permanent URLs: no TTL
- **Cache invalidation on delete** — Redis DEL before Postgres update (fail-safe ordering)
- **Redis eviction policy** — `allkeys-lfu` (hot viral URLs stay cached; no-TTL keys must not be exempt)

---

## Phase 3 — Docker & Local Hardening ✅

**Goal**: Full system runs identically in Docker. Ready for cloud deployment.

### Tasks

- [x] `Dockerfile` for NestJS app (multi-stage: build → production image)
- [x] Update `docker-compose.yml` to include the app service alongside Postgres + Redis
- [x] Health check endpoint: `GET /health`
- [x] Manual testing via Docker Compose (`docker compose up`, `curl http://localhost:3000/health`)

### Decisions Made

- **Multi-stage build** — builder stage: full Alpine + all deps + `nest build`; production stage: fresh Alpine + `npm ci --omit=dev` + `dist/` only
- **Base image** — `node:20-alpine` (pure-JS deps, no native addon risk)
- **`.dockerignore`** — excludes `.env`, `node_modules/`, `dist/` (secrets never baked into image)
- **`depends_on: condition: service_healthy`** — app waits for Postgres and Redis healthchecks before starting; plain `depends_on` is not sufficient
- **Hostname resolution** — inside Docker network, services reach each other by service name (`DB_HOST=postgres`, `REDIS_HOST=redis`); `.env` must reflect this at runtime
- **Secrets** — injected at runtime via `env_file: .env`; never baked into the image. Secrets Manager deferred to Phase 4 (AWS)
- **`CMD`** — `node dist/src/main` (not `dist/main`) because `data-source.ts` at project root causes TypeScript to infer `rootDir` as `.`, mirroring folder structure in `dist/`
- **`/health` route ordering** — lives in a dedicated `HealthModule` imported before `RedirectModule`; NestJS registers routes depth-first so `GET /:code` would otherwise shadow it

---

## Phase 4 — AWS Deployment (ECS Fargate)

**Goal**: Production-grade deployment on AWS. App talks to RDS + ElastiCache instead of local containers.

### Architecture

```
Internet → ALB → ECS Fargate (NestJS tasks) → RDS Postgres (Multi-AZ)
                                             → ElastiCache Redis (Cluster mode)
```

### Tasks

- [ ] Push Docker image to **AWS ECR**
- [ ] Provision **RDS Postgres** (Multi-AZ for HA, automated backups enabled)
- [ ] Provision **ElastiCache Redis Cluster** (cluster mode for horizontal scaling)
  - Update NestJS Redis client to use cluster-aware config (`ioredis` Cluster)
- [ ] Create **ECS Fargate** task definition + service
  - Task role with least-privilege IAM permissions
  - Secrets via AWS Secrets Manager or SSM Parameter Store (no plaintext DB creds in env)
- [ ] **Application Load Balancer** in front of ECS service
- [ ] VPC setup: ECS tasks and RDS/ElastiCache in private subnets, ALB in public subnet
- [ ] Auto-scaling policy on ECS service (scale on CPU or request count)
- [ ] CI/CD pipeline (GitHub Actions): test → build → push to ECR → deploy to ECS

### Key Decision to Discuss

- RDS Multi-AZ vs Read Replica — when does each matter for us?
- How does Redis Cluster mode change key routing? (hint: hash slots — does this affect our batch counter approach?)
- What's your approach to zero-downtime deployments on ECS?

---

## Phase 5 — CDN Layer (CloudFront + Lambda@Edge)

**Goal**: Sub-100ms redirects globally by serving redirect logic at the CDN edge.

### Architecture

```
User → CloudFront → Lambda@Edge (redirect logic) → Origin (ALB/ECS) on cache miss
```

### Tasks

- [ ] Configure **CloudFront distribution** in front of the ALB
- [ ] Write **Lambda@Edge** (Viewer Request trigger) for redirect:
  - On `GET /:code`, check CloudFront cache
  - On miss: forward to origin, cache response with `Cache-Control: max-age=<TTL>`
  - Cache key = short code
- [ ] **Cache-Control strategy**:
  - Active URLs: `max-age` = remaining TTL of the URL
  - Deleted/expired URLs: `Cache-Control: no-store` + CloudFront invalidation
- [ ] **Cache invalidation** on URL delete: call CloudFront `CreateInvalidation` API
- [ ] Decide: should the analytics click count include CDN-served hits? If yes, how?
  - Option A: CloudFront access logs → Kinesis → Lambda → Postgres
  - Option B: Accept under-counting for CDN-cached hits
- [ ] Custom domain on CloudFront (e.g., `short.ly`)

### Key Decision to Discuss

- Lambda@Edge has constraints: no env vars natively, cold starts, limited memory. Does this change our redirect logic design?
- A URL gets deleted. It's cached at 200 edge locations. How do you ensure users aren't redirected to a dead URL? How fast can you guarantee propagation?
- CDN caching means some clicks bypass your server. Is an accurate click count a hard requirement?

---

## Milestones Summary

| Phase | Deliverable                     | Local/Cloud |
| ----- | ------------------------------- | ----------- |
| 1     | Project scaffold + schema       | Local       |
| 2     | Create + Redirect + Auth API    | Local       |
| 3     | Redis caching + counter         | Local       |
| 4     | Dockerized, hardened app        | Local       |
| 5     | ECS Fargate + RDS + ElastiCache | AWS         |
| 6     | CloudFront + Lambda@Edge CDN    | AWS         |
