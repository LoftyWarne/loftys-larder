# Gotchas

Symptoms whose cause sits somewhere you wouldn't look, and lookups that need a command or place the code doesn't name. When debugging, grep this file for the error text first. When changing an area, read its section.

## Adding an entry

- An entry earns its place when finding the cause took real time or reached production, the cause wasn't where the symptom pointed, and it can happen again.
- Prefer fixing the cause, or a check whose failure message explains it, then a comment where it bites. An entry covers what those can't, or names the guard in one line.
- The heading is the symptom, and error text is quoted exactly, so grepping the error finds it.
- Fields: **Symptom**, **Cause**, **Fix** (or **Guard**), **Confirm** (how to tell it's this), **Source** (commit or date), and **Remove when**, if some change would retire the entry.
- Add the entry in the same commit as the fix. Before deleting a `docs/session-notes.md` entry, move any gotcha or lookup in it here.
- Procedures that change production live in `OPERATIONS.md`, rules for every change in `AGENTS.md`, and decisions in the DEC log.

## Where to look

- **One request across Sentry and Axiom:** `OPERATIONS.md` § Cross-referencing an incident. The `reqId` tag in Sentry is the `reqId` field in Axiom.
- **Which release is live, and rolling back:** `OPERATIONS.md` § Releases and rollback.
- **Production data:** `flyctl postgres connect -a loftys-larder-prod-db`, then `\c loftys_larder_prod`. The session is interactive and ignores piped stdin. `node -e "import('pg')…"` on the app machine fails, because the esbuild bundle has no `node_modules`. The user runs production reads.
- **The CSP production actually serves:** `curl -sD- https://loftys-larder.co.uk/ -o/dev/null | grep -i content-security-policy`. The browser may still be replaying a cached shell's headers.
- **Axiom:** the `loftys-larder-prod` dataset is on the EU Central edge (`https://eu-central-1.aws.edge.axiom.co`). `api.axiom.co` is the control plane. Ingest needs an API token, not a personal access token.
- **How many distinct clients reach the app:** in Axiom, `['loftys-larder-prod'] | where msg == 'incoming request' | summarize dcount(['req.remoteAddress'])`.

## Deploy and Fly

### Production logs say `env: "development"`

- **Guard:** `isDevModeOnFly` in `backend/src/config.ts`, covered by `config.test.ts`. With `FLY_APP_NAME` set, the server, `migrate.js` and `seed-reference.js` refuse to start unless `NODE_ENV` is `production`, and the error names the cause (a `NODE_ENV` Fly secret overriding the Dockerfile's `ENV`) and `flyctl secrets unset NODE_ENV --app loftys-larder-prod`. (2026-07-13 session notes)

### `No meal occasions configured` after a database re-attach

- **Symptom:** creating a plan fails with `INTERNAL_SERVER_ERROR: No meal occasions configured`, then with an FK failure on `meal_plans.household_id → households(id)`. The tables exist but the reference rows don't.
- **Cause:** re-attaching Postgres or changing the `DATABASE_URL` secret restarts the Machines without running `release_command`, which seeds reference data only on a deploy.
- **Fix:** redeploy, or run the idempotent seed on the app machine:
  ```
  flyctl machine start <id> --app loftys-larder-prod
  flyctl ssh console --app loftys-larder-prod -C "node /app/seed-reference.js"
  ```
- **Confirm:** the seed prints `seed-reference: complete`, and creating a plan works.
- **Source:** `d822345`, 2026-07-05 session notes. **Remove when:** reference seeds run on boot as well (not decided).

### A release reports success but its second command never ran

- **Guard:** the comment above `release_command` in `fly.toml`. Fly runs the command without a shell, so `&&` needs the `sh -c` wrapper. Without it, `migrate.js` receives the seed command as ignored arguments. (`8d3e229`)

### Every request comes from `66.241.124.105`

- **Symptom:** `req.ip` is the app's shared Fly IPv4, or an address in `2a09:8280::`, for every client, so all IP-keyed rate limits share one bucket.
- **Cause:** Fly's proxy forwards requests from its public addresses, and the trusted-proxy list must include them.
- **Guard:** `backend/src/plugins/trusted-proxies.ts` and `trusted-proxies.test.ts`. The Cloudflare ranges there were copied from cloudflare.com/ips on 2026-10-24; if Cloudflare's change, those clients share a bucket again.
- **Confirm:** the distinct-clients query under Where to look.
- **Source:** `4a9fdc5`.

## Observability

### Axiom's dataset is empty

- **Symptom:** live traffic, but no events in `loftys-larder-prod`.
- **Cause and fix, in order:**
  1. Production running in dev mode: see "Production logs say `env: "development"`".
  2. Search `flyctl logs` for `axiom ingest failed`. A successful ingest logs nothing. A 403 means `AXIOM_ENDPOINT` names the wrong region (it must be the EU edge), a 401 means a personal access token is set instead of an API token, and a 404 means the legacy `/v1/datasets/<ds>/ingest` path.
- **Source:** `c0fc639`, `b9cf175`.

### Sentry reports 4xx `FastifyError`s

- **Guard:** `shouldReportFastifyError` in `backend/src/plugins/sentry.ts`, covered by `sentry.test.ts`. Fastify runs `onError` hooks before it applies the error's status, so Sentry's default filter sees 200 and reports errors such as an empty JSON body. If these come back, the filter has been dropped. (`349ce07`)

### Frontend Sentry is silent in production

- **Guard:** the negation and comment in `.dockerignore`. Its broad `.env.*` patterns would strip the committed `frontend/.env.production`, so `vite build` sees no `VITE_SENTRY_DSN` and `initSentry()` does nothing. The negation must come after the broad patterns. (`fbc5eca`)

## tRPC and Fastify

### `Unable to transform response from server`

- **Symptom:** the tRPC client throws this, often in production only.
- **Cause:** the response wasn't a tRPC envelope, usually because the request matched no route. The project has no data transformer, so superjson isn't involved. Known causes: a batched GET whose comma-joined procedure list passed Fastify's route-parameter limit, and a non-tRPC 404 body.
- **Guard:** `routerOptions.maxParamLength` in `backend/src/server.ts` (regression test in `server.test.ts`), and the tRPC-shaped 404 from `backend/src/trpc/not-found.ts`.
- **Confirm:** look at the raw response body and the request URL's length in DevTools.
- **Source:** `67a2c01`, `7f6ab72`.

## PWA and CSP

### `TypeError: Failed to fetch`, in production only

- **Symptom:** a browser `fetch` fails with no HTTP status, in production but not in dev.
- **Cause:** the CSP blocked it. Dev runs on Vite, which sends no CSP header. The console shows `violates … connect-src`.
- **Fix:** add the host in `backend/src/plugins/security.ts`, plus its assertion in `security.test.ts`.
- **Source:** `5ebed61`.

### A header fix is live but installed apps still see the old one

- **Symptom:** `curl` shows the new CSP, but the installed PWA keeps the old one, even after a hard refresh.
- **Cause:** the service worker precaches `index.html` along with its response headers. A backend-only change leaves the file's content hash alone, so no new service worker ships.
- **Fix:** bump the `shell-revision` meta tag in `frontend/index.html`; the comment there explains it. To test in a browser before that, unregister the service worker and reload.
- **Source:** `5ba2ad1`.

## Database and Postgres

### `deadlock detected` (`40P01`)

- **Cause:** two writes took row locks in different orders. Storage writes share one order, written at the top of `backend/src/lib/slot-reservations.ts`: Reservations settled, then the plan and slot, then Stock items, then Reservations. A new write that locks in another order deadlocks under concurrency.
- **Also:** the e2e household reset retries on `40P01` (`e2e/fixtures/db.ts`), because a health-score write from the previous spec can still hold locks.
- **Source:** `06898ae`, 2026-11-15 session notes.

### `FATAL 57P01` in CI after every test passed

- **Symptom:** the backend test run fails as the Testcontainer stops, and the deploy is skipped.
- **Cause:** pg-pool re-emits an idle client's error on the pool, and a pool with no `'error'` listener turns it into an uncaught exception.
- **Fix:** new test files use `startTestDb` and `stopTestDb` from `backend/test/helpers/test-db.ts` rather than their own pool setup.
- **Source:** `9ee0cbf`.

### Flaky `updatedAt` assertions

- **Cause:** `$onUpdate(() => new Date())` uses Node's clock, while the insert default uses Postgres's, and Testcontainers' clocks can drift apart.
- **Fix:** timestamp columns use ``$onUpdate(() => sql`now()`)``. Day-precision date columns keep `new Date()`.
- **Source:** `7e1e28f`.

### `pg_dump: error: aborting because of server version mismatch`

- **Cause:** the runner's preinstalled older client wins through Ubuntu's `pg_wrapper`, even with the right `postgresql-client-NN` installed.
- **Fix:** `backup.yml` puts `/usr/lib/postgresql/17/bin` on `GITHUB_PATH`. When the cluster's major version changes, bump the package and that line together.
- **Source:** `87f57ee`.

## Auth

### A saved setting shows only after a reload

- **Guard:** `refreshSession()` and its comment in `frontend/src/lib/auth-client.ts`. Better Auth's session atom refreshes only when its own endpoints run, so a field the session carries (today `themePreference`) that's saved through tRPC must call it. (`4a47e97`)

## Model features

### A model feature fails every call in production while its tests pass

- **Symptom:** every request fails, with the UI saying "try again". Tests use the `fake` adapter, so they stay green.
- **Cause:** Anthropic refuses a structured-output schema past its limits with a 400, before any model runs. Recipe Import's schema had 24 union-typed properties against a limit of 16, and even under that its compiled grammar was too large.
- **Fix:** Recipe Import sends no output format. Its prompt describes the schema (`backend/src/lib/recipe-reader/anthropic-prompt.ts`), and the normaliser checks every reply.
- **Confirm:** the `IMPORT_REQUEST_REJECTED` log line carries the provider's error type, validation message and request id. Before a model feature's first deploy, send one real request through the real adapter.
- **Source:** `b0587af`.

## Local dev and tests

### The backend ignores an edit to `.env`

- **Cause:** `tsx watch` restarts on imported source files, not on `.env`. A stray backend can also still hold port 3000, so a new one fails to bind and its start is lost.
- **Fix:** restart the backend. `lsof -ti :3000` finds a straggler; `scripts/dev.sh` sweeps ports 3000 and 5173 on exit.
- **Source:** 2026-06-08 session notes.

### e2e behaves as if a backend change isn't there

- **Cause:** Playwright's `webServer` runs the built `backend/dist/server.js`, and locally it reuses a server already listening on the port (`e2e/playwright.config.ts`).
- **Fix:** `pnpm --filter backend build` before `pnpm --filter e2e e2e`, and stop any server still running on the port.
- **Also:** if planner or shopping queries throw on a missing column, the local `lofty_e2e` database is behind on migrations. `pnpm --filter e2e prepare-db` brings it up to date; CI runs it on every run.
- **Source:** 2026-10-24 and 2026-06-30 session notes.

### Typed text comes out garbled in a test

- **Symptom:** typing `after` into a textarea yields text like `aaaaaaafataearaaaa`, and only under the full parallel run.
- **Cause:** `userEvent.type` into a React 19 controlled `<textarea>` interleaves the old value with the typed characters.
- **Fix:** `fireEvent.change` sets the value in one step. The comments in `recipe-comments.test.tsx` show the pattern.
- **Source:** `00ac823`.

### A long-press drag doesn't start in Chrome's device emulator

- **Cause:** the emulator fires touch sequences, long-press especially, unreliably.
- **Fix:** test the gesture on a real phone before debugging the dnd-kit sensors.
- **Source:** 2026-06-20 session notes.

### A route shows its parent's page with no content

- **Cause:** TanStack Router treats a dot in a route filename as layout nesting, and the parent renders no `<Outlet />`.
- **Fix:** a trailing underscore on the parent segment opts out, as in `routes/_authed/plans/$planId_.shopping.tsx`. The route id changes to match, for example for `useParams({ from })`.
- **Source:** `650b26f`.
