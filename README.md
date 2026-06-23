# Lofty's Larder

A single-household meal planner. See `docs/plan.md` for the strategy and
`docs/feature-specs.md` for the executable feature list. `AGENTS.md` is the
contract for working in this repo — read it before contributing.

## Local dev

### Prerequisites

- Docker (Compose v2)
- Node — version pinned in `.nvmrc` (`nvm use` picks it up)
- pnpm 10.x

### Start Postgres

```sh
cp .env.example .env
docker compose up -d postgres
```

This boots Postgres 17 on host port `5433` with three databases — `lofty_dev`,
`lofty_test`, and `lofty_e2e` — and the `pg_trgm` extension installed in each.
Data persists in the `loftys_larder_pgdata` named volume.

If your volume predates the `lofty_e2e` DB, create it once with
`docker exec loftys-larder-postgres psql -U lofty -d lofty_dev -c 'create database lofty_e2e'`
followed by
`docker exec loftys-larder-postgres psql -U lofty -d lofty_e2e -c 'create extension if not exists pg_trgm'`.

The host port is intentionally non-default to avoid collisions with a system
Postgres on 5432. Override via `POSTGRES_HOST_PORT` in `.env` if needed.

### Gate check

```sh
psql "$DATABASE_URL" -c 'select version();'
psql "$DATABASE_URL" -c '\dx'           # pg_trgm should be listed
psql "$DATABASE_URL_TEST" -c '\dx'      # same on the test DB
```

### Tear-down

- `docker compose down` — stops the container, keeps the volume.
- `docker compose down -v` — also removes `loftys_larder_pgdata` and wipes
  all local data.

> Note: backend integration tests (added in a later FEAT) use Testcontainers
> for ephemeral per-run isolation rather than `lofty_test` in the Compose
> Postgres. The in-Compose test DB is for ad-hoc scripts and manual probing.

### Run the backend

```sh
cp backend/.env.example backend/.env
# Edit BETTER_AUTH_SECRET, RESEND_API_KEY, and MAGIC_LINK_ALLOWED_EMAILS to
# values for your machine. The other vars work out of the box.
pnpm --filter backend dev
```

The backend refuses to boot without `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, `RESEND_API_KEY`, `MAGIC_LINK_TRUSTED_ORIGIN`, and
`MAGIC_LINK_ALLOWED_EMAILS` (config validation runs at startup). A real Resend
API key is only needed if you want a magic-link email to actually arrive — for
plain server-boot you can leave the placeholder; the send call only fires when
someone hits `/api/auth/sign-in/magic-link`.

Magic-link requests are gated by `MAGIC_LINK_ALLOWED_EMAILS` (comma-separated).
Requests for any address not on the list are silently dropped — by design
(single-household MVP).

> `tsx watch` reloads on source changes, **not** on `backend/.env` changes.
> If you edit `.env` (allow-list, API keys, anything), Ctrl-C and re-run
> `pnpm --filter backend dev` (or `pnpm dev` at the repo root) for the new
> values to take effect.

### Run the frontend

```sh
pnpm --filter frontend dev
```

Vite serves on `http://localhost:5173` and proxies `/api/*` to the backend
(default `http://localhost:3000`, override via `BACKEND_URL`). The backend
must be running for sign-in to work.

Smoke test the magic-link flow: open `http://localhost:5173/sign-in`, enter
an email on `MAGIC_LINK_ALLOWED_EMAILS`, and check that inbox. Hitting `/`
without a session redirects to `/sign-in`.

### PWA install + offline shopping list

Production builds register a service worker via `vite-plugin-pwa`
(`registerType: 'autoUpdate'`). The shopping-list tRPC read
(`shopping.getForPlan`) uses a `NetworkFirst` runtime cache with a 3-second
timeout, so killing connectivity and reloading still renders the last
fetched list. Dev builds skip SW registration to keep Vite HMR clean. The
manifest + icons live under `frontend/public/icons/` (placeholder art; the
swap for final brand assets is tracked separately). See DEC-86 for the
cache shape and trade-offs.

## Quality gates

ESLint (typed, `@typescript-eslint` strict-type-checked) and Prettier own
code quality and formatting. Husky runs `lint-staged` on `pre-commit`,
applying Prettier and `eslint --fix` to staged files.

The same commands run in CI on every push (any branch) and PRs to
`main`, in `.github/workflows/ci.yml`:

```sh
pnpm format:check     # prettier --check
pnpm -r lint          # eslint per workspace
pnpm -r typecheck     # tsc per workspace
pnpm -r test          # vitest per workspace
```

To auto-fix locally:

```sh
pnpm format           # write Prettier changes
pnpm lint:fix         # eslint --fix
```

### End-to-end tests

Playwright covers the critical-path flows against the bundled backend +
frontend (per DEC-58). Locally:

```sh
cp e2e/.env.example e2e/.env             # one-time
pnpm --filter @loftys-larder/e2e install:browsers   # one-time, ~150 MB
pnpm --filter @loftys-larder/e2e prepare-db
pnpm --filter @loftys-larder/frontend build
pnpm --filter @loftys-larder/backend build
pnpm e2e
```

The suite uses `lofty_e2e` and resets its household-scoped tables before each
spec. The frontend `build` and backend `build` outputs are what Playwright's
`webServer` runs — same artefact shape as production.

## Deploy

Production runs on Fly.io (`loftys-larder-prod`, region `lhr`) behind
Cloudflare orange-cloud DNS. From FEAT-49 onwards CI handles deploys on
push to `main`; until then, deploy manually from a clean working tree:

```sh
flyctl deploy
```

The database migration runs automatically as Fly's `release_command` (defined
in `fly.toml`) before the new release takes traffic — it boots the runtime
image and runs `node /app/migrate.js`, a bundled drizzle-orm migrator, so
production never needs `drizzle-kit`.

Rollback (re-pins the previous release):

```sh
flyctl releases rollback
```

First-time setup — domain purchase, `flyctl apps create`, custom-domain
attach, Cloudflare DNS and cache rules — is one-shot and documented as
a runbook in `docs/session-notes.md`. Every command run there should be
captured verbatim; FEAT-51 lifts the sequence into `OPERATIONS.md`.
