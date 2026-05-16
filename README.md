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
