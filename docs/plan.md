# Lofty's Larder — Plan

## Overview

A web app for one household to manage recipes, plan meals across custom date ranges, and generate aggregated shopping lists. Two cooks share one dataset.

The core flow: build a library of recipes (photos, macros, ingredients, method); assign recipes to slots in a meal plan with per-meal serving counts; generate a categorised shopping list with shelf-life warnings.

MVP is **single-household** — all authenticated users share one dataset. The data model carries `householdId` so a future multi-tenancy migration would be a localised change, but no application-layer multi-tenancy machinery is built today.

---

## User Requirements

### Recipes & ingredients

Users maintain a master ingredient list with: name, supermarket category, single enforced unit of measurement, optional shelf life in days, and an `is_plant` flag. Recipes reference these ingredients with quantities expressed in the ingredient's enforced unit.

**Recipe ingredients are entered for the whole recipe, not per serving.** Every recipe carries an explicit `BaseServings` value. This matches how recipes are written in the wild (sources state "serves 4," not per-portion quantities) — easier data entry, more natural source ingestion. The shopping list scales by `qty × (slotServings / baseServings)`. Recipes also have manually-entered per-serving macros, an ordered method, optional photo, source link, cooking times, and a soft-delete flag.

The single-unit-per-ingredient rule is a deliberate invariant. If an ingredient is recorded in cloves, every recipe using it requests cloves; users convert manually when entering recipes from sources that use different units. This keeps shopping list aggregation a pure sum and is accepted as a UX limitation.

A recipe may list the same ingredient multiple times (e.g., "1 onion sliced" and "1 onion diced") — `recipe_ingredients` uses a surrogate key, not a (recipe, ingredient) composite.

**Recipe edits propagate to past plans.** Recipes are referenced by FK from meal plan slots, not snapshotted at assignment time. Editing a recipe's ingredients or quantities affects past plan plant-points and any not-yet-generated shopping list. This is accepted — snapshotting would add copy-on-assign storage and substantial complexity to ingredient-mutation paths for a household-scale benefit no one is asking for. Quantity-bound check-state reset (see Shopping list) covers the only mid-shop surprise case.

**Batch cooking.** Some recipes are intended as building blocks rather than complete meals — a pot of lamb keema base, a tray of roast vegetables, a batch of dal. These are flagged with `is_base = true` and can be referenced by other recipes via `base_recipe_id` to declare those as *batch-version* recipes — accompaniment-only recipes that assume the base is already cooked. "Keema with flatbread (batch)" lists only flatbread ingredients; "Keema with flatbread (full)" is a regular complete recipe with both the keema and the flatbread ingredients, used in non-batch weeks. A batch-version recipe cannot itself be a base (no nesting).

Full and batch variants of the same dish can be linked via `paired_recipe_id` so the slot editor offers a "switch to full / switch to batch" affordance at plan time. Pairing is one-to-one and maintained symmetrically at the application layer on save. The pair affordance is hidden when the linked recipe is soft-deleted.

When a base recipe is soft-deleted, batch recipes referencing it remain visible in past plans but are hidden from the recipe picker for new slots — same posture as soft-deleted related recipes.

### Plant points

Computed (never stored) as `COUNT(DISTINCT ingredient_id) WHERE is_plant = true`. Exposed at three granularities:

- **Per recipe** — distinct plant ingredients in the recipe.
- **Per day in a plan** — distinct plant ingredients across all that day's meals.
- **Per plan** — distinct plant ingredients across the plan as a whole.

For batch-version meal slots, the plant ingredient set traverses the meal's `base_recipe_id` so days running on leftovers don't appear plant-poor. When a slot also cooks a base (`cooks_base_recipe_id`, see Meal plans), those ingredients join the union — deduplication handles the common case where the meal's referenced base and the cooked base are the same recipe.

### Meal plans

A plan covers a custom date range with one slot per (day × meal occasion); occasions are Lunch and Dinner for v1. Each slot has one of five states: `empty`, `recipe`, `eat_out`, `takeaway`, `leftovers` — implemented as a typed enum on the slot row, **not** as dummy recipes.

**Slot assignment uses click-to-assign.** Tap a recipe in the sidebar to select it; tap an empty slot to assign. Assigned slots are tappable to edit servings, change recipe, or clear. This interaction model is touch-first (the primary use is on phones in kitchens), faster than drag-and-drop for bulk planning, and works identically with mouse and keyboard — satisfying WCAG 2.1 AA without dedicated DnD a11y machinery.

- **Overlap rule:** new plans cannot overlap with non-deleted plans whose `endDate >= today`. Past plans are not considered.
- **Date-range edits:** shrinking a plan deletes out-of-range slots after explicit confirmation; extending generates new empty slots.
- **Duplication:** copies slot assignments to a new start date; the new plan inherits the original's duration exactly.
- Plans can be drafted, listed by status (active/past/future/all), and soft-deleted.

**Base cooking on slots.** A slot can cook a base recipe alongside its meal via two optional fields, `cooks_base_recipe_id` and `cooks_base_servings`. Today's lunch can be "Keema with flatbread (batch)" eaten × 1 *and* cook "Lamb keema base" × 2 in the same occasion — the slot's planner card shows both lines. Tomorrow's lunch can be "Keema with jacket potato (batch)" eaten × 1 with no base cook, drawing on yesterday's supply. The slot editor surfaces two recipe pickers: "What are you eating?" (any recipe) and "Cooking a base for batch use?" (optional, filtered to recipes with `is_base = true`); selecting a batch-version meal pre-suggests the meal's referenced base but doesn't force the user's hand. The cooked base is decoupled from the meal's referenced base, so a takeaway slot can still prep a base for tomorrow's batch meal. When a batch-version meal has no base supply earlier in the plan or in the same slot, the planner shows a soft warning but doesn't block save.

### Shopping list

Generated from a plan, aggregated by ingredient, grouped by supermarket category. Each line shows total quantity, the recipes contributing, and a check-state that **persists server-side**. Check-state is quantity-bound: if a slot edit changes the total quantity for an ingredient, that line resets to unchecked. The reset is deliberate — checking a line records the user's commitment to buy a specific quantity; if it changes meaningfully, that commitment needs reaffirming. Accepted over warn-only; revisitable if user feedback says it surprises rather than helps.

When a slot cooks a base (`cooks_base_recipe_id` is set), the base recipe's ingredients are aggregated alongside the meal recipe's ingredients on the same shopping list, scaled by `cooks_base_servings`. Batch-version meal recipes contribute only their accompaniment ingredients — the base is bought via the base-cook contribution in this or an earlier slot.

**Shelf-life warning** assumes shopping happens on plan start date (single-shop assumption — documented v1 limitation). Warns if *any* meal using the ingredient falls past `(planStart + shelfLifeDays)`, and surfaces the latest-needed date so the user can plan a second shop.

`eat_out` / `takeaway` / `leftovers` slots contribute nothing to the meal-recipe part of the list; a base cook on any slot type still contributes its base ingredients.

### Ratings & comments

Each user has at most one rating per recipe (1–5). Recipe summaries show average across all users; recipe details additionally show the logged-in user's own rating. Comments are per-user, ordered newest-first by default, editable and deletable only by their author.

**All user-generated text — comments, recipe names, descriptions, method steps — is stored and rendered as plain text.** No markdown, no rich text, no HTML. React's default text-content escaping is the XSS mitigation; `dangerouslySetInnerHTML` is not used anywhere.

### Related recipes

Manually-linked pairs. Symmetric (showing on both recipes), no self-links, no duplicates. Enforced at DB level: composite PK on `(recipeOneId, recipeTwoId)` with `CHECK (recipeOneId < recipeTwoId)`. Soft-deleted recipes are hidden from related lists in the UI but remain in the table for historical plan rendering.

### Account & auth

**Magic-link auth via Better Auth.** Users sign in by entering their email; Better Auth sends a magic link via Resend that expires in 10 minutes. Clicking the link establishes a session. There are no passwords — credential management is removed entirely. Magic links work cross-device (request on phone, click on laptop) and same-device.

A user can update their profile (name, theme preference) and delete their account.

User profile includes a `themePreference` (`system` / `light` / `dark`, default `system`).

**Account deletion is not a cascade.** It:

1. Deletes the user's rows in `recipe_ratings`.
2. Sets `recipe_comments.userId = NULL` (rendered as "[deleted user]").
3. Sets `recipes.addedByUserId = NULL`.
4. Sets `meal_plans.createdByUserId = NULL`.
5. Sets `meal_plan_slots.chefUserId = NULL`.
6. Deletes the user's rows in `recipe_drafts` (drafts are personal and not preserved).
7. Removes the user row.

This preserves household data integrity when a member leaves or rage-quits.

### Non-functional requirements

- **Responsive** across mobile, tablet, desktop. Phone-first; the planner and shopping list are designed for one-handed kitchen use.
- **Theming.** System / light / dark with explicit toggle, persisted per-user in the DB so preference follows the user across devices.
- **Auth:** HttpOnly session cookies (Better Auth defaults); `SameSite=lax`; CSRF token validation enabled.
- **CORS:** restricted to the deployed frontend origin in **dev only** — production is same-origin via `@fastify/static`, so CORS plays no role in prod.
- **Rate limiting** via `@fastify/rate-limit`: 100 req/min per IP for unauthenticated routes, 300 req/min per session for authenticated. Magic-link request endpoint has its own tighter limit (5 requests per email per hour) to prevent email-spam abuse.
- **Security headers** via `@fastify/helmet`: HSTS, X-Frame-Options, secure-cookie flags. CSP is configured explicitly rather than relying on defaults: `img-src` includes `res.cloudinary.com` and `data:`; `connect-src` includes Sentry's browser ingest endpoint; `script-src` and `style-src` allow `'self'` plus the minimum needed for shadcn's styles; everything else defaults to `'self'`.
- **PII handling in error tracking.** Sentry's `beforeSend` strips cookies, authorization headers, and email addresses from captured payloads. Session replay is disabled in v1 — keeps the GDPR posture simple and avoids a cookie-consent banner.
- **Request tracing.** Pino HTTP generates a `req.id` per request and logs it on every entry; attached to Sentry events as a tag for cross-reference between logs and errors.
- **Accessibility:** WCAG 2.1 AA on primary flows, validated via `axe-core` in Playwright against both light and dark themes.
- **Shopping list offline:** PWA with cached last-fetch — the most recent shopping list is readable without connectivity. Service worker uses **network-first** for the shopping list GET (always show server truth when reachable, fall back to cache on failure or timeout). Check-state changes queue locally and sync on reconnect.
- **Edge / CDN.** Cloudflare proxies the Fly app (orange-cloud DNS). Static asset caching and DDoS protection at the edge; `/api/*` is set to bypass cache. TLS terminates at Cloudflare; Fly's origin cert remains for the Cloudflare-to-Fly hop.
- **Observability alerts:** Sentry alert when frontend or backend errors exceed an absolute threshold (>5 errors per 5 minutes). Percentage-based thresholds are unsuitable at low traffic — one user's flake would page constantly.
- **Concurrency:** last-write-wins on all shared resources; no row-level locking or version fields. Justified per concrete collision surface:
  - *Recipe edits* — two cooks rarely edit the same recipe at the same moment; LWW is fine.
  - *Slot assignment* — per-slot writes are independent; LWW per slot is the desired behaviour.
  - *Shopping list check-state* — the highest collision surface, especially with the offline queue. Accepted as an MVP limitation: "last device to sync wins for that line item." A CRDT-lite design is feasible later if real-world conflicts emerge.
- **No staging environment.** Migrations run against production via `release_command` on push to `main`. Mitigation is Testcontainers integration tests covering the actual SQL Drizzle emits, plus rehearsed restore drills (see Backup & rollback). Accepted as a household-scale trade-off; revisit if migration mistakes become a real cost.
- **Off-site backup.** Beyond Fly's automated daily snapshots, a nightly `pg_dump` is uploaded to a Cloudflare R2 bucket via a scheduled GitHub Actions workflow using `flyctl proxy` for DB access. Covers vendor-catastrophe risk for ~$0.50/month.
- **GDPR posture:** UK deployment. Account deletion removes user-attributable data per the tombstoning policy above. One-click data export is not implemented in v1; manual DB export suffices for any access request.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend framework | React + Vite | Fast dev loop; mature ecosystem fit with shadcn/ui and TanStack |
| Routing | TanStack Router | Strictly typed routes + search params; the planner's date range lives in the URL for shareable views |
| Server state | TanStack Query (via `@trpc/react-query`) | Caching, optimistic updates for snappy slot assignment, background refetch |
| Client state | React `useState` + Context | No global store until a concrete shared-state need appears |
| Forms | React Hook Form + Zod | Mature ecosystem; ships in shadcn/ui's `Form` primitives out of the box; minimises re-renders via uncontrolled inputs; same Zod schemas the tRPC procedures use |
| Styling | Tailwind + shadcn/ui | Utility-first; copy-paste components I own outright; ships dark mode out of the box |
| API runtime | Node.js LTS + strict TypeScript | Pinned in `engines`, `.nvmrc`, and Dockerfile; consistent boundary types frontend↔backend; TS catches shape errors at compile time |
| Module system | ESM-only | Greenfield project; ESM is the forward direction across Node and the ecosystem; top-level await and Vitest ergonomics are cleaner |
| API framework | tRPC on Fastify | Typed RPC for a single TS frontend + single TS backend (no codegen, no drift, single Zod codebase end-to-end). Fastify chosen for native async, first-class TypeScript types, low per-request overhead, and a well-maintained `@trpc/server/adapters/fastify` |
| Backend schemas / validation | Zod | One validation library, end-to-end (forms + tRPC procedures) |
| Database | PostgreSQL — Fly Postgres (prod), Docker (local) | Native trigram extension; mature ecosystem; in-region private networking with Fly Postgres |
| ORM | Drizzle | Schema-as-code with integrated migrations via drizzle-kit; queries that read like SQL without losing types. Chosen over Kysely (query builder only — no schema or migrations) and Prisma (heavier, codegen-dependent) |
| Search | ILIKE + `pg_trgm` GIN index | Substring search, indexed; trivial migration path to FTS or external search later |
| Auth | Better Auth (magic links via Resend) | Drizzle adapter, magic-link provider, and session helpers out of the box; passwordless removes credential management entirely. Acknowledged risk: young library (initial release 2024). Mitigation: Better Auth owns a small, well-scoped table set; migration to Lucia or a roll-your-own session table is bounded if the library stalls |
| Email | Resend | Required for magic-link delivery; good developer experience; status monitored via Resend's status page. Postmark is the conservative fallback if deliverability becomes a problem |
| Media | Cloudinary | Direct browser upload via signed credentials with constrained presets (allowed formats, max size, fixed transformation); no backend proxying. Lock-in accepted at household scale |
| Backend logging | Pino → Axiom | Structured JSON, cheap aggregation; 30-day retention on free tier |
| Error tracking | Sentry (frontend + backend SDKs) | Symmetric error capture; absolute-threshold alerts; PII scrubbing configured via `beforeSend` |
| Edge / CDN | Cloudflare | Registrar, DNS, and CDN in one; orange-cloud proxy gives edge caching for static assets, DDoS protection, and edge TLS termination |
| Containers (local) | Docker Compose | Postgres + API + Vite — one command to run locally |
| Runtime host (prod) | Fly.io | Docker-native with declarative `fly.toml`; auto-stop on idle for low-traffic single-region apps; managed Postgres on the same private network. Cheapest among managed Docker hosts that auto-stop |
| CI/CD | GitHub Actions + `flyctl` | Sufficient at this scale; deploy step runs `flyctl deploy` on push to `main` |
| Tests | Vitest + Testcontainers, RTL, Playwright | Ephemeral Postgres for backend; component tests; E2E with `storageState` auth reuse |
| Package manager | pnpm | Strict hoisting prevents phantom dependencies across the three workspaces; content-addressable store keeps disk usage low |
| Coding agent | Claude Code | — |

---

## Architecture

**Monorepo** with three workspaces via pnpm: `/backend` (Fastify + tRPC), `/frontend` (Vite/React), `/shared` (tRPC router type export, shared Zod schemas).

**Type pipeline.** The backend's tRPC router is the single source of truth for API shapes. Procedures define their inputs and outputs with Zod. The frontend imports the router *type* (not the runtime) from `/shared` and uses `@trpc/client` + `@trpc/react-query` to call procedures with full inferred types. There is no codegen step, no OpenAPI document, no CI drift check — drift is structurally impossible because frontend and backend share types directly via the type system. Forms validate against the same Zod schemas the API uses, eliminating form/API duplication.

**Frontend client.** `@trpc/react-query` provides TanStack Query hooks per procedure (`trpc.recipes.list.useQuery()`, `trpc.recipes.create.useMutation()`). Optimistic updates on assignment-style mutations make the planner feel snappy.

**Backend hosting.** Fastify hosts the tRPC handler at `/api/trpc/*` via `@trpc/server/adapters/fastify`. Auth, rate limiting, helmet, static serving, and logging are Fastify plugins applied around the tRPC handler. Better Auth mounts at `/api/auth/*` and owns its tables (users, sessions, accounts, verifications). Domain code reads the current user via Better Auth's session helper. A Fastify pre-handler hook rejects requests without a valid session cookie outside `/api/auth/*`.

**Errors.** tRPC's `TRPCError` codes (`UNAUTHORIZED`, `NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`, etc.) provide a consistent error contract. Domain-specific codes (e.g., `INGREDIENT_IN_USE`) attach via the `cause` field. The frontend's tRPC error link maps these to UI states uniformly.

**Transaction boundaries.** All multi-statement writes use Drizzle transactions: account deletion (the five-table tombstoning sequence plus the user's draft cleanup), plan shrink/extend slot migrations, plan duplication, and recipe save when the method or ingredient list is replaced alongside header fields. Setting or clearing a `paired_recipe_id` updates both sides of the pair within the same transaction.

**Single-household scope, multi-tenancy-ready (minimal).** The MVP has one global tenancy. The data model preserves the option of multi-tenancy without paying for application-layer ceremony today:

- A `households` table exists with one seeded row. Domain tables carry a `householdId` FK pointing to it.
- Application code reads the constant `CURRENT_HOUSEHOLD_ID` from a config module. When (if) multi-tenancy is added, this becomes a session/JWT-derived value — but the abstraction's shape will be designed against the actual mechanism, not guessed at now.
- No `getCurrentScope()` resolver, no scope parameters threaded through repositories. The future tenancy mechanism (RLS? subdomain routing? membership join table?) is unknown enough that pre-building an abstraction risks fitting none of them.
- `addedBy` / `createdBy` are informational, never authorisation predicates.

**Image flow.** A tRPC procedure issues signed Cloudinary upload credentials with constraints baked into the signing parameters: `allowed_formats: ['jpg','jpeg','png','webp']`, `max_file_size: 5 MB`, fixed transformation preset (resize, auto-format). The browser uploads directly to Cloudinary. The returned URL is stored on the recipe via the standard recipe-update procedure. Backend never proxies binary data.

**Date & timezone handling.** All "today"-relative logic — meal-plan status filtering, the date-overlap rule, shelf-life calculations — uses Europe/London time. v1 has no per-user timezone preference. The choice is centralised in a single date utility module so a multi-timezone future is a localised change.

**Theming.** A `ThemeProvider` reads the user's `themePreference` from their profile (or `system` for unauthenticated/initial render), syncs a `dark` class on `<html>`, and listens to `prefers-color-scheme` for the `system` setting. Tailwind's `dark:` variants and shadcn/ui's dark-mode-aware components do the rest.

**Recipe draft persistence.** The recipe editor autosaves in-progress edits server-side to a `recipe_drafts` table, debounced on change. Drafts are keyed by `(user_id, recipe_id)`; new-recipe drafts carry `recipe_id = NULL`. The editor loads any existing draft when opened. Drafts are cleared on successful save and on account deletion. This means a cook can start a recipe on their phone and finish on a laptop without losing edits — matching the cross-device assumption that drove magic-link auth.

**Deployment.** A single Fly.io app serves both the API and the frontend. The production image is multi-stage: stage 1 builds the frontend (`vite build`); stage 2 builds the backend via `esbuild` (single bundle for fast prod startup; not `tsx` in prod); the final image runs Fastify with `@fastify/static` serving `dist/` at the root and the API at `/api/*`. Same-origin in production — session cookies work without CORS or cross-site dance.

Local dev runs Fastify and the Vite dev server as separate processes. Vite's `server.proxy` forwards `/api/*` to Fastify, reproducing same-origin behaviour without an extra proxy layer.

`fly.toml` is committed. Single region (`lhr`) is sufficient for a UK household. Auto-stop is enabled — the machine sleeps when idle and wakes on first request. **Cold-start time is measured in Phase 6** and reconsidered (always-on at ~$5/month) if it exceeds a 3-second budget. A `/api/health` endpoint backs Fly's health checks and confirms DB connectivity.

A **Fly Postgres** cluster runs in `lhr`, attached to the app via `flyctl postgres attach` (injects the connection string as an env var). Private-network connection — no public-internet hop. App-side connection pooling via `pg-pool` with pool size committed in Phase 1 (5–10 range; estimated rather than measured at FEAT-08, with revisit triggers in DEC-71).

**Cloudflare** sits in front of the Fly app via orange-cloud DNS. Edge caching is enabled for static asset paths; `/api/*` is configured to bypass cache. TLS terminates at Cloudflare; the Fly app cert remains for the Cloudflare-to-Fly hop.

Migrations run via Fly's release_command pattern: `release_command = "node /app/migrate.js"` in `fly.toml` (a bundled drizzle-orm migrator) ensures migrations execute before the new release accepts traffic. There is no `flyctl deploy --release-command` flag — the release command lives in `fly.toml`.

Secrets (Cloudinary credentials, Resend API key, Sentry DSNs, Better Auth secret, Axiom token, R2 credentials, `FLY_API_TOKEN` for the `Deploy` workflow, `FLY_API_TOKEN_BACKUP` for the `Backup` workflow) are set via `flyctl secrets set` or GitHub Actions secrets as appropriate — never committed.

**Backup & rollback.** Fly Postgres takes automated daily snapshots. A nightly GitHub Actions workflow runs `pg_dump` via `flyctl proxy` and uploads the dump to a Cloudflare R2 bucket — off-site insurance against a Fly-level catastrophe. Restore drills documented in `OPERATIONS.md`: Fly snapshot list + restore-to-new-cluster procedure, and R2-dump-to-fresh-cluster procedure; both rehearsed once before launch. App rollback via `flyctl releases rollback`.

---

## Data Model

Standard timestamps (`createdAt`, `updatedAt`) on all domain tables; `updatedAt` is set via Drizzle's `$onUpdate` hook, not relied on as convention. Column names are `snake_case` in the database, mapped to `camelCase` in code via Drizzle's name mapping (avoids the unquoted-identifier folding papercut Postgres camelCase causes).

**Auth tables** (`users`, `sessions`, `accounts`, `verifications`) — managed by Better Auth, schema follows Better Auth defaults. Single `name` field on user. The user table additionally carries a `theme_preference` enum column (`system | light | dark`, default `system`).

**`households`** — `household_id smallint PK`, `name varchar`. One row seeded at migration time.

**Reference tables** (read-only after seed):
- `ingredient_categories` — `category_id smallint PK`, `name varchar UNIQUE`.
- `units_of_measurement` — `unit_id smallint PK`, `name varchar`, `abbreviation varchar`.
- `preparation_types` — `prep_type_id int PK`, `description varchar UNIQUE`.
- `meal_occasions` — `occasion_id smallint PK`, `name varchar`. Seeded with Lunch, Dinner.

**`recipe_sources`** — `source_id int PK`, `name varchar`. User-extensible.

**`ingredients`** — `ingredient_id int PK`, `household_id FK`, `name varchar`, `category_id FK`, `default_unit_id FK`, `average_shelf_life_days smallint NULL`, `is_plant boolean DEFAULT false`. Index: `gin (lower(name) gin_trgm_ops)`.

**`recipes`** — `recipe_id int PK`, `household_id FK`, `name varchar`, `description text NULL`, `image_url varchar NULL`, `base_servings smallint NOT NULL`, `active_time_mins smallint NULL`, `total_time_mins smallint NULL`, `estimated_cost_per_serving numeric(10,2) NULL`, `source_id FK NULL`, `source_url varchar NULL`, eight `*_per_serving` macro columns — `calories`, `protein`, `carbs`, `fat`, `saturated_fat`, `fibre`, `sugar`, `salt` (all `smallint NULL`), `added_by_user_id FK NULL` (nullable for tombstoning), `date_added date`, `date_last_updated date`, `is_deleted boolean DEFAULT false`, `is_base boolean NOT NULL DEFAULT false`, `base_recipe_id int FK NULL` (self-reference, `ON DELETE RESTRICT`), `paired_recipe_id int FK NULL` (self-reference, `ON DELETE SET NULL`). Constraints: `CHECK (base_recipe_id IS NULL OR base_recipe_id != recipe_id)`, `CHECK (NOT (is_base AND base_recipe_id IS NOT NULL))` (a recipe is either a base or a batch version, not both), `CHECK (paired_recipe_id IS NULL OR paired_recipe_id != recipe_id)`. Index: `gin (lower(name) gin_trgm_ops)`. Soft-delete is required so past meal plans render: deleted recipes remain in the table for historical plan rendering. Recipe **edits** propagate to past plans by design — recipes are referenced by FK, not snapshotted on assignment. `paired_recipe_id` symmetry (if A points to B, B points to A) is maintained at the application layer within the recipe-save transaction; not a database constraint.

**`recipe_ingredients`** — `recipe_ingredient_id int PK` (surrogate), `recipe_id FK`, `ingredient_id FK`, `quantity numeric(10,3)`, `prep_type_id FK NULL`. **No uniqueness on (recipe_id, ingredient_id)** — duplicates with different prep types are intentional ("1 onion sliced" + "1 onion diced"). Surrogate key chosen over a composite-with-`prep_type_id` PK for simpler ORM mapping and to allow future fields without a PK migration.

**`recipe_method`** — `method_id int PK`, `recipe_id FK`, `step_number smallint`, `instruction text`. `UNIQUE (recipe_id, step_number)`.

**`recipe_drafts`** — `draft_id int PK`, `user_id FK`, `recipe_id FK NULL`, `draft_data jsonb NOT NULL`, `last_updated_at timestamptz`. `UNIQUE (user_id, recipe_id)` — Postgres NULL semantics mean a user can have multiple in-progress new-recipe drafts plus at most one draft per existing recipe. Rows are deleted on successful save and on account deletion. `user_id` uses `ON DELETE RESTRICT` to keep deletion explicit in the tombstoning sequence.

**`related_recipes`** — `recipe_one_id FK`, `recipe_two_id FK`. Composite PK `(recipe_one_id, recipe_two_id)`. `CHECK (recipe_one_id < recipe_two_id)`.

**`recipe_ratings`** — `rating_id int PK`, `recipe_id FK`, `user_id FK`, `rating smallint CHECK (rating BETWEEN 1 AND 5)`, `last_updated_at timestamptz`. `UNIQUE (recipe_id, user_id)`.

**`recipe_comments`** — `comment_id int PK`, `recipe_id FK`, `user_id FK NULL` (nullable for tombstoning), `comment text`, `created_at timestamptz`, `last_updated_at timestamptz NULL`.

**`meal_plans`** — `plan_id int PK`, `household_id FK`, `name varchar NOT NULL`, `start_date date`, `end_date date`, `created_by_user_id FK NULL` (nullable for tombstoning), `is_deleted boolean DEFAULT false`. `CHECK (start_date <= end_date)`.

**`meal_plan_slots`** — `slot_id int PK`, `plan_id FK`, `date date`, `occasion_id FK`, `slot_type enum('empty','recipe','eat_out','takeaway','leftovers') DEFAULT 'empty'`, `recipe_id FK NULL`, `number_of_servings smallint NULL`, `chef_user_id FK NULL`, `comment text NULL`, `cooks_base_recipe_id int FK NULL` (references `recipes(recipe_id)`, `ON DELETE RESTRICT`), `cooks_base_servings smallint NULL`. `UNIQUE (plan_id, date, occasion_id)`. `CHECK ((slot_type = 'recipe') = (recipe_id IS NOT NULL))`. When `slot_type = 'recipe'`, `number_of_servings` is required. `CHECK ((cooks_base_recipe_id IS NULL AND cooks_base_servings IS NULL) OR (cooks_base_recipe_id IS NOT NULL AND cooks_base_servings IS NOT NULL AND cooks_base_servings > 0))` — base-cook fields must be set together. Application-layer validation: `cooks_base_recipe_id` must reference a recipe with `is_base = true`.

**`shopping_list_items`** — composite PK `(plan_id, ingredient_id)`, `is_checked boolean DEFAULT false`. Created lazily on first GET of a plan's shopping list — most plans never reach the shopping stage (drafts, cancelled trips), so lazy creation avoids polluting the table with rows that will never be read.

FK columns supporting tombstoning use `ON DELETE SET NULL`. All other FKs use `ON DELETE RESTRICT` unless noted.

---

## Build Order

Six phases. Each phase ends with tests for what was built in that phase — no work proceeds until those tests pass in CI.

**Phase 1 — Infrastructure & CI.** Initialise the monorepo with pnpm workspaces (`/backend`, `/frontend`, `/shared`). Pin Node LTS via `engines`, `.nvmrc`, and Dockerfile. ESM-only across all workspaces. `docker-compose.yml` for Postgres + Fastify + Vite dev server. Configure Vite's `server.proxy` to forward `/api/*` to Fastify in dev. Scaffold Fastify with Pino (request-ID generation on), `@fastify/helmet`, `@fastify/static`, and the tRPC adapter. Scaffold Vite + React + Tailwind + shadcn/ui + TanStack Router + TanStack Query + tRPC client + React Hook Form. Multi-stage Dockerfile (frontend via `vite build`, backend via `esbuild` bundle for prod — not `tsx`). Create `fly.toml`; verify a one-shot `flyctl deploy` works. Register the production domain via Cloudflare Registrar; configure orange-cloud DNS with a cache-bypass rule for `/api/*`; park the domain pending Phase 2 email setup. GitHub Actions: lint, typecheck, single placeholder test on every push. Commit a `pg-pool` size for Phase 2 — estimated against the workload's ceiling and the runtime image footprint, with the synthetic-load run deferred until FEAT-09 makes it measurable against real DB traffic (DEC-71's revisit triggers cover the failure modes).

**Phase 2 — Database & auth.** Drizzle schema for all tables, including the batch-cooking fields on `recipes` (`is_base`, `base_recipe_id`, `paired_recipe_id`) and on `meal_plan_slots` (`cooks_base_recipe_id`, `cooks_base_servings`), plus `recipe_drafts`. Seed reference data (units, categories, occasions, prep types, the single household row). Drizzle migrations set up; `updatedAt` enforced via Drizzle's `$onUpdate`. App-side `pg-pool` configured with the pool size committed in FEAT-08. Integrate Better Auth with magic-link provider via Resend; verify the production domain with Resend and configure SPF, DKIM, and DMARC records so magic-link emails reach the inbox reliably. Build sign-in (email entry → "magic link sent" confirmation), magic-link verification handler, session-protected layout via TanStack Router. Theme preference column on users; `ThemeProvider` reads from session profile; toggle UI in settings. **Tests:** magic-link request, magic-link verification, expired-link handling, used-link handling, protected route redirects, theme persistence round-trip.

**Phase 3 — Recipes & ingredients.** tRPC procedures for ingredients and recipes. Recipe-level fields update via partial-update procedures; method and ingredient list update via dedicated bulk-replace procedures — every field is independently saveable from the UI. Cloudinary signed-upload procedure with constrained presets (allowed formats, max size, fixed transformation). Build the Ingredient Dictionary view and the Recipe Editor view (image upload, ingredient picker, method editor) using React Hook Form + Zod with shadcn/ui's `Form` primitives. Editor surfaces affordances for marking a recipe as a base (`is_base`), linking a batch version to its base (`base_recipe_id`, restricted to recipes where `is_base = true`), and pairing full↔batch variants (`paired_recipe_id`); pair updates write both sides atomically. Editor autosaves to the `recipe_drafts` table on debounce; loads existing draft on open; clears draft on successful save. Recipe picker filters out batch recipes whose base is soft-deleted. **Tests:** CRUD coverage, ingredient unit enforcement at the procedure boundary, plant-points calculation (recipe level), soft-delete and restore flows, `INGREDIENT_IN_USE` `CONFLICT` error when any recipe (including soft-deleted) references the ingredient, draft autosave + cross-device draft load + draft cleared on save, recipe-pairing symmetry round-trip, soft-deleted-base hidden from picker.

**Phase 4 — Meal planner.** tRPC procedures for plans and slots. Slot auto-generation on plan creation. Date-overlap validation (against non-deleted plans with `endDate >= today`). Date-range edit migrations: shrink-with-confirmation deletes out-of-range slots, extend generates new empty slots. Plan duplication. All multi-slot operations wrapped in Drizzle transactions. Build the Recipe Bank sidebar (compact cards) and the Meal Planner Grid using **click-to-assign**: tap a recipe in the sidebar to select; tap a slot to assign. Assigned slots are tappable to edit servings, change recipe, or clear. Slot editor exposes two recipe pickers — "What are you eating?" (any recipe) and "Cooking a base for batch use?" (optional, filtered to `is_base = true`) — with the meal's referenced base pre-suggested for the base picker. Slot card in the grid renders both lines when a base cook is present; when the meal recipe has a `paired_recipe_id`, expose a "switch to full / switch to batch" toggle. Soft warning when a batch-version meal has no base supply earlier in the plan or in the same slot. TanStack Router search params for the date range. Optimistic updates via TanStack Query for snappy assignment. **Tests:** slot generation, overlap rejection (including the past-plan exemption), date-edit migrations both directions, click-to-assign slot updates, plan duplication, base-cook field consistency, batch-supply soft-warning logic, pair-switch updates the slot's recipe correctly.

**Phase 5 — Shopping list.** Aggregation procedure: join slots → recipes → ingredients, scale by `qty × (slotServings / baseServings)`, group by category, exclude non-`recipe` slots from meal-recipe totals. Add the base-cook contribution: when `cooks_base_recipe_id` is set on any slot, add the base recipe's ingredients scaled by `cooks_base_servings`. Shelf-life warnings: flag any ingredient with at least one use past `(planStart + shelfLifeDays)`, return the latest-needed date. Lazy-create `shopping_list_items` on first GET; check-state procedure with quantity-bound reset. Build the Shopping List view as a printable, PWA-cacheable checklist. PWA service worker + manifest using a **network-first** strategy for the shopping list GET; offline mutation queue for check-state changes that syncs on reconnect. Plant-points procedures for day and plan granularity, traversing `recipe.base_recipe_id` for batch-version slots and `slot.cooks_base_recipe_id` for slots that cook a base. **Tests:** aggregation math (incl. duplicate ingredient lines, mixed prep types, base-cook contributions, batch-version meals not double-counting base ingredients), shelf-life edge cases, plant-points traversal for batch-version slots and base-cook slots, check-state persistence, quantity-bound reset behaviour, offline read and queued-write sync.

**Phase 6 — Observability & deploy hardening.** Pino HTTP transport to Axiom; `req.id` preserved end-to-end through logs. Sentry React SDK + Sentry Node SDK with `beforeSend` PII scrubbing (strip cookies, auth headers, email), session replay disabled, absolute-threshold alert (>5 errors / 5 min); `req.id` attached as a Sentry tag. `@fastify/rate-limit` configured per the NFR (global IP/session limits + tighter per-email limit on magic-link request). `/api/health` endpoint for Fly's health checks (verifies DB connectivity). Explicit CSP policy: `img-src` for Cloudinary, `connect-src` for Sentry ingest, minimal `script-src` / `style-src` allowlist. GitHub Actions deploy workflow: on push to `main`, build the multi-stage image and run `flyctl deploy` — the `fly.toml` `release_command` (bundled drizzle-orm migrator) runs migrations before traffic shifts; secrets configured via `flyctl secrets set` ahead of the first deploy. Nightly scheduled GitHub Actions workflow runs `pg_dump` via `flyctl proxy` and uploads to a Cloudflare R2 bucket. Document backup/restore drill (Fly snapshot list + restore-to-new-cluster procedure; R2-dump-to-fresh-cluster procedure) and rollback (`flyctl releases rollback`) in `OPERATIONS.md`; rehearse both restore paths once before launch. **Measure cold-start time**; reconsider auto-stop if it exceeds the 3-second budget. Playwright E2E for critical paths (sign in via magic link, create recipe, plan a week including a batch-cook slot, generate shopping list, check off items) with `storageState` auth reuse. WCAG 2.1 AA spot-check via `axe-core` against both light and dark themes.

---

## Testing Approach

Tests live alongside the feature in each phase — never deferred. Vitest + Testcontainers for backend integration tests against ephemeral Postgres (covers SQL behaviour, FK constraints, seed data, the actual queries Drizzle emits, and tRPC procedures end-to-end including auth context). React Testing Library for component-level frontend tests, focused on conditional rendering (own vs. others' comments, soft-delete states, slot type variants, batch-cook vs single-recipe slot card rendering, theme rendering). Playwright for end-to-end critical paths in Phase 6, using `storageState` to bypass magic-link redemption per test for speed. Coverage is not a target; behaviour is. Aggregation math (including base-cook contributions and the no-double-count rule for batch-version meals), plant-points traversal for batch slots, shelf-life warnings, and the date-overlap and date-edit migrations are the highest-value test surfaces and get the most cases.

---

## Open Questions

- **Cloudinary cleanup.** Orphaned uploads accepted as v1 debt. *Resolves when storage cost or asset clutter becomes visible* — at which point a scheduled job deletes Cloudinary assets whose `public_id` doesn't match any recipe.
- **PWA vs. server skew.** v1 strategy: cache last-fetched shopping list only, no aggressive caching. If the deployed PWA falls behind a backend procedure shape change, the affected call will fail and prompt a refresh. A graceful versioning strategy is deferred until the failure mode is observed in practice.
- **GDPR data export.** Account deletion is implemented; one-click data export is not. Manual DB export suffices for v1 access requests.
- **Multi-shop shelf-life planning.** v1 assumes a single shop on plan start date. If real cooking patterns reveal frequent top-up shops, add a `shop_date` field to plans and recompute warnings against it.
- **Cooked-base shelf life.** Raw-ingredient shelf life is tracked from purchase; cooked-base shelf life (typically shorter than raw, much longer when frozen) is not. If batch-cooking patterns regularly stretch consumption past safe limits, add a `cooked_shelf_life_days` field on recipes and warn when the gap between a base cook and a consumer slot exceeds it.
