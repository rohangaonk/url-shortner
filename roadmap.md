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

## Phase 2 — Core API (Create & Redirect)

**Goal**: Users can shorten a URL and be redirected using the short code. No cache yet.

### Tasks
- [ ] `POST /urls` — accept `{ original_url, custom_alias?, expires_at? }`, return `{ short_url }`
  - Validate that `original_url` is a real URL (`class-validator` `@IsUrl`)
  - Short code generation: Redis `INCR url:counter` → base62 encode the integer
  - If `custom_alias` provided, use it directly (check uniqueness in DB)
  - Create a corresponding `url_stats` row (click_count = 0) in the same transaction
- [ ] `GET /:code` — look up short_code in DB, respond `302` with `Location` header
  - Return `410 Gone` if not found, `is_active = false`, or past `expires_at`
- [ ] `DELETE /urls/:id` — soft-delete (`is_active = false`)

### Key Decisions Already Made
- **302** (not 301) so browser doesn't cache and every redirect hits our server — required for click tracking
- **No auth** on `POST /urls`; `DELETE` can be open for now too (will revisit in hardening phase)
- **Collision-free** by design — Redis counter is monotonically increasing, no retry logic needed

### Key Decision to Discuss Before Building
- What NestJS module structure will you use? (`UrlsModule`, `RedirectModule` separate, or combined?)
- Should `POST /urls` accept an `expires_at` field? Your API spec from discussions included it via Hello Interview notes.

---

## Phase 3 — Redis: Caching & Click Counter Flush

**Goal**: Redirect latency drops significantly. Click counts land in Postgres without hammering it.

### Tasks
- [ ] Integrate `ioredis` as a NestJS provider (already installed)
- [ ] **Cache-aside** on `GET /:code`:
  - Check Redis first (`url:{shortCode}` → original_url)
  - On miss: query Postgres, populate cache with TTL ≤ `expires_at`
  - Cache invalidation on `DELETE`: explicitly `DEL url:{shortCode}`
- [ ] **Click tracking** on `GET /:code` (fire-and-forget):
  - `INCR stats:{shortCode}:count`
  - `SET stats:{shortCode}:last_accessed <ISO timestamp>`
- [ ] **Flush job** (NestJS `@Interval`, every ~1s):
  - `SCAN` for `stats:*:count` keys
  - Bulk `UPDATE url_stats SET click_count = click_count + $delta, last_accessed_at = $ts`
  - Delete processed Redis keys
- [ ] Decide eviction policy: `allkeys-lru` vs `volatile-lru`

### Key Decision to Discuss
- `allkeys-lru` evicts any key when memory is full. `volatile-lru` only evicts keys with a TTL set. Which is safer for our mix of cache keys and counter keys?
- What happens to unflushed counter keys if the app crashes mid-interval?

---

## Phase 4 — Analytics

**Goal**: Users can see click counts and last accessed time per URL.

### Tasks
- [ ] `GET /urls/:id/analytics` — return `{ clicks: number, last_accessed_at: Date }`
  - Read from `url_stats` table (Postgres)
  - Optionally blend with unflushed Redis counter for fresher data

### Decisions Already Made
- Per-click row table rejected — too write-heavy at scale
- `url_stats` (one row per URL) is the source of truth, hydrated by the Phase 3 flush job
- Eventually consistent is acceptable for click counts

---

## Phase 5 — Docker & Local Hardening

**Goal**: Full system runs identically in Docker. Ready for cloud deployment.

### Tasks
- [ ] `Dockerfile` for NestJS app (multi-stage: build → production image)
- [ ] Update `docker-compose.yml` to include the app service alongside Postgres + Redis
- [ ] Health check endpoint: `GET /health`
- [ ] Graceful shutdown: drain in-flight requests, flush Redis counters to Postgres before exit
- [ ] Rate limiting on `POST /urls` (`@nestjs/throttler`) to prevent spam
- [ ] Input sanitization: reject known malicious URL patterns (basic blocklist)
- [ ] Integration tests for happy path + edge cases (expired URL, collision, invalid URL)

---

## Phase 6 — AWS Deployment (ECS Fargate)

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

## Phase 7 — CDN Layer (CloudFront + Lambda@Edge)

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

| Phase | Deliverable | Local/Cloud |
|-------|------------|-------------|
| 1 | Project scaffold + schema | Local |
| 2 | Create + Redirect + Auth API | Local |
| 3 | Redis caching + counter | Local |
| 4 | Analytics endpoint | Local |
| 5 | Dockerized, hardened app | Local |
| 6 | ECS Fargate + RDS + ElastiCache | AWS |
| 7 | CloudFront + Lambda@Edge CDN | AWS |
