# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

---

## 2026-06-22 — FEAT-49 (GitHub Actions deploy workflow)

**Status:** workflow file + secrets checklist written. No code paths exercised — first real verification is a push to `main` once the Fly app and runtime secrets exist. DoD in `docs/feature-specs.md §FEAT-49` left unticked.

### Drift from kick-off plan

1. **Deploy gates on the `CI` workflow via `workflow_run`,** not by re-running lint/typecheck/test inline. Matches the spec's "depends on the CI workflow successful" branch and avoids paying the gate cost twice on every push to `main`. Trade-off: `workflow_run` triggers always resolve the workflow file from the default branch, and the commit SHA must be propagated explicitly via `github.event.workflow_run.head_sha` — the workflow does this, and `actions/checkout` pins to that SHA so a fast follow-on push can't sneak into the wrong release.

2. **Added `workflow_dispatch` with an optional `sha` input.** Outside the spec but lets us re-deploy a SHA without an empty commit (e.g. after rotating a Fly secret with `--stage`, or to retry a transient builder failure). User confirmed.

3. **`concurrency: deploy-production` with `cancel-in-progress: false`.** A second push during a deploy queues instead of aborting mid-`release_command`. A cancelled deploy mid-migration would leave us in an awkward state with no clean rollback target — queueing is the safer default for our scale.

4. **Surfaced "release id" as `flyctl releases --json | jq -r '.[0].Version'`,** wrapped in a `|| echo "unknown"` fallback so an unexpected `flyctl` output shape doesn't fail the deploy step *after* the deploy itself succeeded. The summary block in `$GITHUB_STEP_SUMMARY` is the operator's audit trail; downgrading to "unknown" is preferable to a red workflow for cosmetic reasons.

### Discovered while writing the secrets checklist

- **`VITE_SENTRY_DSN` is build-time, not runtime.** Vite bundles it into the SPA at build, so it has to reach the Fly remote builder as a Docker build arg — not a Fly app secret. The current `Dockerfile` doesn't declare `ARG VITE_SENTRY_DSN` or pass it into the build stage, so the frontend Sentry SDK no-ops in production today. Captured as a caveat in `docs/secrets-checklist.md` and flagged as a follow-up against FEAT-46 rather than scope-creeping FEAT-49. The Dockerfile change is small (`ARG` + `ENV` in the build stage, plus `--build-arg` plumbing through the deploy command) and should land before we rely on frontend error reporting.

- **R2 credentials are GitHub Actions secrets, not Fly secrets.** FEAT-50's nightly `pg_dump → R2` workflow runs in CI and uses `flyctl proxy` to reach Postgres — the R2 client never runs inside the Fly app, so `R2_*` belong in the repo-level Actions store. Checklist groups them separately to avoid future confusion.

### Implementation decisions worth carrying

- **`flyctl deploy --remote-only`** is the chosen build location. The repo has no Docker buildx locally (noted in the FEAT-05 entry), and remote builds keep the workflow free of `docker login` / qemu / multi-arch concerns. Image is small enough (~229 MB per FEAT-05) that the Fly builder is the right tool.

- **No CI workflow file changes.** `workflow_run` doesn't require `ci.yml` to be `workflow_call`-able — it triggers reactively on completion events. Leaving `ci.yml` untouched keeps the PR review surface minimal.

- **Rollback path is documented as `flyctl releases rollback <version>`,** with an explicit note that one-way migrations defeat it and the recovery path is `pg_restore` from the R2 dump (FEAT-50/51). Catches the foot-gun ahead of time.

### Open questions / next actions

- **First-deploy bootstrap is a human action.** The checklist's `flyctl secrets set --stage` snippet expects the Fly app, the Fly Postgres cluster, and the apex domain to already exist (FEAT-05 / FEAT-09 / FEAT-13). FEAT-49 doesn't itself stand the app up.
- **Pre-flight verification of the broken-migration safety net** is in the checklist but worth doing exactly once on a low-stakes branch so we *know* `release_command` aborts the way we expect — not the kind of thing to discover during a real incident.

---

## 2026-06-22 — FEAT-48 (Explicit CSP policy)

**Status:** implementation complete. `pnpm --filter backend typecheck` clean, `pnpm --filter backend lint` clean, `test/security.test.ts` is 10/10 and `test/server.test.ts` still 12/12. DoD boxes in `docs/feature-specs.md §FEAT-48` left unticked — human action. Manual verification (load prod app, attempt `<script>` injection, confirm Sentry events still post) are operator probes.

### Decisions taken at kick-off

- **Sentry browser-ingest origin is its own env var (`SENTRY_BROWSER_INGEST_ORIGIN`)**, not parsed from `SENTRY_DSN`. Backend and frontend may use different Sentry projects; deriving from the backend DSN would have created an undocumented FE/BE coupling. Unset → `connect-src` omits the entry entirely.
- **`style-src 'self' 'unsafe-inline'` accepted for v1**, anticipated by DEC-46. Radix UI (used by shadcn/ui per DEC-51) injects inline styles for popover/tooltip positioning; a nonce/hash strategy would need every Radix primitive to thread one through. Inline comment in `security.ts` flags the compromise + revisit trigger.
- **`script-src` stays strict (`'self'` only).** DEC-46 explicitly calls out that adding `'unsafe-inline'` to `script-src` defeats the policy. Test #5 guards against accidental relaxation.
- **`useDefaults: false` on helmet's CSP** so the policy is auditable in one place rather than split across helmet's defaults and our overrides. Every directive (default-src, base-uri, form-action, frame-ancestors, object-src, img-src, connect-src, script-src, style-src, font-src) is declared explicitly.
- **Single host for Cloudinary**: `https://res.cloudinary.com`, not a wildcard. FEAT-48's "gotcha" note about `*.res.cloudinary.com` subdomains doesn't match how Cloudinary actually serves (single host with `/<cloud-name>/...` paths). Widen only if a real broken-image case surfaces.
- **`X-Frame-Options: DENY`**, not the helmet default `SAMEORIGIN`. Aligns with `frame-ancestors 'none'`; the existing assertion in `server.test.ts` was updated.

### Drift from kick-off plan

1. **`CspDirectives` interface needed an index signature.** Helmet's `directives` field is typed `Record<string, null | Iterable<...> | typeof dangerouslyDisableDefaultSrc>`. A plain typed interface doesn't satisfy that contract — added `[directive: string]: Iterable<string>` alongside the explicit shape to keep both editor IntelliSense and helmet's signature happy without an `as unknown as` cast at the call site.
2. **Bumped `frameguard` in helmet options to `{ action: 'deny' }`**, which surfaced an existing assertion in `server.test.ts:305` (`x-frame-options: SAMEORIGIN`). Flipped that test to expect `DENY` — the value is correct given `frame-ancestors 'none'`.
3. **One ESLint conflict resolved by removing an `as Iterable<string>` cast.** `noUncheckedIndexedAccess` made `Record<string, Iterable<string>>` access return `Iterable<string> | undefined`, but adding `!` triggered `no-non-null-assertion`. The right fix was a typed interface — the cast was a sign the return type was too loose.

### Implementation details worth carrying

- **`STATIC_DIR` unset in tests means no SPA fallback route exists**, so the CSP test suite inspects headers on `/api/health` responses (helmet attaches them to every response). Fine for header-shape assertions; doesn't exercise the SPA HTML path itself.
- **HSTS comes from helmet's defaults**, untouched. Only `contentSecurityPolicy` and `frameguard` are passed as overrides — other middleware (HSTS, X-Content-Type-Options, Referrer-Policy, etc.) stay at helmet 8's secure defaults. DEC-47's "review on helmet major upgrade" applies; we're currently on `helmet@8.1.0`.
- **`buildCspDirectives` is exported** so the policy shape can be unit-tested without booting Fastify. Useful if future changes want to assert directive composition logic (e.g. conditional CSP additions for new third parties).
- **Index signature on `CspDirectives`** loosens the type for helmet but the explicit keys are still type-checked at the return site — TS narrows on the literal. Adding a new directive means editing the interface AND the literal; the index signature only carries the helmet contract.

### Open follow-ups

- **Manual gate-check.** Load the prod app in a browser; DevTools console should show zero CSP violations. Attempt a `<script>alert(1)</script>` injection via a recipe note or shopping-list input; CSP should block execution (and React escaping should prevent it from rendering as a tag in the first place — defense in depth). Confirm Sentry browser events still POST.
- **Frontend Sentry init needs the DSN to be set** for the `connect-src` allowlist to matter. FEAT-45 landed the SDK; the `SENTRY_BROWSER_INGEST_ORIGIN` env var added here is the CSP-side companion. If the FE Sentry project hasn't been provisioned yet, leave the env var unset — `connect-src` will just be `'self'` and the FE SDK no-ops without a DSN anyway.
- **Vite dev: CSP not exercised.** In dev the SPA is served by Vite (`:5173`) which sets its own headers; the Fastify CSP only applies to responses Fastify itself serves. No dev/prod split is needed — manual verification of the policy must happen against a production-style build (or the Docker image) where Fastify serves the SPA HTML.

---

## 2026-06-22 — FEAT-47 (/api/health endpoint with DB probe)

**Status:** implementation complete. `pnpm --filter backend typecheck` and `pnpm --filter backend lint` clean. New `test/health.test.ts` is **5/5**; `test/server.test.ts` still **12/12** under the new server.ts ordering. The auth pre-handler's exemption string (`plugins/auth.ts:12`, `url.startsWith('/api/health')`) and rate-limit's exemption (`plugins/rate-limit.ts:22`) were already wired by FEAT-44/46 — this FEAT only adds the route handler itself. DoD boxes in `docs/feature-specs.md §FEAT-47` left unticked — human action. Manual gate-checks (`curl https://<domain>/api/health` → 200; stop the DB → 503; Fly dashboard goes healthy) are operator probes.

### Decisions taken at kick-off

- **Route file lives at `backend/src/routes/health.ts`**, not `backend/src/plugins/health.ts`. The spec is explicit about the path; created the new `routes/` directory. Logical separation from `plugins/` (which is for cross-cutting wiring like security, auth, rate-limit, logging) keeps intent clear — a route handler is not a plugin.
- **Per-route `logLevel: 'warn'` to silence the access log**, instead of sampling. Sampling would need a custom serializer for one route's volume problem; `logLevel: 'warn'` is the one-line config that does the same job. Failures still log because the handler emits a `warn` explicitly.
- **Timeout enforced in JS via `Promise.race`, not Postgres `statement_timeout`.** Postgres-side timeout only bounds the query itself, not the pool's connection-acquisition wait — which is the more likely failure mode under load (saturated pool of 10 connections per DEC-71). Racing in JS bounds the whole probe.
- **503 body is `{ ok: false }` — no error details.** Fly only reads the status code; volunteering the cause would leak reconnaissance to scanners. The cause is in the structured `warn` log (Axiom-visible), not the response body.
- **Probe failures log one structured `warn` with `reason: 'timeout' | 'error'`** (plus the `err` payload when an error reached us). One log per failed probe, zero per success — bounds Axiom volume at "failures only" instead of "every probe."
- **Route registered before `registerAuth` / `registerRateLimit` in `server.ts`.** Both pre-handler hooks already early-exit on `/api/health`, so order isn't load-bearing for correctness; clustering the route registration near `app.decorate('db', db)` keeps the file readable.

### Drift from kick-off plan

1. **Three lint-driven micro-edits, no behaviour change.** The `eslint-config-strict-type-checked` rules forced: `() => {}` → `() => undefined` for the swallow catch (`@typescript-eslint/no-empty-function`); braced body on `setTimeout(() => { resolve('timeout'); })` (`@typescript-eslint/no-confusing-void-expression`); `Array<Record<string, unknown>>` → `Record<string, unknown>[]` in the test (`@typescript-eslint/array-type`). Substantively identical to the planned code.
2. **`captureLogs` types `loggerInstance` as `FastifyBaseLogger`, not `ReturnType<typeof pino>`.** Pino's generic defaults produce a `Logger<never, boolean>` that Fastify's `loggerInstance` option rejects (it wants `Logger<string, boolean>`). The widening trick used in `server.ts:60` (`const baseLogger: FastifyBaseLogger = logger`) is the same workaround. Documented inline in `buildHealthApp`.

### Implementation details worth carrying

- **`probe.catch(() => undefined)` is load-bearing.** When the 2 s timeout wins, the underlying `db.execute` promise is left to settle on its own. Without an attached handler, a later reject would surface as an unhandledRejection and trip Sentry (FEAT-45). The no-op catch is the cheapest mitigation; the `.then(() => 'ok')` derivative used in `Promise.race` is independently handled by Promise.race itself.
- **`db.execute(sql\`select 1\`)` acquires + releases a pool connection.** With `POOL_MAX = 10` (DEC-71) and the timeout at 2 s, a saturated pool either drains in time (200ms per request × 10 = 2s) and the probe succeeds, or doesn't and Fly correctly marks the machine unhealthy. The timeout encodes "if we can't even get a connection, we're not healthy."
- **Fake-timer test pattern for the 2 s timeout.** `vi.useFakeTimers()` + `app.inject(...)` returns a promise; awaiting `vi.advanceTimersByTimeAsync(2_000)` flushes both timer queue and microtasks, after which the inject promise resolves with the 503. Restored in `afterEach` with `vi.useRealTimers()` so subsequent tests aren't affected.
- **Auth-exemption test mounts a stub `auth`**, not the real `createAuth(...)`. `Auth['api']['getSession']` returning `null` is the only thing the pre-handler reads; the wildcard `/api/auth/*` handler is registered but never invoked from `/api/health`. Side-effect import of `trpc/context.ts` carries the `FastifyInstance['db']` augmentation along so the decorate call typechecks. Trade-off: the test doesn't exercise the real Better Auth handler tree — that's covered by `server.test.ts`'s existing auth cases.

### Open follow-ups

- **Manual gate-check.** `curl https://<domain>/api/health` against the deployed Fly app should return 200; with Postgres stopped (or unreachable via firewall), 503; Fly dashboard should show the machine as healthy under normal operation. Endpoint goes live as soon as FEAT-47 ships; no separate enable step.
- **FEAT-49 unblock.** This FEAT was a hard dependency for "robust deploys" — Fly's health-check path (`/api/health`, declared in `fly.toml` since FEAT-05) now resolves to a real handler. The release-command migration step in FEAT-49 can rely on the health probe to gate traffic.
- **Testcontainer environment unblock.** Same pre-existing colima/docker-socket issue carried over from FEAT-44/45/46. Not specific to this FEAT; 14 testcontainer-backed suites can't bootstrap in this shell. Worth a one-off investigation outside any feature scope.

---

## 2026-06-22 — FEAT-46 (Rate limiting via @fastify/rate-limit)

**Status:** implementation complete. `pnpm -r typecheck` and `pnpm -r lint` clean. Non-testcontainer vitest suites **89/89** passing (rate-limit, server, config, logger, sentry, scrub-pii, cloudinary-sign, date-utils) — the new `test/rate-limit.test.ts` is 8/8. Testcontainer-backed suites failed to bootstrap with "Could not find a working container runtime strategy"; same colima docker-socket mount issue that's been present in this shell since FEAT-44/45, unrelated to this change. DoD boxes in `docs/feature-specs.md §FEAT-46` left unticked — human action. Manual gate-checks (burst `/api/trpc/health.ping` past 100/min and the magic-link endpoint past 5/hr) are operator probes.

### Decisions taken at kick-off

- **`trustProxy: true` on the Fastify constructor**, not a Cloudflare IP-range allow-list. We're orange-clouded (DEC-72), so spoofing `x-forwarded-for` requires bypassing Cloudflare; the simpler config is acceptable. Documented in `server.ts` next to the option.
- **Rate-limit hook runs at `preHandler`, registered *after* `registerAuth`.** Same-kind hooks fire in registration order, so the auth pre-handler hydrates `req.session` first and the rate-limit keyGenerator can read `req.session?.id`. Side effect: in production, an unauth probe of a non-exempt route gets a fast 401 before it ever hits the limiter. Accepted — the 401 itself is the cheap-rejection path.
- **`/api/health` is the only exemption.** Fly's liveness probe hits it on a tight cadence, and FEAT-47's spec demands the exemption regardless. `/api/auth/*` is *not* exempt — the per-email magic-link bucket lives there.
- **Magic-link per-email check via a second `preHandler` hook**, not the plugin's per-route `config.rateLimit`. Better Auth owns the wildcard `/api/auth/*` route in `plugins/auth.ts`, so we can't attach per-route options at registration. The hook is scoped by URL + method (`POST /api/auth/sign-in/magic-link`) and reads the email from `req.body` (parsed by preHandler time). Falls back to an IP-keyed bucket when the body has no string `email`, so omitting it doesn't bypass the limit.
- **HTTP-level 429 envelope, not a tRPC one.** `{ error: 'TooManyRequests', code: 'RATE_LIMITED', retryAfterSeconds: <n> }` with a `Retry-After` header. The rate-limit hook runs before the tRPC adapter; there's no clean way to forge a tRPC-link-shaped envelope from outside the adapter. Documented in `OPERATIONS.md`.
- **`OPERATIONS.md` stubbed now**, not deferred to FEAT-50. Single section documenting the three thresholds, exemption, 429 shape, and the in-memory store / Fly auto-stop caveat. FEAT-50 expands with backup/restore/rollback.

### Drift from kick-off plan

1. **Plugin registered with `global: false` and both checks driven from a single `preHandler` hook**, instead of relying on `@fastify/rate-limit`'s built-in global enforcement + `errorResponseBuilder`. Reading the plugin source while writing tests revealed that `errorResponseBuilder` is *thrown* into Fastify's error pipeline — returning a plain object (our envelope shape) becomes a 500, not a 429, because Fastify only honours `statusCode` when the thrown value is an Error. The chosen design uses the plugin's `createRateLimit` decorator for the store + keying machinery and sends the documented 429 envelope via `reply.send` directly. Same external behaviour, the response shape stays under our control.
2. **Checking `!result.isAllowed && result.isExceeded`, not just `result.isAllowed`.** The plugin's TS types make `isAllowed: true` look like "under the cap" but it's actually "matched the allowList and was never counted." A normal under-the-cap request returns `isAllowed: false` with `isExceeded: false`. Missing this on the first pass produced 500s (thrown bodies) and 100% block rates in tests — caught by behavioural tests, fixed by the conjunction above.
3. **Extra test for email normalisation** (`'  CASING@example.com  '` lands in the same bucket as `casing@example.com`). Not in the kick-off list but cheap to nail down — the keyGenerator lowercases and trims, and someone reading the code shouldn't have to guess whether casing variants share a bucket.
4. **No additional dev-only `/api/trpc/health.ping` exemption.** Considered, then dropped: the global limit at 100/min is far above what any test or dev loop hits naturally. The auth plugin's dev-only exemption exists because the auth gate would otherwise 401 every dev probe; the rate-limit gate doesn't fire until the 101st request in a minute, so it never gets in the way.

### Implementation details worth carrying

- **`@fastify/rate-limit@^11` is `type: 'commonjs'`** — same as `@fastify/helmet` and `@fastify/cors` already in the tree. ESM consumers (us) interop through Node's CJS resolution; no special handling. DEC-01's "CJS-only is a stop-and-ask" carries an implicit carve-out for the fastify-org plugin family already established at FEAT-03.
- **`@fastify/rate-limit`'s `createRateLimit` decorator returns a check function that *always* increments the counter** (unless allowList matches). The returned `isAllowed` discriminant is poorly named — it really means "was this request short-circuited by the allowList?" The real "should we block?" signal is `isExceeded`. If we ever swap the store for Redis (the upstream-supported path; spec says "if scaled out later, plug Redis"), this semantics is unchanged.
- **In-memory store + Fly auto-stop = counter reset on machine wake.** Accepted as v1 per the spec; the alternative is Redis as a dependency and that's well past where household-traffic threats justify the operational cost. Documented in `OPERATIONS.md` so it's not read as a bug later.
- **`req.id` propagation isn't affected.** Fastify's per-request log scope already binds `reqId`; the 429 response shape doesn't carry it, but the access log line that records the 429 does. Sentry would catch nothing here — a 429 is intentional, not an error.
- **Test harness uses a tiny standalone Fastify app**, not the real `buildApp(...)`. Lets the session-bucket test simulate auth via a header-driven preHandler that hydrates a structurally-minimal `req.session` (only `.id` is read by the keyGenerator). Side-effect import of `trpc/context.ts` brings the `FastifyRequest` module augmentation along so the cast through `unknown` doesn't require a `@ts-expect-error`. Trade-off: tests don't exercise the live boot order — that's covered by `server.test.ts`'s 12 cases continuing to pass under the new ordering.
- **Burst counts in tests are exact (100/300/5)**, not approximate. `@fastify/rate-limit` allows up to and including `max`, blocks at `max + 1`. The tests assert the last in-window request succeeds and the first over-window request 429s — keeps the off-by-one explicit.

### Open follow-ups

- **Author the DEC.** Spec carries `[DEC-TBD: rate limits per NFR; tighter per-email limit on magic-link]`. The thresholds and the per-email rationale are in `docs/non-goals.md` ("Rate limits sized for household traffic, not adversarial scale") and `docs/plan.md`; a short DEC tying those threads together + recording the in-memory store + Cloudflare trust-proxy choices would close the marker.
- **FEAT-47 (`/api/health`).** The exemption is already wired but the endpoint doesn't exist yet. When FEAT-47 lands, the only action is to confirm Fly's liveness probe hits the path Cloudflare-free (Fly's internal probes don't go through CF, so trust-proxy doesn't matter there).
- **Redis switch trigger.** If we ever go multi-machine on Fly, the in-memory counters silently desynchronise. `@fastify/rate-limit` supports a `redis` option that takes an ioredis client; the change is local to `plugins/rate-limit.ts`. Worth a DEC update at the time, not pre-emptive scaffolding now.
- **Manual gate-check.** `pnpm --filter backend dev`, then a curl loop of 110× `/api/trpc/health.ping` and 6× `POST /api/auth/sign-in/magic-link` with the same email body. Confirms 429 + `Retry-After` in a live process, which the test harness can't fully replicate (no Cloudflare in the middle).
- **Testcontainer environment unblock.** Pre-existing: this shell's colima setup can't mount `/Users/conorwarne/.colima/default/docker.sock` into the @testcontainers helper container ("operation not supported" via virtiofs). 14 test files affected; none touched by FEAT-46. Worth a one-off investigation outside any feature scope, perhaps a `DOCKER_HOST` + colima config tweak.

---

## 2026-06-21 — FEAT-45 (Sentry frontend + backend with PII scrubbing and req.id tag)

**Status:** implementation complete. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm --filter backend build`, `pnpm --filter frontend build` all clean. Backend vitest **56/56** passing across the FEAT-44/45 touch area (scrub-pii, sentry, logger, config, server). Frontend vitest **310/310** passing (3 new in `src/lib/sentry.test.ts`). DoD boxes in `docs/feature-specs.md §FEAT-45` left unticked — human action. Deploy-gate (real Sentry event for a synthetic error, scrubbed payload + `reqId` tag) is a manual probe. The spec's `[DEC-TBD: Sentry beforeSend PII scrubbing; replay disabled to skip cookie consent]` is closed by DEC-76; `[DEC-TBD: absolute-threshold alert; percentage-based unsuitable at low traffic]` by DEC-78.

### Decisions taken at kick-off

- **`scrubPii` in `/shared/src/lib/`, not duplicated per side.** Identical logic on both ends; `/shared` already carries one runtime utility (`occasion-order`) so this is precedent-consistent, not net-new layering. Backend imports via the relative path the rest of the workspace uses (`'../../../shared/src/index.ts'`); frontend via the package name (`'@loftys-larder/shared'`) per its existing tsconfig path map.
- **Backend `reqId` propagation via a Fastify `onRequest` hook calling `Sentry.getIsolationScope().setTag(...)`, not tRPC middleware.** Catches errors thrown by Fastify plugins, the auth pre-handler, *and* tRPC procedures. Sentry v9's HTTP integration (loaded by default in `Sentry.init`) creates a per-request isolation scope via OpenTelemetry context before Fastify's lifecycle starts; `onRequest` is the earliest Fastify hook, so the request-bound scope already exists by the time we tag it. The test verifies concurrency safety by simulating two requests with distinct scopes — proves the tag never leaks across them.
- **DSN optional in every env; init is a no-op when absent.** Unlike Axiom (the only structured-log destination, DEC-75 + FEAT-44's fail-fast posture), Sentry is best-effort observability. A missing DSN in production logs a single Pino `warn` line and continues; dev/test silently no-op. Matches DEC-76's stance and avoids breaking local dev when contributors haven't set up their own DSN.
- **Synthetic-error endpoint deliberately omitted.** The spec asks for "synthetic error in dev shows up in Sentry" as a manual gate-check — adding a permanent shipped surface (e.g. `health.crash`) inverts the cost. Tests assert the SDK transport receives the scrubbed event deterministically; the gate-check is a one-off DevTools throw, not a maintained procedure.
- **`tracesSampleRate: 0` default.** DEC-77 explicitly punts distributed tracing. Sentry's auto-instrumentation would otherwise sample at the SDK default once OTel attaches — pinning to 0 keeps the APM surface off until it earns its cost.
- **Frontend `integrations: []` to omit replay.** Not just disabling — leaving replay out of the integrations list keeps it out of the bundle entirely. DEC-76 / non-goal "Session replay in Sentry" is the source of truth; the structural absence is stronger than a runtime flag.
- **CSP work deferred to FEAT-48.** `helmet`'s default CSP would block frontend → Sentry in prod, but FEAT-48 owns the explicit `connect-src` allowlist with `*.ingest.sentry.io`. Backend → Sentry works regardless of CSP. Documented as the gap to close before the deploy-gate ticks.

### Drift from kick-off plan

1. **`scrubPii` signature relaxed from `<T extends ScrubbableEvent>(event: T): T` to `<T>(event: T): T` with structural narrowing inside.** Sentry's `ErrorEvent` requires `type: undefined` as a discriminant and `RequestEventData` lacks an index signature; either would reject the stricter constraint at the `Sentry.init({ beforeSend })` call site. The generic-with-internal-narrowing form preserves Sentry's declared types end-to-end without `as`-casts inside `sentry.ts`.
2. **`SENTRY_ENVIRONMENT` env var added** even though kick-off only listed `SENTRY_DSN`. Cheap addition; lets prod-alert filters target `production` while dev events stay tagged separately. Defaults to `NODE_ENV` server-side, to `import.meta.env.MODE` client-side.
3. **`firstNonEmpty()` helper for the frontend env-fallback chain.** `??` only handles nullish; an empty-string env var (`VITE_SENTRY_ENVIRONMENT=` in a .env file, common pattern) would otherwise pin Sentry's `environment` to `""`. The helper treats empty strings as absent and ends in a `'development'` default so the field is never blank.
4. **`BuildAppOptions.skipSentry` added** so server tests that don't want global Sentry SDK state (the side effect of `Sentry.init`) can skip init cleanly. Used by no test today; in place because the alternative is harder to bolt on later.
5. **Backend `captureException` exported via `export { captureException } from '@sentry/node'`** rather than `export const captureException = Sentry.captureException`. The const form loses overload typing; the re-export preserves it.
6. **`frontend/src/env.d.ts` created** to type `VITE_SENTRY_DSN` / `VITE_SENTRY_ENVIRONMENT` against `ImportMetaEnv`. Lives alongside `vite-plugin-pwa/client` augmentation already in `tsconfig.json#compilerOptions.types`.

### Implementation details worth carrying

- **Bundle size:** backend `dist/server.js` went from 4.5MB (post-FEAT-44) to 6.0MB. The bulk is `@sentry/node` + its OpenTelemetry transitive deps (`@opentelemetry/instrumentation-*`, `@sentry/opentelemetry`). Still well within the 512MB Fly machine class (FEAT-05 baseline image was 229MB). Worth re-checking cold-start once FEAT-52 measures it — Sentry's OTel patches `http` at init time and may push the boot path by 30-50ms.
- **Sentry init ordering matters for OTel patching of `http`.** v9 recommends `node --import ./instrument.js` so init runs before any module imports `http`. We call `Sentry.init` inside `buildAppWithLogger` before `Fastify()` is constructed; Fastify's HTTP server is created at `app.listen()` time, not at import, so the patch lands in time. If we ever take a hard dep on Sentry's tracing/spans, move init to a separate `instrument.js` and load with `--import` to avoid races.
- **`beforeSend` and `beforeBreadcrumb` both pass through `scrubPii`.** Breadcrumbs can carry URL query params and navigation history that may include email-shaped values. Same scrubber, same contract.
- **Frontend init runs *before* React renders.** `main.tsx` calls `initSentry()` between the CSS imports and `ReactDOM.createRoot(...)`. Auto-captured unhandled errors and promise rejections from the very first frame land in Sentry without needing an ErrorBoundary in place. If we add one later (e.g., a TanStack Router error component or a `Sentry.ErrorBoundary` wrapper), it slots in without re-architecting the init.
- **Backend test uses a real Fastify instance with `getIsolationScope` / `setupFastifyErrorHandler` doubles.** The injectables in `RegisterSentryHooksOptions` make this clean: the test asserts each request's `setTag('reqId', …)` lands on a *distinct* scope object. That's the concurrency invariant DEC-77 leans on — if Sentry ever changes its scope semantics under us, this test goes red.
- **`@sentry/node@9.47.1` and `@sentry/react@9.47.1` both ESM-shipping** via the `exports.import` condition. Confirmed at install. The `^9.0.0` ranges in package.json resolved to 9.47.1; check on upgrade that the v9 API surface (`getIsolationScope`, `setupFastifyErrorHandler`, `beforeSend(event)` signature) hasn't shifted.

### Open follow-ups

- **Author the DECs.** DEC-76 already covers "beforeSend PII scrubbing + replay disabled" and DEC-78 covers the absolute-threshold alert — both pre-date FEAT-45. The `[DEC-TBD: ...]` markers in `docs/feature-specs.md §FEAT-45` are stylistic remnants; can be replaced with `(DEC-76)` / `(DEC-78)` references in a docs-only pass.
- **CSP `connect-src` for Sentry ingest is FEAT-48.** Frontend → Sentry won't reach the dashboard in prod until that lands. Backend events flow regardless. Tracked as the gap that blocks the FEAT-45 deploy-gate.
- **Sentry dashboard alert config is a human action.** DEC-78's >5 events / 5 min absolute threshold needs setting up via the Sentry UI. FEAT-51 will absorb the OPERATIONS.md doc step (file doesn't exist yet); for now, the alert config is a one-off the operator runs after the DSN is set.
- **`flyctl secrets set SENTRY_DSN=…`** before the deploy-gate. Frontend needs `VITE_SENTRY_DSN` at build time — wire into the GitHub Actions deploy workflow (FEAT-49) as a build secret.
- **No `Sentry.setUser(...)` wired.** Tempting hook for "who saw the error" but would put `user.id` (or email if we're sloppy) on every event. DEC-76's PII discipline pairs with "don't add PII intentionally" — left explicitly off. Revisit if multi-household ships.
- **Frontend ErrorBoundary not added.** App-level boundary would let `componentDidCatch` push curated context (e.g., the route name) into Sentry events. Out of FEAT-45's scope; the SDK's global handlers already catch unhandled rejections. Worth a small follow-up FEAT once the gate-check shows what bubbles up unhandled vs needing structured catch.

---

## 2026-06-21 — FEAT-44 (Pino → Axiom transport with req.id propagation)

**Status:** implementation complete. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm --filter backend build` clean. New + adjacent vitest files (`test/logger.test.ts`, `test/config.test.ts`, `test/server.test.ts`) **42/42** passing. Testcontainer-backed suites unchanged — they were already failing on `main` in this shell with "Could not find a working container runtime strategy" (verified via `git stash`); unrelated to this change. DoD boxes in `docs/feature-specs.md §FEAT-44` left unticked — human action. Deploy-gate (real Axiom event correlated to a real `reqId`) is a human probe.

### Decisions taken at kick-off

- **Custom Pino destination via `fetch`, not `pino.transport({ target: '@axiomhq/pino' })`.** The spec flags worker-thread transports + esbuild bundling as fragile (the runtime image only carries `dist/server.js`). A ~70-line in-process NDJSON batcher avoids that path entirely: no worker, no transport file on disk, no `node_modules` carry-over for the prod image. One ESM dep (`pino-pretty`) added for dev pretty-printing — flagged at kick-off, accepted.
- **Multistream with stdout *and* Axiom in prod.** Fly's machine-level log feed still surfaces stdout, so the dual write keeps logs visible even if Axiom is unreachable. The cost is a duplicate write per entry — negligible at household traffic.
- **Required-in-prod via Zod refines, not graceful fallback.** `loadConfig()` rejects production without `AXIOM_TOKEN` + `AXIOM_DATASET`. Same posture as `BETTER_AUTH_SECRET` / `RESEND_API_KEY` — fail at boot, not silently demote to stdout.
- **`reqId` field name pinned to the FEAT-03 / DEC-77 spelling.** No renaming on the way through; Pino's child logger emits `reqId` already and the multistream is a pass-through. The integration test in `test/server.test.ts` asserts the wire shape so a drift to `req_id`/`requestId` would fail loudly.
- **Response header for `reqId` left unexposed.** Fastify v5 defaults `requestIdHeader: false`; the FEAT-44 acceptance criterion explicitly allows this ("…if exposed"). Keeping the surface small until FEAT-45 needs it for Sentry cross-reference.

### Drift from kick-off plan

1. **`buildServerOptions` / `buildLoggerOptions` removed entirely** instead of kept as compat shims. The only call site was `server.ts`, which now needs the Axiom destination handle for shutdown drain — exposing the bundle directly is cleaner than threading the handle out separately. `buildApp` retained as a thin wrapper over `buildAppWithLogger` for the existing test signature.
2. **`stdout` injection added to `BuildAppOptions` / `BuildLoggerOptions`.** Beyond fetch injection — needed in the integration test so production-mode logs don't leak JSON into vitest output (the multistream still mirrors to whatever stream you give it). Also a general-purpose test seam for future log assertions.
3. **`FastifyBaseLogger` local annotation around the Pino instance.** Passing `loggerInstance: pino.Logger` narrows Fastify's generic to `Logger`, which then refuses `registerSecurity(app, …)` and friends (cross-plugin type drift). Going through `const baseLogger: FastifyBaseLogger = logger` keeps the FastifyInstance at the default base type and the plugin tree stays assignable. Worth re-checking if Fastify or `@types/pino` change either side.
4. **`AXIOM_ENDPOINT` env var added** (defaults to `https://api.axiom.co`). Not in the kick-off file list; cheap to include and lets the unit tests run against a stub host without monkey-patching `fetch`. Also unlocks the EU region (`https://api.eu.axiom.co`) without code change.

### Implementation details worth carrying

- **`createAxiomDestination` batches NDJSON lines and POSTs to `/v1/datasets/<dataset>/ingest`.** Defaults: 100 entries or 1s, whichever first. Send is queued through a single chained `pending` promise so concurrent flushes serialise — keeps payload ordering stable and avoids HOL bursts. Per-flush failures surface via `onError` (silent default; server bootstrap could wire a Pino re-emit if useful). Timer uses `.unref()` so a pending flush doesn't hold the event loop open at shutdown.
- **`axiom.end()` is called from `main()`'s SIGTERM/SIGINT path** after `app.close()`. Drains the last batch before `process.exit(0)`. Without it, the last second of logs disappears on every redeploy.
- **`pino-pretty` runtime, not devDep.** Initially planned as devDep, but `LOG_LEVEL=info` in dev actually constructs the pretty stream — moving it to `dependencies` matches the import-time usage. Bundle grew to **4.5MB** (from ~3MB) on `pnpm --filter backend build`; well within the 512MB Fly machine class (DEC-71 / FEAT-05 baseline of 229MB image).
- **"No request bodies in logs" is structural, not asserted.** Fastify's default request logger logs `req` (method/url/host/remoteAddress) + `res` (statusCode/responseTime), nothing else. The Axiom destination is a pass-through — it never sees a request body unless a call site explicitly logs one. The contract lives at the call sites, not in the transport.
- **`docs/measurements.md` baseline is a *stub*.** No synthetic load run — the spec's manual verification is a deployed dashboard probe. The stub locks in what to record (daily event count, p95 event size, level mix, projected retention vs the 30-day rolling window) so the first measurement has a target shape.

### Open follow-ups

- **Author the DEC.** The spec's `[DEC-TBD: Pino → Axiom for structured logs, 30-day free-tier retention]` already has DEC-75 — but DEC-75 doesn't record the *transport* decision (custom in-process destination vs `@axiomhq/pino` worker). Worth either extending DEC-75 with the transport choice + rationale, or adding a small adjacent DEC pointing back to it. Trade-off captured: bundle simplicity over official SDK.
- **`flyctl secrets set AXIOM_TOKEN=… AXIOM_DATASET=…`** before the next deploy, or boot fails loudly via the prod refine. This is the human deploy gate.
- **First-week log volume measurement** — fill in `docs/measurements.md` once a representative day of real traffic exists in Axiom. Triggers in the stub list the conditions that would invalidate the 30-day-retention assumption.
- **Stub onError handler in `createAxiomDestination` swallows everything.** Acceptable v1 — a failing Axiom shouldn't crash the app. If we ever care about visibility on transport failures (e.g., 401s after token rotation), wire it through Pino's stderr write in `server.ts`. Don't `console.log` it (FEAT-03 / AGENTS.md trap).
- **FEAT-45 (Sentry) will need the same `reqId` field on its events.** DEC-77 cross-cutting #1 — the contract pinned in `test/server.test.ts`'s "carrying the request reqId" assertion is now load-bearing for Sentry's tag attach.

---

## 2026-06-21 — FEAT-43 (Offline check-state queue + reconnect sync)

**Status:** implementation complete. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean. Frontend tests **307/307** passing (27 new across 6 files). DoD boxes in `docs/feature-specs.md §FEAT-43` left unticked — human action. The spec's `[DEC-TBD: offline mutation queue, LWW conflict resolution accepted]` is still open; the implementation answers it (queue at the optimistic-hook layer, drain via standalone `useMutation`, LWW honoured because drain replays in `queuedAt` order and the server's post-reset response wins on settle).

### Decisions taken at kick-off

- **Hook-level enqueue, not a tRPC link.** The spec sketches "extend `trpc.ts` with a link that catches network errors and queues toggles." Adopted instead: catch the offline failure inside `useOptimisticCheckToggle.onError` and enqueue from there. Reasons: (a) a generic link would intercept *every* mutation's network errors and need a per-procedure allow-list — leaky; (b) the toggle hook already owns input shape + cache patches; (c) AGENTS.md flags the tRPC URL shape as stop-and-ask, and a network-error link is close enough to the surface that the conservative call is to leave `trpc.ts` untouched. The shape stays `httpBatchLink` → `/api/trpc/…` unchanged (cross-cutting #16 honoured).
- **Hand-rolled IndexedDB wrapper, no `idb-keyval` dep.** ~120 lines of `openDB` / `withStore` / `promisifyRequest` over the native `IDBFactory`. Decision driven by AGENTS.md's stop-and-ask-before-new-dep rule; the IDB API is small enough that a wrapper costs less than the dep negotiation.
- **`online`-event drain only, no `BackgroundSyncPlugin`.** FEAT-42 didn't wire a Background Sync handler; layering one in for FEAT-43 would expand the SW surface. The chosen path: drain in the page's `useEffect` on `isOnline === true` transitions (covers both reconnect and mount-already-online). Failures keep entries in the queue for the next `online` flip — the spec's "captive portals lie" gotcha is absorbed there.
- **Queue keyed by `(planId, ingredientId)`; drain runs across all plans; indicator is plan-scoped.** Switching plans does not strand pending work. The visible "Pending sync" chip only renders on lines whose `ingredientId` matches a queue entry for the visible `planId`.
- **One named cache bucket touched, none added.** `shopping-list-network-first` from FEAT-42 / DEC-86 still owns reads; FEAT-43 only adds a write-side queue. After drain, `utils.shopping.getForPlan.invalidate({ planId })` triggers a network-first refetch and the cache reconciles.

### Drift from kick-off plan

1. **`OfflineQueueStore` is an interface with two implementations + a singleton factory.** Kick-off plan named one IDB-backed module; jsdom omits `indexedDB`, so the contract-based split (in-memory + IDB sharing one interface) was the cheapest way to make the queue unit-testable without a `fake-indexeddb` dev-dep. The factory picks IDB when present, in-memory otherwise — also a graceful degradation path for browsers that disable IDB (private mode in some engines).
2. **`__resetOfflineQueueStoreForTests` test seam.** Public-but-underscored export so the page-level integration tests can swap the singleton between cases without a full module re-import. The pattern matches what the SW tests already use for the `virtual:pwa-register` stub.
3. **Standalone `useMutation` for the drain path** (not `mutateAsync` on the optimistic hook). The optimistic hook would have fired `onMutate`'s cache patch redundantly for each drain entry; the plain mutation avoids that. After the drain completes, one `invalidate({ planId })` lets server truth land via the network-first cache rule from DEC-86. `mutateAsync` is captured in a ref to keep the effect deps stable across renders.
4. **`isQueued` indicator on `<ListLine>` is `role="status" aria-label="Pending sync"` with `data-print-hide`.** Matches the existing typographic chip patterns (no icon library); print stylesheet hides it via the same attribute the page header already uses.
5. **Page-level integration tests landed.** Three new cases in `shopping-list-page.test.tsx` exercise drain-on-mount + invalidate, drain-on-reconnect, and the offline banner via the in-memory store. The "real IDB reload" probe stays a manual verification step (see `docs/feature-specs.md §FEAT-43` step 2).

### Implementation details worth carrying

- **`useOptimisticCheckToggle` decides offline vs online from `navigator.onLine` inside `onError`.** The check is `!navigator.onLine` (`navigator.onLine` is typed as `boolean`, never `undefined`). When offline: enqueue, keep the cache patch, suppress the user-supplied `onError`. When online: existing rollback + `onError` path runs unchanged. `onSuccess` removes any matching queue entry — protects against a live toggle landing during a drain pass that already enqueued the prior state.
- **`drainOfflineQueue` returns `{ drained, remaining, error? }` and stops at the first failure.** The failing entry stays in the queue (plus everything after it) so the next `online` flip retries from the same point. No exponential backoff in v1 — explicit per the kick-off discussion.
- **`useOfflineQueue` deduplicates its `setEntries` calls via a shallow-equal compare** (`sameEntries`). Without it, every mount produced an after-test `setEntries([])` resolve that React flagged with the `act(...)` warning; the equality bail-out keeps the hook quiet on idle renders.
- **`shopping-list-page.tsx` cancellation flag is a mutable object** (`const lifecycle = { cancelled: false }`), not `let cancelled = false`. TS narrows the literal-false declaration aggressively enough that `if (cancelled)` reads as "always falsy" to `@typescript-eslint/no-unnecessary-condition`. Object-flagged cancellation sidesteps the narrow and reads identically at runtime.
- **`useEffect` deps for the drain are `[offline.isOnline, offline.store, utils, planId, idIsValid]`.** Stable across renders in practice — `offline.store` is `useMemo`'d in the hook, `utils` is the same `useUtils()` ref across renders, `idIsValid` is derived from the route param.
- **`useMemo(() => injected ?? getOfflineQueueStore(), [injected])` in `useOfflineQueue`.** Holds the store reference stable per render so the subscription effect doesn't re-run.
- **Print CSS already covers the indicator** via the existing `[data-print-hide]` rule in `src/print.css`; no new stylesheet entry needed.

### Open follow-ups

- **Author the DEC.** `[DEC-TBD: offline mutation queue, LWW conflict resolution accepted]` is still open. Suggested content: hook-layer enqueue (no tRPC link), drain via standalone `useMutation`, `(planId, ingredientId)` collapse, `queuedAt`-ordered drain, stop-on-first-failure, LWW per DEC-36 with no row-version. Cross-refs: FEAT-38 (toggleChecked), FEAT-42 (PWA cache), DEC-36 (LWW), DEC-86 (network-first cache that pairs with the drain's invalidate).
- **IDB persistence-across-reload is unit-test-uncovered.** The in-memory store is the test target; the IDB wrapper itself is audited by eye. The first time we want regression coverage on the IDB path, `fake-indexeddb` is the conventional dev-dep — small, ESM, test-only — and would let `offline-queue.test.ts` exercise the wrapper too. Flagged for the next time IDB behaviour changes.
- **Captive-portal stale-`onLine` is accepted v1 risk.** If users report "I reconnected but nothing synced," the fix is either a periodic retry timer (cheap, drains every N seconds when the queue is non-empty) or a manual "retry sync" button on the offline banner.
- **Procedure rename hazard remains.** The drain calls `trpc.shopping.toggleChecked.useMutation()` directly; a rename of `shopping.toggleChecked` would break compilation (good) and require an audit of the FEAT-42 cache regex + this file. Worth a note in any future router-renaming session, joining the same note from FEAT-42.

---

## 2026-06-21 — FEAT-42 (PWA infrastructure: service worker + manifest + network-first for shopping list)

**Status:** implementation complete. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm format:check` all clean. Frontend tests **280/280** passing (12 new across two files). `pnpm --filter frontend build` succeeds; `dist/sw.js` contains the `shopping\.getForPlan` regex + `NetworkFirst` handler + `shopping-list-network-first` cache bucket; `dist/manifest.webmanifest` carries the expected name, `start_url`, scope, and icon set. DoD boxes in `docs/feature-specs.md §FEAT-42` left unticked — human action. **DEC-86** authored at the same time (the spec's `[DEC-TBD: PWA network-first for shopping list]`).

### Decisions taken at kick-off

- **One named cache bucket, one URL pattern.** `NetworkFirst` against `/\/api\/trpc\/shopping\.getForPlan/`, `cacheName: 'shopping-list-network-first'`, `networkTimeoutSeconds: 3` (aligned with the Fly cold-start budget — DEC-63 / DEC-64), 32 entries / 7-day max-age. Limiting the rule to `getForPlan` keeps mutations and unrelated reads off the cache surface and honours cross-cutting #16 (match the procedure segment, not the `batch=1&input=...` query string).
- **`registerType: 'autoUpdate'`, no update toast.** v1 accepts a silent SW update on next full reload; a "new version available" banner is more UX surface than the project warrants today.
- **Dev SW disabled.** `devOptions.enabled: false`. The "stale SW + Vite HMR" footgun (FEAT-42 common-gotcha) is real; the cost is one less surface to debug in dev.
- **`injectRegister: null`; we call `registerSW` ourselves** from a tiny gated module. Gives us a single chokepoint for the dev/prod check and the `'serviceWorker' in navigator` guard.
- **Direct browser → Cloudinary stays untouched (DEC-50).** SW does not intercept that origin; runtime caching only matches `/api/trpc/shopping.getForPlan`.

### Drift from kick-off plan

1. **Extracted PWA config into `frontend/src/lib/pwa-config.ts`.** Original plan kept the `VitePWA(...)` invocation inline in `vite.config.ts`. Spec's DoD calls for "manifest fields present (probe via fetch in a test)" — a full `vite build` inside Vitest is heavyweight. Hoisting `pwaManifest`, `pwaRuntimeCaching`, and `SHOPPING_LIST_NETWORK_FIRST_PATTERN` into a separate module makes them directly importable from a unit test (`src/test/pwa-config.test.ts`, 9 cases). `vite.config.ts` imports the same objects, so build-output and tests probe the same source of truth.
2. **Local structural type for `RuntimeCachingRule`.** `vite-plugin-pwa` does not re-export `RuntimeCaching` (the type lives in `workbox-build`, which is hoisted transitively but not a direct dep). Defined a minimal local interface covering the subset Workbox reads. If we ever take a direct dep on `workbox-build` for other reasons, swap to the upstream type.
3. **`virtual:pwa-register` aliased to a test stub in `vitest.config.ts`.** Vitest does not run the `vite-plugin-pwa` plugin, so the virtual id is unresolvable at test time. Added `src/test/stubs/pwa-register.ts` and an `resolve.alias` entry in `vitest.config.ts` so `sw-register.test.ts` can further `vi.mock` the id and assert calls. Tests themselves use `vi.waitFor(...)` to settle the dynamic import (microtask flushing was flaky).
4. **Added `vite-plugin-pwa/client` to `frontend/tsconfig.json#compilerOptions.types`.** Needed so `virtual:pwa-register` types are visible inside `sw-register.ts` without a triple-slash reference.
5. **Placeholder icons generated via a tiny no-deps Node script** (`$CLAUDE_JOB_DIR/tmp/gen-icons.mjs`) — solid sage-green PNGs at 192 / 512 / maskable-512 / 180 (Apple). Hand-packed PNG with a single IDAT zlib stream; no native bindings or image libs pulled in. Final brand art is tracked as a follow-up.

### Implementation details worth carrying

- **`registerServiceWorker()` gates on three checks**, in order: `import.meta.env.PROD`, `typeof navigator !== 'undefined'`, `'serviceWorker' in navigator`. The last one matters on older WebViews (some embedded Android / older iOS contexts) where `navigator` exists but the SW API is absent. `void import('virtual:pwa-register').then(...)` keeps the virtual id out of dev/test bundles entirely.
- **Workbox config has `navigateFallback: '/index.html'` with `/api/*` on the denylist.** Without the denylist, a tRPC `fetch` against a precached app-shell route returns the SPA HTML on offline navigation — silently masking the real network failure. The denylist keeps API calls failing loud.
- **The cache rule's regex is non-anchored.** Tests assert it matches both `/api/trpc/shopping.getForPlan` and `/api/trpc/shopping.getForPlan?batch=1&input=%7B%7D`, *and* doesn't over-match `shopping.toggleChecked`, `recipes.list`, or `/api/auth/*`. The "over-match guard" tests are the cheap canary for "did someone widen the regex without thinking."
- **Icons live at the standard `frontend/public/icons/` path.** `apple-touch-icon.png` is linked directly from `index.html` (Apple ignores manifests for that link); the other three are referenced from `manifest.webmanifest`. `vite-plugin-pwa`'s `includeAssets: ['icons/apple-touch-icon.png']` ensures the precache pulls it in too.
- **`workbox-window` dev-dep is needed even though we don't import it directly.** `vite-plugin-pwa` emits a `workbox-window.prod.es5-*.js` chunk; the dep must be installed for the chunk to resolve. Visible in the build output.
- **`index.html` gained `theme-color`, `apple-mobile-web-app-*`, and an `apple-touch-icon` link.** The `<link rel="manifest">` is auto-injected by `vite-plugin-pwa` at build time — do not also hand-write one in `index.html` or you'll ship two competing references.

### Open follow-ups

- **Brand-art icons.** Placeholder solid-colour PNGs are in place; swap for final assets before any external install is encouraged.
- **Manifest auto-injection of `lang: 'en'`.** `vite-plugin-pwa` adds `lang: 'en'` to the built manifest even though our `pwaManifest` object does not declare it. Harmless today; flagged here so the asymmetry between the source object and the emitted artifact isn't a surprise during a future audit.
- **Procedure rename hazard.** The cache rule is hand-written, not derived from the tRPC client. If `shopping.getForPlan` is ever renamed, the cache silently misses until the regex is updated. The pwa-config tests catch over-match but not rename — worth a note in any future router-renaming session.
- **FEAT-43 enablement.** The SW now ships in production builds; FEAT-43 (offline mutation queue) can land without re-treading PWA setup. The named cache bucket (`shopping-list-network-first`) is the right place to evict on reconnect-drain if we want a stricter freshness story than the default `maxAgeSeconds`.

---

## 2026-06-21 — FEAT-41 (Plant points: day + plan with batch traversal and base-cook union)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Backend: 479/479 passing via Testcontainers (Colima socket workaround: `DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). Frontend: 268/268 passing — the pre-existing `recipe-comments.test.tsx` flake (two cases under React 19 + `user.type` on a controlled `<textarea>`) was rewritten to use `fireEvent.change`, so the full suite is now reliably green. DoD boxes in `docs/feature-specs.md §FEAT-41` left unticked — human action.

### Decisions taken at kick-off

- **Two literal procedures, not one bundled summary.** `plants.forDay({ planId, date })` and `plants.forPlan({ planId })` mirror the spec verbatim. The planner page issues one `forPlan` for the header total and one `forDay` per visible date; tRPC's `httpBatchLink` coalesces all of them into a single HTTP round-trip (≤ 14 day-queries at the plan cap), so the per-procedure API surface costs nothing at runtime. Considered extending `forPlan` to return `{ totalCount, perDay }` — cheaper to revisit later than to over-design now.
- **Helper layer doesn't reuse `recipePlantPointsExpr`.** The recipe-level helper is a correlated subquery; the day/plan layer is one grouped query with `COUNT(DISTINCT)` over a `UNION ALL`. Layering traversal on top of a correlated subquery would have spawned N+1 SQL where one query suffices. The recipe-level helper stays "pure and small" per its existing file comment.
- **`COUNT(DISTINCT ingredient_id)` over `UNION ALL` does all the dedup.** Spec's three dedup cases (same plant in two prep types on one recipe; same plant in the meal *and* its traversed base; same plant in the meal's referenced base *and* the slot's cooked base) all collapse to "two rows with the same `ingredient_id` count once." No application-side dedup, no temporal restriction on cooks-base (a later-in-the-day base cook still contributes to that day's count — spec's manual-verification step 2 confirms).
- **Out-of-range `forDay` returns 0, not `BAD_REQUEST`.** The same query that returns 0 for an "empty day" returns 0 for a date outside the plan; matching them is simpler than threshold-validating the date against the plan's start/end. Flagged as drift-tolerable.
- **Cache invalidation lives inside the optimistic hooks.** `useOptimisticSlotUpdate` and `useOptimisticSlotRelocate` already own the "after any slot mutation settles" surface; adding `utils.plants.forDay.invalidate({ planId })` + `utils.plants.forPlan.invalidate({ planId })` to their `onSettled` keeps the badge refresh in lock-step with the data it derives from. Alternative (subscribe in the page and refetch on a key prop) would have leaked plant-points knowledge into every consumer of those hooks.
- **Badge skeleton instead of "blank until ready".** Per-day queries resolve quickly but not instantly; a neutral animated `🌱 ·` chip prevents the rowheader from shifting on first paint. `count={null}` is the in-flight signal, `count={0}` is a visible badge with the number `0`.

### Drift from kick-off plan

1. **Open `[DEC-TBD]` not authored.** Spec carries `[DEC-TBD: plant-points traversal rules for batch and base-cook slots]`. The implementation answers it (union-DISTINCT shape, cooks-base included regardless of `slot_type`, no temporal restriction), but writing the actual DEC entry to `docs/design-decisions.md` is a human action per the project's DEC discipline. Flagging for the next doc pass.
2. **Pre-existing test flake fixed inline.** `recipe-comments.test.tsx` had two cases that called `user.type` against a React 19 controlled `<textarea>`; the typing-vs-render race interleaved the prior textarea value with the typed characters (`type('after')` after a `clear()` produced `aaaaaaafataearaaaa`). Swapped both to `fireEvent.change({ target: { value: … } })` which sets the controlled value atomically and exercises the same observable behaviour (button-disabled-over-limit; edit-saves-trimmed-text). Carried because the broken typing path will bite anything else that takes the same shape.
3. **Added `useDayPlantPoints` hook.** Kick-off plan said "small helper hook." Materialised as `frontend/src/hooks/use-day-plant-points.ts`, wrapping `trpc.useQueries` to issue one `forDay` per visible date and return a `ReadonlyMap<string, number | null>` (the shape the grid consumes). Stable date-array identity is the caller's responsibility — page memoises `visibleDates` on `(planQuery.data, search.start, search.end)`. No surprise here; just naming it for the record.

### Implementation details worth carrying

- **Helper SQL is one query with three `UNION ALL` legs.** Eating-recipe ingredients (gated on `slot_type='recipe'`), batch-version traversal (`recipes.base_recipe_id IS NOT NULL`, joining `recipe_ingredients` on the base), and cooks-base union (`slot.cooks_base_recipe_id IS NOT NULL`, any `slot_type`). Outer `SELECT count(DISTINCT contributions.ingredient_id)::int` over the inner set, filtered to `ingredients.is_plant = true`. The household-scoped plan join is the same `mealPlans.householdId = $1` predicate the rest of the surface uses — keeps the helper safe even if a caller forgets the procedure-layer guard.
- **The bare-column-render trap survived another round.** Inside `sql` templates, column references like `${mealPlanSlots.recipeId}` render as `recipe_id` without the table qualifier. Both `recipe_ingredients` and `ingredients` carry an `id`, so every join predicate inside the inner unions had to be hand-qualified (`recipe_ingredients.ingredient_id`, `recipes.base_recipe_id`, etc.) to dodge "column reference ambiguous." The pattern is the same one `lib/plant-points.ts`'s original comment documents and `recipe-social.ts` rediscovered the hard way last month.
- **`forDay` vs `forPlan` share one inner function** parameterised by a `dateFilter: SQL` fragment (`and meal_plan_slots.date = ${date}::date` for `forDay`, empty `sql` `` ` ` `` for `forPlan`). Avoids two near-identical 60-line SQL templates drifting apart.
- **Plan guard in the procedure mirrors `loadHouseholdPlan` from `plans.ts`/`shopping.ts`.** Local `assertHouseholdPlan` rather than importing — kept the dependency arrows shallow.
- **Badge component is single-file plain Tailwind, no icon library.** `🌱` glyph for the leaf, `aria-label="N plant points"` (or "N plant points in this plan" for the plan variant). Loading state is `🌱 ·` with `animate-pulse` and `role="status"` + `aria-label="Loading plant points"`. Two variants (`day` / `plan`) tweak padding + font-weight only.
- **`PlannerGrid.dayPlantCounts` mirrors `warningSlotIds`** in spirit — a read-only externally-derived map, no business logic in the grid. Absent key → no badge; key with `null` → skeleton; key with number → numeric badge. The grid is now a pure presentational surface for both per-slot warnings and per-day badges.
- **Optimistic hook invalidation is fire-and-forget.** Both `void utils.plants.forDay.invalidate({ planId })` and `void utils.plants.forPlan.invalidate({ planId })` run before the `setQueryData` swap; the badges refetch async while `plans.get` reconciles LWW in-place. No waterfall.
- **No new dependencies, no migration.** All columns already existed from earlier feature work; the helper composes existing schema. Frontend pulls in no icon library.

### Open follow-ups

- **Author the DEC.** Spec's `[DEC-TBD: plant-points traversal rules for batch and base-cook slots]` is still open. Suggested content: union-DISTINCT shape, cooks-base included regardless of `slot_type`, dedup-via-DISTINCT principle, no temporal restriction. Cross-refs: FEAT-19 (recipe-level), FEAT-23 (batch traversal), FEAT-32 (base cooking).
- **`forPlan` per-day breakdown.** If a future view wants a denser summary (e.g. "plant points heatmap across the plan"), either issue N `forDay` queries or extend `forPlan` to return `{ totalCount, perDay }`. Today's API is the literal spec shape; extending is cheap.
- **React 19 + `user.type` on controlled `<textarea>` is a known shape.** Two tests hit it in `recipe-comments.test.tsx`; the fix-pattern is `fireEvent.change({ target: { value: … } })`. If a future test does multi-keystroke typing into a controlled textarea and shows interleaving symptoms, reach for the same fix rather than `user.type`.

### Known limitations / not in scope

- **Plant-points by week / month** — not in v1. The two procedures answer the planner's two display surfaces (day badge, plan total) and nothing else.
- **Plant-points history / trend chart** — not in scope; FEAT-41 is a display feature, not analytics. The `non-goals.md` posture on dashboards covers this.
- **Per-day breakdown inside `forPlan`** — see open follow-ups; trivial to add when a consumer needs it.

---

## 2026-06-20 — FEAT-40 ship, mobile nav refresh, DnD widened

**Status:** all changes committed (`6f3d1b5` … `594dbba`). Backend: 459/459 green; frontend: 260/260 green. Pre-existing `recipe-comments.test.tsx` flake under parallel load still surfaces intermittently (unrelated — passes in isolation).

This is one long arc that started as "plan a new FEAT after 39 for desktop DnD" and ended up reshaping the planner's viewport story, the mobile chrome, and the `$onUpdate` clock-skew that surfaced in passing.

### What landed

1. **`6f3d1b5` — Phase A doc supersession.** DEC-84 (DnD additive) + DEC-85 (hide bank below `md` at the time) added; DEC-52 marked scope-narrowed. FEAT-40 (the new "Responsive planner interactions" spec) inserted in `feature-specs.md`, all downstream FEATs renumbered 40..53 → 41..54. Sweep covered `feature-specs.md`, `design-decisions.md`, `non-goals.md`, `session-notes.md`, `README.md`, `AGENTS.md`, and four in-code comment references (`backend/src/lib/{batch-supply,date-utils,plant-points}.ts`, `frontend/src/hooks/use-optimistic-check-toggle.ts`).
2. **`27f4db5` — Phase B implementation.** Three viewport tiers (phone / tablet / desktop) gated on two `matchMedia` queries via `useViewportTier`; `@dnd-kit/core` mounted on desktop with `PointerSensor` + `KeyboardSensor` + `TouchSensor`; bank → slot drag (same `slots.update` shape as click-to-assign) + slot ↔ slot drag (new `slots.relocate` atomic move/swap). `slots.relocate` runs inside `withTransaction`, rejects cross-plan with `FORBIDDEN`, rejects cross-household via the same plan-join scope discipline `slots.update` uses. `useOptimisticSlotRelocate` mirrors `useOptimisticSlotUpdate`'s `onMutate` / `onError` / `onSettled` scaffold but patches two slots in cache.
3. **`7e1e28f` — `$onUpdate` clock-skew fix.** `users.updatedAt` and the other timestamp columns defaulted to `sql\`now()\`` on INSERT but `$onUpdate(() => new Date())` on UPDATE. Under clock skew between Node and Postgres in Testcontainers the after-value could land *earlier* than the before-value (saw ~14 ms inversion in user-procedures). Switched all 9 timestamp `$onUpdate` callbacks to `() => sql\`now()\`` so both ends use the DB clock; `recipes.dateLastUpdated` left on `new Date()` because it's a `date` column (day precision, no skew).
4. **`aa71089` — Three tiers collapsed to two.** The tablet tier (bank above grid, no DnD) was a half-state with neither the layout benefit (bank above the grid was cramped) nor the DnD benefit. Re-anchored everything to a single `lg` cutoff: below `lg` no bank, no DnD, editor-only; at `lg+` bank + DnD. `useViewportTier` → `useIsLargeViewport` (boolean). DEC-85 + FEAT-40 rewritten for the `lg` cutoff; AGENTS.md trap and `non-goals.md` scope updated.
5. **`81c4ccb` — Mobile width reclamation.** Double `p-6` (root + `AuthedLayout`) was eating 48 px each side on every viewport. Grid mins (`6rem` + 2 × `10rem` = 26 rem) overflowed a 412 px phone. Fix: dropped `AuthedLayout`'s `p-6`, stepped root to `p-3 sm:p-6`, tightened grid mins to `4rem` date + `7rem` per occasion. Fits a 360 px viewport with breathing room; larger viewports still expand via `1fr`.
6. **`045fdc5` — Nav wrap.** The top-row nav had no `flex-wrap`, so "Shopping list" broke mid-label and `items-center` mis-aligned it. Added `flex-wrap gap-y-2` and `whitespace-nowrap` on each link.
7. **`90502e4` — Bottom tab bar on phone.** Replaced the 2-row top nav below `lg` with a sticky header (app title links Home, gear icon links Settings) + a fixed bottom bar with four primary destinations (Plans, Shopping list, Recipes, Ingredients), each as a stacked `lucide-react` icon + label. `pb-[env(safe-area-inset-bottom)]` clears the iOS home indicator; outlet gets `pb-20` so the last row sits above the bar. Top nav stays at `lg+`. Gate reuses `useIsLargeViewport`.
8. **`594dbba` — Slot ↔ slot DnD at every viewport.** Originally DnD only mounted at `lg+`. Touch-and-hold list-reordering is a legitimate phone gesture and the user wanted it. Mounted the `DndProvider` unconditionally and always pass `dndEnabled` to the grid. Bank → slot drag stays `lg+` only because the bank itself is hidden below `lg` (DEC-85). DEC-84 gets an "Amended" line; FEAT-40, `non-goals.md`, and AGENTS.md traps split the two paths.

### Decisions taken inline (drift from the plan worth recording)

- **Viewport gate is `lg`, not `pointer: fine`.** Original instinct was to gate DnD on pointer fineness; user pushed back that touchscreen laptops and tablets in landscape have plenty of room. Settled on viewport-only — touchscreen laptops hit `lg+` and get DnD; tablets in portrait below `lg` get the compact layout. Phones never get the bank. The `TouchSensor` with 200 ms delay handles the gesture/scroll conflict on touch devices.
- **Bank and DnD share one gate.** Started as two separate decisions (bank below `md`, DnD at `lg+`), collapsed to one in `aa71089` because the tablet middle tier was a half-state. "Bank and DnD travel together" is now the durable rule — except for the later widening below.
- **Slot ↔ slot DnD widened to all viewports.** Direct user request after the collapse. Bank → slot stays `lg+` only (no bank below `lg`), so the "travel together" rule only binds the bank ↔ DnD coupling at `lg+`; slot-only DnD is its own additive thing.
- **`slots.relocate` not two `slots.update` calls.** Move + swap are inherently two-row writes; doing them as two client calls would split the transaction. `withTransaction` (cross-cutting #4) handles it server-side and the client gets back both updated slots in one response.
- **`useOptimisticSlotRelocate` is a sibling of `useOptimisticSlotUpdate`, not an extension.** Same scaffold (`onMutate` / `onError` / `onSettled` + previous-snapshot rollback) but the cache patch shape differs (two-slot vs one-slot, no recipe preview). Forcing the existing hook to grow a second mode would have muddied the single-slot path. Sibling hooks keep both readable.
- **Postgres `NOW()` for `$onUpdate` is durable, not a test-only fix.** Was tempted to only loosen the test assertion (`not.toBe(initial)` instead of `toBeGreaterThan`), but the real bug is the mixed clock source. Schema fix is the right durable answer; it costs nothing in production (DB clock is already the source for INSERT defaults) and removes a whole category of flake.
- **Bottom tab bar over hamburger.** Hamburger is the most space-efficient but hides destinations, and discovery loss is well-studied. Tab bar puts the four primary destinations under the thumb — matches DEC-52 / DEC-53's "one-handed in a kitchen" framing better than the top row ever did. Home moved to app-title link, Settings to gear icon, so the bar stays at four destinations rather than crowding into five.
- **`PointerSensor` + `TouchSensor` coexistence is intentional.** dnd-kit supports both registered together; the library dispatches per event source. If real-device touch ever feels racy, the standard fix is to drop `PointerSensor` and pair `MouseSensor` + `TouchSensor` — flagged in the discussion, not yet needed.

### Carry-forward gotchas

- **`useIsLargeViewport` is the single source for the planner's viewport-gated behaviour.** Bank visibility, the planner page's flex/grid layout, and the auth-shell's bottom-tab-bar-vs-top-nav all read it. Any future tweak that "feels mobile-specific" should reuse this hook rather than introduce a second breakpoint; we collapsed three tiers to two precisely to avoid drift.
- **Slot ↔ slot drag works at every viewport, but bank → slot drag does not** — the bank is hidden below `lg` per DEC-85. A future contributor proposing "drag from the bank on a phone" is missing that there is no bank below `lg`.
- **`$onUpdate(() => sql\`now()\`)` is now the default for timestamp columns.** Anyone adding a new `updatedAt`-style column should follow that pattern, not `() => new Date()`. Date columns (`recipes.dateLastUpdated`) stay on `new Date()` — day precision absorbs clock skew.
- **`AuthedLayout` no longer pads.** Root `<main className="container mx-auto p-3 sm:p-6">` is the only place that pads now. Any new authed page can assume content sits directly inside root's padding.
- **Bottom tab bar uses `pb-20` on the outlet wrapper to clear the fixed bar.** If a future feature adds a sticky element at the bottom (e.g. shopping-list checkout footer), it needs to either coexist above the tab bar or be `lg+` only.
- **`AuthedLayout` test mocks `Link` as a plain `<a>`.** The existing pattern of `vi.importActual` + override-`createFileRoute` doesn't let us render the layout outside a Router context. The new render tests override `Link` and `Outlet` directly. If you add more layout-render tests, follow the same mock shape.
- **DnD on mobile DevTools emulator is flaky.** Touch sequences (especially long-press) don't fire reliably in Chrome's emulator. Test the gesture on a real device before chasing what looks like a sensor bug.
- **Bottom tab bar a11y.** `<nav aria-label="Primary">` is the landmark; each tab is a TanStack Router `<Link>` with `activeProps` and `inactiveProps`. Don't switch to a `<button>` or you'll lose the routing semantics; don't drop the `aria-label` or you'll have two unnamed `<nav>` regions on desktop+phone transition.

---

## 2026-06-19 — Theme preference doesn't apply without hard refresh

**Status:** fix complete; not yet committed at write time. `settings-page.test.tsx` 14/14 pass; `pnpm -r typecheck` and `pnpm -r lint` clean. Pre-existing flake in `recipe-comments.test.tsx` unrelated.

### The bug

Switching theme in Settings and clicking *Save* persisted to the DB but the UI stayed on the old theme until a hard refresh. `ThemeProvider` (`frontend/src/lib/theme-provider.tsx`) reads `themePreference` from Better Auth's `useSession` cache, not from tRPC's `getMe`. The settings mutation only `invalidate`s `trpc.user.getMe`, so the Better Auth session atom keeps serving the stale value.

Better Auth's session atom auto-refreshes only when its own endpoints fire (the client wires a `$sessionSignal` listener to `/update-user`, `/sign-out`, etc. — see `node_modules/.../better-auth/dist/client/config.mjs:67`). Our profile update goes through tRPC, so that listener never sees it.

### What changed

- `frontend/src/lib/auth-client.ts`: exported `refreshSession()` which calls `authClient.$store.notify('$sessionSignal')`. That's the documented hook for nudging the session atom from outside Better Auth's endpoint surface.
- `frontend/src/routes/-components/settings-page.tsx`: `updateProfile.useMutation`'s `onSuccess` now calls `refreshSession()` after `utils.user.getMe.invalidate()`, so `ThemeProvider` re-reads on the next render.
- `settings-page.test.tsx`: the `updateProfileMock` now wraps `mutateAsync` so `useMutation`'s `onSuccess` actually runs in tests (previously the mock just returned `{ mutateAsync }` and onSuccess was never invoked). Added two new tests: success path refreshes the session; error path does not.

### Decisions taken inline

- **Did not move the theme source-of-truth to tRPC's `getMe`.** `ThemeProvider` sits at the app root and renders for unauthenticated users (sign-in page); reading from `getMe` would either fail or need a conditional that knew whether the user is signed in. Keeping the session as the read path and just nudging the atom is two lines and preserves the existing shape.
- **`$store.notify` over `getSession({ disableCookieCache: true })`.** Both refetch, but `notify` triggers the same code path Better Auth's own auto-refresh uses (`useAuthQuery` re-runs when `$sessionSignal` flips), so the React subscriber sees a fresh value via the existing nanostore subscription. Calling `getSession` directly bypasses the atom and the `useSession` consumers wouldn't necessarily re-render.

### Carry-forward gotchas

- **Any future field added to `inferAdditionalFields` (the auth client extension at `auth-client.ts:17`) needs the same treatment** if it's mutated via tRPC rather than Better Auth. Today that's just `themePreference`; if `householdName` or similar lands on the session later, the settings mutation should keep calling `refreshSession()` — already covered by the existing call site.
- **The test mock change is non-trivial:** `updateProfileMock.mockImplementation(opts => { ... opts.onSuccess?.() ... })` mirrors `useMutation`'s real behaviour. If anyone adds another `useMutation` with side-effecting callbacks to this page, they can rely on `onSuccess` actually firing in tests.

---

## 2026-06-19 — Shopping list contributor row layout

**Status:** implementation complete; not yet committed at write time. `list-line.test.tsx` 6/6 pass. Unrelated pre-existing flake in `recipe-comments.test.tsx` ("edit flow swaps in a textarea" — `userEvent.type` produced garbled input again under parallel load; same shape as the FEAT-39 note's flake). UI-only cosmetic change — no schema, no DTO, no helper.

### What changed

- `frontend/src/components/shopping/list-line.tsx`: the per-recipe contributor `<li>` inside the `<details>` disclosure was three flex children with mixed font sizes and no separation between the date and the amount. Now: `items-baseline justify-between gap-x-3`; recipe name on the left, date + amount grouped in a single trailing span with a hidden `·` separator. Dropped the per-span `text-xs` so the whole row inherits the disclosure's `text-sm`; metadata softened to `text-muted-foreground/80` for hierarchy against the recipe name.

### Decisions taken inline

- **Single font size for the row.** The previous mix (recipe text-sm, date/amount text-xs) created a baseline-stretch artefact under `align-items: stretch` and read as a cramped run. One size + `items-baseline` is what fixes the "looks odd".
- **`·` separator is `aria-hidden`.** Screen readers already pause between sibling spans; the dot is purely visual. Avoids "Mon 15 Jun dot 300 g" being read out.
- **No new helper.** The pairing pattern (label + metadata group with `justify-between`) is already present on the main shopping line above; replicating four lines of layout is cheaper than extracting at this scale.

### Carry-forward gotchas

- `list-line.test.tsx` `getByText('Tomato pasta')` still resolves because the recipe name remains in its own `<span>`. Tests that match the *raw* contributor string (e.g. `getByText(/Tomato pasta Mon 15 Jun/)`) would now fail since the spans are split across two flex groups; none in tree today, but worth knowing if a snapshot is ever added.

---

## 2026-06-19 — Slot card clear affordance

**Status:** implementation complete; not yet committed at write time. `pnpm --filter frontend typecheck`, `pnpm --filter frontend lint`, and the full Vitest suite (250 tests) all pass. No human probe owed beyond a tap to confirm the icon hit-target feels right.

### What changed

- `SlotCell` gained an optional `onClear` prop and renders a `Trash2` icon button (top-right, absolutely positioned within a wrapper `<div>`) whenever `onClear` is supplied and the slot is not already empty. Main button gets `pr-8` padding when the affordance is visible so the icon doesn't overlap the content.
- `PlannerGrid` accepts `onSlotClear` and threads it per slot.
- `PlannerPage` adds `handleSlotClear`, which dispatches an `empty` payload through the existing `useOptimisticSlotUpdate` hook — no editor-sheet detour.
- Tests: two new `SlotCell` cases (clear fires `onClear`, hidden for empty slots), one new `PlannerPage` case (card-level clear bypasses the editor). Two pre-existing planner-page selectors anchored with `^…$` because the new `Clear …` aria-label otherwise matched the same `getByRole` regex as the main button.

### Decisions taken inline

- **Nested-button avoidance via a wrapper div.** A single `<button>` can't contain another interactive button (invalid HTML, blocks the inner click in some browsers). The card is now `<div className="relative"><button …/>{maybe <button …/>}</div>` — both buttons are siblings and the trash button is absolutely positioned. Matches the standard shadcn pattern for "card with secondary action".
- **No confirmation dialog on clear.** The editor sheet's existing `handleClear` button doesn't confirm either — staying consistent. LWW (DEC-36) means an accidental clear is recoverable by re-picking the recipe; the editor sheet still opens on tap of the main button when the user wants to inspect first.
- **Hidden for empty slots.** Clearing an empty slot is a no-op. Keeps the visual noise down on a fresh week where every slot starts empty.
- **Reused the optimistic hook (cross-cutting #7).** Did not introduce a new mutation path. The new handler is one `update({ input })` call with the canonical empty payload — identical shape to the editor's clear button so the optimistic + settle logic doesn't fork.

### Carry-forward gotchas

- **`SlotCell` is now a `<div>` at the root, not a `<button>`.** Tests that did `getByRole('button')` on a `SlotCell` mount will fail if a clear handler is supplied (two buttons match). The existing `slot-cell.test.tsx` happens to render without `onClear` so its bare `getByRole('button')` still resolves uniquely — but anything new should use the aria-label.
- **The clear button's `aria-label` is `Clear ${describeSlotForA11y(slot)}`.** That string is a strict superset of the main button's label, so any regex that matches the main button without anchors will also match the clear button. Always anchor (`^…$`) or use `exact: true`.

---

## 2026-06-19 — Shopping list nav entry

**Status:** implementation complete; not yet committed at write time. `pnpm --filter frontend typecheck` and `pnpm --filter frontend lint` both clean. No new tests — UI nav wiring only. Manual probe (sign in → click "Shopping list" → confirm forward to active plan or empty state) owed by the human.

### What changed

- New `/_authed/shopping` route: thin shell in `frontend/src/routes/_authed/shopping.tsx`, page body in `routes/-components/shopping-index-page.tsx`. Queries `plans.list({ status: 'active' })`, picks the first item, and forwards to `/plans/$planId/shopping` with `replace: true`. No active plan → empty state with a CTA to `/plans`. Loading/error mirror the per-plan `ShoppingListPage` shape.
- `routes/-components/authed-layout.tsx` now has a `Shopping list` link between `Plans` and `Ingredients`.

### Decisions taken inline

- **Forward, don't duplicate.** The shopping list URL stays `/plans/$planId/shopping` — that's the canonical, per-plan URL the planner header already links to and the PWA cache rules already match. The new `/shopping` is a convenience entry that resolves "which plan?" client-side, not a second source of truth.
- **`replace: true` on the redirect** so back-button doesn't bounce the user between `/shopping` and `/plans/$planId/shopping`.
- **"Active" = first item of `plans.list({ status: 'active' })`.** The list query orders by `startDate desc, id desc`; given the backend's overlap constraint (DEC-17 territory) you can only have one active plan at a time in v1, so "first" and "the one" coincide. If multi-active ever becomes a thing, this picks the most recently started — fine as a default.
- **No `beforeLoad` redirect.** Doing it in the component with `useEffect` keeps the route file a thin shell (AGENTS.md route-shell rule) and reuses the existing tRPC react-query plumbing rather than wiring a server-side prefetch just for this.

### Carry-forward gotchas

- The new route doesn't have a Vitest. The nav-link presence and the redirect behaviour are both observable, but with the existing per-plan `shopping-list-page.test.tsx` covering the destination it didn't earn one. If the redirect ever flakes, the cheapest probe is a single render-and-assert-`navigate` test mirroring `plans-page.test.tsx`'s `useNavigate` mock pattern.

---

## 2026-06-19 — Planner date label formatting

**Status:** implementation complete; not yet committed at write time. Touched `frontend/src/lib/date-utils.ts` plus three surfaces (planner header, plans list card, slot editor modal title) and three test files. Frontend Vitest run scoped to affected files: 45/45 across `date-utils.test.ts`, `plan-list-card.test.tsx`, `plans-page.test.tsx`, `planner-page.test.tsx`, `slot-editor-sheet.test.tsx`. `pnpm -r typecheck` clean. UI-only cosmetic change — no schema, no DTO, no domain code; nothing to verify via Testcontainers.

### What changed

- New `formatLongDayLabel(iso)` — "Fri 19th Jun 2026". Uppercased weekday rejected mid-iteration in favour of sentence-case for the modal/header context (was MON … →  Mon …).
- New `formatDayRangeLabel(start, end)` — collapses repeated month/year segments. Same month + year: `Mon 15th – Sun 21st Jun 2026`. Same year only: `Mon 30th Jun – Sun 6th Jul 2026`. Different years: full label on both sides. The collapse parses both ISO strings once and branches on `s.year === e.year && s.month === e.month`.
- Three call sites updated: `routes/-components/planner-page.tsx` header, `components/planner/plan-list-card.tsx` list row, `components/planner/slot-editor-sheet.tsx` `DialogTitle`. Slot-cell aria-labels (`{occasionName} on {date}`) intentionally left alone — accessibility text, not a user-visible date.

### Decisions taken inline

- **Helpers live in `frontend/src/lib/date-utils.ts`,** not `/shared`. Format is a frontend presentation concern; the backend has its own civil-day helpers (`backend/src/lib/date-utils.ts`) and there's no current DTO that needs the rendered string. DEC-80 keeps `/shared` runtime-leaf — adding a presentation helper there would have been wrong altitude.
- **Ordinal suffix is a 4-line switch.** No `Intl` API for ordinals at the `en-GB` locale we care about (`Intl.PluralRules` gets the plural category but not the suffix string). Hand-rolled `ordinalSuffix(day)` covers 11th/12th/13th and the `1/2/3/n` tail. Self-contained, no deps.
- **Collapse logic is in the range formatter, not the day formatter.** Keeping `formatLongDayLabel(iso)` total — "always renders weekday/day/month/year" — means it's safe to call standalone (slot modal does). The collapse decision is a property of the *pair*, so it lives where the pair is.
- **Test fixture date `2026-06-15 – 2026-06-21` falls in the same month**, so the existing fixture exercises the same-month branch. No fixture changes needed; the cross-month and cross-year branches are covered by intent only — could add `date-utils.test.ts` cases if it ever regresses, but the call-site tests pin the most-used branch.

### Carry-forward gotchas

- **`Intl.DateTimeFormat` rendered short month is `Jun.` in some locales but `Jun` in `en-GB`.** The pinned locale (`'en-GB'`) gives the trailing-dot-free form across Node/Chromium. A future swap to `'en'` would re-introduce the dot; the call-site tests would catch it.
- **Same-month range with reversed weekday (`Sun 21st – Mon 15th`) is grammatically odd**, but the formatter trusts that callers pass `start ≤ end`. Upstream uses `clampRange` + `plan.startDate <= plan.endDate` invariants, so this stays implicit.

---

## 2026-06-19 — FEAT-39 (Shopping list view UI)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across the three workspaces. Frontend Vitest run: 247/247 tests across 36 files (212 pre-existing + 35 net new across `use-optimistic-check-toggle.test.ts` (5), `shopping-list-page.test.tsx` (7), `list-line.test.tsx` (6), and one additional case across the existing planner-page test where I extended the `@tanstack/react-router` mock). One pre-existing flake in `recipe-comments.test.tsx` ("Post button is disabled when text exceeds the max length" — `userEvent.type` produced garbled input under parallel load, then passed in isolation and on rerun). DoD boxes in `docs/feature-specs.md §FEAT-39` left unticked — human action. Manual gate (open list, check items, edit servings to trigger DEC-31 reset, print preview, phone viewport) owed by the human.

### Decisions taken at kick-off

- **Sibling optimistic hook, not a generalised one.** `useOptimisticSlotUpdate`'s preview args (`optimisticRecipe`, `optimisticPairedRecipe`) are tightly coupled to the plan DTO shape. Generalising would have leaked plan-DTO concerns into the shopping cache or required an awkward type-parameterised wrapper. `useOptimisticCheckToggle` mirrors the same `onMutate` / `onError` / `onSettled` skeleton against `utils.shopping.getForPlan` (server-truth on settle, no invalidation — DEC-36 LWW). Confirmed pre-implementation. Cross-cutting #7's "encapsulate the pattern" obligation is satisfied at the *pattern* level (the rollback-on-error contract is the canonical part), not at the symbol level.
- **Nav entry points added on both the plan list card and the planner header.** Spec's file list only enumerated the shopping route — the page would have been URL-only. Confirmed pre-implementation that adding two small links is in scope, not feature creep. Both use `Button asChild + Link` so the styling is reused.
- **shadcn `Checkbox` primitive, not native `<input type="checkbox">`.** Native would have avoided a new dep (Radix `@radix-ui/react-checkbox`); shadcn aligns with the rest of `components/ui/*` and gives a consistent focus-ring/colour story. Confirmed pre-implementation. Radix is ESM-clean, so the DEC-01 ESM-only constraint isn't a stop-and-ask.
- **Checked lines stay in place, dim + strikethrough.** Sorting checked items to the bottom would reflow the list and break scroll position mid-shop; hiding them needs an extra "show checked" toggle. Confirmed pre-implementation.
- **No reset-signal affordance.** When `getForPlan` returns a previously checked line as `isChecked: false` because its total drifted (DEC-31), the visible flip on reload is the signal. No toast, no chip — that's the accepted surprise framing in DEC-31's consequences. Confirmed pre-implementation.
- **Native `<details>` / `<summary>` for the contributing-recipes disclosure.** Keyboard- and screen-reader-friendly out of the box; the print stylesheet hides the whole `<details>` regardless. No controlled disclosure state needed in the page.

### Drift from kick-off plan

1. **Extended the `planner-page.test.tsx` router mock.** Not in the plan's file list, but adding the `Shopping list` header button caused the existing mock to fail with "No 'Link' export is defined on the '@tanstack/react-router' mock." Added a minimal `Link` stub (`<a>` passthrough). The plan-list-card test was unaffected — it doesn't mock the router.
2. **Page hides the header via `[data-print-hide]`, not by name.** Plan said "hide nav"; the AuthedLayout's `<nav>` is hidden by tag selector (`nav { display: none }`), but the page's own intro header was a candidate too. Introduced a `data-print-hide` attribute on it (and any future "hide on paper" elements) so the print CSS can generalise without inventing new tag selectors.
3. **`data-shopping-*` attributes used for the print-CSS hooks.** Avoided coupling the print stylesheet to Tailwind class names. `data-shopping-list-page`, `data-shopping-category`, `data-shopping-line`, `data-shopping-contributors`, `data-shopping-shelf-life-badge` all act as stable selectors for the @media print block. Easy to grep, doesn't break if the visual classes change.
4. **Route renamed `$planId.shopping.tsx` → `$planId_.shopping.tsx` post-merge (commit `650b26f`).** Manual gate caught the navigation failing — the dot in the original filename made TanStack file-based routing nest the shopping page under `$planId.tsx` (the planner) as a layout-child. The planner doesn't render an `<Outlet />`, so the shopping page never mounted at `/plans/<id>/shopping`. The trailing-underscore convention breaks the route out of the parent layout — generated tree now shows `parentRoute: AuthedRoute` instead of `AuthedPlansPlanIdRoute`, and the URL path is unchanged (`/plans/<id>/shopping`). The page's `useParams` `from` field updates to match the regenerated route id (`/_authed/plans/$planId_/shopping`). **Carry-forward gotcha:** any future co-located sub-route under a non-layout parent in this repo (e.g. `$recipeId.history.tsx` under `$recipeId.tsx` if/when that's added) will hit the same trap. Either the parent grows an `<Outlet />` *or* the child takes the trailing-underscore opt-out.

### Implementation details worth carrying

- **`useOptimisticCheckToggle` patches one line per call.** `applyCheckPatch(list, ingredientId, isChecked)` walks the categories and flips the matching line. Used both by `onMutate` (with the input's `isChecked`) and `onSettled` (with the server's). One traversal helper handles both directions.
- **`onSettled` reconciles without invalidating.** Mirrors the slot hook (DEC-36 LWW). The server response carries only `{ planId, ingredientId, isChecked }` — that's enough to re-patch the cache without a refetch. A concurrent edit on a second client surfaces on the next `shopping.getForPlan` mount.
- **`ListLine` uses `<label htmlFor>` over the entire row.** Clicking the ingredient name or the quantity also toggles the checkbox — bigger tap target than the 5×5 px checkbox alone, matches the FEAT spec's "large tap targets" criterion.
- **`formatQuantity` is the unit-aware formatter.** Reused from FEAT-19. `g` strips trailing zeros after one decimal; other units strip pure trailing zeros. Both the total and each contributing slot's `scaledQuantity` go through it.
- **`formatDayLabel` from `dateUtils`.** Both the shelf-life badge ("Needed by Mon 15 Jun") and each contributing slot's date use the same human-friendly civil-day formatter. No `new Date()` in domain code (DEC-33).
- **Print CSS is a separate file, imported once in `main.tsx`.** Order matters — `index.css` (Tailwind tokens) before `print.css` (@media print rules) so that the print block can override the tokens. The print stylesheet is small (≈ 70 lines) but isolated; future surfaces that need print rules can extend the same file without touching component CSS.
- **Radix `Checkbox` uses `data-state="checked"`.** Tailwind's `data-[state=checked]:bg-primary` + `data-[state=checked]:text-primary-foreground` colour the box; the `Check` lucide icon renders inside the `CheckboxPrimitive.Indicator`. No `@radix-ui/react-checkbox` CSS to import.
- **`ComponentRef` over `ElementRef`.** The shadcn template uses `ElementRef` (deprecated in @types/react 19). Linter caught it; replaced with `ComponentRef` per the rule's suggestion. Carries forward to any future shadcn primitives added to this repo.
- **Empty-state copy ("Nothing to shop for — this plan has no ingredient-bearing slots yet.").** Renders when `categories` is `[]` or every category has zero `lines`. Distinct from the loading and error states; the page never collapses to a blank screen.

### Open follow-ups

- **Manual gate** per the FEAT-39 verification steps: start backend + frontend; navigate to `/plans/<id>/shopping`; check a line — UI flips immediately; reload — server state matches; bump a slot's `numberOfServings` so a checked line's total drifts → reload → that line returns unchecked; print preview → single column, no nav, no contributing-recipes, shelf-life badges visible, category groupings preserved; phone-width viewport → no horizontal scroll, tap targets ≥ 44 px.
- **`recipe-comments.test.tsx` flake.** Pre-existing parallel-run timing issue with `userEvent.type` — `'after'` came out as `'aaaaaaafataearaaaa'`. Reproducible only under the full parallel test run; passes alone and on rerun. Not caused by FEAT-39, but worth a separate investigation if it surfaces again. Likely fix is `userEvent.setup({ delay: null })` or a `pointerEventsCheck: 0` option, but the root cause should be confirmed before applying a workaround.
- **FEAT-42 (PWA infra).** The shopping route is now the first `tRPC` URL that needs network-first runtime caching. `vite-plugin-pwa` registration plus the Workbox runtime-cache rule should match on the `/api/trpc/shopping.getForPlan?…` path prefix (cross-cutting #16 — `httpBatchLink` URL shape stays). No DTO change needed.
- **FEAT-43 (offline mutation queue).** `useOptimisticCheckToggle` is the natural extension point — wrap `mutation.mutate` in a queue that serialises `{ planId, ingredientId, isChecked, requestedAt }` to IndexedDB and drains on reconnect. The hook's `onMutate` already does the optimistic patch, so the queue layer is the durability story plus the drain reconciliation, not a rewrite.
- **Stale memory:** the cross-cutting helper register in AGENTS.md mentions only the slot card and the optimistic slot-update hook as canonical scaffolds. After FEAT-43 makes the shopping-side hook authoritative for offline-aware mutations, the cross-cutting section should call it out by name (currently it's a sibling, not a peer).

---

## 2026-06-18 — FEAT-38 (Check-state with lazy-create and quantity-bound reset)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck` and `pnpm -r lint` clean across the three workspaces. Backend Testcontainers run (with the Colima env vars `DOCKER_HOST=unix:///.../colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`): 453/453 passing — 30 in `shopping-procedures.test.ts` (15 pre-existing + 15 new: 10 `getForPlan check-state`, 7 `toggleChecked`; one removed-ingredient survival case landed inside the check-state block). DoD boxes in `docs/feature-specs.md §FEAT-38` left unticked — human action. Manual gate (check items → edit servings → reload → that line is unchecked, others remain checked; revert servings → check stays off) is owed by the human.

### Decisions taken at kick-off

- **Server recomputes `last_checked_quantity` on toggle.** The toggle input does not carry a quantity. Procedure re-runs the contribution SQL for the single `(planId, ingredientId)` pair inside the transaction and stamps the authoritative total. A client-supplied number would let a stale snapshot poison the reset invariant on the very next `getForPlan`. Confirmed pre-implementation.
- **`toggleChecked` returns `{ planId, ingredientId, isChecked }`.** Minimal confirmation. The UI continues to drive line state from the most recent `getForPlan` snapshot; no need to send the full line back.
- **Orphan toggles are rejected with `NOT_FOUND` + `SHOPPING_INGREDIENT_NOT_IN_PLAN`.** A new contribution check runs before the upsert. Zero rows → refuse. Prevents a buggy or malicious client from planting `(planId, ingredientId)` rows the aggregation will never surface. FK already enforces existence; the *contribution* check is the additional discipline.
- **`getForPlan` uses bulk SELECT-then-upsert.** One SELECT pulls every existing `shopping_list_items` row for the plan; in-memory diff produces three sets — *insert*, *reset*, *unchanged* — and at most two bulk writes follow (`INSERT … ON CONFLICT DO NOTHING` + `UPDATE … WHERE ingredient_id = ANY($)`). Both skipped if their set is empty. Bounded queries per request regardless of line count.
- **`parseMilliFromFixed3` exported from `shopping-aggregation.ts`.** Numeric equality on `last_checked_quantity` vs `currentTotal` runs via integer-milli — same parsing rules as the aggregation totals. A future precision change moves one constant in one file. (Naked string compare would over-fire the reset because Postgres can emit `'1.5'` and `'1.500'` for the same value; pinned by test "compares lastCheckedQuantity by numeric value, not string representation".)

### Drift from kick-off plan

1. **Aggregation helper output type narrowed, not just shape-expanded.** Plan called for `isChecked: boolean` on `ShoppingListLine`. The helper had been returning `ShoppingListLine`; rather than have it produce a fake `isChecked: false` placeholder, introduced `AggregatedShoppingListLine = Omit<ShoppingListLine, 'isChecked'>` and `AggregatedShoppingListCategory` in `shopping-aggregation.ts`. The helper stays a pure transformation; the procedure decorates with the post-write `isChecked` before returning. Zero test changes in `shopping-aggregation.test.ts` because no existing expectation included `isChecked` (a one-line bonus — adding the placeholder would have broken the literal `.toEqual([...])` on line 59).
2. **New domain code named `SHOPPING_INGREDIENT_NOT_IN_PLAN`.** Plan-draft text used a tentative `INGREDIENT_NOT_IN_PLAN`. Aligned with the existing prefix convention (`SLOT_*`, `RECIPE_*`, `INGREDIENT_*`, `PLAN_*`, `ACCOUNT_*`) — there are no other `SHOPPING_*` codes yet, so this one establishes that namespace.
3. **Contribution projection extracted into two `const` objects.** Originally three near-identical SELECT projections (`selectMealRecipeContributions`, `selectCooksBaseContributions`, and the new `selectIngredientContributions`) would have meant copy-paste rot. Factored the column projection into `contributionProjection` and `cooksBaseContributionProjection = { ...contributionProjection, scaledQuantity: <cooksBase variant> }`. Three callsites share one shape.

### Implementation details worth carrying

- **`getForPlan` now runs inside `withTransaction`.** The session-notes-1341 obligation (cross-cutting #13: "getForPlan must run inside withTransaction so concurrent first-reads can't race on insert") is honoured by wrapping the whole flow — plan load, two parallel contribution SELECTs, aggregation, reconcile pass, decoration. One transaction across the read-that-writes.
- **`reconcileCheckState` is the reconciliation engine.** Takes the plan id and a `Map<ingredientId, currentTotal>`. Returns `Map<ingredientId, isChecked>` reflecting the post-write view. Three set partitions (insert / reset / unchanged) drive at most two bulk writes; the `postWrite` map seeds the line decoration without a second SELECT. Uses `inArray(shoppingListItems.ingredientId, toReset)` for the bulk UPDATE — Drizzle composes a single `WHERE ingredient_id = ANY($)` statement.
- **`toggleChecked`'s contribution check reuses the two-path SQL.** `selectIngredientContributions` is `selectMealRecipeContributions` + `selectCooksBaseContributions` scoped to one ingredient, run in parallel inside the transaction. Returns the full contribution rows so the same `aggregateContributions` helper can compute the total for the stamp — no separate aggregation code path. The procedure exits via `computeIngredientTotal` which calls `aggregateContributions(contribs, { planStart })` and reads `aggregated[0]?.lines[0]?.totalQuantity`. Single-line guard against the (shouldn't-happen) empty result throws `Error`, not `TRPCError` — it's an invariant violation, not a user-facing path.
- **`SHOPPING_INGREDIENT_NOT_IN_PLAN` added to `DOMAIN_ERROR_CODES`.** The closed-enum schema is checked everywhere by `domainErrorCodeSchema`, so the new code is a one-line addition there + one-line `cause: { code: ... }` at the procedure's throw site.
- **`shoppingListLineSchema` gained `isChecked: z.boolean()` as required.** Always present on the DTO; the procedure stamps the post-reset value before returning. UI doesn't need to handle "absent" or "null" — a single `if (line.isChecked)` discriminator.
- **`numeric(10,3)` round-trip preserves precision.** Drizzle's `numeric` column maps to strings in JS — `'1.500'` is what comes back from the DB, `'1.5'` is what the seed test wrote. The integer-milli compare absorbs both representations exactly. The reset pass would otherwise fire on every load after a manual seed.
- **`shopping_list_items` row for a no-longer-contributing ingredient is left untouched.** Tested explicitly: delete the recipe ingredient that made the ingredient appear; `getForPlan` returns the empty category list; the persisted `is_checked = true` row stays. Harmless — composite PK survives, and if the ingredient comes back the previous check stamps re-apply.
- **`updatedAt` advances on every toggle.** Pinned by a 10ms-delay test. Routing all writes through Drizzle (no `tx.execute(sql\`UPDATE ...\`)` for the bulk reset) keeps the `$onUpdate` invariant intact.
- **Migration is one column, generated.** `0007_silly_kid_colt.sql`: `ALTER TABLE "shopping_list_items" ADD COLUMN "last_checked_quantity" numeric(10, 3);`. Nullable, defaults absent — `NULL` is "never been checked" (lazy-create) *and* "currently unchecked" (post-uncheck or post-reset). The two states are intentionally indistinguishable in storage; the read-path treats both as "no commitment recorded".

### Open follow-ups

- **Manual gate** per the FEAT-38 verification steps: build a plan with 3 ingredients; call `shopping.getForPlan` and confirm three rows exist in `shopping_list_items` with `is_checked = false`; `toggleChecked` two lines → reload → two return `isChecked: true`; bump a slot's `numberOfServings` so a checked line's total shifts → reload → that line is unchecked again and the persisted row reflects it; revert the serving count → the line stays unchecked (one-way reset per DEC-31).
- **FEAT-39 (UI surface).** The line shape's `isChecked` field is what the checkbox binds to; the optimistic-update hook from FEAT-31 is the recommended scaffold for the `toggleChecked` call (cross-cutting #7). The contract intentionally keeps the response minimal — no full-line round-trip — to keep the optimistic update path narrow.
- **FEAT-43 (offline queue + reconnect sync).** When LWW reorders a queued toggle behind a fresh aggregation, the reset can flip a line the user thought they'd just checked. DEC-36 / DEC-31 explicitly accept this; named in DEC-36's revisit-when. The IndexedDB queue should serialise `(planId, ingredientId, isChecked, requestedAt)` — server doesn't need `requestedAt`, but the client uses it to drop duplicate toggles at queue-drain time.
- **`PLAN_NOT_FOUND` domain code** remains uncreated (carried over from FEAT-36). `toggleChecked` throws plain `NOT_FOUND` for cross-household plans following the same `loadHouseholdPlan` precedent; the UI doesn't disambiguate yet.
- **Concurrent first-read race not exercised behaviourally.** The architectural `withTransaction` wrap is the protection — two simultaneous first-reads would both run `INSERT … ON CONFLICT DO NOTHING`, and Postgres serialises the inserts. Deterministically reproducing this in Testcontainers needs a coordinator helper (two awaiting promises, one shared barrier). Skipped this session because the cost outweighs the marginal certainty; the unique-PK fallback is the load-bearing guarantee, not the transaction isolation.

---

## 2026-06-18 — FEAT-37 (Shelf-life warnings)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across the three workspaces. Backend pure-helper suite `test/shopping-aggregation.test.ts`: 15/15 passing (9 pre-existing + 6 new shelf-life cases). Testcontainer-backed procedure suites (`shopping-procedures.test.ts` et al.) not exercised in this session — Docker wasn't running locally; the FEAT-37 change at the procedure layer is one new column projected through two SELECTs plus a `startDate` plumb-through, no SQL semantics changed. DoD boxes in `docs/feature-specs.md §FEAT-37` left unticked — human action. Manual gate (set an ingredient shelf life to 3 days, use it on day 5, confirm the warning surfaces) is owed by the human.

### Decisions taken at kick-off

- **`daysOverflow` is exclusive whole-day diff.** Defined as `latestNeededDate − (planStart + shelfLifeDays)` measured by raw UTC-ms / 86_400_000 on the civil-day Dates. With `planStart=2026-06-01, shelfLifeDays=3, latestNeededDate=2026-06-05` the boundary is `2026-06-04` and the answer is `1`. Deliberately **not** `dateUtils.daysBetween` — that helper is inclusive (`daysBetween(d, d) === 1`) and would yield `2` for the same input. Confirmed pre-implementation via AskUserQuestion.
- **Boundary is strict-greater-than.** Usage on `(planStart + shelfLifeDays)` is treated as fitting; only strictly later dates warn. Matches the common-gotcha note in the spec and aligns with the cook's intuition (a 3-day shelf life means it's fine on day 3).
- **Warning is `optional`, not `nullable`.** When the line fits, the field is **absent** on the DTO rather than serialised as `null`. Pinned by a test (`expect('shelfLifeWarning' in line).toBe(false)`). Cuts wire size on the common case and gives the UI a straightforward `if (line.shelfLifeWarning)` discriminator.
- **`averageShelfLifeDays` rides through the contribution row.** Both contribution SELECTs already join `ingredients`; projecting one more column is free. No second query, no procedure-layer redesign — the helper picks up the value from the first contribution row per ingredient (per-ingredient invariant: the column is functionally dependent on `ingredient_id`).
- **`planStart` is required on the helper signature.** Tightening `aggregateContributions(rows)` → `aggregateContributions(rows, { planStart })` makes the dependency explicit at every callsite. No optional default — a silent "no planStart, no warnings ever" behaviour would mask a wiring bug.

### Drift from kick-off plan

None of consequence. Two minor deviations worth noting:

1. **No new domain helper.** Plan said the warning math would live inside `shopping-aggregation.ts`. Resisted the urge to factor `computeShelfLifeWarning` into `date-utils` or a new module — it's a one-call-site helper tightly coupled to the bucket's `contributingSlots` shape. If a second consumer appears (FEAT-38's reset logic doesn't need it), promote it.
2. **Test-local `civilDate(iso)` parser.** The plan didn't anticipate a test helper. Added a small regex-based parser (mirroring `parseCivilDate` in shape, separate to keep the test file independent of `date-utils`). The first version used array-destructure + `!` non-null assertions; ESLint's `no-non-null-assertion` rule flagged it, replaced with explicit `RegExp.exec` per AGENTS.md "don't silence the linter".

### Implementation details worth carrying

- **`ShoppingContribution.averageShelfLifeDays: number | null`.** Threading the per-ingredient column through the contribution row keeps the SQL projection and helper input shape parallel — same column shape in both meal-recipe and cooks-base SELECTs.
- **`AggregateOptions` type exported for callers.** Single option for now (`planStart`); reserving the shape for FEAT-38's lazy-create reset (likely `{ planStart, existingChecked: …}` or similar) without another signature break.
- **Latest-date scan, not max-on-sort.** The helper does a linear `latestMs` scan over `contributingSlots` after they've already been sorted by `(date, slotId)`. Could in principle read `contributingSlots[contributingSlots.length - 1].date`, but the explicit max is robust to a future sort change and reads more clearly at the cost of N comparisons (always tiny).
- **No `dateUtils.daysBetween` used for overflow** — that helper is inclusive. Used raw `(latestMs − boundary.getTime()) / MS_PER_DAY` with `Math.round` to absorb any DST-driven 23-/25-hour-day skew (Europe/London civil days are UTC-midnight encoded, so DST is structurally irrelevant here, but the `round` makes the contract obvious without a comment).
- **Procedure-layer change is mechanical.** `loadHouseholdPlan` projects `startDate`; both SELECTs project `ingredients.averageShelfLifeDays`; the call to `aggregateContributions` becomes `aggregateContributions([...], { planStart: planRow.startDate })`. No new error path, no transaction (still a pure read), no `withTransaction` need (deferred to FEAT-38 as per session-notes-1341).
- **Pre-existing tests updated minimally.** Default `averageShelfLifeDays: null` on the test factory + a `DEFAULT_PLAN_START` constant far enough in the past that no realistic shelf life triggers. Nine call sites updated; semantics unchanged for those cases.

### Open follow-ups

- **Manual gate** per the FEAT-37 verification steps: in dev, set an ingredient's `averageShelfLifeDays` to 3, attach it to a recipe assigned to a slot on plan-day 5, call `shopping.getForPlan` via tRPC devtools — confirm `shelfLifeWarning.latestNeededDate` matches the slot date and `daysOverflow` is 2. Remove the shelf-life value; warning disappears.
- **Procedure-layer integration test.** A Testcontainers-backed test in `shopping-procedures.test.ts` that seeds an ingredient with a shelf life, places it past the boundary on a slot, and asserts the warning surfaces end-to-end. Not added this session because Docker wasn't running locally; the helper coverage and the mechanical procedure change keep the risk low, but a procedure-level pin would be cheap and worth picking up next time Testcontainers are exercised.
- **FEAT-39 UI surface.** The `<ShelfLifeBadge>` component (FEAT-39 file list) is the consumer. With the field optional, the component contract is `props: { warning?: ShelfLifeWarning }` and the parent renders only when set.
- **FEAT-38's lazy-create reset.** The quantity-bound reset (`is_checked → false` when current total differs from `last_checked_quantity`) wraps `getForPlan` in `withTransaction`. The shelf-life pass is read-only and not affected by the transaction boundary — runs identically inside or outside.
- **DEC-37's single-shop assumption.** Top-up shops still warn against `planStart`. The "instrument how often warnings are dismissed without action" idea named in DEC-37's revisit-when can layer on top of the line shape later (no DTO change needed if the metric is fire-and-forget).

---

## 2026-06-18 — FEAT-36 (Shopping list aggregation procedure)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck` and `pnpm -r lint` clean across the three workspaces. Backend Testcontainers run (with the FEAT-32-era Colima env vars: `DOCKER_HOST=unix:///.../colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`): 430/431 passing — the 14 new `shopping-procedures.test.ts` cases and 9 new `shopping-aggregation.test.ts` cases all pass; the one failure is the pre-existing `user-procedures.test.ts:235` `$onUpdate` timing race (`expected 1781815476317 to be greater than 1781815476337`) which passes on isolated re-run, unrelated to FEAT-36. DoD boxes in `docs/feature-specs.md §FEAT-36` left unticked — human action. Manual gate (hand-compute a non-trivial plan's totals against the procedure output) is owed by the human.

### Decisions taken at kick-off

- **Output DTO is nested-by-category** (Q1): `{ planId, categories: [{ category, lines: [{ ingredient, unit, totalQuantity, contributingSlots[] }] }] }`. FEAT-39 will render section headers directly; FEAT-37 can attach `shelfLifeWarning?` to the existing `line` shape without restructuring. Confirmed pre-implementation.
- **Same-slot dual contribution renders as two `contributingSlots` entries** (Q2). A slot eating recipe A and cooking base B with a shared ingredient produces two entries on the same `slotId` with different `recipeId` / `recipeName`. Preserves traceability ("the 3 onions split as: 1 from the meal + 2 from the base cook"). Confirmed pre-implementation.
- **Soft-deleted recipes still contribute.** Aggregation joins `recipes` without an `is_deleted` filter so DEC-21 / DEC-22 historical-render coherence holds — a slot whose recipe was soft-deleted after assignment still aggregates its ingredients. Pinned by a test.
- **No `withTransaction`.** FEAT-36 is a pure read; the session-notes-1341 obligation ("getForPlan must run inside withTransaction so concurrent first-reads can't race on insert") applies to FEAT-38's lazy-create write, not the FEAT-36 aggregation. Will wrap at FEAT-38.
- **No `hasBaseSupply` call.** Per DEC-26 / session-notes-166, FEAT-36 doesn't warn on missing base supply ("the cook is presumed to know") — it sums whatever's set on `cooks_base_recipe_id`.

### Drift from kick-off plan

1. **No `PLAN_NOT_FOUND` domain code.** The plan said `TRPCError({ code: 'NOT_FOUND', cause: { code: 'PLAN_NOT_FOUND' } })` with a "will verify at implementation time" hedge. Followed the `plans.get` / `plans.delete` precedent (`loadHouseholdPlan` throws plain `TRPCError NOT_FOUND` with no `cause`). Adding a code is a closed-enum edit to `shared/src/schemas/errors.ts`'s `DOMAIN_ERROR_CODES` — held off because no existing read-side `NOT_FOUND` uses a domain cause and the UI (FEAT-39) hasn't asked for the disambiguation yet. Easy to add when needed.
2. **Decimal precision via bigint integer-milli, not `decimal.js`.** Plan flagged decimal libs as a stop-and-ask trigger; the helper parses the `numeric(10,3)` SQL strings into `bigint` (×1000), sums, and reformats. Exact at every plausible recipe scale (10^13 headroom), no float drift, zero dependency cost. `0.1 + 0.2 === 0.300` is pinned by a test.
3. **Per-line scaled qty rounded in SQL to 3 decimals** (`round(... , 3)`). Needed so the bigint integer-milli math is exact — without `round`, Postgres's `numeric` division can emit values beyond 3 decimals (e.g. `1/3 → 0.33333...`) and the helper's parser would reject them. Documented in the helper comment.

### Implementation details worth carrying

- **Two SELECTs, one helper.** `selectMealRecipeContributions` joins `meal_plan_slots → meal_plans → recipes (eating) → recipe_ingredients → ingredients → ingredient_categories → units_of_measurement` filtered `slot_type = 'recipe' AND plan_id = ? AND household_id = CURRENT_HOUSEHOLD_ID`. `selectCooksBaseContributions` is the same shape but joins `recipes` via `cooks_base_recipe_id` and filters `cooks_base_recipe_id IS NOT NULL`. Both run in `Promise.all`; the helper concats and aggregates.
- **Plan pre-flight is its own one-row read.** Household-scoped `SELECT id FROM meal_plans WHERE id = ? AND household_id = ?` runs before the contribution queries — keeps the `NOT_FOUND` path clean and means an empty plan returns `{ planId, categories: [] }` instead of a confusing "no rows" silence.
- **Within-slot duplicate ingredient lines collapse by `(slotId, recipeId)` key in the helper.** "Onion sliced" + "onion diced" on the same recipe in the same slot becomes one `contributingSlots` entry with the summed quantity. Cross-recipe (slot eating recipe A + cooking base B, both with onion) stays as two entries because the key differs. Both pinned by tests (unit + integration).
- **Batch-no-double-count is structural, not enforced.** The meal-path SELECT joins `recipes` via `slot.recipe_id` only — it never traverses `recipes.base_recipe_id` to pull the base's ingredients. The base-path SELECT joins via `slot.cooks_base_recipe_id`. The two paths can't see each other's data, so a batch-version meal without a corresponding `cooks_base_*` slot will silently underprovision the base (the DEC-26 trade-off). Test #8 pins the no-double-count case explicitly.
- **Nested-by-category sorting:** categories by category name (locale-aware case-insensitive), lines within category by ingredient name, `contributingSlots` by `(date, slotId)`. All in the pure helper; SQL returns rows in any order.
- **No new dependencies, no migration.** Pure additive: one shared schema file, one helper, one router file, one router-composition edit, two test files.
- **`shopping_list_items` untouched.** Table exists from FEAT-12 but FEAT-36 doesn't read or write it. Lazy-create + check-state arrives in FEAT-38.

### Open follow-ups

- **Manual gate** per the FEAT-36 verification steps: create a plan with one full recipe + one batch-version meal whose base is cooked in another slot + one eat-out slot; hand-compute the totals for one ingredient; call `shopping.getForPlan` and diff line-for-line. The integration test for the batch + base-cook case (#8) is the codified version; the manual probe via the production stack confirms the SQL composes correctly outside test seeding.
- **`PLAN_NOT_FOUND` domain code.** Add to `DOMAIN_ERROR_CODES` when FEAT-39's UI needs to distinguish "plan deleted" from "plan never existed" from other failure modes. Cheap retrofit.
- **`pickableRecipesWhere` not consumed.** Pickability is enforced at slot-update time (FEAT-30/32); FEAT-36 reads the assignments. If a future change soft-deletes a recipe between slot assignment and shopping, the slot still references the recipe (DEC-21 historical render) and the aggregation includes it — confirmed by test "still includes ingredients from a soft-deleted recipe".
- **FEAT-37 (shelf-life warnings)** will extend the helper. Plan to attach `shelfLifeWarning?: { latestNeededDate, daysOverflow }` to `shoppingListLineSchema`; the line shape doesn't carry the slot dates as aggregates yet, but `contributingSlots[].date` is enough to compute the max. No DTO restructure needed.
- **FEAT-38 (lazy-create + check-state)** will wrap `getForPlan` in `withTransaction` (cross-cutting #13 / session-notes-1341) so concurrent first-reads can't race on the `shopping_list_items` insert. The current procedure is a pure read; wrapping adds the lazy-insert pass over the aggregated lines and the quantity-bound check-state reset.

---

## 2026-06-18 — FEAT-35 (Account deletion with tombstoning sequence)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across the three workspaces. Backend Testcontainers suite: 408/408 passing (10 new in `user-procedures.test.ts` — 4 covering `getDeletionSummary` and 6 covering `deleteAccount` end-to-end + rollback + email-mismatch). Frontend: 229/229 passing (33 test files) — 5 new in `settings-page.test.tsx` (heading + summary copy, email-gated enable, signOut + navigate, server-error stays-open, pending-state disables confirm) and 2 new in `sign-in-page.test.tsx` (banner present when `justDeleted`, absent on normal visit). One observed flake in `recipe-comments.test.tsx` (`edit flow swaps in a textarea …`) — re-ran clean; confirmed identical flake on a stashed `main` (pre-change), unrelated. DoD boxes in `docs/feature-specs.md §FEAT-35` left unticked — human action.

### Decisions taken at kick-off

- **No Better Auth `deleteUser` config.** `sessions` and `accounts` already cascade on `users.id` (see `db/schema/auth.ts:51, 76`); the procedure's `DELETE FROM users` cleans them. `verifications` has no user FK, so we sweep it by `identifier = ctx.user.email` inside the same transaction. Keeps the auth-boundary small (cross-cutting #17) and the entire sequence atomic in one Drizzle transaction.
- **Pre-deletion summary shows only the three tombstoned counts** (comments, recipes, plans). Ratings and drafts are hard-deleted and aren't load-bearing to the household; the user already knows about their own personal data.
- **Sign-out is client-side.** The procedure doesn't touch the cookie — once the user row is gone the session token can't be resolved by Better Auth on the next request. Client calls `authClient.signOut().catch(...)` (best-effort, clears React Query state; ignored if it fails because the session is already cascade-deleted server-side), then `useNavigate({ to: '/sign-in', search: { deleted: '1' } })`.
- **Deletion banner via `?deleted=1` search param.** Introduced `signInSearchSchema` with `z.literal('1').optional().catch(undefined)` so unrelated visits to `/sign-in` are immune to malformed input. Route file (`routes/sign-in.tsx`) calls `validateSearch` and reads via `Route.useSearch()`, passes a `justDeleted` prop into the `SignInPage` body — keeps the route file a thin shell per AGENTS.md and matches the `auth.verify.tsx` pattern.
- **Explicit `UPDATE … SET … = NULL` for the four SET-NULL columns.** Spec-faithful, auditable, and exercised in the per-step tests. Resilient if a future schema change drops a SET NULL strategy on one of those columns.
- **Email comparison is case-sensitive exact match.** Test `treats the email comparison as exact (case-sensitive)` pins this; flag a domain-code-aware copy change later if real users object.

### Drift from kick-off plan

1. **Added domain error code `ACCOUNT_DELETE_EMAIL_MISMATCH`** on the procedure's `TRPCError.cause`. Not in the kick-off plan but matches DEC-35 / cross-cutting #11 (every domain-meaningful failure gets a structured cause). Lets a future copy update in the UI key off `getDomainErrorCode` rather than string-matching the message.
2. **`DangerZone` lives as a private function inside `routes/-components/settings-page.tsx`**, not a separate component file. The wiring is one-call-site and tightly coupled to the settings page state machine; the *reusable* primitive is the `DangerConfirmDialog` (in `frontend/src/components/`). Inverting that — pulling `DangerZone` out — would have meant threading five props for no second consumer.
3. **The rollback test wraps `db.transaction`, not the procedure.** Used the existing `vi.spyOn(db, 'transaction').mockImplementationOnce` pattern from `plans-procedures.test.ts:1295` (the `duplicate` rollback test). Real Postgres ROLLBACK fires; the assertion sweep then confirms every step is unwound. Earlier draft tried to provoke the failure via a `CHECK (id <> '<USER_ID>') NOT VALID` constraint on `users` — that doesn't fire on DELETE, so the approach was abandoned mid-write.
4. **`getDeletionSummary` recipe count excludes soft-deleted recipes.** The spec just says "recipes that will be tombstoned"; choosing to match what other household members can still see (`isDeleted = false`) means the number lines up with the planner UI's view. Test pins this (`Soft-deleted` recipe added; not counted).
5. **Existing settings/sign-in test files extended in place rather than new files.** Memory rule (no FEAT-N in filenames) plus the existing test files already had the right mock plumbing; adding mocks for `getDeletionSummary` / `deleteAccount` / `authClient` / `useNavigate` to the existing setup was cheaper than a parallel test file.

### Implementation details worth carrying

- **Seven-step sequence, fixed order.** RESTRICT-FK rows (`recipe_ratings`, `recipe_drafts`) must come before any of the SET-NULL writes or the user-row delete; `verifications` sweep sits between step 6 and step 7 because it's keyed by email not id (the user row still exists when we do the sweep — required so `ctx.user.email` is still meaningful, though we cached it into a local first). Inline comment in `procedures/user.ts:139–145` flags the cross-cutting #15 obligation: any future user-FK'd table must be added to this block at the same time.
- **`getDeletionSummary` runs three counts in parallel** (`Promise.all`). Cheap at household scale, no transaction needed (read-only), no risk of stale read-vs-delete inconsistency because the UI re-fetches as the dialog opens.
- **`DangerConfirmDialog` is a generic primitive**, not deletion-specific. Props: `confirmationText` (the literal the user must type, the dialog matches exact-equal), `confirmationLabel`, `confirmLabel`, `pendingLabel`, `pending`, `errorMessage`, `onConfirm`. Resets typed state on close. Next consumer (if any) can drop in for any destructive action that wants typed-text gating.
- **`Better Auth` cascade is load-bearing.** `sessions.userId` and `accounts.userId` both declare `{ onDelete: 'cascade' }` in `db/schema/auth.ts`. If those ever change, the procedure needs explicit cleanup steps for both tables.
- **No new dependencies, no migration.** Pure additive change to a procedure, a shared schema, two route components, and one new dialog component.
- **Test setup for `user-procedures.test.ts` now truncates 12 tables** (was 4 — only auth). Necessary because the deletion tests seed across the household / recipes / plans / slots / drafts surface. Existing `getMe` / `updateProfile` / `listHouseholdMembers` tests still pass — they don't depend on any of the additional tables being empty or seeded.

### Open follow-ups

- **Better Auth's docs do publish a `user.deleteUser` config**; if a future migration wants to lean on Better Auth's own hooks (e.g. for analytics / audit emails), revisit whether to wire it. For v1, the explicit-cleanup-in-our-transaction shape is preferred for atomicity and audit clarity.
- **Manual gate** per the FEAT-35 verification steps: sign in as a test user; seed a rating, comment, recipe, plan, draft; open Settings → Danger zone; confirm counts match; type the email; trigger delete; verify the redirect + banner; query the DB to confirm the seven-step pattern (drafts/ratings gone, comments/recipes/plans NULL-attributed, user row + sessions + accounts gone, verifications for that email gone).
- **`recipe-comments.test.tsx` edit flow is flaky** under parallel test runs on this machine — `user.type` races against React's event loop occasionally. Not introduced by FEAT-35 (same flake observed pre-change); flag for a future re-investigation, not in scope here.

---

## 2026-06-18 — FEAT-34 (Plan list / browse view)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across the three workspaces. Frontend: 222/222 passing (33 test files) — 7 new in `plans-page.test.tsx` (active default + summary render; status switch navigates with the new search param; per-filter empty-state copy; new-plan dialog success + PLAN_DATE_OVERLAP surfacing; duplicate dialog forwards `{ planId, newStartDate }` and navigates; delete optimistic onMutate + onError rollback), 2 new in `plan-list-card.test.tsx` (summary string, Open/Duplicate/Delete callbacks). Backend non-container suites pass (58/58); the 12 Testcontainers suites couldn't launch in this environment ("Could not find a working container runtime strategy" — same as the FEAT-33 session). The two new `plans-procedures.test.ts` list cases (`slotsTotal = range × occasions on a fresh plan`, `slotsAssigned across a mix of non-empty states`) sit in that suite and are owed a Docker-capable box. DoD boxes in `docs/feature-specs.md §FEAT-34` left unticked — human action. Manual gate (create three plans across past/active/future; verify filters; duplicate to a future start; delete and re-open All) is owed by the human.

### Decisions taken at kick-off

- **Spec wording vs DEC-83: no `name` field on duplicate** (Q1). FEAT-34 spec says "asks for the new start date and name", but DEC-83 removed plan names and the existing `plans.duplicate` input is `{ planId, newStartDate }`. Dialog collects start date only; computes (and shows) the implied end date from the source duration as part of the description text.
- **Spec wording vs DEC-82: hard-delete with AlertDialog confirm** (Q2). The spec says "Soft-delete prompts a confirm"; DEC-82 made plans hard-delete and `plans.delete` already hard-deletes. UI uses `<AlertDialog>` ("This removes all of its slots and cannot be undone"); no procedure change.
- **Status filter lives in the URL search param** (Q3). `/plans?status=active|past|future|all`, default `active`, validated by a new `plansSearchSchema` in `/shared`. Matches DEC-10 (date range in URL for the planner) — back-button + shareable.

### Drift from kick-off plan

1. **Plan `list` row count is via single LEFT JOIN + `count(... ) filter (where ...)`.** Kick-off said "add slotsTotal/slotsAssigned via LEFT JOIN + GROUP BY"; in code that's exactly one statement returning both counts in one round-trip. `slotsAssigned` uses Postgres `FILTER (WHERE slot_type <> 'empty')`, which is the idiomatic aggregate-with-predicate form and avoids the CASE-WHEN-NULL trick. Parenthesised the FILTER clause before `::int` to keep the precedence unambiguous.
2. **`planListItemSchema` is a distinct extension of `planSchema`**, not a widening. `get` / `updateRange` / `duplicate` outputs intentionally don't inherit `slotsTotal` / `slotsAssigned` — those callers already have the full slot array and don't need a denormalised count. Only `listPlansResultSchema.items` switched to the new schema.
3. **`useNavigate` without a `from` clause.** Initial attempt used `useNavigate({ from: '/_authed/plans/' })` per the planner-page pattern, but TanStack Router's typed `from` wouldn't accept the trailing-slash index id (the equivalent `/_authed/plans/$planId` works fine for the planner). Worked around by dropping `from` and passing the absolute `to: '/plans'` on the search-param update — same nav behaviour, no type cast.
4. **`STATUS_OPTIONS` typed as `readonly { … }[]`**, not `ReadonlyArray<…>`. The project's ESLint forbids the latter (`@typescript-eslint/array-type`); learn-on-first-touch.

### Implementation details worth carrying

- **Delete is optimistic against the current filter's cache only.** `onMutate` cancels + snapshots `plans.list({ status })` for the active filter, removes the row, returns the snapshot; `onError` restores it; `onSettled` invalidates `plans.list` (all filter keys). A user mid-delete who switches filters would see the deleted row re-appear under the new bucket until `onSettled` resolves — acceptable at household scale and parallel to the FEAT-23 `recipe-rating` pattern.
- **Default new-plan range is today → today + 6 days** (a 7-day window). Picked to nudge the cook toward weekly planning without being prescriptive; the user can shrink or extend before submitting. `advance()` is an inline 6-liner over `Date.UTC` rather than widening `date-utils.ts` — the helper is single-use and the `eachDateInRange` / `formatCivilDate` pair didn't compose cleanly here.
- **Server-error translation lives in one `translateError` helper** at the bottom of `plans-page.tsx`. Maps the three domain codes the planner-create/duplicate paths can surface (`PLAN_DATE_OVERLAP`, `PLAN_RANGE_TOO_LONG`, `PLAN_PAST_NOT_EDITABLE`) to friendly copy; everything else falls back to `err.message`. Kept domain-code → copy mapping in the page rather than the dialogs so the dialogs stay presentation-only.
- **`Plans` nav link slotted between `Recipes` and `Ingredients`** in `authed-layout.tsx`. `authed-layout.test.tsx` only tests `authedBeforeLoad`, not the nav DOM — no test update needed.
- **`<Link>` mocked in the page test as a plain `<a>`** so `Link` props don't trip TanStack Router's strict typing at render time; same pattern used in `plan-list-card.test.tsx`. Avoids pulling the real router setup into a unit test.
- **No new dependencies, no migration.** Schema change is shared-Zod-only; backend change is one SQL aggregate.

### Open follow-ups

- **Run the backend Testcontainers suites** on a Docker-enabled box. The two new `plans-procedures.test.ts` cases (`reports slotsTotal = range × occasions and slotsAssigned = 0 for a fresh plan`, `reports slotsAssigned across a mix of non-empty slot states`) sit alongside the existing 36 `plans.*` cases in the same `describe`; carry the FEAT-32-era Colima env-var workaround.
- **Manual smoke** per the FEAT-34 verification steps: create past/active/future plans, exercise each filter, duplicate to a future start, hard-delete and confirm via the `all` filter, attempt an overlapping create to see the inline error.
- **Plant-points / shopping-list summary on the card** is intentionally absent — those derive in FEAT-36/40. The card has space for a single line of secondary text today; when those land, slot in alongside the slot-fill summary rather than below it.

---

## 2026-06-18 — FEAT-33 (Pair switch UI: full ↔ batch toggle on slot)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format` clean across the three workspaces. Frontend: 213/213 passing (31 test files) — 7 new in `slot-editor-sheet.test.tsx` (visibility on pair present / absent / soft-deleted, both label framings, click-fires-input shape with reset servings + cleared base-cook, hidden in non-recipe slot states), +1 in `use-optimistic-slot-update.test.ts` for the new `optimisticPairedRecipe` arg. Fixtures gained `pairedRecipeId` on `PlanSlotRecipe` literals and a `pairedRecipe` field on `PlanSlot` literals across `slot-cell.test.tsx`, `slot-editor-sheet.test.tsx`, `planner-page.test.tsx`, and `use-optimistic-slot-update.test.ts`. Backend non-container suites pass (5/5); the 12 Testcontainers suites couldn't launch in this environment (Colima socket mount-source error during this session — the workaround that worked for FEAT-32 didn't trigger here, needs re-attempt on a Docker-enabled box). One assertion in `plans-procedures.test.ts` updated for the new `recipe.pairedRecipeId` field. DoD boxes in `docs/feature-specs.md §FEAT-33` left unticked — human action. Manual gate (pair two recipes, assign one, click the switch — slot shows the other; soft-delete a pair member and re-open the editor to confirm the affordance hides) is owed by the human.

### Decisions taken at kick-off

- **Servings reset to `paired.baseServings` on switch** (D1). Full vs. batch siblings often have different yields; carrying the existing count produces a wrong number more often than not. Symmetric with the in-editor recipe-pick path (`slot-editor-sheet.tsx` combobox onChange).
- **Button label frames the destination** (D2). If `currentRecipe.baseRecipeId !== null` (current is the batch version) → "Switch to full version"; otherwise → "Switch to batch version". The destination name rides as `aria-label` only.
- **Base-cook fields cleared on switch** (D3). The implementation note "Don't auto-set the base picker on pair switch — let the user decide separately" reads as "clear", not "preserve". The suggestion hint re-appears on the next render for the new recipe and the user picks fresh.
- **Pair data delivered as a slot sub-object via a third LEFT JOIN** (D5), mirroring `cooksBaseRecipe` from FEAT-32. One render, no extra round-trip per editor open. Adds ~70 bytes/slot to `plans.get`.

### Drift from kick-off plan

1. **Visibility scope narrowed from "active recipe" to "saved recipe"** (D4 relaxed). Kick-off plan said visibility tracks `state.recipe ?? slot.recipe`, matching how `showBatchWarning` reads. In code: the affordance only renders when `state.recipe === null` (no fresh combobox pick) — the joined `pairedRecipe` sub-object reflects only the *saved* recipe's sibling, so a freshly-picked recipe's pair would need a lazy `recipes.get` fetch. Practical effect: pick a new recipe → save → then pair-switch. Reasoning: the freshly-picked-then-immediately-pair-switch flow is unusual and the lazy-fetch parallel to the FEAT-32 base-suggestion pattern wasn't worth the added complexity for v1.
2. **`SlotEditorSheetProps.onSave` signature widened to an options object.** Plan called for an additional positional arg (`optimisticPairedRecipe`). In code: replaced the existing `optimisticRecipe?` positional with an options bag `{ optimisticRecipe?, optimisticPairedRecipe? }`. The planner-page caller updated to match. Same data flow, less argument-list growth — `chefChip` (FEAT-33 sibling work, see open follow-ups) and any future per-update sub-object plug in by name.
3. **`PlanSlotRecipe` extended in addition to the new sub-object.** Plan added `pairedRecipe` on `PlanSlot`; in code `planSlotRecipeSchema` also grew `pairedRecipeId` so the optimistic two-tap-assign path can preserve it on the cached `recipe` field, and so the visibility gate doesn't depend on the FK round-trip via `state.recipe`. Trivial schema additive; one extra column in the planner-side select.

### Implementation details worth carrying

- **`pairedRecipe` projection covers `{ id, name, imageUrl, isBase, baseRecipeId, baseServings, isDeleted }`** — the superset of what the editor needs (`baseServings` for the servings default, `isBase` for any future "is this a base?" checks, `imageUrl` so the slot card can later render a paired-thumbnail hint). Adding the columns now means future consumers (FEAT-36 aggregation walking pair links, anything that wants the pair's image on the editor) don't need a schema bump.
- **Pair-switch fires through the existing `slots.update` procedure** — no new mutation. The procedure already validates pickability on recipe-FK changes (`assertRecipeAssignable`), so the switch path enjoys the same household + soft-deleted defence-in-depth without an extra check.
- **Optimistic side-channel pattern extended** — `useOptimisticSlotUpdate` now holds two refs (`pendingOptimisticRecipe`, `pendingOptimisticPaired`). `undefined` on the paired ref means "no opinion — reuse the existing sub-object if the recipe FK is unchanged"; `null` means "no pair on this recipe". The distinction matters: a servings-only edit shouldn't blink off the affordance, and a non-recipe state-change shouldn't keep stale paired data live.
- **`resolveExistingPaired`** mirrors `resolveExistingRecipe` — when the caller doesn't pass an `optimisticPairedRecipe` and the recipe FK is unchanged, reuse the cached sub-object. The two together preserve the slot's pair affordance across in-place edits while letting a recipe change clear it.
- **Pair-switch `onSave` payload builds the optimistic recipe + paired sub-object from the slot's existing `recipe` and `pairedRecipe`** — both directions are known at click time without any extra fetch. The new optimistic `pairedRecipe.baseServings` falls back to `1` because the surviving (former) pair side's `baseServings` isn't carried on `PlanSlotRecipe`; the field is essentially write-only here, and the next switch would re-read the freshly-settled row.
- **No new dependencies, no migration.** All FK columns already existed on `recipes` from FEAT-11 / FEAT-23; the only data-shape changes are additive zod fields + a third aliased LEFT JOIN in two slot-select sites.
- **No new domain error code.** Pair switch is a recipe-FK change through `slots.update`; existing `SLOT_RECIPE_*` codes cover the failure modes.
- **`PairSwitchButton` is purely presentational** — no tRPC, no state. It accepts `currentIsBatchVersion`, `pairedRecipeName`, `disabled`, and `onClick`; the editor sheet owns the visibility logic and payload construction.

### Open follow-ups

- **Lazy-fetch the freshly-picked recipe's pair** if the "pick → immediately pair-switch (before save)" flow turns out to matter. Parallel to the FEAT-32 base-suggestion pattern: gated `trpc.recipes.get.useQuery({ id: state.recipe.pairedRecipeId })`, fall back to `slot.pairedRecipe` when `state.recipe === null`. Cheap to add later if user feedback surfaces it.
- **Run the backend Testcontainers suites** on a Docker-enabled box. The only assertion that needed updating was `plans-procedures.test.ts:467` for the new `pairedRecipeId: null` on the recipe sub-object; the schema additions are purely additive so other suites should pass. Carry the FEAT-32-era Colima env-var workaround.
- **Manual smoke** of: pair two recipes in the editor, assign one to a slot, open the editor, observe the button + label, click → slot card shows the sibling with `paired.baseServings`. Then soft-delete one of the pair and confirm the affordance hides on the surviving member.
- **Slot-card thumbnail for the paired sibling** — the `pairedRecipe.imageUrl` column is projected but not yet rendered anywhere. Could plug into the slot card as a small "switch to ↔" affordance if the editor-sheet flow proves too slow. Not in v1 scope.
- **`chefChip` content slot on the slot card is still unfilled** — FEAT-33's spec was the pair-switch button (editor-side), but the original FEAT-31 plan reserved `chefChip` for a future iteration that surfaces the assigned chef on the card. If a later FEAT picks it up, plug in via the existing `SlotCellProps.chefChip` extension slot — no rewrite needed.

### What did NOT change

- DB schema for `recipes` / `meal_plan_slots` unchanged — only additive projection.
- `slots.update`'s "edit in place" gate semantics unchanged — recipe-FK re-validation already covers the pair-switch path.
- `useOptimisticSlotUpdate`'s public interface gained one optional arg; existing callers continue to work without changes.
- `SlotCellProps` unchanged.
- `pickable-recipes` helper unchanged.
- No new dependencies, no new migration, no `withTransaction` calls, no `dangerouslySetInnerHTML`, no `eslint-disable`.
- No FEAT-N strings in code, test filenames, or `describe()` blocks — feedback pin holds.

### Known limitations / not in scope

- **Pair switch on a freshly-picked-but-not-yet-saved recipe** — see the drift note above. Save first, then switch.
- **Pair-switch button on the slot card itself** — editor-only, per the FEAT-33 file list. The card's `chefChip` slot is the next obvious affordance hook.
- **Concurrent pair-symmetry break during the optimistic window** — if a second client renames the paired recipe between the click and the settle, the editor reverts to the server-canonical sub-object on settle. LWW (DEC-36) holds.

---

## 2026-06-17 — FEAT-32 (Base cooking on slots: model fields, editor, card rendering, soft warning)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Frontend: 205/205 passing (31 test files) — 7 new in `slot-editor-sheet.test.tsx`, +1 in `slot-cell.test.tsx`, fixtures updated in `use-optimistic-slot-update.test.ts` and `planner-page.test.tsx` for the wider DTOs. Backend: 396/396 passing across 17 files via Testcontainers (Colima socket workaround: `DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). New `batch-supply.test.ts` (7 cases for `hasBaseSupply`); `slots-procedures.test.ts` grew 8 new tests for the base-cook surface (round-trip, clear, joint-set refine, non-base / cross-household / deleted-base rejections, edit-in-place when the base is later soft-deleted, non-recipe-slot defence); one assertion in `plans-procedures.test.ts` updated for the new `recipe.baseRecipeId` field. DoD boxes in `docs/feature-specs.md §FEAT-32` left unticked — human action. Manual gate (batch-version meal → suggestion hint shows linked base; click apply; save; card renders two lines; remove base cook upstream → warning re-appears) is owed by the human.

### Decisions taken at kick-off

- **Suggestion UX is an explicit hint button, not a pre-fill.** The FEAT-32 spec's "must not auto-set; it's a hint" wording is most faithfully expressed as a `Suggested: <name> — use this?` button beside an empty picker. Click → fetches the base recipe via `recipes.get` and populates both the picker and the base-servings input (defaulted from `recipe.baseServings`). Opt-in, not opt-out.
- **Base-cook fields restricted to `slot_type='recipe'`** at both the input schema refine and the procedure layer. The DB joint-set CHECK is unconditional, but cooking a base on an `eat_out` slot is nonsensical for the v1 mental model. Defence in depth: the input schema rejects with a clear refine message before the procedure even loads the slot.
- **Warning lives backend + frontend, with `OCCASION_ORDER` as the shared source of truth.** Backend `hasBaseSupply` SQL helper is the reusable predicate for FEAT-36 (aggregation) and FEAT-41 (plant-points). For the planner UI's per-slot warning the frontend computes it client-side from the already-loaded `plans.get` data — no extra round-trip, no extra cache entry. Both consume `shared/src/lib/occasion-order.ts`'s `OCCASION_ORDER = { Lunch: 0, Dinner: 1 }` so a third occasion drops in once in one file.
- **Occasion ordering hardcoded as a constant**, not a DB column. Spec's common-gotcha note already flags this: "if a future occasion (breakfast?) is added, the ordering needs an explicit column." A `display_order` column on `meal_occasions` is the upgrade path; for two occasions the constant is cheaper and equally correct.
- **`SLOT_BASE_*` domain error codes (three new)** ride the existing `domainErrorCauseSchema`: `SLOT_BASE_CROSS_HOUSEHOLD`, `SLOT_BASE_NOT_PICKABLE`, `SLOT_BASE_NOT_BASE`. Same shape as the existing `SLOT_RECIPE_*` codes from FEAT-30.

### Drift from kick-off plan

1. **Added `PlanSlot.cooksBaseRecipe` (id + name + isDeleted) to the slot DTO.** Kick-off plan added `recipe.baseRecipeId` (so the UI can detect a batch-version meal) but didn't call out a separate "cooked-base name" carrier. The slot card needs the base recipe's *name* to render "Cook base: Y (×M)" and a "(deleted)" suffix when the base was soft-deleted post-assignment. Solution: new `planSlotCookedBaseSchema` ({ id, name, isDeleted }) projected via an aliased `LEFT JOIN` in both `selectPlanSlots` and `selectSlotById`. No constraint change; one extra projection per slot read.
2. **Suggestion hint fetches via `recipes.get`, not a new thin `getHeader`.** Kick-off plan flagged this as "to verify in implementation, fallback OK." `recipes.get` already returns the full `Recipe` shape including `baseServings`, which the apply-suggestion path uses to default the base-servings input. No new procedure added.
3. **`useOptimisticSlotUpdate` extended in place.** Not a drift exactly — the kick-off plan said the hook would "pass through unchanged because base-cook fields ride along" — but the optimistic `applySlotPatch` had to grow two assignments (cook-base FK + servings) and a small `cooksBaseRecipe` preservation rule (preserve when the FK is unchanged, null otherwise; server-returned slot replaces on settle). The hook's public interface didn't change.

### Implementation details worth carrying

- **`hasBaseSupply` semantics.** "Earlier-or-same" = (date < target) OR (date = target AND occasion order ≤ target's order) OR (same slot id; self-supply). Backend SQL mirrors the JS `OCCASION_ORDER` map via an inline `CASE name WHEN 'Lunch' THEN 0 WHEN 'Dinner' THEN 1 ELSE 999`. Returns `{ hasSupply, earliestSupplySlotId? }`; ordered ascending by (date, occasion order, id) so the earliest supply is deterministic when multiple slots cook the base.
- **Frontend warning derivation is O(plan-slot²) per render** — acceptable for plans capped at 14 days × 2 occasions × 1 meal = 28 slots. Memoised on `planQuery.data`. Returns a `Set<number>` of warning slot ids consumed by both the grid (per-slot `baseCookLine`) and the editor sheet (`hasBaseSupply` prop).
- **Slot card extension via `baseCookLine` slot, not `SlotCellProps` widening.** Cross-cutting #14 is honoured: the planner-grid composes the line (cook info + optional warning) and passes the node into the existing prop. `SlotCellProps` is unchanged; FEAT-33's `chefChip` will plug in the same way.
- **Editor sheet's `EditorState` grew `baseRecipe` (id + name) and `baseServings` (string).** Initialised from `slot.cooksBaseRecipe` on open; the picker's value uses a `minimalRecipeListItem` stand-in (same trick as the meal-recipe picker) so the combobox renders the current selection without a full bank fetch.
- **Editor's warning visibility** depends on three predicates: (a) the eating recipe is a batch-version (its `baseRecipeId !== null`), (b) the editor's local `baseRecipe` is null (user hasn't applied the suggestion or picked one), (c) the parent says supply is missing (`hasBaseSupply` prop). All three must hold for the warning to render. Adding the base inside the editor immediately silences it via predicate (b); saving without a base keeps it on the card via (c).
- **Pickable-recipes helper unchanged.** Base picker calls `recipes.list` with `{ isBase: true, includePickerHidden: true }` — both options were already in `pickableRecipesWhere` from FEAT-23.
- **`assertRecipeIsBase` mirrors `assertRecipeAssignable`** — same household + not-deleted checks, plus the `is_base = true` assertion. Re-validation only fires on FK change (`input.cooksBaseRecipeId !== existing.cooksBaseRecipeId`), preserving DEC-21 historical-render coherence: a slot whose base was later soft-deleted can still have its base-servings edited without re-validating the FK.
- **`loadHouseholdSlot` extended** to return existing `cooksBaseRecipeId` so the "changed?" gate has the same shape as the existing `recipeId` gate. Single extra column in the select.
- **No new dependencies, no migration.** All columns already existed from earlier feature work (DB joint-set CHECK has been in place since the original meal-plans migration). Frontend `BatchWarning` component is plain Tailwind + a Unicode warning glyph; no icon library added.

### Open follow-ups

- **FEAT-33 (pair switch) lands `<PairSwitchButton />` on the editor sheet** and `chefChip` on the slot card via the same content-slot pattern. After a pair switch the batch-supply warning may suddenly appear or disappear (spec's "correct behaviour, not a bug" note) — that's already handled by the per-render derivation; nothing extra needed in FEAT-33.
- **FEAT-36 (aggregation) consumes `hasBaseSupply` differently** — it'll likely walk all slots and sum cook-base servings against the consumers of each base. Today's helper is single-slot-anchored; aggregation may want a "list all base-cook supplies in a plan" variant. Don't extend the helper signature pre-emptively; let FEAT-36 spec it.
- **FEAT-41 (plant-points)** wants the same "earlier-or-same" predicate to attribute the plant-points of a cooked base to its consuming meals across the same date or earlier. Same helper, different aggregation. The shared `OCCASION_ORDER` is the contract.
- **If a third meal occasion lands (Breakfast),** update `MEAL_OCCASIONS` in `backend/src/db/seeds/reference.ts`, `OCCASION_ORDER` in `shared/src/lib/occasion-order.ts`, and the SQL `CASE` in `backend/src/lib/batch-supply.ts`. Three files in lockstep. Alternative: promote to a `display_order` column on `meal_occasions` and read it everywhere — worth the migration when occasions become non-linear or user-editable.
- **Backend Testcontainers needed the now-familiar Colima workaround** to run in this dev environment. Carry the env vars when running future backend integration tests locally.

### What did NOT change

- DB schema for `meal_plan_slots` unchanged; columns + joint-set CHECK already existed.
- `slots.update`'s "edit in place" gate semantics unchanged — re-validation still scoped to "the FK is changing".
- `useOptimisticSlotUpdate`'s public interface unchanged; `applySlotPatch` extended but no new hook shape.
- `SlotCellProps` unchanged; the cell still has `baseCookLine`/`chefChip`/`commentLine` extension slots — FEAT-32 fills the first, FEAT-33 fills the second.
- `pickable-recipes` helper unchanged.
- No new domain error category — three new codes ride the existing `domainErrorCauseSchema`.
- No new dependencies; no new migration; no `withTransaction` calls.
- No FEAT-N strings in code, test filenames, or `describe()` blocks — feedback pin holds.

### Known limitations / not in scope

- **Pair switch UI** — FEAT-33.
- **Aggregated shopping list view** — FEAT-36.
- **Plant-points display on the planner** — FEAT-41.
- **Multi-occasion ordering** — Lunch < Dinner hardcoded; a third occasion needs the three-file update above or a `display_order` column.

---

## 2026-06-15 — FEAT-31 (Meal Planner UI: Recipe Bank + Grid + click-to-assign)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` all clean across the three workspaces. Frontend: 197/197 passing (30 test files); new coverage in `date-utils.test.ts` (16), `use-optimistic-slot-update.test.ts` (5), `slot-cell.test.tsx` (4), `recipe-bank.test.tsx` (7), `planner-page.test.tsx` (6). Backend non-container suites pass (58/58); the 11 Testcontainers suites — including the `listHouseholdMembers` tests in `user-procedures.test.ts` — couldn't launch in this environment ("Could not find a working container runtime strategy"); needs the Colima socket workaround on the next dev box. DoD boxes in `docs/feature-specs.md §FEAT-31` left unticked — human action. Manual gate (open a plan, two-tap assign, edit, switch state, clear; soft-delete a recipe in another tab and confirm historical render survives) is owed by the human.

### Decisions taken at kick-off

- **Chef dropdown sourced via a thin `user.listHouseholdMembers` procedure.** Single-household MVP (DEC-17) means every auth user is implicitly a member; the procedure just `select … from users order by name`. Forward-compatible with future invites without changing the wire shape. Chose this over (a) deferring the control entirely or (b) hardcoding `[ctx.user]` on the client — the procedure path means the editor's chef select is a real control from v1.
- **Recipe Bank uses `useInfiniteQuery`**, not first-page-only. `recipes.list` already paginates by `(lower(name), id)` keyset; the sidebar just consumes pages on demand. Search input filters the same query.
- **Frontend `date-utils.ts` is a parallel module, not a `/shared` promotion.** DEC-80 keeps `/shared` runtime-leaf, with the AppRouter as the one type-only exception; promoting the backend date-utils would have been more invasive. Both sides carry the same Europe/London civil-day contract; if they drift, it's a one-file delta to reconcile.
- **No shadcn `Drawer` / `vaul`.** Plan called for it; in implementation I reused the already-installed Radix `Dialog`, positioned as a bottom sheet on small screens via Tailwind classes (`bottom-0` + `rounded-t-lg` on mobile, centred on `sm:`). AGENTS.md treats new deps as a stop-and-ask trigger and the existing primitive covers the modal pattern. The touch-first UX is preserved without the dependency.
- **`user.listHouseholdMembers` lives on the existing `user` router, not a new `users` router.** The kick-off plan said `procedures/users.ts`; in code I added the procedure to `procedures/user.ts` alongside `getMe` / `updateProfile`. Avoids two near-identical routers and keeps the root router barrel unchanged.
- **Page body lives at `routes/-components/planner-page.tsx`, not under `routes/_authed/plans/-components/`.** Followed the existing project convention (every page body sits in the one flat `routes/-components/` directory next to `recipes-page.tsx`); planner sub-components live under `components/planner/`. Route file stays a thin shell exporting only `Route` with the search-param validator (AGENTS.md route trap).

### Drift from kick-off plan

1. **Skipped the `shadcn Drawer` install.** Plan: install vaul + add the Drawer component. Code: reused the existing `Dialog`. Reason in the decisions above.
2. **`users` procedure collapsed into existing `user` router.** Plan called for `users.listHouseholdMembers`; in code it's `user.listHouseholdMembers`. Trivial rename, but worth recording for downstream FEAT-32 / FEAT-33 docs that may reference it.
3. **`routes/_authed/plans/-components/` directory not created.** Page bodies follow the project's flat `routes/-components/` convention; planner sub-components went to `components/planner/`. Same net result, matches the codebase pattern.

### Implementation details worth carrying

- **`useOptimisticSlotUpdate` is the canonical hook** (cross-cutting #7). `onMutate` snapshots the previous `plans.get` cache, applies the patch (including the optimistic recipe sub-object), and stores the snapshot in the context. `onError` restores the snapshot. `onSettled` calls `setQueryData` with the server-returned slot — no `invalidate()` — encoding DEC-36 LWW: the server response is canonical. A concurrent edit on another client surfaces on the next `plans.get` mount, not via a refetch storm.
- **Side-channel for the optimistic recipe.** `mutate(input)` only forwards the input to `onMutate`; the preview `PlanSlotRecipe` (typically picked from the bank) goes through a ref (`pendingOptimisticRecipe`). Mutations are user-driven and sequential, so a ref is enough — no overlap between `update(...)` and the adjacent `onMutate` runtime. Two test cases exercise the contract.
- **Slot card has explicit content slots** (cross-cutting #14): `baseCookLine`, `chefChip`, `commentLine` props. FEAT-32 fills `baseCookLine`; FEAT-33 fills `chefChip`. The base body owns name/servings/state label; deleted-recipe hint is in-band on the recipe name span.
- **Planner grid is a CSS grid with `display: contents` rows.** `gridTemplateColumns` is computed from the occasion count (`minmax(6rem, max-content) repeat(N, minmax(10rem, 1fr))`). Row headers (`formatDayLabel`) sit on the left; column headers along the top. Slots are looked up by `(date, occasionId)` from a Map built once per render.
- **`clampRange` collapses correctly when search params are outside the plan.** Returns `null` when `start > end`; the page renders a tiny status message rather than the empty grid. The TanStack search-param schema rejects `start > end` upstream, so the only way to hit `null` here is a plan that's been shrunk to a single day with the URL still pointing at a wider range.
- **`recipes.list` infinite-query input always carries `includePickerHidden: true`** — soft-deleted recipes and batch-versions of deleted bases never appear in the bank. Verified by `recipe-bank.test.tsx`: the test asserts the first call's input.
- **Slot editor's recipe combobox uses `utils.recipes.list.fetch`** (imperative tRPC fetch on every keystroke, debounced inside `SearchableCombobox`) rather than a `useQuery` watcher. Reuses the existing combobox primitive verbatim (cross-cutting #6); no per-picker fork.
- **Bottom-sheet styling via Tailwind responsive classes**, not a separate component. `bottom-0 max-w-none rounded-t-lg rounded-b-none sm:bottom-auto sm:top-[50%] sm:translate-y-[-50%] sm:max-w-lg sm:rounded-lg`. Easy to swap to vaul later without touching the editor's interaction code.

### Open follow-ups

- **Run the new backend Testcontainers tests** (`user-procedures.test.ts` `describe('listHouseholdMembers', …)`) on a Docker-enabled box before considering FEAT-31 truly green. Three assertions: seeded user round-trip, name-ordered listing with extra users, unauthenticated rejection.
- **Manual smoke** of the URL search-param flow — drag `?start` and `?end` in the location bar and confirm the grid re-renders without remounting the editor or losing the bank's scroll position.
- **FEAT-32 will extend `slot-cell.tsx` via the `baseCookLine` prop** and the slot editor with `cooksBaseRecipeId` / `cooksBaseServings` controls. The cell's content-slot shape is the contract; don't add a second editor or fork the cell.
- **FEAT-33 (chef) will fill `chefChip`** on the slot card and may consider whether `user.listHouseholdMembers` should grow filtering (e.g. exclude tombstoned users). For now it returns all `users` rows.
- **A separate frontend `date-utils` carries the duplication risk DEC-33 was meant to prevent.** If the backend / frontend implementations drift on Europe/London civil-day semantics, a `/shared/src/util/` promotion becomes the cleanup — flag, don't pre-optimise.
- **AGENTS.md trap addition candidate:** "Adding `vaul` / a second drawer primitive when shadcn `Dialog` already covers the case." The Dialog-as-bottom-sheet pattern landed here; revisit if a future FEAT genuinely needs the swipe-to-dismiss behaviour vaul provides.

### What did NOT change (carry from earlier notes)

- `meal_plan_slots` / `meal_plans` schemas unchanged. No migration.
- `slots.update` procedure unchanged from FEAT-30 — the planner UI consumes it as-is.
- `recipes.list` and `pickableRecipesWhere` unchanged — bank passes `includePickerHidden: true`.
- `plans.get` unchanged — already returns plan + hydrated `slots` in the shape the planner needs.
- No `withTransaction` calls added; no new domain error codes; no new dependencies.
- No FEAT-N strings in code, test filenames, or `describe()` blocks — feedback pin holds.

### Known limitations / not in scope

- **Base-cook fields** (`cooks_base_recipe_id`, `cooks_base_servings`) — surfaced in FEAT-32. The slot editor doesn't expose them yet.
- **Plant-points display on the planner** — FEAT-41.
- **Aggregated shopping list view** — FEAT-36 onwards.
- **Drag-and-drop slot assignment** — explicitly excluded (DEC-52); click-to-assign only.

---

## 2026-06-15 — FEAT-30 (Slot procedures — recipe only)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean. Backend: 20/20 in the new `slots-procedures.test.ts`; 71/71 in `plans-procedures.test.ts` + `meal-plans-schema.test.ts` (no regressions from the new `comment` column). Testcontainers ran via the now-familiar Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). DoD boxes in `docs/feature-specs.md §FEAT-30` left unticked — human action.

### Decisions taken at kick-off

- **Add the `comment` column on FEAT-30**, despite the kick-off proposal to defer. The FEAT-30 spec input lists `comment?` and FEAT-31's editor sheet expects it; the migration is a one-liner (`ALTER TABLE meal_plan_slots ADD COLUMN comment text`), nullable, no default. FEAT-29's duplicate already had a placeholder TODO; that landed in this commit too.
- **Full-replace input semantics, not patch.** Caller declares the desired final state of every editable field on the slot (`slotType`, `recipeId`, `numberOfServings`, `chefUserId`, `comment`). Two Zod `refine`s encode the biconditional `slotType === 'recipe' ⇔ recipeId !== null && numberOfServings !== null`, mirroring the DB CHECK constraints so the procedure returns a clean domain error before the write. Simpler than threading "omitted = unchanged" through the procedure, and matches the FEAT-31 editor-sheet save model (save = whole form).
- **"Edit in place" gate is `recipeId === existing.recipeId`.** Pickability is only re-checked when the assignment is *changing*. A slot whose recipe was soft-deleted after assignment keeps working: servings/comment/chef can be edited; only switching to a *different* (soft-deleted) recipe is rejected. Test coverage on both branches.
- **`empty` clears chef + comment too.** Schema doesn't force it — it's the caller's responsibility — but the UI will pass `null` for both when transitioning to empty, and the procedure writes what comes in. Coherent reading of "empty = nothing assigned".
- **`chefUserId` validity = exists in `users`.** Single-household MVP (DEC-17) has no membership table; the FK already enforces SET NULL on user delete (DEC-29). Procedure-layer existence check returns a typed domain error (`SLOT_CHEF_NOT_FOUND`) rather than letting the DB FK throw.
- **`cooks_base_*` deliberately untouched here** (FEAT-32 territory). Procedure never reads or writes those columns; new test asserts pre-existing values survive transitions in case any prior fixture set them.
- **`SLOT_COMMENT_MAX_LENGTH = 2000`**, matching `RECIPE_COMMENT_MAX_LENGTH`. Untighter limit not explicitly requested; mirroring the recipe-comment cap keeps the constant easy to reason about.
- **File path follows the existing `trpc/procedures/` convention**, not the spec's `trpc/routers/slots.ts`. Same pattern as every other router file in the repo; the spec wording predates the directory layout convergence.

### Drift from kick-off plan

1. **Schema change scope expanded** to add `meal_plan_slots.comment text` — initially proposed dropping the `comment` field from FEAT-30 until a separate migration. User vetoed; column added inline.
2. **Domain error code list grew by four** (`SLOT_NOT_FOUND`, `SLOT_RECIPE_NOT_PICKABLE`, `SLOT_RECIPE_CROSS_HOUSEHOLD`, `SLOT_CHEF_NOT_FOUND`). All thread through the existing `domainErrorCauseSchema` (DEC-35) — no new error machinery.
3. **`plans.duplicate` updated to copy `comment`** alongside the six fields it already carries. This is the FEAT-29 follow-up that was left as a TODO in last session's notes; FEAT-30's column landing was the natural moment to clear it.

### Implementation details worth carrying

- **Household scope via plan join, not a slot column.** `meal_plan_slots` has no `household_id` — scope flows through `plan_id → meal_plans.household_id`. The `loadHouseholdSlot` helper does the inner-join + scoped WHERE in one go and returns `NOT_FOUND` (`SLOT_NOT_FOUND`) on miss; cross-household isolation is identical to the existing pattern in `plans.get`.
- **No `withTransaction`.** Reads-then-single-UPDATE — the cross-cutting #4 rule applies to multi-statement *writes*. A read followed by one mutating statement is allowed to skip the wrapper.
- **Single UPDATE writes all five mutable columns**; the schema refines guarantee coherence before the SQL runs. DB CHECK constraints are the defence-in-depth layer if the refines ever drift.
- **Re-select returns the full `PlanSlot` DTO.** Mirrors `selectPlanSlots` in `plans.ts` but for a single slot — gives the FEAT-31 optimistic-update hook a server-confirmed row to swap into the cache without re-fetching the whole plan.
- **`assertRecipeAssignable` reads `householdId` + `isDeleted` in one query** and returns a cross-household error before the deleted check, so callers can't probe deletion state of foreign-household recipes. Same isolation discipline as the rest of the surface.
- **Recipe pickability check skipped on edit-in-place** by comparing input `recipeId` to the slot's *existing* `recipeId`. The compare happens against the DB row loaded for scope validation, so no extra round-trip.

### Open follow-ups

- **FEAT-31 will need a slot-editor sheet that drives this procedure.** The full-replace input shape is friendly to a form-submit; the editor just collects the five fields and posts.
- **`SLOT_COMMENT_MAX_LENGTH = 2000`** is a sensible default but isn't backed by a DEC. If field-usage patterns suggest a tighter cap (e.g. 200 chars for one-line "use the big pan" hints), revisit.
- **`assertUserExists` does an existence-only check.** If we ever care that the chef belongs to *this* household (true multi-tenancy), this is the one site that needs widening — the FK alone won't catch it because users aren't yet scoped to a household.

---

## 2026-06-15 — FEAT-29 (Plan duplication)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint` clean across all three workspaces. Backend: 41/41 in `plans-procedures.test.ts` (33 pre-existing + 8 new for `duplicate`); 19/19 in `date-utils.test.ts` (14 pre-existing + 5 new for `addDays`); 354/354 backend-wide. Testcontainers ran via the Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). DoD boxes in `docs/feature-specs.md §FEAT-29` left unticked — human action. Manual gate (duplicate a populated plan; new plan shows identical assignments offset by the date delta) is owed by the human.

### Decisions taken at kick-off

- **Skip `comment` column copy.** The acceptance criterion lists `comment` among the fields to copy, but `meal_plan_slots` has no `comment` column today — that field is introduced by FEAT-30. Copy the six columns that exist (`slot_type`, `recipe_id`, `number_of_servings`, `chef_user_id`, `cooks_base_recipe_id`, `cooks_base_servings`). FEAT-30 will add the one-line addition when the column lands.
- **Return shape mirrors `plans.create`: `{ plan, slotCount }`.** Spec literally said "the new plan id"; the wrapping DTO is a tiny superset, gives the UI the new range + creator without a follow-up `get`, and matches the existing convention.
- **`PLAN_MAX_RANGE_DAYS` recheck skipped.** Source was bounded at create/update time and duration is preserved by definition; a recheck would be defensive but never trigger.
- **No `today` guard on `newStartDate`.** Duplicating *backwards* into the past is unusual but not forbidden; the overlap predicate already exempts past plans (`endDate >= today`), so the behaviour is internally consistent. If a real workflow surfaces where past-target should error, revisit by adding a guard symmetric to `PLAN_PAST_NOT_EDITABLE`.

### Drift from kick-off plan

1. **Added `addDays(date, days)` to `backend/src/lib/date-utils.ts`** — not on the kick-off file list, and `dateUtils` changes are an AGENTS.md stop-and-ask trigger. Justification surfaced during implementation: DEC-33 forbids `new Date()` in domain code, and `newEnd = newStart + duration` plus per-slot date shifting needs a primitive that didn't exist. Inline `Date.UTC` math in the procedure would have violated DEC-33 directly. The helper is small, DST-stable (delegates to the existing `civilDateAt` overflow normalisation), covered by five unit tests, and a natural reuse target for any future "shift a civil day by N" need. Flagged in the post-implementation status; not vetoed.
2. **Transaction-rollback test uses a post-callback throw** rather than mocking `tx.insert` to fail on the second call. Wraps `db.transaction` via `vi.spyOn`, awaits the callback, then throws — same net effect (Postgres `ROLLBACK`), avoids the `any` cast + `eslint-disable` that a mid-insert spy would have needed (each suppression is itself a stop-and-ask trigger). The synthetic-failure intent is preserved: a thrown error inside the transaction callback, asserted to leave zero state behind.

### Implementation details worth carrying

- **Date map via lockstep range walk.** `eachDateInRange(source.startDate, source.endDate)` and `eachDateInRange(newStart, newEnd)` produce same-length arrays in date order; zip them into a `Map<string, Date>` keyed on `formatCivilDate(sourceDate)` for O(1) lookup when shifting each slot. Avoids per-slot arithmetic and keeps all date math inside the helper layer.
- **Single bulk slot insert.** All copied slots go in via one `tx.insert(mealPlanSlots).values(slotValues)` call inside the transaction, returning row ids for the `slotCount`. The slot generator (`generateEmptySlotsForRange`) is *not* called — duplicate already has the complete (date × occasion) coverage from the source, so seeding empties first would be wasted writes.
- **Overlap predicate is identical to `create`'s** (DEC-38): household-scoped, `endDate >= today`, inclusive boundary via `NOT (other.end < new.start OR other.start > new.end)`. No new helper extracted yet — if a third user appears (e.g. an "import plan" surface), lift it into `backend/src/lib/plan-overlap.ts` per FEAT-27's session-note suggestion.
- **Source-slot read is outside the transaction.** Reads are cheap at household scale and the transaction's purpose is the atomic plan + slot *write*. Same shape as `updateRange`'s destructive-shrink pre-flight read.
- **Defence-in-depth `INTERNAL_SERVER_ERROR` on a missed date-map lookup.** The map is built from the exact source range and slots can't land outside it, so the guard never fires — but throwing inside the transaction is the right failure mode if the assumption ever breaks (rolls back the plan insert).
- **Cross-household isolation works for free.** `loadHouseholdPlan` filters by `householdId = CURRENT_HOUSEHOLD_ID`, so duplicating another household's plan returns `NOT_FOUND` — same pattern as `get` / `updateRange` / `delete`.

### What downstream FEATs will consume

- **FEAT-30 (Slot procedures)** adds `comment` to `meal_plan_slots`; when it lands, add `comment: slot.comment` to the `slotValues` map in `plans.duplicate` and a corresponding case to the assignment-fidelity test. Single-line change in each place.
- **FEAT-31 (Planner UI)** will surface duplicate as a button on a past or current plan. Input is just `{ planId, newStartDate }`; on success, the UI navigates to `/plans/$newPlanId` using the returned `plan.id`. `slotCount` is informational (toast: "Duplicated 14 slots").
- **`addDays` is a public dateUtils export** and a candidate for the shopping-list date-range walks and the per-day plant-points aggregation (FEAT-41); reuse instead of reaching for raw arithmetic.

### What did NOT change (carry from earlier notes)

- `meal_plans` / `meal_plan_slots` schemas unchanged. No migration. No new constraints.
- No new dependencies. Existing `drizzle-orm` imports cover everything; `vi` from `vitest` was already available but unused in this test file until now (one new top-level import).
- `withTransaction` unchanged. The duplicate transaction is the third caller after `create` and `updateRange`.
- No frontend code touched — UI lands in FEAT-31. New mutation is exposed on `appRouter` automatically.
- No FEAT-N strings in code, test filenames, or `describe()` blocks — feedback pin holds.

### Open items / known flakes

- **`user-procedures.test.ts:202` `$onUpdate` millisecond flake** still present on wider parallel backend runs; pre-existing, confirmed via the same `git stash` repro path used in earlier sessions. Not in scope for this FEAT.

---

## 2026-06-15 — FEAT-28 (Plan date-range edits) + plan-name removal

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` all clean. Backend: 33/33 in `plans-procedures.test.ts` (17 pre-existing + 16 new); `meal-plans-schema.test.ts` still green after the `name` column drop. Wider backend run reproduces the same pre-existing `$onUpdate` millisecond flake at `user-procedures.test.ts:202` — confirmed via `git stash` against clean `main`, fails the same way; unrelated. Testcontainers ran via the Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). DoD boxes in `docs/feature-specs.md §FEAT-28` left unticked — human action. Manual gate (extend by 3 days; destructive shrink with and without `confirmDestructive`) is owed by the human.

### Decisions taken at kick-off

- **Plans have no `name` column (`docs/design-decisions.md` DEC-83 added).** The kick-off question for FEAT-28 turned into a deeper challenge: is a plan name justified for the UX? Conclusion no, for the single-household MVP — the date range plus DEC-38's overlap rule is a sufficient unique identifier within the active window. Past plans are still distinguishable by date range. Migration `0005_yellow_lilandra.sql` drops the column; `planNameSchema` removed; `createPlanInput` is now `{ startDate, endDate }`. FEAT-27, 29, 31 specs updated. DEC-83 records the revisit trigger (semantic-label need, second user, or sharing surface).
- **Past plans are immutable.** `updateRange` rejects with `BAD_REQUEST` + `cause.code = 'PLAN_PAST_NOT_EDITABLE'` when the *current* plan's `endDate < todayInLondon()`. Not in the FEAT-28 spec literal, but Conor's call during planning: re-planning the same dates from a past period is the FEAT-29 (duplicate) workflow, not a `updateRange` workflow. Same shape as DEC-38's past-plan exemption — the past is read-only.
- **Destructive-shrink confirmation lives in the procedure contract.** `confirmDestructive?: boolean`. Without it, when shrinking would discard any slot with `slot_type <> 'empty'`, the procedure throws `BAD_REQUEST` with `cause = { code: 'PLAN_DESTRUCTIVE_RANGE_CHANGE', slots: [{ id, date, occasionId, slotType, recipeId }] }`. The list of lost slots ships with the error so FEAT-31 can render a confirm dialog without a second round-trip. Pre-flight read is outside the transaction (spec note: household-scale read is cheap); the transaction itself is purely the writes.
- **Set-diff implementation, not "delete all, regenerate".** `eachDateInRange` on the current range and the new range; symmetric date-set diff (compared via `formatCivilDate` strings so set keys are stable). `datesToRemove` → `delete` slots `WHERE plan_id = ? AND date IN (...)`. `datesToAdd` → `generateEmptySlotsForDates(...)`. In-range slots and their assignments are preserved by id. A mixed shrink-one-side / extend-other-side call is a single `withTransaction`.
- **Self-exclusion on the overlap check.** Re-uses `plans.create`'s overlap predicate with one addition: `ne(mealPlans.id, planRow.id)`. A no-op or pure-extend update never reports the plan itself as a conflict.

### Drift from kick-off plan

1. **Plan-name removal landed as a bundled prep, not a separate PR.** The kick-off question was "should `updateRange` also let the user rename?" — which surfaced a deeper question Conor pushed back on ("Can you justify why a plan name is required for the UX?"). The right answer was "no, drop it." DEC-83 captures the rationale; the spec edits and migration ship with the FEAT-28 work because the files overlap heavily (`plans.ts` procedure, `shared/src/schemas/plans.ts`, the test file). One commit, not two.
2. **Helper refactor (`slot-generation.ts`).** Introduced `generateEmptySlotsForDates(tx, planId, dates[], occasionIds)`; `generateEmptySlotsForRange` is now a one-line wrapper that calls `eachDateInRange` then delegates. Anticipated in the kick-off; lands as planned. `plans.create` is functionally unchanged.
3. **Helper extraction inside `plans.ts`.** Extracted `loadHouseholdPlan(db, id)`, `loadOccasionIds(db)`, and `selectPlanSlots(db, planId)` so `get` and `updateRange` share one source of truth for the slot projection (the LEFT JOIN over `recipes` without an `is_deleted` filter — DEC-21). All three helpers take a `DbHandle = NodePgDatabase<Schema> | Tx` so they work inside or outside a transaction.

### Implementation details worth carrying

- **`plans.updateRange` result is structurally identical to `plans.get`'s result.** Same `planSchema.extend({ slots: z.array(planSlotSchema) })` shape. The planner UI (FEAT-31) can use the response to refresh its cached plan view without a follow-up `get`.
- **`PLAN_DESTRUCTIVE_RANGE_CHANGE` cause payload uses `planSlotLossSchema` (`shared/src/schemas/plans.ts`)** — `{ id, date, occasionId, slotType, recipeId }`. Tight shape; what the confirm dialog needs and nothing more. `loose()` on `domainErrorCauseSchema` (FEAT-17) still works — the extra `slots` field passes through.
- **Set diff uses `formatCivilDate` strings as keys.** `eachDateInRange` returns `Date` objects whose identity differs by instance; comparing them in a `Set` would treat `2026-06-15T00:00:00.000Z` as not-equal to a fresh `Date` for the same civil day. Formatting to `YYYY-MM-DD` first normalises the keys.
- **Pre-flight destructive check is `ne(mealPlanSlots.slotType, 'empty')`,** not `inArray(...)` over the non-empty enum values. Cheaper to write, identical result; the enum lives in the DB so there's no risk of an unknown variant slipping past.
- **The `updatedAt` column on `meal_plans` bumps via Drizzle `$onUpdate` (DEC-16)** as a side effect of the `tx.update(mealPlans).set(...)`. No manual `updatedAt: new Date()` write; no trigger. Confirmed by re-reading the schema; the existing `meal-plans-schema.test.ts` `$onUpdate` test still passes.
- **All `name` cleanup in test files preserved test intent.** The list-test's `expect(all.items.map((p) => p.name)).toEqual(['Mine'])` became `expect(all.items.map((p) => p.id)).toEqual([mineId])` — same isolation invariant, different observable column.

### What downstream FEATs will consume

- **FEAT-29 (Plan duplication)** can reuse `loadHouseholdPlan` and `loadOccasionIds` (lifted from `plans.create`/`get`/`updateRange`). Duplication is conceptually "compute an offset, copy slots inside a transaction" — the helper surface is now there.
- **FEAT-31 (Planner UI)** gets two new touchpoints: the `updateRange` mutation and the `PLAN_DESTRUCTIVE_RANGE_CHANGE` confirm-dialog flow. Recommendation: render the dialog from the cause payload directly (lossy slots are described by `date` + `occasionId` + `slotType` + optional `recipeId`; resolve the recipe name via the existing recipe query cache rather than fetching). The shared `useOptimisticSlotUpdate` hook (FEAT-31) won't apply to `updateRange` — it's a plan-level mutation, not a slot-level one. A separate `useUpdatePlanRange` is appropriate.
- **FEAT-51 (`OPERATIONS.md`)** should note migration `0005` drops `meal_plans.name`. Deployment ordering is automatic via Fly `release_command` (DEC-40); no manual step.

### What did NOT change (carry from earlier notes)

- `meal_plan_slots` table is unchanged. No new constraints; the existing biconditional CHECK on `(slot_type = 'recipe') = (recipe_id IS NOT NULL)` (FEAT-12) is what backstops a mistaken `updateRange` that tries to overwrite a slot's type.
- No new dependencies. `inArray` from `drizzle-orm` is the only newly-imported symbol in the procedure file.
- `dateUtils` is unchanged. `eachDateInRange`, `daysBetween`, `parseCivilDate`, `formatCivilDate`, `todayInLondon` all reused as-is.
- No frontend code touched — UI lands in FEAT-31. The new mutation is exposed on `appRouter` automatically.
- No FEAT-N strings in code, test filenames, or `describe()` blocks — feedback pin holds.

### Open items / known flakes

- **`user-procedures.test.ts:202` `bumps updatedAt via $onUpdate` reproducibly fails** with the new `updatedAt` value running 3-10ms *before* the captured initial. Confirmed via `git stash` against clean `main`. Pattern looks like a Postgres `now()` vs JS `Date.now()` precision quirk inside a single fast test run — possibly related to the `clock_timestamp()` vs `statement_timestamp()` distinction or just transaction-clock resolution. Out of scope for this session; worth filing as a separate fixup (probably: capture `now()` from Postgres rather than JS for the "before" timestamp, or relax to `>=`).
- **Past-plan editability is now strictly forbidden by `PLAN_PAST_NOT_EDITABLE`.** If a real workflow surfaces where the user wants to extend a plan that just rolled into "past" (e.g. they didn't finish cooking through it), the current answer is "duplicate forward via FEAT-29." If duplication isn't actually a good answer there, revisit by adding a grace window (e.g. plans whose `endDate >= today - N days` remain editable) or by softening the guard to a warning.

---

## 2026-06-15 — FEAT-27 (Plan procedures: create, list, get, delete)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck` + `pnpm -r lint` clean across all three workspaces. Backend: 31 new tests green — 14 in `date-utils.test.ts`, 17 in `plans-procedures.test.ts`; the existing `meal-plans-schema.test.ts` (30 tests) still passes after the `meal_plans.name` column landed. Testcontainers ran via the Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). A wider parallel backend run again flagged the recurring `$onUpdate` millisecond flake in `user-procedures.test.ts:202` — confirmed pre-existing by re-running the file in isolation against an untouched test source (reproduces, same shape). DoD boxes in `docs/feature-specs.md §FEAT-27` left unticked — human action. Manual gate checks (create today→+6 → see `2 × 7` empty slots; overlap rejection; past-plan exemption; delete then re-create over the same range) are owed by the human.

### Decisions taken at kick-off

- **Hard delete, not soft delete (`docs/design-decisions.md` DEC-82 added).** The FEAT-27 spec wording said `softDelete` + `is_deleted = true`. Nothing in the schema references `meal_plans.id` outside of slots and shopping-list items, both of which cascade. No "restore" UI exists in the spec set. The only argument for tombstoning was reversibility, which doesn't survive scrutiny — FEAT-29 duplicate copies forward, so `past` plans in `list` remain the legitimate "I want last week's plan back" path. Migration cost is zero (no `is_deleted` column added); overlap predicate drops the `is_deleted = false` clause and is cleaner.
- **Inclusive overlap boundary (DEC-38 boundary semantics codified).** A plan ending on D and a new plan starting on D *do* overlap (forbidden). Matches the spec's `NOT (other.end < new.start OR other.start > new.end)` formulation and the session-notes line 917 anticipation. The alternative (touching is allowed via `<=`/`>=`) gives a sharper-edged UX for back-to-back planning but the safer default surfaces a clear `PLAN_DATE_OVERLAP` error that the cook can resolve with a one-day shift.
- **14-day maximum range, not 90.** The spec's "common gotchas" suggested up to 90 to stay inside Postgres parameter limits. The household cadence is 1–2 weeks; 14 keeps the slot-generation bulk insert tiny and is what the cook will hit before the parameter ceiling matters. Surfaced via `PLAN_RANGE_TOO_LONG` with `maxDays: 14` so the UI can render a precise message.
- **`get` returns `recipe: { id, name, imageUrl, isBase, isDeleted } | null` on each slot.** Slim DTO, includes `isDeleted` so the planner UI (FEAT-31) can render a "(deleted)" hint on historical slots whose recipe was soft-deleted post-assignment. Mirrors DEC-21's "historical reads still resolve a soft-deleted recipe" stance.

### Drift from kick-off plan

1. **Added a schema migration (`backend/drizzle/0004_worthless_storm.sql`) and the `meal_plans.name` column.** The plan file said "no migration needed" and "`backend/src/db/schema/meal-plans.ts` — no new column." That was wrong: `meal_plans` was missing the `name` column entirely. `docs/plan.md` line 254 mandates `name varchar NOT NULL`; FEAT-12's acceptance criteria didn't enumerate columns and the column was missed — same shape of omission as the `is_deleted` discussion we already had. Same approval logic applied: the spec-level intent is unambiguous (`createPlanInput.name` was already in the approved schema set), only the table column was missing. Migration is a single `ADD COLUMN ... NOT NULL` against an empty production table (no rows shipped). `backend/test/meal-plans-schema.test.ts`'s `insertPlan` helper + the `$onUpdate` test were updated to supply `name: 'Test Plan'`.
2. **Procedure file path:** `backend/src/trpc/procedures/plans.ts` (matches repo convention), not the spec's `routers/plans.ts`. The repo standardised on `procedures/` post-FEAT-03; the spec text predates that.

### Implementation details worth carrying

- **`todayInLondon()` encoding: UTC-midnight `Date` whose UTC year/month/day equals the Europe/London civil-day parts.** Built via `Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year, month, day }).formatToParts(instant)` → `new Date(Date.UTC(y, m-1, d))`. Compares directly against Drizzle `date({ mode: 'date' })` columns because PostgreSQL's `date` type also round-trips as a UTC-midnight `Date`. No `Temporal`, no `date-fns-tz`, no `new Date()` at call sites outside `date-utils.ts` — pinned by DEC-33. DST coverage: the BST-onset test (`2026-03-29T01:30:00Z → 2026-03-29`) and the late-evening BST roll test (`2026-06-15T23:30:00Z → 2026-06-16`) both pin the civil-day rollover happening at UK midnight, not UTC midnight.
- **Overlap predicate uses the `meal_plans_household_start_date_idx` btree on `(household_id, start_date)`** for the leading `household_id = ? AND end_date >= ?` clause — anticipated by session-notes line 917. The `NOT (other.end < new.start OR other.start > new.end)` sub-clause is unindexed; at household scale (a handful of plans per year) the planner will sequential-scan the candidate set from the index, which is fine. If plan counts grow, consider a `tstzrange` GIST index — but not now.
- **`generateEmptySlotsForRange` builds the (date × occasion) cartesian product in memory and issues one bulk INSERT.** 14 days × N occasions (2 today) is 28 rows; well under any Postgres parameter ceiling. The function takes a `Tx` (not a `Db`) so the caller must wrap it in `withTransaction` — enforced by the type signature, which is the cheapest way to honour cross-cutting #4 without a runtime check.
- **Date round-trip on the wire is `YYYY-MM-DD` strings,** not `Date`. The project doesn't run a tRPC data transformer; a `Date` over the wire would serialise to a full ISO timestamp and lose the civil-day intent. `parseCivilDate` / `formatCivilDate` are the boundary converters. `z.iso.date()` is the Zod input shape.
- **`plans.get` does `LEFT JOIN recipes` without `is_deleted` filter.** Historical slots referencing soft-deleted recipes still render the recipe sub-shape with `isDeleted: true`. The `meal_occasions` join uses `innerJoin` for the occasion name — `meal_occasions` is a reference table that never deletes, so the inner join is safe.
- **`plans.delete` uses a household-scoped `DELETE ... RETURNING`.** A cross-household delete attempt returns zero rows and surfaces `NOT_FOUND`, matching the rest of the codebase's cross-household isolation pattern (no information disclosure about whether the id exists in another household).
- **`createdByUserId` is set from `ctx.user.id` on create and `ON DELETE SET NULL` on the FK** (existing from FEAT-12). Informational only — never an authorisation predicate (DEC-17). The `delete` procedure does not check `createdByUserId` because the spec model is household-shared.

### What downstream FEATs will consume

- **FEAT-28 (Plan date-range edits)** will reuse `dateUtils` (`todayInLondon`, `parseCivilDate`, `formatCivilDate`, `daysBetween`, `eachDateInRange`), `slot-generation` (`generateEmptySlotsForRange` — for the extend half), and the overlap predicate from `plans.create`. The shrink half will need its own helper to compute "slots that fall outside the new range"; consider lifting the overlap predicate into `backend/src/lib/plan-overlap.ts` when FEAT-28 lands so it isn't duplicated across procedures.
- **FEAT-29 (Plan duplication)** uses `eachDateInRange` to walk the source plan's date range and `generateEmptySlotsForRange` to seed the destination (slot assignments then copy in a second pass, all inside one `withTransaction`).
- **FEAT-30 (Slot procedures)** queries against the slots produced here. The `slot_type` enum is in `meal-plans.ts`'s pgEnum; FEAT-30's `update` procedure should switch on it and never write a slot without going through the joint-set CHECK on `(recipe_id, slot_type, number_of_servings)` — already enforced at the DB level by FEAT-12's constraints.
- **FEAT-31 (Planner UI)** gets the slot DTO shape it needs (`PlanSlot` carries `recipe: PlanSlotRecipe | null`). The `Plan` DTO has `createdByUserId` so the UI can render attribution. The `PlanStatus` enum (`active | past | future | all`) is the URL search-param contract per DEC-10.
- **FEAT-37 (Shelf-life warnings)** is the second `dateUtils` consumer — explicitly anticipated by the helper's docstring.
- **FEAT-51 (`OPERATIONS.md`)** should document that `meal_occasions` is seeded with two rows (`Lunch`, `Dinner`) on first migration; `plans.create` returns `INTERNAL_SERVER_ERROR` if the table is empty, indicating a deployment misconfiguration.

### What did NOT change (carry from earlier notes)

- The `meal_plan_slots` table is unchanged. FEAT-12's joint-set CHECK and unique constraints back-stop everything FEAT-27 inserts.
- No new dependencies. `date-utils` uses platform `Intl` only; no `date-fns-tz`, no `Temporal` polyfill.
- No frontend code touched — UI lands in FEAT-31. The `plans` router is wired into `appRouter` so the type surface is available immediately.
- No FEAT-N in code, test filenames, or `describe()` strings — pinned by the saved feedback.

### Open items for downstream FEATs

- The "overlap predicate" lives inline in `plans.create`. FEAT-28 will need it for `updateRange`'s re-check; extract to `backend/src/lib/plan-overlap.ts` then if the surface grows beyond the two call sites.
- `MEAL_OCCASIONS` is seeded with two rows. If a third occasion (e.g. `Breakfast`) is added later, existing plans will *not* retro-fill — only newly-created plans will get the third slot per day. This is fine for v1; if a backfill is ever needed, the migration is `INSERT INTO meal_plan_slots (plan_id, date, occasion_id, slot_type) SELECT p.id, gs::date, :new_occasion_id, 'empty' FROM meal_plans p, generate_series(p.start_date, p.end_date, '1 day') gs;` — but flag it via a kick-off question rather than slipping it into an unrelated FEAT.

---

## 2026-06-15 — FEAT-26 (Related recipes)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck` + `pnpm -r lint` clean across all three workspaces. Frontend: 159/159 tests pass (7 new in `related-recipes.test.tsx`). Backend: `recipes-procedures.test.ts` 117/117 (18 new across `addRelated`, `removeRelated`, `listRelated`). Testcontainers ran via the Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`). A wider parallel backend run flagged the recurring `$onUpdate` millisecond flake in `user-procedures.test.ts:202` — confirmed pre-existing via `git stash` + clean-tree re-run. DoD boxes in `docs/feature-specs.md §FEAT-26` left unticked — human action. Manual gate checks (link A↔B from A; navigate to B and see A; soft-delete B and the link disappears; restore B and it reappears; self-link rejected; duplicate rejected) are owed by the human.

### Decisions taken at kick-off

- **Q1 — No `AlertDialog` confirmation on chip remove.** The remove is cheap to re-do via the combobox, mirrors `unrate`'s direct-action shape. The shadcn `AlertDialog` primitive lives in the codebase now (FEAT-25) but staying out of it here keeps chip removal a single click.
- **Q2 — Self-link surfaces as `BAD_REQUEST` + domain code `RELATED_RECIPE_SELF_LINK`,** not a Zod refinement. Parallel to `RECIPE_BATCH_PAIR_SELF` (FEAT-23). Lets the UI render a specific message via `formatMutationError` rather than a generic Zod validation string.
- **Q3 — Reject `addRelated` / `removeRelated` when the anchor recipe is soft-deleted.** Symmetric with the `otherRecipeId` rule (UI also disables the combobox via `isDisabled`). `listRelated` stays permissive on a soft-deleted anchor so historical reads continue to work — pinned by the "still works for a soft-deleted anchor (historical reads)" test.
- **Q4 — Duplicate detection via `INSERT … ON CONFLICT DO NOTHING RETURNING`** and empty-`RETURNING` translates to `CONFLICT` + `RELATED_RECIPE_DUPLICATE`. Avoids parsing Postgres error codes; one round-trip; mirrors `rate`'s upsert pattern without forcing a duplicate semantics.

### Drift from kick-off plan

1. **Combobox clear via remount-key, not via `setSelected(null)` in `onSuccess`.** The plan called for "store the picked option in local state; on mutation success, set it to null." In practice this didn't clear the combobox's input string. `SearchableCombobox` holds `inputValue` locally and resets it via `useEffect(() => setInputValue(value?.label ?? ''), [value])`. Inside the option-commit event handler, React batches `setSelected(option)` (from `handlePick`) immediately followed by `setSelected(null)` (from `onSuccess`); the committed render still sees `value` going `null → null`, the effect dep array doesn't change, and the input stays on the picked label. The fix is a `resetCount` integer used as a `key={resetCount}` on the combobox — bumping the count on success remounts the primitive with empty internal state. Trade-off: the user loses combobox focus after each add (must click in again). Acceptable for chip-add UX at household scale; if a future picker needs to chain adds without focus loss, `SearchableCombobox` could expose an imperative `clear()` via `useImperativeHandle`.
2. **`assertBothRelatedPickable` is a new helper, not a reuse of `pickableRecipesWhere`.** The plan said "reuse the picker helper for the add pre-check." The `pickableRecipesWhere` helper composes a `WHERE` SQL fragment for a `recipes` query; it's perfect for picker lists but awkward for "validate these two specific ids exist in-household and aren't soft-deleted" because the call site wants a clean `BAD_REQUEST` with a domain code, not a row count. The two-id `inArray` shape pulls both checks into one round-trip and matches the existing `assertRecipeInHousehold` / `assertSourceInHousehold` style already in the file. Same intent as the picker helper (DEC-21 visibility rules), different mechanical fit.
3. **`relatedRecipeItemSchema` is its own narrow DTO** — `{ id, name, imageUrl }` only. The plan implied something `RecipeListItem`-shaped; in practice the chip list only needs the name + a link target, so trimming the DTO keeps the wire payload tiny and avoids dragging `averageRating`, `ratingCount`, `plantPointsCount`, etc. into a context that doesn't use them. Future "richer related-recipe card" surfaces can extend without breaking callers (cross-cutting #9).

### Implementation details worth carrying

- **The CASE-driven `other_id` join in `listRelated` is what avoids a UNION.** Single query: `SELECT … FROM related_recipes rr JOIN recipes r ON r.id = CASE WHEN rr.recipe_one_id = $1 THEN rr.recipe_two_id ELSE rr.recipe_one_id END WHERE (rr.recipe_one_id = $1 OR rr.recipe_two_id = $1) AND r.household_id = $current AND r.is_deleted = false`. DEC-27 lists "Queries on either side need a UNION or a view" as a consequence — the CASE approach is a third option that keeps the read in a single planner step. Ordered by `lower(r.name)` then `r.id` for determinism (same secondary-key trick used in `listComments`).
- **Picker scope filter in the frontend is on `linkedIds` (the related list), not the recipe `id`.** The combobox's `searchQuery` fetches via `utils.recipes.list.fetch({ search, includePickerHidden: true, limit: 10 })` and filters out `recipeId` itself + every id already in the related-list cache. The `linkedIds` set is `useMemo`d off `listQuery.data?.items` so the dependency array of `searchRelated`'s `useCallback` only changes when the link set genuinely changes — keeps the combobox's debounce useEffect from thrashing.
- **`addRelated` normalises to `(min, max)` *after* validating both sides are pickable.** Order matters: the validation step uses the unordered ids the caller passed (an `inArray([recipeId, otherRecipeId])` covers both regardless of magnitude); only the `INSERT` payload is reordered. If validation ran on the normalised pair, a "linking from a recipe in a different household" test couldn't distinguish anchor-side from partner-side without inspecting magnitudes. Pinning both branches explicitly in the test suite caught this on the first run.
- **The household predicate is applied to `recipes.householdId` on the join target in `listRelated`,** not via a pre-flight `assertRecipeInHousehold` on every `recipeOneId` / `recipeTwoId`. The pre-flight is only on the anchor; the join's household check handles the "other side" automatically — soft-deleted or cross-household partners drop out of the join. DEC-17 ("`CURRENT_HOUSEHOLD_ID` is the only authorisation predicate") honoured without a CTE or correlated subquery.
- **`removeRelated` is idempotent on no-op deletes.** Same reasoning as `unrate` (DEC-36 LWW): a parallel tab might have already removed the link; the second click shouldn't 404. Tested via "is a no-op when no link exists" — asserts `resolves.toEqual({ recipeId, otherRecipeId })` rather than `rejects`.
- **`formatMutationError` maps the three new domain codes** (`RELATED_RECIPE_DUPLICATE`, `RELATED_RECIPE_SELF_LINK`, `RELATED_RECIPE_NOT_PICKABLE`) to friendly messages, falling back to `error.message` otherwise. The shape `error.data?.cause?.code` matches how tRPC client errors carry the structured cause through `superjson`-less serialisation (the same shape FEAT-23's batch errors use on the client; not exercised on the UI today but the path is wired).
- **No new index on `related_recipes`.** The existing `related_recipes_two_id_idx` (from FEAT-11) covers the `recipe_two_id = $1` half of the listRelated `OR`; the composite PK covers the `recipe_one_id = $1` half. No `addedAt` / `createdAt` column on the table — DEC-27 explicitly chose the minimal two-column shape, the UI sorts alphabetically rather than chronologically.
- **`recipe-detail-page.test.tsx` got a third mock alongside `RecipeRating` + `RecipeComments`.** `RelatedRecipes` is mocked to a `data-testid="related-recipes-mock"` div carrying `data-recipe-id` and `data-disabled`. Same shape as the FEAT-24 / FEAT-25 mocks — the detail-page test should stay focused on the detail-page concerns, not the related-recipes mutation surface.

### What FEAT-31 / FEAT-35 will consume from here

- **FEAT-31 (Meal Planner UI)** will hit `recipes.list` with `includePickerHidden: true` for the Recipe Bank sidebar; that flag is already exercised here for the related-recipes combobox. The "exclude an id set from the picker" pattern (linkedIds → suggestion filter) is reusable for "exclude already-planned-this-week" if the planner gets that affordance.
- **FEAT-35 (account deletion / tombstoning)** does not need to touch `related_recipes` — the table has no `user_id` columns. The seven-step deletion sequence remains as documented in DEC-29.
- **The `formatMutationError` shape** is the first frontend mapping from a `data.cause.code` to a UI string. If future features need similar mappings, lift this into a shared `lib/format-trpc-error.ts` (currently inline because it has exactly one consumer).

### What did NOT change (carry from earlier notes)

- The `related_recipes` table from FEAT-11 was sufficient as-is — composite PK + CHECK encode symmetry + no self-link + no duplicates without any application-layer help.
- No new `withTransaction` calls — each procedure is a single statement (DEC-27 noted "no application-layer symmetry maintenance" as a positive consequence; that holds end-to-end).
- No new dependencies added. The `SearchableCombobox` primitive (FEAT-21) was reused without a fork (cross-cutting #6). The `AlertDialog` primitive (FEAT-25) is available but unused here per Q1.
- No FEAT-N in code, test filenames, or `describe()` strings — pinned by the saved feedback.

---

## 2026-06-14 — FEAT-25 (Recipe comments)

**Status:** implementation complete; not yet committed at write time. `pnpm -r typecheck` + `pnpm -r lint` clean across all three workspaces. Frontend: 152/152 tests pass (13 new in `recipe-comments.test.tsx`). Backend: `recipes-procedures.test.ts` 99/99 (18 new across `addComment`, `editComment`, `deleteComment`, `listComments`). Testcontainers ran via the Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`). A lone failure observed on a wider parallel run was the pre-existing `$onUpdate` millisecond flake in `user-procedures.test.ts:202` — assertion `1781462528054 > 1781462528076` missed by 22ms under container-startup contention; unrelated to this FEAT. DoD boxes in `docs/feature-specs.md §FEAT-25` left unticked — human action. Manual gate checks (post → edit → see "(edited)" → delete with the AlertDialog confirm; another browser sees the comment but no Edit/Delete buttons) are owed by the human.

### Decisions taken at kick-off

- **Q1 — Inline textarea swap for edits**, not modal. The comment text is replaced in place with a `<textarea>` plus Save / Cancel. Avoids introducing a Dialog layer for a 2-second-job UX.
- **Q2 — "(edited)" suffix when `lastUpdatedAt !== null`.** The schema comment on `recipe_comments` already encoded this intent (nullable column, no `$onUpdate`); the UI honours it.
- **Q3 — shadcn `AlertDialog` for delete confirmation** rather than `window.confirm`. Adds the first AlertDialog primitive to `components/ui/`, plus the `@radix-ui/react-alert-dialog` dependency. Dep was a stop-and-ask trigger; user approved at kick-off — same publisher as the already-trusted `@radix-ui/react-dialog`, ESM-compliant (DEC-01).
- **Q4 — Viewer user id via `useSession()` from `@/lib/auth-client.ts`,** not a prop drilled from the detail page and not a server-side `isMine` field per row. Matches `theme-provider.tsx`'s pattern. `RecipeComments` reads `session.data?.user.id ?? null`; when null, no edit/delete affordances render. Tests mock `useSession` the same way `theme-provider.test.tsx` does (`vi.mock('@/lib/auth-client.ts', () => ({ useSession: vi.fn() }))` + cast).

### Drift from kick-off plan

1. **Timestamps switched from `z.date()` to ISO string (`z.string()`)** during implementation. tRPC has no data transformer configured (no superjson) — `z.date()` validates the server-side return but JSON serialises to an ISO string on the wire, so the client type-checks as `string`. The first typecheck pass surfaced this directly. The project's only other timestamp DTO (`recipe_drafts.lastUpdatedAt`) is a `number` — same root cause, same workaround shape. ISO string here keeps it human-inspectable plus `new Date(s)` parses it directly in the UI. Backend procedures `.toISOString()` the Drizzle row before returning; the `editComment` test asserts `new Date(result.lastUpdatedAt).getTime() > new Date(created.createdAt).getTime()`.
2. **`recipe-detail-page.test.tsx` got a second mock alongside `RecipeRating`.** `RecipeComments` is mocked to a `data-testid="recipe-comments-mock"` div so the detail-page test doesn't have to satisfy the new `trpc.useUtils` + four-procedure mock surface. Mirrors the FEAT-24 pattern.
3. **No optimistic temp-id insert on `addComment`.** Plan called for "invalidate-on-settle" already; reconfirmed during implementation that an optimistic temp-id added edge cases (server-assigned id, server `createdAt`) not worth handling at household scale. Add / edit / delete all just `invalidate({ recipeId })` on settle.

### Implementation details worth carrying

- **`lastUpdatedAt` is set explicitly to `now()` inside `editComment`**, not via Drizzle's `$onUpdate`. `$onUpdate` would fire on INSERT too and the column would never be NULL, defeating the "NULL means never edited" inference the UI relies on. Same shape as FEAT-24's `onConflictDoUpdate` lesson but for a different reason: there it was that `$onUpdate` doesn't fire on conflict-update path; here it's that we deliberately don't want it to fire at all. Both pinned by tests that compare `lastUpdatedAt` against `createdAt`.
- **Author-only authorization is procedure-layer FORBIDDEN, not domain code.** `loadCommentForAuthor` JOINs `recipe_comments` to `recipes` and rejects with `NOT_FOUND` if the comment doesn't exist or its recipe is in another household — same "household NOT_FOUND" facade FEAT-24 used (DEC-17 informs the user nothing). If the row resolves but `comment.userId !== ctx.user.id`, it's `FORBIDDEN`. Differentiates "comment doesn't exist for you" from "comment isn't yours to edit" without leaking cross-household existence. Tests "rejects FORBIDDEN when caller is not the author" and "rejects NOT_FOUND when comment is on a recipe in another household" pin both branches.
- **DTO carries `userId` and `authorName` independently, both nullable.** A tombstoned comment row has both fields NULL (FK is SET NULL, the LEFT JOIN against `users` returns NULL for `name`). The UI's `displayName = comment.authorName ?? '[deleted user]'` ladder works without checking `userId`. The "isMine" check uses `userId === viewerUserId` though — having both fields means future "yours" affordances don't require an extra query.
- **The `listComments` ORDER BY is `desc(createdAt), desc(id)`.** Two comments created in the same `now()` tick would otherwise have undefined order; the secondary id key makes it deterministic. The "newest-first" test now passes inserted rows with explicit `createdAt` deltas; without those deltas the test would have raced.
- **The shadcn AlertDialog primitive is a verbatim port** of the standard shadcn `alert-dialog.tsx` shape — `Root`, `Trigger`, `Portal`, `Overlay`, `Content`, `Header`, `Footer`, `Title`, `Description`, `Action`, `Cancel`. `Action` and `Cancel` apply `buttonVariants()` so the confirm/cancel buttons inherit the project's button styling without duplicating Tailwind classes. The Dialog primitive that already shipped (FEAT-22) is structurally identical apart from `Action` / `Cancel` and the lack of the close-X icon — keeping them as separate components (instead of trying to unify) follows shadcn's own split and the Radix a11y semantics (AlertDialog focuses Cancel by default, traps the user until they make a choice).
- **Comment body uses `whitespace-pre-wrap`** so users who paste a multi-line note keep their breaks. React's default escaping still runs; the "rendered comment text is React-escaped" test inserts `<script>alert(1)</script>` and asserts both the literal text shows up and `container.querySelector('script')` is null. DEC-49 pinned.
- **Composer + edit-textarea both surface a `length / RECIPE_COMMENT_MAX_LENGTH` counter** with the muted-foreground colour flipping to destructive when over. Submit / Save buttons disable on empty-trimmed, over-limit, or pending. The "Post button is disabled when text exceeds the max length" test is slow (~4.5s) because it types 2001 chars via `userEvent` — accepted; not worth replacing with a synthetic `fireEvent.change` since the user-event keystroke loop is the only thing exercising the live counter + disable threshold path together.
- **Edit affordance hides when the row is in edit mode** (`isAuthor && !editOpen`) so the buttons don't double up beneath the textarea. Cancel restores `draft` to the original `comment.comment` then closes the editor; Save validates `trimmed !== comment.comment` so a no-op save is impossible (which would otherwise bump `lastUpdatedAt` and falsely surface "(edited)").
- **No new index added on `recipe_comments`.** The existing `recipe_comments_recipe_id_idx` covers the `WHERE recipe_id = ?` predicate; the `ORDER BY created_at DESC` runs against the few-hundred-rows-max per recipe scope acceptable per the FEAT spec.

### What FEAT-26 / FEAT-35 will consume from here

- **FEAT-26 (related recipes)** is unaffected by comments but the AlertDialog primitive is now available for any future "remove this link?" confirmation if the team decides chips need a confirmation step. Currently planned as a single-click remove per the spec.
- **FEAT-35 (account deletion / tombstoning)** must include `recipe_comments.userId` in its SET-NULL step (DEC-29 already lists it). After the tombstoning lands, the "[deleted user]" rendering in `RecipeComments` becomes manually verifiable — until then the unit test (`returns authorName: null for tombstoned authors` in the backend; `shows [deleted user] when authorName is null` in the frontend) is the only safety net.
- **The Composer / CommentRow split** is intentionally small and not extracted into shared primitives — there's exactly one consumer. If a second textarea-with-counter surface lands (e.g. recipe description editor), revisit.

### What did NOT change (carry from earlier notes)

- The `recipe_comments` table from FEAT-11 was sufficient as-is — no schema or migration work.
- `assertRecipeInHousehold` remains the single household gate for `addComment` and `listComments`. Edit and delete take the more nuanced "load + join + householdId check" path because they don't get `recipeId` directly from the client.
- No new `withTransaction` calls — every procedure is a single statement. The `editComment` path is `read-then-write` but the write itself is atomic and DEC-36 (LWW) makes interleaving acceptable.
- No new dependencies were added beyond `@radix-ui/react-alert-dialog` (approved up front). DEC-01 / cross-cutting #20 honoured (ESM, same publisher as already-trusted `@radix-ui/react-dialog`).

---

## 2026-06-14 — FEAT-24 (Recipe ratings)

**Status:** implementation complete; not yet committed. `pnpm -r typecheck` + `pnpm -r lint` clean. Frontend: 139/139 tests pass (8 new in `recipe-rating.test.tsx`, 4 new in `recipe-detail-page.test.tsx`, 2 new in `recipes-page.test.tsx`). Backend: `recipes-procedures.test.ts` 81/81 (14 new across `rate`, `unrate`, and `list rating aggregate` blocks). Testcontainers ran via the Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock`). DoD boxes in `docs/feature-specs.md §FEAT-24` left unticked — human action. Manual gate checks (rate → refresh → card aggregate updates; clear by clicking the same star; another user sees only their own "yours") are owed by the human.

### Decisions taken at kick-off

- **Q1 — Kept the existing `yourRating` field name** despite the spec saying `ownRating`. The DTO had already shipped under `yourRating` (schema, `RatingAggregate` type, two backend tests, two frontend fixtures). Cross-cutting concern #9 favours DTO stability; renaming would have churned five surfaces without semantic gain.
- **Q2 — Star widget disabled on soft-deleted recipes.** Detail page still renders soft-deleted rows (DEC-21) so past plans can resolve titles, but rating a tombstoned recipe is incoherent. The widget reads `recipe.isDeleted` and disables all five buttons.
- **Q3 — Display average to one decimal place** on both card and detail header. Centralised in `frontend/src/lib/format-rating.ts`.
- **Q4 — Rating chip hidden on cards when `ratingCount === 0`.** No "Not rated" placeholder. The plant-points chip is unconditional and already carries the "always present" role.
- **Q5 — Inline optimistic update on `recipes.get` via `setData`** (not `useOptimisticSlotUpdate` — that's planner-specific, FEAT-31). The rating component owns its `onMutate`/`onError`/`onSettled` against both `rate` and `unrate`; rollback restores the prior `recipes.get` snapshot from context.

### Drift from kick-off plan

1. **`averageRating` + `ratingCount` moved onto `recipeListItemSchema`, not added as separate detail-only fields.** Plan said add to both; cleanest implementation was to put them on the list shape and let `recipeSchema` inherit via `.extend(...)`. The existing `recipeSchema` had them duplicated — removed the duplicates. No external behaviour change.
2. **Added `lib/format-rating.ts`** rather than inlining `toFixed(1)` in two call sites. Tiny DRY, consistent with the existing `format-quantity.ts`.
3. **Backend `list` aggregate uses correlated scalar subqueries, not a LEFT JOIN to a grouped subquery.** Two scalar subqueries (one for `avg`, one for `count`) keyed on `recipe_ratings.recipe_id` are cheaper to write and read at this scale and stay composable with the existing keyset pagination + ORDER BY. The trade-off (re-running the subquery per row) is fine for a ≤60-row page.

### Implementation details worth carrying

- **The `${column}` bare-render trap inside `sql` templates bit again.** First cut wrote `where ${recipeRatings.recipeId} = ${recipes.id}` — Drizzle interpolates column references *bare* inside a `sql` template, and because `recipe_ratings` *also* has an `id` column, the WHERE clause silently resolved to `recipe_ratings.recipe_id = recipe_ratings.id`. The aggregate test caught it ("expected 4, got 5" — average of just the first inserted row). Fix: spell out `recipe_ratings.recipe_id = recipes.id` like `lib/plant-points.ts` does. **Worth carrying:** if a future helper joins a child table to `recipes` via a correlated subquery, *always* fully qualify both sides of the join predicate; the bare-render rule is a project-wide convention codified in the plant-points helper comment but easy to forget.
- **`onConflictDoUpdate` does NOT fire Drizzle's `$onUpdate` callback** — the callback is wired into Drizzle's `.update(...)` builder, not the conflict-update path. `lastUpdatedAt` must be set explicitly in the `set: { ... }` block of the conflict clause. The rate procedure does `lastUpdatedAt: sql\`now()\`` to keep behaviour consistent with `$onUpdate`'s "DB clock" semantics. The "upserts the existing row and advances lastUpdatedAt" test pins this — without the explicit set, the row's timestamp would freeze on first insert.
- **`unrate` is intentionally idempotent.** A missing row is a no-op, not a 404. DEC-36 (LWW, no row-version columns): if a second tab already cleared the rating, the click should still succeed silently. Pinned by the "is idempotent when no rating exists" test.
- **Optimistic average is computed locally in the rating component.** `applyRating(recipe, nextRating)` recomputes `averageRating` + `ratingCount` from the previous (count, average) pair without a server round-trip; the `recipes.get` query gets the patched snapshot via `utils.recipes.get.setData`. Edge cases handled: previous null → new value (incr), previous value → null (decr, may make count zero), previous value → new value (delta only). Same-value clicks short-circuit. Failures roll back via the saved `previous` snapshot.
- **The widget invalidates `recipes.list` on settle** (in addition to `recipes.get` for the detail page). This propagates the new aggregate to the browse-page card without forcing the user to navigate back and forth.
- **Detail-page test mocks the widget to a `<div data-testid>`** instead of mocking trpc mutations inline. Keeps the detail-page test focused on the detail-page concerns (header layout, rating-summary chip, disabled-on-tombstoned propagation); the widget's mutation behaviour is exercised in its own test file.
- **Browse card's "average rating" chip is rendered alongside the plant-points chip, gated on `ratingCount > 0`.** No layout shift when ratings are absent; the row keeps the time + plant-points pair always present.

### What FEAT-25 / FEAT-26 / FEAT-31 will consume from here

- **FEAT-25 (recipe comments)** can mirror the same optimistic-update shape — `setData` against `recipes.get` (or a comment-list query if one's added), `previous`-snapshot rollback, settle-time invalidation. Don't reach for `useOptimisticSlotUpdate`; it's planner-only.
- **FEAT-26 (related recipes)** is unaffected by ratings, but the average-chip render pattern (small `aria-label`'d span, hidden when the value is zero/null) is the established convention for "secondary card facts" — copy it for related-recipe chips if needed.
- **FEAT-31 (slot picker / planner card)** consumes `recipes.list`'s new `averageRating` + `ratingCount`. The fields are non-optional in the DTO (null + 0 when absent), so picker rows can render the chip without conditional fetches.

### What did NOT change (carry from earlier notes)

- The `recipe_ratings` table from FEAT-11 was sufficient as-is — no schema or migration work.
- `recipes.get`'s aggregate path (`loadRatingAggregate`) was untouched; `yourRating` semantics preserved end-to-end.
- `assertRecipeInHousehold` remains the single household gate for both mutations (`recipe_ratings` itself carries no `household_id` per DEC-17's "scope through the parent recipe" pattern).
- No new dependencies (DEC-01 / cross-cutting #20). No `withTransaction` (each mutation is a single statement).

---

## 2026-06-14 — FEAT-23 (Batch cooking model + UI)

**Status:** implementation complete; not yet committed. `pnpm -r typecheck`, `pnpm -r lint` clean across all three workspaces. Frontend: 126/126 tests pass (7 new in `batch-fields.test.tsx`, 2 new in `recipe-edit-page.test.tsx`). Backend: `recipes-procedures.test.ts` 70/70 (21 new), `recipes-schema.test.ts` 32/32. Testcontainers ran via the established Colima socket workaround (`DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`). DoD boxes in `docs/feature-specs.md §FEAT-23` left unticked — human action. Manual gate checks (pair two recipes; soft-delete one; observe the pair affordance hides; restore — the affordance returns) are owed by the human.

### Decisions taken at kick-off

- **Q1 — Single `recipes.setBatchFields` mutation owns the whole batch surface** (`isBase`, `baseRecipeId`, `pairedRecipeId`). Two reasons: marking a recipe as a base often *also* clears `baseRecipeId` (XOR), so coupling them avoids a two-call dance; and putting pair-symmetry in its own surface keeps `updateHeader`'s "reject batch fields" pin from FEAT-20 intact and tested. The procedure refuses an empty input (`refine` on the input schema) — every call represents a real intent.
- **Q2 — `recipes.list` accepts `isBase`.** `pickableRecipesWhere` already had the parameter from FEAT-19's reservation; the list input schema gained the same flag and threads it through. The base picker calls `recipes.list({ isBase: true, includePickerHidden: true })` instead of a bespoke `listBases` query. Composable with search + cursor pagination.
- **Q3 — Partner names + isDeleted denormalised onto `recipeSchema`** via two aliased LEFT JOINs in `recipes.get`. Costs ~nothing per get; avoids a second round-trip on the editor mount to resolve picker labels. New fields: `baseRecipeName`, `baseRecipeIsDeleted`, `pairedRecipeName`, `pairedRecipeIsDeleted` (all nullable; null when the link is null).
- **Q4 — No draft autosave for batch fields.** Pair-symmetry is dangerous to half-save (a partial repair could clobber the partner). The section has an explicit "Save batch fields" button mirroring image-uploader.
- **Q5 — `isBase` toggle lives in `batch-fields.tsx` for edit mode, not in `header-fields.tsx`.** Session-notes 2026-06-13 line 63 had already flagged this; following it kept the header diff/patch logic unchanged. The create page keeps the `isBase` checkbox on `HeaderFields` via `mode === 'create'`.
- **Q6 — Two batch-versions may be paired.** DEC-23 and the CHECKs don't prohibit it; the spec doesn't either. Allowed.

### Drift from kick-off plan

1. **`updateHeader` was not reopened.** Plan listed extending `updateHeader` to accept `isBase`/`baseRecipeId`/`pairedRecipeId`; reality was cleaner to put the whole batch surface on a new procedure. The XOR pre-check and the symmetry transaction belong together — splitting them across two procedures would have meant duplicating the XOR check inside `updateHeader`. The existing `updateHeader` test "rejects unknown header fields" still pins the boundary.
2. **`getBatchFields` not added.** The shape `{ id, isBase, baseRecipeId, pairedRecipeId }` is already returned by `recipes.get`; the editor reads it from there. Avoids a parallel read path.
3. **Pair picker hides when `isBase` is true (user-flagged during gate check).** Original plan kept the pair picker always visible — the FEAT-23 spec only called out hiding the base picker. The user pointed out the semantic problem: a base recipe is a *component* (e.g. "Slow-cooked beans"), not a meal, so it has no full↔batch sibling per DEC-23's pair definition. The picker is now `{!isBase && …}`; ticking the checkbox also clears local pair state, so the save round-trip emits `pairedRecipeId: null` and the symmetry transaction clears both sides. The procedure stays permissive (a base with a pair is still mechanically valid; only the UI refuses to construct one). Carry: when DEC-23 is revisited, decide whether to also reject `is_base=true AND paired_recipe_id IS NOT NULL` at the DB CHECK or procedure layer; today it's UI discipline only.

### Implementation details worth carrying

- **`includePickerHidden` now uses a correlated subquery against the `recipes` table aliased as `base`** — `NOT EXISTS (SELECT 1 FROM recipes AS base WHERE base.id = recipes.base_recipe_id AND base.is_deleted = true)`. The helper produces a single composable WHERE fragment; the alias keeps it usable when callers add their own joins. **Worth carrying:** when FEAT-31 (slot recipe picker) lands, it asks the same helper for the same rule; no second site to update.
- **Aliased self-joins in `recipes.get` use Drizzle's `alias()` from `drizzle-orm/pg-core`** — `alias(recipes, 'base_recipe')` and `alias(recipes, 'paired_recipe')`. Drizzle requires unique aliases per FROM/JOIN; reusing a single `recipesAlias` across both joins fails at runtime. The aliased columns appear in the SELECT untouched (`baseRecipe.name`, `pairedRecipe.isDeleted`) — Drizzle's column resolution stays type-safe.
- **The pair-symmetry transaction reads the new partner's `pairedRecipeId` BEFORE writing self.** If A is being paired with C and C currently points at D, the transaction needs D's id to clear D's back-pointer. Reading C's row first gives us D in a single round-trip; the write phase then issues a batched `UPDATE ... WHERE id IN (B, D) SET paired_recipe_id = NULL` followed by `UPDATE C SET paired_recipe_id = A` and `UPDATE A SET paired_recipe_id = C, ...`. The clearing pass deliberately skips ids equal to `self.id` or the new partner — those rows get overwritten by the forward updates a moment later.
- **Two-row pair set is non-trivially LWW.** Two concurrent users pairing A with B and A with C race on the `UPDATE A` and the `UPDATE C/B`. The project's DEC-36 (LWW per row, no row-version columns) makes this acceptable at household scale; the spec called out FOR UPDATE as an option but the plan defers it. If a future feature observes torn pairs in the wild, the fix is `SELECT … FOR UPDATE` on the three rows touched (self, oldPartnerOfSelf, newPartner) at the top of the transaction.
- **Procedure validation is pre-flight (outside the transaction).** Mirrors `replaceIngredients`. The pickable-base check, pair-in-household check, XOR check, and self-pair check all raise typed domain errors before `withTransaction` opens — the transaction body holds only writes. Cheaper, easier to read, and the domain error UI gets clean messages without round-tripping a CHECK violation.
- **Frontend picker excludes self at the client edge.** `searchBases` / `searchPairs` filter `result.items.filter(row => row.id !== recipeId)` after the network call. The server doesn't know "self"; pushing the rule down would add an `excludeRecipeId` input to `recipes.list` for a single consumer. Worth carrying: if a third consumer needs the same filter, promote it to a server-side input.
- **`BatchFields` resets its local state from props on recipe-id swap** via three `useEffect`s keyed on `initial.isBase`, `baseRecipePartner`, and `pairedRecipePartner`. Same pattern as `HeaderFields`'s `form.reset(defaultValues)` effect. Without it a route swap (FEAT-29 duplicate?) would render with stale state.
- **Soft-deleted partner = read-only chip with "(deleted)" hint above the picker.** Picker control still renders so the user can clear or replace; the hint disappears once they pick a different partner. Confirms DEC-21's "historical references intact" rule on the UI side without forcing the user to re-pair through a dead row.

### What FEAT-31 / FEAT-32 / FEAT-26 will consume from here

- **FEAT-31 (slot editor)** reads `recipes.list({ includePickerHidden: true })` for its main recipe picker — already returns soft-deleted bases hidden + batch-versions-of-deleted-bases hidden.
- **FEAT-32 (base picker for cooked-base)** reads `recipes.list({ isBase: true, includePickerHidden: true })` — same surface as the BatchFields base picker; no second query path.
- **FEAT-26 (related recipes)** can copy the `searchPairs` callback shape (the only difference is the filter — related-recipes excludes existing pairs, batch picker excludes self).

### What did NOT change (carry from earlier notes)

- `updateHeader`'s "rejects unknown header fields" pin still holds — `isBase`/`baseRecipeId`/`pairedRecipeId` are still XOR'd out of the header writable schema.
- `pickableRecipesWhere` is still the only place that knows visibility rules (cross-cutting #5).
- `withTransaction` wraps the multi-statement write (cross-cutting #4) — the procedure constructs a `makeWithTransaction(ctx.db)` and runs the writes inside.

---

## 2026-06-13 — FEAT-22 (Recipe draft autosave)

**Status:** implementation complete; not yet committed (this session commits it). `pnpm -r typecheck`, `pnpm -r lint` clean across all three workspaces. Frontend: 117/117 tests pass (9 new in `use-recipe-draft.test.ts`, 2 new in `recipe-edit-page.test.tsx`, 2 new in `recipe-new-page.test.tsx`). Backend: 230/231 tests pass; 20/20 new tests in `recipe-drafts-procedures.test.ts` green. The single backend failure is the same pre-existing `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` ms-race flake documented in every FEAT-17+ entry — not touched here. Testcontainers ran via the established Colima socket workaround. DoD boxes in `docs/feature-specs.md §FEAT-22` left unticked — human action. Manual gate check (type a draft in browser A, open the same recipe in browser B as the same user, see the draft restored) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **A1 — `/recipes/new` resumes the most-recent new-recipe draft (single UX slot).** Multiple `recipe_id IS NULL` rows can coexist at the DB layer (for FEAT-35 cleanup + cross-device safety) but the UI never surfaces a chooser. The new-recipe page loads `getNewDrafts()[0]` and treats it as "the" pending draft. Simpler than building a drafts list, and matches spec acceptance criteria 6 ("multiple new-recipe drafts persist" — true at DB, not at UX).
- **B1 — On successful section save, strip only that section from the draft.** Each section save (`updateHeader`, `replaceIngredients`, `replaceMethod`) calls `draft.clearSection(key)` after success; the hook removes that key from the fields blob and either writes through the remainder immediately or deletes the row if nothing remains. Preserves still-dirty sections through a partial save — saving the header doesn't wipe in-progress ingredient edits.
- **C2 — `imageUrl` is part of the header autosave blob.** The camera-snap-on-phone case is the highest-value autosave scenario: Cloudinary returns a URL, the URL only lives in React state until the user hits "Save header." Including `imageUrl` in `draftData.fields.header` shrinks the orphan window from "until next manual save" to "until autosave fires" (~1s) and lets a phone upload survive a switch to laptop. No new code path — `HeaderFields` already round-trips `imageUrl` as a header form field, so the autosave grabs it for free.
- **`draftData.fields` is `z.record(z.string(), z.unknown())` server-side.** Envelope (`version`, `fields` bag) validated; field shapes are the editor's contract and robust-parsed on load. Coupling the server schema to every editor field would mean a backend deploy on every editor change. Version-mismatched rows are dropped silently — FEAT-35 will sweep them.

### Drift from kick-off plan

1. **Added `draftId` to `upsertRecipeDraftInputSchema`.** The plan described `upsert({ recipeId, draftData })` only. Mid-implementation realised: Postgres treats NULLs as distinct in the unique index, so `ON CONFLICT (user_id, recipe_id)` never matches for `recipe_id IS NULL`. Without an id-targeted update path, **every keystroke on a new-recipe draft would insert a new row** (60s of typing = 60 rows). Fixed by adding an optional `draftId` to the upsert input: when provided, the procedure does a `WHERE id = ? AND user_id = ?` update (ownership-checked); when absent, falls back to the existing insert (NULL) or ON CONFLICT (non-NULL) paths. The hook captures the returned id on first upsert and replays it on subsequent autosaves, so a single new-recipe row survives the whole edit session. Two new backend tests cover this: "updates the targeted draft when draftId is provided" and "returns NOT_FOUND when draftId belongs to another user." **Worth carrying:** any future "row-keyed-by-NULL" autosave pattern needs the same insert-then-targeted-update dance.
2. **`lastUpdatedAt` returned as epoch ms (number), not a `Date`.** Plan said `Date`. tRPC's wire format doesn't auto-serialize `Date` without a `superjson` transformer, and the link config (`httpBatchLink` at `/api/trpc`) explicitly avoids transformers (cross-cutting #16 — don't reshape the URL contract). Numbers serialize natively, the hook displays "saved Xs ago" off it just as easily. Worth carrying: any new procedure returning a timestamp should pick `number` (ms-since-epoch) or `string` (ISO) over `Date` unless we add a transformer.
3. **Repo convention `procedures/`, not `routers/`.** Spec said `backend/src/trpc/routers/recipe-drafts.ts`; codebase has `procedures/recipes.ts`, `procedures/ingredients.ts`, etc. Followed the repo. Same drift as FEAT-15/16/17/18/19/20.
4. **Editor section components grew optional autosave hooks.** Plan said "wire the editor pages to the hook"; reality required surface-extending three section components so the page could observe their state without owning the form instances:
   - `HeaderFields` got `onValuesChange?: (values) => void` — uses RHF's `form.watch` subscription inside a `useEffect` (returns the unsubscribe).
   - `MethodEditor` got `initialDraftSteps?` + `onStepsChange?` — `useState` initialiser checks `initialDraftSteps` first; a `useEffect([steps, onStepsChange])` emits the snapshot shape `{ instruction }[]`.
   - `IngredientList` got `initialDraftLines?` + `onLinesChange?` — same pattern; snapshot shape `{ ingredient, quantity, prepTypeId }[]` (rowKey/errors stripped). New exported type `IngredientDraftLine`.
   All three are strictly additive props — omit them and the components behave identically to FEAT-21. Test files for the components were not touched.

### Implementation details worth carrying

- **The hook gates editor render on `draft.isReady`.** `MethodEditor` and `IngredientList` use `useState(() => initialDraftLines ?? initialLines.map(toDraft))` — that initialiser only runs on first mount. If the draft query hasn't settled yet, the components mount with server-only state and the draft data never lands. Editor pages show "Loading…" until both `recipes.get` and the draft query resolve, then mount the sections with merged defaults. **Worth carrying:** any future section component that initializes state from props once needs this gating pattern, or it needs a "reset on prop change" effect (HeaderFields has that via `useEffect(() => form.reset(defaultValues), [defaultValues, form])`).
- **The hook's debounce is trailing-edge only, no leading fire.** `queueAutosave` clears any pending timer and schedules a fresh one — first call after a quiet period waits the full debounce (no immediate round-trip on the first keystroke). Cancel-on-unmount via a `useEffect(() => () => cancelPending(), [])` cleanup.
- **`clearSection` writes through immediately when sections remain, deletes the row when not.** After a header save, the hook strips `fields.header`. If `fields.ingredients` or `fields.method` were also queued, it fires a fresh `upsert` with the remainder (no debounce wait) so the next reload sees the correct merged state. If nothing remains it calls `delete` and invalidates the draft queries. **Worth carrying:** if a future surface adds a 4th section, this branch automatically handles it — the only place that knows about section keys is the editor page.
- **Notice + discard is a plain inline banner, not a toast.** Same call as FEAT-21's "Saved." aria-live — no `sonner` dep yet. `<div role="status">` with the message + a `<button onClick={discardDraft}>Discard draft</button>`. If FEAT-23 or beyond brings in a toast lib, the notice can fold into it; for now the inline banner is sufficient.
- **Hook tests use `vi.useFakeTimers()` + `act()`.** First version ran timers outside `act` and produced "state update should be wrapped in act" warnings; wrapping `vi.advanceTimersByTime(...)` in `act(() => ...)` is the pattern. Mock callbacks for `mutate(input, { onSuccess })` need explicit parameter types — the linter's strict-type-checked rules reject untyped destructure on `any`.
- **Backend test suite needed a fresh truncate list.** `recipe-drafts-procedures.test.ts` truncates `recipe_drafts`, `recipes`, `households`, `users`, `sessions`, `accounts`, `verifications` (no ingredients / preparation types / units / categories — drafts don't need them). Saved seed time, kept the test file self-contained. Worth carrying: each new procedures-test file gets its own truncate list tuned to its data needs; don't share with `recipes-procedures.test.ts`'s big list.
- **`@testing-library/react` `renderHook` works without a QueryClient wrapper here** because we mock `@/lib/trpc.ts` at the module boundary — the hook never touches @tanstack/react-query primitives directly. If a future hook reaches past trpc into raw `useQuery`, the test setup needs a `QueryClientProvider`.
- **Filenames and `describe()` strings don't reference "FEAT-22" anywhere.** Memory-pinned rule observed.

### Spec ambiguities resolved here (don't re-litigate)

- **Multiple new-recipe drafts exist at the DB layer but never surface as a chooser.** A1 above. If FEAT-35 cleanup wants to render the list (e.g. "you have 3 unfinished drafts" on account-deletion confirmation), `getNewDrafts` already returns them all.
- **Section save deletes only that section's fields.** B1 above. The hook handles "is the blob now empty? then delete the row" without the editor page needing to know.
- **`imageUrl` is in the draft.** C2 above. Image uploads still go direct to Cloudinary (DEC-50); the autosaved URL is just the form value.

### What FEAT-35 will consume from here

- **`recipeDrafts.getNewDrafts`** already returns all `recipe_id IS NULL` rows for the current user. FEAT-35's account-deletion sequence (DEC-29) needs to delete every draft row before tombstoning the user — `recipeDrafts.delete({ recipeId: null })` removes all NULL drafts in one call, and per-recipe iteration handles the rest. The `users` FK is `onDelete: 'restrict'` precisely so this cleanup is forced to be explicit.
- **Version-mismatched rows are dropped on read but persist in the DB.** A future editor envelope bump (`version: 2`) will leave `version: 1` rows orphaned. FEAT-35's sweep can delete them on the way through; a periodic cleanup could too. For now they're harmless — `getForRecipe` / `getNewDrafts` filter them out.

---

## 2026-06-13 — FEAT-21 (Recipe Editor UI + SearchableCombobox primitive)

**Status:** implementation complete; not yet committed. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Frontend: 100/100 tests pass across 19 files (8 new files, 36 new tests: `searchable-combobox` 8, `header-fields` 6, `ingredient-list` 7, `method-editor` 5, `image-uploader` 3, `recipe-new-page` 2, `recipe-edit-page` 5). Backend: 49/49 recipes-procedures tests pass (5 new — 3 for `recipes.references` + 2 for cross-household source rejection). The whole-workspace backend run had the same pre-existing 1ms-race flake in `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` documented in FEAT-19 / FEAT-20 entries. Testcontainers ran via the established Colima socket workaround. DoD boxes in `docs/feature-specs.md §FEAT-21` left unticked — human action. Manual gate check (create-new-recipe end-to-end with image, appears on browse + detail; edit one field on existing recipe and confirm only that field changes) owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Single Zod resolver across `create` and `edit` modes — the form always carries every header field.** Started by switching the resolver between `createRecipeInputSchema` and `updateRecipeHeaderInputSchema.shape.patch` per mode. Walked it back: in edit mode RHF still has every field populated from server data, so the patch-shape `.refine("Provide at least one field")` is benign. One schema, one shape — and the page does the diff into a patch before calling `updateHeader`. The `isBase` checkbox visibility is the only mode-difference in the form itself.
- **Header diff happens at the page, not the section component.** `HeaderFields` just submits the full `HeaderFormValues`. `recipe-edit-page.tsx` has a `PATCH_KEYS` array + `diffHeader()` that produces the minimal patch. Keeps the section dumb and testable; keeps the diff logic next to the mutation call where it's read together. If the patch is empty the page short-circuits with a "Saved." notice and no network call.
- **Plain aria-live "Saved." instead of a toast library.** Spec said "non-blocking toast"; no `sonner` / `react-hot-toast` in `package.json`. Per-section `<p role="status">Saved.</p>` keyed on a `savedNoticeKey: number` (re-renders on each save). Lighter than adding a dep. Worth carrying: if a second consumer needs cross-section notifications, that's when `sonner` earns its place.
- **Up/down buttons + remove for method reordering, no DnD.** Spec explicitly OK'd this ("full DnD a11y not needed"). Buttons disable at boundaries (`index === 0` for up, `index === steps.length - 1` for down). No new dep.
- **`HeaderFields` accepts `mode: 'create' | 'edit'`; the only gated UI is the `isBase` checkbox.** `isBase` is on `createRecipeInputSchema` but excluded from `updateRecipeHeaderInputSchema.shape.patch`. FEAT-23 will add `isBase` / `baseRecipeId` / `pairedRecipeId` to the edit page via a separate `batch-fields.tsx` component (per the spec), keeping `header-fields.tsx` stable.
- **Server-line errors map by `ingredientId` lookup, not by raw index.** When `replaceIngredients` returns `RECIPE_INGREDIENT_UNIT_MISMATCH` or `RECIPE_INGREDIENT_NOT_FOUND` (cause `{ ingredientId }`), the page finds the matching draft line and surfaces "Wrong unit for this ingredient" or "Ingredient not available" inline. Robust against re-ordering, but assumes one bad line per response (matches the server's pre-flight: throws on first hit). Worth carrying: if the server starts returning *all* bad lines at once, the mapping needs to extend.
- **Quantity stays a string at every layer.** `recipeQuantitySchema` is regex-based; `numeric(10,3)` round-trips as a string out of Postgres; the form binds an `<input type="text" inputMode="decimal">` to a string. No `Number()` coercion → no precision loss → what the user typed is what comes back. The unit display next to the qty input is read-only (from the picked ingredient's `defaultUnitId` / `defaultUnitName`) because of DEC-18.
- **Cloudinary multipart body is built with snake_case keys.** Per the trap documented in FEAT-18 session notes ("snake_case is the wire side; the signature is computed over those exact names"). `image-uploader.test.tsx` asserts each snake_case field is present and that camelCase aliases (`apiKey`, `allowedFormats`) are NOT. Regression test for the most likely client-side mistake.
- **`max_file_size` is NOT signed and NOT sent to Cloudinary.** New trap discovered during gate-check: the first upload returned `401 Invalid Signature` with Cloudinary's error body showing its "String to sign" omitted `max_file_size`. Cloudinary lists `max_file_size` as a documented upload param but it is **Pro-plan-only**; lower-tier accounts strip the param before signature verification, producing a deterministic 401 whenever the server signs over it. **Fix:** removed `max_file_size` from both `signUploadParams` in `backend/src/trpc/procedures/uploads.ts` and the client `FormData` in `image-uploader.tsx`. The cap is enforced **client-side** instead — the credentials still carry `maxFileSize`, and the uploader rejects `file.size > creds.maxFileSize` before opening `fetch`. New test in `image-uploader.test.tsx` asserts (a) `body.get('max_file_size')` is null and (b) the oversized-file path surfaces the inline error and never calls `fetch`. The backend `uploads-procedures.test.ts` "signs the bundle..." test was updated to expect a signature over the four-param set (no `max_file_size`). Worth carrying: **if a future upload param is added, verify Cloudinary's `error.message` "String to sign" matches what the server signed BEFORE relying on it.** Their error body is the source of truth, not the docs.

### Drift from kick-off plan

1. **`recipes.references` opportunistically scopes `recipe_sources` to `CURRENT_HOUSEHOLD_ID`, and `create`/`updateHeader` now reject a foreign-household `sourceId` with `NOT_FOUND`.** Plan flagged it as a confirm-or-defer Q1. I went ahead — it closes the DEC-17 hole called out in this doc (FEAT-18 entry "Open hole: `recipe_sources` cross-household") and the cost was one helper `assertSourceInHousehold` + two extra integration tests. Backend test coverage now seeds a foreign-household source row and asserts it is not returned by `references` AND that `create` / `updateHeader` reject it. If a future feature introduces source CRUD, household-scope is already enforced at the write boundary.
2. **TanStack Router file convention forced a route restructure mid-implementation.** Original plan: `routes/_authed/recipes/$recipeId.edit.tsx` as a sibling to the existing `$recipeId.tsx`. Reality: the dot syntax makes `edit.tsx` a *nested child* of `$recipeId.tsx`, which renders `RecipeDetailPage` with no `<Outlet />` — so visiting `/recipes/:id/edit` matched the route tree but the editor never had anywhere to render. **Fix that worked:** renamed `$recipeId.tsx` → `$recipeId.index.tsx`, updated `createFileRoute('/_authed/recipes/$recipeId/')` (trailing slash now required), updated the `useParams({ from: '/_authed/recipes/$recipeId/' })` literal in `recipe-detail-page.tsx`. Both routes are now siblings under `AuthedRoute`. **Worth carrying as a trap row:** future "sibling routes off a param" pairs (e.g. FEAT-22 draft view at `/recipes/:id/draft`, planner edit views) must use `$param.index.tsx` + `$param.X.tsx`, never `$param.tsx` + `$param.X.tsx`.
3. **Added `@radix-ui/react-popover` dependency.** Stop-and-ask item in the plan; approved via plan approval. Sibling to the existing `@radix-ui/react-dialog`; ESM-native. Used as the listbox portal in `SearchableCombobox` — gives correct positioning + outside-click handling for free. No other consumer yet.
4. **Toast surface decision documented above became "use aria-live instead."** Not a deviation in spirit (acceptance criterion was "non-blocking toast" → "shows a transient confirmation"), but worth flagging since the literal noun changed.

### Implementation details worth carrying

- **`SearchableCombobox` is the cross-cutting #6 primitive.** Generic over `T extends { id: number; label: string }`, parameterised by `searchQuery: (q: string) => Promise<readonly T[]> | readonly T[]`. Debounce default 200ms, override per consumer. Keyboard nav: `ArrowUp`/`ArrowDown` wrap, `Enter` commits, `Escape` closes without committing, mouse-down on options uses `preventDefault` so the input doesn't blur first. Listbox is portalled via Radix Popover with `--radix-popover-trigger-width` matching the input. The `searchQuery` effect only fires when the listbox is `open` AND the debounced query changed; closed→typed-then-blurred does nothing. **First consumer is the ingredient picker in `ingredient-list.tsx`.** Future consumers per the plan: FEAT-23 base + pair pickers, FEAT-26 related-recipes, FEAT-31 slot recipe picker, FEAT-32 base picker. Build them by passing a different `searchQuery` — do not fork.
- **Debounce test had a subtle race.** First version asserted "last call after typing 'Ap' is 'Ap'". Failed intermittently because `waitFor`'s ~50ms poll caught the state mid-debounce. **Pattern that worked:** `await waitFor(() => expect(search).toHaveBeenCalledWith('Ap'))` — wait for the specific call, then assert every recorded call's argument is a prefix of `'Ap'` (no partial-then-undone state). Worth carrying for any future debounced-input test.
- **TanStack file-based routing: `$recipeId.tsx` makes child files nest, not sibling.** Documented above as drift #2. Trap row to add to AGENTS.md (next time it's edited): "Create sibling routes off a path param using `$param.index.tsx` + `$param.foo.tsx`, never `$param.tsx` + `$param.foo.tsx`. The latter nests `foo` inside `$param` and needs an `<Outlet />` to render." Until then, this entry is the only memory of the trap.
- **Header `name` validation comes from the Zod schema, not RHF rules.** The acceptance-criteria test for "empty name surfaces inline" hits `recipeNameSchema`'s `min(1, 'Name is required')` literal. If that string changes in `/shared`, the test breaks loudly — that's the design (one source of truth for the message).
- **`HeaderFormValues` is `CreateRecipeInput` aliased.** Fine because `updateRecipeHeaderInputSchema.shape.patch` is a strict subset (no `isBase`). The page's `diffHeader` only emits keys in the `PATCH_KEYS` array (which excludes `isBase`), so the patch shape stays clean even though the form values type carries the extra field.
- **`HeaderFields` `useEffect(() => form.reset(defaultValues), [defaultValues, form])`** — re-syncs the form when the server data changes after a save (`utils.recipes.get.invalidate` → refetch → new `defaultValues` → form reset → dirty state cleared). Worth carrying: any future RHF-driven section that hydrates from a tRPC query needs this reset effect, otherwise post-save the form keeps showing the user's pre-save state.
- **`recipe-edit-page.tsx` does not use the optimistic-update hook.** Per the kick-off plan: `useOptimisticSlotUpdate` (cross-cutting #7) arrives in FEAT-31, generalised for slot writes. For now: `await mutation.mutateAsync(...)` → `await utils.recipes.get.invalidate({ id })` → success notice. Plain, no rollback machinery. Future drift to watch: if optimistic updates land on header saves (cheap and obvious — header writes are scalar), the hook should be the entry point, not a hand-rolled `onMutate`.
- **`fetchCredentials` in the edit page wraps a disabled-by-default tRPC query (`enabled: false`) + `refetch()` on demand.** The credentials query is a `query` (FEAT-18 session-notes line 135) but should only fire when the user actually picks a file. `useQuery({ enabled: false })` + `refetch()` is the canonical way to do on-demand fetching with full caching semantics in @tanstack/react-query. Worth carrying for any "credential-style" lazy query.
- **Image deletion: `onUploaded(null)` → `updateHeader({ imageUrl: null })`.** No Cloudinary destroy call. Matches the DEC-50 "direct browser → Cloudinary, no backend proxy" stance — the asset stays in the bucket, the recipe just forgets it. Cleanup is a separate cron / cost concern, not an MVP one.
- **Backend test had to insert `recipeSources` via inline `db.insert(...).returning(...)`** (no `insertSource` helper existed). I kept the inserts inline in the new `describe('references')` block + the new cross-household tests; if a future FEAT needs source seeding repeatedly, hoist an `insertSource` to match `insertIngredient` / `insertRecipe`.
- **Test mocks for the edit page are deep.** `vi.hoisted(() => ({...}))` returning ~12 mock fns covering `recipes.get`, `recipes.references`, `recipes.updateHeader` / `replaceIngredients` / `replaceMethod`, `uploads.getRecipeImageCredentials`, `useUtils().recipes.get.invalidate`, `useUtils().ingredients.list.fetch`. Pattern is identical to the existing `recipe-detail-page.test.tsx` mock shape — just more surfaces. If a section is added (FEAT-23 batch-fields, FEAT-22 draft hook), extend this mock map rather than fork the file.
- **Filenames and `describe()` strings don't reference "FEAT-21" anywhere.** Memory-pinned rule observed.

### Spec ambiguities resolved here (don't re-litigate)

- **Source create-on-the-fly: NO for v1.** Sources are picker-only; if `references.sources` is empty the source `<select>` is hidden and recipes save with `sourceId = null` and an optional plain `sourceUrl`. A future source-CRUD FEAT (none currently listed in `docs/feature-specs.md`) would add the create surface.
- **Method step ordering is via up/down buttons, not DnD.** Spec OK'd either; chose up/down for a11y + no new dep.
- **`isBase` toggle only on the new page.** Edit-page batch fields wait for FEAT-23.

### Closes the DEC-17 hole flagged earlier in this doc

Per the FEAT-18 entry's "Open hole: `recipe_sources` cross-household" — `updateHeader` accepted a `sourceId` and let the FK confirm existence without checking household ownership. **Closed in this session** via `assertSourceInHousehold` in `backend/src/trpc/procedures/recipes.ts`, applied in `create` and `updateHeader`. Both have explicit integration tests against a seeded foreign-household source row. Single-household MVP didn't strictly require this, but the discipline is now consistent across all `sourceId`-accepting procedures.

### What FEAT-22 / FEAT-23 / FEAT-26 / FEAT-31 will consume from here

- **FEAT-22 (recipe draft autosave)** plugs `useRecipeDraft` into the editor. Each section already has a clean `defaultValues` + `onSubmit` boundary, so the draft hook can wrap `defaultValues` (merge draft over server) and the submit handlers (delete the draft on success).
- **FEAT-23 (batch model)** adds `frontend/src/components/recipe-editor/batch-fields.tsx` and an `isBase` toggle on the edit page. `HeaderFields` already accepts `mode='edit'`; the batch fields land as a new section component next to it. The base picker is a `SearchableCombobox<RecipeListItem>` with a `searchQuery` filtered to `isBase = true` via the picker helper.
- **FEAT-26 (related recipes)** is another `SearchableCombobox` consumer — same shape, different `searchQuery`.
- **FEAT-31 (slot editor recipe picker)** is another consumer. Worth carrying: each consumer should pass a `searchQuery` that calls a `pickable-recipes` helper variant, never re-implement the "what's pickable?" filter inline.
- **The `recipes.references` shape (`{ units, prepTypes, sources }`)** is now a query the editor relies on; future fields (e.g. categories) extend the shape additively. Don't rename.

---

## 2026-06-13 — FEAT-20 (Recipe write procedures: create, updateHeader, replaceIngredients, replaceMethod, softDelete, restore)

**Status:** implementation complete; not yet committed (this session commits it). `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Backend: 205/206 tests pass (27 new in `recipes-procedures.test.ts`, all green; 44/44 in the recipes file pass). The single failure is the pre-existing `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` millisecond-race flake on `$onUpdate(() => new Date())` granularity — same flake documented in the FEAT-19 entry; not touched by this work. Testcontainers ran via the FEAT-17/18/19 Colima socket workaround: `DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Definition-of-done boxes in `docs/feature-specs.md §FEAT-20` left unticked — human action. The manual gate check (create-edit-delete-restore cycle end-to-end via a probe; soft-deleted recipe still renders in a historical plan context after FEAT-31) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`isBase` accepted on `create` (optional, default `false`); explicitly rejected by `updateHeader`.** Spec listed the `updateHeader` field set as "name, description, image_url, base_servings, macros, time fields, source_id, source_url" — no mention of `isBase` / `baseRecipeId` / `pairedRecipeId`. FEAT-23 owns those: pair-symmetry is a transaction that touches two rows + a XOR check against `is_base`. Allowing `isBase` on create lets a household mark a recipe as a base from the start without bouncing through FEAT-23's editor; allowing it on `updateHeader` would let the user create a state that needs FEAT-23's symmetry handling to clean up. Q2 of the kick-off Ask block; user confirmed.
- **Unit enforcement uses both `unitId` AND `ingredientId` from the client; server validates equality with the ingredient's `default_unit_id`.** Spec line 826 ("per-line `unit_id` must equal the ingredient's `default_unit_id` — otherwise `BAD_REQUEST`") implied clients send `unitId` despite DEC-18's "one unit per ingredient" making it derivable. We took the spec literally because the boundary check is the integrity guarantee — the editor's form validation in FEAT-21 is UX, not authority. A client that drifts out of sync with the ingredient's enforced unit (stale cache, e.g.) gets caught at the procedure boundary instead of silently writing the wrong unit. Q3 of kick-off; user confirmed.
- **Method step numbers are server-authoritative — clients send an ordered `instruction[]`, server numbers them 1..N.** The DB has a `UNIQUE (recipe_id, step_number)`; if clients sent `stepNumber`, a duplicate would surface as a constraint violation instead of a clean re-numbering. The editor (FEAT-21) is "send the list in display order"; the server "writes them in that order with fresh step numbers." Cheaper and safer than per-row diff. Q4 of kick-off; confirmed.
- **`null` clears a nullable column on `updateHeader`; `undefined` leaves it alone.** Mirrors the `ingredients.update` pattern from FEAT-17. The patch schema uses Zod `.partial()` on a base that has explicit `.nullable()` columns, so `null` is a valid client value (typed) and gets written through verbatim. `undefined` keys are absent from the patch object and the per-key `if (patch.X !== undefined)` guard skips them. Q5 of kick-off; confirmed.
- **`softDelete` is unconditional — a base recipe with live batch-versions can still be soft-deleted.** DEC-23 / FEAT-23's picker helper (`includePickerHidden`) is the place that excludes batch-versions-of-deleted-bases from new contexts. FEAT-20 doesn't gate the delete; the visibility consequences are the picker's. Q6 of kick-off; confirmed.
- **`estimatedCostPerServing` is in the `updateHeader` patch set.** Spec's "macros, time fields" list didn't enumerate it but the spirit is "every editable header column." Included to avoid the editor having to round-trip through `create` to set cost. Q7 of kick-off; confirmed.
- **`pairedRecipeId` is *not* accepted as input on any of these procedures.** Spec gotcha line 842 said so explicitly; FEAT-23 owns the pair-symmetry transaction. Confirmed.
- **`withTransaction` constructed inline via `makeWithTransaction(ctx.db)`** in `replaceIngredients` and `replaceMethod`. The alternative was adding `withTransaction` to `AppContext` + decorating it on Fastify + threading it through every test's `makeContext()` — 4 test files would have grown a required field for the second time this quarter (FEAT-18 already added `cloudinary`). Both paths preserve the audit guarantee ("audit-grep for `db.transaction(` should hit only `withTransaction.ts`"), so I chose the smaller-blast-radius option. Worth carrying: if a third procedure-side write needs the helper, *then* it's time to put `withTransaction` on the context.
- **Pre-flight validation outside the transaction.** `replaceIngredients` runs the household + unit checks before opening `withTransaction`. The transaction then only contains the DELETE + INSERT pair, which is the smallest possible critical section. Cheaper read paths stay outside locks; user-visible errors are still raised synchronously.

### Drift from kick-off plan

1. **Added `RECIPE_INGREDIENT_NOT_FOUND` alongside the planned `RECIPE_INGREDIENT_UNIT_MISMATCH`.** Kick-off plan named only the unit-mismatch code. While wiring the household-scope check on the ingredient lookup, I needed a distinct signal for "the line points at an ingredient that doesn't exist or belongs to another household" vs "the unit is wrong." Same `cause`-channel shape, same status (`BAD_REQUEST`); two codes so the editor (FEAT-21) can render distinct error messages. Net add: one item in `DOMAIN_ERROR_CODES`. Not scope creep — it's an error-shape refinement inside the FEAT-20 surface.
2. **Procedure file path: `backend/src/trpc/procedures/recipes.ts`** (spec said `routers/recipes.ts`). Same drift as FEAT-15/16/17/18/19. Codebase convention.
3. **Test count: 27 new tests, vs kick-off plan's "behaviours" listing of ~22.** Extra tests came from idempotency probes on `softDelete` / `restore`, regression guards confirming `list` still hides + `get` still returns a soft-deleted recipe, and an explicit "rejects empty instruction" boundary test. All within the FEAT-20 surface — no new behaviour introduced, just more coverage of stated criteria.

### Implementation details worth carrying

- **`makeWithTransaction(ctx.db)` is a one-line factory** (`(fn) => db.transaction(fn)`); calling it per request is free. The pattern is "construct at call site, never import `db.transaction(...)` directly." If a procedure ends up needing the helper twice in one body, hoist it to a local `const withTransaction = …` so the two calls share. Worth carrying as the procedure-level pattern until a transactional helper layer needs to exist.
- **Drizzle's `quantity: numeric(10,3)` round-trips as a string.** Tests asserted on `'10.000'`, `'200.000'`, `'111.000'` — Postgres pads the trailing zeros to the column's scale. Input regex in the schema is `^\d+(\.\d{1,3})?$` (accept 1–3 decimals); output is the padded form. Same for `estimatedCostPerServing` (`numeric(10,2)`, padded to `.00`). If a future field uses `numeric` and the test asserts on un-padded input strings, the test will fail — pad to scale or compare with `Number(...)`.
- **`updateHeader` returns `{ id }` only.** The procedure is "did the write happen for this id"; callers refetch via `recipes.get` if they need the new state. The `ingredients.update` procedure (FEAT-17) returns the full row; the asymmetry is intentional — recipe header reads are joined (sourceName, plant points), and re-deriving them on every patch is wasteful. Pattern for the editor (FEAT-21): optimistic update via `setQueryData`, fire `updateHeader`, on success invalidate `recipes.get` rather than reading the response.
- **`replaceIngredients` allows the same `ingredientId` twice with different `prepTypeId`.** Tested explicitly. DB has no unique constraint on `(recipe_id, ingredient_id)` for this reason (plan.md line 219). The editor (FEAT-21) needs to mirror this — don't dedupe by ingredient id in the list editor.
- **In-transaction rollback test uses a non-existent `prepTypeId` (99999) to trigger an FK violation *inside* the INSERT.** Pre-flight validates the ingredient FK + unit; to test the rollback path, you need a failure that fires *after* the DELETE has run. `prepTypeId` works because it's optional / unvalidated up front. Worth carrying: if you add pre-flight checks that include prep types, the rollback test will need a different failure vector.
- **`makeContext()` in the test file was NOT extended.** I considered adding `withTransaction` to `AppContext` but chose the inline factory instead (see kick-off decisions); the existing 4 test files' `makeContext` shapes are unchanged. Future read: if FEAT-21+ ever centralises transaction access on the context, those test files will all need one new field.
- **Filenames and `describe()` strings don't reference "FEAT-20" anywhere.** Memory-pinned rule observed.
- **The fixture-update tax from FEAT-18 didn't re-fire this session.** Adding new procedures to `recipesRouter` doesn't change `AppContext` or `Config`, so the test scaffolding stayed identical. Worth carrying as a positive signal: extending an existing router is the cheapest surface to grow.

### Spec ambiguities resolved here (don't re-litigate)

- **`isBase` allowed at create, not at update.** See decisions.
- **`baseRecipeId` and `pairedRecipeId` not in any FEAT-20 input.** See decisions.
- **`estimatedCostPerServing` in the `updateHeader` patch set.** Q7 of kick-off.
- **Unit mismatch is `BAD_REQUEST` with structured `cause`, not `CONFLICT`.** Spec said `BAD_REQUEST` literally; tRPC code + domain code on cause is the FEAT-17 pattern.
- **Method step numbering is server-side 1..N.** Q4 of kick-off.
- **`null` clears, `undefined` skips.** Q5 of kick-off.
- **`softDelete` doesn't check for dependent batch-versions.** Q6 of kick-off; FEAT-23 owns the visibility rule.

### Open items for downstream FEATs

- **FEAT-21 (Recipe Editor UI)** consumes these mutations directly. Section saves: header → `updateHeader`; ingredient list → `replaceIngredients`; method → `replaceMethod`; image upload → Cloudinary direct (FEAT-18) → `updateHeader({ imageUrl })`. The unit enforcement at the procedure boundary is the safety net; the editor's per-line unit display + form validation is the UX. The "discard draft" flow (FEAT-22) needs to know that `replaceIngredients([])` clears the list — same semantics as a saved-empty recipe.
- **FEAT-22 (Recipe draft autosave)** can rely on `recipes.create` returning `{ id }` to flip the draft from `(user, NULL)` keyed to `(user, recipeId)` keyed. The draft's `version` field needs to track the editor's field set; today the FEAT-20 surface is the union of the writable header columns + the two replace lists.
- **FEAT-23 (batch-cooking model)** will extend two surfaces touched here:
  1. Reopen `updateHeader` to accept `isBase` / `baseRecipeId`, and add a parallel "set pairing" procedure (probably `setPairedRecipe`) that owns the symmetry transaction. The XOR CHECK (`NOT (is_base AND base_recipe_id IS NOT NULL)`) will catch malformed combos; the transaction handles the case of repairing A→B as A→C.
  2. The `pickable-recipes` helper's `includePickerHidden` flag becomes operational — soft-deleted bases hide their batch-versions from new pickers.
  - Don't ship FEAT-23 without re-reading the FEAT-20 schema: the writable header shape today *excludes* `isBase`/`baseRecipeId` by design, and the `updateHeader` test pins that rejection. FEAT-23 will reshape both.
- **FEAT-24 (recipe deletion + restore UI)** wires `softDelete` / `restore` to the editor's delete affordance and a "trash"-like view via `recipes.list({ includeDeleted: true })`. No procedure change expected.
- **Open hole: `recipe_sources` cross-household.** `updateHeader` accepts a `sourceId` and lets the FK confirm existence — it does *not* verify the source row belongs to `CURRENT_HOUSEHOLD_ID`. A motivated caller could pin another household's source row to one of their recipes. Low risk in single-household MVP but a real DEC-17 hole. Likely fix: whichever FEAT introduces source management (probably FEAT-21's source picker, or a dedicated source-CRUD FEAT) adds a household scope check. Captured here so it isn't lost; called out at task completion.
- **`addedByUserId` is set on `create` from `ctx.user.id` and never written by `updateHeader`.** That matches DEC-17 ("`addedBy`/`createdBy` are informational — never authorisation predicates"). If a future FEAT thinks it needs to "transfer ownership," it should think hard about whether that's a household-level concern (rejected by DEC-17's single-household scope) before adding a write path.
- **Unit-mismatch domain code is consumable by the editor.** Domain error path: `TRPCError.code === 'BAD_REQUEST'` + `cause.code === 'RECIPE_INGREDIENT_UNIT_MISMATCH'` + `cause.expectedUnitId` / `cause.providedUnitId` / `cause.ingredientId`. FEAT-21's per-line error rendering can read those keys to compose "expected `g`, got `piece`" inline. The `getDomainErrorCode` helper in `lib/domain-error.ts` (FEAT-17) is the entry point.

---

## 2026-06-09 — FEAT-19 (Recipe read procedures + browse view)

**Status:** implementation complete; not yet committed. `pnpm -r typecheck`, `pnpm -r lint` clean across all three workspaces. Frontend: 12 files / 64 tests pass (8 new in `recipes-page.test.tsx`, 4 new in `recipe-detail-page.test.tsx`). Backend: 178/179 tests pass (17 new in `recipes-procedures.test.ts`, all green). The one failing test — `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` — is a pre-existing millisecond-race flake on `$onUpdate(() => new Date())` granularity (not touched by FEAT-19; reproducible by running that file alone). Testcontainers ran via the same Colima socket workaround as FEAT-17/18: `DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Definition-of-done boxes in `docs/feature-specs.md §FEAT-19` left unticked — human action. The manual gate check (load `/recipes` after `pnpm --filter backend seed`, search, click a card, verify `is_deleted = true` row disappears from the list but renders on the detail page) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`recipes.search` folded into `recipes.list`, not a separate procedure.** The FEAT-19 Goal sentence names three procedures (`list`, `get`, `search`); the acceptance criteria describe only two (`list` with a `search?` filter, `get`). One trigram-backed `list` query serves both browse and picker contexts, avoiding a parallel code path that would drift. Captured as Q2 of the kick-off Ask block; user confirmed.
- **`includePickerHidden` accepted on the input schema today as a no-op.** The batch-version-of-soft-deleted-base rule lives in FEAT-23. Defining the flag now means FEAT-23 fills in the rule without reshaping `listRecipesInputSchema` (which is type-exported and consumed across the workspace boundary via `AppRouter`). The helper `pickableRecipesWhere` accepts the option and currently ignores it — `void options.includePickerHidden` documents the intentional skip and prevents an unused-import lint flake.
- **`pickable-recipes` helper exposes a Drizzle WHERE fragment, not a full subquery.** `pickableRecipesWhere(options): SQL` returns an `and(...)` that callers AND into their own WHERE — keeps the helper composable with cursor pagination, search, and any future per-call predicate. Caller still owns `from(recipes)` and the ORDER BY. Worth carrying: when FEAT-23 adds `isBase` and the picker-hidden rule, neither needs the caller's query shape to change.
- **Keyset pagination over `(lower(name), id)`, not offset.** Same ordering as the ORDER BY, so cursor comparison is exact. Cursor shape is `{ lowerName: string; id: number }` — fetch `limit + 1` to learn whether `nextCursor` should be non-null without a second `count(*)` round-trip. UI doesn't surface a page control yet; the wire shape is there so the recipe-bank (FEAT-31) and the slot-editor picker (FEAT-31/32) can grow into it without a procedure version bump. Confirmed at kick-off Q4.
- **Plant-points helper lives in `backend/src/lib/plant-points.ts` and exposes both a correlated SQL fragment and a standalone evaluator.** `recipePlantPointsExpr(outerRecipeIdSql)` for inline use in the list / get SELECT; `selectRecipePlantPoints(db, recipeId)` for tests + one-off reads (and the day/plan composition in FEAT-41 will compose the fragment, not the helper). FEAT-41's traversal layer (batch-version meals + base-cook union + dedup) is *new*; this helper is the building block, kept pure and small per cross-cutting concern #10.
- **Recipe DTO split into `recipeListItemSchema` and `recipeSchema`** in `shared/src/schemas/recipes.ts`. The list shape is what every picker / browse / recipe-bank consumer reads; the detail shape extends it with macros, source name, joined ingredients + method, and rating aggregates. Adding fields is cheap, restructuring is invasive — calling out the boundary now (cross-cutting concern #9) saves the editor (FEAT-21), the planner sidebar (FEAT-31), the related-recipes UI (FEAT-26), the base picker (FEAT-32), and the shopping-list aggregation (FEAT-36) from each redefining their own DTO. `plantPointsCount` lives on the list DTO because it's cheap server-side and useful on cards; ratings stay on `get` only (Q4 of kick-off).
- **Detail read view shipped (`/_authed/recipes/$recipeId`), not stubbed.** Spec said "no editor yet — show a read view or stub". A real read view exercises `recipes.get` end-to-end before FEAT-21 lands; it also surfaces the NOT_FOUND flow against the route. Plain-text everywhere (DEC-49). No rating UI, no edit affordances — FEAT-21/27/29 fill those.
- **Dev fixtures split into `runDevSeeds` so tests keep using `runSeeds` unchanged.** `runSeeds` (household + reference) is what tests share; `runDevSeeds` (sample ingredients + 2 recipes) is invoked only from `scripts/seed.ts`. Tests would have collided on the seeded `Onion` ingredient otherwise (`recipes-schema.test.ts` builds its own `Onion`). Cleaner than gating on `NODE_ENV` inside the seed body.
- **Procedure file path: `backend/src/trpc/procedures/recipes.ts`.** Spec text said `routers/recipes.ts`; same drift as FEAT-15/16/17/18. Followed codebase convention.

### Drift from kick-off plan

1. **Dropped `dateAdded` / `dateLastUpdated` from the DTOs after a typecheck failure.** I drafted both schemas with `z.coerce.date()`, expecting tRPC's default (transformer-free) serializer to round-trip the JS `Date` from Drizzle's `date(mode: 'date')` column. It doesn't — the wire payload is a string, but the Zod output type is `Date`, and the frontend type from `AppRouter` got `Date` while the runtime value was a string. Two fixes were on the table: (a) add a superjson transformer to tRPC (substantive, threads through every procedure + every cache rule) or (b) drop the date fields, since nothing in FEAT-19's surfaces actually uses them. Took (b). If a downstream FEAT needs created/updated timestamps (e.g. the recipe-bank's "recently added" sort) we'll either add a transformer then or type the fields as ISO strings end-to-end (cheaper, narrower change). Avoiding the transformer also keeps the PWA cache (FEAT-42) honest — its rules match on JSON, not superjson envelopes.
2. **Plant-points subquery hit "column reference \"id\" is ambiguous" first.** Inside a `sql` template literal, Drizzle renders column references *bare* (no `table.` prefix), so the join condition `${ingredients.id} = ${recipeIngredients.ingredientId}` became `"id" = "ingredient_id"` — three `id` columns in scope (outer `recipes`, inner `recipe_ingredients`, inner `ingredients`). Fix: spell out `<table>.<column>` literally inside the template, and require the outer-recipe id reference to be a qualified SQL fragment (callers now pass `sql\`recipes.id\``, not `recipes.id`). Captured in a comment on `recipePlantPointsExpr`. Worth carrying: **inside `sql\`...\`` templates, treat Drizzle column references as bare identifiers and qualify them yourself.** This will bite anyone writing correlated subqueries; the safe rule is "if your subquery joins more than one table, every column in the template is a string-literal."
3. **`recipes.list` returns a paginated *result envelope* (`{ items, nextCursor }`) rather than a bare array.** `recipes.list.useQuery` consumers must read `data?.items ?? []`. `ingredients.list` returns a bare array; that asymmetry is intentional (ingredients is small enough not to need cursors and the helper signature would have been overkill) but worth flagging because mental-model spillover is easy.
4. **Nav placement: "Recipes" sits between "Home" and "Ingredients" in `authed-layout.tsx`.** Plan said "between Home and Ingredients"; landed there. No tests on the nav directly — the existing `authed-layout.test.tsx` doesn't exhaustively enumerate links. If we want a regression guard against accidental nav removal, that test is the place — defer until we add a fourth link.

### Implementation details worth carrying

- **Drizzle `count(...)` static type is `number` but runtime is `string` (Postgres bigint).** Casting to `Number(row.count)` trips `@typescript-eslint/no-unnecessary-type-conversion`. The fix is a `sql<number>\`count(...)::int\`` cast at the SQL level, making the runtime value match the static type. The avg() column carries the `string | null` type honestly, so `Number(row.avg)` is fine and lint passes. Pattern worth carrying to any future aggregate procedure.
- **`avg(rating)` returns `string | null` from Drizzle**; `null` when there are no rows. The DTO surfaces `averageRating: number | null` — test "returns null aggregates when there are no ratings" + "aggregates ratings and surfaces the caller's own rating" both pin this behaviour.
- **`yourRating` uses a `max(case when ... then rating end)` over the same aggregate query.** Avoids a second round-trip. Postgres returns the value as a number (since `rating` is `smallint`); the DTO carries it as `1..5 | null`. Tested by inserting two raters and switching the caller via `makeContext({ userId: OTHER_USER_ID })`.
- **The four-way `get` parallel queries (header + ingredients + method + rating aggregate)** are independent; `Promise.all` keeps total latency to the slowest single query. Worth carrying: future write procedures (FEAT-20) won't parallelise like this — they'll use `withTransaction` — but read procedures should default to "fan out independent queries, then assemble."
- **TanStack Router's auto-code-split plugin requires route files under `routes/*.tsx` to export only `Route`.** I created both `recipes/index.tsx` (browse) and `recipes/$recipeId.tsx` (detail) as thin shells; the page components and any future `beforeLoad` live in `routes/-components/`. Re-confirms the AGENTS.md rule.
- **Frontend tests mock `@tanstack/react-router`'s `Link` and `useParams` rather than rendering a real router.** Mirroring this pattern lets the page component tests stay focused on data flow / rendering instead of router setup. Captured in `recipes-page.test.tsx` and `recipe-detail-page.test.tsx`.
- **`TRPCClientError.data?.code` reads as `any` under strict-type-checked ESLint.** Worked around with a small `isNotFoundError(error: unknown)` helper that does the `instanceof` check + a narrow `as { data?: { code?: unknown } }` cast. Same trick the existing `lib/trpc.ts` link uses; lint accepts the typed-cast version but not the inline accessor. If a third surface needs this, fold the helper into `lib/domain-error.ts` (it already houses the related `getDomainErrorCode`).
- **`Number.parseInt` on the route param + a positive-integer guard.** The route is `/recipes/$recipeId` (string param); the procedure expects a positive int. The detail page treats any non-positive-integer param as NOT_FOUND without firing the query (`enabled: idIsValid`). Worth carrying for FEAT-21's editor route (`/recipes/$recipeId/edit`).
- **Filenames and `describe()` strings don't reference "FEAT-19" anywhere.** Memory-pinned rule observed.

### Spec ambiguities resolved here (don't re-litigate)

- **Procedure surface: `list` + `get`** (no separate `search`). See decisions.
- **`includePickerHidden` accepted but no-op until FEAT-23.** See decisions.
- **Detail read view: real route, not a stub.** Q4 of kick-off.
- **Pagination: keyset cursor over `(lower(name), id)`, no UI control yet.** Q4 of kick-off.
- **`plantPointsCount` on the list DTO.** Q4 of kick-off.
- **Dev recipe seed: 2 fixtures (Tomato pasta, Roast chicken with veg).** Q4 of kick-off.
- **Date fields: not on the DTOs** (see drift item 1). Reopen only if a downstream FEAT actually needs them; pair with the superjson decision.

### Open items for downstream FEATs

- **FEAT-20 (write procedures) consumes the same file** — `backend/src/trpc/procedures/recipes.ts`. The spec already says "extends FEAT-19 file." `create`, `updateHeader`, `replaceIngredients`, `replaceMethod`, `softDelete`, `restore` land there; all multi-statement work goes through `withTransaction` per cross-cutting #4. The unit-mismatch boundary check on `replaceIngredients` (per-line `unit_id` must equal the ingredient's `default_unit_id`) is the integrity guarantee — the editor's form validation in FEAT-21 is UX, not authority.
- **FEAT-21 (Recipe Editor) consumes `recipes.get` for hydration** and the FEAT-20 mutations for partial saves. The detail page shipped here renders the same DTO the editor will read — no shape change expected. The image upload flow established in FEAT-18 plugs into `header.imageUrl` via `recipes.updateHeader` (FEAT-20). Direct browser→Cloudinary, then `updateHeader({ imageUrl })` once Cloudinary returns `secure_url`.
- **FEAT-23 (batch-cooking model)** will:
  1. Extend `pickableRecipesWhere` with the batch-version-of-deleted-base rule (use `includePickerHidden`).
  2. Accept the `isBase` parameter on the helper (use the picker for `is_base = true` only).
  3. Possibly add `baseRecipeId` / `pairedRecipeId` aggregates on the list DTO if pickers need them. Today both fields are returned plainly.
- **FEAT-26 (related recipes)** reuses the same picker helper for the "what can I link to?" query — no new helper needed.
- **FEAT-31 (planner sidebar / recipe bank)** consumes `recipes.list` directly. The keyset cursor shape is the contract; if the recipe bank needs a virtualised infinite list, `useInfiniteQuery` over `{ cursor, limit }` is the path. No procedure change expected.
- **FEAT-41 (day + plan plant points)** composes `recipePlantPointsExpr` at the day/plan level with the batch-traversal rules (FEAT-23). Keep this helper pure (no household scoping, no date logic) — that's the contract the day/plan computation relies on.
- **Superjson / date-on-the-wire decision is deferred.** If two downstream FEATs need real `Date` types over the wire (recipe-bank "recently added" sort + planner created-at filter, say), the cheapest change is to type those fields as ISO strings in the DTO and add a single `parseISO()` at the consumer. Adding a transformer to tRPC is a substantive change (every cache rule, every test fixture) and we should defer it until the cost of NOT having it is concrete. Open question; capture before FEAT-31 or FEAT-34.
- **`pickable-recipes` helper has no test file of its own** — its behaviour is exercised through `recipes.list` (includes-deleted and excludes-deleted assertions). If FEAT-23's extensions get gnarly enough, peel out `pickable-recipes.test.ts` and exercise the WHERE in isolation; the helper is small enough today that a procedure-level test is the right tool.

---

## 2026-06-08 — FEAT-18 (Cloudinary signed-upload procedure)

**Status:** implementation complete; commit `d07395e` on `main`. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Backend: 39/39 non-container tests pass (6 new in `cloudinary-sign.test.ts`, 4 new in `uploads-procedures.test.ts`, plus the inherited `config` + `server` suites). The 7 Testcontainer suites didn't run in this session (Colima socket couldn't bind-mount into the Ryuk reaper — same env caveat as FEAT-17's session note); rerun locally with `DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` to confirm no regressions. Definition-of-done boxes in `docs/feature-specs.md §FEAT-18` left unticked — human action. The manual gate check (real `curl` POST to `api.cloudinary.com/v1_1/<cloud>/image/upload` with returned credentials, plus a >5 MB and a `.gif` rejection probe) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Hand-rolled SHA-1 signer over the official `cloudinary` SDK.** The package is CJS-only (no `"type": "module"`, no `exports.import`), which is a DEC-01 stop-and-ask. The signing surface we need is ~15 LOC against Node's `crypto.createHash('sha1')`; pulling in the SDK would buy us upload/admin helpers we don't use and break the ESM-only constraint. The SDK door is still ajar if a later FEAT needs admin operations (asset deletion, transformations), but the signer alone doesn't justify the dep. Captured in the implementation: `backend/src/lib/cloudinary.ts` is dep-free.
- **Cloudinary creds threaded through Fastify `decorate` → `AppContext`, mirroring the `db` pattern.** Second consumer of the decorate-and-augment pattern established in FEAT-16. `app.decorate('cloudinary', { cloudName, apiKey, apiSecret })` in `server.ts`; `req.server.cloudinary` read in `createContext`; `FastifyInstance` + `AppContext` augmented in `trpc/context.ts`. Alternatives considered: (a) lazy `loadConfig()` at module top of `uploads.ts` à la `db/index.ts` — rejected because it makes procedure tests env-var-coupled at import time; (b) router-factory `createUploadsRouter(config)` — rejected because it cascades through every `appRouter` import site. Decoration keeps the test context plain-object-shaped: tests build `AppContext` with mock `cloudinary` and call `appRouter.createCaller(ctx)` exactly as for `db`.
- **Locked constants live in `shared/src/schemas/uploads.ts`, exported as constants AND used as Zod `z.literal()`s.** `RECIPE_IMAGE_FOLDER`, `RECIPE_IMAGE_MAX_FILE_SIZE`, `RECIPE_IMAGE_ALLOWED_FORMATS`, `RECIPE_IMAGE_EAGER_TRANSFORMATION`. The procedure imports the constants to build the signed payload AND the test re-derives the signature using the same constants — so any drift in the locked values breaks the test, not just the wire shape. The schema's `z.literal()` walls mean the frontend can't accidentally claim a wider contract than what's signed.
- **`getRecipeImageCredentials` is a `query`, not a `mutation`.** Side-effect-free at our boundary (no DB write, no external API call) — minting a signed string is pure. Cloudinary considers the credential "used" only when a real upload arrives, and even then the constraint is the `timestamp` window (~1h tolerance), not "single use." Marking it a query also lets TanStack Query auto-refetch on stale (relevant once FEAT-21's editor mounts), which is the desired behaviour: the credentials should be fresh when the user actually clicks "upload."
- **`folder = loftys-larder/recipes` and `eager = c_fill,w_1200,h_900,q_auto,f_auto`.** Folder name is the project slug under Cloudinary's default root; eager transformation pre-generates a 4:3 1200×900 crop with auto quality/format. The eager value is somewhat arbitrary (the spec said "a fixed eager transformation" without dictating dimensions); 4:3 was picked because recipe cards in FEAT-19 will be card-shaped, not square. Changeable later — but the constraint is that **changing the eager value won't retroactively re-derive existing assets**; new uploads only. If the recipe card layout shifts in FEAT-19, decide before users have uploaded enough to make a re-upload painful.
- **No `CLOUDINARY_UPLOAD_PRESET` env var.** The FEAT-18 spec said "or signed params" — we chose signed params. The preset path would put the constraints in the Cloudinary dashboard (operator action, not code); the signed-params path keeps the constraints in the repo and the signing path. Signed params win on transparency; preset wins only if we wanted ops to flip constraints without a deploy, which we don't.
- **Procedure test skips the Testcontainer.** The procedure does zero DB I/O, so spinning up Postgres just to assert auth gating + signature shape would inflate the suite for no signal. The `makeContext` helper still mirrors `user-procedures.test.ts` line-for-line (same session/user shape) — only `db` is `{} as AppContext['db']` since it's never read. Worth carrying: container-free procedure tests are valid when the procedure provably doesn't touch the db; default is still container-backed.

### Drift from kick-off plan

1. **Fixture sprawl: five test files needed CLOUDINARY env vars / context fields added.** `config.test.ts`, `auth.test.ts`, and `server.test.ts` build `Config` literals (now requires three more strings); `user-procedures.test.ts` and `ingredient-procedures.test.ts` build `AppContext` literals (now requires `cloudinary`). Plan listed three test files; reality was five. Mechanical follow-on of adding a required field to `Config` and `AppContext`. Worth recording because every subsequent FEAT that extends either type will pay the same fixture-update tax — if a third consumer of `AppContext` lands (say, a per-request feature flag), consider whether to keep extending the literals or to introduce a `makeAppContext({ overrides })` factory in a shared test helper.
2. **`UNSIGNED_PARAMS` set is the canonical list of exclusions.** Spec only named `file`; Cloudinary's signing rules actually exclude five: `file`, `cloud_name`, `resource_type`, `api_key`, `signature`. The unit test asserts all five are stripped — surfaced during test design, not implementation. Reference: https://cloudinary.com/documentation/signatures. Don't trim this set.
3. **Frontend untouched.** Not drift from the FEAT-18 plan (FEAT-18 is backend-only) but worth flagging: the frontend has no consumer of `appRouter.uploads.*` yet. The `AppRouter` type re-export will pick it up automatically once FEAT-21 lands. No frontend chunk size change expected.

### Implementation details worth carrying

- **Cloudinary signing algorithm, codified.** Take every param the client will POST except `file`, `cloud_name`, `resource_type`, `api_key`, `signature`; sort keys alphabetically; join as `k=v&k=v` (no URL-encoding); append the API secret directly (no separator); SHA-1 hex digest. Reference vector in `cloudinary-sign.test.ts` should survive any future SDK swap.
- **Cloudinary's wire-side param names are snake_case** (`allowed_formats`, `max_file_size`, `folder`, `eager`, `timestamp`) — the signature is computed over those exact names. Our tRPC wire shape is camelCase (`allowedFormats`, `maxFileSize`, …) because that's the project convention (DEC-15). **FEAT-21's frontend uploader must re-snake the field names when building the multipart body** — `formData.append('allowed_formats', allowedFormats.join(','))`, etc. — or the signature will mismatch and Cloudinary will 401 every upload. This is the most likely client-side trap; trap-worthy of an AGENTS.md row once FEAT-21 lands.
- **Cloudinary `timestamp` is Unix seconds at UTC**, not domain time. `Math.floor(Date.now() / 1000)` is the right call. The procedure has a one-line comment explaining why `dateUtils` (Europe/London, DEC-33) doesn't apply — pre-empts the future linter pass that searches for `Date.now()` in backend code.
- **`AppContext` now has a required `cloudinary` field that wasn't there before this FEAT.** Plus the augmented `FastifyInstance`. Any future test scaffolding that constructs an `AppContext` literal must include `cloudinary: { cloudName, apiKey, apiSecret }`. TS catches missed sites at typecheck; the failure mode is `Property 'cloudinary' is missing in type '…' but required in type 'AppContext'`. Don't fix that with `as AppContext` casts — fill the field.
- **`pnpm prettier --write` is the cleanup path after `Write`.** Two newly-written test files tripped `format:check`; one `pnpm prettier --write <files>` fixed both. Husky's `lint-staged` would have caught this at commit time anyway, but pre-commit cycles are slow; run `format:check` proactively after creating files.
- **`z.tuple([z.literal(...), ...])` for `allowedFormats`** locks not just the items but the *count and order*. If a future FEAT adds `avif` or `heic`, the constants AND the schema tuple both need updating in lockstep — that lockstep is the feature, not a maintenance burden.

### Spec ambiguities resolved here (don't re-litigate)

- **"Use Cloudinary's official SDK helper if available" vs hand-rolled** — chose hand-rolled (CJS dep + ESM-only constraint, see decisions).
- **"or signed params" vs `CLOUDINARY_UPLOAD_PRESET`** — chose signed params; no preset env var.
- **Eager transformation value** — fixed at `c_fill,w_1200,h_900,q_auto,f_auto` (see decisions). Revisitable in FEAT-19 if the card layout dictates otherwise; revisitable becomes painful once recipe images accumulate.
- **Folder namespace** — fixed at `loftys-larder/recipes`. If FEAT-21 ever introduces a second image type (e.g. user avatars), use a sibling folder under the same prefix (`loftys-larder/users`) and a sibling procedure (`uploads.getUserImageCredentials`) — don't overload this one.
- **Output procedure type** — `query`, not `mutation` (see decisions).
- **Folder/procedure file name** — `procedures/uploads.ts` (codebase convention) over the spec's `routers/uploads.ts`. Same drift as FEAT-15/16/17.

### Open items for downstream FEATs

- **FEAT-20 will persist `image_url` on the recipe row via `recipes.update`.** Cloudinary's upload response returns `secure_url` (HTTPS-only) — that's the field to store, not `url`. The PWA cache rules (FEAT-42) match `res.cloudinary.com` for `img-src` (DEC-46 CSP already includes it), so served images won't need any further wiring.
- **FEAT-21 (Recipe Editor) consumes `uploads.getRecipeImageCredentials`.** The flow: call the query → POST `multipart/form-data` to `https://api.cloudinary.com/v1_1/<cloudName>/image/upload` with fields `{ file, api_key, timestamp, signature, folder, allowed_formats, max_file_size, eager }` — **snake_case keys** (see implementation note). Cloudinary's response is JSON with `secure_url`; pass that to `recipes.update`. No proxying through the backend (DEC-50). Direct browser → Cloudinary keeps the Fly machine's request-body budget intact.
- **Orphan cleanup is a non-goal in v1** (DEC-50). If a user gets credentials, uploads, then abandons the recipe edit, the asset sits in Cloudinary forever. Free-tier storage covers household-scale; revisit only if Cloudinary's billing or asset-clutter gets visible. If we ever build the cleanup job, it'd be a nightly worker that diffs Cloudinary's asset list against `recipes.image_url` — but it's a non-goal so don't.
- **Better Auth `protectedProcedure` is the only auth surface here.** No rate-limit on credential minting yet. FEAT-46's `@fastify/rate-limit` should cover `uploads.*` alongside the magic-link endpoint — a credential mint isn't expensive, but it costs Cloudinary if a misbehaving client floods uploads, so a modest per-user limit (10/min?) is a defensive default. Not enabled now.
- **`AppContext.cloudinary` is the second consumer of the decorate-and-augment pattern.** If a third arrives (e.g. a feature-flag client, a Sentry-tagged logger, a per-request `dateUtils.now()` injection), consider whether to keep adding to `AppContext` directly or introduce a `services` namespace (`ctx.services.cloudinary`, `ctx.services.flags`, …). At two consumers it's fine flat; at four it'd benefit from grouping. Just don't reach for the namespace until the third consumer makes the case.
- **Operator action before next prod deploy.** Three new env vars are required (no defaults); the next deploy after this PR merges will crashloop without them. Set in Fly:

  ```sh
  flyctl secrets set \
    CLOUDINARY_CLOUD_NAME="<your-cloud-name>" \
    CLOUDINARY_API_KEY="<your-api-key>" \
    CLOUDINARY_API_SECRET="<your-api-secret>" \
    --app loftys-larder-prod
  ```

  Sandbox a separate Cloudinary account for dev/CI — don't share the prod API secret. The free tier gives 25GB storage + 25GB bandwidth/month, easily comfortable for household scale.

---

## 2026-06-08 — FEAT-17 (Ingredient CRUD + Dictionary view)

**Status:** implementation complete; `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean. Frontend tests 52 / 52 (18 new across `ingredients-page`, `ingredient-form`, `domain-error`). Backend tests 151 / 152 — 23 new ingredient-procedure cases all pass; the one failure is the pre-existing `user-procedures > bumps updatedAt via $onUpdate` timing flake, **not** introduced here (recurs across sessions; tracked but not blocking). Definition-of-done boxes in `docs/feature-specs.md §FEAT-17` left unticked — human action. Manual gate check (add → edit → search → delete with `INGREDIENT_IN_USE` surface against an active recipe and again against a soft-deleted recipe) owed by the human; agent cannot drive a browser.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Domain-error mapper lives in `frontend/src/lib/domain-error.ts`, not inside the tRPC link.** Cross-cutting #11 reads "add to the error link a single mapper to a typed UI error." Rewrapping inside the link interferes with TanStack Query's error caching (the cached error shape would diverge from what `mutateAsync` rethrows). The accessor pattern — `getDomainErrorCode(error)` → `DomainErrorCode | null` — gives the same typed surface at the consumer call-site without touching the request pipeline. Form/page consumers branch on the returned code; the link stays a pure transport.
- **Cause shape surfaced via `errorFormatter` in `backend/src/trpc/init.ts`.** Default tRPC strips `cause` from the wire payload. The formatter validates `error.cause` against `domainErrorCauseSchema` and, if it parses, copies it onto `shape.data.cause`. This is the *only* place the cause crosses the boundary; the frontend helper reads from this exact path. If the cause doesn't parse (e.g. accidentally non-domain error), the formatter no-ops and the default shape goes through. Adds zero overhead on the success path.
- **Uniqueness constraint chosen over pre-flight `SELECT`.** `(household_id, lower(name))` `UNIQUE` (migration `0003_glorious_silvermane.sql`). Race-safe by construction; pre-flight check could lose to a concurrent insert. Procedures catch PG SQLSTATE `23505` and translate to `CONFLICT + INGREDIENT_NAME_TAKEN`. Two households can each have an "Onion" — uniqueness scopes to the household, matching DEC-17.
- **Cause-chain walk on PG-error detection.** Drizzle wraps driver errors in `DrizzleQueryError`; the original pg error sits on `.cause`. `isUniqueViolation` walks up to 5 cause levels checking `code === '23505'` + matching `constraint`. Inspecting just the top error misses the wrap and silently falls back to `INTERNAL_SERVER_ERROR`. (Found this in test — first run failed the rename-collision case until the unwrap landed.)
- **In-use check joins `recipe_ingredients` with no `is_deleted` filter on `recipes`.** Soft-deleted recipes still pin the ingredient — past meal plans reference them (DEC-21, cross-cutting #5, #19). Implementation is a single `SELECT 1 FROM recipe_ingredients WHERE ingredient_id = $1 LIMIT 1` — no join needed because `recipe_ingredients` rows can't outlive their recipe under the current FK (restrict on both sides), so any reference at all is a conflict.
- **shadcn `Dialog` (Radix) added as the first Radix dep.** Stop-and-ask threshold cleared because the acceptance criterion explicitly requires "add-new dialog, edit dialog, delete with confirm". Native `<dialog>` + `window.confirm` were considered and rejected: the delete-confirm needs to *keep the dialog open* and re-render with the `INGREDIENT_IN_USE` message inline, which `window.confirm` can't do. One Dialog primitive covers all three use cases; `AlertDialog` was *not* added — the delete dialog is just a `Dialog` with destructive button styling.
- **No shadcn `Select`.** Category + unit dropdowns are native `<select>` styled with Tailwind. Same calculus as FEAT-16's radios: avoid `@radix-ui/react-select` until a FEAT genuinely needs combobox behaviour (FEAT-21's searchable combobox primitive is the right place).
- **Backend procedures live in `procedures/ingredients.ts`, not `routers/ingredients.ts`.** Spec said `routers/` but the project established `procedures/` in FEAT-15/16. Codebase convention wins; if we ever do migrate this directory, one rename PR, not piecemeal.
- **List response is *flat* denormalised** (`{ categoryId, categoryName, defaultUnitId, defaultUnitName, ... }`), not nested. Easier to render in a table, fewer wrapper objects in test assertions. The denormalisation is server-side — a single query with two `innerJoin`s — so the wire payload doesn't pay for it on render.
- **`getDomainErrorCode` reads `error.shape.data.cause` directly.** Could have used `error.data` (the tRPC client mirror of `data`), but `shape` is the canonical envelope. Documenting because it looks like indirection — it isn't.

### Drift from kick-off plan

1. **Added `ingredients.references` query (returns `{ categories, units }`).** Not in the FEAT-17 spec. Form dropdowns need the full list of categories + units; there's no existing reference endpoint. Two options were live: add a separate `references` router (clean but out-of-scope) or bundle into ingredients (small surface, in-scope). Chose the bundle. When FEAT-21 (recipe editor) wants the same data + `preparation_types`, promote to a dedicated `reference` router — that's the right time, not now.
2. **Nav link added in `authed-layout.tsx`.** Layout was a bare `<Outlet />` before; now it renders a top nav with Home / Ingredients / Settings. FEAT-16's session-notes flagged "settings page is URL-only" as an open item — partially closed here, but the proper navigation shell is still owed to a later FEAT (PWA shell or similar). Treat this nav as scaffolding, not the final IA.
3. **Frontend `lib/trpc.ts` not modified.** Spec listed it as a file to touch ("extend the error link to surface domain codes"). The domain-code mapper lives in `lib/domain-error.ts` instead (see kick-off decision). `trpc.ts` keeps the `httpBatchLink` URL shape untouched (cross-cutting #16) and the `unauthorizedRedirectLink` unchanged.
4. **Two test files use non-null array destructuring instead of `!`.** ESLint config forbids `@typescript-eslint/no-non-null-assertion`. Pattern: `const [a, b] = arr; if (!a || !b) throw new Error('seed failed'); …` — works around the rule cleanly and gives a real error message when seeding breaks. Copy this for any future Testcontainers test that needs a known-non-empty `.returning()`.
5. **Form's `nameError` prop is a separate channel from RHF errors.** RHF owns client-side validation; the page-level mutation handler catches `INGREDIENT_NAME_TAKEN` and pushes the message in via a `nameError` prop. The form's `useEffect` calls `form.setError('name', { type: 'server', message })`. This is the pattern for any future form that needs to surface a server-side field-scoped conflict.

### Implementation details worth carrying

- **Pattern for `CURRENT_HOUSEHOLD_ID` scoping established here.** Every read: `eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID)` in the `where` clause. Every write that targets an id: include both `eq(ingredients.id, id)` AND the household clause — that's how cross-household ids get treated as `NOT_FOUND` rather than 200 OK. Copy this exact shape for every domain procedure from FEAT-19 onward. (DEC-17, cross-cutting #3.)
- **`domainConflict(code, message, metadata?)` helper.** Returns a `TRPCError` with `code: 'CONFLICT'` and `cause: { code, ...metadata }`. Five-line helper, but it's the convention for every later domain conflict (`SLOT_OCCUPIED`, `DUPLICATE_PAIRING`, etc.). Lifting to `shared/` would create a cycle; leave it inlined where it's used until a third caller appears.
- **`DOMAIN_ERROR_CODES` is a string-literal `as const` array, paired with a `z.enum(...)` schema.** Adding a new code is a one-line append. Both ends (server `cause.code`, frontend `getDomainErrorCode` return type) update in lockstep because the union flows from the same constant.
- **Test seed: insert categories + units inline per `beforeEach`** rather than calling `seedReference`. Lets the test pin specific IDs (`categoryId`, `otherCategoryId`) for cross-household and rename scenarios. The full `seedReference` would seed nine categories + nine units — overkill, and you'd lose the `[cat0, cat1]` destructure pattern.
- **Search query: lower input in TS, use `sql\`lower(${col}) like ${'%' + lowered + '%'}\``.** Both sides lowered — the `pg_trgm` GIN index hits. Drizzle's `ilike` would technically work but doesn't reuse the lower()-functional index. AGENTS.md "common gotchas" called this out; encoded here.
- **`vi.hoisted` mock pattern carried from FEAT-16.** Six mocks for the ingredients page (`references.useQuery`, `list.useQuery`, three mutations, `useUtils`). The `vi.hoisted` block defines them as constants before `vi.mock` runs; the factory closes over them. Reset all six in `beforeEach`. Pattern scales.
- **Form-level `key={editTarget.id}`** on `IngredientForm` inside the Edit dialog. Without it, switching from edit-A → close → edit-B reuses the form state from A; the `defaultValues` change wouldn't reset the inputs. The `key` forces React to remount the form on target change, picking up the new defaults cleanly.
- **`document.documentElement.classList.toggle('dark', active)`** still applies (carried from FEAT-16); ingredient pages inherit the theme automatically via the top-level `dark:` Tailwind variants. No theme work needed per-page.
- **TanStack Router auto-code-split** emitted `ingredients-*.js` chunk at 43.51 kB gzipped to 14.97 kB. The thin route convention earns its keep again — the page component + RHF + dialog all sit in the lazy chunk; the root bundle is unaffected.

### Spec ambiguities resolved here (don't re-litigate)

- **"Joined to category and default unit (denormalised for the dictionary view)"** — interpreted as flat fields, not nested objects (see kick-off decision).
- **"Cap shelf life"** — spec said "optional positive int"; resolved at 3650 days (~10 years) in `ingredientShelfLifeSchema`. Negotiable if a real use-case appears; 0 and `null` are the meaningful sentinels, the high bound is just a sanity cap.
- **"Establish the cause shape (`{ code: string, ...metadata }`) in FEAT-17"** — codified as `domainErrorCauseSchema = z.object({ code: domainErrorCodeSchema }).loose()`. The `.loose()` (Zod 4 alias of `.passthrough()`) keeps arbitrary metadata travelling alongside the code.
- **"Pickable recipes" helper** — out of scope for FEAT-17; the in-use check doesn't filter on `is_deleted`. The helper lands in FEAT-19 (`backend/src/lib/pickable-recipes.ts`).
- **Backend procedures directory naming** (`procedures/` not `routers/`) — see drift item; already established.

### Open items for downstream FEATs

- **`ingredients.references` will outgrow its router.** When FEAT-21 needs `preparation_types` (and possibly `meal_occasions` for the planner), promote to `procedures/reference.ts` with `reference.categories`, `reference.units`, `reference.preparationTypes`, `reference.mealOccasions`. Keep the bundle endpoint (`reference.all`) for forms that need everything in one call. Don't extend `ingredients.references` further.
- **First `INGREDIENT_NAME_TAKEN`-style conflict pattern is now codified.** When FEAT-21 adds recipes, expect parallels: `RECIPE_NAME_TAKEN` (uniqueness on `(household_id, lower(name))` for recipes? or accept duplicates? — open question, lives with FEAT-19/20). FEAT-23's batch-pairing will need `RECIPE_ALREADY_PAIRED`. Same `{ code, ...metadata }` shape, same `domainConflict` helper, same `getDomainErrorCode` on the consumer side.
- **`backend/test/user-procedures.test.ts:197` `bumps updatedAt via $onUpdate` flake.** Recurred again this session. Race: `$onUpdate(() => new Date())` and the surrounding awaits can land in the same millisecond. Fix candidates: bump the `setTimeout` from 20ms → 50ms; or assert `>=` instead of `>` with a separate "different timestamp" assertion; or use `vi.useFakeTimers` to make the gap deterministic. Don't ignore forever; it's eroding signal on every test run.
- **First Radix dep is in.** `@radix-ui/react-dialog`. The FEAT-16 prediction ("account deletion may finally justify the first Radix dep") was beaten by FEAT-17; the calculus shifts slightly — the threshold for the *next* Radix component (`AlertDialog`, `Select`, `RadioGroup`, …) is now lower because the patterns are established. Still stop-and-ask, but the slope is less steep.
- **shadcn `Dialog` component template in `components/ui/dialog.tsx`** is the canonical install. Future shadcn additions (`select`, `dropdown-menu`, `alert-dialog`, …) follow the same pattern: copy the template, swap `ElementRef` for `ComponentRef` (the new React 19 type — old shadcn templates still use the deprecated form; ESLint catches it).
- **Testcontainers env vars on Colima:** `DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Without the second, the Ryuk reaper container fails to bind-mount the host socket and *every* Testcontainers suite fails fast. Document in CONTRIBUTING when that file lands; until then, this entry is the source of truth.
- **Auto-code-split warning at 500kB.** Main `index-*.js` chunk is 516.83 kB minified (159.46 kB gzipped). Not actionable yet; carry the number for trend. Watch how it grows as FEAT-21/26/31 land — the planner + recipe editor will be the biggest entrants.
- **`.claude/settings.json` exists now** (created by `/fewer-permission-prompts` this session). Project-shared allowlist covers the pnpm test/typecheck/lint/format:check matrix + docker read-only. The accumulated `settings.local.json` can be pruned of duplicates at the user's discretion; this entry just notes that the shared file is now the source of truth.

---

## 2026-06-08 — FEAT-16 (Profile settings: name + theme + ThemeProvider)

**Status:** implementation complete; `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. `pnpm --filter frontend test` green — 34 / 34 (15 new: 8 `theme-provider.test.tsx` + 7 `settings-page.test.tsx`). `pnpm --filter backend test` — the 9 new `user-procedures.test.ts` Testcontainers cases were authored but **not run in this session** because the local Docker daemon wasn't up; the two non-Docker backend test files (`config`, `server`) still pass 29 / 29 with no regressions. Definition-of-done boxes in `docs/feature-specs.md §FEAT-16` left unticked — human action. The manual gate check (toggle theme → refresh → still dark; change name → refresh → persists; system + OS appearance flip → UI follows live) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Read path: extend Better Auth `user.additionalFields` instead of going through `trpc.user.getMe` only.** `themePreference` is now typed on `ctx.user` (server) and on `session.user` (client). The alternative — keep Better Auth narrow, fetch via `getMe` — would have added a cold-load round-trip and split the read path in two. Cross-cutting #17 ("keep the auth boundary small") is honoured by setting `input: false` so Better Auth's sign-up/update payloads can't write the field: domain writes still flow through `trpc.user.updateProfile` only. Captures the spirit of DEC-42 without the cost.
- **Client-side mirroring via `inferAdditionalFields({ user: { themePreference: ... } })`** in `lib/auth-client.ts`. The other documented option — `inferAdditionalFields<typeof auth>()` — would have introduced a frontend → backend runtime back-edge for the sake of a type. The inline schema is three lines and stays in sync by hand; the typed runtime payload is the same either way.
- **Pre-paint guard in `index.html` over accepting the flash.** DEC-54's downside is the "system + dark-OS + first paint" flash. A six-line inline `<script>` reads `matchMedia('(prefers-color-scheme: dark)').matches` and applies `dark` to `<html>` before React mounts. No localStorage shadow (would contradict the cross-device promise); the authed preference wins on mount as the ThemeProvider's effect runs.
- **`ThemeProvider` reads from `useSession()`, not from `trpc.user.getMe.useQuery()`.** Once the additional-field is in the session, that's the cheapest read on the client. The settings page itself uses `trpc.user.getMe` because it needs `name` too (which is not on the session payload by default — adding it as an `additionalField` made no sense; `name` is already on Better Auth's base user).
- **Native `<input type="radio">` + native `<label>` for the theme picker, not shadcn `RadioGroup` / `Label`.** Each shadcn primitive would have added a new Radix dep (`@radix-ui/react-radio-group`, `@radix-ui/react-label`), which is a stop-and-ask trigger per AGENTS.md. The native pattern matches `sign-in-page.tsx`'s minimalism, keeps the Tailwind styling latitude, and preserves a11y (`role="radiogroup"`, `htmlFor` bindings, real focus management).
- **No toast primitive.** Save feedback is inline (`role="status"` "Saved." + `role="alert"` error message), matching `sign-in-page.tsx`'s state-machine pattern. A toast/sonner primitive belongs to whichever later FEAT first has a genuine need (e.g. async background mutations elsewhere on screen).
- **`db` threaded through the tRPC context via Fastify `decorate`.** First procedure that needs the DB. `app.decorate('db', db)` in `server.ts`; `createContext` reads `req.server.db`; `AppContext` and `FastifyInstance` augmented in `trpc/context.ts`. Tests can still inject their own db via `buildApp({ db })` overrides — the existing FEAT-14 test ergonomics survive untouched.
- **DTO shape for `getMe`: `{ id, email, name, themePreference }` only.** Tight surface, easy to extend. Returning the full row (`image`, `emailVerified`, `createdAt`, `updatedAt`) would have leaked Better-Auth-shaped internals into domain code with no consumer.
- **Diff-only patch in the settings form.** `updateProfile` only receives keys that *changed*: if the user only touches the radio, the mutation payload is `{ themePreference }`. Plays nicely with the Zod `.refine` that requires at least one field, makes test assertions tight (`expect(mutateAsync).toHaveBeenCalledWith({ name: 'New Name' })`), and minimises the `updatedAt` churn on no-op submits.

### Drift from kick-off plan

1. **No shadcn `RadioGroup` / `Label` primitives added** (see decisions above). Plan said add them; reality said new deps = stop-and-ask, so native radios + native labels instead. Worth carrying: the first FEAT that genuinely needs a Radix primitive will pay the dep cost — until then, the form library is "native HTML + Tailwind + shadcn `Button` / `Input`."
2. **Relative import from `backend/src/trpc/procedures/user.ts` to `../../../../shared/src/schemas/user.ts`,** not `@loftys-larder/shared`. First backend runtime import from `/shared` (FEAT-15's session-notes anticipated this would Just Work; it didn't). Cause: `shared/src/router-type.ts` type-only-re-exports the backend router, so shared's tsc walks into backend code; with the backend code importing `@loftys-larder/shared` by package name, shared's compile tried to resolve its own package against a non-existent `shared/dist/index.d.ts`. The relative import sidesteps the cycle entirely without needing `paths` mappings or a `shared/dist` build step. Frontend keeps its `@loftys-larder/shared` import — its `tsconfig` has `paths` already (DEC-80) and frontend isn't in the cycle.
3. **`backend/tsconfig.json` `rootDir`: `"."` → `".."`.** Needed for (2) above so the relative import doesn't trip `TS6059: not under rootDir`. Aligns backend with shared and frontend (both already `".."`). Zero emit impact — backend is `noEmit: true`; esbuild is its bundler. Worth noting because it's a tsconfig change and tsconfig changes deserve scrutiny.
4. **`AppContext` gained `db: Db`** and `FastifyInstance` was module-augmented with `db`. Plan assumed the access pattern but didn't spell out the plumbing. Threaded via `app.decorate('db', db)`; the auth test's protected-procedure probe context literal had to gain `db: {} as AppContext['db']` to satisfy the new shape — only one call site needed updating.
5. **Mock pattern: `vi.hoisted` for the trpc mock in `settings-page.test.tsx`.** The `@typescript-eslint/unbound-method` rule fires on `trpc.useUtils as ReturnType<typeof vi.fn>` because `useUtils` is typed as a method on the tRPC client. `vi.hoisted(() => ({ useUtilsMock: vi.fn() }))` declares the mock fns before the `vi.mock` factory runs, captures them as constants, and references them by name inside the factory. Cleaner than the cast pattern; worth copying for any future test that needs to mock a top-level method on a real-typed export.

### Implementation details worth carrying

- **Better Auth's `user.additionalFields` with `input: false`** prevents the field from being writable through Better Auth's sign-up / update payloads while still surfacing it on `getSession()`. Read-only-from-Better-Auth, written-only-through-domain. This is the pattern for any future per-user metadata projection (notification prefs, locale, …).
- **`inferAdditionalFields` is the client mirror.** Must be added to the client's `plugins` array alongside `magicLinkClient()`. Schema shape is `{ user: { fieldName: { type: 'string', required: true } } }` — matches the DBFieldAttribute shape, not the server's full `additionalFields` config.
- **`app.decorate('db', db)` happens after `registerSecurity` and before `registerAuth`**, but really any time before the tRPC plugin registers is fine. The decorate creates an instance-level prop accessible via `req.server.db` inside the tRPC context.
- **`appRouter.createCaller(ctx)` is now the canonical procedure-test entry-point.** `protectedProcedure` throws `UNAUTHORIZED` from the context check, so passing a context with `session: null, user: null` is the cheapest way to assert middleware behaviour without spinning up Fastify. (Reuses the FEAT-14 pattern; `user-procedures.test.ts` extends it to a fully realistic context.)
- **ThemeProvider subscribes to `matchMedia` only when preference is `system`.** Effect dep array is `[preference]`; entering/leaving `system` cleanly attaches/detaches the listener. The `dark`-class effect has a separate `[resolved]` dep so it fires for both explicit changes *and* system-driven changes. Tested via a controllable mock (`installMatchMedia`) that exposes a `fire(matches)` method.
- **`document.documentElement.classList.toggle('dark', active)`** is the simplest way to keep the class in sync; idempotent.
- **TanStack Router's auto-code-split** worked exactly as documented for the new `_authed/settings.tsx` — the route file exports only `Route`, the page body lives in `routes/-components/settings-page.tsx`, and the production build emits a dedicated `settings-*.js` chunk (3.34 kB). The FEAT-15 thin-route convention earns its keep every new route.
- **`form.reset({ ... })` inside a `useEffect` on `meQuery.data`** is the React-Hook-Form idiom for hydrating defaults from an async source. Don't pass `meQuery.data` into `defaultValues` directly — those are evaluated once at mount, and the form would be initialised empty.

### Spec ambiguities resolved here (don't re-litigate)

- "themePreference persisted per-user in DB so it follows across devices" (DEC-54) — interpreted as "session payload carries it after server-side projection," not "client polls a tRPC query on every render." See first decision above.
- "Backend procedure file location" — spec said `backend/src/trpc/routers/user.ts`; codebase had `backend/src/trpc/procedures/health.ts`. Codebase convention wins. New procedure files go in `procedures/`. If we ever do migrate this directory, do it in one rename PR, not piecemeal.
- "shared schema file naming" — spec said `shared/src/schemas/user.ts`; resolved as a new file (not extending `auth.ts`). One file per domain noun.

### Open items for downstream FEATs

- **Sign-out flow still not built.** FEAT-15's session-notes flagged this as "likely FEAT-16 or a dedicated shell FEAT"; FEAT-16 left it untouched because the settings page is reachable only by hand-typing `/settings` and the navigation shell hasn't landed yet. First nav shell — likely FEAT-26 (PWA shell) or the layout-side of a later recipes/planner FEAT — should wire `authClient.signOut()` + `router.navigate({ to: '/sign-in' })` on success.
- **Settings page is URL-only.** No nav entry; user has to type `/settings`. Same deferral as sign-out — wait for the nav shell.
- **Account deletion (FEAT-35)** will extend `_authed/settings.tsx`. The seven-step tombstoning sequence (DEC-29) needs to land alongside; the form add will be a new section under "Theme," likely with a confirmation dialog primitive (which *may* finally justify the first Radix dep).
- **First backend `/shared` import resolved** (see drift item 2). Pattern: import from `'../../../../shared/src/schemas/<file>.ts'` for now. If we accumulate enough of these to want the `@loftys-larder/shared` package-name syntax in backend, add `paths` to both `backend/tsconfig.json` and `shared/tsconfig.json` (the cycle means both compilation units need the mapping) — not just backend's. Don't add to backend alone; the shared-typecheck step will fail.
- **`db` is now on `AppContext`.** Every procedure can read `ctx.db` without further wiring. Procedures should still scope their queries explicitly — `ctx.user.id` for user-owned tables (auth-owned), `CURRENT_HOUSEHOLD_ID` for household-scoped tables (FEAT-17 onward, DEC-17). The convention belongs in the first ingredient/recipe procedure to establish the pattern.
- **`useSession()` is now in use** (ThemeProvider) — closing the FEAT-15 open item. The hook fires for any UI that wants the current user without re-fetching; combine with `trpc.user.getMe` when you need additional fields (like `name` in the settings form).
- **No toast primitive yet.** Save UX is inline. First async-action-elsewhere-on-screen FEAT (probably the planner's optimistic slot assignment, FEAT-31) is the right place to introduce shadcn `sonner` — at that point a dep is justified.

---

## 2026-06-03 — FEAT-15 (Sign-in UI + magic-link verification + protected routing)

**Status:** implementation complete; `pnpm --filter frontend test` green (19 tests across 5 files — `sign-in.test.tsx`, `auth.verify.test.tsx`, `_authed.test.tsx`, `lib/trpc.test.ts`, plus the inherited `-components/index-page.test.tsx`). `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format` clean across all three workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-15` left unticked — human action. The end-to-end gate check (real magic-link → click → app in a browser) is still owed.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Server-default magic-link redirect target (Better Auth's built-in flow).** The email link points at the server (`/api/auth/magic-link/verify?token=…&callbackURL=…`); the server verifies the token, sets the session cookie, and 302s straight to `callbackURL` (`/`). The frontend `/auth/verify` route is therefore an *error-landing page only* — reached when Better Auth's `errorCallbackURL` fires with `?error=<code>`. The alternative (frontend extracts the token and calls a verify API itself) would double the network hops and re-introduce cross-origin and CSRF concerns we don't need. The FEAT-15 spec wording ("verification route consumes the token from the URL") was interpreted to mean "is the destination of the verification flow," not literally "extracts the token in the browser."
- **Move `routes/index.tsx` → `routes/_authed/index.tsx`.** `/` becomes the first authenticated route. Cleanest implementation of "logged-in user visiting `/sign-in` is redirected to `/`" — and matches the long-term shape, since every later FEAT (settings, recipes, planner, shopping list) will live under `_authed/`. The alternative of leaving `/` public and adding a placeholder `_authed/home.tsx` was rejected as junk that would get renamed in FEAT-16.
- **Native `<label htmlFor>`, no `@radix-ui/react-label`.** Radix's label adds zero behavioural value for a single email input (the native `<label htmlFor>` already gives click-to-focus). Saved one dependency. shadcn/ui is still the styling system per DEC-51; this is purely "don't add a dep you don't need."
- **CSRF transport: Better Auth's double-submit cookie, sent via `credentials: 'include'`.** Better Auth's default CSRF model uses a cookie the browser sends automatically. No header injection in the tRPC client. Confirmed at implementation time against the installed `better-auth@1.6.11`. The tRPC `httpBatchLink` was extended with a `fetch` override (`(input, init) => fetch(input, { ...init, credentials: 'include' })`) — minimum-viable wiring.
- **tRPC URL shape preserved (cross-cutting #16).** `httpBatchLink({ url: '/api/trpc' })` stays — the PWA cache rules (FEAT-42 onward) match on the procedure segment.
- **Custom `unauthorizedRedirectLink` over per-call `onError`.** A `TRPCLink<AppRouter>` (using `observable` from `@trpc/server/observable`) intercepts errors with `err.data?.code === 'UNAUTHORIZED'` and calls an injected `onUnauthorized` callback. `app.tsx` wires that callback to `router.navigate({ to: '/sign-in' })`. The injection pattern keeps `lib/trpc.ts` independent of the router and dodges the otherwise-cyclic import.
- **Route file structure: named exports for `beforeLoad` + components.** Each route file exports its `beforeLoad` and its component as named exports (`signInBeforeLoad`, `SignInPage`, `verifyBeforeLoad`, `VerifyPage`, `copyForError`, `authedBeforeLoad`) which the `Route` definition then references. Tests call the named exports directly without standing up a memory router; the `Route` object's option shape doesn't expose a plain function for testing.

### Drift from kick-off plan

1. **Two stop-and-asks mid-implementation, both producing new DECs:**
   - **DEC-80's deferred call resolved.** `signInSchema` was the first runtime import from `/shared`; Vite couldn't resolve `@loftys-larder/shared` (the `main` field pointed at non-existent `./dist/index.js`). User chose option (2) — alias to source. `frontend/vite.config.ts` and `frontend/vitest.config.ts` now alias `@loftys-larder/shared` → `../shared/src/index.ts`. `shared/package.json` gained `zod`. Captured as DEC-80 update.
   - **`@typescript-eslint/only-throw-error` vs `throw redirect(...)`.** TanStack Router's `beforeLoad` contract is throwing a Response-like object; the strict rule flags this at every guard. User chose global config relaxation for `frontend/src/routes/**` over per-line suppressions. Captured as **DEC-81**.
2. **Three failure states in `/auth/verify` collapse to two codes + default.** Plan listed {expired, used, invalid}. Reading Better Auth's source: only `EXPIRED_TOKEN` and `INVALID_TOKEN` are emitted (no separate "used" — once consumed, re-clicking hits `INVALID_TOKEN` because the verification row is deleted). UI copy is now: expired → "this link has expired"; invalid → "no longer valid (may have been used or modified)"; default branch covers `failed_to_create_user` / `failed_to_create_session` / `new_user_signup_disabled`.
3. **`frontend/tsr.config.json` added** with `routeFileIgnorePattern: "\\.test\\.tsx?$"`, plus a matching `routeFileIgnorePattern` in the Vite plugin's `tanstackRouter({...})` call. Without it, `tsr generate` warns on every run for `*.test.tsx` files colocated with their routes. Not in plan; mechanical fix.
4. **shadcn `Input` primitive added** (`frontend/src/components/ui/input.tsx`). Plan listed it; landed as anticipated, no new deps.
5. **`zod` added as a direct `shared/package.json` dep** — was previously only in backend + frontend. Shared's first runtime import is FEAT-15's `signInSchema`. Mechanical, but worth flagging because it changes shared's dependency surface.

### Implementation details worth carrying

- **TanStack Router's `redirect()` returns a `Response`-like object with the target on `.options.to`, not `.to`.** First-pass tests asserted `{ to: '/sign-in' }` and failed with `Response { options: { to: '/sign-in', statusCode: 307 } }`. Fix the assertion shape to `{ options: { to: '/sign-in' } }`.
- **Better Auth's React `useSession()` is backed by nanostores, not TanStack Query.** Don't try to fold it into the app's `QueryClient`. It manages its own subscription independently. For route guards, call `authClient.getSession()` directly in `beforeLoad` (it short-circuits to `{ data: null }` with zero DB round-trip when there's no session cookie, per the FEAT-14 implementation note).
- **The unauthorized-redirect link sits *before* `httpBatchLink` in the links array.** Order matters: the batch link's error must propagate up through the redirect link's `error()` observer to fire the callback.
- **`routes/_authed.tsx` (layout) and `routes/_authed/index.tsx` (child) are sibling files** under TanStack Router's pathless-route convention. The route tree generator merges them — no manual wiring.
- **The tRPC client factory is now `createTRPCClient({ onUnauthorized })`** in `lib/trpc.ts`. The factory returns a fresh client wired with both the redirect link and the cookie-credentials `httpBatchLink`. The old inline `httpBatchLink({ url: '/api/trpc' })` in `app.tsx` is gone.
- **Vite proxy gotcha sanity-checked.** `frontend/vite.config.ts` proxies `/api/*` to `BACKEND_URL ?? http://localhost:3000`. Better Auth's React client points at `/api/auth` (same-origin from the browser's perspective) and rides this proxy in dev. In prod the Fastify app serves both `/api/*` and the SPA — same origin, no proxy needed.

### Spec ambiguities resolved here (don't re-litigate)

- "Verification route consumes the token from the URL, completes sign-in, redirects to `/`" — interpreted as Better Auth's server-default flow. Server consumes the token; the frontend `/auth/verify` route is the error-landing.
- "tRPC client treats `UNAUTHORIZED` responses by redirecting to `/sign-in`" — implemented as a global custom link, not as per-call `onError` handlers in individual queries.
- "Verification route should handle the failure cases (expired, used, invalid) with distinct messages" — interpreted as: distinct copy for `EXPIRED_TOKEN`, distinct copy for `INVALID_TOKEN` (which is what "used" collapses to once Better Auth deletes the verification row), and a generic-failure default for the rarer codes.

### Open items for downstream FEATs

- **FEAT-16 (profile + theme settings).** First feature to land under `_authed`. Route file: `frontend/src/routes/_authed/settings.tsx`. Backend procedures `user.getMe` / `user.updateProfile` should be `protectedProcedure` (FEAT-14 contract). `ThemeProvider` reads from the Better Auth session — *not* localStorage — to honour DEC-TBD's cross-device theme persistence. Until a real navigation shell lands, the settings page is reachable only by hand-typing the URL.
- **FEAT-17 onward** — every domain procedure inherits the `protectedProcedure` + `CURRENT_HOUSEHOLD_ID` discipline from FEAT-14. The frontend tRPC client now sends cookies on every call automatically; no per-procedure wiring needed on the frontend side.
- **First backend runtime import from `/shared`.** Should resolve transparently — `tsx watch` (dev) and `esbuild` bundle (prod) both follow the workspace symlink to `shared/src/index.ts`. No config change anticipated. If anything trips, add a `paths` mapping to `backend/tsconfig.json` mirroring the frontend's.
- **Sign-out flow not built.** `authClient.signOut()` exists in the auth client; when a real navigation shell adds a "sign out" affordance (likely FEAT-16 or a dedicated shell FEAT), wire `signOut()` + `router.navigate({ to: '/sign-in' })` on success.
- **`useSession()` not exercised in code yet.** Route guards use `getSession()` directly. When a logged-in user's name needs to appear in the UI (FEAT-16 settings page), that's the call site for `useSession()`. The hook is already re-exported from `lib/auth-client.ts`.

### Follow-up later the same day — route-file thinning

First `pnpm dev` after the initial implementation surfaced a TanStack Router auto-code-split warning:

> These exports from "/.../routes/sign-in.tsx" will not be code-split and will increase your bundle size: - SignInPage

The plugin can only split `Route.options.component` cleanly; any other exported React component gets hoisted into the route's chunk. Triggered because the initial implementation exported `SignInPage` / `VerifyPage` from the route files so the test suite could import them directly.

**Fix:** moved page components and `beforeLoad` functions out of `routes/*.tsx` into `routes/-components/` (matching the existing `index-page.tsx` pattern; the `-` prefix excludes the dir from route detection). Route files are now thin shells exporting only `Route`. Test files colocated with the components they exercise — `routes/-components/sign-in-page.test.tsx`, `verify-page.test.tsx`, `authed-layout.test.tsx`.

One small refactor along the way: `VerifyView` used to call `Route.useSearch()` directly, which couples the component to the route file. The component now takes `error: string | undefined` as a prop; the thin wrapper inside `auth.verify.tsx` reads `Route.useSearch()` and passes it through. Cleaner test surface, no circular import.

**Codified in AGENTS.md** as a new "Code conventions" bullet (route files are thin shells; everything else in `-components/`) and a new "Common traps" row (don't export from route files). Every future FEAT that adds a route inherits this.

Verification: typecheck + lint + 19 tests pass; dev server boots without the warning. Tests, route tree, and dev surface all green.

### Follow-up 2026-06-08 — gate check passed; tsx-watch + .env gotcha

End-to-end magic-link flow confirmed working against the local stack: form → Resend → inbox → click → authenticated session. FEAT-15 DoD gate check is satisfied (human ticks the boxes in `docs/feature-specs.md §FEAT-15`).

Debugging detour worth recording: `tsx watch` does **not** restart on `backend/.env` changes — it only watches imported source files. The symptom (emails not arriving despite the form returning success) traced to a backend instance that had loaded an early version of `.env` hours earlier and kept running across multiple in-place `.env` edits. Resolution: kill the backend and re-run `pnpm dev`. Documented in `README.md` under "Run the backend". Worth a one-paragraph mental model for anyone debugging "config change didn't take effect": tsx watch reloads `src/`, not env files.

A second factor in that debug session: a leftover background `pnpm --filter backend dev` from an earlier "run the app" loop was still holding port 3000, which meant the user's subsequent `pnpm dev` invocations couldn't bind and silently lost their start. The `scripts/dev.sh` cleanup trap now sweeps :3000/:5173 stragglers on exit, but anyone running `pnpm --filter backend dev` outside the script should still `lsof -ti :3000` before/after to catch zombies.

### Follow-up 2026-06-08 — absolute callback URLs

First real magic-link click hit a backend 404: `{"message":"Route GET:/ not found"}`. Cause: the sign-in form passed `callbackURL: '/'` (relative). Better Auth resolves relative URLs against `BETTER_AUTH_URL`, which is the backend origin (`http://localhost:3000`) in dev. The SPA lives on Vite (`:5173`), not Fastify — so the redirect landed on a Fastify origin that has no `/` route.

**Fix:** `frontend/src/routes/-components/sign-in-page.tsx` now passes `` `${window.location.origin}/` `` and `` `${window.location.origin}/auth/verify` ``. Better Auth's server stores those verbatim and redirects to whichever origin the user is on — Vite in dev, the unified origin in prod. The dev origin (`http://localhost:5173`) is already on `MAGIC_LINK_TRUSTED_ORIGIN`, so Better Auth's allow-list lets the redirect through. Test assertion updated.

Codified in AGENTS.md as a new "Common traps" row so future call sites (`signOut`, any future OAuth, anything taking a `callbackURL`) inherit the pattern.

End-to-end flow now confirmed: form → email → click → redirect to `http://localhost:5173/` → authenticated session visible to the SPA.

---

## 2026-05-26 — FEAT-14 (Better Auth integration — server)

**Status:** implementation complete; `pnpm --filter backend test` green (119 tests; 30 new FEAT-14 cases — 12 in `auth.test.ts` plus 7 new in `config.test.ts` and 4 in `server.test.ts` — over 89 inherited). Typecheck + lint + `format:check` clean across all three workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-14` left unticked — human action. The end-to-end gate check (real magic-link → click → session) is still owed.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **No `resend` npm dep; plain `fetch` against `api.resend.com/emails`.** The SDK's only value-add is request shaping that's three lines of code; eliminating the dep removes one SDK-migration risk. The send fn is small enough that adding the SDK later is a one-paragraph diff if Resend ever ships a feature we want (batches, attachments). Production wraps fetch via `createResendSender` (`backend/src/auth/resend.ts`); tests inject a spy.
- **Allow-list lives in a separate `withAllowList` wrapper, not in the Resend transport.** A first pass put the gate inside `createResendSender` — caught by a failing test on first run because injected test spies bypassed the transport entirely. Fix: compose the gate around any sender (real or test) in `buildApp`. The gate semantic is also better-named this way — `withAllowList(sender, emails, log)` reads as the policy it is, separate from the transport it wraps.
- **Better Auth schema bridging: `{ usePlural: true, camelCase: true }`.** FEAT-10's tables are pluralised (`users`, `sessions`, …); Better Auth defaults to singular. `usePlural: true` (vs. per-model overrides) is the cheaper config. `camelCase: true` matches our Drizzle TS-keys (`userId`, `expiresAt`, …) — the snake_case mapping at the DB column level happens at the Drizzle runtime via the global `casing: 'snake_case'` (DEC-15), so the adapter only needs to know how to address fields via TS keys.
- **Better Auth handler bridged via the Web `Request`/`Response` path, not `toNodeHandler`.** The Node-handler path requires disabling Fastify's body parsing on the auth route, which leaks across the rest of the app unless carefully scoped. Bridging via `auth.handler(new Request(url, init))` lets Fastify's built-in JSON parser run on the request body and we just `JSON.stringify` it back into the `RequestInit.body` — no body-parser fight, no encapsulation gymnastics. Matches the pattern in Better Auth's Fastify integration docs.
- **`account.fields.password = false` not configured.** Kick-off plan flagged it; on closer reading, unnecessary. The password column only sees writes when the email-and-password provider is enabled, which it isn't (DEC-41). FEAT-10's session note already covers this — NULL costs zero bytes. Saved one config line plus a downstream migration risk.
- **Cookie prefix: `lofty-larder`, not `__Host-`.** `__Host-` forbids subdomains and invalidates every existing session on the deploy that flips it, for no v1 benefit (single-origin in prod per DEC-44). Better Auth defaults already satisfy DEC-43 (`HttpOnly`, `Secure` in prod, `SameSite=Lax`, CSRF).
- **`health.ping` exemption is dev-only.** Spec verbatim. The pre-handler's `isExempt(url, config)` returns true for `/api/trpc/health.ping` only when `NODE_ENV !== 'production'`. Prod healthcheck endpoint lands separately in FEAT-47 as a plain Fastify route under `/api/health`.
- **No user→household join row.** Per DEC-17, `CURRENT_HOUSEHOLD_ID` IS the link in v1. Better Auth's user-create path runs unmodified; multi-user-household work is a non-goal.
- **`buildApp(config, { db?, sendMagicLink? })` — both injectable.** The signature change is the test ergonomics that pays for itself across every later FEAT's tests. Production calls `buildApp(config)` and gets the singletons; tests pass their own Drizzle handle (Testcontainers in `auth.test.ts`, a no-op pool in `server.test.ts`) plus a spy sender.
- **Module augmentation for `FastifyRequest.session`/`user` lives in `trpc/context.ts`, not the auth plugin.** First pass put it in `plugins/auth.ts` — typechecked fine in the backend but broke `/shared` because `router-type.ts` only pulls the tRPC chain (router → init → context), not the plugins. Moving the augmentation onto the `trpc/context.ts` compilation path makes it visible to every consumer of the AppRouter type.

### Drift from kick-off plan

1. **No `resend` SDK dependency** (see decisions above). Plan said "add `resend` to `backend/package.json`"; instead `backend/src/auth/resend.ts` does the REST call directly.
2. **Allow-list refactored into `withAllowList`** after a failing test showed the gate was bypassed when tests injected a sender (see decisions above). Plan had it inside the Resend transport.
3. **`backend/src/db/index.ts` refactored to lazy init.** Plan didn't flag it. The singleton pool's `loadConfig()` ran at module import — which was fine until `server.ts` started importing from `db/index.ts`. Unit tests that don't set the new auth env vars would have crashed on import. `getDb()` returns the singleton on first call; the pool only opens when something actually wants it. `scripts/seed.ts` updated to call `getDb()` to get `pool` and `withTransaction`.
4. **`server.test.ts` `/api/static/does-not-exist.txt` test expectation changed from 404 to 401.** The pre-handler short-circuits before the not-found handler. The test's intent (static plugin doesn't claim `/api/*`) is now proven indirectly via the auth path catching it; the inline comment in the test calls this out.
5. **No new `/shared` schemas.** Plan said no, and that held — Better Auth owns its own input validation for the magic-link flow. The first `/shared/src/schemas/*` entry will land alongside FEAT-15's frontend wiring or FEAT-17's ingredient procedures.

### Implementation details worth carrying

- **`BetterAuthOptions['account']` typing is open enough to accept a `fields` map** but we don't need it (see "decisions: `account.fields.password` not configured"). The password column will stay NULL forever under magic-link-only auth.
- **Better Auth's verify endpoint returns 302 on token reuse**, not 4xx — the redirect URL carries an `error` query param. Tests must accept either shape: assert "no second session was minted" as the semantic check, and treat 302+`error=` *or* 4xx as both valid token-reuse signals. `auth.test.ts` codifies this.
- **`auth.handler(new Request(url, init))` is the right Fastify bridge.** Fastify parses the body into `req.body` via its JSON parser; we re-stringify it into the Web `Request`'s `RequestInit.body`. The catch-all route declares all relevant methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) so Better Auth sees the full surface. Set-cookie headers pass through Fastify's reply unchanged.
- **`createCallerFactory` is the right way to test a `protectedProcedure` without an HTTP round-trip.** Reaching into `procedure._def.resolver` from outside doesn't exist on tRPC v11 — caller factories do. Reusable pattern for later FEATs that want to assert middleware behaviour without mocking the entire Fastify stack.
- **Better Auth's `getSession` short-circuits to `null` when there's no session cookie present** — no DB query. Means unauth requests through the pre-handler don't pay a round-trip cost, and the no-DB tests in `server.test.ts` can run against a stubbed Drizzle handle without ever connecting.
- **`pg.Pool` is fully lazy** — `new pg.Pool({ connectionString })` doesn't open a connection until a client is checked out. `server.test.ts` exploits this with a pool pointed at a bogus URL that never connects.
- **Better Auth's `magicLink({ disableSignUp: false })` is the default**, but spelt out for clarity in `backend/src/auth/index.ts`. The allow-list is the actual sign-up gate (FEAT-14 kick-off Q2). Toggling `disableSignUp` would block the first-time sign-in path even for allow-listed emails who don't yet have a row.

### Spec ambiguities resolved here (don't re-litigate)

- "Verify cookies are set with the expected flags... `__Host-` prefix if used" — **not enabled** (single-origin prod, no subdomain access desired, flip would invalidate sessions).
- `account.fields.password` — **not configured**. Column stays NULL; no consumer.
- Sign-up posture — **allow-list via `MAGIC_LINK_ALLOWED_EMAILS`** (single-household MVP, two-person privacy default).
- User→household linkage on first sign-in — **none in v1** (DEC-17; `CURRENT_HOUSEHOLD_ID` is the link).
- `health.ping` exemption — **dev-only** per the spec AC literally.
- Verify endpoint failure shape — **either 302+`error=` or 4xx**; test the no-session semantic, not the status code.
- Pre-handler integration with `reqId` (DEC-77) — **honoured naturally**; both the auth handler and `getSession` run on the same `req`, so `req.id` flows untouched into Pino and downstream.

### Open items for downstream FEATs

- **FEAT-15 (sign-in UI + verification + protected routing)** — frontend Better Auth client must point at `/api/auth` and post `{ email, callbackURL }` to `/api/auth/sign-in/magic-link`. The verify endpoint is `/api/auth/magic-link/verify?token=…`. tRPC's client error link maps 401 → redirect to `/sign-in` (cross-cutting #16: don't change the tRPC URL shape; the PWA cache rules match on it).
- **FEAT-15 — the verification route reads the token from `?token=` in the URL**, not the path. Better Auth's plugin generates URLs as `${MAGIC_LINK_TRUSTED_ORIGIN}/api/auth/magic-link/verify?token=…` by default. The frontend "magic-link landing" route should consume that token (or be hit directly server-side — confirm during FEAT-15 kick-off).
- **FEAT-16 (profile + theme)** — `user.getMe` / `user.updateProfile` procedures should be `protectedProcedure` (not `publicProcedure`); the `ctx.user` narrowing means resolvers can read `ctx.user.id` and `ctx.user.themePreference` directly without a null check.
- **FEAT-17 onward — every domain procedure file** uses `protectedProcedure` (from `backend/src/trpc/init.ts`) as the default. `publicProcedure` is reserved for `health.ping` and any future genuinely-anonymous endpoints. Domain procedures scope every query by `CURRENT_HOUSEHOLD_ID` (DEC-17, cross-cutting #3) — `ctx.user.id` is informational only, never authorisation.
- **FEAT-35 (account deletion)** — the seven-step tombstoning sequence (DEC-29) will delete from `sessions` and `accounts` before the `users` row. Better Auth's cascade rule on `sessions.userId` / `accounts.userId` is `ON DELETE CASCADE` (FEAT-10 schema), so deleting the user row would clean those up automatically — but the explicit step is still in the sequence for audit-trace clarity. `verifications` are identified by email string, not `userId`, so they don't cascade; the tombstoning procedure should `DELETE FROM verifications WHERE identifier = :email` as part of the same transaction.
- **FEAT-46 (rate limiting, DEC-45)** — the magic-link request endpoint needs the per-email 5/hour limit (DEC-45). Better Auth's built-in `rateLimit: { window: 60, max: 5 }` on the `magicLink` plugin would cover *per-IP* but not *per-email*; FEAT-46 will need a custom limiter or to extend Better Auth's. Not enabled now — wait for FEAT-46 to land the unified `@fastify/rate-limit` config.
- **FEAT-47 (`/api/health` route)** — when this lands, the auth pre-handler exemption `/api/health` already accepts it (the `isExempt` helper matches the `/api/health` prefix). Just register the plain Fastify route.
- **FEAT-51 (`OPERATIONS.md` + restore drills)** — the prod env-var checklist below should lift into the ops doc.

### Operator action before next prod deploy

Four new env vars are required outside test; the next deploy after this PR merges will crashloop without them. Set in Fly:

```sh
flyctl secrets set \
  BETTER_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  BETTER_AUTH_URL="https://loftys-larder.co.uk" \
  RESEND_API_KEY="re_XXXXXXXX" \
  MAGIC_LINK_TRUSTED_ORIGIN="https://loftys-larder.co.uk" \
  MAGIC_LINK_ALLOWED_EMAILS="conorwarne92@gmail.com" \
  --app loftys-larder-prod
```

`MAGIC_LINK_FROM` defaults to `magic@loftys-larder.co.uk` (the FEAT-13 sender) so doesn't need setting unless overriding. Add more comma-separated entries to `MAGIC_LINK_ALLOWED_EMAILS` as second-household-member emails come in.

### Environment notes — same Colima env vars as FEAT-09 / 10 / 11 / 12

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

`auth.test.ts` follows the same Testcontainers pattern as `schema.test.ts` — `beforeAll` boots Postgres + runs migrations; `beforeEach` truncates the four Better Auth tables with `restart identity cascade`. Auth suite finishes in ~5s once the container is warm.

### Deferred (do NOT do as part of FEAT-14)

- Frontend sign-in UI, verification route, protected layout — **FEAT-15**.
- `user.getMe` / `user.updateProfile` procedures — **FEAT-16**.
- Tombstoning sequence (delete sessions/accounts/verifications/recipes/etc. before user row) — **FEAT-35**.
- Per-email rate-limit on magic-link request — **FEAT-46**.
- Unauth `/api/health` Fastify route (already exempt in the pre-handler) — **FEAT-47**.
- `OPERATIONS.md` lift of the env-var checklist above — **FEAT-51**.
- Cloudflare cache-bypass tightening for `/api/auth/*` — already covered by the broad `/api/*` bypass rule landed at FEAT-06; revisit only if Cloudflare's edge starts misclassifying.
- Sentry `beforeSend` PII scrub for auth headers — **FEAT-44** (when Sentry first lands).

---

## 2026-05-23 — FEAT-13 (Resend domain verification)

**Status:** verification complete on 2026-05-23. `loftys-larder.co.uk` verified with Resend; SPF / DKIM / DMARC published in Cloudflare; test send to a personal Gmail showed `spf=pass`, `dkim=pass`, `dmarc=pass` and landed in Inbox. Sender confirmed as `magic@loftys-larder.co.uk`. Definition-of-done boxes in `docs/feature-specs.md §FEAT-13` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Sender address: `magic@loftys-larder.co.uk`.** Matches the spec's example; scannable in an inbox; signals intent. This will be referenced in FEAT-14's Better Auth config as a constant — don't pre-bake it anywhere now (no premature import; see "Deferred" below).
- **DKIM published at the apex, not a subdomain.** Single-purpose project, single sender; the trade-off (apex becomes "claimed" by Resend if a second sending service is added later) does not bite us. DKIM CNAME name will be whatever selector Resend prescribes under `*._domainkey.loftys-larder.co.uk` — copy verbatim from the wizard, do not invent.
- **DMARC starts at `v=DMARC1; p=none` with no `rua`.** Per the spec ("start with `p=none` so failures are visible without blocking"). Skipping `rua` because at this send volume the daily XML reports cost more than they're worth; trivial to add `rua=mailto:...` later by editing the one TXT record. Tighten to `quarantine`/`reject` only after real send-volume data confirms alignment is stable.
- **Fresh Resend account for this project**, not adding `loftys-larder.co.uk` to an existing personal workspace. Cleaner billing isolation; one account = one app.
- **Resend region: EU (Dublin) if offered at signup.** Lowest latency from the Fly `lhr` app, and keeps personal-data processing in-region. If Resend's signup doesn't expose a region toggle, accept the default — it isn't a v1 blocker.
- **No MX records.** Resend is outbound-only for our use; no inbound mail, no catch-all. Resend may *suggest* an MX for bounce handling — skip it; bounces are surfaced in the Resend dashboard already.
- **DKIM CNAME must be unproxied (DNS only) in Cloudflare.** Proxied (orange-cloud) CNAMEs return Cloudflare's edge IPs on lookup, breaking the value chain for receivers fetching the public key. This is the named gotcha in the FEAT-13 spec; the runbook below double-flags it.

### Pre-flight check (done at plan time)

- `dig +short TXT loftys-larder.co.uk` → **empty.** No pre-existing apex TXT records, so SPF and DMARC TXT entries can be added as fresh records without the RFC-7208 single-merged-TXT dance.

### Runbook — first-time Resend domain verification

Substitute `<SPF_TXT>`, `<DKIM_SELECTOR>`, `<DKIM_TARGET>` with the verbatim values Resend's "Add domain" wizard shows for this workspace — those values are workspace-scoped and not predictable. The live values are in the Cloudflare DNS zone and the Resend dashboard; do not duplicate them here.

#### Step 0 — Prerequisites

- Domain live and on Cloudflare DNS: `loftys-larder.co.uk` (confirmed by FEAT-06).
- A personal Gmail (or equivalent showing `Authentication-Results`) reachable for the test send.
- Cloudflare dashboard access to `loftys-larder.co.uk`'s DNS zone.

#### Step 1 — Resend account + add domain

1. Sign up at <https://resend.com> with the project email. Record the account email.
2. After signup, complete the workspace setup. Record the workspace name.
3. Domains → Add Domain.
   - **Domain:** `loftys-larder.co.uk` (apex — no subdomain).
   - **Region:** EU (Dublin) if offered; otherwise the default.
4. Resend reveals the required DNS records on the next screen. Leave that tab open — every value below comes from it verbatim.

#### Step 2 — Capture Resend's prescribed records

Read off Resend's wizard. Typically three records:

| Resend field | Type | Name (host) | Content (target/value) |
|---|---|---|---|
| SPF | TXT | apex (`@`) | something like `v=spf1 include:<resend-domain> ~all` — copy **exact** string |
| DKIM | CNAME | `<selector>._domainkey` | a Resend-hosted target (e.g. `<selector>._domainkey.<workspace>.<resend-host>`) |
| DMARC | TXT | `_dmarc` | Resend may *suggest* a value; **use ours instead**: `v=DMARC1; p=none` |

Notes:
- Resend has sometimes shown a single DKIM CNAME, sometimes three (multi-selector). Copy whatever it shows, in whatever number; each goes in as its own DNS-only CNAME in step 3.
- If Resend suggests an MX record for bounce handling, **skip it.** Outbound-only.
- If Resend offers an existing-DMARC option for your DMARC TXT, **override** to our `v=DMARC1; p=none` — keeping our `rua`-less form explicit.

#### Step 3 — Cloudflare DNS records

Cloudflare dashboard → DNS → Records. Add each row exactly:

| # | Type | Name | Content | Proxy | Source of value |
|---|---|---|---|---|---|
| 1 | TXT | `@` | `<SPF_TXT>` | DNS only — TXT never proxies | Resend wizard |
| 2 | CNAME | `<DKIM_SELECTOR>._domainkey` | `<DKIM_TARGET>` | **DNS only — explicitly toggle off orange-cloud** | Resend wizard |
| 3 | TXT | `_dmarc` | `v=DMARC1; p=none` | DNS only | Our decision |

Repeat row 2 for each DKIM CNAME if Resend prescribes multiple.

Cloudflare quirk: entering `@` in the Name field resolves to the zone apex; entering `_dmarc` resolves to `_dmarc.loftys-larder.co.uk`; entering `<selector>._domainkey` resolves to `<selector>._domainkey.loftys-larder.co.uk`. The dashboard preview confirms FQDN — verify before saving each row.

**Defence-in-depth on the DKIM CNAME proxy flag.** After saving each CNAME, re-open it and confirm the toggle reads "DNS only" (grey cloud), not "Proxied" (orange cloud). Cloudflare's defaults try to proxy CNAMEs. The spec gotcha names this as the primary FEAT-13 failure mode.

#### Step 4 — Wait + sanity-check DNS propagation

Cloudflare propagates internally in < 60s; public DNS caches may lag a few minutes. From a shell:

```sh
dig +short TXT loftys-larder.co.uk                          # expect: SPF string
dig +short CNAME <DKIM_SELECTOR>._domainkey.loftys-larder.co.uk   # expect: Resend target
dig +short TXT _dmarc.loftys-larder.co.uk                   # expect: "v=DMARC1; p=none"
```

If empty after a few minutes: confirm the records exist in the Cloudflare dashboard and that no row was saved with the orange-cloud toggle on for the DKIM CNAME (a proxied CNAME would not resolve to the Resend target on lookup).

#### Step 5 — Trigger Resend verification

Resend dashboard → Domains → `loftys-larder.co.uk` → "Verify DNS" (or equivalent). Resend pulls fresh DNS and reports per-record status.

Wait until the domain card reads **Verified** (green). Initial polls can take a few minutes; subsequent re-tries are instant.

#### Step 6 — Test send + Gmail authentication-results check

1. Resend dashboard → Emails → "Send test" (or via the API console).
   - From: `magic@loftys-larder.co.uk`.
   - To: a personal Gmail.
   - Subject + body: anything plain text.
2. In Gmail, open the message → ⋮ menu → "Show original".
3. In the headers, locate the `Authentication-Results` line. Confirm three substrings:
   - `spf=pass`
   - `dkim=pass`
   - `dmarc=pass`
4. Confirm the message landed in **Inbox**, not Spam/Promotions.

If any of the three reads `fail` or `neutral`, do **not** declare done — the corresponding DNS record is wrong (typo in the value, or DKIM was proxied) and needs re-checking.

### Open items for downstream FEATs

- **FEAT-14 (Better Auth server)** — consumes the verified domain. Sender constant should be `magic@loftys-larder.co.uk`; `RESEND_API_KEY` lands then via `flyctl secrets set` (do **not** set it now — no consumer yet, and an unused secret in Fly drift-checks adds noise).
- **FEAT-51 (`OPERATIONS.md` + restore drills)** — lifts this runbook into the operations doc. The live record values stay in Cloudflare DNS / Resend dashboard; don't duplicate them into the doc.
- **DMARC tightening watch.** Once FEAT-14 is live and we have a few weeks of real magic-link sends with no SPF/DKIM failures, revisit DMARC `p=none` → `quarantine`. Not now.
- **`rua` watch.** If we ever suspect domain spoofing or want visibility into receiver behaviour, add `rua=mailto:conorwarne92@gmail.com` to the `_dmarc` TXT. Single-record edit, no other change.

### Deferred (do NOT do as part of FEAT-13)

- Any `backend/src/auth/*` file — **FEAT-14**.
- `RESEND_API_KEY` in Fly secrets — **FEAT-14**.
- A `from`-address constant anywhere in code — **FEAT-14**.
- Postmark as a configured fallback — out of scope per DEC-69; only *named* as a fallback in case Resend deliverability degrades.
- MX records on `loftys-larder.co.uk` — out of scope; outbound-only sender.
- Tightening DMARC beyond `p=none` — explicitly deferred per spec.
- Adding `rua` / `ruf` to DMARC — explicitly skipped at kick-off.

### Commit

`chore(infra): document Resend domain verification` — diff is this session-notes entry only.

---

## 2026-05-21 — FEAT-12 (Schema: meal plans and shopping list items)

**Status:** implementation complete; `pnpm --filter backend test` green (99 tests; 30 new FEAT-12 cases + 69 inherited). Typecheck + lint + `format:check` clean across all workspaces. Migration applies cleanly via Testcontainers from a fresh image. Definition-of-done boxes in `docs/feature-specs.md §FEAT-12` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`meal_plans.id` and `meal_plan_slots.id` are `integer().generatedAlwaysAsIdentity()`.** Same reasoning as FEAT-11's recipe tables — plan/slot row counts climb at the same order as recipes, and the slot FKs `(recipeId, cooksBaseRecipeId)` must be `integer` to match `recipes.id`'s type. Consistent identity-PK style across the whole domain.
- **`meal_plan_slots.planId` is `ON DELETE CASCADE`,** not RESTRICT. *Why:* slots have no meaning outside their plan. The alternative — forcing FEAT-37's plan-delete procedure to clear slots first — adds boilerplate to every plan-delete path for no semantic gain. Recipes and ingredients are explicitly *not* cascaded (RESTRICT on `recipeId` / `cooksBaseRecipeId`) because those references survive plan deletion (the recipe is shared, not owned).
- **`number_of_servings > 0` extends the spec's NOT-NULL-when-recipe rule.** Spec called only for "NOT NULL when slot_type='recipe'"; added `> 0` as part of the same CHECK because a zero-serving slot would silently zero out FEAT-36's aggregation. The CHECK clause is one composite: `slot_type <> 'recipe' OR (number_of_servings IS NOT NULL AND number_of_servings > 0)` — a single named constraint, one violation message, cheap.
- **`cooks_base_*` joint-set encoded as one combined CHECK.** Form: `(cooks_base_recipe_id IS NULL) = (cooks_base_servings IS NULL) AND (cooks_base_servings IS NULL OR cooks_base_servings > 0)`. *Why one clause:* the violation surface is "the pair is wrong somehow"; splitting into two named constraints would make the test assertions report on whichever fires first, not the conceptual violation. One name (`meal_plan_slots_cooks_base_joint`) is what FEAT-30's application layer will surface to the user.
- **`recipeId` (eaten-recipe FK) is `ON DELETE RESTRICT`,** mirroring `cooksBaseRecipeId`. *Why:* recipes are soft-deleted (DEC-21) so the FK rarely fires in practice, but if a future migration ever hard-deletes a recipe, an existing slot reference should block it rather than corrupt the past plan. Spec only explicitly specified RESTRICT for `cooksBaseRecipeId`; same reasoning applies to both.
- **`recipe_id IS NOT NULL` and `slot_type = 'recipe'` are coupled via biconditional CHECK.** Form: `(slot_type = 'recipe') = (recipe_id IS NOT NULL)`. *Why a biconditional, not just one direction:* a slot of type `eat_out` with a stray `recipeId` is also a bug; both directions of the bug have the same fix (clear or set the field), so one bidirectional CHECK is the precise primitive.
- **No `shop_date` column on `meal_plans` in v1.** Spec AC didn't list it; `docs/non-goals.md` defers multi-shop planning and names `shop_date` as the entry point when that work happens. Adding it now would invite UI to surface a field nothing reads.
- **No `householdId` denormalisation on slots / shopping-list items.** Both inherit scope via `planId → meal_plans.householdId`. *Why:* DEC-17's single-tenant-with-multi-tenant-readiness posture is satisfied at the plan level; queries already need to join the plan for date filtering, so the join is free. Redundant denormalisation would have to be kept in sync without a corresponding query win.
- **`is_base = true` rule for `cooks_base_recipe_id` is application-layer.** Spec implementation notes say so explicitly; honoured. The DB enforces only the FK and the joint-set. FEAT-30's slot-save procedure will validate `is_base = true` against the `recipes` table and surface a domain error code via `TRPCError.cause` (per cross-cutting #11). Do not push this into a Postgres trigger.

### Drift from kick-off plan

1. **Tests live at `backend/test/meal-plans-schema.test.ts`,** not `backend/src/db/schema/__tests__/` as the kick-off plan said. Matches the FEAT-11 precedent — Vitest's `include: ['test/**/*.test.ts']` (in `backend/vitest.config.ts`) is the source of truth. Plan file said `__tests__/`; reality is `test/`.
2. **Dropped a planned `meal_plan_slots_plan_id_idx` btree.** The `(plan_id, date, occasion_id)` unique index already serves single-column `plan_id` lookups (leading-column rule), so the standalone btree was redundant. drizzle-kit's first-pass output included it; removed before regenerating the migration. Migration is `0002_meal_plans_and_shopping.sql`.
3. **First-pass migration auto-named `0002_redundant_black_bird.sql`; regenerated as `0002_meal_plans_and_shopping.sql`** using `pnpm --filter backend db:generate --name meal_plans_and_shopping`. The `--name` flag is the right way to get a descriptive tag — same naming discipline as FEAT-11's `0001_recipes_domain.sql`. If you regenerate, also clean up `drizzle/meta/_journal.json` so old entries don't accumulate.

### Implementation details worth carrying

- **`pgEnum` declaration and column use share the same identifier.** Following the `themePreference` precedent from FEAT-10/`auth.ts`: `export const slotType = pgEnum('slot_type', [...])` then `slotType: slotType().notNull()` in the table. Confusing at first glance, but the JS-name overload (constructor function for column declaration, value reference everywhere else) works and matches house style. Don't rename to `slotTypeEnum` — diverges from precedent.
- **Postgres enum label order is observable.** The migration emits `CREATE TYPE "public"."slot_type" AS ENUM('empty','recipe','eat_out','takeaway','leftovers')` and the order is encoded in `pg_enum.enumsortorder`. A smoke test in `meal-plans-schema.test.ts` asserts the exact 5-label sequence; if a later migration accidentally reorders or renames, the test fires. Extending the enum requires `ALTER TYPE ... ADD VALUE ...` in a migration — drizzle-kit handles this when the array order is preserved and a new value is appended.
- **Drizzle's `check()` SQL-tag generates correctly-quoted identifiers.** All four FEAT-12 CHECKs compiled to the expected form with backtick-style sql tags. No hand-edit of the migration was needed for the CHECK syntax (unlike FEAT-11's `CREATE EXTENSION pg_trgm` which had to be prepended manually — drizzle-kit doesn't track extensions, but it does track CHECKs).
- **Test-FK behaviour via `expectConstraintViolation(promise, name)`.** Reused from FEAT-11. Drizzle's `DrizzleQueryError` wraps the underlying pg `DatabaseError`; `.cause.constraint` is the canonical place to read the constraint name. `vitest`'s `.rejects.toThrow(/regex/)` would match against the wrapper's `.message` which is just the failed SQL — the helper reads the constraint name directly so the tests prove which invariant fired.
- **`date` columns declared with `mode: 'date'`,** same as FEAT-11. `meal_plans.startDate` / `endDate` and `meal_plan_slots.date` all use Drizzle's date-mode-Date variant so values round-trip as JS `Date` rather than strings. SQL is unchanged.
- **`updatedAt` via `$onUpdate(() => new Date())` on all three new tables.** DEC-16 discipline. `mealPlans.updatedAt`, `mealPlanSlots.updatedAt`, `shoppingListItems.updatedAt` — all `timestamp({ withTimezone: true }).notNull().default(sql\`now()\`).$onUpdate(...)`. Tests cover the bump for all three.

### Spec ambiguities resolved here (don't re-litigate)

- "joint-set CHECK on `cooks_base_*` with `> 0` guard" — one combined CHECK, one constraint name, biconditional + positive guard.
- `ON DELETE` for `meal_plan_slots.planId` — **CASCADE**. Slots are owned by their plan.
- `number_of_servings` constraint when `slot_type = 'recipe'` — **NOT NULL AND > 0**, both in the same named CHECK.
- `recipeId` ON DELETE — **RESTRICT**, mirroring `cooksBaseRecipeId`'s explicit RESTRICT.
- `shop_date` on `meal_plans` — **not added in v1**; defer to whenever multi-shop work lands (per `docs/non-goals.md`).
- `householdId` on slots / shopping_list_items — **not added**; inherited via `planId → meal_plans.householdId`.

### Open items for downstream FEATs

- **FEAT-27 (create plan) — overlap check uses the `meal_plans_household_start_date_idx` btree** on `(household_id, start_date)`. DEC-38's rule ("new plans cannot overlap with non-deleted plans whose `endDate >= today`") translates to a `WHERE household_id = CURRENT_HOUSEHOLD_ID AND end_date >= :today AND tstzrange(start_date, end_date, '[]') && tstzrange(:new_start, :new_end, '[]')` predicate; the index covers the leading clause.
- **FEAT-30 (slot editor) — `cooks_base_recipe_id` must reference a recipe with `is_base = true`.** Application-layer validation, raise `TRPCError({ code: 'BAD_REQUEST', cause: { code: 'NOT_A_BASE_RECIPE', recipeId } })`. Multi-statement slot saves wrap in `withTransaction` (cross-cutting #4).
- **FEAT-35 (account deletion) — the tombstoning sequence now also NULLs** `meal_plans.created_by_user_id` and `meal_plan_slots.chef_user_id`. Both columns are `ON DELETE SET NULL`, so the user-row delete would handle it automatically — but the explicit-update step in DEC-29's sequence still applies for audit-trace clarity.
- **FEAT-36 / FEAT-38 (shopping list) — `shopping_list_items` rows are lazy-created on first call to `shopping.getForPlan(planId)`** (DEC-30). The `getForPlan` procedure must run inside `withTransaction` (cross-cutting #13) so concurrent first-reads can't race on insert. Quantities are *not* stored on the table — they're computed from the plan's recipes on read; only `is_checked` is persistent state.
- **FEAT-37 (delete plan) — plan delete cascades to slots and shopping_list_items.** No explicit cleanup needed in the application layer; the FK actions handle it.

### Environment notes — same Colima env vars as FEAT-09 / 10 / 11

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

This pass confirmed the failure mode again: without `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` set, Ryuk tries to bind-mount `~/.colima/default/docker.sock` *inside* the Ryuk container, which the Lima VM rejects with `operation not supported`. The override points the bind-mount at `/var/run/docker.sock` (the path the daemon listens on *inside* the VM) and Ryuk is happy. `TESTCONTAINERS_RYUK_DISABLED=true` is the alternative documented at FEAT-10/11; either works.

CI (`ubuntu-latest`) doesn't need either.

### Deferred (do NOT do as part of FEAT-12)

- `recipes.create` / `recipes.updateHeader` etc. — **FEAT-20**.
- `plans.create` (with overlap check) — **FEAT-27**.
- Slot-save procedure with `is_base` validation — **FEAT-30**.
- Plan shrink/extend transaction — **FEAT-35**.
- Shopping-list aggregation + lazy create — **FEAT-38**.
- `pickable-recipes` helper (cross-cutting #5) — **FEAT-19**.
- `dateUtils` module (cross-cutting #8) — **FEAT-27** (first consumer is the plan-overlap check).
- Plant-points helper — **FEAT-41**.
- Zod schemas in `/shared/src/schemas/*` — land alongside the procedures that consume them.

---

## 2026-05-21 — FEAT-11 (Schema: recipes domain)

**Status:** implementation complete; `pnpm --filter backend test` green (69 tests; 32 new recipes-domain cases + 37 inherited). Typecheck + lint clean across all workspaces. Migration applies cleanly via Testcontainers from a fresh image. Definition-of-done boxes in `docs/feature-specs.md §FEAT-11` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Eight per-serving macro columns, not the spec's six.** Final set: `calories`, `protein`, `carbs`, `fat`, `saturated_fat`, `fibre`, `sugar`, `salt` (all `smallint NULL`). *Why:* matches UK front-of-pack labelling — covers everything most online recipes already publish, and avoids a follow-up migration to add `salt` the first time someone logs a soy-sauce-heavy meal. `docs/plan.md` line 217 updated in the same pass.
- **`recipe_sources` is household-scoped** with `UNIQUE (household_id, name)`. *Why:* the plan called it "user-extensible" but listed no `household_id`; under DEC-17's single-tenant-with-multi-tenant-readiness posture, the global option would leak one household's sources into another's picker the day a second household is added. Cheaper to scope now.
- **`recipe_ratings.user_id` is `ON DELETE RESTRICT`,** not CASCADE. *Why:* DEC-29's tombstoning sequence (plan.md lines 86–91, step 1) explicitly deletes the user's ratings before the user row. RESTRICT forces FEAT-35 to honour that step instead of letting a stray `DELETE FROM users` quietly destroy ratings without going through the documented path.
- **No `$onUpdate` on `recipe_comments.last_updated_at`.** *Why:* Drizzle's `$onUpdate` fires on INSERT too (when the column has no provided value) — keeping it would mean the column is never NULL on a fresh comment, defeating the spec's NULL-means-never-edited inference (plan.md line 229). The application layer (FEAT-29) sets `last_updated_at` explicitly when a comment is edited. All other timestamp / date columns in the new schema do use `$onUpdate` per DEC-16.
- **Trigram GIN index expression went straight through `drizzle-kit`.** Declared as `index(...).using('gin', sql\`lower(${table.name}) gin_trgm_ops\`)`; the generated SQL is correct verbatim — no hand-edit needed for the index DSL. The only manual edit to the generated migration was prepending `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (drizzle-kit doesn't track extensions). This means future schema diffs against this index round-trip cleanly.
- **`date_added` / `date_last_updated` use `date({ mode: 'date' })`.** *Why:* the default `date()` builder returns string mode, which mismatches `$onUpdate(() => new Date())`'s `Date` return type. `mode: 'date'` keeps the column as Postgres `date` while letting Drizzle round-trip JS `Date` values. No SQL difference.
- **PK style for recipe-domain tables is `integer().generatedAlwaysAsIdentity()`.** *Why:* spec says `int PK`; reference tables (FEAT-10) use `smallserial` because they're 5–10 rows each. Recipe-domain tables expect orders of magnitude more, so 32-bit identity is the right fit. The choice cascades into FKs — `recipe_ingredients.recipe_id` is `integer`, `recipe_ingredients.prep_type_id` is `smallint` to match `preparation_types.id`'s `smallserial`.

### Drift from kick-off plan

1. **Recipe `dateAdded` / `dateLastUpdated` declared with `mode: 'date'`** — not pre-flagged in the plan but unavoidable once Drizzle's typed builder rejected `Date` as the `$onUpdate` return type for a string-mode column. SQL output unchanged.
2. **Test file is `backend/test/recipes-schema.test.ts`** (per the approved plan). Reuses the Testcontainers + per-test `truncate ... restart identity cascade` pattern from `backend/test/schema.test.ts:44–77`. 32 tests across migration-shape, CHECK constraints, FK ON DELETE behaviour, surrogate-key duplicates, NULL-distinct uniqueness on `recipe_drafts`, and `$onUpdate` round-trips.
3. **A small `expectConstraintViolation(promise, name)` helper** lives in the test file. *Why:* `vitest`'s `rejects.toThrow(/regex/)` matches against the thrown error's `.message`, but Drizzle wraps the underlying `pg` `DatabaseError` in a `DrizzleQueryError` whose `.message` is just `"Failed query: <sql> params: ..."`. The constraint name is on `.cause.constraint`. The helper reads that and asserts on it — without it, the tests would either pass when the wrong constraint fired, or be reduced to "something threw."

### Implementation details worth carrying

- **Drizzle's `$onUpdate` fires on INSERT-without-value, not just UPDATE.** Counter-intuitive name. If a column should be NULL until explicitly set (like `recipe_comments.last_updated_at`), do not use `$onUpdate`. If the column should always be populated (the standard `updated_at` discipline DEC-16 describes), `$onUpdate` is correct precisely because of this behaviour.
- **drizzle-kit doesn't track Postgres extensions.** `CREATE EXTENSION IF NOT EXISTS pg_trgm` had to be prepended to the generated SQL. The migration carries a `--` comment explaining why; any future migration that uses `gin_trgm_ops` (or any other extension operator class) needs the same treatment. There's no Drizzle DSL hook for this — it's a one-line manual edit and that's fine.
- **`index(...).using('gin', sql\`lower(${col}) gin_trgm_ops\`)`** is the right Drizzle DSL for a trigram GIN index on an expression. The generated SQL is `CREATE INDEX "name" ON "table" USING gin (lower("col") gin_trgm_ops);` — verbatim what FEAT-19's ILIKE search needs.
- **Self-referential FKs use `references((): AnyPgColumn => table.id, {...})`.** The lazy arrow + `AnyPgColumn` cast is the documented Drizzle pattern; the back-reference resolves at table finalisation. Three columns use it here: `recipes.base_recipe_id` (RESTRICT), `recipes.paired_recipe_id` (SET NULL), and (transitively, via composite FKs) `related_recipes`.
- **Migration file was auto-named `0001_futuristic_cerise.sql`; renamed to `0001_recipes_domain.sql` and the journal `tag` updated to match.** drizzle-kit's auto-naming is fine in CI but worse than a descriptive name for future grep. The pattern: rename the `.sql` file, edit `drizzle/meta/_journal.json` to update the `tag` field for the matching `idx`. Snapshot file is keyed by `idx` and doesn't need renaming.
- **Composite PK on `related_recipes` declared via `primaryKey({ columns: [a, b] })`** in the table's second-argument array. The CHECK `recipe_one_id < recipe_two_id` enforces symmetry at the DB level — one row per pair, period. App-layer code in FEAT-21 only ever has to compute `[lo, hi] = a < b ? [a, b] : [b, a]` before inserting.

### Open items for downstream FEATs

- **FEAT-12 (meal plans) — `meal_plan_slots.recipe_id` and `meal_plan_slots.cooks_base_recipe_id`** both FK to `recipes.id`. Recipes are 32-bit `integer`, so the slot FKs are `integer`. `cooks_base_recipe_id` ON DELETE RESTRICT (per spec). The slot-type enum lives there, not here.
- **FEAT-19 (recipe procedures) — `pickable-recipes` helper** (cross-cutting #5) encodes the soft-delete visibility rule. Don't filter `is_deleted = false` by hand at any call site. The trigram GIN index is now ready for `lower(name) % :query` ILIKE search; no further DB work needed.
- **FEAT-21 (recipe editor) — `paired_recipe_id` symmetry** is maintained in the application layer inside a `withTransaction` (DEC-22, cross-cutting #4). Setting A.paired = B must also set B.paired = A in the same tx; clearing one must clear both.
- **FEAT-29 (comments) — `recipe_comments.last_updated_at`** is application-managed (no `$onUpdate`). The comment-edit procedure must set it explicitly. UI shows "(edited)" iff non-NULL.
- **FEAT-35 (account deletion) — RESTRICT on `recipe_ratings.user_id` and `recipe_drafts.user_id`** forces the tombstoning sequence to delete those rows *before* the user row. Verified by the FK tests in this pass.

### Spec ambiguities resolved here (don't re-litigate)

- "six `*_per_serving` macro columns" — explicitly **changed to eight** with named columns (`calories`, `protein`, `carbs`, `fat`, `saturated_fat`, `fibre`, `sugar`, `salt`). Spec text in `docs/plan.md` line 217 updated.
- "user-extensible" `recipe_sources` with no `household_id` mentioned — **scoped to household** + `UNIQUE (household_id, name)`.
- `recipe_ratings.user_id` ON DELETE not specified explicitly — **RESTRICT**, in line with the spec's "tombstone-able SET NULL, the rest RESTRICT" rule and DEC-29's explicit-deletion sequence.

### Environment notes — same Colima env vars as FEAT-09/10

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1
export TESTCONTAINERS_RYUK_DISABLED=true   # or TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE per FEAT-09 entry
```

CI (`ubuntu-latest`) doesn't need either.

### Deferred (do NOT do as part of FEAT-11)

- tRPC procedures for recipes / ingredients — **FEAT-17 / FEAT-19 / FEAT-20**.
- Zod schemas in `/shared/src/schemas/` — land alongside the procedures that consume them.
- Cloudinary signed-upload procedure — **FEAT-17**.
- The `pickable-recipes` helper — **FEAT-19**.
- Recipe-pairing symmetry transaction — **FEAT-21 / FEAT-23**.
- Account-deletion tombstoning — **FEAT-35**.
- Partial index on `recipes WHERE is_deleted = false` — not in the spec; revisit if recipe scan plans get slow with soft-deleted rows.

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
- ~~**FEAT-14 — Zod 4 transitive pin.**~~ **Resolved 2026-05-21:** project upgraded to `zod@^4` while the consuming surface was a single file (`backend/src/config.ts`); path (a) chosen. DEC-07 amended with the version pin. `@hookform/resolvers` bumped to `^5` alongside. No translation seam needed at the Better Auth boundary — `/shared/src/schemas/*` will land on v4 from the start.
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
- **`DATABASE_URL` is required in every environment** (Zod-validated as `postgres://` or `postgresql://`). *Why required, not optional-with-lazy-pool:* plumbing only earns its keep if it's hot at startup, and `health.ping` will start touching the DB at FEAT-47. Boot-time failure is the right time to surface a missing secret, not first-DB-query time.
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

GitHub Actions runners use the default socket path and don't need either override. Worth a `docs/OPERATIONS.md` line at FEAT-51 lift; not blocking.

### Deferred (do NOT do as part of FEAT-09)

- Wire `db` into the tRPC context — downstream FEAT (FEAT-10 first procedure).
- `flyctl postgres create` / `flyctl postgres attach` and `DATABASE_URL` in Fly secrets — operational follow-up; required before the next prod deploy.
- Any table/schema — FEAT-10/11/12.
- `release_command "pnpm drizzle-kit migrate"` in CI — FEAT-49.
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
- **`fly-request-id` flows through Cloudflare untouched.** Confirmed in probes. This is the foundation for FEAT-44's `reqId` propagation (DEC-77 / cross-cutting #1).
- **All helmet security headers survive the Cloudflare hop.** CSP, HSTS, X-Frame-Options, etc. all present on responses fetched through the proxied URL.

### Decisions taken at kick-off

- **App name:** `loftys-larder-prod`. Now pinned in `fly.toml`. Renaming is painful — treat as permanent.
- **Canonical host:** apex. `www` 301-redirects to apex. Done at Cloudflare with a Single Redirect rule (cheapest place — keeps the redirect off the Fly machine's wake path).
- **HTTPS redirect authority:** Fly. `force_https = true` stays in `fly.toml`; Cloudflare "Always Use HTTPS" stays **off**. Single source of truth, no loop (FEAT-06 gotcha line 266).
- **Cloudflare SSL mode:** Full (strict). Fly issues a real LE cert; Flexible would downgrade the Cloudflare→Fly hop to HTTP and break `force_https`.
- **Cache bypass pattern:** the rule matches `/api/*` — broad enough to cover the tRPC URL shape `/api/trpc/<procedure>?batch=1&input=...` (cross-cutting #16). Do not narrow it.

### Runbook — first-time prod deploy

Substitute `<DOMAIN>` throughout once chosen. Capture every command's exit status / output worth keeping; FEAT-51 lifts this into `OPERATIONS.md`.

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
- Swap TCP `[checks.tcp_alive]` for HTTP `/api/health` check — **FEAT-47**.
- Wire `release_command "pnpm drizzle-kit migrate"` into CI on push to `main` — **FEAT-49**.
- Cold-start measurement against 3-second budget (DEC-64) — **FEAT-52**.
- Nightly `pg_dump → R2` (DEC-73) — **FEAT-50 / 50**.

### Captured values (live record — for FEAT-51's `OPERATIONS.md` lift)

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

2. **Health check in `fly.toml` is a machine-level TCP check, not the HTTP `/api/health` path specified in FEAT-05.** `/api/health` ships in FEAT-47; declaring an HTTP check that resolves to a non-existent route would have marked every machine unhealthy from FEAT-06's first deploy. Inline comment in `fly.toml` flags the swap point. **FEAT-47 must replace `[checks.tcp_alive]` with an HTTP check (or add one and keep TCP).**

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

2. **Added `LOG_LEVEL` env var** to `backend/src/config.ts` and `.env.example`. Not in FEAT-03's plan; added so the Vitest suite can run Pino at `silent` without polluting test output. Defaults to `info` in dev/prod. Worth knowing this exists when wiring Axiom in FEAT-44 (don't accidentally set it to `silent` in production env).

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
