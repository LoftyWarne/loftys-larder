# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

---

## 2026-06-03 — FEAT-15 (Sign-in UI + magic-link verification + protected routing)

**Status:** implementation complete; `pnpm --filter frontend test` green (19 tests across 5 files — `sign-in.test.tsx`, `auth.verify.test.tsx`, `_authed.test.tsx`, `lib/trpc.test.ts`, plus the inherited `-components/index-page.test.tsx`). `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format` clean across all three workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-15` left unticked — human action. The end-to-end gate check (real magic-link → click → app in a browser) is still owed.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Server-default magic-link redirect target (Better Auth's built-in flow).** The email link points at the server (`/api/auth/magic-link/verify?token=…&callbackURL=…`); the server verifies the token, sets the session cookie, and 302s straight to `callbackURL` (`/`). The frontend `/auth/verify` route is therefore an *error-landing page only* — reached when Better Auth's `errorCallbackURL` fires with `?error=<code>`. The alternative (frontend extracts the token and calls a verify API itself) would double the network hops and re-introduce cross-origin and CSRF concerns we don't need. The FEAT-15 spec wording ("verification route consumes the token from the URL") was interpreted to mean "is the destination of the verification flow," not literally "extracts the token in the browser."
- **Move `routes/index.tsx` → `routes/_authed/index.tsx`.** `/` becomes the first authenticated route. Cleanest implementation of "logged-in user visiting `/sign-in` is redirected to `/`" — and matches the long-term shape, since every later FEAT (settings, recipes, planner, shopping list) will live under `_authed/`. The alternative of leaving `/` public and adding a placeholder `_authed/home.tsx` was rejected as junk that would get renamed in FEAT-16.
- **Native `<label htmlFor>`, no `@radix-ui/react-label`.** Radix's label adds zero behavioural value for a single email input (the native `<label htmlFor>` already gives click-to-focus). Saved one dependency. shadcn/ui is still the styling system per DEC-51; this is purely "don't add a dep you don't need."
- **CSRF transport: Better Auth's double-submit cookie, sent via `credentials: 'include'`.** Better Auth's default CSRF model uses a cookie the browser sends automatically. No header injection in the tRPC client. Confirmed at implementation time against the installed `better-auth@1.6.11`. The tRPC `httpBatchLink` was extended with a `fetch` override (`(input, init) => fetch(input, { ...init, credentials: 'include' })`) — minimum-viable wiring.
- **tRPC URL shape preserved (cross-cutting #16).** `httpBatchLink({ url: '/api/trpc' })` stays — the PWA cache rules (FEAT-41 onward) match on the procedure segment.
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
- **`health.ping` exemption is dev-only.** Spec verbatim. The pre-handler's `isExempt(url, config)` returns true for `/api/trpc/health.ping` only when `NODE_ENV !== 'production'`. Prod healthcheck endpoint lands separately in FEAT-46 as a plain Fastify route under `/api/health`.
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
- **FEAT-45 (rate limiting, DEC-45)** — the magic-link request endpoint needs the per-email 5/hour limit (DEC-45). Better Auth's built-in `rateLimit: { window: 60, max: 5 }` on the `magicLink` plugin would cover *per-IP* but not *per-email*; FEAT-45 will need a custom limiter or to extend Better Auth's. Not enabled now — wait for FEAT-45 to land the unified `@fastify/rate-limit` config.
- **FEAT-46 (`/api/health` route)** — when this lands, the auth pre-handler exemption `/api/health` already accepts it (the `isExempt` helper matches the `/api/health` prefix). Just register the plain Fastify route.
- **FEAT-50 (`OPERATIONS.md` + restore drills)** — the prod env-var checklist below should lift into the ops doc.

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
- Per-email rate-limit on magic-link request — **FEAT-45**.
- Unauth `/api/health` Fastify route (already exempt in the pre-handler) — **FEAT-46**.
- `OPERATIONS.md` lift of the env-var checklist above — **FEAT-50**.
- Cloudflare cache-bypass tightening for `/api/auth/*` — already covered by the broad `/api/*` bypass rule landed at FEAT-06; revisit only if Cloudflare's edge starts misclassifying.
- Sentry `beforeSend` PII scrub for auth headers — **FEAT-43** (when Sentry first lands).

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
- **FEAT-50 (`OPERATIONS.md` + restore drills)** — lifts this runbook into the operations doc. The live record values stay in Cloudflare DNS / Resend dashboard; don't duplicate them into the doc.
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
- Plant-points helper — **FEAT-40**.
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
