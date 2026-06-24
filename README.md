# Lofty's Larder

A single-household web app for managing recipes, planning meals across custom date ranges, and generating aggregated, category-grouped shopping lists.

## Why

Two cooks sharing one kitchen want one dataset: a library of recipes, a meal plan they can both edit from their phones, and a shopping list that adds up exactly what the plan needs. Off-the-shelf planners assume per-serving data entry, snapshot recipes so edits don't propagate, and bolt on features (pantry tracking, URL import, AI suggestions) that two people who already cook don't need. Lofty's Larder is deliberately narrow: whole-recipe quantities scaled by serving count, recipes referenced by FK so edits flow through to plans, and a shopping list that's a printable, offline-readable checklist. It is built for one household — not a SaaS product.

## Status

Honest state: **all six build phases are implemented in code, but the project has not completed its human verification gate or a real production launch.** It is best described as feature-complete and pre-launch, not "shipped."

What's in the tree and working:

- **Backend** — Fastify + tRPC + Drizzle. Procedures for health, ingredients, recipes, recipe drafts, plans, slots, shopping list, plant points, uploads, and user/account. Nine migrations covering auth, the recipes domain, meal plans, and shopping-list items.
- **Frontend** — Vite + React + TanStack Router/Query + shadcn/ui. Sign-in, settings, ingredient dictionary, recipe browse/detail/editor, planner grid with click-to-assign, plan list, and shopping list. Component tests alongside each page.
- **Auth** — magic-link via Better Auth + Resend, gated to an allow-list. No passwords.
- **PWA** — service worker + manifest; network-first cache for the shopping-list read with offline check-state queue and reconnect sync. (Icons are placeholder art — final brand assets are tracked separately.)
- **Observability & ops** — Pino → Axiom with `req.id` propagation, Sentry front + back with PII scrubbing, rate limiting, explicit CSP, `/api/health`. CI, deploy, and nightly `pg_dump` → R2 backup workflows are in `.github/workflows/`.
- **Tests** — Vitest + Testcontainers (backend), React Testing Library (frontend), and six Playwright critical-path specs including an `axe-core` a11y spot-check.

What's outstanding / not done:

- **Definition-of-Done boxes in `docs/feature-specs.md` are all unticked — by design.** Verification is a human action in this project; "implemented + tests pass" is the agent's ceiling.
- **Restore drills have not been rehearsed.** `OPERATIONS.md` documents both restore paths and rollback, but the rehearsal log is empty — the procedures are written and reviewed, not yet validated against a real cluster.
- **Cold-start has not been measured empirically** (FEAT-52). Auto-stop is enabled with a 3-second budget; the always-on decision waits on a real measurement.
- **No confirmed public deployment.** The Fly app (`loftys-larder-prod`, `lhr`) and Cloudflare setup are configured; first-time domain/app provisioning is a documented runbook, not a completed launch.

## Running it

There is no public demo — it's a private, allow-list-gated single-household app. To run locally:

**Prerequisites:** Docker (Compose v2), Node (version pinned in `.nvmrc`, `nvm use`), pnpm 10.x.

```sh
pnpm install

# Postgres (port 5433; creates lofty_dev, lofty_test, lofty_e2e with pg_trgm)
cp .env.example .env
docker compose up -d postgres

# Backend — edit BETTER_AUTH_SECRET, RESEND_API_KEY, MAGIC_LINK_ALLOWED_EMAILS
cp backend/.env.example backend/.env
pnpm --filter backend dev        # http://localhost:3000

# Frontend (separate terminal)
pnpm --filter frontend dev       # http://localhost:5173, proxies /api/* to backend
```

The backend refuses to boot without its required env vars (validated at startup). A real Resend key is only needed for a magic-link email to actually arrive; magic-link requests for addresses not on `MAGIC_LINK_ALLOWED_EMAILS` are silently dropped. Smoke test: open `/sign-in`, enter an allow-listed email, click the link. See the git history of this file for the fuller dev runbook (gate checks, PWA notes, e2e setup).

**Quality gates** (same as CI):

```sh
pnpm format:check && pnpm -r lint && pnpm -r typecheck && pnpm -r test
```

## Architecture

A pnpm monorepo with three workspaces: `/backend` (Fastify + tRPC + Drizzle), `/frontend` (Vite/React), and `/shared` (the type pipeline — shared Zod schemas and a type-only export of the tRPC `AppRouter`). The backend's tRPC router is the single source of truth for API shapes; the frontend imports its *type* (not runtime) and calls procedures with full inference via `@trpc/react-query`, so there's no codegen and no possible front/back drift. Forms validate against the same Zod schemas the procedures use. In production a single Fly.io app serves the API at `/api/*` and the built frontend at the root (same-origin, no CORS); in dev, Vite's proxy reproduces same-origin against a separate Fastify process. Full strategy, data model, and build order in [`docs/plan.md`](docs/plan.md).

## Stack

| Concern | Choice | Why |
|---|---|---|
| Frontend | React + Vite | Fast dev loop; clean fit with shadcn/ui and TanStack |
| Routing | TanStack Router | Typed routes; planner date range lives in URL search params |
| Server state | TanStack Query via `@trpc/react-query` | Caching + optimistic updates for snappy slot assignment |
| Forms | React Hook Form + Zod | Same Zod schemas as the API; minimal re-renders |
| Styling | Tailwind + shadcn/ui | Utility-first; components owned outright; dark mode built in |
| Backend | Fastify | Native async, first-class TS types, low per-request overhead |
| API contract | tRPC | Typed RPC for one TS client + one TS server; no codegen, no drift |
| Validation | Zod | One validation library end-to-end |
| Database | PostgreSQL (Fly Postgres prod, Docker dev) | Trigram search, mature, in-region private networking |
| ORM | Drizzle | Schema-as-code + migrations; SQL-like queries without losing types |
| Search | `ILIKE` + `pg_trgm` GIN index | Indexed substring search; trivial upgrade path to FTS |
| Auth | Better Auth + Resend magic links | Passwordless removes all credential management |
| Media | Cloudinary direct browser upload | Binary never touches the API path |
| Logging / errors | Pino → Axiom; Sentry front + back | Structured logs + symmetric error capture with PII scrubbing |
| Host | Fly.io (`lhr`, auto-stop) behind Cloudflare | Docker-native, idle-cheap, edge caching + TLS |
| Tests | Vitest + Testcontainers, RTL, Playwright | Real Postgres in tests; component + critical-path E2E |
| CI/CD | GitHub Actions + `flyctl` | Sufficient at this scale; deploy on push to `main` |

## Decisions and trade-offs

A few of the more consequential ones — the full log (86 entries) is in [`docs/design-decisions.md`](docs/design-decisions.md):

- **Recipes are referenced by FK, never snapshotted onto slots (DEC-22).** Editing a recipe propagates to past plans. Snapshotting was rejected as copy-on-assign complexity for a problem nobody at household scale has; the shopping list's quantity-bound check-reset covers the only mid-shop surprise.
- **Single enforced unit per ingredient (DEC-18).** Shopping-list aggregation stays a pure sum with no conversion table. The cost is paid by the data-entry user (manual conversion), not the cooking user.
- **Single-household MVP with a multi-tenancy-*ready* schema (DEC-17).** Domain tables carry `householdId` and code reads a `CURRENT_HOUSEHOLD_ID` constant — but there's no scope resolver, no membership joins. The future tenancy mechanism is unknown enough that pre-building an abstraction would likely fit none of them.
- **Last-write-wins everywhere (DEC-36).** No row-version columns, no locks. "Last device to sync wins" is the accepted shopping-list trade-off; a CRDT-lite design is the named upgrade path if real conflicts appear.
- **All user text is plain text (DEC-49).** No markdown, no HTML, no `dangerouslySetInnerHTML` — React's escaping is the XSS mitigation.
- **No staging environment (DEC-65).** Migrations run against prod via Fly `release_command`. Testcontainers tests (exercising the actual SQL Drizzle emits) plus rehearsed restore drills are the mitigation.
- **Account deletion is tombstoning, not cascade (DEC-29).** A leaving cook can't take the shared library with them; `addedBy`/`createdBy`/`chefUser` columns go null.

## Roadmap / non-goals

This project's negative space is documented as carefully as its features. Pantry tracking, recipe URL import, AI suggestions, cross-household sharing, grocery-API integration, dietary/allergen filtering, and per-user timezones are explicit non-goals — each with the reasoning and the condition that would force a revisit. Deferred decisions (multi-tenancy mechanism, shopping-list conflict resolution beyond LWW, email-provider fallback, always-on vs auto-stop) are tracked with their trigger conditions. See [`docs/non-goals.md`](docs/non-goals.md).

## License

No license. This is a private, single-household project — not published for reuse or distribution. All rights reserved.
