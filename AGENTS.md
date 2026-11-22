# AGENTS.md — Lofty's Larder

Lofty's Larder is a meal-planning PWA for one household: recipes, meal plans, shopping lists, health scores and storage. Shipped through FEAT-81.

**Posture: ask, don't assume.** A question costs a paragraph; an unwanted decision costs a revert and a DEC update. When a rule here disagrees with your instinct, the rule wins: say so, then follow it.

## Docs

Read the part a task needs, not the whole set.

| Doc | Holds | Read it when |
|---|---|---|
| `README.md` | What ships today, and how to run it | Setting up, or a change alters what ships |
| `CONTEXT.md` | Domain glossary, terms only | A term in a FEAT or DEC is unclear |
| `docs/feature-specs.md` | FEAT-01 … FEAT-82, and cross-cutting concerns #1–#23 (§Cross-feature concerns) | Working on a FEAT: read that FEAT and the concerns it threads through |
| `docs/design-decisions.md` | DEC-01 … DEC-118 | A FEAT cites a DEC, or a change touches behaviour a DEC decides |
| `docs/plan.md` | Strategy, data model, build order | A FEAT or DEC cites a section |
| `docs/non-goals.md` | What v1 leaves out, and why | Work drifts towards something no FEAT asks for |
| `docs/gotchas.md` | Symptoms with surprising causes, and non-obvious lookups | Debugging: grep it for the error text first. Changing an area: read its section |
| `docs/session-notes.md` | Open questions and work in flight | Starting a session: read the newest entry |
| `.claude/skills/` | The steps the user runs: `/feat-kickoff`, `/feat-implement`, `/feat-verify`, `/feat-review`, `/investigate-bug` | Asked in words to kick off, implement, verify, review or investigate a bug: read and follow the matching `SKILL.md` |
| `OPERATIONS.md` | Production: secrets, alerts, releases and rollback, restores, rate limits | Before any `flyctl` command or production change |

A FEAT goes kick-off → approval → implement → verify, one skill per step.

## Commands

The `package.json` scripts are the source of truth. When one is missing, ask before inventing it.

- Check everything: `pnpm format:check && pnpm -r lint && pnpm -r typecheck && pnpm -r test`
- Dev: `pnpm dev` starts Postgres, migrates, seeds, then runs the backend (`:3000`) and frontend (`:5173`).
- e2e: `pnpm --filter backend build`, then `pnpm e2e`. Playwright runs the built server.
- New migration: `pnpm --filter backend db:generate`.
- Deploy: CI deploys `main` after it passes; `fly.toml`'s `release_command` migrates and seeds. Rollback is in `OPERATIONS.md` § Releases and rollback.

## Workspaces

pnpm workspaces with no build orchestrator (DEC-03).

| Workspace | Holds | Imports |
|---|---|---|
| `/backend` | Fastify, tRPC procedures, Drizzle schema and migrations, Better Auth; shared helpers in `src/lib/` | `/shared` |
| `/frontend` | The React PWA | `/shared`; `import type` for `AppRouter` |
| `/shared` | Zod schemas and DTOs (`src/schemas/`), the `AppRouter` type, pure functions both sides run | nothing at runtime |
| `/e2e` | Playwright specs, fixtures and the e2e database setup | nothing from the other workspaces |

`/shared`'s one reach into `/backend` is the type-only `export type { AppRouter }` in `shared/src/router-type.ts`, erased at compile time (DEC-80).

## Rules

Each rule names its source. A task that seems to need one bent is a stop-and-ask.

**Toolchain**
- ESM-only: every `package.json` is `"type": "module"`, with `NodeNext` module resolution. Check that a new dependency ships ESM before proposing it. (DEC-01, concern #20)
- Strict TypeScript on Node 24 LTS, pinned in `engines`, `.nvmrc` and the Dockerfile. (DEC-02)
- Prettier formats and ESLint lints, with `@typescript-eslint` strict-type-checked rules on purpose; husky runs lint-staged on commit. Auto-fix freely (`pnpm lint:fix`). When the hook fails, fix the cause and re-stage. CI is the source of truth: a local pass that fails in CI means the local Node or pnpm has drifted. (FEAT-07)
- Logging goes through Pino, the only output Axiom sees. (FEAT-03, DEC-75)
- `req.id` travels as `reqId`, the same value in Pino, Axiom and Sentry; pass it on as it is. (DEC-77, concern #1)
- Comments explain a *why* the code can't show, and nothing else.
- Tests check behaviour, with no coverage threshold. Backend tests run against real Postgres in Testcontainers. (DEC-56, DEC-59)

**Data and domain**
- Every query on a household-scoped table filters on `household_id = CURRENT_HOUSEHOLD_ID`, a constant in `backend/src/config.ts`, not a resolved scope. `addedBy` and `createdBy` are informational, never an authorisation check. (DEC-17, concern #3)
- Zod schemas and DTOs live in `/shared/src/schemas/`; procedures and forms import them. (concern #2)
- `snake_case` in the database, `camelCase` in code, mapped by Drizzle; a raw SQL fragment uses `snake_case`. `updatedAt` comes from Drizzle's `$onUpdate`, so every write goes through Drizzle. (DEC-15, DEC-16)
- Multi-statement writes go through `withTransaction` (`backend/src/db/withTransaction.ts`). DEC-114's sign-in counters are the one recorded exception. (concern #4)
- Time is Europe/London for everyone, through the date module (`backend/src/lib/date-utils.ts`, `frontend/src/lib/date-utils.ts`). Domain code gets "now" from it rather than `new Date()`. (DEC-33, concern #8)
- Recipes are soft-deleted, because past plans still render them. What a picker may offer comes from `backend/src/lib/pickable-recipes.ts`. (DEC-21, concerns #5, #19)
- Slots reference recipes by FK, so recipe edits reach past plans. (DEC-22)
- One unit per ingredient; users convert when they enter a quantity. (DEC-18)
- Quantities are for the whole recipe, with an explicit `baseServings`. (DEC-19)
- A recipe is a base (`is_base`), a variation of one base (`base_recipe_id`), or standalone, two levels at most; a CHECK enforces it. (DEC-23, DEC-87)
- A slot's state is its `slot_type` enum (`empty`, `recipe`, `eat_out`, `takeaway`, `leftovers`), not a placeholder recipe. (DEC-25)
- Plant points are computed on read, never stored. (DEC-32)
- Every write that concern #21 lists calls `markHealthScoreStale` inside its transaction: a recipe's ingredients, method text, servings, nutrition or base. (DEC-101)
- Every read that shows held stock, or plans against it, calls `settleReservations` (`backend/src/lib/stock-settlement.ts`) first, inside its transaction. A read that skips it shows food already eaten. (DEC-118, concern #23)
- Shared resources are last-write-wins, with no row-version columns or concurrency tokens. (DEC-36)
- Account deletion tombstones, in FEAT-35's sequence, rather than cascading. A new table with a user FK extends that sequence. (DEC-29, concern #15)
- A domain error is a `TRPCError` with the tRPC code on `code` and `{ code, ...metadata }` on `cause`. (DEC-35, concern #11)
- A feature that calls a model gets its own seam with a `fake` adapter, `<FEATURE>_ADAPTER` and `<FEATURE>_MODEL` config, its rules applied outside the seam, and metadata-only logs. Before its first deploy, send one real request through the real adapter. (DEC-109, DEC-110, concern #22)

**Frontend**
- Files under `frontend/src/routes/` export only `Route`; page bodies and `beforeLoad` live in `routes/-components/`, because TanStack Router's auto-code-split can only split `Route.options.component`.
- Optimistic updates reuse `useOptimisticSlotUpdate` (`frontend/src/hooks/`). A sibling hook mirrors its `onMutate` / `onError` / `onSettled` scaffold rather than forking it. (concern #7)
- `SearchableCombobox` is the one combobox. (FEAT-21, concern #6)
- The slot card grows through its named content regions. (FEAT-31, concern #14)
- The planner has three widths: one card per day below `md`, the grid from `md`, and the Recipe Bank with bank → slot drag from `lg`. Slot ↔ slot drag works at every width (a 200 ms touch-and-hold lifts a slot). Below `lg`, recipes are assigned through the slot-editor sheet. (DEC-84, DEC-85, DEC-115, FEAT-40)

**API, auth and edge**
- Keep `httpBatchLink`'s `/api/trpc/<procedure>?batch=1&input=…` shape: the PWA's cache rules match on the procedure segment. (concern #16)
- Images upload from the browser straight to Cloudinary with signed credentials, never through Fastify. (DEC-50, DEC-68)
- Sign-in is passwordless: a one-time code emailed through Better Auth's `emailOTP` plugin. Better Auth owns its tables; domain code references `user_id` and keeps the boundary small. (DEC-41, DEC-42, DEC-114, concern #17)

**Production**
- One Fly app in `lhr`, auto-stopping, with a 3-second cold-start budget. Going always-on needs a measurement first. (DEC-63, DEC-64, FEAT-52)
- There is no staging environment: Testcontainers tests and restore drills are the safety net, and `release_command` runs migrations on deploy. (DEC-40, DEC-65)

## Ask first

Stop and ask before:

- contradicting a DEC, or settling a FEAT reading that would change one
- work that drifts into `docs/non-goals.md`
- adding a dependency (check its ESM support when proposing it)
- a schema change the approved plan didn't include: table, column, FK, constraint or index
- changing a shared piece: `withTransaction`, the date module, `pickable-recipes`, `settleReservations`, the optimistic-update hook, the slot card, the combobox or the tRPC link
- widening the auth surface beyond reading the session
- mocking the database in a test (Testcontainers is the pattern)
- adding an `eslint-disable`, `@ts-expect-error`, `@ts-ignore` or `prettier-ignore`, or changing `eslint.config.js` or `.prettierrc`
- choosing between two libraries or patterns that no DEC decides
- writing the same logic in a third place with no shared helper (it's probably a new cross-cutting concern)
- acting on acceptance criteria that are ambiguous, contradictory or incomplete

## Never

Hard guardrails, each with what to do instead:

- **Ticking a box.** The user ticks acceptance-criteria and Definition-of-done boxes in `docs/feature-specs.md`, and judges each phase gate. Report the evidence for each: a test name and file, or a manual probe and its output.
- **Rendering text as HTML.** User text is plain, with no markdown or rich text, and goes through React's escaping, with no `dangerouslySetInnerHTML`. (DEC-49)
- **Committing with `--no-verify`.** Fix what the hook caught.
- **Putting FEAT numbers in code.** Filenames, migration names and test `describe()` strings describe behaviour; FEAT numbers belong in docs.

## Tech stack

Anything outside this table is a new dependency: ask first.

| Concern | Use |
|---|---|
| Frontend | React + Vite (DEC-04); TanStack Router, with the date range in search params (DEC-10); TanStack Query through `@trpc/react-query` (DEC-08); `useState` and Context for client state (DEC-09) |
| Forms and styling | React Hook Form + Zod resolver (DEC-11); Tailwind + shadcn/ui (DEC-51) |
| Backend and API | Fastify (DEC-05); tRPC, with types through `/shared` (DEC-06); Zod (DEC-07) |
| Database | PostgreSQL: Fly Postgres in production, Docker Compose running Postgres only in dev (DEC-12, DEC-74); Drizzle (DEC-13); `ILIKE` + `pg_trgm` GIN index for search (DEC-14) |
| Auth and mail | Better Auth emailed one-time code (DEC-42, DEC-114); Resend (DEC-69) |
| Media | Cloudinary, uploaded straight from the browser (DEC-68) |
| Models | Anthropic, behind each feature's seam (DEC-109, concern #22) |
| Observability | Pino → Axiom (DEC-75); Sentry front and back, with a `beforeSend` PII scrub and no session replay (DEC-76) |
| Edge and hosting | Cloudflare orange-cloud DNS with an `/api/*` cache bypass (DEC-72); Fly.io in `lhr` (DEC-63) |
| Build | `tsx watch` in dev; one esbuild bundle in production (DEC-61) |
| Tests | Vitest + Testcontainers, React Testing Library, Playwright with `storageState` (DEC-56, DEC-57, DEC-58) |
| CI/CD | GitHub Actions + `flyctl` (DEC-66) |

## Working in the repo

- Commit or push only when the user asks. Messages follow Conventional Commits, and each FEAT's Definition of done proposes one.
- Record readings agreed at kick-off, drift and open questions in `docs/session-notes.md`, newest entry first. Delete an entry once its work is committed and nothing in it is open, after moving any gotcha or lookup in it to `docs/gotchas.md`.
- A fix whose cause was hard to find adds a `docs/gotchas.md` entry in the same commit, unless a guard or a comment where it bites now explains it.
- Change this file in the same commit as the rule or command it describes, and delete lines that stop being true.
