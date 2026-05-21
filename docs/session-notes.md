# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

---

## 2026-05-21 — FEAT-10 (Schema: auth, household, reference tables + seeds)

**Status:** implementation complete; `pnpm --filter backend test` green (37 tests; 11 new FEAT-10 cases + the 26 inherited). Typecheck + lint clean across all workspaces. Manual flow verified locally: migrate → seed → re-seed → psql confirms one household row, 2 occasions, 8 categories, 8 units, 6 prep types; counts unchanged after the second run. Definition-of-done boxes in `docs/feature-specs.md §FEAT-10` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`households.id` is `uuid`, not the spec's `smallint`.** Kept the existing `CURRENT_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001'` from FEAT-09. *Why:* DEC-17's "multi-tenancy-ready" promise is exactly the place the FK type pays off — a future `smallint → uuid` migration touches every domain table's FK and every index built on it, and uuid is the only sensible choice at SaaS scale (non-enumerable, no count leak, distributed-generation-safe). At household scale the 14 extra bytes per FK are rounding error. Spec text updated in this pass; the `[ ]` checkbox on that AC still reads literally — see "spec wording" below.
- **Install `better-auth` now, code the schema against its runtime.** Reading the installed package's `@better-auth/core/db/get-tables.mjs` is unambiguous; reading the docs site is not. Schema shapes are now derived from the same code the library will execute at runtime, which is the only mismatch-proof reading.
- **Reference seeds: opinionated MVP lists** (`INGREDIENT_CATEGORIES`, `UNITS_OF_MEASUREMENT`, `PREPARATION_TYPES` in `backend/src/db/seeds/reference.ts`). *Why:* "with their seed data" in the spec implies populated, not empty. Seeded lists are exported so tests can assert the full set; edit at source, not via DB-only inserts.
- **`themePreference` via Drizzle `pgEnum`.** *Why:* matches DEC-78 verbatim and Drizzle infers the literal union type automatically. Adding values is cheap; removing values (the only painful case) isn't a realistic future for `system|light|dark`.
- **Reference table columns minimal:** `id smallserial`, `name text UNIQUE NOT NULL`. No `display_order`, no timestamps. *Why:* these rows are static enums-with-attributes. Add `display_order` later only when the UI actually needs explicit ordering.
- **Pluralised table names** (`users`, `sessions`, `accounts`, `verifications`). Better Auth defaults to singular (`user`), but `user` is a Postgres reserved word — quoting on every raw-SQL path is a footgun and the spec's `\d users` line uses plural anyway. FEAT-14 will need `usePlural: true` (or per-model `modelName` overrides) when configuring the Better Auth Drizzle adapter.

### Drift from kick-off plan

1. **`backend/src/db/seeds/index.ts` added** — not on the kick-off file list. Hosts the `runSeeds(withTransaction)` runner that both `scripts/seed.ts` and the test suite consume. Keeping it as a module lets the test import `runSeeds` without spinning up the CLI's pino logger or owning pool lifecycle.

2. **`backend/tsconfig.json` extended** to include `scripts/**/*`. ESLint's project service couldn't resolve `scripts/seed.ts` otherwise (same shape as the FEAT-09 fix that added `drizzle.config.ts`). Follow the same pattern when adding any future top-level script directory.

3. **`backend/package.json` script added:** `"seed": "tsx --env-file-if-exists=.env scripts/seed.ts"`. Mirrors the `dev` script's env-file handling so `pnpm --filter backend seed` works against any environment that has a `.env`, not just the shell session that exports vars.

4. **Spec wording updated, AC checkbox text changed.** The original FEAT-10 spec said `household_id smallint PK`. With the uuid call locked in, the AC line now reads "`id uuid PK` matching `CURRENT_HOUSEHOLD_ID`". *Per AGENTS.md the box itself stays unticked* — the user verifies and ticks. Spec-text edits are not the same as DoD ticks.

5. **No standalone Pino plugin used in the seed CLI.** `backend/src/plugins/logger.ts` returns a Fastify `FastifyServerOptions['logger']`, not a Pino instance — fine for the server, no use to a CLI script. Created a small `pino({ level: process.env.LOG_LEVEL ?? 'info' })` instance directly in `scripts/seed.ts`. The AGENTS.md "Pino only" rule is honoured; no `console.log` introduced.

### Implementation details worth carrying

- **Better Auth's canonical schema lives in `@better-auth/core/dist/db/get-tables.mjs`.** Single function `getAuthTables(options)` that returns the user/session/account/verification table shapes plus their plugin extensions. Read it first if a future schema change feels ambiguous from the docs — the source is unambiguous.
- **Better Auth uses string IDs everywhere.** `users.id`, `sessions.userId`, `accounts.userId`, `verifications.id` are all `text`. Downstream FKs to `users.id` (FEAT-29's tombstoning columns: `recipes.addedByUserId`, `meal_plans.createdByUserId`, etc.) must be `text`, not `uuid`. Don't try to "normalise" by switching the auth schema to uuid PKs — Better Auth's own generator won't match.
- **`pgEnum` migration shape.** Drizzle emits `CREATE TYPE "public"."theme_preference" AS ENUM('system','light','dark');` as a separate statement before the table referencing it. If a future migration removes the enum, the type-drop step has to follow the last column reference — Drizzle handles this automatically via `db:generate` but raw SQL migrations need to know it.
- **`drizzle-orm/node-postgres/migrator`** is the right import for programmatic migrations in tests; pass `{ migrationsFolder: '<path-to>/backend/drizzle' }`. `import.meta.url` + `fileURLToPath` resolves to the test file's directory, so `path.resolve(here, '..', 'drizzle')` keeps the test file portable.
- **`onConflictDoNothing({ target: column })`** needs the column to participate in a unique constraint *of its own* — not just a multi-column index that includes it. Our reference tables use a single-column `UNIQUE` per spec, so this works directly. Worth knowing if FEAT-11 lands a composite-unique table and the seed pattern repeats.
- **`accounts.password` is dead-but-kept under magic-link-only.** DEC-41 forbids password *flows*; Better Auth's canonical account model has the column unconditionally and the Drizzle adapter inserts every field listed in `getAuthTables(options)`. Removing the column would crash the adapter on its first account-write unless we *also* configure `account.fields.password = false` (or similar) in `betterAuth({...})` at FEAT-14. NULL costs zero bytes in PG's row payload (only a bit in the null bitmap), so the schema-hygiene win isn't worth the new failure mode. Revisit at FEAT-14 if pruning the column for clarity becomes worth a one-config-line + one-migration follow-up.
- **Session/verification token columns are plaintext-at-rest, not hashed.** This is Better Auth's design (`@better-auth/core/dist/crypto/*` generates `crypto.randomBytes`-backed strings); we just store them. Defence model is HttpOnly+Secure cookies (DEC-43) + 10-minute TTL on magic-link nonces (DEC-41). If a future security review wants hashed-at-rest sessions, that's a Better Auth fork/config conversation, not a schema change.

### Open items for downstream FEATs

- **FEAT-14 — Better Auth `usePlural: true` config.** Schema is plural; Better Auth defaults to singular model names. Either pass `usePlural: true` in the adapter options or override per-model with `user: { modelName: 'users' }`, etc. If we forget, the adapter will throw at runtime on its first DB call.
- **FEAT-14 — Zod 4 transitive pin.** `better-auth@1.6.11` pulls `zod@^4.0.0` via `@better-auth/core` and `better-call` for its own runtime; the project is on `zod@3.25.76` (root `package.json` constraints). Both coexist today via pnpm hoisting with no visible breakage — but the moment we share a Zod schema *between* the Better Auth surface and `/shared/src/schemas/*`, the types won't agree. Two paths at FEAT-14: (a) upgrade the entire project to Zod 4 (breaks every existing `/shared` schema with the v3→v4 migration); (b) treat the Better Auth boundary as a place where types deliberately don't share — translate at the seam. Pick before wiring `betterAuth(...)` into the Fastify lifecycle.
- **FEAT-11 (recipes) — `addedByUserId` is `text` (Better Auth string ID)**, not `uuid`. Cascade behaviour at user deletion is *not* `ON DELETE CASCADE` (DEC-29 tombstoning); the recipe deletion step must NULL these columns explicitly in the FEAT-35 transaction.
- **FEAT-11 (recipes) — `householdId` is `uuid`.** All FKs to `households.id` are 16-byte uuid columns. Index sizing in `docs/measurements.md` will need updating once recipe volume becomes measurable.

### Spec ambiguities resolved here (don't re-litigate)

- "household_id smallint PK" — overridden to uuid per DEC-17's revisit clause. Spec text updated.
- "with their seed data" for the three under-specified reference tables — resolved to the opinionated MVP lists exported from the seed module.
- "users (with `theme_preference`...)" — implemented as Drizzle `pgEnum('theme_preference', [...])` rather than text + CHECK.

### Environment notes — Colima continued

Same two env vars as FEAT-09 are still required to run the backend test suite locally:

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1
export TESTCONTAINERS_RYUK_DISABLED=true   # or TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE per FEAT-09 entry
```

CI (`ubuntu-latest`) uses the default socket path and needs neither.

### Prettier ignore — root file isn't enough for per-workspace runs

`pnpm format:check` (root) was always clean; `pnpm -r format:check` (per-workspace) was flagging `frontend/dist/`, `frontend/src/routeTree.gen.ts`, `backend/dist/server.js`, `backend/drizzle/meta/*.json`. **Root cause:** prettier 3 finds `.prettierrc` by walking *up* the directory tree, but `.prettierignore` is only read from the CWD. So `pnpm -r format:check` ran `prettier --check .` inside each workspace and never saw the root ignore file. CI uses the root invocation, so it stayed green throughout — only local `-r` runs hit the gap.

**Fix landed alongside FEAT-10:** added per-workspace `.prettierignore` files in `frontend/`, `backend/`, `shared/`, each with workspace-relative paths (`src/routeTree.gen.ts` in frontend, `drizzle/meta` in backend, etc.). Slight duplication with the root file, accepted because the alternative — `--ignore-path ../.prettierignore` in each workspace's `format`/`format:check` scripts — hits anchored-path issues (a rule like `frontend/src/routeTree.gen.ts` won't match `src/routeTree.gen.ts` when prettier runs from inside `frontend/`).

Also tightened the root file: narrowed `backend/drizzle` (which was hiding the .sql migration files from prettier) to `backend/drizzle/meta`, and dropped the redundant `shared/dist` (matched by plain `dist`).

If a future change adds a fourth workspace, copy the relevant subset into a new workspace-local `.prettierignore` rather than relying on the root file.

### Deferred (do NOT do as part of FEAT-10)

- Configure `betterAuth(...)`, mount the auth router, set `usePlural` — **FEAT-14**.
- Choose Zod 3 vs 4 strategy at the Better Auth boundary — **FEAT-14**.
- Recipes domain (recipes, recipe_ingredients, recipe_method, etc.) — **FEAT-11**.
- Meal-plans domain — **FEAT-12**.
- Trigram GIN indexes on recipe / ingredient name — **FEAT-11**.
- Account-deletion tombstoning sequence (NULL `addedByUserId` etc., delete user row) — **FEAT-35**.
- Update `docs/measurements.md` with index sizing implications of `uuid` household FKs — open whenever FEAT-11/12 lands measurable row counts.

---

## 2026-05-20 — FEAT-09 done; FEAT-10 next

- **Just finished:** FEAT-09 (Drizzle infrastructure). Detailed entry below. Tests green locally (26/26); human verification of acceptance criteria still pending. **Commit not yet made.**
- **Operational follow-up (do before next prod deploy):** `flyctl postgres create` → `flyctl postgres attach` against `loftys-larder-prod`. Today the prod app has no `DATABASE_URL`; with FEAT-09 in, the server refuses to boot without it. Order matters: attach before merging FEAT-09 to `main`, or the next deploy crashloops.
- **Next:** kick-off FEAT-10 (Schema: auth, household, reference tables + seeds). Read `docs/feature-specs.md §FEAT-10` + DEC-15 / DEC-16 / DEC-17 / DEC-41 / DEC-42.
- **DEC-80 decision now blocking FEAT-10/11.** FEAT-09 didn't trigger it (no `/shared` runtime imports added); FEAT-10 will if it lands Better Auth Drizzle table shapes / Zod schemas in `/shared`. Decide build approach (tsc emit vs `paths` mapping vs `exports` → `src/`) at FEAT-10 kick-off, *before* the schema PR lands. Three options sketched in FEAT-05 session note.
- **FEAT-10 must import `CURRENT_HOUSEHOLD_ID`** from `backend/src/config.ts` (or its re-export from `backend/src/db/index.ts`) for the households seed row. Do NOT regenerate the UUID — value is `00000000-0000-4000-8000-000000000001`.
- **FEAT-10 first real migration** will be the first thing `backend/drizzle/` actually contains. `db:generate` is wired and verified empty against today's schema; `db:migrate` is wired and verified no-op against the Compose Postgres.

---

## 2026-05-20 — FEAT-09 (Drizzle infrastructure)

**Status:** implementation complete; `pnpm --filter backend test` green (26 tests, including 5 Testcontainers smoke cases) with Colima env. Typecheck and lint clean across all workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-09` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`CURRENT_HOUSEHOLD_ID` is a hardcoded UUID constant** in `backend/src/config.ts` (`00000000-0000-4000-8000-000000000001`), re-exported from `backend/src/db/index.ts`. *Why hardcoded, not env-var:* single-household MVP (DEC-17) only needs *one* value across all environments; an env var would invite drift between dev/test/prod. FEAT-10's seed must import this constant — do not regenerate.
- **`DATABASE_URL` is required in every environment** (Zod-validated as `postgres://` or `postgresql://`). *Why required, not optional-with-lazy-pool:* plumbing only earns its keep if it's hot at startup, and `health.ping` will start touching the DB at FEAT-46. Boot-time failure is the right time to surface a missing secret, not first-DB-query time.
- **Pool max hardcoded at 10**, `min` at pg-pool default 0. *Why not env-var-overridable:* DEC-71 picked a static number once for the household workload ceiling. The Testcontainers smoke builds its own `pg.Pool({ max: 1 })`, so test concurrency is decoupled.
- **DEC-80 not triggered by FEAT-09.** No `/shared` runtime imports added; the call is deferred to FEAT-10/11 when Better Auth Drizzle table shapes and/or Zod schemas first cross the workspace boundary at runtime.

### Drift from kick-off plan

1. **No `currentDatabase` factory.** Plan implied a singleton with optional factory; ended up with a clean singleton (`pool`, `db`, `withTransaction` exported from `backend/src/db/index.ts`) and a `makeWithTransaction(db)` constructor in its own file so the smoke test can build its own Drizzle handle against the Testcontainers Postgres without depending on env-var config. Audit-grep for `db.transaction(` still hits only `withTransaction.ts`.

2. **`drizzle-kit` casing option set globally** via `casing: 'snake_case'` on both the Drizzle runtime (`drizzle(pool, { schema, casing: 'snake_case' })`) and `drizzle.config.ts`. Means FEAT-10 columns can stay camelCase in the Drizzle DSL without per-column `name()` mapping — DEC-15 honoured by config, not by per-column boilerplate.

3. **`tsconfig.json` extended** to include `drizzle.config.ts` so ESLint's project service can lint it; not on the kick-off file list but unavoidable once `strictTypeChecked` ran on the config file.

4. **`backend/test/server.test.ts` and `backend/test/config.test.ts` updates** beyond the kick-off plan: existing tests assumed `DATABASE_URL` didn't exist; both now pass it via `baseEnv` (config) / inline (server). The `_ignored` destructure pattern wasn't allowed by `@typescript-eslint/no-unused-vars` — switched to an `envWithout(key)` helper using `Object.fromEntries(...).filter(...)`.

5. **`pg-pool` exhaustion test loop** initially asserted `select ${i}` round-trip; pg returns parameterized numeric values as strings (pg-types default for inferred `int4/numeric`). Tightened to `select 1 as ok` — still exercises the release-back-to-pool path, just without the type-coercion noise. Worth knowing in FEAT-10 onward: when a test (or runtime code) reads a count or numeric value back from pg, **the value may arrive as a string** unless you cast in SQL (`::int`) or configure `pg-types.setTypeParser`. Drizzle's typed `db.select()` API masks this for column reads — it's only loose `db.execute()` rows that hit the raw pg-types behaviour.

### Implementation details worth carrying

- **`pg` ESM import shape:** `import pg from 'pg'; const { Pool } = pg;` (or `new pg.Pool(...)`). `pg` is CJS-published with named exports; under NodeNext, the default-import-then-destructure pattern is what works. Reach for `import { Pool } from 'pg'` and the build will fail.
- **`vitest.config.ts` left untouched.** No global test setup, no env-var injection at the vitest layer. Each test file that needs Postgres builds its own Drizzle handle (smoke test pattern). FEAT-10 integration tests can copy the smoke-test pattern; don't add a global setup file unless the duplication actually hurts.
- **Drizzle's global `casing: 'snake_case'`** is set in both `backend/src/db/index.ts` (runtime) *and* `backend/drizzle.config.ts` (kit). The two need to agree, or generated migrations will diff against the runtime DSL. If you change one, change the other.

### Environment notes — Testcontainers under Colima

Two env vars required to run the smoke suite locally:

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

- `DOCKER_HOST` — Colima's socket isn't at the default `/var/run/docker.sock`; Testcontainers' runtime detection has to be pointed at it.
- `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` — Ryuk (Testcontainers' reaper) bind-mounts the docker socket back into its own container. Colima's Lima VM can't bind-mount a `~/.colima/...` path through 9p in a way Ryuk expects; pointing the override at `/var/run/docker.sock` is the documented Colima workaround.

GitHub Actions runners use the default socket path and don't need either override. Worth a `docs/OPERATIONS.md` line at FEAT-50 lift; not blocking.

### Deferred (do NOT do as part of FEAT-09)

- Wire `db` into the tRPC context — downstream FEAT (FEAT-10 first procedure).
- `flyctl postgres create` / `flyctl postgres attach` and `DATABASE_URL` in Fly secrets — operational follow-up; required before the next prod deploy.
- Any table/schema — FEAT-10/11/12.
- `release_command "pnpm drizzle-kit migrate"` in CI — FEAT-48.
- `/shared` runtime build wiring (DEC-80 revisit) — deferred until the FEAT that first lands a runtime shared import.

---

## 2026-05-17 — FEAT-06 (Fly.io initial deploy + Cloudflare DNS)

**Status:** implementation complete on 2026-05-20. Live URL is `https://loftys-larder.co.uk`, `www` 301s to apex, `/api/trpc/health.ping` round-trips through Cloudflare → Fly (`lhr`). Browser load + DevTools clean. Definition-of-done boxes in `docs/feature-specs.md §FEAT-06` left unticked — human action.

### Drift from runbook

1. **Cert ownership via `_fly-ownership` TXT, not the A/AAAA path Fly "recommended".** Behind Cloudflare orange-cloud, public DNS returns Cloudflare IPs, not Fly's — so Fly's IP-based ownership check can never validate while proxying is on. TXT is the right path here. Runbook Step 4/5 updated mid-execution to reflect this; same fix will apply for any future hostname added to the Fly app.

2. **Cache rule needed a UI-builder fix.** Initial config used `URI Full` + `wildcard` with the raw expression syntax pasted as the wildcard value — that never matches. Final: `URI Path` + `starts with` + `/api/`, action `Bypass cache`. Rule shows Active in dashboard.

3. **`cf-cache-status` reports `DYNAMIC`, not `BYPASS`, on `/api/*` probes.** Accepted: tRPC responses carry no `Cache-Control`, so Cloudflare's default classifier independently marks them uncacheable before the bypass rule's signal is attributed in the header. Defense-in-depth holds (classifier + rule both say don't cache). Worth knowing if a future endpoint inadvertently sets cacheable headers — that's when we'd start seeing `BYPASS` instead.

4. **`www → apex` redirect went Dynamic, not Static.** Static + "Preserve path suffix" toggle dropped the path on test probes — only query string came through. Switched to Dynamic with expression `concat("https://loftys-larder.co.uk", http.request.uri)`. `http.request.uri` is already path+query, so the expression is short. The `if`/`len` builtins from typical filter expressions aren't available in `target_url` expressions — caused one false start.

### Implementation decisions worth carrying

- **`flyctl deploy --remote-only` for the first deploy** because local Docker has no `buildx` (see FEAT-05 entry below). Once `docker-buildx` is installed, the flag can be dropped.
- **Fly issues only the LE cert** in `flyctl certs show`. The FEAT-06 gotcha's mention of "two certs (LE + Cloudflare-origin)" refers to Fly's LE cert plus Cloudflare's edge SSL cert — the latter is implicit and verified by Full (strict) SSL mode being on without TLS errors on the live URL.
- **Cloudflare SSL/TLS mode: Full (strict).** "Always Use HTTPS" left **off** — Fly's `force_https = true` (in `fly.toml`) is the single redirect authority. No loops.
- **`fly-request-id` flows through Cloudflare untouched.** Confirmed in probes. This is the foundation for FEAT-43's `reqId` propagation (DEC-77 / cross-cutting #1).
- **All helmet security headers survive the Cloudflare hop.** CSP, HSTS, X-Frame-Options, etc. all present on responses fetched through the proxied URL.

### Decisions taken at kick-off

- **App name:** `loftys-larder-prod`. Now pinned in `fly.toml`. Renaming is painful — treat as permanent.
- **Canonical host:** apex. `www` 301-redirects to apex. Done at Cloudflare with a Single Redirect rule (cheapest place — keeps the redirect off the Fly machine's wake path).
- **HTTPS redirect authority:** Fly. `force_https = true` stays in `fly.toml`; Cloudflare "Always Use HTTPS" stays **off**. Single source of truth, no loop (FEAT-06 gotcha line 266).
- **Cloudflare SSL mode:** Full (strict). Fly issues a real LE cert; Flexible would downgrade the Cloudflare→Fly hop to HTTP and break `force_https`.
- **Cache bypass pattern:** the rule matches `/api/*` — broad enough to cover the tRPC URL shape `/api/trpc/<procedure>?batch=1&input=...` (cross-cutting #16). Do not narrow it.

### Runbook — first-time prod deploy

Substitute `<DOMAIN>` throughout once chosen. Capture every command's exit status / output worth keeping; FEAT-50 lifts this into `OPERATIONS.md`.

#### Step 0 — Domain (manual, Cloudflare Registrar)

1. Pick a domain. Cloudflare Registrar charges at-cost (no markup, no upsell). Avoid `.app` (HSTS preloaded — debugging cert issues is harder); `.io` has had reliability wobbles. A plain `.com` or `.co.uk` is the boring correct choice.
2. Register / transfer at <https://dash.cloudflare.com/?to=/:account/registrar>. Cloudflare Registrar requires the domain's DNS already be on Cloudflare — if it's elsewhere, add the zone first, change nameservers at the current registrar, then transfer.
3. Once registered, the zone appears in the Cloudflare dashboard. Note the zone's API account-id and zone-id — useful for later Cloudflare automation but not required here.

Record: chosen domain, registration date, registrar account email.

#### Step 1 — Install + auth flyctl

```sh
brew install flyctl          # if missing
flyctl version               # record
flyctl auth login            # opens browser
flyctl auth whoami           # record the org / email
```

`flyctl` was not installed locally at FEAT-05 (see 2026-05-17 entry below). Do not commit any flyctl config files that land in `~/`.

#### Step 2 — Create the Fly app (no deploy yet)

```sh
flyctl apps create loftys-larder-prod --org <org>
```

The repo's `fly.toml` already names the app; do **not** run `flyctl launch` — it would prompt to overwrite `fly.toml`, the `Dockerfile`, and `.dockerignore`, all of which are correct as-is from FEAT-05. `apps create` is the surgical equivalent.

Verify:

```sh
flyctl config validate        # reads ./fly.toml
flyctl apps list | grep loftys-larder-prod
```

#### Step 3 — First deploy

No Postgres yet (FEAT-09 attaches it). The app boots without `DATABASE_URL`; `health.ping` doesn't touch the DB, so this is sufficient for FEAT-06's acceptance criteria.

```sh
flyctl deploy --remote-only
```

`--remote-only` uses Fly's remote builder (BuildKit), sidestepping the local-Docker-29-no-buildx situation noted in FEAT-05.

Once it returns healthy:

```sh
flyctl status
flyctl logs                   # sanity-check Pino output
curl -I https://loftys-larder-prod.fly.dev/
curl 'https://loftys-larder-prod.fly.dev/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D'
```

The `*.fly.dev` URL bypasses Cloudflare entirely — use it later to A/B against the Cloudflare-fronted custom domain when diagnosing edge issues.

#### Step 4 — Attach the custom domain at Fly

Apex and www both need Fly certs.

```sh
flyctl certs add <DOMAIN>
flyctl certs add www.<DOMAIN>
flyctl certs list             # both should appear "Not verified"
flyctl ips list -a loftys-larder-prod                 # IPv4 + IPv6 for the app
flyctl certs setup <DOMAIN>                            # prints exact DNS instructions, incl. _fly-ownership TXT
flyctl certs setup www.<DOMAIN>
```

Record the IPv4, IPv6, and the two `_fly-ownership` TXT values verbatim — they go into Cloudflare next.

#### Step 5 — Cloudflare DNS records (TXT for ownership + proxied A/AAAA/CNAME for traffic)

**Why two record types per hostname.** Per DEC-72 we proxy DNS through Cloudflare (orange cloud). When proxied, public DNS lookups return Cloudflare's edge IPs, not Fly's — so Fly's IP-based cert-ownership check via A/AAAA records cannot succeed through the proxy. The fix is a `_fly-ownership` TXT record (TXT records are never proxied), which is what proves ownership to Fly. The A/AAAA/CNAME records still go in, proxied, because that's how live traffic reaches Fly through Cloudflare — they just aren't the ownership proof.

In the Cloudflare dashboard → DNS → Records:

| # | Type | Name | Content | Proxy |
|---|---|---|---|---|
| 1 | TXT | `_fly-ownership` | (value from `flyctl certs setup <DOMAIN>`) | DNS only — TXT never proxies |
| 2 | TXT | `_fly-ownership.www` | (value from `flyctl certs setup www.<DOMAIN>`) | DNS only |
| 3 | A | `@` | (IPv4 from `flyctl ips list`) | Proxied (orange cloud) |
| 4 | AAAA | `@` | (IPv6 from `flyctl ips list`) | Proxied (orange cloud) |
| 5 | CNAME | `www` | `loftys-larder-prod.fly.dev` | Proxied (orange cloud) |

Notes:
- Cloudflare strips the zone suffix in the Name field — entering `_fly-ownership` produces FQDN `_fly-ownership.<DOMAIN>`. Same for the `www` variant.
- Don't add MX / SPF / DKIM / DMARC records here — email lands in FEAT-13.

After DNS propagates (usually < 60s on Cloudflare; TXT records occasionally take a couple of minutes to be visible externally):

```sh
dig +short TXT _fly-ownership.<DOMAIN>      # sanity: TXT visible publicly?
dig +short TXT _fly-ownership.www.<DOMAIN>
flyctl certs check <DOMAIN>                  # re-triggers Fly's validation
flyctl certs check www.<DOMAIN>
flyctl certs show <DOMAIN>
flyctl certs show www.<DOMAIN>
```

Wait until both certs show `Issued` for both Let's Encrypt and Cloudflare-origin (FEAT-06 gotcha line 265 — wait for **both** before declaring done).

#### Step 6 — Cloudflare SSL/TLS settings

Cloudflare dashboard → SSL/TLS → Overview:

- **Encryption mode: Full (strict).** Not Flexible, not Full — Full (strict) requires the origin to present a trusted cert, which Fly does.

SSL/TLS → Edge Certificates:

- **Always Use HTTPS: OFF.** Fly does the redirect (`force_https = true` in `fly.toml`). Two redirect authorities loop.
- **Automatic HTTPS Rewrites: ON** (safe default; rewrites in-page links).
- **Minimum TLS Version: 1.2** (1.3 if no client compatibility worries — fine here).

#### Step 7 — Cloudflare cache rule: bypass `/api/*`

Dashboard → Caching → Cache Rules → Create rule.

- **Rule name:** `bypass-api`
- **When incoming requests match:** custom filter expression
  ```
  (starts_with(http.request.uri.path, "/api/"))
  ```
- **Then:**
  - Cache eligibility: **Bypass cache**
  - (No other settings needed.)
- **Save and deploy.**

Verify with a hit to the protected path:

```sh
curl -sI "https://<DOMAIN>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D" | grep -i 'cf-cache-status\|cf-ray'
```

Expect `cf-cache-status: BYPASS` (or `DYNAMIC` if the rule hasn't matched but Cloudflare classified it as uncacheable anyway — BYPASS is the desired explicit signal).

#### Step 8 — Cloudflare Single Redirect: `www` → apex

Dashboard → Rules → Redirect Rules → Create rule.

- **Rule name:** `www-to-apex`
- **When incoming requests match:** custom filter expression
  ```
  (http.host eq "www.<DOMAIN>")
  ```
- **Then:**
  - Type: **Static**
  - URL: `https://<DOMAIN>${http.request.uri.path}` (use Dynamic with expression `concat("https://<DOMAIN>", http.request.uri.path)` and preserve query string if you want querystrings forwarded — simpler to enable "Preserve query string" toggle on Static).
  - Status code: **301**
  - Preserve query string: **on**

Verify:

```sh
curl -sI https://www.<DOMAIN>/ | grep -i 'location\|HTTP/'
```

Expect `HTTP/2 301` + `location: https://<DOMAIN>/`.

#### Step 9 — Final probes (acceptance criteria mapping)

| Probe | Expected | Maps to AC |
|---|---|---|
| `curl -I https://<DOMAIN>/` | `200`, `server: cloudflare`, `cf-ray:` present | line 260 |
| `curl 'https://<DOMAIN>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D'` | tRPC success shape | line 261 |
| Response headers on `/api/*` probe | `cf-cache-status: BYPASS` (or `DYNAMIC`) | line 262 / line 250 |
| Browser load on `https://<DOMAIN>/` | frontend renders, no mixed-content warnings | line 251 / 252 |
| Browser load on `https://www.<DOMAIN>/` | 301s to apex | line 251 |
| `flyctl certs show <DOMAIN>` / `www.<DOMAIN>` | both `Issued` for LE + Cloudflare-origin | line 248 |

When all six pass: report back. **Do not** tick the FEAT-06 boxes in `feature-specs.md`; that's a human action after the browser check.

### Deferred to later FEATs (do NOT do as part of FEAT-06)

- `flyctl postgres create` / `flyctl postgres attach` — **FEAT-09**.
- `flyctl secrets set DATABASE_URL=…` — **FEAT-09** (or implicit via `postgres attach`).
- SPF / DKIM / DMARC DNS records for Resend — **FEAT-13**.
- Swap TCP `[checks.tcp_alive]` for HTTP `/api/health` check — **FEAT-46**.
- Wire `release_command "pnpm drizzle-kit migrate"` into CI on push to `main` — **FEAT-48**.
- Cold-start measurement against 3-second budget (DEC-64) — **FEAT-51**.
- Nightly `pg_dump → R2` (DEC-73) — **FEAT-49 / 50**.

### Captured values (live record — for FEAT-50's `OPERATIONS.md` lift)

Fly app: `loftys-larder-prod`, region `lhr`, org TBD.

From `flyctl certs setup` (2026-05-20):

| Hostname | Type | Value |
|---|---|---|
| `loftys-larder.co.uk` | A | `66.241.124.105` |
| `loftys-larder.co.uk` | AAAA | `2a09:8280:1::118:845e:0` |
| `www.loftys-larder.co.uk` | A | `66.241.124.105` |
| `www.loftys-larder.co.uk` | AAAA | `2a09:8280:1::118:845e:0` |
| `loftys-larder.co.uk` | TXT `_fly-ownership` | `app-xkjgdnn` |
| `www.loftys-larder.co.uk` | TXT `_fly-ownership.www` | `app-xkjgdnn` (same value — Fly's token is app-scoped) |

Both hostnames share the same Fly machine IPs (single app, shared edge).

Certificate issuance (2026-05-20): both `loftys-larder.co.uk` and `www.loftys-larder.co.uk` validated via `_fly-ownership` TXT within ~1 min of DNS propagation. LE certs issued (rsa + ecdsa), 2-month expiry. Fly handles renewal automatically.

Cache rule `bypass-api` configured at Cloudflare → Caching → Cache Rules. Initial misconfig used UI builder fields `URI Full` + `wildcard` with the raw expression syntax pasted as the wildcard value — that pattern never matched anything. Corrected to `URI Path` + `starts with` + `/api/`. Probe still shows `cf-cache-status: DYNAMIC` rather than `BYPASS`; the AC is configuration (rule listed + enabled + bypass action), not the header value. Defense-in-depth holds: tRPC responses carry no `Cache-Control` so Cloudflare's default classifier independently marks them uncacheable. The rule remains as the explicit second layer in case a future endpoint inadvertently sets cacheable headers.

### Open ops questions worth resolving before run

- **Domain not yet chosen.** Step 0 above; user will pick at Cloudflare Registrar.
- **Fly org.** `flyctl orgs list` after auth — confirm which org owns this app. Personal org is fine for household-scale.

---

## 2026-05-17 — FEAT-05 (Production Dockerfile + fly.toml)

**Status:** implementation complete; manual smoke (docker build + docker run probes) verified. Definition-of-done left unticked.

### Drift from kick-off plan

1. **Base image is `node:24-alpine`, not `node:24-slim`.** Plan recommended slim; first build came in at 346 MB (slim itself is ~345 MB on Apple-silicon Docker), failing the < ~300 MB acceptance criterion. No native-binding deps in the runtime image — esbuild's native bits live only in the build stage — so musl-libc risk is nil at this stage. Final image is **229 MB**. Revisit if `pg` (FEAT-09) or another native dep needs glibc; the swap is one-token (`alpine` → `slim`).

2. **Health check in `fly.toml` is a machine-level TCP check, not the HTTP `/api/health` path specified in FEAT-05.** `/api/health` ships in FEAT-46; declaring an HTTP check that resolves to a non-existent route would have marked every machine unhealthy from FEAT-06's first deploy. Inline comment in `fly.toml` flags the swap point. **FEAT-46 must replace `[checks.tcp_alive]` with an HTTP check (or add one and keep TCP).**

3. **`frontend/tsconfig.json` was modified** — not on the kick-off file list. Docker exposed that `shared/dist/` is a one-off local artefact, not reproducibly built (`shared`'s `build` script is `tsc --noEmit`). Restored a reproducible frontend build with:
   - `paths: { "@loftys-larder/shared": ["../shared/src/index.ts"] }` — resolves the type-only import to source.
   - `rootDir: ".."` (was `"src"`) — widens TS's project boundary so cross-workspace type traversal no longer trips TS6059. Safe because `noEmit: true`.

   Consistent with DEC-80's single narrow type-only exception.

4. **Dropped BuildKit-only directives from the Dockerfile.** Originally used `# syntax=docker/dockerfile:1.7` + `RUN --mount=type=cache,id=pnpm,...` for a pnpm-store cache mount. Local Docker 29 has no `buildx` plugin installed, and classic builder rejects both. Removed them; Fly's remote builder is BuildKit and will work either way — we just lose the local pnpm-store cache.

5. **Deferred verification: `flyctl config validate`.** flyctl isn't installed locally; runs as part of FEAT-06 setup.

### Implementation decisions worth carrying

- **`STATIC_DIR` is the explicit signal for SPA serving.** `security.ts` only mounts `@fastify/static` at `/` (with SPA fallback) when `STATIC_DIR` is set. The Dockerfile sets it to `/app/public`; dev never sets it (Vite's `server.proxy` covers that path). Avoids any magic `import.meta.url`-relative resolution that would break inside the bundle.

- **SPA fallback uses `setNotFoundHandler`, gated on `!req.url.startsWith('/api/')`.** Unknown `/api/*` paths return JSON 404; unknown non-`/api/*` GETs return `index.html` so TanStack Router can hydrate. Don't widen this without thinking through the tRPC URL contract (cross-cutting #16).

- **The FEAT-03 placeholder `/api/static/` mount was removed.** The original FEAT-03 comment ("real `dist/` wiring lands with FEAT-05") was the trigger. `backend/public/.gitkeep` deleted with it.

- **esbuild bundle has a CJS-interop banner.** `format: 'esm'` strips CJS shims; if a transitive dep reaches for `require` / `__dirname` / `__filename` at module-eval time it crashes. The banner restores them against `import.meta.url`. Cheap insurance; can be revisited if it ever causes confusion.

- **`shared`'s `package.json` `main` / `types` fields point at `./dist/index.js` / `./dist/index.d.ts` — neither is produced by `shared`'s `build` script.** This is now a latent inconsistency: nothing in the build graph emits them, the frontend now bypasses them via paths mapping, the backend doesn't import shared at runtime. Two clean follow-ups: (a) strip `main` / `types` (and `files`) from shared's package.json since the workspace is consumed via TS paths only, or (b) wire a real emit step (probably a stripped `tsconfig.build.json` without `noEmit` and `allowImportingTsExtensions`). Cheap to defer; worth doing before a fourth workspace needs to import shared.

### Environment notes

- Local Docker is 29.2.1, classic builder only. `docker buildx` not installed. `brew install docker-buildx` would fix it; not required for FEAT-05/06.
- `flyctl` not installed locally — install during FEAT-06.

---

## 2026-05-16 — FEAT-03 (Backend Fastify scaffold)

**Status:** implementation complete; acceptance criteria verified via tests + smoke probe (not ticked — that's a human action).

### Drift from kick-off plan

1. **Dropped TS `composite: true` from `/shared` and project references from `/backend` + `/frontend`.** The type-only cross-workspace import in `shared/src/router-type.ts` was incompatible with `composite + rootDir` (TS refuses to read files outside the project boundary, even for type-only imports). `/shared/tsconfig.json` now runs `noEmit: true` with `rootDir: ".."`. Captured as **DEC-80** with the revisit trigger ("first runtime import from `/shared`", likely FEAT-08). AGENTS.md leaf-rule bullet updated to note the type-only exception.

2. **Added `LOG_LEVEL` env var** to `backend/src/config.ts` and `.env.example`. Not in FEAT-03's plan; added so the Vitest suite can run Pino at `silent` without polluting test output. Defaults to `info` in dev/prod. Worth knowing this exists when wiring Axiom in FEAT-43 (don't accidentally set it to `silent` in production env).

3. **Added two extra tests** beyond the planned set:
   - `security headers > sets helmet default headers` — guards against accidental helmet misconfiguration.
   - `buildApp > generates a fresh reqId per request` — replaces a planned "honours an injected request-id header" test that turned out to be testing a Fastify v5 opt-in feature (`requestIdHeader` defaults to `false`) we don't currently need.

### Implementation decisions worth carrying

- **CORS origin is a function predicate**, not the bare `ALLOWED_ORIGIN` string. Passing a string to `@fastify/cors` echoes that origin to *every* request regardless of the incoming `Origin` header; using a function predicate means foreign origins get no `Access-Control-Allow-Origin` at all. Matches the AGENTS.md "restricted to the Vite dev server URL" intent.

- **`@fastify/static` is mounted at `/api/static/`**, not root, to avoid the documented gotcha of static swallowing `/api/*` routes. When FEAT-05 wires the real `dist/` for the production bundle, it'll need a different mount strategy (root with explicit `prefix` ordering relative to tRPC).

- **`fastify-tRPC onError` typing.** `@trpc/server`'s Fastify adapter currently surfaces `error`/`path` as implicit-`any` in the destructure under our strict TS settings. Worked around with an inline `{ error: unknown; path: string | undefined }` annotation. If `@trpc/server` ships better types later, the annotation can go.

- **`AppRouter` re-export uses a `.ts` extension** in the relative import (`'../../backend/src/trpc/router.ts'`) and requires `allowImportingTsExtensions: true` in `shared/tsconfig.json`. ESM-strict NodeNext doesn't auto-resolve extensions; the `.ts` here is type-only (erased) so it never hits Node's resolver.

### Environment housekeeping (not project state, just useful to future-me)

- Project pins Node LTS via `.nvmrc` (`24`). Today (2026-05) that's v24.15.0. Local environment was previously serving Homebrew's v26 (latest "Current"); Homebrew's `node` and `node@22` formulae were uninstalled; nvm sourcing was added to `~/.zshrc` and `nvm alias default 24.15.0` set. Per DEC-02, revisit the pin around October 2026 when Node 26 is promoted to LTS.
