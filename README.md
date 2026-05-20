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

This boots Postgres 17 on host port `5433` with two databases — `lofty_dev`
and `lofty_test` — and the `pg_trgm` extension installed in each. Data
persists in the `loftys_larder_pgdata` named volume.

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

## Deploy

Production runs on Fly.io (`loftys-larder-prod`, region `lhr`) behind
Cloudflare orange-cloud DNS. From FEAT-48 onwards CI handles deploys on
push to `main`; until then, deploy manually from a clean working tree:

```sh
flyctl deploy --release-command "pnpm drizzle-kit migrate"
```

Rollback (re-pins the previous release):

```sh
flyctl releases rollback
```

First-time setup — domain purchase, `flyctl apps create`, custom-domain
attach, Cloudflare DNS and cache rules — is one-shot and documented as
a runbook in `docs/session-notes.md`. Every command run there should be
captured verbatim; FEAT-50 lifts the sequence into `OPERATIONS.md`.
