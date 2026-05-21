# Lofty's Larder — Feature Specs

Derived from `plan.md`. Each feature is sized for a single sitting (up to ~4 hours). Cross-references to the design decision log use `[DEC-TBD: <subject>]` placeholders; the log itself is written in a later phase, at which point these tags become real `DEC-NN` references.

Conventions:
- **Reuse note** appears only where designing for reuse from day one materially affects the implementation.
- Commit messages follow Conventional Commits.
- The **gate check** in each Definition of Done is the simplest end-to-end action that proves the feature works in the running system — not just that it compiles or passes a unit test.

---

## Phase 1 — Infrastructure & CI

### FEAT-01 — Monorepo scaffolding

**Goal:** Stand up a pnpm-workspace monorepo with `/backend`, `/frontend`, `/shared`, ESM-only, strict TypeScript, Node LTS pinned. `[DEC-TBD: ESM-only across all workspaces]` `[DEC-TBD: pnpm workspaces with /shared as the type-pipeline carrier]`

**Estimate:** 1–2 hr. **Depends on:** none. **Enables:** FEAT-02, 03, 04.

**Reuse note:** The `/shared` workspace contract — what gets exported, how Zod schemas are organised, where the tRPC router type lives — is set here and touched by every subsequent feature. Get this shape right before recipes/plans start producing schemas.

**Files:**
- `package.json` (root, private, workspaces)
- `pnpm-workspace.yaml`, `.nvmrc`, `.gitignore`, `.editorconfig`
- `tsconfig.base.json`, `backend/tsconfig.json`, `frontend/tsconfig.json`, `shared/tsconfig.json`
- `backend/package.json`, `frontend/package.json`, `shared/package.json`
- `shared/src/index.ts` (placeholder barrel)

**Acceptance criteria:**
- [ ] `pnpm install` succeeds with no peer-dep warnings from a fresh clone
- [ ] Node LTS pinned in all three workspaces' `engines` field and in `.nvmrc`
- [ ] All workspaces use `"type": "module"` and ESM import syntax
- [ ] `tsconfig.base.json` sets `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
- [ ] `pnpm -r typecheck` exits 0 on placeholder content
- [ ] `/shared` exports a type-only barrel ready to hold the tRPC router type

**Implementation notes:**
- Top-level `package.json` is `"private": true` and carries shared dev tooling (TypeScript, ESLint, Prettier) at root with `*` versions resolved by pnpm.
- Use path aliases sparingly; explicit relative imports across workspaces are clearer.

**Manual verification:**
1. Delete `node_modules` and lockfile, run `pnpm install` — clean install.
2. `pnpm -r typecheck` from root.
3. `node --version` matches `.nvmrc`.

**Common gotchas:**
- A CJS-only dependency will surface as an ERR_REQUIRE_ESM at runtime, not at install. Sanity-check critical deps support ESM before pinning.
- Without `"moduleResolution": "NodeNext"`, TypeScript will accept extension-less imports that Node refuses to run.

**Definition of done:**
- Tests cover: nothing yet (placeholder test added in FEAT-07).
- Commit: `chore(infra): scaffold pnpm monorepo with backend/frontend/shared workspaces`
- Gate check: from a fresh clone, `pnpm install && pnpm -r typecheck` exits 0.

---

### FEAT-02 — Local dev Docker Compose

**Goal:** One-command local environment running Postgres for dev and tests.

**Estimate:** 1–2 hr. **Depends on:** FEAT-01. **Enables:** FEAT-03, FEAT-09, all backend integration tests.

**Files:**
- `docker-compose.yml`
- `.env.example` (DB URL, port)
- `README.md` (dev-start section)

**Acceptance criteria:**
- [ ] `docker compose up -d postgres` starts Postgres with `pg_trgm` extension creatable
- [ ] Persistent named volume so data survives container restarts
- [ ] Distinct dev DB and test DB available (or scripted setup for the test DB)
- [ ] `.env.example` documents `DATABASE_URL` shape; real `.env` is gitignored
- [ ] Exposed port doesn't collide with a system Postgres if one is running (use a non-5432 host port)

**Implementation notes:**
- Compose file should declare Postgres only at this stage. Fastify and Vite stay on the host during local dev (faster reload, simpler debugging) — Compose is for the database and any future stateful service.
- Pin the Postgres image to an explicit minor version, not `latest`.

**Manual verification:**
1. `docker compose up -d postgres`
2. `psql $DATABASE_URL -c 'select version();'` returns the pinned version.
3. `psql $DATABASE_URL -c 'create extension if not exists pg_trgm;'` succeeds.

**Common gotchas:**
- Default host port 5432 collides with a local Postgres install. Pick a non-default mapped port from the start.
- Without a named volume, `docker compose down -v` wipes data; that's correct but documenting the distinction prevents surprises.

**Definition of done:**
- Tests cover: not applicable.
- Commit: `chore(infra): add docker-compose for local Postgres with pg_trgm`
- Gate check: `docker compose up -d postgres` then `psql $DATABASE_URL -c '\dx'` lists `pg_trgm`.

---

### FEAT-03 — Backend Fastify scaffold

**Goal:** Boot a Fastify server with Pino logging (per-request `req.id`), `@fastify/helmet`, `@fastify/static`, `@fastify/cors` (dev-only), and a mounted tRPC adapter at `/api/trpc/*` exposing one placeholder procedure. `[DEC-TBD: req.id propagated end-to-end]` `[DEC-TBD: CORS only in dev; prod is same-origin]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-01. **Enables:** every backend procedure thereafter.

**Reuse note:** The plugin-registration order and the tRPC context shape (`req`, `reply`, `session`) are decided here. Every later procedure inherits them. The pre-handler auth hook (added in FEAT-14) will plug into this same pipeline — leave a comment marking the insertion point.

**Files:**
- `backend/src/server.ts` (boot)
- `backend/src/plugins/logger.ts`, `backend/src/plugins/security.ts`
- `backend/src/trpc/context.ts`, `backend/src/trpc/router.ts`, `backend/src/trpc/init.ts`
- `backend/src/config.ts` (env loader with Zod)
- `shared/src/router-type.ts` (exports `AppRouter` type)
- `backend/package.json` (deps: `fastify`, `@fastify/helmet`, `@fastify/static`, `@fastify/cors`, `pino`, `@trpc/server`, `zod`, `tsx`)

**Acceptance criteria:**
- [ ] Server boots and logs a startup line with the bound port
- [ ] Pino HTTP plugin generates a `req.id` on every request and includes it in access logs
- [ ] `@fastify/helmet` registered with default options (CSP customised in FEAT-47)
- [ ] tRPC mounted at `/api/trpc/*` with one placeholder `health.ping` procedure returning `{ ok: true, reqId: string }`
- [ ] Calling `health.ping` from a script using `@trpc/client` returns the expected shape
- [ ] CORS enabled in dev with origin restricted to the Vite dev server URL; disabled in prod build
- [ ] Env loader validates required vars on boot and exits with a clear error on missing values
- [ ] `AppRouter` type exported from `/shared` (not the router runtime)

**Implementation notes:**
- The tRPC context factory pulls `req.id` and passes it through so downstream procedures can log with correlation.
- Keep `@fastify/static` registered but pointed at a placeholder dir for now; real `dist/` wiring lands with FEAT-05.
- Use `tsx watch` for local dev; the prod bundle path (esbuild) is added in FEAT-05.

**Manual verification:**
1. `pnpm --filter backend dev`
2. `curl http://localhost:3000/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D` returns 200 with `reqId` populated.
3. Server log line for that request includes the same `reqId`.

**Common gotchas:**
- Registering `@fastify/static` without a `prefix` swallows `/api/*` routes. Mount static at root and ensure tRPC's prefix wins by registration order or use `prefix: '/api/static'`.
- Pino's `genReqId` must produce a non-empty string; the default is fine but verify it's enabled.
- Avoid `console.log` anywhere — once Axiom transport lands (FEAT-43), only Pino entries get aggregated.

**Definition of done:**
- Tests cover: server boots, env validation rejects missing required vars, `health.ping` returns the expected shape (Vitest + supertest-style probe).
- Commit: `feat(backend): scaffold Fastify with Pino, helmet, and tRPC adapter`
- Gate check: `curl` the placeholder procedure and observe the matching `reqId` in the log.

---

### FEAT-04 — Frontend Vite/React scaffold

**Goal:** Boot a Vite + React + Tailwind + shadcn/ui + TanStack Router + TanStack Query + tRPC client + React Hook Form app proxying `/api/*` to Fastify. Render one page that calls `health.ping` and shows the result. `[DEC-TBD: Vite server.proxy for dev same-origin]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-01, 03. **Enables:** every frontend view thereafter.

**Reuse note:** The tRPC client config, the TanStack Query default options, the router root layout, and the Tailwind/shadcn theme tokens all get set here and reused everywhere. Decide the QueryClient defaults (stale time, retry policy) deliberately — changing them later is invasive.

**Files:**
- `frontend/index.html`, `frontend/vite.config.ts`
- `frontend/src/main.tsx`, `frontend/src/app.tsx`, `frontend/src/router.tsx`
- `frontend/src/lib/trpc.ts` (client setup)
- `frontend/src/lib/query-client.ts`
- `frontend/src/routes/_root.tsx`, `frontend/src/routes/index.tsx`
- `frontend/src/index.css` (Tailwind directives)
- `frontend/tailwind.config.ts`, `frontend/postcss.config.js`
- `frontend/components.json` (shadcn config)
- `frontend/package.json` (deps: `react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `@trpc/client`, `@trpc/react-query`, `react-hook-form`, `@hookform/resolvers`, `zod`, `tailwindcss`, `clsx`, `tailwind-merge`, `lucide-react`, shadcn primitives as needed)

**Acceptance criteria:**
- [ ] `pnpm --filter frontend dev` serves on Vite's port; `/api/*` proxied to Fastify
- [ ] `AppRouter` type imported from `/shared`; tRPC client fully typed (autocomplete works on procedures)
- [ ] TanStack Router root layout + index route render
- [ ] Tailwind base styles applied; shadcn `Button` primitive renders without runtime errors
- [ ] Index page calls `trpc.health.ping.useQuery()` and displays `reqId`
- [ ] Vite production build (`pnpm --filter frontend build`) succeeds and emits to `frontend/dist/`

**Implementation notes:**
- Configure `vite.config.ts` `server.proxy` for `/api` → Fastify host. Same-origin in dev mirrors prod.
- Set QueryClient defaults thoughtfully: `staleTime` of a few seconds for most queries, `retry: 1`, `refetchOnWindowFocus: false` for development sanity. Revisit per query as needed.
- shadcn init via CLI (`pnpm dlx shadcn@latest init`) then add primitives as features need them.

**Manual verification:**
1. `pnpm --filter frontend dev`, open the page in a browser.
2. The displayed `reqId` matches the one logged by Fastify for that request.
3. `pnpm --filter frontend build` emits `dist/` with hashed assets.

**Common gotchas:**
- Importing the tRPC *runtime* from backend will pull server code into the bundle. Import only the *type* from `/shared` via `import type`.
- TanStack Router code-generation: if using the file-based router, ensure the generator runs in dev and CI; otherwise route trees go stale.
- Tailwind's content globs must include `frontend/src/**/*.{ts,tsx}` or classes get tree-shaken out of dev too.

**Definition of done:**
- Tests cover: index route renders the result from a mocked `health.ping` (RTL).
- Commit: `feat(frontend): scaffold Vite/React with Tailwind, shadcn, TanStack, tRPC client`
- Gate check: open the index page in the browser, see the `reqId` from the server displayed live.

---

### FEAT-05 — Production multi-stage Dockerfile + fly.toml

**Goal:** Build a production image that bundles the backend via esbuild and serves the frontend via `@fastify/static`, plus a `fly.toml` ready to deploy. (DEC-61: esbuild bundle in prod, tsx in dev; DEC-62: multi-stage Dockerfile; DEC-60: single Fly app serves API and frontend same-origin; DEC-63: single region lhr; DEC-64: auto-stop enabled.)

**Estimate:** 2–3 hr. **Depends on:** FEAT-03, 04. **Enables:** FEAT-06.

**Files:**
- `Dockerfile` (multi-stage)
- `fly.toml`
- `backend/build.ts` or esbuild config
- `.dockerignore`

**Acceptance criteria:**
- [ ] Stage 1 builds the frontend with `pnpm --filter frontend build`
- [ ] Stage 2 bundles the backend with esbuild into a single file
- [ ] Final stage: minimal Node base image, copied bundle, copied `frontend/dist/`, runs the bundle directly with `node`
- [ ] `@fastify/static` serves `frontend/dist/` at `/` in production
- [ ] `docker build .` produces an image; `docker run -p 3000:3000 -e DATABASE_URL=... <image>` boots and serves the frontend at `/` and the API at `/api/*`
- [ ] `fly.toml` declares region `lhr`, the listening port, `auto_stop_machines = "stop"`, `min_machines_running = 0`, and the health-check path (`/api/health` — endpoint built in FEAT-46)
- [ ] Image size is reasonable (< ~300 MB; smaller is better with `node:lts-slim` or `node:lts-alpine` + esbuild bundling)

**Implementation notes:**
- esbuild config: `platform: 'node'`, `format: 'esm'`, `bundle: true`, `target: 'node20'` (or current LTS), `external: []` (bundle everything except optional native modules — verify which deps must remain external; native bindings for `pg` typically need to be installed, not bundled).
- `.dockerignore` must exclude `node_modules`, `**/dist`, `.env*`, `.git`.

**Manual verification:**
1. `docker build -t loftys-larder .`
2. `docker run --rm -p 3000:3000 -e DATABASE_URL=<local> loftys-larder`
3. Visit `http://localhost:3000` — frontend loads; API call to `health.ping` succeeds.

**Common gotchas:**
- `pg` and other native-binding deps may need to stay outside the bundle. Mark them `external` in esbuild and include them via a stripped `package.json` in the final stage, or use an SEA-style bundler. Verify what works for the chosen dep set.
- Multi-stage caching: order COPYs so `package.json` and lockfile come before source code; dependency installs cache between rebuilds.
- Don't run as root in the final image; create a non-root user.

**Definition of done:**
- Tests cover: not applicable (build artefact verification only).
- Commit: `feat(infra): production Dockerfile and fly.toml`
- Gate check: locally-built image serves the frontend at `/` and answers `health.ping` at `/api/trpc/`.

---

### FEAT-06 — Fly.io initial deploy + Cloudflare DNS

**Goal:** A one-shot `flyctl deploy` puts the production image live, reachable via the registered domain through Cloudflare orange-cloud DNS with `/api/*` bypassing cache. `[DEC-TBD: Cloudflare in front of Fly with /api/* cache bypass]`

**Estimate:** 3–4 hr (ops-heavy, includes domain purchase, DNS propagation waits). **Depends on:** FEAT-05. **Enables:** FEAT-13, FEAT-48.

**Files:**
- `fly.toml` (updated with app name)
- `README.md` deploy section
- Notes captured to feed `OPERATIONS.md` later (FEAT-50)

**Acceptance criteria:**
- [ ] Domain registered via Cloudflare Registrar
- [ ] `flyctl launch` (or `flyctl apps create` + `flyctl deploy`) deploys the image to `lhr`
- [ ] Custom domain attached to the Fly app; Fly certificate issued and validated
- [ ] Cloudflare DNS proxied (orange cloud) pointing to the Fly app
- [ ] Cloudflare cache rule: bypass cache for `/api/*`
- [ ] HTTPS works from a browser on both the apex and a `www` subdomain (decide and document which is canonical)
- [ ] Frontend loads; `health.ping` succeeds against the production URL

**Implementation notes:**
- Park the domain at this stage; email setup (SPF/DKIM/DMARC for Resend) lands in FEAT-13.
- Use `flyctl secrets set DATABASE_URL=…` before attaching Postgres in FEAT-09 — or rely on `flyctl postgres attach` to inject it.
- Document every CLI command run; many of these are not idempotent and will be needed for the restore drill (FEAT-50).

**Manual verification:**
1. `curl -I https://<domain>/` returns 200 with Cloudflare headers.
2. `curl https://<domain>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D` returns the expected shape.
3. Cloudflare dashboard shows `/api/*` cache rule active.

**Common gotchas:**
- Fly issues two certs (Let's Encrypt and Cloudflare-origin). Both should validate before declaring done.
- Cloudflare's "Always Use HTTPS" + Fly's HTTP→HTTPS redirect can produce a redirect loop. Pin one side as the redirect authority.
- Orange-cloud + HTTP/3 on Cloudflare with an HTTP/1.1 origin: not a problem in practice but worth verifying.

**Definition of done:**
- Tests cover: not applicable.
- Commit: `chore(infra): deploy to Fly behind Cloudflare DNS`
- Gate check: hit the production URL in a browser, see the frontend with a live `health.ping` round-trip.

---

### FEAT-07 — GitHub Actions CI

**Goal:** Every push to any branch runs lint, typecheck, and one placeholder test in CI.

**Estimate:** 1–2 hr. **Depends on:** FEAT-01. **Enables:** FEAT-48 (deploy workflow extends this).

**Files:**
- `.github/workflows/ci.yml`
- Root `package.json` scripts: `lint`, `typecheck`, `test`
- `vitest.config.ts` (one in each workspace that has tests)
- `eslint.config.js`, `.prettierrc`

**Acceptance criteria:**
- [ ] Workflow triggers on `push` to all branches and `pull_request` to `main`
- [ ] Uses `pnpm/action-setup` with the lockfile-matching version
- [ ] Caches the pnpm store keyed on `pnpm-lock.yaml`
- [ ] Runs `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`
- [ ] At least one passing Vitest test exists (placeholder) so the test step is meaningful
- [ ] Workflow runs in under ~3 minutes for a no-op change

**Implementation notes:**
- A single job is fine at this stage; split into matrix/parallel jobs only if wall time becomes annoying.
- ESLint config: `@typescript-eslint` strict-type-checked rules; let Prettier handle formatting.

**Manual verification:**
1. Push a branch with an intentional type error — CI fails on the typecheck step.
2. Push a fix — CI green.

**Common gotchas:**
- Forgetting to pin the pnpm version in `package.json` `packageManager` causes drift between local and CI.
- `pnpm -r test` will silently pass if no workspace has a test script. Confirm the placeholder test actually runs.

**Definition of done:**
- Tests cover: one placeholder Vitest test in `/backend` or `/shared`.
- Commit: `ci: lint, typecheck, and test on every push`
- Gate check: an intentionally broken PR shows red checks in the GitHub UI.

---

### FEAT-08 — `pg-pool` sizing decision (estimated; load run deferred)

**Goal:** Commit a `pg-pool` size and confirm the Fly machine class so FEAT-09 has a number to consume. Per DEC-71, document the reasoning and the revisit triggers. The synthetic-load run the original plan called for is deferred — `health.ping` doesn't hit the DB yet, so a measurement now would only probe the Node baseline, not the real `pg-pool` allocation under traffic. FEAT-09 opens that measurement window if the estimate proves wrong. `[DEC-TBD: pg-pool size committed in Phase 1; estimated against workload ceiling + image footprint, with named revisit triggers]`

**Estimate:** 30 min (docs only). **Depends on:** FEAT-06 (for the runtime image footprint reference in the FEAT-05 session note). **Enables:** FEAT-09.

**Files:**
- `docs/measurements.md` — chosen pool size, machine class, reasoning, revisit triggers.
- `fly.toml` — confirmed unchanged at `shared-cpu-1x@512mb` (no edit; the FEAT verifies the decision rather than touching the file).

**Acceptance criteria:**
- [ ] A pool size in the 5–10 range is committed in `docs/measurements.md` with the reasoning written down.
- [ ] The Fly machine class is confirmed in `docs/measurements.md` (and matches the live `fly.toml`).
- [ ] The file explicitly flags itself as an *estimate*, not a measurement, so future archaeology isn't misled.
- [ ] DEC-71's revisit triggers are listed, plus the FEAT-specific addendum (FEAT-09 traffic with peak RSS > 70% of the machine ceiling, or sustained `pg-pool` queue depth > 0).
- [ ] DEC-71 and `docs/plan.md`'s three "measure" references are updated to match the estimate framing.

**Implementation notes:**
- The synthetic-load procedure (autocannon against the deployed `health.ping`, `flyctl machine status --json` snapshots, dashboard memory chart) is captured *in `docs/measurements.md`* as the procedure to run if a revisit trigger fires. Don't lose it — that's the empirical fallback.
- Don't tick the FEAT-08 boxes; that's a human action.

**Manual verification:** The decision is reviewable in `docs/measurements.md`; the pool size value gets used in FEAT-09.

**Common gotchas:**
- The instinct to pick the lower end of the range "to be safe" inverts the cost asymmetry. Connection-exhaustion is a correctness failure; over-provisioning is a few idle sockets. Default to the upper bound at this scale.
- Don't downgrade the machine class to 256MB pre-emptively just because the FEAT-05 image footprint is small — wait for FEAT-09's real DB load before reclaiming that headroom.

**Definition of done:**
- Tests cover: not applicable.
- Commit: `docs(infra): record pg-pool sizing decision (estimated; revisit per DEC-71)`
- Gate check: open `docs/measurements.md`; the chosen pool size, machine class, reasoning, and revisit triggers are all present, and the file explicitly flags itself as an estimate.

---

## Phase 2 — Database & auth

### FEAT-09 — Drizzle infrastructure

**Goal:** Wire up Drizzle with its migration tooling, pg-pool sized per FEAT-08, snake_case→camelCase column mapping, and the `$onUpdate` hook for `updatedAt`. `[DEC-TBD: snake_case in DB, camelCase in code]` `[DEC-TBD: updatedAt via $onUpdate, not relied on as convention]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-02, 08. **Enables:** FEAT-10, 11, 12, every backend procedure.

**Reuse note:** The `householdId` constant (`CURRENT_HOUSEHOLD_ID` from a config module) is introduced here and every domain query for the rest of the project consumes it. Co-locate it with the Drizzle DB instance so it's hard to forget. `[DEC-TBD: CURRENT_HOUSEHOLD_ID as config constant, no scope threading]`

**Files:**
- `backend/src/db/index.ts` (Drizzle instance + pool)
- `backend/src/db/schema/index.ts` (barrel; per-table files added in 10/11/12)
- `backend/drizzle.config.ts`
- `backend/src/config.ts` (extended with `CURRENT_HOUSEHOLD_ID`)
- `backend/package.json` (deps: `drizzle-orm`, `drizzle-kit`, `pg`, `@types/pg`)

**Acceptance criteria:**
- [ ] `pg-pool` configured with size from FEAT-08
- [ ] Drizzle instance exported with type-safe schema map (empty schema OK at this stage)
- [ ] `drizzle-kit generate` and `drizzle-kit migrate` run from a workspace script
- [ ] Migrations directory committed (`backend/drizzle/`)
- [ ] `CURRENT_HOUSEHOLD_ID` constant exposed from config; documented as the read site every domain query must use
- [ ] A `withTransaction(fn)` helper exported for multi-statement writes

**Implementation notes:**
- Use Drizzle's column name mapping (`name: varchar('name')` declared on a camelCase property, mapping to snake_case at the column level).
- The `withTransaction` helper sits at the DB module and is the only sanctioned way to wrap multi-statement work — patterns that bypass it will skew transaction-boundary discipline.
- Don't add tables yet; this feature is plumbing only.

**Manual verification:**
1. `pnpm --filter backend db:generate` produces an (empty) migration.
2. `pnpm --filter backend db:migrate` runs cleanly against the Compose Postgres.
3. Reading the source, `CURRENT_HOUSEHOLD_ID` is obviously the canonical scope read.

**Common gotchas:**
- Pool exhaustion under test concurrency. Tests need either a smaller pool or a per-test connection pattern.
- `drizzle-kit` sometimes generates migrations against a stale schema if not run after every schema change; CI should fail if `git status` shows uncommitted migrations.

**Definition of done:**
- Tests cover: Drizzle DB instance constructs and `select 1` round-trips (Testcontainers smoke).
- Commit: `feat(db): wire up Drizzle with pg-pool, migrations, and household scope constant`
- Gate check: run an empty migration against local Postgres; subsequent `health.ping`-style probe with a `db.execute(sql\`select 1\`)` returns the expected value.

---

### FEAT-10 — Schema: auth, household, reference tables (with seeds)

**Goal:** Add the Better Auth tables (users with `theme_preference`, sessions, accounts, verifications), `households` (single seed row), and the read-only reference tables — `ingredient_categories`, `units_of_measurement`, `preparation_types`, `meal_occasions` (Lunch, Dinner) — with their seed data. `[DEC-TBD: single-household MVP, schema multi-tenancy-ready]` `[DEC-TBD: theme_preference column on users]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-09. **Enables:** FEAT-11, 12, 14.

**Files:**
- `backend/src/db/schema/auth.ts` (per Better Auth's required shape)
- `backend/src/db/schema/household.ts`
- `backend/src/db/schema/reference.ts`
- `backend/src/db/seeds/reference.ts`
- `backend/src/db/seeds/household.ts`
- `backend/src/db/seeds/index.ts` (`runSeeds` runner; CLI + tests both consume it)
- A seed runner script (`backend/scripts/seed.ts`)

**Acceptance criteria:**
- [ ] Better Auth tables match the library's expected shape (verify against Better Auth's Drizzle adapter docs)
- [ ] `users.themePreference` enum (`system | light | dark`, default `system`)
- [ ] `households` has a `name` column and one seeded row; `id uuid PK` matching `CURRENT_HOUSEHOLD_ID` from `backend/src/config.ts` (chosen over the spec's original `smallint` to align with DEC-17's multi-tenancy-ready clause; rationale in `docs/session-notes.md` FEAT-10 entry)
- [ ] All reference tables have `UNIQUE` on the user-visible name field
- [ ] `meal_occasions` seeded with Lunch and Dinner
- [ ] Seeds are idempotent (re-run safely)
- [ ] Migration applied to local DB; `\d users` and `\d ingredient_categories` show expected shape

**Implementation notes:**
- Seed runner: read seed modules and `INSERT … ON CONFLICT DO NOTHING` for idempotence; all inserts wrapped in a single `withTransaction` (cross-cutting #4) so a mid-sequence failure rolls everything back.
- Better Auth may require specific column names/types — follow its docs precisely; if there's a mismatch, the magic-link flow fails late and confusingly.
- Reference seeds beyond Lunch/Dinner are opinionated MVP lists (`INGREDIENT_CATEGORIES`, `UNITS_OF_MEASUREMENT`, `PREPARATION_TYPES` exported from `backend/src/db/seeds/reference.ts`). Edit at source — not via DB-only inserts — so reseeding stays authoritative.

**Manual verification:**
1. `pnpm --filter backend db:migrate` then `pnpm --filter backend seed`.
2. `psql` and confirm one household row, two meal occasions, expected categories/units/prep types.

**Common gotchas:**
- Better Auth uses string IDs for users; downstream FKs must match the column type exactly.
- Don't seed user rows here — users are created via the auth flow (FEAT-14).

**Definition of done:**
- Tests cover: seeds are idempotent on a second run; required reference rows exist after seeding.
- Commit: `feat(db): auth tables, household, and reference data with seeds`
- Gate check: fresh DB → migrate → seed → reference tables fully populated; `select count(*) from households` returns 1.

---

### FEAT-11 — Schema: recipes domain

**Goal:** Add `ingredients`, `recipes` (with `is_base`, `base_recipe_id`, `paired_recipe_id` and their CHECK constraints), `recipe_ingredients` (surrogate PK, no uniqueness), `recipe_method`, `recipe_drafts`, `recipe_sources`, `related_recipes`, `recipe_ratings`, `recipe_comments`. Include the trigram GIN indexes. `[DEC-TBD: surrogate key on recipe_ingredients, duplicates intentional]` `[DEC-TBD: paired_recipe_id symmetry maintained in app, not DB]` `[DEC-TBD: soft-delete recipes for historical plan rendering]` `[DEC-TBD: server-side draft persistence keyed by user+recipe]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-10. **Enables:** FEAT-17, 19, 20, 22, 24, 25, 26.

**Files:**
- `backend/src/db/schema/ingredients.ts`
- `backend/src/db/schema/recipes.ts` (recipes + recipe_ingredients + recipe_method + recipe_sources)
- `backend/src/db/schema/recipe-drafts.ts`
- `backend/src/db/schema/recipe-social.ts` (related, ratings, comments)
- New migration files

**Acceptance criteria:**
- [ ] All listed tables created with columns, FKs, CHECKs, UNIQUEs, and `ON DELETE` actions matching `plan.md`'s data model
- [ ] `pg_trgm` extension enabled in a migration before the GIN indexes
- [ ] GIN indexes on `lower(name)` for `ingredients` and `recipes`
- [ ] CHECK on `recipes`: `base_recipe_id != recipe_id`, `NOT (is_base AND base_recipe_id IS NOT NULL)`, `paired_recipe_id != recipe_id`
- [ ] CHECK on `related_recipes`: `recipe_one_id < recipe_two_id`
- [ ] `recipe_ingredients` has surrogate `recipe_ingredient_id`, no `(recipe_id, ingredient_id)` unique constraint
- [ ] `recipe_drafts`: `UNIQUE (user_id, recipe_id)` (relying on Postgres NULL semantics for multiple new-recipe drafts); `user_id` FK `ON DELETE RESTRICT`
- [ ] All tombstone-able FK columns set to `ON DELETE SET NULL` (per plan), the rest `ON DELETE RESTRICT`

**Implementation notes:**
- The `is_base`/`base_recipe_id` CHECK enforces the "base XOR batch-version" rule at the DB layer; symmetry of `paired_recipe_id` stays in application code.
- The trigram index migration must `CREATE EXTENSION IF NOT EXISTS pg_trgm` before index creation.
- Self-referential FKs in Drizzle need a forward declaration pattern; verify the codegen handles it.

**Manual verification:**
1. Migration applies cleanly.
2. `psql`: `\d recipes` shows all expected columns, constraints listed, indexes present.
3. Attempt insert violating each CHECK from psql; each is rejected.

**Common gotchas:**
- A user trying to FK to `users.id` will fail if the column type doesn't exactly match Better Auth's user PK.
- `paired_recipe_id` `ON DELETE SET NULL`: this nulls the other side of the pair via DB; the app-layer symmetry maintenance (FEAT-23) must handle the case where the other side is already null (no-op).

**Definition of done:**
- Tests cover: each CHECK constraint rejects bad inserts; FK `ON DELETE` actions behave as specified (e.g. deleting a user nulls `recipes.added_by_user_id` if RESTRICTed elsewhere isn't violated — actually `added_by_user_id` is SET NULL so user deletion paths get exercised in FEAT-35 tests).
- Commit: `feat(db): recipes, ingredients, drafts, and social tables`
- Gate check: migration runs; `\d` of each table matches the data model spec; CHECK constraint violations rejected from psql.

---

### FEAT-12 — Schema: meal plans and shopping list items

**Goal:** Add `meal_plans`, `meal_plan_slots` (including `cooks_base_recipe_id` / `cooks_base_servings` with their joint-set CHECK), and `shopping_list_items` (composite PK, lazy-created at read time in FEAT-38). `[DEC-TBD: slot states as enum, not dummy recipes]` `[DEC-TBD: lazy-create shopping_list_items on first GET]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-11. **Enables:** FEAT-27, 30, 35, 36.

**Files:**
- `backend/src/db/schema/meal-plans.ts`
- `backend/src/db/schema/shopping-list.ts`
- New migration

**Acceptance criteria:**
- [ ] `meal_plans` columns and `CHECK (start_date <= end_date)` per plan
- [ ] `meal_plan_slots`: `UNIQUE (plan_id, date, occasion_id)`; slot-type enum; `CHECK ((slot_type = 'recipe') = (recipe_id IS NOT NULL))`; joint-set CHECK on `cooks_base_recipe_id`/`cooks_base_servings` with `> 0` guard
- [ ] `cooks_base_recipe_id` FK to `recipes(recipe_id)` `ON DELETE RESTRICT`
- [ ] `shopping_list_items`: composite PK `(plan_id, ingredient_id)`, `is_checked boolean DEFAULT false`
- [ ] `meal_plans.created_by_user_id` and `meal_plan_slots.chef_user_id` both `ON DELETE SET NULL`
- [ ] CHECK that `number_of_servings IS NOT NULL` when `slot_type = 'recipe'`

**Implementation notes:**
- The `slot_type` enum is a Postgres `enum` type; declare it once and reuse via Drizzle's `pgEnum`.
- Application-layer validation that `cooks_base_recipe_id` references a recipe with `is_base = true` lives in FEAT-30; the DB only enforces the FK and joint-set.

**Manual verification:**
1. Migration applies; `\d meal_plan_slots` shows all CHECKs and the unique constraint.
2. From psql, try inserting a slot with `slot_type='recipe'` and `recipe_id IS NULL` — rejected.

**Common gotchas:**
- Postgres enums are awkward to extend later; if you anticipate a future slot type, add it now or accept a migration cost later.
- The "is_base = true" check is *application*-layer; do not be tempted to push it into a DB trigger — it's cheaper in code and matches the rest of the project's style.

**Definition of done:**
- Tests cover: each CHECK rejects the bad case; the unique constraint enforces one slot per (plan, date, occasion); FK on `cooks_base_recipe_id` rejects deletion of a referenced recipe.
- Commit: `feat(db): meal plans, slots, and shopping list items`
- Gate check: insert a plan, generate slots in psql, observe CHECK violations on misuse.

---

### FEAT-13 — Resend domain verification

**Goal:** Verify the production domain with Resend; set SPF, DKIM, and DMARC DNS records so magic-link emails reach inboxes reliably. `[DEC-TBD: Resend for magic-link email; Postmark as fallback if deliverability degrades]`

**Estimate:** 1–2 hr (mostly DNS waiting). **Depends on:** FEAT-06. **Enables:** FEAT-14.

**Files:** notes captured for `OPERATIONS.md` (FEAT-50).

**Acceptance criteria:**
- [ ] Resend account created; domain added
- [ ] SPF, DKIM, and DMARC records set in Cloudflare DNS per Resend's instructions
- [ ] Resend dashboard reports domain as verified
- [ ] A test send from the Resend console to a personal inbox arrives, passes SPF/DKIM/DMARC checks (verify via Gmail's "show original")

**Implementation notes:**
- DMARC: start with `p=none` so failures are visible without blocking; tighten later once real send volumes confirm alignment.
- A `from` address on the verified domain is required (e.g. `magic@<domain>`).

**Manual verification:**
1. Resend dashboard → Domains → green checkmark on the production domain.
2. Test send arrives in Gmail with no spam-folder routing; "show original" shows SPF/DKIM/DMARC = pass.

**Common gotchas:**
- Cloudflare proxying applies to A/AAAA/CNAME records by default; TXT records (SPF, DMARC) and the DKIM CNAME are unaffected, but verify the DKIM CNAME isn't accidentally proxied.
- DNS propagation can lag; allow up to a few hours before declaring failure.

**Definition of done:**
- Tests cover: not applicable.
- Commit: `chore(infra): document Resend domain verification`
- Gate check: a test email from Resend lands in a real inbox with all three auth checks passing.

---

### FEAT-14 — Better Auth integration (server)

**Goal:** Mount Better Auth at `/api/auth/*` with the magic-link provider via Resend, the Drizzle adapter, session cookies with `HttpOnly`/`SameSite=lax`/CSRF, and a Fastify pre-handler hook that rejects unauthenticated requests outside `/api/auth/*`. `[DEC-TBD: magic-link only, no passwords]` `[DEC-TBD: HttpOnly session cookies, SameSite=lax, CSRF enabled]` `[DEC-TBD: pre-handler hook enforces auth outside /api/auth/*]` `[DEC-TBD: Better Auth choice — young library, migration plan documented]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-10, 13. **Enables:** FEAT-15, every subsequent procedure (which assumes a session in context).

**Files:**
- `backend/src/auth/index.ts` (Better Auth config + Resend send fn)
- `backend/src/server.ts` (mount Better Auth handler at `/api/auth/*`, register pre-handler)
- `backend/src/trpc/context.ts` (extract session from request)
- `backend/src/trpc/init.ts` (`protectedProcedure` helper)

**Acceptance criteria:**
- [ ] Better Auth's handler mounted at `/api/auth/*` correctly (routes for sign-in, magic-link verify, session, sign-out)
- [ ] Drizzle adapter wired to the schema from FEAT-10
- [ ] Magic-link send goes through Resend with the verified `from` address
- [ ] Magic-link expiry set to 10 minutes
- [ ] Session cookie: `HttpOnly`, `Secure` in prod, `SameSite=lax`, signed
- [ ] CSRF protection per Better Auth defaults
- [ ] Fastify pre-handler rejects unauthenticated requests outside `/api/auth/*`, `/api/health` (when added), and (in dev) `/api/trpc/health.ping`
- [ ] tRPC context exposes `session` and `user`; `protectedProcedure` throws `TRPCError({ code: 'UNAUTHORIZED' })` if absent

**Implementation notes:**
- The Resend send function is a small adapter Better Auth calls with the link URL and recipient; keep the template plain text + a single link.
- The pre-handler must `return done()` quickly for unauth routes — don't read the session for them.
- `protectedProcedure` is the default for all domain procedures; expose `publicProcedure` only for the very small set of routes that genuinely need it.

**Manual verification:**
1. POST to the magic-link request endpoint with a fresh email; check the inbox; the email contains a valid link.
2. Click the link; cookie set; subsequent `/api/auth/session` call returns the user.
3. Hit `/api/trpc/health.ping` without a session cookie → 401. Hit it with the session cookie → 200.

**Common gotchas:**
- Better Auth and Fastify cookie plugins can fight over `Set-Cookie`. Verify cookies are set with the expected flags in production (`Secure`, `__Host-` prefix if used).
- The CSRF token must accompany state-changing requests; the tRPC client config in FEAT-15 needs to send it.
- A pre-handler that *fetches* the session for every request creates a DB round-trip per request — Better Auth typically reads from the cookie/JWT first; verify your config doesn't accidentally query the DB unnecessarily.

**Definition of done:**
- Tests cover: magic-link request creates a verification row; verification with a valid token creates a session; expired and reused tokens are rejected; `protectedProcedure` throws when called without a session; pre-handler lets `/api/auth/*` through.
- Commit: `feat(auth): integrate Better Auth with magic-link provider via Resend`
- Gate check: real email → click link → authenticated session works end-to-end against the local stack.

---

### FEAT-15 — Sign-in UI + verification + protected routing

**Goal:** Frontend flow — email entry → "magic link sent" confirmation; verification handler route extracts the token, calls Better Auth, redirects to the app; a TanStack Router protected layout that redirects unauthenticated users to sign-in.

**Estimate:** 2–3 hr. **Depends on:** FEAT-04, 14. **Enables:** all authenticated frontend views.

**Files:**
- `frontend/src/routes/sign-in.tsx`
- `frontend/src/routes/auth/verify.tsx` (or the path Better Auth's client expects)
- `frontend/src/routes/_authed.tsx` (protected layout)
- `frontend/src/lib/auth-client.ts` (Better Auth client)
- `frontend/src/lib/trpc.ts` (extended: send CSRF, handle 401)

**Acceptance criteria:**
- [ ] Sign-in page: email input with React Hook Form + Zod; submit calls Better Auth's `signIn.magicLink({ email })`
- [ ] After submit, page shows a "Check your email" confirmation
- [ ] Verification route consumes the token from the URL, completes sign-in, redirects to `/`
- [ ] `_authed` layout calls `useSession()`; redirects to `/sign-in` when unauthenticated
- [ ] tRPC client treats `UNAUTHORIZED` responses by redirecting to `/sign-in`
- [ ] Existing logged-in user visiting `/sign-in` is redirected to `/`

**Implementation notes:**
- Show the email input in a disabled state during the network call; expose any send error inline.
- Verification route should handle the failure cases (expired, used, invalid) with distinct messages.

**Manual verification:**
1. Open sign-in, enter an email, see confirmation.
2. Click the link in the email — land in the app, authenticated.
3. Open an incognito window, try a protected route — redirected to sign-in.
4. Tamper with the verification token URL — error displayed.

**Common gotchas:**
- TanStack Router's `beforeLoad` is the right hook for redirect logic; doing it in `useEffect` after render is a UX papercut and may flash protected content.
- The verification route should be reachable without auth itself — exempt it from the protected layout.

**Definition of done:**
- Tests cover: sign-in form validates email; protected layout redirects when no session; verification route renders the three failure states.
- Commit: `feat(auth): sign-in UI, magic-link verification, and protected routing`
- Gate check: full magic-link sign-in flow in a local browser — request → email → click → app.

---

### FEAT-16 — Profile settings (name + theme + ThemeProvider)

**Goal:** A profile/settings page where the user can update their `name` and `themePreference`; a `ThemeProvider` reads the preference from the session, applies a `dark` class to `<html>`, and respects `prefers-color-scheme` when set to `system`. `[DEC-TBD: themePreference persisted per-user in DB so it follows across devices]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-10, 15. **Enables:** FEAT-35 (account deletion adds to this page).

**Files:**
- `backend/src/trpc/routers/user.ts` (procedures: `getMe`, `updateProfile`)
- `frontend/src/routes/_authed/settings.tsx`
- `frontend/src/lib/theme-provider.tsx`
- `frontend/src/app.tsx` (wrap with `ThemeProvider`)
- `shared/src/schemas/user.ts` (Zod for profile update)

**Acceptance criteria:**
- [ ] `user.updateProfile` takes `{ name?: string, themePreference?: 'system' | 'light' | 'dark' }`, validates, updates the row
- [ ] Settings page shows current name (editable) and a theme radio/select with three options
- [ ] `ThemeProvider` applies/removes `dark` on `<html>` based on the resolved theme
- [ ] When `themePreference = 'system'`, the provider subscribes to `matchMedia('(prefers-color-scheme: dark)')` and updates live
- [ ] Theme persists across sessions and devices (read from the user row, not localStorage)
- [ ] Unauthenticated/initial-render falls back to `system`

**Implementation notes:**
- The `matchMedia` listener must be cleaned up on unmount.
- shadcn/ui components are dark-mode-aware via Tailwind's `dark:` variants — no extra config needed once the class is set.

**Manual verification:**
1. Toggle theme on desktop, sign in on another device — theme follows.
2. Set to `system`, change OS appearance — UI flips live.
3. Update name; refresh; new name persists.

**Common gotchas:**
- Flash of incorrect theme on initial paint: read the cached preference before React hydrates if avoidable, or accept a small flash and document.
- Don't ship a localStorage shadow of the preference — that contradicts the cross-device promise.

**Definition of done:**
- Tests cover: name update round-trips; themePreference round-trips; ThemeProvider applies the right class on each setting; `system` follows `prefers-color-scheme`.
- Commit: `feat(user): profile settings with name update and theme preference`
- Gate check: change theme to dark, refresh — page is dark; change name, refresh — new name shown.

---

## Phase 3 — Recipes & ingredients

### FEAT-17 — Ingredient CRUD + Dictionary view

**Goal:** tRPC procedures for ingredients (`list`, `create`, `update`, `delete`) and the Ingredient Dictionary view; deletion fails with `TRPCError({ code: 'CONFLICT', cause: { code: 'INGREDIENT_IN_USE' } })` if any recipe (including soft-deleted) references the ingredient. `[DEC-TBD: single enforced unit per ingredient as data invariant]` `[DEC-TBD: domain error codes attached via TRPCError.cause]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-11, 14, 16. **Enables:** FEAT-19, 21.

**Reuse note:** This is the first procedure file. It sets the patterns later procedures inherit: how Zod input schemas are organised in `/shared`, the shape of list responses, how `CURRENT_HOUSEHOLD_ID` scoping is applied, how domain errors attach to `TRPCError.cause`, and how the frontend's tRPC error link maps codes to UI. Spend the time to get these conventions right.

**Files:**
- `backend/src/trpc/routers/ingredients.ts`
- `shared/src/schemas/ingredients.ts`
- `frontend/src/routes/_authed/ingredients.tsx`
- `frontend/src/components/ingredient-form.tsx`
- `frontend/src/lib/trpc.ts` (extend the error link to surface domain codes)

**Acceptance criteria:**
- [ ] `list` returns all ingredients for the household, joined to category and default unit (denormalised for the dictionary view), ordered by name
- [ ] `create` validates: name non-empty, category exists, default unit exists, `is_plant` boolean, shelf life optional positive int
- [ ] `update` allows changing any field (subject to validation); old recipes pick up the change via FK reference
- [ ] `delete` returns `CONFLICT` with `INGREDIENT_IN_USE` cause if any row in `recipe_ingredients` references it (including soft-deleted recipes); otherwise hard-deletes
- [ ] Search by substring uses the `pg_trgm` GIN index on `lower(name)` (`ILIKE`)
- [ ] Dictionary view: list with search box, add-new dialog, edit dialog, delete with confirm; confirmation surfaces the `INGREDIENT_IN_USE` error gracefully

**Implementation notes:**
- Every query scopes by `CURRENT_HOUSEHOLD_ID` — set this pattern explicitly in the file's first procedure and reuse.
- The "in use" check is a single `EXISTS` query against `recipe_ingredients` joined to `recipes` (no `is_deleted` filter — soft-deleted recipes count).
- Zod schemas live in `/shared` and are imported by both the procedure and the form.

**Manual verification:**
1. Add an ingredient, edit it, search for it.
2. Use it in a recipe (after FEAT-21), attempt to delete → conflict surfaced in UI.
3. Soft-delete that recipe (after FEAT-20), attempt to delete the ingredient again → still conflicts.

**Common gotchas:**
- `ILIKE` without `lower()` + the trigram index will scan; both sides need to be lowered.
- Don't forget to scope listings by household; copying the pattern from one procedure to the next is how the scope discipline holds.

**Definition of done:**
- Tests cover: CRUD round-trip; unit enforcement at validation; `INGREDIENT_IN_USE` raised for active and soft-deleted recipe references; substring search returns expected matches.
- Commit: `feat(ingredients): CRUD procedures and dictionary view`
- Gate check: in the running app, add → edit → search → delete (succeeds when unused, fails when used) end-to-end.

---

### FEAT-18 — Cloudinary signed-upload procedure

**Goal:** A tRPC procedure that issues short-lived signed Cloudinary upload credentials with constrained presets (allowed formats, max size, fixed transformation). The browser uploads directly to Cloudinary; the backend never proxies binary data. `[DEC-TBD: direct browser → Cloudinary upload, no backend proxying]` `[DEC-TBD: orphaned uploads accepted as v1 debt]`

**Estimate:** 2 hr. **Depends on:** FEAT-14. **Enables:** FEAT-21.

**Files:**
- `backend/src/trpc/routers/uploads.ts`
- `backend/src/lib/cloudinary.ts` (signing helper)
- `shared/src/schemas/uploads.ts`
- Secrets: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOAD_PRESET` (or signed params)

**Acceptance criteria:**
- [ ] `uploads.getRecipeImageCredentials` returns `{ cloudName, apiKey, timestamp, signature, folder, allowedFormats, maxFileSize, transformation }` ready to be POSTed to Cloudinary's REST endpoint
- [ ] Signature is computed server-side with the API secret
- [ ] Signing parameters constrain: `allowed_formats: ['jpg','jpeg','png','webp']`, `max_file_size: 5_242_880` (5 MB), a fixed `eager` transformation
- [ ] Only authenticated users get credentials
- [ ] Credentials expire within a small window (e.g. 10 min via the `timestamp` parameter)

**Implementation notes:**
- The Cloudinary signature is `SHA1` over the alphabetised query string + API secret. Use Cloudinary's official SDK helper if available rather than rolling SHA1 by hand.
- Don't store anything server-side at this stage — the returned URL is saved on the recipe via `recipes.update` in FEAT-20.

**Manual verification:**
1. Call the procedure; receive credentials.
2. POST a file from `curl` to `https://api.cloudinary.com/v1_1/<cloud>/image/upload` using the credentials — upload succeeds and returns a `secure_url`.
3. POST a file exceeding 5 MB — rejected by Cloudinary.

**Common gotchas:**
- Storing the API secret in code or shipping it to the client. It belongs in `flyctl secrets`.
- The transformation pipeline is set at signing time; changing it later won't retroactively re-transform existing assets.

**Definition of done:**
- Tests cover: signature is computed deterministically for fixed inputs; the procedure refuses unauthenticated callers.
- Commit: `feat(uploads): Cloudinary signed-upload procedure for recipe images`
- Gate check: end-to-end manual upload from a test page or `curl` works against real Cloudinary.

---

### FEAT-19 — Recipe read procedures + browse view

**Goal:** Procedures: `recipes.list` (with filters: active/deleted, search, paged), `recipes.get` (by id, with method + ingredients + computed plant points + average rating + own rating), `recipes.search` (trigram); the Recipe Browse view (grid of cards). Filters out soft-deleted recipes from picker contexts; admin views (the dictionary's "deleted" tab) can opt in.

**Estimate:** 3–4 hr. **Depends on:** FEAT-11, 14. **Enables:** FEAT-21, 26, 31.

**Reuse note:** The recipe DTO shape defined here is consumed by the editor, the planner sidebar, the related-recipes UI, and the shopping list. Designing the shape once — including which fields are eager, which are lazy, what the plant-points field looks like — pays off for every downstream feature. Also define a `listForPicker` query option (or a flag) that filters soft-deleted recipes and (later) soft-deleted bases; this is the single sanctioned source of "what's pickable right now."

**Files:**
- `backend/src/trpc/routers/recipes.ts` (read procedures only at this stage)
- `shared/src/schemas/recipes.ts`
- `backend/src/lib/plant-points.ts` (recipe-level calculation, reused in FEAT-40)
- `frontend/src/routes/_authed/recipes/index.tsx`
- `frontend/src/components/recipe-card.tsx`

**Acceptance criteria:**
- [ ] `list` accepts `{ search?, includeDeleted?, includePickerHidden? }`; default returns non-deleted recipes the picker can use
- [ ] `get` returns the full recipe including ingredients (with prep type joined), method (ordered by step number), plant points (computed), source, image URL, macros, base/pair fields, and aggregates (avg rating, your rating)
- [ ] Trigram search is fast and case-insensitive
- [ ] Browse view: grid of cards, search box, no separate filters yet (delete/restore wired in FEAT-20)
- [ ] Plant-points calculation: `COUNT(DISTINCT ingredient_id) WHERE is_plant = true` at recipe level
- [ ] The `plant-points` helper is exported and importable by other routers (FEAT-40 will use it)

**Implementation notes:**
- Avoid N+1: `get` should fetch the recipe, its ingredients (with joined ingredient + prep type), its method, and aggregates in as few queries as the relational shape allows (typically 3–4).
- The "pickable" filter is the place to start the central pattern: a small `pickableRecipesQuery` helper that all subsequent picker UIs consume.

**Manual verification:**
1. Visit the recipes page; existing recipes show as cards.
2. Search by partial name; results filter correctly.
3. Click into a recipe (no editor yet — show a read view or stub) — full data loads.

**Common gotchas:**
- Lazily computing plant points on the frontend means duplicating logic in multiple places. Compute server-side.
- The trigram index won't help queries like `WHERE name ILIKE 'foo'` (no leading `%`); the v1 search assumes substring, so use `%foo%` and rely on the GIN.

**Definition of done:**
- Tests cover: `list` with and without `includeDeleted`; `get` returns the expected joined shape; plant-points calculation; trigram search ranking.
- Commit: `feat(recipes): read procedures and browse view`
- Gate check: load the recipes page with seeded data, see cards, click one, see the full read view.

---

### FEAT-20 — Recipe write procedures (create, update, replace, soft-delete, restore)

**Goal:** Procedures: `recipes.create`, `recipes.updateHeader` (partial), `recipes.replaceIngredients` (bulk replace), `recipes.replaceMethod` (bulk replace), `recipes.softDelete`, `recipes.restore`. Multi-statement saves wrapped in `withTransaction`. `[DEC-TBD: recipe edits propagate to past plans, no snapshotting]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-11, 14, 19. **Enables:** FEAT-21, 22, 23.

**Files:**
- `backend/src/trpc/routers/recipes.ts` (extends FEAT-19 file)
- `shared/src/schemas/recipes.ts` (extends)

**Acceptance criteria:**
- [ ] `create` validates inputs (name, baseServings ≥ 1, optional fields), inserts the row, returns the new id
- [ ] `updateHeader` accepts a partial subset of header fields; `name`, `description`, `image_url`, `base_servings`, macros, time fields, `source_id`, `source_url`
- [ ] `replaceIngredients` deletes the recipe's `recipe_ingredients` and inserts the new set inside a transaction; validates each row's unit against the ingredient's enforced unit
- [ ] `replaceMethod` deletes and re-inserts `recipe_method` rows in order inside a transaction
- [ ] `softDelete` sets `is_deleted = true`; `restore` clears it
- [ ] All writes scope by `CURRENT_HOUSEHOLD_ID`
- [ ] When `replaceIngredients` runs, the per-line `unit_id` must equal the ingredient's `default_unit_id` — otherwise `BAD_REQUEST`

**Implementation notes:**
- Bulk-replace is preferable to per-row diff at this scale and matches the editor's behaviour (every save sends the full list).
- Don't combine `updateHeader` with the bulk replaces — splitting lets the editor save header fields without round-tripping the entire ingredient list.
- The unit enforcement at the procedure boundary catches client-side mistakes; the form validation (FEAT-21) is the primary UX, but the boundary check is the integrity guarantee.

**Manual verification:**
1. Create a recipe via tRPC dev tools or a stub form.
2. Update its name; existing ingredients/method unaffected.
3. Replace its ingredient list; old rows gone, new rows present.
4. Try replacing with a unit mismatch — `BAD_REQUEST`.
5. Soft-delete; the read view still works (historical rendering); the list view hides it.

**Common gotchas:**
- Forgetting the transaction wrapper on bulk replaces leaves partial state if the second statement fails.
- The `paired_recipe_id` symmetry handling lives in FEAT-23; don't accept it as input here yet.

**Definition of done:**
- Tests cover: CRUD; partial header update only touches specified fields; bulk replace is transactional (failure rolls back); unit mismatch rejected; soft-delete/restore round-trip.
- Commit: `feat(recipes): write procedures with bulk-replace and soft-delete`
- Gate check: create-edit-delete-restore cycle works end-to-end via a probe; soft-deleted recipe still renders in a historical plan context (verifiable after FEAT-31).

---

### FEAT-21 — Recipe Editor UI

**Goal:** A form-driven recipe editor: image upload (Cloudinary direct), header fields, ingredient picker with per-line quantity and prep type, ordered method editor. Each section saves independently via the partial-update / bulk-replace procedures from FEAT-20. Built with RHF + Zod + shadcn/ui `Form` primitives.

**Estimate:** 4 hr. **Depends on:** FEAT-18, 19, 20. **Enables:** FEAT-22, 23.

**Reuse note:** The ingredient picker primitive built here is the same component (or a sibling) used by the slot editor's recipe picker (FEAT-31) and the base picker (FEAT-32). Build it as a generic combobox over a typeahead-search query, parameterised by the data source, not hardcoded to ingredients.

**Files:**
- `frontend/src/routes/_authed/recipes/$recipeId.edit.tsx`
- `frontend/src/routes/_authed/recipes/new.tsx`
- `frontend/src/components/recipe-editor/header-fields.tsx`
- `frontend/src/components/recipe-editor/ingredient-list.tsx`
- `frontend/src/components/recipe-editor/method-editor.tsx`
- `frontend/src/components/recipe-editor/image-uploader.tsx`
- `frontend/src/components/searchable-combobox.tsx` (reusable; consumed by the ingredient picker)
- `shared/src/schemas/recipes.ts` (reused)

**Acceptance criteria:**
- [ ] Editor loads existing recipe data (when editing) or starts blank (when creating)
- [ ] Header save submits `updateHeader` with only changed fields
- [ ] Ingredient list save submits `replaceIngredients`; each line has ingredient combobox, quantity input, optional prep-type select
- [ ] Method save submits `replaceMethod`; steps reorderable and addable/removable
- [ ] Image uploader: pick a file → request Cloudinary credentials → POST to Cloudinary → on success, save `image_url` via `updateHeader`
- [ ] Validation errors render inline (RHF + Zod)
- [ ] Successful section saves show a non-blocking toast and clear the section's dirty state

**Implementation notes:**
- Sections are independent forms. A user can save the header without touching ingredients.
- The combobox component takes a `searchQuery` function as a prop and renders a debounced typeahead; ingredient is the first consumer.
- The method editor needs reordering — `useFieldArray` + drag handles (or up/down buttons for accessibility) work fine; full DnD a11y not needed.

**Manual verification:**
1. New recipe: fill header → save → ingredients added → save → method → save → image uploaded → saved.
2. Edit existing recipe: change one field, save header only — confirms partial update.
3. Try saving an ingredient with the wrong unit (client validation should pre-empt; server backs it up).

**Common gotchas:**
- Cloudinary uploads must not block the rest of the form; show a progress indicator and don't disable other sections.
- RHF + Zod `zodResolver` doesn't auto-coerce types; `quantity` is `numeric` in DB; coerce on the form side.
- Re-fetching after save can cause input flicker if not handled carefully; rely on tRPC's optimistic update + `setQueryData` patterns.

**Definition of done:**
- Tests cover: header save, ingredient list save, method save, image upload happy path, validation surfacing.
- Commit: `feat(recipes): recipe editor UI with section-level saves`
- Gate check: create a brand-new recipe end-to-end from the UI, complete with image — appears on the browse page.

---

### FEAT-22 — Recipe draft autosave

**Goal:** The editor autosaves in-progress edits to `recipe_drafts` (debounced); loads any existing draft on open (keyed by `(user_id, recipe_id)`, with `recipe_id = NULL` for new recipes); clears the draft on successful save; clears on account deletion (handled in FEAT-35). `[DEC-TBD: server-side draft persistence over localStorage, for cross-device]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-11, 21. **Enables:** account-deletion cleanup (FEAT-35).

**Files:**
- `backend/src/trpc/routers/recipe-drafts.ts` (procedures: `upsert`, `getForRecipe`, `getNewDrafts`, `delete`)
- `shared/src/schemas/recipe-drafts.ts`
- `frontend/src/hooks/use-recipe-draft.ts`
- Editor components from FEAT-21 (extend to use the hook)

**Acceptance criteria:**
- [ ] `upsert` takes `{ recipeId: number | null, draftData: <jsonb shape> }`; inserts or updates the row keyed by `(user_id, recipe_id)`
- [ ] `getForRecipe` returns the draft if it exists; `null` otherwise
- [ ] Editor calls `upsert` debounced (~1 s) on any change
- [ ] On open, the editor loads draft data and merges it over server state, with a small notice that an unsaved draft exists (and a "discard draft" button)
- [ ] On successful save (`recipes.create` or `recipes.update*`), the draft is deleted in the same client flow
- [ ] A user can have multiple new-recipe drafts (Postgres NULL semantics on UNIQUE)
- [ ] Cross-device: a draft saved on phone is loaded on laptop for the same user

**Implementation notes:**
- The draft schema (`draftData` jsonb) is the union of editor fields; version it (`{ version: 1, fields: ... }`) so future shape changes are detectable.
- Debounce on the React side with a leading-edge silenced first call; cancel on unmount to avoid stale writes.
- "Discard draft" calls `delete` and re-fetches server state.

**Manual verification:**
1. Start editing a recipe; type without saving; reload the page — draft re-loads.
2. Same user signs in on another browser, opens the same recipe — draft re-loads.
3. Save the recipe — draft cleared.
4. Start two new recipes without saving — both drafts persist.

**Common gotchas:**
- Sending the full editor state on every keystroke is wasteful at scale, but at household scale it's fine; debounce is the optimisation.
- Versioned `draftData` matters when the editor's field set changes between deploys.

**Definition of done:**
- Tests cover: upsert behaviour, cross-device load (simulated by two sessions), delete on save, multiple new-recipe drafts allowed.
- Commit: `feat(recipes): server-side draft autosave with cross-device load`
- Gate check: in one browser, type a draft; in a second authenticated session, open the same recipe and see the draft.

---

### FEAT-23 — Batch cooking model + UI

**Goal:** Surface and enforce `is_base`, `base_recipe_id`, and `paired_recipe_id` in the recipe editor; maintain `paired_recipe_id` symmetry within the recipe-save transaction; filter the base picker to recipes with `is_base = true`; hide soft-deleted bases from new picker contexts. `[DEC-TBD: recipe pairing symmetry maintained in app, not DB]` `[DEC-TBD: batch-version cannot itself be a base (no nesting)]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-19, 20, 21. **Enables:** FEAT-30, 31, 33, 36 (aggregation traversal), 40 (plant-points traversal).

**Reuse note:** The "pickable recipes" filter helper from FEAT-19 gains an `isBase` parameter here. Keep one place that knows the rules of what's pickable; future picker contexts (recipe-bank, base picker, related picker) just pass different params.

**Files:**
- `backend/src/trpc/routers/recipes.ts` (extends with pair-symmetry transaction)
- `frontend/src/components/recipe-editor/batch-fields.tsx`
- `frontend/src/components/recipe-editor/header-fields.tsx` (integrate `is_base` toggle)

**Acceptance criteria:**
- [ ] Editor exposes: `is_base` checkbox; `base_recipe_id` picker (visible only when this recipe is a batch-version candidate — i.e. `is_base = false`; picker filtered to `is_base = true`); `paired_recipe_id` picker
- [ ] Server-side: setting `paired_recipe_id` updates both sides in a single transaction; clearing one side clears the other; if A→B exists and the user saves A→C, the transaction sets A→C, clears B's pointer to A, and sets C→A
- [ ] CHECK constraints from FEAT-11 enforce the XOR (`NOT (is_base AND base_recipe_id IS NOT NULL)`) and the self-reference bans
- [ ] Base picker hides soft-deleted bases; existing batch recipes pointing to a now-deleted base are not surfaced in the recipe picker for new slot assignment (verified in FEAT-31)
- [ ] Pair affordance hidden when the linked recipe is soft-deleted

**Implementation notes:**
- The pair-symmetry transaction is the trickiest write in the project. Cover with explicit tests for: new pairing, repairing (A→B becomes A→C), clearing pair, deleting a paired recipe (the FK `ON DELETE SET NULL` handles the cascade on hard-delete; soft-delete needs app-layer handling — hide the affordance but don't clear the pointer, because un-restore should re-surface it).
- The picker filter helper now takes `{ excludeDeleted?: boolean, onlyBases?: boolean, excludeBatchVersionsOfDeletedBases?: boolean }`.

**Manual verification:**
1. Mark a recipe as base; save; another recipe's base picker now offers it.
2. Pair two recipes; reload the other one — pair visible. Re-pair one side to a third recipe; original other side cleared.
3. Soft-delete a base; the base picker no longer offers it; existing batch recipes pointing to it still render but are filtered from new-slot picker.

**Common gotchas:**
- Soft-deleted base + active batch version is the source of subtle bugs. The rule is: keep historical references intact, hide from *new* selection contexts.
- The pair-symmetry transaction must use `FOR UPDATE` on the three rows touched if running under any meaningful concurrency; at household scale, LWW per row is acceptable per the plan.

**Definition of done:**
- Tests cover: setting/changing/clearing pair maintains symmetry round-trip; `is_base = true` with `base_recipe_id` set is rejected at the DB; soft-deleted base hidden from new-slot picker; soft-deleted base remains visible in the historical recipe view.
- Commit: `feat(recipes): batch cooking model with paired-recipe symmetry`
- Gate check: pair two recipes; soft-delete one; observe the pair affordance hides; restore — the affordance returns.

---

### FEAT-24 — Recipe ratings

**Goal:** Each user can leave at most one rating (1–5) per recipe; recipe summaries show average; detail views additionally show the logged-in user's own rating.

**Estimate:** 2 hr. **Depends on:** FEAT-11, 19. **Enables:** none specifically; quality-of-life.

**Files:**
- `backend/src/trpc/routers/recipes.ts` (extend with `rate`, `unrate`)
- `frontend/src/components/recipe-rating.tsx`
- Update `recipes.get` and `recipes.list` to return average and own rating

**Acceptance criteria:**
- [ ] `rate({ recipeId, rating })` upserts the row keyed on `(recipe_id, user_id)`
- [ ] `unrate({ recipeId })` deletes the row
- [ ] `recipes.get` returns `{ averageRating: number | null, ownRating: number | null, ratingCount: number }`
- [ ] `recipes.list` returns at least `averageRating` and `ratingCount` per card
- [ ] UI: star widget on recipe detail; clicking a star sets the rating; clicking the current value clears it

**Implementation notes:**
- Average is recomputed at read time; no denormalisation.
- `recipe_ratings` already has `UNIQUE (recipe_id, user_id)` from FEAT-11.

**Manual verification:** rate, refresh, see average update; clear rating; sign in as a different user and see only your own rating reflected as "own".

**Common gotchas:**
- The "own rating" field requires the procedure to know the current user; reuse the protected-procedure context.

**Definition of done:**
- Tests cover: upsert, delete, average aggregation, own-rating per session.
- Commit: `feat(recipes): user ratings`
- Gate check: rate a recipe, see the average update on the browse page card.

---

### FEAT-25 — Recipe comments

**Goal:** Per-user comments on recipes, ordered newest-first, editable/deletable by author only; rendered as plain text (no markdown, no HTML); `[deleted user]` placeholder when author tombstoned. `[DEC-TBD: all user-generated text rendered as plain text, no rich text or markdown]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-11, 19. **Enables:** none specifically.

**Files:**
- `backend/src/trpc/routers/recipes.ts` (extend with `addComment`, `editComment`, `deleteComment`, `listComments`)
- `frontend/src/components/recipe-comments.tsx`

**Acceptance criteria:**
- [ ] `addComment` validates non-empty text, max length (e.g. 2000 chars), inserts a row
- [ ] `editComment` allowed only when `user_id` matches; updates `comment` and sets `last_updated_at`
- [ ] `deleteComment` allowed only when `user_id` matches; hard-deletes
- [ ] `listComments(recipeId)` returns newest-first, joined to the user's display name; null author renders as `[deleted user]`
- [ ] Comments rendered as plain text (no markdown parsing, no `dangerouslySetInnerHTML`)
- [ ] Edit and delete affordances hidden when the viewer is not the author

**Implementation notes:**
- React's text-content escaping is the XSS defence; do not add markdown or any HTML interpretation.
- The author-only authorisation lives at the procedure layer; the frontend hiding is UX, not security.

**Manual verification:**
1. Add a comment; edit it; delete it.
2. Sign in as another user; see the comment; can't edit or delete it.
3. Trigger tombstoning (after FEAT-35); the comment renders as `[deleted user]`.

**Common gotchas:**
- Long comments + many recipes: paginate if comment counts grow, but at household scale just return all newest-first.
- A user could try to send HTML in the text — fine because React escapes; but never accept it into a markdown parser later.

**Definition of done:**
- Tests cover: CRUD, author-only edit/delete, render-as-text on the backend (procedure returns string, not HTML), tombstoned user rendering.
- Commit: `feat(recipes): user comments`
- Gate check: add a comment, see it on the recipe detail; another browser sees it but can't edit.

---

### FEAT-26 — Related recipes

**Goal:** Manually-linked pairs of recipes, surfaced symmetrically on both, with no self-links and no duplicates; soft-deleted recipes hidden from related lists but kept in the table for historical rendering. `[DEC-TBD: related_recipes symmetric via composite PK with CHECK]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-11, 19. **Enables:** none specifically.

**Files:**
- `backend/src/trpc/routers/recipes.ts` (extend with `addRelated`, `removeRelated`, `listRelated`)
- `frontend/src/components/related-recipes.tsx`

**Acceptance criteria:**
- [ ] `addRelated({ recipeId, otherRecipeId })` inserts `(min, max)` ordering to satisfy the `recipe_one_id < recipe_two_id` CHECK
- [ ] `removeRelated` deletes the row regardless of which side was passed
- [ ] `listRelated(recipeId)` returns the other side of each pair; filters out soft-deleted recipes
- [ ] Self-link attempted → `BAD_REQUEST`
- [ ] Duplicate attempted → `CONFLICT` (PK violation translated to a clean error)
- [ ] UI: combobox to add a related recipe (reuses the searchable combobox); list of chips with remove; chips link to detail

**Implementation notes:**
- DB enforces symmetry. The procedure just normalises ordering.
- The combobox excludes the current recipe and already-related recipes from suggestions.

**Manual verification:**
1. From recipe A, link to recipe B; from recipe B, see A in the related list.
2. Try to link A to itself — error surfaced.
3. Soft-delete B; A's related list no longer shows B; restore B; B reappears.

**Common gotchas:**
- The "exclude already-linked" client list goes stale on add; use TanStack Query invalidation.

**Definition of done:**
- Tests cover: add/remove round-trip, self-link rejection, duplicate rejection, soft-deleted exclusion from listing.
- Commit: `feat(recipes): related recipe links`
- Gate check: link two recipes from one detail page, navigate to the other, see the reverse link.

---

## Phase 4 — Meal planner

### FEAT-27 — Plan procedures: create, list, get, soft-delete (with auto slot generation and overlap rule)

**Goal:** Procedures `plans.create`, `plans.list`, `plans.get`, `plans.softDelete`. `create` auto-generates one `empty` slot per (date × occasion) inside a transaction and rejects overlap with any non-deleted plan whose `endDate >= today`. `[DEC-TBD: overlap rule, past-plan exemption]` `[DEC-TBD: slot auto-generation on plan creation]`

**Estimate:** 3 hr. **Depends on:** FEAT-12, 14. **Enables:** FEAT-28, 29, 30, 31.

**Reuse note:** A `dateUtils` module centralises "today in Europe/London" semantics — first appears here, reused by shelf-life (FEAT-37). `[DEC-TBD: Europe/London time, single-tz v1; localised in dateUtils for future change]`

**Files:**
- `backend/src/trpc/routers/plans.ts`
- `shared/src/schemas/plans.ts`
- `backend/src/lib/date-utils.ts` (`todayInLondon()`, helpers for date-range expansion)
- `backend/src/lib/slot-generation.ts` (`generateEmptySlotsForRange(planId, start, end, occasionIds)`)

**Acceptance criteria:**
- [ ] `create({ name, startDate, endDate })` validates start ≤ end; rejects with `CONFLICT` if any non-deleted plan with `endDate >= today` overlaps the range
- [ ] On accept, inserts the plan and generates empty slots for every (date × meal occasion) inside a transaction
- [ ] `list({ status: 'active' | 'past' | 'future' | 'all' })` filters per `todayInLondon()`: active = `today BETWEEN startDate AND endDate`, past = `endDate < today`, future = `startDate > today`
- [ ] `get(planId)` returns the plan + all slots (with joined recipe data where assigned)
- [ ] `softDelete` sets `is_deleted = true`
- [ ] Overlap is checked against `is_deleted = false` plans only; past plans excluded from overlap

**Implementation notes:**
- The overlap query: `WHERE NOT (other.endDate < new.startDate OR other.startDate > new.endDate)` filtered by `is_deleted = false AND endDate >= today`.
- Slot generation: expand the range to dates × occasion ids; bulk insert.
- `todayInLondon()` returns a `date` (no time component) in the Europe/London civil day.

**Manual verification:**
1. Create a plan from today to today+6; observe slots auto-generated (14 slots for 2 occasions).
2. Try creating an overlapping plan — `CONFLICT`.
3. Create a fully-past plan (or wait till one becomes past) — allowed (overlap exempt for past).
4. Soft-delete a plan; create one overlapping its range — allowed.

**Common gotchas:**
- "Today" computed from server clock without timezone awareness will drift around midnight; always go through `dateUtils`.
- The bulk insert for slots can hit parameter limits if the range is huge — clamp the max range to something sensible (e.g. 90 days) and reject longer ranges with `BAD_REQUEST`.

**Definition of done:**
- Tests cover: slot generation count and contents; overlap rejection on active plans; past-plan exemption; deleted-plan exemption; status filter buckets correctly around midnight.
- Commit: `feat(plans): create, list, soft-delete with auto slot generation and overlap rule`
- Gate check: create a plan via probe; query `meal_plan_slots` to see 2 × N empty slots.

---

### FEAT-28 — Plan date-range edits (shrink and extend)

**Goal:** `plans.updateRange({ planId, startDate, endDate })`. Shrinking deletes out-of-range slots (after the UI confirms); extending generates new empty slots for the added dates. Both happen in a transaction. Overlap re-checked.

**Estimate:** 2–3 hr. **Depends on:** FEAT-27. **Enables:** FEAT-31 (UI), FEAT-34.

**Files:**
- `backend/src/trpc/routers/plans.ts` (extend)
- `shared/src/schemas/plans.ts` (extend)

**Acceptance criteria:**
- [ ] `updateRange` re-runs overlap validation (excluding this plan)
- [ ] If new range is a strict superset, generate empty slots for the added dates
- [ ] If new range shrinks on either side, delete slots whose date falls outside the new range (in the same transaction)
- [ ] Mixed (shrink one side, extend the other) handled in a single transaction
- [ ] Returns the updated plan with its now-current slots
- [ ] Reject if any not-yet-confirmed loss of assigned slots — i.e. the procedure requires `{ confirmDestructive: true }` if the shrink would delete a non-empty slot; without confirmation, returns `BAD_REQUEST` with the list of slots that would be lost in `cause`

**Implementation notes:**
- Querying "slots that would be lost" before the transaction starts means a separate read; for household scale this is fine.
- The confirmation lives in the procedure contract because the UI button (FEAT-31) must show what will be deleted.

**Manual verification:**
1. Extend a plan by 3 days — new empty slots appear.
2. Shrink a plan with an empty slot on the deleted day — succeeds.
3. Shrink past an assigned slot without `confirmDestructive` — error with the slot list; pass `confirmDestructive: true` — succeeds and the slot is gone.

**Common gotchas:**
- A partial extend + shrink in the same call could mistakenly delete the new days if implemented as "delete old, regen all" rather than "compute the symmetric diff." Implement as a diff.
- Don't forget overlap re-check; the user might extend into another plan.

**Definition of done:**
- Tests cover: pure extend; pure shrink; mixed; overlap re-check; destructive-confirm gating.
- Commit: `feat(plans): date-range edits with shrink-confirm and extend-generation`
- Gate check: extend then shrink a plan; slot count adjusts correctly each time.

---

### FEAT-29 — Plan duplication

**Goal:** `plans.duplicate({ planId, newStartDate })` copies the plan's slot assignments to a new plan that inherits the original's duration exactly, anchored on the new start date.

**Estimate:** 2 hr. **Depends on:** FEAT-27. **Enables:** none specifically.

**Files:**
- `backend/src/trpc/routers/plans.ts` (extend)
- `shared/src/schemas/plans.ts` (extend)

**Acceptance criteria:**
- [ ] Duration = source `endDate - startDate` (inclusive)
- [ ] New plan's `endDate = newStartDate + duration`
- [ ] Overlap rule applies (CONFLICT if it would overlap an active plan)
- [ ] All slot assignments copied: `slot_type`, `recipe_id`, `number_of_servings`, `chef_user_id`, `comment`, `cooks_base_recipe_id`, `cooks_base_servings`
- [ ] Wrapped in a transaction
- [ ] Slots' dates remapped by offset (`new_date = source_date + (newStartDate - sourceStartDate)`)
- [ ] Returns the new plan id

**Implementation notes:**
- This is the cleanest way to test the transaction helper, since failure mid-copy must leave no orphan plan.
- The new plan's `name` could be `Copy of <name>` or take an explicit `newName` input — pick one (suggest explicit input).

**Manual verification:**
1. Duplicate a plan to a fresh future date — new plan with identical slot pattern offset by the date delta.
2. Duplicate into an overlapping range — `CONFLICT`.

**Common gotchas:**
- Slot `chef_user_id` may reference a user who has since been tombstoned (FEAT-35); copying NULL is fine — handle gracefully.

**Definition of done:**
- Tests cover: assignment fidelity, date offset correctness, overlap rejection, transaction rollback on synthetic failure.
- Commit: `feat(plans): duplicate plan with date-shifted slot copy`
- Gate check: duplicate a populated plan; new plan shows identical assignments offset by the date delta.

---

### FEAT-30 — Slot procedures (assign, set state, clear, edit) — recipe only

**Goal:** `slots.update({ slotId, slot_type, recipe_id?, number_of_servings?, chef_user_id?, comment? })` covers all five states. Validates: `slot_type='recipe'` requires `recipe_id` + `number_of_servings > 0`; non-recipe states clear `recipe_id` and `number_of_servings`. Base-cook fields (`cooks_base_recipe_id`, `cooks_base_servings`) added in FEAT-32 — leave the columns null here.

**Estimate:** 2 hr. **Depends on:** FEAT-12, 19, 27. **Enables:** FEAT-31, 32.

**Files:**
- `backend/src/trpc/routers/slots.ts`
- `shared/src/schemas/slots.ts`

**Acceptance criteria:**
- [ ] `update` validates the slot-type ↔ recipe pairing
- [ ] Switching from `recipe` to non-recipe nulls `recipe_id` and `number_of_servings`
- [ ] `recipe_id` must reference a non-deleted recipe at assignment time (deleted recipes can remain on existing slots — historical render)
- [ ] `chef_user_id` must be a valid user
- [ ] Validation that `recipe.householdId === CURRENT_HOUSEHOLD_ID`

**Implementation notes:**
- The procedure is one endpoint covering all slot state transitions; UI calls it with whichever fields apply.
- Don't allow setting `slot_type='recipe'` with a soft-deleted recipe; do allow editing servings on a slot whose recipe became soft-deleted (rare, but coherent).

**Manual verification:**
1. Assign a recipe to a slot via probe; verify columns.
2. Switch to `eat_out` — recipe fields cleared.
3. Try assigning a soft-deleted recipe — `BAD_REQUEST`.

**Common gotchas:**
- The CHECK on the table already enforces the recipe ↔ recipe_id link; the procedure should preempt with a clean error rather than letting the DB throw.

**Definition of done:**
- Tests cover: all five state transitions; recipe-id ↔ slot-type coherence; soft-deleted recipe rejection on new assignment; soft-deleted recipe acceptance on edit-in-place.
- Commit: `feat(slots): update procedure for all slot state transitions`
- Gate check: cycle a slot through all five states via probe; observed columns match each state.

---

### FEAT-31 — Meal Planner UI: Recipe Bank sidebar + Grid + click-to-assign

**Goal:** The planner view — a sidebar of recipe cards (the Bank) and a grid of slots by (date × occasion). Click-to-assign interaction: tap a recipe to select; tap a slot to assign. Tap an assigned slot to open the slot editor (servings, change recipe, clear, set state to non-recipe, chef, comment). Optimistic updates via TanStack Query. Date range in TanStack Router search params. `[DEC-TBD: click-to-assign interaction model]` `[DEC-TBD: date range in URL search params for shareable views]` `[DEC-TBD: last-write-wins on slot assignments]`

**Estimate:** 4 hr. **Depends on:** FEAT-19, 27, 28, 30. **Enables:** FEAT-32, 33, 34.

**Reuse note:** The optimistic-update pattern lands first here. Establish a small `useOptimisticSlotUpdate` hook that other slot-related mutations can compose. The recipe-bank's filter (use the picker helper from FEAT-19) is the same machinery the slot editor's recipe picker reuses.

**Files:**
- `frontend/src/routes/_authed/plans/$planId.tsx`
- `frontend/src/components/planner/recipe-bank.tsx`
- `frontend/src/components/planner/planner-grid.tsx`
- `frontend/src/components/planner/slot-cell.tsx`
- `frontend/src/components/planner/slot-editor-sheet.tsx`
- `frontend/src/hooks/use-optimistic-slot-update.ts`

**Acceptance criteria:**
- [ ] Plan URL is `/plans/$planId?start=YYYY-MM-DD&end=YYYY-MM-DD` (start/end optional, default to plan range)
- [ ] Recipe Bank: scrollable column of compact cards; clicking a card selects it (visual selection state)
- [ ] Selected recipe + click on empty slot → assignment (slot updates immediately; mutation rolls back on error)
- [ ] Click on an assigned slot → editor sheet opens (mobile-friendly bottom sheet)
- [ ] Editor exposes: change recipe (combobox), number of servings (with default = recipe.baseServings), slot type (radio: recipe / eat_out / takeaway / leftovers / empty), chef (select from household users), comment (textarea)
- [ ] Clear button on the editor returns the slot to empty
- [ ] Recipe Bank filters out soft-deleted recipes and batch versions whose base is soft-deleted (the pickable helper)
- [ ] Touch-first: the slot editor works one-handed on a phone; the recipe bank is scrollable above the grid on small screens

**Implementation notes:**
- Optimistic updates use TanStack Query's `onMutate`/`onError`/`onSettled` pattern; the hook centralises rollback logic.
- The slot-editor sheet (shadcn `Sheet` or `Drawer`) closes on save; toast surfaces errors.
- TanStack Router search-param schema validates the dates.

**Manual verification:**
1. Open a plan; assign a recipe to a slot via tap-tap.
2. Tap the assigned slot; edit servings; save.
3. Change to `eat_out`; recipe cleared visually and in DB.
4. Soft-delete a recipe in another tab; refresh — recipe gone from bank; historical assignment still rendered on the slot.

**Common gotchas:**
- Optimistic update + concurrent edits + LWW: a stale optimistic state can flicker if the server returns a newer state. Accept reconciliation via `setQueryData` from server response.
- The bottom-sheet pattern on iOS Safari can fight with viewport height — test on a real device.

**Definition of done:**
- Tests cover: click-to-assign updates the slot; slot-editor saves servings/recipe/state/chef/comment; pickable filter excludes soft-deleted and batch-version-of-deleted-base; optimistic rollback on simulated error.
- Commit: `feat(planner): recipe bank, grid, and click-to-assign with optimistic updates`
- Gate check: assign three recipes to three slots, edit one, clear one — DB rows reflect the UI state.

---

### FEAT-32 — Base cooking on slots: model fields, editor, card rendering, soft warning

**Goal:** Surface `cooks_base_recipe_id` / `cooks_base_servings` in the slot editor and on the slot card; pre-suggest the meal's `base_recipe_id` when the meal is a batch-version; soft warning when a batch-version meal has no base supply earlier in the plan or in the same slot. `[DEC-TBD: cooked base decoupled from meal's referenced base, can be different]` `[DEC-TBD: soft warning only — doesn't block save]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-23, 30, 31. **Enables:** FEAT-36 (aggregation), FEAT-40 (plant-points).

**Reuse note:** The base-supply check logic ("does this batch meal have a base cooked earlier or here?") will be reused by aggregation (FEAT-36) and plant-points (FEAT-40) — though for different purposes. Factor it as a query over the plan's slots, then consume it in the planner UI here.

**Files:**
- `backend/src/trpc/routers/slots.ts` (extend `update` with base-cook fields + application-level `is_base = true` validation)
- `backend/src/lib/batch-supply.ts` (`hasBaseSupply(planId, slotId, baseRecipeId)` → returns boolean + earliest-cook-slot reference)
- `frontend/src/components/planner/slot-editor-sheet.tsx` (extend)
- `frontend/src/components/planner/slot-cell.tsx` (extend: render two lines when base-cook present)
- `frontend/src/components/planner/batch-warning.tsx`

**Acceptance criteria:**
- [ ] Slot editor: "What are you eating?" combobox (any pickable recipe); "Cooking a base for batch use?" combobox (optional; filtered to `is_base = true`); servings input for the base cook (required when base cook set)
- [ ] If the eating recipe is a batch-version (has `base_recipe_id`), the base picker pre-suggests that base (user can override or clear)
- [ ] DB joint-set CHECK already enforces both fields set or both null; UI mirrors the constraint
- [ ] Server-side procedure rejects `cooks_base_recipe_id` referring to a non-`is_base` recipe
- [ ] Soft warning shown on the slot card and in the editor when a batch-version meal lacks base supply (no earlier slot or same slot cooking the meal's base)
- [ ] Soft warning is non-blocking — save proceeds
- [ ] Slot card renders two lines: "Meal: X (×N)" and "Cook base: Y (×M)" when base-cook is set

**Implementation notes:**
- `hasBaseSupply`: SQL that asks "is there any slot in this plan with `cooks_base_recipe_id = ?` whose date ≤ current slot's date and (date < current OR same slot.id)?"
- "Earlier" is "any date strictly before this slot's date, or same date with the same or earlier occasion ordinal" — define an occasion ordering once (Lunch < Dinner).

**Manual verification:**
1. Open a slot whose meal is a batch-version; base picker pre-suggests the linked base; set servings → save.
2. Pick a non-`is_base` recipe in the base picker — disallowed (filtered out at the picker; procedure rejects defence-in-depth).
3. Assign a batch-version meal without any earlier base cook → soft warning visible.
4. Add a base cook on an earlier slot → warning clears on re-render.

**Common gotchas:**
- Pre-suggesting must not auto-set; it's a hint. Users sometimes cook the base elsewhere or substitute.
- Occasion ordering (Lunch < Dinner) is hardcoded today; if a future occasion (breakfast?) is added, the ordering needs an explicit column.

**Definition of done:**
- Tests cover: base-cook fields round-trip; `is_base = true` constraint at procedure layer; pre-suggestion logic; soft-warning logic across plan boundaries.
- Commit: `feat(planner): base cooking on slots with batch-supply warning`
- Gate check: create a plan with a batch meal in one slot and the corresponding base cook in an earlier slot — slot cards render both lines; warning absent.

---

### FEAT-33 — Pair switch UI (full ↔ batch toggle on slot)

**Goal:** When a slot's meal recipe has a `paired_recipe_id`, the slot editor exposes a "switch to full / switch to batch" toggle that updates the slot's `recipe_id` to the paired recipe.

**Estimate:** 1–2 hr. **Depends on:** FEAT-23, 31. **Enables:** none specifically.

**Files:**
- `frontend/src/components/planner/slot-editor-sheet.tsx` (extend)
- `frontend/src/components/planner/pair-switch-button.tsx`

**Acceptance criteria:**
- [ ] Button visible only when the slot's recipe has `paired_recipe_id` set AND the paired recipe is not soft-deleted
- [ ] Label reflects the switch direction (e.g. paired_recipe is_base = true → "Switch to full" if current is the full and paired is a base… or whichever is the meaningful framing — the button tells the user what they'll get)
- [ ] Tap → mutation updates `recipe_id` to the paired one; optimistic update; servings may default to the new recipe's `baseServings` (decide and document)

**Implementation notes:**
- The button is small and trivial; the value is the clarity of the user mental model ("I want the batch version of this dish for tonight").
- Don't auto-set the base picker on pair switch — let the user decide separately.

**Manual verification:**
1. Pair two recipes (FEAT-23).
2. Assign one to a slot.
3. Click the pair-switch — slot now shows the other.

**Common gotchas:**
- After a pair switch, the batch-supply warning may suddenly appear; that's the correct behaviour, not a bug.

**Definition of done:**
- Tests cover: button visibility logic; switch updates the slot recipe; switch hidden when paired recipe is soft-deleted.
- Commit: `feat(planner): full↔batch pair switch on slot`
- Gate check: pair two recipes, assign one, click the switch — slot shows the other.

---

### FEAT-34 — Plan list / browse view

**Goal:** A page listing the household's plans, filterable by status (active / past / future / all), with quick actions: open, duplicate, soft-delete. Also the entry point for the "new plan" flow.

**Estimate:** 2 hr. **Depends on:** FEAT-27, 28, 29. **Enables:** none specifically.

**Files:**
- `frontend/src/routes/_authed/plans/index.tsx`
- `frontend/src/components/planner/plan-list-card.tsx`
- `frontend/src/components/planner/new-plan-dialog.tsx`

**Acceptance criteria:**
- [ ] Status filter (radio or tabs): active / past / future / all (default: active)
- [ ] New-plan dialog: name, start date, end date; calls `plans.create`; on success, navigates to the new plan
- [ ] Plan card: name, date range, slot-fill summary (e.g. "12/14 slots assigned"); actions: open, duplicate, delete
- [ ] Duplicate action opens a small dialog asking for the new start date and name
- [ ] Soft-delete prompts a confirm

**Implementation notes:**
- The slot-fill summary requires a small read (count of non-empty slots per plan); add it to `plans.list` to avoid N+1.
- Optimistic updates on soft-delete with rollback on failure.

**Manual verification:**
1. Create three plans across past / active / future; filters show the right ones.
2. Duplicate an active plan to a future start date.
3. Soft-delete a plan; switch filter to All; see all of them.

**Common gotchas:**
- "Past" filter around midnight depends on `todayInLondon()`. Don't re-implement.

**Definition of done:**
- Tests cover: filter buckets; new-plan dialog validates; duplicate dialog wires through.
- Commit: `feat(planner): plan list and browse with status filters`
- Gate check: cover all three actions (open, duplicate, delete) from the list.

---

### FEAT-35 — Account deletion with tombstoning sequence

**Goal:** A "Delete my account" action on the settings page that runs the seven-step tombstoning sequence in a transaction: delete `recipe_ratings` rows, NULL `recipe_comments.userId`, NULL `recipes.addedByUserId`, NULL `meal_plans.createdByUserId`, NULL `meal_plan_slots.chefUserId`, delete `recipe_drafts` rows, delete the user row; then sign out. `[DEC-TBD: account deletion as tombstoning, not cascade — preserves household data]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-16, 11, 12, 22. **Enables:** none specifically; closes the account-management loop.

**Files:**
- `backend/src/trpc/routers/user.ts` (extend with `deleteAccount`)
- `frontend/src/routes/_authed/settings.tsx` (extend with delete section)
- `frontend/src/components/danger-confirm-dialog.tsx`

**Acceptance criteria:**
- [ ] `deleteAccount` runs all seven steps inside one `withTransaction`
- [ ] After commit, the procedure signs out the session
- [ ] Settings page has a "Danger zone" section with a confirm dialog requiring the user to type their email to enable the button
- [ ] Pre-deletion summary: shows count of comments, recipes, plans that will be tombstoned (informational)
- [ ] After deletion, the user is redirected to `/sign-in` with a "Your account has been deleted" message

**Implementation notes:**
- Order matters: drafts and ratings are hard-deleted first to clear FKs that point to the user with `ON DELETE RESTRICT`; the rest set NULL; finally the user row is deleted.
- Better Auth's session/account/verification rows for this user may need cleanup; verify the library's deletion helper handles it, or include it in the transaction.
- The confirm dialog with email-typed gating is a small but worthwhile friction layer.

**Manual verification:**
1. Sign in as a user; ensure they have at least one rating, one comment, one recipe, one plan, one draft.
2. Trigger delete; counts in the pre-summary are correct.
3. After deletion: the user row gone; the comment renders as `[deleted user]`; the recipe row remains with NULL author; the plan remains.

**Common gotchas:**
- Better Auth's tables: don't forget to delete `sessions` and `accounts` for the user — otherwise stale rows linger. The simplest path is calling the library's `deleteUser` helper *inside* the same transaction, or running an explicit DELETE per Better Auth's schema.
- Running this with no transaction is dangerous; partial state could leave a user row but no ratings/comments tombstoned.

**Definition of done:**
- Tests cover: each of the seven steps executes; failure mid-sequence rolls back; comments/recipes/plans render with the `[deleted user]` shape after; Better Auth tables for the user are cleared.
- Commit: `feat(user): account deletion with tombstoning sequence`
- Gate check: delete a test account; query DB tables to confirm the exact tombstoning pattern.

---

## Phase 5 — Shopping list

### FEAT-36 — Shopping list aggregation procedure

**Goal:** `shopping.getForPlan(planId)` returns ingredient lines grouped by category, with totals scaled by `qty × (slotServings / baseServings)`. Adds base-cook contributions from any slot with `cooks_base_recipe_id` set. Excludes non-recipe slot types from meal-recipe totals. Batch-version meals contribute only their accompaniment ingredients; the base ingredients come from the base-cook contribution. `[DEC-TBD: shopping list aggregation math, batch-no-double-count rule]`

**Estimate:** 4 hr. **Depends on:** FEAT-19, 27, 30, 32. **Enables:** FEAT-37, 38, 39.

**Reuse note:** The procedure's output DTO (lines with `ingredient`, `category`, `totalQuantity`, `contributingSlots[]`) is consumed by the UI (FEAT-38) and the shelf-life logic (FEAT-37). Design the DTO once, including the `contributingSlots` shape (slot id, recipe name, date, scaled quantity) — both consumers need it.

**Files:**
- `backend/src/trpc/routers/shopping.ts`
- `backend/src/lib/shopping-aggregation.ts` (the math, isolated for testability)
- `shared/src/schemas/shopping.ts`

**Acceptance criteria:**
- [ ] Joins: `meal_plan_slots` → `recipes` (the eating recipe) → `recipe_ingredients` → `ingredients` → `ingredient_categories`
- [ ] Scaling: each ingredient line contributes `recipe_ingredient.quantity × (slot.number_of_servings / recipe.base_servings)`
- [ ] Non-recipe slot types contribute nothing from the meal recipe
- [ ] Base-cook contribution: for each slot with `cooks_base_recipe_id` set, add the base recipe's ingredients scaled by `slot.cooks_base_servings / base_recipe.base_servings`
- [ ] Batch-version meals (meal recipe's `base_recipe_id` is set): include only the meal recipe's own ingredients; the base is supplied via a `cooks_base_*` slot somewhere
- [ ] Same ingredient appearing on multiple lines of the same recipe (e.g. "onion sliced" + "onion diced") aggregates as a single total
- [ ] Output grouped by `ingredient_categories.name`, ordered by category then ingredient name
- [ ] Output includes per-line `contributingSlots: [{ slotId, recipeName, date, scaledQuantity }]`

**Implementation notes:**
- Do the aggregation in one round-trip if possible: a CTE union of (meal-recipe contributions) and (base-cook contributions), then sum by ingredient.
- Keep the math in a pure helper that takes raw rows and produces the DTO — makes unit testing trivial.
- Watch for rounding: use Postgres `numeric(10,3)` arithmetic; the final UI may render at 2 decimals but the DB math stays at 3.

**Manual verification:**
1. Create a plan with: one full recipe, one batch-version recipe whose base is cooked in another slot, one eat-out slot.
2. Generate the shopping list; verify totals manually for one ingredient.
3. Confirm the batch-version meal contributes only its accompaniments; the base ingredients show up via the base-cook contribution; no double-count.

**Common gotchas:**
- A recipe with duplicate ingredient lines (onion sliced + onion diced) must sum into one ingredient line. The aggregation is by `ingredient_id`, not by `recipe_ingredient_id`.
- If a slot's `cooks_base_recipe_id` points to a deleted recipe — shouldn't happen because of `ON DELETE RESTRICT`, but if it does, surface as an error rather than silent omission.
- Floating-point drift: keep Decimal/`numeric` arithmetic; avoid converting to JS `number` before final aggregation.

**Definition of done:**
- Tests cover: simple plan totals; mixed recipe and non-recipe slots; duplicate ingredient lines summed; batch-version meal contributing accompaniments only; base-cook contribution; combined "batch meal + base cook in same plan" with no double-count; many-recipes-one-ingredient aggregation.
- Commit: `feat(shopping): aggregation procedure with base-cook contributions`
- Gate check: a hand-computed plan's totals match the procedure output line-for-line.

---

### FEAT-37 — Shelf-life warnings

**Goal:** For each ingredient on the shopping list, if any contributing slot's date is later than `(planStart + shelfLifeDays)`, flag it and surface the latest-needed date. `[DEC-TBD: single-shop assumption, shopping on plan start date]`

**Estimate:** 1–2 hr. **Depends on:** FEAT-36. **Enables:** FEAT-38.

**Files:**
- `backend/src/lib/shopping-aggregation.ts` (extend)
- `shared/src/schemas/shopping.ts` (extend)

**Acceptance criteria:**
- [ ] Each shopping-list line carries `shelfLifeWarning?: { latestNeededDate: string, daysOverflow: number }`
- [ ] Warning fires only if the ingredient's `average_shelf_life_days` is set AND any contributing slot date > `planStart + shelfLifeDays`
- [ ] `latestNeededDate` is the maximum contributing-slot date
- [ ] If no slot exceeds shelf life, the field is absent

**Implementation notes:**
- Compute alongside the aggregation; one extra pass over the aggregated lines.
- Use the `dateUtils` from FEAT-27.

**Manual verification:**
1. Set an ingredient's shelf life to 3 days; use it in a slot 5 days into the plan; verify the warning surfaces with the right `latestNeededDate`.
2. Remove the shelf-life value; warning disappears.

**Common gotchas:**
- Inclusive vs exclusive boundary: a 3-day shelf life with usage on day 3 — does that fit? Pick a definition and document (suggested: usage strictly later than `planStart + shelfLifeDays` warns; usage on the boundary does not).

**Definition of done:**
- Tests cover: warning fires past boundary; absent at/before boundary; absent when shelf life is null; `latestNeededDate` correctness with multiple contributing slots.
- Commit: `feat(shopping): shelf-life warnings with latest-needed date`
- Gate check: a plan with a short-shelf-life ingredient used late shows the warning end-to-end.

---

### FEAT-38 — Check-state procedures with lazy-create and quantity-bound reset

**Goal:** `shopping.toggleChecked({ planId, ingredientId, isChecked })`. The first `getForPlan` call for a plan lazily creates `shopping_list_items` rows for that plan's current ingredient set; subsequent calls reuse them. On every aggregation, if a line's current total differs from the total recorded at last check, that line's `is_checked` resets to false. `[DEC-TBD: lazy-create shopping_list_items]` `[DEC-TBD: quantity-bound check-state reset]`

**Estimate:** 3 hr. **Depends on:** FEAT-36. **Enables:** FEAT-39, FEAT-42.

**Files:**
- `backend/src/trpc/routers/shopping.ts` (extend)
- `backend/src/lib/shopping-aggregation.ts` (extend with quantity tracking)
- `shopping_list_items` table needs an extra column for "last-checked quantity" — adjust schema (FEAT-12 left it minimal). Note: this is a small additive migration here, not a re-do.

**Acceptance criteria:**
- [ ] First `getForPlan(planId)` reads existing `shopping_list_items` rows; for any aggregated ingredient missing a row, inserts one (`is_checked = false`, `lastCheckedQuantity = NULL`)
- [ ] Aggregated lines whose `current total != lastCheckedQuantity` (when `is_checked = true`) reset to `is_checked = false`
- [ ] `toggleChecked` updates `is_checked` and, when set to true, stores `lastCheckedQuantity = currentTotal`
- [ ] The output of `getForPlan` returns the post-reset state
- [ ] Schema migration adds `last_checked_quantity numeric(10,3) NULL` to `shopping_list_items`

**Implementation notes:**
- The reset runs *inside* `getForPlan` as part of the aggregation flow — the read also writes if there's a change. Use a transaction.
- Alternatively, store the snapshot via the `toggleChecked` call and detect mismatch on read — same result, slightly different ergonomics.

**Manual verification:**
1. Generate a shopping list; check off a few items.
2. Edit a slot's servings to change a checked ingredient's total; reload the shopping list — that line is unchecked again, others remain checked.
3. Change a serving count back; line stays unchecked (reset is one-way per change).

**Common gotchas:**
- Equality comparison on `numeric` requires exact match; rounding to a fixed scale (3 decimals) is essential.
- Race condition: two devices checking and editing concurrently can produce surprising resets; LWW is accepted per the plan, but document the behaviour.

**Definition of done:**
- Tests cover: lazy create on first GET; reset triggers when total changes; toggle persists; reset does not fire if total is unchanged but other lines change.
- Commit: `feat(shopping): check-state with lazy-create and quantity-bound reset`
- Gate check: check an item → edit servings → reload → item is unchecked.

---

### FEAT-39 — Shopping List view UI

**Goal:** A printable, mobile-friendly shopping list page: grouped by category, with check boxes, total quantities, contributing recipes (collapsed by default), and shelf-life warnings. PWA-cacheable shape established here (service worker arrives in FEAT-41).

**Estimate:** 3 hr. **Depends on:** FEAT-36, 37, 38. **Enables:** FEAT-41.

**Files:**
- `frontend/src/routes/_authed/plans/$planId.shopping.tsx`
- `frontend/src/components/shopping/category-section.tsx`
- `frontend/src/components/shopping/list-line.tsx`
- `frontend/src/components/shopping/shelf-life-badge.tsx`
- `frontend/src/print.css` (print stylesheet)

**Acceptance criteria:**
- [ ] List grouped by category in display order
- [ ] Each line: checkbox, ingredient name, total quantity + unit, contributing recipes (collapsible)
- [ ] Shelf-life warning rendered as a non-blocking badge with the `latestNeededDate`
- [ ] Check toggle calls `toggleChecked`; optimistic update
- [ ] Print stylesheet: hide nav, render in single column, keep category groupings, hide contributing-recipes section
- [ ] Works one-handed on a phone (large tap targets, no horizontal scroll)

**Implementation notes:**
- Optimistic updates on check toggle use the same hook scaffold as the slot updates (FEAT-31).
- The print stylesheet is small but valued — pre-shop print is a real flow.

**Manual verification:**
1. Open shopping list; check items; observe optimistic updates.
2. Print preview shows a clean shopping list.
3. Long category sections scroll smoothly on mobile.

**Common gotchas:**
- Avoid putting the check state in `localStorage`; the server is the source of truth (FEAT-41/42 handle offline separately).

**Definition of done:**
- Tests cover: category grouping render; line renders with shelf-life badge; check toggle optimistic update.
- Commit: `feat(shopping): list view with print-friendly stylesheet`
- Gate check: open the list, check items, print preview — all coherent.

---

### FEAT-40 — Plant points: day-level and plan-level (with batch traversal and base-cook union)

**Goal:** Procedures `plants.forDay(planId, date)` and `plants.forPlan(planId)`. Both compute distinct plant-ingredient counts. Day/plan logic traverses `recipe.base_recipe_id` for batch-version slots (so days running on leftovers don't appear plant-poor) and unions `slot.cooks_base_recipe_id` ingredients. Dedup handles the case where the meal's referenced base equals the cooked base. UI display on the planner. `[DEC-TBD: plant-points traversal rules for batch and base-cook slots]`

**Estimate:** 3 hr. **Depends on:** FEAT-19 (recipe-level), 23, 27, 32. **Enables:** none specifically; quality feature.

**Reuse note:** The recipe-level `plant-points.ts` helper from FEAT-19 is the building block. The traversal logic is *new* but composed of the same `is_plant` distinction. Keep the traversal in one place; tests against the day/plan layer exercise the recipe-level helper indirectly.

**Files:**
- `backend/src/trpc/routers/plants.ts`
- `backend/src/lib/plant-points.ts` (extend with `forDay`, `forPlan`)
- `frontend/src/components/planner/plant-points-badge.tsx`
- `frontend/src/components/planner/planner-grid.tsx` (extend)

**Acceptance criteria:**
- [ ] `forDay`: collect plant ingredients from each slot's eating recipe (traversing `base_recipe_id` for batch-version meals), union with the base-cook recipe's plant ingredients if `cooks_base_recipe_id` is set, then `COUNT(DISTINCT)`
- [ ] `forPlan`: same logic aggregated across all days
- [ ] Non-recipe slot types contribute zero unless they cook a base (a `cooks_base_recipe_id` set on a takeaway slot still counts)
- [ ] Dedup: if meal's `base_recipe_id` = `cooks_base_recipe_id` on the same slot, plant ingredients counted once
- [ ] UI: badge on each day row of the planner showing day total; plan total in the plan header

**Implementation notes:**
- Best done in one SQL query per granularity using UNION + DISTINCT — let the DB handle dedup.
- Refresh the badges in response to slot mutations (TanStack Query invalidation).

**Manual verification:**
1. Build a day with: one full recipe (3 plants), one batch-version recipe whose base has 4 plants and accompaniments have 2 plants (some overlap). Expected total = distinct count.
2. Add a base-cook on a takeaway slot — day total updates.

**Common gotchas:**
- "Distinct" must be at ingredient id level; counting plant ingredient *names* will fail if the same ingredient is named differently in different recipes (it shouldn't, but the schema doesn't prevent it).
- The traversal must skip soft-deleted base recipes? No — base is referenced via FK with `ON DELETE RESTRICT`, so it can be soft-deleted but not hard-deleted; the rows still exist, traverse normally.

**Definition of done:**
- Tests cover: simple day (full recipes only); day with batch-version meal traversing to base; day with base-cook union; dedup when meal base = cooked base; plan-level rollup.
- Commit: `feat(plants): day and plan plant-point procedures with batch traversal`
- Gate check: hand-compute a tricky day's plant count; UI badge matches.

---

### FEAT-41 — PWA infrastructure: service worker + manifest + network-first for shopping list

**Goal:** Register a service worker via `vite-plugin-pwa`; ship a web manifest with icons and theme colours; the shopping-list GET uses a **network-first** strategy (always show server truth when reachable, fall back to cache on failure or timeout). `[DEC-TBD: PWA network-first for shopping list]`

**Estimate:** 3 hr. **Depends on:** FEAT-04, 39. **Enables:** FEAT-42.

**Files:**
- `frontend/vite.config.ts` (add `vite-plugin-pwa`)
- `frontend/public/manifest.webmanifest` (or generate via plugin config)
- `frontend/public/icons/*` (PWA icon set)
- `frontend/src/sw-register.ts`

**Acceptance criteria:**
- [ ] Manifest references the right icons and theme colours; `start_url` correctly set
- [ ] Service worker registered in production builds (skip in dev to avoid caching surprises)
- [ ] Network-first runtime caching configured for the shopping-list query URL pattern (tRPC URLs follow a `batch=1&input=...` shape — match by path prefix)
- [ ] On a clean install, browsing to a shopping list works; killing connectivity and reloading still shows the last-fetched list
- [ ] "Install app" affordance available in supporting browsers
- [ ] iOS Safari quirks accepted but documented (no install prompt, but add-to-home-screen still works)

**Implementation notes:**
- `vite-plugin-pwa` with `registerType: 'autoUpdate'` and Workbox runtime caching.
- Don't cache mutations or non-shopping-list reads — keep the cache surface tight.

**Manual verification:**
1. Production build; serve locally; load the shopping list.
2. Disconnect the network; reload — list still renders.
3. Reconnect; reload — server-fresh data shown.
4. Use the install affordance in a desktop Chrome to install the PWA.

**Common gotchas:**
- Service worker scope confusion: registered at `/`, scope must match the routes you intend to cache. Misconfiguring scope silently breaks caching.
- Skip dev-mode SW registration; Vite's HMR + a stale SW is a nightmare.

**Definition of done:**
- Tests cover: SW registration in prod; manifest fields present (probe via fetch in a test).
- Commit: `feat(pwa): service worker and manifest with network-first shopping list cache`
- Gate check: install the PWA, open a shopping list, go offline, reload — list renders from cache.

---

### FEAT-42 — Offline check-state queue + reconnect sync

**Goal:** When offline, `toggleChecked` mutations queue locally; on reconnect, the queue drains in order against the server. UI reflects the optimistic queued state. `[DEC-TBD: offline mutation queue, LWW conflict resolution accepted]`

**Estimate:** 3–4 hr. **Depends on:** FEAT-38, 41. **Enables:** none specifically; offline-shopping UX.

**Files:**
- `frontend/src/lib/offline-queue.ts` (IndexedDB-backed)
- `frontend/src/components/shopping/list-line.tsx` (extend with queued indicator)
- `frontend/src/lib/trpc.ts` (extend with a link that catches network errors and queues toggles)

**Acceptance criteria:**
- [ ] Toggle mutations made while offline are stored in IndexedDB with `{ id, planId, ingredientId, isChecked, queuedAt }`
- [ ] UI shows queued state immediately (optimistic) with a small "pending sync" indicator
- [ ] On `online` event (or service-worker `sync` event if used), queue drains in chronological order
- [ ] Successful drain removes the entry; failure (auth / network) keeps it for retry
- [ ] If two queued toggles target the same line, only the latest is kept (collapse on enqueue)
- [ ] Conflict on sync (server's `lastCheckedQuantity` differs) — LWW per current line: the queued action wins, but if a quantity reset happened server-side the line may already be unchecked; surface the reconciliation gracefully

**Implementation notes:**
- IndexedDB is the right store (cookies/localStorage are too small/unsuitable).
- Use a small wrapper like `idb-keyval` or hand-roll a tiny store; full Dexie isn't needed for one queue.
- The "collapse on enqueue" rule keeps the queue O(lines) not O(taps).

**Manual verification:**
1. Open shopping list, go offline, check three items — each marked "pending sync".
2. Reconnect — pending markers clear; server state reflects the changes.
3. Offline, check then uncheck the same line; on sync, only the final state lands on the server.

**Common gotchas:**
- The `online` event lies on some networks (reports online when the link is captive-portal-blocked). Retry-on-failure is the fallback.
- IndexedDB writes are async and can be lost on browser crash; this is acceptable v1 risk per the plan's LWW posture.

**Definition of done:**
- Tests cover: queue persistence across reload; collapse-on-enqueue; drain order; failure-then-retry behaviour.
- Commit: `feat(shopping): offline check-state queue with reconnect sync`
- Gate check: offline → toggle several → reconnect → server state matches.

---

## Phase 6 — Observability & deploy hardening

### FEAT-43 — Pino → Axiom transport with req.id propagation

**Goal:** Ship Fastify's Pino logs to Axiom via a transport; the per-request `req.id` (established in FEAT-03) lands on every log entry in Axiom. `[DEC-TBD: Pino → Axiom for structured logs, 30-day free-tier retention]`

**Estimate:** 1–2 hr. **Depends on:** FEAT-03, 06. **Enables:** FEAT-44.

**Reuse note:** This is the second consumer of `req.id` after FEAT-03; FEAT-44 is the third. Keep the field name (`reqId` vs `request_id` vs `req.id`) consistent across all three or cross-reference breaks.

**Files:**
- `backend/src/plugins/logger.ts` (extend with Axiom transport)
- `flyctl secrets` for `AXIOM_TOKEN`, `AXIOM_DATASET`
- `docs/measurements.md` (note: log volume baseline)

**Acceptance criteria:**
- [ ] In production, Pino streams JSON entries to Axiom via the official transport (`@axiomhq/pino` or similar)
- [ ] Local dev keeps pretty-printed stdout (no Axiom send)
- [ ] Every entry includes `reqId` matching the value the same request shows in response headers (if exposed) and in Sentry tags (FEAT-44)
- [ ] Startup, shutdown, and error events all reach Axiom
- [ ] No PII is in log entries that wasn't already in the request line (specifically — request bodies are not logged)

**Implementation notes:**
- Pino transports run in a worker thread by default; verify the bundle handles that path (esbuild + `pino`'s transport spawn can be finicky — pre-bundle the transport or use Pino's `customLevels` to log to a custom stream).
- Decide log level: `info` in prod, `debug` for one-off debugging via env flag.

**Manual verification:**
1. Deploy with `AXIOM_TOKEN` set; hit production; check Axiom dashboard for entries with `reqId`.
2. Correlate one Axiom entry to the same `reqId` returned in the request's response header (if exposed) or in a Sentry error.

**Common gotchas:**
- Axiom's free tier has a per-event size limit; oversized payloads (large query results logged at debug) will drop silently. Stay at `info` in prod.
- Worker-thread transports + esbuild's bundle: the transport file must exist on disk at runtime. May need to copy it into the image or set Pino's `transport.target` to a bundled module.

**Definition of done:**
- Tests cover: not applicable (transport behaviour is verified via the deployed dashboard).
- Commit: `feat(observability): Pino transport to Axiom with req.id propagation`
- Gate check: produce a request in prod, find its `reqId` in Axiom.

---

### FEAT-44 — Sentry frontend + backend with PII scrubbing and req.id tag

**Goal:** Sentry React SDK + Sentry Node SDK initialised in both apps with `beforeSend` scrubbing (cookies, authorization headers, email addresses); session replay disabled; `req.id` attached as a tag on backend errors so they cross-reference Axiom entries; absolute-threshold alert configured in Sentry (>5 errors / 5 min). `[DEC-TBD: Sentry beforeSend PII scrubbing; replay disabled to skip cookie consent]` `[DEC-TBD: absolute-threshold alert; percentage-based unsuitable at low traffic]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-43. **Enables:** none specifically.

**Files:**
- `backend/src/plugins/sentry.ts`
- `frontend/src/lib/sentry.ts`
- `backend/src/server.ts` and `frontend/src/main.tsx` (init early)
- `flyctl secrets`: `SENTRY_DSN_BACKEND`, `SENTRY_DSN_FRONTEND`
- Sentry dashboard configuration (one-time)

**Acceptance criteria:**
- [ ] Backend Sentry initialised before Fastify plugins; captures unhandled errors and explicit `Sentry.captureException`
- [ ] Frontend Sentry initialised before React renders; captures error boundary errors and unhandled rejections
- [ ] `beforeSend` strips: `Cookie` header, `Authorization` header, any field named `email` (case-insensitive) anywhere in the payload
- [ ] Session replay disabled in both SDKs
- [ ] Backend attaches the current request's `reqId` as a Sentry tag on each captured event
- [ ] Sentry project alert: notify on >5 events / 5 min absolute threshold (configured in the Sentry dashboard, documented in `OPERATIONS.md`)
- [ ] Synthetic error in dev shows up in Sentry with scrubbed payload

**Implementation notes:**
- `beforeSend` is the right hook; `beforeBreadcrumb` for breadcrumbs that also leak (URL params).
- Add a `Sentry.setTag('reqId', reqId)` either via a Fastify hook or as the first action in the tRPC procedure middleware.

**Manual verification:**
1. Throw a synthetic error from a procedure; observe the Sentry event with the expected `reqId` tag and no `Cookie` header.
2. Throw from the frontend; observe in Sentry; payload doesn't contain the user's email.
3. Trigger 6 errors in 5 minutes; alert fires.

**Common gotchas:**
- Sentry's auto-instrumentation may capture request bodies in some configs; verify the scrub covers form data too.
- Don't ship the backend DSN to the frontend or vice versa — separate projects.

**Definition of done:**
- Tests cover: `beforeSend` scrub logic (pure function over a sample payload).
- Commit: `feat(observability): Sentry with PII scrubbing and req.id tag`
- Gate check: trigger a synthetic error end-to-end; Sentry event arrives, `Cookie` header absent, `reqId` tag present.

---

### FEAT-45 — Rate limiting via @fastify/rate-limit

**Goal:** `@fastify/rate-limit` configured: 100 req/min per IP for unauthenticated routes, 300 req/min per session for authenticated, and a tighter 5 requests per email per hour on the magic-link request endpoint. `[DEC-TBD: rate limits per NFR; tighter per-email limit on magic-link]`

**Estimate:** 1–2 hr. **Depends on:** FEAT-14. **Enables:** none specifically.

**Files:**
- `backend/src/plugins/rate-limit.ts`
- `backend/src/server.ts` (register plugin)

**Acceptance criteria:**
- [ ] Plugin registered before the tRPC adapter
- [ ] `keyGenerator` returns IP for unauth, session id for auth (where present), and email (from request body) for the magic-link route
- [ ] Storage: in-memory (single Fly machine — fine for v1; if scaled out later, plug Redis)
- [ ] 429 responses include a `Retry-After` header
- [ ] Returned error body uses a stable shape consistent with other tRPC errors (or escapes the tRPC envelope cleanly)

**Implementation notes:**
- The magic-link route lives under `/api/auth/*` which Better Auth owns; you may need to inspect the route handler and apply a per-route limit via Fastify hooks rather than the plugin's automatic key generation.
- Document the limits in `OPERATIONS.md` so legitimate burst use cases don't get misread as bugs.

**Manual verification:**
1. Hammer the magic-link endpoint with the same email 6 times in an hour — sixth request 429s.
2. Hit `/api/trpc/health.ping` 101 times in a minute as the same IP — 101st 429s.

**Common gotchas:**
- The IP behind Cloudflare is in `CF-Connecting-IP`, not `request.ip`. Configure Fastify to trust the proxy and use the right header.
- In-memory store + Fly auto-stop means counters reset on machine wake — accept this as v1 behaviour.

**Definition of done:**
- Tests cover: IP-based limit triggers; per-email limit triggers; legitimate request under limits passes; 429 carries `Retry-After`.
- Commit: `feat(security): rate limits per NFR with per-email magic-link limit`
- Gate check: hit each limit type from the running app; 429s observed.

---

### FEAT-46 — /api/health endpoint

**Goal:** A health endpoint that returns 200 + `{ ok: true }` when the server is up and the DB is reachable; 503 otherwise. Used by Fly's health checks (referenced from `fly.toml` since FEAT-05).

**Estimate:** 1 hr. **Depends on:** FEAT-09. **Enables:** robust deploys via FEAT-48.

**Files:**
- `backend/src/routes/health.ts`
- `backend/src/server.ts` (register; exempt from auth pre-handler)

**Acceptance criteria:**
- [ ] Endpoint at `GET /api/health`
- [ ] Performs a cheap DB probe (`select 1`) with a short timeout
- [ ] Returns 200 on success, 503 on DB failure
- [ ] Exempt from the auth pre-handler
- [ ] Exempt from rate limiting (Fly will hit it frequently)
- [ ] No logging at `info` level for this route (skip access log to keep volume sane) — or sample it

**Implementation notes:**
- A 2-second DB timeout is reasonable. Longer than that and Fly should consider the machine unhealthy.
- Don't read from a connection that's blocked on another query; the pool should give a fresh one quickly.

**Manual verification:**
1. `curl https://<domain>/api/health` returns 200 with the expected body.
2. With the DB stopped, `curl` returns 503.
3. Fly dashboard shows the machine as healthy.

**Common gotchas:**
- Logging this endpoint at `info` will balloon Axiom volume — drop or sample.
- Don't add caching to this endpoint; it must be fresh per call.

**Definition of done:**
- Tests cover: 200 happy path; 503 when DB is unreachable.
- Commit: `feat(backend): /api/health endpoint with DB probe`
- Gate check: confirm Fly's health-check passes on a deploy; force a DB outage in dev and observe 503.

---

### FEAT-47 — Explicit CSP policy

**Goal:** Replace `@fastify/helmet`'s default CSP with an explicit policy: `img-src 'self' res.cloudinary.com data:`, `connect-src 'self' <sentry-ingest>`, minimal `script-src` and `style-src` allowlist. Everything else defaults to `'self'`.

**Estimate:** 1–2 hr. **Depends on:** FEAT-03, 18, 44. **Enables:** none specifically.

**Files:**
- `backend/src/plugins/security.ts` (extend helmet config)

**Acceptance criteria:**
- [ ] `Content-Security-Policy` header set with the explicit policy
- [ ] `img-src` includes `'self'`, `res.cloudinary.com`, `data:`
- [ ] `connect-src` includes `'self'` and Sentry's ingest endpoint
- [ ] `script-src` and `style-src` allow `'self'` plus only what shadcn/Tailwind strictly requires (inline-styles for shadcn's CSS variables need handling — either nonce-based or `'unsafe-inline'` for styles only, documented as a known compromise)
- [ ] `frame-ancestors 'none'` (with `X-Frame-Options` as a backup)
- [ ] HSTS enabled

**Implementation notes:**
- Test the policy in a browser; the DevTools console will list violations.
- Inline styles from shadcn/ui (CSS-in-JS via Tailwind) are usually compiled out, but verify with a build.

**Manual verification:**
1. Load the prod app; DevTools console shows no CSP violations.
2. Manually craft a `<script>` tag injection on a page; CSP blocks execution.
3. Sentry events still send (connect-src includes its ingest).

**Common gotchas:**
- Cloudinary image transformations sometimes serve from `*.res.cloudinary.com` subdomains; verify the host matches your account.
- Adding `'unsafe-inline'` to `script-src` defeats the purpose; only do it for styles if absolutely necessary and document why.

**Definition of done:**
- Tests cover: header present in responses; key directives match the policy.
- Commit: `feat(security): explicit CSP policy with Cloudinary and Sentry allowlist`
- Gate check: load the prod app; no CSP console errors.

---

### FEAT-48 — GitHub Actions deploy workflow

**Goal:** On push to `main`, build the multi-stage image and run `flyctl deploy --release-command "pnpm drizzle-kit migrate"` so migrations execute before traffic shifts; secrets pre-configured via `flyctl secrets set`. `[DEC-TBD: migrations run via release_command on deploy]` `[DEC-TBD: no staging environment, mitigated by Testcontainers and restore drills]`

**Estimate:** 2 hr. **Depends on:** FEAT-07, 06, 09. **Enables:** FEAT-49.

**Files:**
- `.github/workflows/deploy.yml`
- GitHub repo secret: `FLY_API_TOKEN`
- `docs/secrets-checklist.md` (or section in `OPERATIONS.md` later)

**Acceptance criteria:**
- [ ] Workflow triggers on push to `main` only
- [ ] Re-runs lint, typecheck, test as a gate (or depends on the CI workflow successful)
- [ ] `flyctl deploy --release-command "pnpm drizzle-kit migrate"` runs against the production app
- [ ] Migration failure aborts the deploy (no traffic shifts)
- [ ] Workflow surfaces deploy result (commit SHA, release id)
- [ ] All required `flyctl secrets` (Cloudinary, Resend, Sentry DSNs, Better Auth secret, Axiom token, R2 credentials, `FLY_API_TOKEN`) are checklisted and set ahead of first deploy
- [ ] Documented rollback: `flyctl releases rollback <release-id>`

**Implementation notes:**
- Build inside the workflow OR let `flyctl` build remotely — pick one (remote build is simpler if image is small).
- Keep the deploy job separate from CI to avoid double-work on PRs.

**Manual verification:**
1. Merge a no-op change to `main`; deploy workflow runs; production receives the new release.
2. Introduce a deliberately-broken migration on a branch; deploy aborts; production unchanged.

**Common gotchas:**
- `release_command` runs in a Fly Machine that gets torn down after; logs are short-lived. If a migration fails, capture logs via `flyctl logs --instance <release-id>` immediately.
- Secret rotation: changing a secret requires re-deploy or `flyctl machines restart`.

**Definition of done:**
- Tests cover: not applicable (workflow verified by observing a real deploy).
- Commit: `ci: deploy workflow with release-command migrations`
- Gate check: a push to `main` produces a successful production release including migration application.

---

### FEAT-49 — Nightly pg_dump → R2 backup workflow

**Goal:** A scheduled GitHub Actions workflow runs `pg_dump` via `flyctl proxy` against the Fly Postgres cluster and uploads the dump to a Cloudflare R2 bucket. `[DEC-TBD: off-site backup to R2, ~$0.50/month, vendor-catastrophe insurance]`

**Estimate:** 2–3 hr. **Depends on:** FEAT-48. **Enables:** FEAT-50.

**Files:**
- `.github/workflows/backup.yml` (cron)
- `scripts/backup.sh` (or inline in the workflow)
- GitHub secrets: `FLY_API_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`

**Acceptance criteria:**
- [ ] Workflow runs daily on a cron schedule (off-peak, e.g. 03:00 UTC)
- [ ] `flyctl proxy` connects to Fly Postgres in the workflow runner
- [ ] `pg_dump --format=custom` produces a compressed dump
- [ ] Dump uploaded to R2 with a date-stamped key (e.g. `dumps/YYYY-MM-DD.dump`)
- [ ] Retention policy in R2: keep last N days (configure via R2 lifecycle rule)
- [ ] Workflow failure produces a GitHub issue or notification (Slack? GitHub built-in email?)

**Implementation notes:**
- `flyctl proxy` runs in the background; the workflow needs to wait for the local port to be ready, then run `pg_dump` against `localhost:<port>`.
- Use the `aws` CLI with R2's S3-compatible endpoint for upload, or use a Cloudflare-published action.

**Manual verification:**
1. Trigger the workflow manually; observe successful dump and R2 upload.
2. Download the dump from R2; restore it locally to a fresh Postgres and verify a known query returns expected data.

**Common gotchas:**
- The Postgres client version on the runner must be compatible with the server's version — use Postgres' official `postgresql-client-N` package matching the server's major.
- R2 doesn't support some S3 features; verify the upload command uses the right region/endpoint.

**Definition of done:**
- Tests cover: not applicable (verified by manual restore).
- Commit: `ci: nightly pg_dump to R2`
- Gate check: a manually-triggered run uploads a dump that restores cleanly to a local Postgres.

---

### FEAT-50 — OPERATIONS.md and rehearsed restore drills

**Goal:** A single `OPERATIONS.md` documenting: Fly snapshot list + restore-to-new-cluster procedure, R2-dump-to-fresh-cluster procedure, app rollback via `flyctl releases rollback`, secrets management, alert response runbook. Both restore paths rehearsed at least once.

**Estimate:** 3 hr (writing + actual restore drill). **Depends on:** FEAT-49. **Enables:** confidence to launch.

**Files:**
- `OPERATIONS.md`
- Log of the rehearsed restores (date, outcome, time taken) appended

**Acceptance criteria:**
- [ ] Document covers: every secret and where it's configured; every alert and what to do when it fires; the two restore paths with exact commands; rollback command; how to find a release id; how to view Axiom/Sentry for an incident
- [ ] Fly snapshot restore rehearsed: list snapshots, create a fork cluster, point a staging app at it (or accept that it just verifies the snapshot is intact), verify a known row is present
- [ ] R2 dump restore rehearsed: download a recent dump, restore to a fresh local Postgres, verify a known row
- [ ] Both rehearsals dated and logged in the document
- [ ] Rollback rehearsed: deploy a noop, then `flyctl releases rollback` to a prior; observe traffic on the prior release

**Implementation notes:**
- Restore drills feel low-value until they're not. Run them with a stopwatch; record the time-to-restore.
- The document is the artefact; the drill is the validation.

**Manual verification:**
1. Read the document fresh; could a stranger follow it to restore?
2. Both rehearsals have actually been performed.

**Common gotchas:**
- A restore drill that "works" but doesn't actually load the data is worse than no drill. Verify a known row at the end.
- Document the *current* tooling — if `flyctl` syntax changes, the doc decays. Date the entries.

**Definition of done:**
- Tests cover: not applicable.
- Commit: `docs(ops): OPERATIONS.md with rehearsed restore drills`
- Gate check: a sceptical reader (you, in a week) reading the doc could follow it cold.

---

### FEAT-51 — Cold-start time measurement and auto-stop decision

**Goal:** Measure cold-start time after the machine has been auto-stopped; if it exceeds a 3-second budget for the user's first request, reconsider auto-stop (always-on at ~$5/month is the alternative). `[DEC-TBD: 3-second cold-start budget; auto-stop unless exceeded]`

**Estimate:** 1–2 hr. **Depends on:** FEAT-05, 06, 14. **Enables:** none specifically; informs ops cost decision.

**Files:**
- `docs/measurements.md` (extend)
- `fly.toml` (potentially: `min_machines_running` flipped if decision is always-on)

**Acceptance criteria:**
- [ ] Machine is allowed to auto-stop (verify via Fly dashboard)
- [ ] First request after sleep is timed, end-to-end from a remote `curl`, repeated several times for a stable measurement
- [ ] If average cold-start exceeds 3 s, document the decision: switch to always-on or accept the budget breach with justification
- [ ] Decision recorded in `docs/measurements.md` and (if applicable) `fly.toml` updated

**Implementation notes:**
- The first request after sleep includes machine wake + Node boot + first DB connection. esbuild's single-bundle helps; verify it's not e.g. 1.5 s of TypeScript transpile in dev configs leaking into prod.
- If consistently over budget, consider keeping `min_machines_running = 1` for a single small machine — the cost is small and the UX win is real.

**Manual verification:**
1. Force the machine to sleep (`flyctl machines stop` or wait); time the next request.
2. Repeat; tabulate.

**Common gotchas:**
- The Cloudflare proxy itself adds a few hundred ms during cold paths; measure both end-to-end and Fly-direct if accessible.
- The measurement is only valid for the current bundle size; redo it if the bundle changes meaningfully.

**Definition of done:**
- Tests cover: not applicable.
- Commit: `docs(ops): record cold-start measurement and auto-stop decision`
- Gate check: the decision and its supporting numbers are in `docs/measurements.md`.

---

### FEAT-52 — Playwright E2E for critical paths

**Goal:** Playwright covers the critical-path flows end-to-end against a real browser: sign in via magic link, create a recipe, plan a week including a batch-cook slot, generate the shopping list, check off items. Auth reuse via `storageState`. `[DEC-TBD: Playwright with storageState auth reuse]`

**Estimate:** 4 hr. **Depends on:** all functional features. **Enables:** confidence to deploy.

**Files:**
- `e2e/playwright.config.ts`
- `e2e/global-setup.ts` (sign in once, save storageState)
- `e2e/specs/*.spec.ts` (per critical path)
- CI workflow extension to run e2e against a deployed preview (or a dedicated e2e environment)

**Acceptance criteria:**
- [ ] `global-setup` performs one magic-link sign-in (with a special test path that returns the token directly when called with a known test header, OR by reading the most recent verification row from a test DB) and saves `storageState`
- [ ] Test 1: sign-in via the storage state loads the authed home page
- [ ] Test 2: create a recipe through the editor and see it on the browse page
- [ ] Test 3: create a plan, assign a batch-version meal to one slot and the corresponding base cook on an earlier slot
- [ ] Test 4: generate the shopping list and verify the line totals and the batch-no-double-count rule
- [ ] Test 5: check off items; reload; check state persists
- [ ] All five tests pass in CI within ~5 minutes total

**Implementation notes:**
- The magic-link test-helper path: a backend procedure exposed only when `NODE_ENV=test` that returns the latest verification token for an email; or seed the verification row directly. Document the chosen approach.
- Tests run against a clean DB (seed reference data, then start each test with a known fixture).

**Manual verification:**
1. `pnpm e2e` locally — all green.
2. CI runs — all green.

**Common gotchas:**
- Flaky tests around optimistic updates: use Playwright's `expect.poll` or `waitFor` rather than fixed timeouts.
- Magic-link verification token capture without compromising prod: only expose the test helper conditionally; double-check it can't be reached in prod.

**Definition of done:**
- Tests cover: see above acceptance criteria.
- Commit: `test(e2e): Playwright critical-path coverage with storageState auth`
- Gate check: e2e workflow green in CI.

---

### FEAT-53 — WCAG 2.1 AA spot-check via axe-core

**Goal:** Run axe-core inside Playwright against the main views (sign-in, recipe browse, recipe editor, planner, shopping list) in both light and dark themes; fail on violations.

**Estimate:** 2 hr. **Depends on:** FEAT-52, 16. **Enables:** none specifically.

**Files:**
- `e2e/specs/a11y.spec.ts`
- `e2e/playwright.config.ts` (extend)

**Acceptance criteria:**
- [ ] axe-core integrated via `@axe-core/playwright`
- [ ] Spec exercises: sign-in page, browse, editor, planner, shopping list
- [ ] Each view tested in both light and dark themes
- [ ] Test fails on any WCAG 2.1 AA violation (configurable severity threshold)
- [ ] Known accepted exceptions documented in `OPERATIONS.md` with reasoning (any colour-contrast tweaks are addressed, not waived, where possible)

**Implementation notes:**
- shadcn/ui defaults are generally AA-compliant; custom colours and tight contrast on hover/focus states are the usual offenders.
- Dark theme is where this most often surfaces problems — don't skip it.

**Manual verification:**
1. Run the a11y spec; review violations; fix or document accepted exceptions.
2. Repeat after each significant UI change.

**Common gotchas:**
- axe-core reports false positives occasionally; the documented-exception path lets you ignore individual rules per element, but be sparing.
- Toggling the theme in a test requires the same `ThemeProvider` plumbing as the user uses — test it via the settings page or by pre-setting a session.

**Definition of done:**
- Tests cover: axe-core run produces zero violations (or only documented ones) on each main view in both themes.
- Commit: `test(a11y): axe-core spot-check across main views and themes`
- Gate check: a11y spec green in CI; documented exceptions list reviewed and minimal.

---

---

## Cross-feature concerns and reuse-from-day-one

The 53 features above are sequenced for incremental delivery, but several concerns thread through many of them. Each item below is something where a *decision or pattern made in an early feature locks in costs or affordances for later ones*. Surfacing them now prevents the small inconsistencies that compound over a project of this size.

### 1. `req.id` propagation chain

**Threads through:** FEAT-03 (Pino HTTP req-id generation), FEAT-43 (Axiom transport carrying req.id), FEAT-44 (Sentry tag attaching req.id), FEAT-52 (e2e probably should expose req.id for debugging failed runs).

The value of req.id is *cross-referenceability*: an alert in Sentry should link to the matching Axiom entry should link to the response a user reported. That only works if the field name is identical across all three sinks and the value is preserved without re-generation along the way. **Decide the field name (`reqId`) at FEAT-03 and don't drift later.** Add a small assertion in a test: pick a request, capture its `reqId`, find it in both Axiom and (if errored) Sentry.

### 2. Zod schemas in `/shared`

**Threads through:** FEAT-01 (workspace structure), FEAT-04 (frontend imports), every procedure and every form thereafter.

The promise of "one schema, validated on both sides" only holds if `/shared/src/schemas/*` is the canonical home and both sides import from there. The temptation is to inline a quick schema in a procedure file — resist. **Set the convention in FEAT-17 (the first procedure) and hold it.** Every later feature inherits.

### 3. `CURRENT_HOUSEHOLD_ID` scoping discipline

**Threads through:** FEAT-09 (constant introduced), FEAT-17 onward (every domain query).

There is no scope-threading machinery; the constant is the discipline. The risk is that a single query slips through without `WHERE household_id = ?` and the code passes review because there are no other households to fail against. **Add a lint rule or a code review checklist item: "Every Drizzle query touching a household-scoped table must reference `CURRENT_HOUSEHOLD_ID`."** Re-evaluate when multi-tenancy actually arrives.

### 4. `withTransaction` helper as the only sanctioned multi-write boundary

**Threads through:** FEAT-09 (helper introduced), FEAT-20 (recipe save), FEAT-23 (pair symmetry), FEAT-27 (slot generation), FEAT-28 (range edits), FEAT-29 (duplication), FEAT-35 (account deletion), FEAT-38 (lazy-create + reset).

The plan calls out the transaction surfaces explicitly. Making `withTransaction` the *only* place multi-statement work happens — i.e. no ad-hoc `db.transaction(...)` calls scattered through procedures — concentrates the risk and makes audits trivial. **Test it has a clear stack-trace on failure**, since transaction-rollback errors are notoriously opaque.

### 5. The "pickable recipes" helper

**Threads through:** FEAT-19 (helper introduced), FEAT-23 (extended for `is_base`), FEAT-26 (related-recipes picker), FEAT-31 (recipe-bank), FEAT-32 (base picker).

There are multiple subtly-different "what recipes can I pick right now?" questions: any non-deleted recipe, only bases, only non-deleted-and-not-batch-version-of-deleted-base, etc. **Build it as one parameterised query helper in FEAT-19 rather than re-derived per feature.** When the rules change (e.g. "also exclude recipes the household has explicitly archived"), one site changes.

### 6. The searchable combobox primitive

**Threads through:** FEAT-21 (ingredient picker in editor), FEAT-23 (base + pair pickers in editor), FEAT-26 (related-recipes picker), FEAT-31 (slot editor recipe picker), FEAT-32 (base picker in slot editor).

Five consumers, one mental model: a debounced typeahead over a search query, parameterised by data source. **Build the primitive in FEAT-21 generic enough to consume in FEAT-23 without forking it.** The cost is one extra hour up front; the saving is consistent behaviour across the app.

### 7. Optimistic-update pattern

**Threads through:** FEAT-31 (first usage), FEAT-32 (base cooking), FEAT-33 (pair switch), FEAT-39 (check toggles), FEAT-42 (offline queue).

TanStack Query's `onMutate`/`onError`/`onSettled` pattern is the right tool. Five features touching it means five chances to drift. **Encapsulate the pattern in a small hook (`useOptimisticSlotUpdate`, generalised) in FEAT-31** so the rollback logic lives in one place. The offline queue (FEAT-42) is a strict superset — it adds a persistence layer — so structuring FEAT-31's hook with an injectable mutation function makes FEAT-42 a small extension rather than a rewrite.

### 8. The `dateUtils` module

**Threads through:** FEAT-27 (introduced for overlap + status filter), FEAT-37 (shelf-life), FEAT-34 (list view filter), FEAT-40 (per-day plant points).

The plan calls out "Europe/London time, centralised so multi-timezone is a localised change." Every "today"-relative computation must read from the module. **Forbid `new Date()` in domain code** (in review or via lint) and import from `dateUtils` instead.

### 9. The recipe DTO and the shopping-list DTO

**Threads through (recipe):** FEAT-19 (defined), FEAT-21 (editor), FEAT-23 (batch fields), FEAT-31 (planner sidebar), FEAT-26 (related), FEAT-36 (aggregation traverses base).

**Threads through (shopping):** FEAT-36 (defined), FEAT-37 (shelf-life adds to it), FEAT-39 (UI consumes), FEAT-42 (offline cache shape mirrors it).

Both DTOs are consumed by many features and changed by few. **Define them with explicit Zod schemas in `/shared` in FEAT-19 and FEAT-36 respectively** — adding fields is a small migration; renaming or restructuring is invasive. The `contributingSlots` shape inside the shopping DTO is particularly worth getting right because both the UI and the shelf-life logic depend on its details.

### 10. Plant-points calculation as a building block

**Threads through:** FEAT-19 (recipe-level), FEAT-40 (day + plan level with traversal).

The recipe-level computation in FEAT-19 is reused by FEAT-40, but the traversal logic (batch-version meals + base-cook union + dedup) is *new* in FEAT-40. **Keep the recipe-level helper pure and small** so the day/plan logic composes it without surprises. Resist optimising prematurely; the SQL approach (UNION + DISTINCT) is cleaner than client-side joining.

### 11. Domain error codes via `TRPCError.cause`

**Threads through:** FEAT-17 (`INGREDIENT_IN_USE` — first), then any procedure that needs a structured client response — FEAT-28 (destructive shrink), FEAT-26 (duplicate related), FEAT-30 (slot misuse).

The pattern: standard tRPC error code on `code`, domain code on `cause`. The frontend's error link maps both into UI states. **Establish the cause shape (`{ code: string, ...metadata }`) in FEAT-17** and add to the error link a single mapper to a typed UI error.

### 12. Pair-symmetry transaction pattern

**Threads through:** FEAT-23 (paired_recipe_id), and (in spirit) FEAT-26 (related_recipes — though DB-enforced).

`paired_recipe_id` symmetry is one of the trickier writes in the project (three rows touched, one of them potentially needing a clear). **Cover with explicit tests** for the four state transitions (new pair, repair, clear, third-party transition) before relying on it. If a future schema gains another symmetric relation, this is the template.

### 13. Lazy-create-on-read pattern for `shopping_list_items`

**Threads through:** FEAT-12 (table), FEAT-38 (lazy-create logic).

The plan's reasoning ("most plans never reach the shopping stage") makes lazy creation the right shape — but the read becomes a read-and-maybe-write. **The `getForPlan` procedure (FEAT-36 + FEAT-38) must run inside a transaction** because the read-write boundary crosses both the aggregation and the lazy-create. Don't optimise into separate read/write paths; one transaction keeps consistency.

### 14. Slot card rendering shape

**Threads through:** FEAT-31 (recipe-only slot card), FEAT-32 (base-cook two-line card), FEAT-33 (pair-switch button on card).

Three features touch the same component. **Build the slot card in FEAT-31 with explicit slots for future content** (e.g. a `secondaryLine` and an `actionButtons` array) so FEAT-32 and FEAT-33 add to it without rewriting.

### 15. Account deletion needs all the tables

**Threads through:** FEAT-11, FEAT-12, FEAT-22, FEAT-35.

The seven-step tombstoning sequence references every user-FK'd table. **FEAT-35 must wait until all those tables exist** (placing it at the end of Phase 4 is intentional). If a future feature adds a new user-FK'd table, the deletion sequence must be extended at the same time. Add a check (test or code review) that lists user-FK'd tables and compares to the sequence.

### 16. PWA scope vs. tRPC URL shape

**Threads through:** FEAT-04 (tRPC URLs settled), FEAT-41 (network-first match patterns), FEAT-42 (offline queue match patterns).

`@trpc/react-query` produces URLs like `/api/trpc/<procedure>?batch=1&input=...`. The Workbox runtime caching pattern (FEAT-41) must match on the procedure name segment, not the query string. **Avoid changing the tRPC URL shape later** (e.g. by reconfiguring `httpBatchLink` to `httpLink`) without revisiting the cache rules.

### 17. Better Auth migration path

**Threads through:** FEAT-10 (schema follows Better Auth), FEAT-14 (integration), every authenticated procedure.

The plan acknowledges Better Auth's risk as a young library with a migration plan to Lucia / roll-your-own. **Keep the boundary small.** Better Auth owns its tables; everything else references `user_id` directly. If migration becomes necessary, the change is bounded to the auth router and the session-reading code.

### 18. Cold-start ↔ pg-pool ↔ machine size

**Threads through:** FEAT-08, FEAT-09, FEAT-51.

Three measurement decisions that interact: machine size determines memory headroom, which constrains pool size, which contributes to cold-start time (more connections = longer first-request latency). **Re-measure cold-start (FEAT-51) after the pool is in use** (post-FEAT-09), not just after FEAT-05's empty deploy. The 3-second budget may bind at one of these surfaces unexpectedly.

### 19. The "soft-delete visible in history, hidden from new selection" rule

**Threads through:** FEAT-11 (`is_deleted` column), FEAT-19 (read procedures), FEAT-23 (base picker filter), FEAT-26 (related list), FEAT-30 (new-slot assignment rejected, edit-in-place allowed), FEAT-31 (recipe-bank filter).

The rule is consistent across all these features but easy to forget. **Codify it in the pickable-recipes helper (concern #5)** and document it once. The seven contexts above are the test surface; if a future feature adds another picker, it consumes the helper.

### 20. ESM-only is a system-wide constraint

**Threads through:** FEAT-01 onward.

Every dependency added must support ESM. Encountering a CJS-only package three months in is an expensive day. **Verify ESM support at the moment a dependency is proposed**, before pinning it. Particularly watch out for older auth/email/observability libraries — they're often CJS holdouts.

---

## Summary

**53 features across 6 phases.**

Phase 1 (infrastructure & CI) lays plumbing — 8 features, mostly small. Phase 2 (database & auth) is 8 features with one chunky schema split into three. Phase 3 (recipes & ingredients) is 10 features, the largest concentration because it includes the recipe editor's complexity. Phase 4 (meal planner) is 9 features including account deletion (placed here because all user-FK'd tables must exist first). Phase 5 (shopping list) is 7 features including the PWA and offline behaviour. Phase 6 (observability & deploy hardening) is 11 features, several of them documentation and measurement rather than code.

The 20 cross-cutting concerns above are not extra features — they are *patterns and decisions that the early features establish on behalf of the later ones*. Investing slightly more time in FEAT-09, 17, 19, 21, and 31 to get the reusable shapes right pays back across the rest of the project.

The highest-value places to spend the first day or two of extra care are: (1) the `/shared` Zod schema layout (FEAT-01/04), (2) the `pickable-recipes` helper shape (FEAT-19), (3) the optimistic-update hook (FEAT-31), and (4) the shopping-list DTO (FEAT-36). Mistakes in any of these compound through five or more downstream features.
