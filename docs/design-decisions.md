# Lofty's Larder — Design Decisions

ADR-format log of every meaningful tech and architectural decision drawn from `plan.md` and `non-goals.md`. Each entry is one decision; cross-references list the features in `feature-specs.md` shaped by it and any `non-goals.md` entries that follow from it.

Decisions are numbered sequentially (`DEC-01` …) and grouped by category. A summary section at the end lists those most worth deep consideration when revisiting.

---

## Framework and Language

### DEC-01 — ESM-only across all workspaces

- **Chosen:** Native ECMAScript Modules in `/backend`, `/frontend`, and `/shared`. Every `package.json` declares `"type": "module"`; TypeScript uses `module: "NodeNext"`.
- **Alternatives:** CommonJS; dual ESM/CJS publishing per workspace.
- **Why it won:** Greenfield project — ESM is the forward direction across Node and the wider ecosystem. Top-level `await`, cleaner Vitest ergonomics, and no dual-package hazard. With Vite on the frontend and tRPC on the backend, ESM-first dependencies dominate the relevant ecosystem already.
- **Consequences (+):** Single module shape across workspaces; no `__dirname` workarounds; cleaner test setup.
- **Consequences (−):** A CJS-only dependency surfaces as `ERR_REQUIRE_ESM` at runtime, not at install — a real risk for older auth / email / observability libraries. Every new dependency must be ESM-vetted before pinning. Without `moduleResolution: "NodeNext"`, TypeScript silently accepts extension-less imports Node refuses to run.
- **Revisit when:** A load-bearing capability has only a CJS implementation, and wrapping it would cost more than relaxing the constraint. Unlikely.
- **Cross-refs:** FEAT-01 establishes; cross-cutting concern #20 enforces across every later FEAT.

### DEC-02 — Node.js LTS pinned, strict TypeScript

- **Chosen:** Node LTS pinned via `engines`, `.nvmrc`, and the Dockerfile. TypeScript in `strict: true` across all workspaces, single `tsconfig.base.json`.
- **Alternatives:** Floating Node version; relaxed `strict` flags; Bun or Deno.
- **Why it won:** Two-developer project benefits from boring, well-supported tooling. Strict TS catches shape errors at compile time and amplifies the value of the typed tRPC pipeline; without it, the type bridge between backend and frontend is a soft contract.
- **Consequences (+):** Same runtime everywhere (local, CI, prod). Compile-time errors instead of runtime ones at API boundaries.
- **Consequences (−):** Node LTS upgrades are a small periodic chore (`engines`, `.nvmrc`, Dockerfile, CI matrix). `strict: true` rejects some idiomatic JavaScript patterns; ramp-up cost for anyone unfamiliar.
- **Revisit when:** Node LTS major upgrades (every ~12 months) — not the decision itself, just the version. The strict-TS decision should not be revisited.
- **Cross-refs:** FEAT-01, FEAT-05 (Docker pinning).

### DEC-03 — pnpm workspaces with `/shared` as the type-pipeline carrier

- **Chosen:** Three pnpm workspaces — `/backend`, `/frontend`, `/shared`. `/shared` exports the tRPC router *type* and any Zod schemas used on both sides.
- **Alternatives:** npm or yarn workspaces; a single-package layout; turborepo or Nx on top.
- **Why it won:** pnpm's strict hoisting prevents phantom dependencies across the three workspaces — important because the frontend must not accidentally see a backend-only dep through hoisting. Content-addressable store keeps disk usage low for a small team. Three workspaces is below the threshold where a build orchestrator pays for itself.
- **Consequences (+):** Frontend imports backend types but cannot import backend runtime — caught at the workspace boundary. Single lockfile, single install.
- **Consequences (−):** pnpm's stricter resolution occasionally surprises tooling expecting hoisted layouts (some bundler plugins, older ESLint configs). The `/shared` workspace contract is touched by every feature; mistakes propagate widely.
- **Revisit when:** A fourth workspace appears with non-trivial build dependencies on the others — at that point a build orchestrator may earn its keep.
- **Cross-refs:** FEAT-01 establishes; cross-cutting concern #1 (the `/shared` Zod schema layout).

### DEC-04 — React + Vite as the frontend stack

- **Chosen:** React rendered via Vite's dev server (HMR) and `vite build` for production.
- **Alternatives:** Next.js, Remix, SvelteKit; CRA (deprecated).
- **Why it won:** A meta-framework's main wins (SSR, routing-as-framework, file-based RPC) don't apply to a logged-in single-household app. The dev loop is the dominant cost at this stage; Vite's HMR is the fastest available. Mature ecosystem fit with shadcn/ui and TanStack.
- **Consequences (+):** Fast HMR, simple build, no framework lock-in. Same React idioms anywhere.
- **Consequences (−):** Routing, data fetching, and SSR are all à la carte (TanStack Router, TanStack Query) — more pieces to wire by hand than a meta-framework. No SSR means the first render is a blank shell until JS executes; acceptable for an authenticated app behind a magic-link wall.
- **Revisit when:** SEO matters (it does not — auth-walled), or initial-load perception becomes a real complaint that a meta-framework would meaningfully fix.
- **Cross-refs:** FEAT-04.

### DEC-05 — Fastify as the backend framework

- **Chosen:** Fastify with `@fastify/helmet`, `@fastify/static`, `@fastify/cors`, `@fastify/rate-limit`, and the tRPC adapter.
- **Alternatives:** Express, Hono, Koa, NestJS.
- **Why it won:** Native async, first-class TypeScript types, low per-request overhead, well-maintained `@trpc/server/adapters/fastify`, and a plugin ecosystem covering every cross-cutting concern (helmet, static, rate-limit). Express's middleware ergonomics and dated typings would have cost more in friction than Fastify's relative learning curve does.
- **Consequences (+):** Plugins cover security, static serving, and rate-limiting without custom code. Per-request `req.id` is built in via Pino integration.
- **Consequences (−):** Smaller community than Express; fewer Stack Overflow answers for unusual cases. Plugin encapsulation can surprise people used to Express middleware mutating context freely.
- **Revisit when:** A required plugin disappears from maintenance with no replacement. Unlikely.
- **Cross-refs:** FEAT-03; FEAT-14 (auth pre-handler), FEAT-45 (rate limit), FEAT-46 (health), FEAT-47 (CSP).

### DEC-06 — tRPC for the API contract (no codegen, no OpenAPI)

- **Chosen:** tRPC end-to-end. The backend's router type is exported through `/shared` and consumed by the frontend via `@trpc/client` + `@trpc/react-query`. Procedures define inputs and outputs in Zod.
- **Alternatives:** REST + OpenAPI + codegen, GraphQL, hand-written fetch wrappers.
- **Why it won:** Single TS frontend + single TS backend means typed RPC produces zero drift — there is no IDL, no codegen step, no CI drift check, because frontend and backend share types through the type system itself. Forms validate against the same Zod schemas the API uses, eliminating form/API duplication.
- **Consequences (+):** Procedure-shape changes flow into the frontend at compile time. Single Zod codebase end-to-end. Optimistic updates via `@trpc/react-query` are straightforward.
- **Consequences (−):** Locks the API to a TS client — there is no language-agnostic contract. A third-party integration would need either OpenAPI generated from the router (possible) or a parallel REST surface. tRPC's URL shape (`/api/trpc/<procedure>?batch=1&input=...`) couples the PWA's Workbox cache patterns to internals (cross-cutting concern #16). Errors are tRPC-coded; mapping to UI states requires a frontend error link.
- **Revisit when:** A non-TS consumer appears (a mobile app in another language, a partner integration, a public API). At that point either generate OpenAPI from the router or expose a parallel surface — the migration is bounded but real.
- **Cross-refs:** FEAT-03 (server adapter), FEAT-04 (client setup), FEAT-17 onward (every procedure); cross-cutting concerns #9, #11, #16.

### DEC-07 — Zod as the single validation library

- **Chosen:** Zod for tRPC procedure schemas, environment-config parsing, and React Hook Form validation.
- **Alternatives:** Yup, Joi, Valibot, custom validators.
- **Why it won:** One schema library across forms, API procedures, and config means one mental model. React Hook Form + shadcn/ui ship Zod-first integration. tRPC supports Zod natively.
- **Consequences (+):** Schemas are reused between forms and the API — no duplicate validation logic.
- **Consequences (−):** Zod's bundle weight on the frontend is non-trivial (tens of KB after minification). If bundle size becomes a real concern, Valibot is a smaller compatible-ish swap, but the migration touches every schema.
- **Revisit when:** Frontend bundle size becomes user-visible (it will not at this scale) or Zod itself stalls.
- **Cross-refs:** FEAT-01, FEAT-03 (env loader), FEAT-21 (Recipe Editor forms), every tRPC procedure.

---

## State

### DEC-08 — TanStack Query for server state via `@trpc/react-query`

- **Chosen:** TanStack Query as the only server-state cache; `@trpc/react-query` produces hooks per procedure (`trpc.recipes.list.useQuery()` etc.).
- **Alternatives:** SWR; bespoke `useEffect` + state; RTK Query.
- **Why it won:** Caching, background refetch, and `onMutate`/`onError`/`onSettled` optimistic-update primitives map directly onto the planner's snappy slot assignment requirement. tRPC's React adapter is built on it. SWR is simpler but lacks the mutation lifecycle hooks that the optimistic pattern relies on.
- **Consequences (+):** Optimistic updates, automatic refetch on focus, query invalidation are all idiomatic. The same primitive supports the offline mutation queue (a strict superset).
- **Consequences (−):** Two mental models for state — server state in TanStack Query, client state in React. Easy to put something in the wrong place (e.g. derived UI state cached as a query). The optimistic-update pattern needs to be encapsulated in a shared hook or it drifts across five+ consumers.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-04 (client setup), FEAT-31 onward (every mutation), FEAT-42 (offline queue); cross-cutting concern #7.

### DEC-09 — React `useState` + Context for client state (no global store)

- **Chosen:** Plain React state and Context for client-only state. No Redux, Zustand, Jotai, or similar.
- **Alternatives:** Zustand (smallest), Redux Toolkit, Jotai, Recoil.
- **Why it won:** There is no concrete shared client-state need today. The planner's selection state (which recipe is selected in the bank) is screen-local; the theme preference is a single Context. A store added speculatively becomes the place every later state pattern goes, whether or not it should.
- **Consequences (+):** Fewer dependencies, smaller bundle, no global-state ceremony.
- **Consequences (−):** When a shared piece of client state does appear (e.g. an undo stack across the planner), the first one will have to introduce a store — and the question of "which one" will surface mid-feature.
- **Revisit when:** Two or more unrelated pieces of UI need to share non-server client state non-trivially. Zustand is the named first-reach.
- **Cross-refs:** FEAT-04, FEAT-16 (ThemeProvider as Context), FEAT-31.

### DEC-10 — TanStack Router with date range in URL search params

- **Chosen:** TanStack Router for strictly-typed routes and typed search params. The planner's date range lives in URL search params, not component state.
- **Alternatives:** React Router (less type-safe), Next.js app router (would require Next), Wouter (minimalist, no typed search params).
- **Why it won:** Typed search params on the planner's date range make shareable views work for free — copy URL, paste to other device, same view. Strict route typing catches route-changes that break links at compile time.
- **Consequences (+):** Browser back/forward navigates the planner. Date-range URLs are bookmarkable.
- **Consequences (−):** Newer than React Router; smaller community. Migrating route patterns (file-based vs code-defined) is non-trivial later.
- **Revisit when:** Library stalls — at which point React Router is the conservative swap.
- **Cross-refs:** FEAT-04, FEAT-15 (protected routes), FEAT-31 (date range in search params), FEAT-34.

### DEC-11 — React Hook Form + Zod for forms

- **Chosen:** React Hook Form with `@hookform/resolvers/zod`, integrated via shadcn/ui's `Form` primitives.
- **Alternatives:** Formik, controlled components written by hand, TanStack Form.
- **Why it won:** Minimises re-renders via uncontrolled inputs (matters on the Recipe Editor with many fields). Ships in shadcn/ui's primitives out of the box. Uses the same Zod schemas the tRPC procedures validate against — schema-as-truth.
- **Consequences (+):** Editor performance scales with form size. Same validation runs client- and server-side.
- **Consequences (−):** Uncontrolled-input model occasionally trips up integrations that expect controlled inputs (e.g. some custom autocomplete primitives).
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-04, FEAT-21 (Recipe Editor), FEAT-16 (Settings).

---

## Data

### DEC-12 — PostgreSQL as the database

- **Chosen:** PostgreSQL — Fly Postgres in production, Docker locally.
- **Alternatives:** SQLite (would have served two users fine), MySQL, MongoDB.
- **Why it won:** Native trigram extension (`pg_trgm`) for ingredient/recipe substring search without an external search service. Mature ecosystem, well-supported by Drizzle, in-region private networking via Fly Postgres. SQLite would simplify backup at the cost of losing trigram search and easy concurrent dev usage.
- **Consequences (+):** Trigram search built in. Standard SQL idioms.
- **Consequences (−):** Postgres is overkill for two-user traffic — most features could run on SQLite. Operating a Postgres cluster adds a connection-pool tuning surface and a real backup story (covered in DEC-71, DEC-73).
- **Revisit when:** Operating Postgres becomes the dominant ops cost. Migrating to SQLite would lose trigram search but is conceptually feasible.
- **Cross-refs:** FEAT-02, FEAT-09, FEAT-11, FEAT-12, FEAT-19 (search).

### DEC-13 — Drizzle as the ORM

- **Chosen:** Drizzle, with `drizzle-kit` for migrations and the `$onUpdate` hook for `updatedAt`.
- **Alternatives:** Prisma, Kysely, raw SQL via `pg`, TypeORM.
- **Why it won:** Schema-as-code with integrated migrations (Kysely is a query builder only; migrations bring-your-own). Queries read like SQL without losing types (Prisma's query layer is heavier and codegen-dependent). Lighter than Prisma, more complete than Kysely.
- **Consequences (+):** Migrations versioned with code. Type-safe queries that mirror SQL. Snake_case → camelCase mapping built in.
- **Consequences (−):** Younger than Prisma; rougher tooling around generated migrations (occasional manual edits). Some advanced SQL features need an `sql\`...\`` template fragment that escapes the type system. The `$onUpdate` hook on `updatedAt` is enforced at the application layer, not the DB — a query bypassing Drizzle would not update the timestamp (mitigated: all writes go through Drizzle).
- **Revisit when:** Drizzle stalls (Prisma is the conservative swap, with non-trivial migration cost — schema syntax differs).
- **Cross-refs:** FEAT-09, FEAT-10, FEAT-11, FEAT-12, FEAT-20, FEAT-27, FEAT-35.

### DEC-14 — Search via ILIKE + `pg_trgm` GIN index

- **Chosen:** Substring search on `lower(name)` with a `pg_trgm` GIN index on ingredients and recipes.
- **Alternatives:** Postgres FTS (`tsvector`/`tsquery`), Meilisearch, Algolia, Elasticsearch.
- **Why it won:** Trivial substring matching is what users want for "find an ingredient/recipe by name". Trigram-indexed ILIKE is fast on household-scale row counts (hundreds of recipes). FTS is more powerful but introduces tokenisation choices (stemming, stop-words) the household doesn't need. External search adds an entirely separate service.
- **Consequences (+):** No infrastructure beyond Postgres. No tokeniser to maintain.
- **Consequences (−):** No ranking beyond match presence; no weighted multi-field search; no language-specific stemming. Substring "marin" won't match "marinade" via stem; it will via trigram coincidence, which is fine for the dataset size.
- **Revisit when:** Ranking complaints surface, or cross-field weighted search becomes a real ask. Migration to FTS is bounded (an additional column + index).
- **Cross-refs:** FEAT-11, FEAT-19; non-goal: "Search upgrade path beyond ILIKE + pg_trgm".

### DEC-15 — `snake_case` columns in DB, `camelCase` in code

- **Chosen:** Database columns are `snake_case` (`base_servings`, `is_deleted`, `paired_recipe_id`); TypeScript uses `camelCase` via Drizzle's name mapping.
- **Alternatives:** `camelCase` columns (requires quoted identifiers), `snake_case` everywhere (verbose in TS).
- **Why it won:** Postgres folds unquoted `camelCase` identifiers to lowercase. Either you quote every reference (`"basServings"`) and accept the noise forever, or you pick one convention per layer.
- **Consequences (+):** Idiomatic in both layers. Raw psql queries are pleasant.
- **Consequences (−):** Anyone reading raw SQL output then writing TS code translates names in their head. Drizzle handles it transparently — but a stray raw query in code must use the snake_case form.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-09, every schema feature.

### DEC-16 — `updatedAt` enforced via Drizzle `$onUpdate` (not relied on as convention)

- **Chosen:** Every domain table's `updatedAt` is set by Drizzle's `$onUpdate` hook, not by trigger and not by hoping every code path remembers.
- **Alternatives:** Postgres triggers; application-layer convention; ignore `updatedAt`.
- **Why it won:** Triggers are correct but hide behaviour from the codebase; convention rots. `$onUpdate` is explicit, declared with the column, and runs for every Drizzle write.
- **Consequences (+):** Timestamps consistent without thinking. Visible at the schema definition site.
- **Consequences (−):** A non-Drizzle write (raw SQL inside a migration, or a future direct-DB tool) bypasses the hook. Mitigation: all application writes route through Drizzle.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-09, every domain schema feature.

### DEC-17 — Single-household MVP; schema multi-tenancy-ready; `CURRENT_HOUSEHOLD_ID` as config constant

- **Chosen:** One `households` row seeded at migration time. All domain tables carry `householdId` FK. Application code reads `CURRENT_HOUSEHOLD_ID` from a config module. No `getCurrentScope()` resolver, no scope parameter threading through repositories.
- **Alternatives:** Full multi-tenancy from day one (RLS, subdomain routing, membership join table); no `householdId` at all and add later.
- **Why it won:** Schema-level readiness costs almost nothing (one FK column) and makes a future migration localised. Application-layer multi-tenancy machinery — scope resolvers, threading, RLS policies — is expensive and would be designed against an imagined access pattern. The right mechanism depends on what multi-tenancy *means* when it arrives (households inviting each other? recipe sharing? a SaaS product?).
- **Consequences (+):** Every query gets a `where householdId = CURRENT_HOUSEHOLD_ID` clause cheaply. Future multi-tenancy is one well-defined refactor away.
- **Consequences (−):** Every read carries a constant that has to be set in every environment (prod, test). `addedBy` / `createdBy` are informational, never authorisation predicates — easy to forget when adding a new domain action that one might assume scopes by user. If multi-tenancy is added and the mechanism is Postgres RLS, the `CURRENT_HOUSEHOLD_ID` config-constant pattern needs to be retired entirely rather than extended.
- **Revisit when:** A concrete second-household requirement appears, with stated semantics. Until then, no scope-resolver, no membership joins.
- **Cross-refs:** FEAT-09 (constant), FEAT-10 (schema), every domain procedure; non-goal: "Multi-tenancy mechanism (deferred)", "Recipe / meal-plan sharing across households".

### DEC-18 — Single enforced unit per ingredient

- **Chosen:** Each ingredient row carries one `default_unit_id`. Every recipe referencing it uses that unit; users convert manually when entering recipes from sources with different units.
- **Alternatives:** Multi-unit-per-ingredient with a conversion table.
- **Why it won:** Shopping-list aggregation becomes a pure sum — no conversion table to maintain, no rounding pathology, no unit collision (1 cup of flour + 100g of flour = ?). The conversion burden moves to the data-entry user, who has more context than the runtime.
- **Consequences (+):** Aggregation math is trivial and obviously correct. No unit-conversion infrastructure to test or break.
- **Consequences (−):** A real UX cost paid by whoever enters recipes from sources that don't match the chosen unit. Two cooks accept this; a wider audience might not.
- **Revisit when:** Entry friction from manual conversion becomes an adoption barrier — cannot happen at household scale.
- **Cross-refs:** FEAT-17 (procedure boundary enforcement), FEAT-21 (editor), FEAT-36 (aggregation); non-goal: "Multi-unit-per-ingredient support".

### DEC-19 — Whole-recipe ingredient quantities with explicit `baseServings`

- **Chosen:** Recipe ingredients are entered for the whole recipe. Every recipe carries a `baseServings` value. The shopping list scales by `qty × (slotServings / baseServings)`.
- **Alternatives:** Per-serving quantities.
- **Why it won:** Recipes in the wild are written "serves 4," not per-portion. Whole-recipe entry matches source material and lowers data-entry friction. `baseServings` is a single denominator the aggregator can scale by.
- **Consequences (+):** Source material maps directly to the editor. Aggregation has one well-defined formula.
- **Consequences (−):** A recipe whose `baseServings` is wrong skews every shopping-list quantity using it. Mitigated by visibility in the editor — `baseServings` is prominent, not hidden.
- **Revisit when:** Not anticipated; would be a foundational data-model change.
- **Cross-refs:** FEAT-11 (column), FEAT-21 (editor), FEAT-36 (aggregation); non-goal: "Per-serving recipe ingredient entry".

### DEC-20 — Surrogate key on `recipe_ingredients`; duplicate (recipe, ingredient) rows allowed

- **Chosen:** `recipe_ingredient_id int PK`; **no uniqueness** on `(recipe_id, ingredient_id)`.
- **Alternatives:** Composite PK `(recipe_id, ingredient_id)` with single row per ingredient; composite PK including `prep_type_id`.
- **Why it won:** A recipe may list the same ingredient with different prep types ("1 onion sliced" + "1 onion diced"). A composite PK with `prep_type_id` works but constrains future fields (a recipe needing two `diced` onion entries) and complicates ORM mapping. The surrogate key is simpler.
- **Consequences (+):** Editor allows duplicate lines without surprise. Aggregator sums correctly across duplicates.
- **Consequences (−):** No DB-level guarantee against accidental exact duplicates (1 onion sliced + 1 onion sliced added twice in the editor). Mitigated at the editor and procedure boundary.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-11, FEAT-20 (bulk replace), FEAT-36 (aggregation).

### DEC-21 — Soft-delete recipes for historical plan rendering

- **Chosen:** `recipes.is_deleted boolean DEFAULT false`. Deleted recipes are hidden from new pickers but remain in the table.
- **Alternatives:** Hard delete (would break past plans referencing the recipe); copy-on-assign snapshotting (would let hard delete work — see DEC-22).
- **Why it won:** Meal plans reference recipes by FK. Hard delete would either orphan plan slots or require snapshotting. Soft-delete is the cheapest way to keep history intact.
- **Consequences (+):** Past plans render correctly forever. The picker filter encodes the visibility rule in one place.
- **Consequences (−):** The "is this recipe visible in this context" rule grows variants (in pickers? in related lists? as a batch-recipe's base?) — codified in the `pickable-recipes` helper (cross-cutting concern #5). `INGREDIENT_IN_USE` errors must consider soft-deleted recipes too, which surprises ingredient deletion.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-11, FEAT-17 (`INGREDIENT_IN_USE`), FEAT-19, FEAT-20, FEAT-23, FEAT-26, FEAT-31; cross-cutting concerns #5, #19.

### DEC-22 — Recipe edits propagate to past plans (no snapshotting on assignment)

- **Chosen:** Plan slots reference recipes by FK. Editing a recipe's ingredients or quantities affects past plan plant-points and any not-yet-generated shopping list.
- **Alternatives:** Copy recipe contents into the slot at assignment time so later edits don't mutate past plans.
- **Why it won:** Snapshotting adds copy-on-assign storage and substantial complexity to every ingredient-mutation path. The problems it solves (post-hoc plant-points drift, mid-shop quantity changes) nobody is asking about at household scale. The shopping-list quantity-bound check-state reset (DEC-31) covers the only mid-shop surprise.
- **Consequences (+):** No snapshot storage. No "this plan's view of the recipe" divergence to reason about. Recipe corrections are retroactive — usually what the cook wants.
- **Consequences (−):** A typo correction on a recipe changes a past plan's plant-points history. A meaningful ingredient swap on a recipe changes a not-yet-shopped plan's shopping list. Mid-shop changes are absorbed by the quantity-bound check reset, not silenced.
- **Revisit when:** Past-plan integrity is required for an external reason (regulatory, sharing, public archive) — none currently in scope.
- **Cross-refs:** FEAT-11, FEAT-20, FEAT-36; non-goal: "Recipe snapshotting at slot assignment".

### DEC-23 — Two-level batch-cooking model with explicit base / batch-version pairing

- **Chosen:** Recipes carry `is_base boolean`, `base_recipe_id` (self-FK, batch versions point to their base), and `paired_recipe_id` (full↔batch sibling link). CHECK constraint: a recipe is either a base or a batch version, not both — no nesting.
- **Alternatives:** Nested base recipes (a stock that feeds a sauce that feeds a meal); a "prep step" abstraction distinct from recipes; no batch concept at all.
- **Why it won:** Two levels cover every cooking pattern the household has surfaced (base → accompaniments). Nesting introduces cycle-detection, recursive plant-points traversal, and ambiguous aggregation paths for no observed use case. The pair link gives the slot editor a "switch to full / switch to batch" affordance without inferring it from data.
- **Consequences (+):** Aggregator and plant-points traversal are bounded (one level deep). The editor pair-switch is a simple FK lookup.
- **Consequences (−):** A recipe pattern needing three-deep composition would force a model change. `paired_recipe_id` symmetry has to be maintained at the application layer in the recipe-save transaction (DEC-26). The batch-version-of-soft-deleted-base case adds a picker rule.
- **Revisit when:** A real meal pattern needs three-deep composition. Re-evaluation should weigh nesting vs. a separate "prep step" abstraction.
- **Cross-refs:** FEAT-11, FEAT-23, FEAT-32, FEAT-33, FEAT-36, FEAT-40; non-goal: "Nested base recipes".

### DEC-24 — Cooked-base contribution on slots, decoupled from the meal's referenced base

- **Chosen:** A slot can cook a base via `cooks_base_recipe_id` and `cooks_base_servings`, independent of whichever recipe the slot is *eating*. Today's lunch can eat one batch-version recipe and cook a different base for tomorrow.
- **Alternatives:** Force the cooked base to match the eaten recipe's `base_recipe_id`; no per-slot base cook (force a separate slot for the base).
- **Why it won:** Real cooking decouples "what we ate today" from "what I prepped for the week." A takeaway slot can still prep a base. The slot editor pre-suggests the meal's referenced base for ergonomics but doesn't force it.
- **Consequences (+):** Plan flow matches kitchen reality. Plant-points traversal de-duplicates the common case where the eaten and cooked bases are the same recipe.
- **Consequences (−):** Two recipe pickers on the slot editor instead of one. Aggregation has to add base contributions on top of meal-recipe contributions, and batch-version meals must not double-count.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-12, FEAT-32, FEAT-36, FEAT-40.

### DEC-25 — Slot states modelled as an enum, not as dummy recipes

- **Chosen:** `slot_type enum('empty','recipe','eat_out','takeaway','leftovers')` with a CHECK ensuring `recipe_id IS NOT NULL` iff `slot_type = 'recipe'`.
- **Alternatives:** Reserved "Eat Out" / "Takeaway" / "Leftovers" recipe rows; nullable `recipe_id` only.
- **Why it won:** Dummy recipes pollute the picker, the search index, the related-recipes graph, and the rating tables for no semantic value. An enum makes the slot's nature visible in queries.
- **Consequences (+):** Aggregator can `WHERE slot_type = 'recipe'` to skip meal-recipe contributions cleanly. The picker doesn't have to hide special rows.
- **Consequences (−):** Adding a state ("packed lunch"?) requires a migration. The CHECK constraint must stay in lockstep with the enum.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-12, FEAT-30, FEAT-31, FEAT-36.

### DEC-26 — `paired_recipe_id` symmetry maintained at the application layer

- **Chosen:** Setting or clearing `paired_recipe_id` updates both sides of the pair within the recipe-save transaction. Not enforced as a database constraint.
- **Alternatives:** Postgres trigger maintaining symmetry; a separate `recipe_pairs` table with composite PK and a CHECK (the `related_recipes` pattern).
- **Why it won:** A trigger hides behaviour from the codebase. A separate join table is over-design for a one-to-one pairing. Transactional application-layer maintenance is visible, testable, and bounded.
- **Consequences (+):** Symmetry guarantee scoped to one well-tested code path.
- **Consequences (−):** A raw SQL update bypassing the application layer can break symmetry — no DB safety net. Requires explicit tests for the four state transitions (new pair, repair, clear, third-party transition) covered in cross-cutting concern #12.
- **Revisit when:** A second symmetric self-relation appears — at that point a generic pattern (the `related_recipes` shape) might be worth extracting.
- **Cross-refs:** FEAT-11, FEAT-23; cross-cutting concern #12.

### DEC-27 — `related_recipes` symmetric via composite PK with CHECK

- **Chosen:** `related_recipes (recipe_one_id, recipe_two_id)` with composite PK and `CHECK (recipe_one_id < recipe_two_id)`. One row per pair, symmetry baked into ordering.
- **Alternatives:** Two rows per pair (A→B and B→A); a `paired_recipe_id`-style FK on each recipe (used for the full↔batch pair instead — see DEC-26).
- **Why it won:** One row per pair, no duplication possible, no self-links (the CHECK prevents `recipe_one_id = recipe_two_id`). Symmetric reads are a UNION on either column.
- **Consequences (+):** DB-enforced invariants. No application-layer symmetry maintenance.
- **Consequences (−):** Queries on either side need a UNION or a view. Less convenient than two-row-per-pair for naive reads.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-11, FEAT-26.

### DEC-28 — Server-side recipe drafts (over localStorage) for cross-device editing

- **Chosen:** `recipe_drafts` table keyed `(user_id, recipe_id)` with `recipe_id NULL` allowed for new-recipe drafts. Editor autosaves on debounce, loads existing draft on open, clears on successful save and on account deletion.
- **Alternatives:** localStorage drafts; no drafts at all.
- **Why it won:** Matches the magic-link cross-device story — start a recipe on the phone, finish on the laptop. localStorage drafts strand work on one device.
- **Consequences (+):** Editing work survives device switches and browser-storage clears.
- **Consequences (−):** Network requests on every debounce — small per-request cost, real volume. Drafts table grows over time; new-recipe drafts with `recipe_id = NULL` can multiply per user (intentional, per the plan's UNIQUE-with-NULL behaviour). Cleanup of stale new-recipe drafts is not implemented; if it becomes a clutter problem, a TTL field is the upgrade path.
- **Revisit when:** Draft table size becomes visible or the autosave traffic shows up as a rate-limit pressure.
- **Cross-refs:** FEAT-11, FEAT-22, FEAT-35.

### DEC-29 — Account deletion as tombstoning, not cascade

- **Chosen:** Account deletion deletes `recipe_ratings` and `recipe_drafts`, NULLs `recipe_comments.userId`, `recipes.addedByUserId`, `meal_plans.createdByUserId`, `meal_plan_slots.chefUserId`, then deletes the user row. All in one transaction.
- **Alternatives:** Hard cascade (delete the user's recipes, comments, attributions); freeze the account (no deletion).
- **Why it won:** This is a shared household dataset. A leaving user shouldn't take their housemate's recipes with them. Tombstoning preserves household-level data integrity at the cost of nullable `addedBy` / `createdBy` / `chefUser` columns — a price the schema already pays.
- **Consequences (+):** Past plans, recipes, comments survive a user departure. Comments render as `[deleted user]`.
- **Consequences (−):** Every user-FK'd column is nullable, which makes "who created this" never a hard authorisation predicate (DEC-17 already accepts this). Account deletion needs to know every user-FK'd table — a new such table must extend the deletion sequence (cross-cutting concern #15). GDPR right-to-erasure of authored content is arguable under this model.
- **Revisit when:** Data-protection requirements change such that right-to-erasure must include authored content.
- **Cross-refs:** FEAT-35; non-goal: "Cascade delete on user account removal".

### DEC-30 — Lazy-create `shopping_list_items` on first GET

- **Chosen:** `shopping_list_items` rows are created on the first call to `shopping.getForPlan(planId)`, not at plan creation.
- **Alternatives:** Create rows eagerly when slots are populated; recompute and replace on every read.
- **Why it won:** Most plans never reach the shopping stage (drafts, cancelled trips). Eager creation pollutes the table with rows that will never be read.
- **Consequences (+):** Table stays focused on plans that actually generated a list.
- **Consequences (−):** The read becomes a read-and-maybe-write — the `getForPlan` procedure must run inside a transaction (cross-cutting concern #13). Two simultaneous first-reads on the same plan could race; the transaction makes the second one a no-op.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-12, FEAT-36, FEAT-38; cross-cutting concern #13.

### DEC-31 — Shopping list check-state resets on quantity change (vs warn-only)

- **Chosen:** When aggregation finds a line's current total differs from the total recorded at last check, `is_checked` resets to false silently.
- **Alternatives:** Warn the user that a quantity changed but keep the check; no detection at all.
- **Why it won:** Checking a line records the user's commitment to buy a *specific quantity*. If that quantity changes meaningfully, the commitment needs reaffirming. Reset is the unambiguous version of "your plan changed since you checked this."
- **Consequences (+):** The shopping list always reflects the current plan.
- **Consequences (−):** A trivial edit during shopping (a typo correction on a recipe) can re-uncheck lines mid-shop — potentially surprising. Accepted over warn-only.
- **Revisit when:** User feedback indicates the reset surprises rather than helps — at which point warn-with-confirm is the named alternative.
- **Cross-refs:** FEAT-38; non-goal: "Optimistic concurrency control" (LWW is the broader posture).

### DEC-32 — Plant-points computed, never stored

- **Chosen:** Plant-points are computed as `COUNT(DISTINCT ingredient_id) WHERE is_plant = true` at three granularities (recipe, day, plan). No materialised column.
- **Alternatives:** Stored on the recipe; materialised view per plan.
- **Why it won:** A recipe's ingredient set changes; storing a derived count means another invalidation path. At household scale the query is cheap. Day/plan granularity adds batch-version traversal and base-cook unions; computing on read is simpler than maintaining the materialisation.
- **Consequences (+):** Always current. No invalidation logic.
- **Consequences (−):** Every read does the count. At household scale, irrelevant.
- **Revisit when:** Read volume on plant-points makes the cost visible. Not at household scale.
- **Cross-refs:** FEAT-19 (recipe-level), FEAT-40 (day + plan with traversal); cross-cutting concern #10.

### DEC-33 — Europe/London time hardcoded, centralised in `dateUtils`

- **Chosen:** All "today"-relative logic (plan status filtering, overlap rule, shelf-life) uses Europe/London time, accessed through one date utility module. No per-user timezone.
- **Alternatives:** Per-user timezone column; UTC throughout; server-local time.
- **Why it won:** Both cooks live on Europe/London time. Hardcoding eliminates a class of edge cases (DST around plan boundaries, day-of-week-shifts at 23:30 UTC). Centralising in one module makes a future multi-timezone change a localised refactor rather than a hunt-and-replace.
- **Consequences (+):** All date logic agrees. DST-correct without library-of-the-day debates.
- **Consequences (−):** A user travelling abroad sees "today" as Europe/London "today," which can be the wrong day for plan filtering on a transatlantic flight. Accepted.
- **Revisit when:** Either cook moves abroad, or the app serves households outside the UK.
- **Cross-refs:** FEAT-27, FEAT-34, FEAT-37, FEAT-40; cross-cutting concern #8; non-goal: "Per-user timezone".

---

## Persistence and Server Logic

### DEC-34 — Drizzle transactions for all multi-statement writes

- **Chosen:** Account deletion, plan shrink/extend, plan duplication, recipe save (when method or ingredient list is replaced alongside header fields), and pair-symmetry updates all run in Drizzle transactions.
- **Alternatives:** Per-statement writes with compensating actions on failure; explicit advisory locks.
- **Why it won:** Postgres transactions are the simplest correct primitive for "all or nothing" semantics. Drizzle's `db.transaction()` API is straightforward.
- **Consequences (+):** Failure modes are bounded — a partial recipe save can't leave the method updated but the ingredients half-replaced.
- **Consequences (−):** Long-running transactions hold locks. None of the listed operations should be long, but a future inclusion of a slow step (a network call) inside a transaction is a recurring antipattern to watch for.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-20, FEAT-27, FEAT-28, FEAT-29, FEAT-35, FEAT-23.

### DEC-35 — `TRPCError` codes with domain codes attached via `cause`

- **Chosen:** Standard tRPC error codes (`UNAUTHORIZED`, `NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`) carry domain-specific shapes via the `cause` field — e.g. `TRPCError({ code: 'CONFLICT', cause: { code: 'INGREDIENT_IN_USE' } })`. The frontend's tRPC error link maps both into UI states.
- **Alternatives:** Custom error classes thrown across the wire; HTTP status codes only; a single error string convention.
- **Why it won:** tRPC's HTTP-aligned codes are a familiar surface for the client. The `cause` field gives a typed extension point for domain semantics without growing the tRPC code set. The pattern composes — every procedure that needs structured client behaviour follows the same shape.
- **Consequences (+):** UI mapping is one place. Adding a new domain error is additive — extend the `cause` union, extend the mapper.
- **Consequences (−):** The `cause` shape is a convention, not a type-enforced contract — easy to drift. Mitigated by tests at the boundary and by treating the mapper as the single source of truth.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-17 (establishes), FEAT-26, FEAT-28, FEAT-30; cross-cutting concern #11.

### DEC-36 — Last-write-wins on all shared resources

- **Chosen:** No row-version columns, no row-level locks, no optimistic-concurrency tokens. Recipe edits, slot assignments, and shopping-list check-state all use last-write-wins.
- **Alternatives:** Row versioning (`ROWVERSION` / `xmin` checks); optimistic locking with explicit `If-Match`; CRDTs for the offline-able state.
- **Why it won:** Per concrete collision surface — *recipe edits* (two cooks rarely edit the same recipe simultaneously), *slot assignment* (per-slot writes are independent), *shopping-list check-state* (the highest collision surface, especially with the offline queue) — LWW is the cheapest correct-enough answer. The shopping-list case is explicitly accepted as "last device to sync wins for that line item."
- **Consequences (+):** No version columns, no merge logic, no conflict UI.
- **Consequences (−):** A check-state line can flip from checked to unchecked because a partner's offline queue replayed an older state — user-visible weirdness possible. The plan names CRDT-lite as the upgrade path for that surface.
- **Revisit when:** Real-world shopping-list conflicts produce user-visible regressions ("I just checked that"). Synthetic concern alone isn't enough.
- **Cross-refs:** FEAT-31, FEAT-38, FEAT-42; non-goal: "Optimistic concurrency control", "Shopping-list conflict resolution beyond LWW".

### DEC-37 — Single-shop assumption for shelf-life warnings

- **Chosen:** Shelf-life warnings assume shopping happens on plan start date. Flag any ingredient with at least one use past `(planStart + shelfLifeDays)` and surface the latest-needed date.
- **Alternatives:** Multiple shop dates per plan; warn based on each ingredient's actual purchase date.
- **Why it won:** Most weeks the household shops once at the start. Surfacing the latest-needed date lets the cook plan a second shop manually when needed.
- **Consequences (+):** Aggregation is one pass with one anchor date. Warning logic is simple.
- **Consequences (−):** A plan with a planned mid-week top-up shop still warns against the start date. Cook has to read past the warning. Accepted as a v1 limitation.
- **Revisit when:** Top-up shops become routine enough that warnings are noise rather than signal. Implementation path: add `shop_date` field to plans (the plan already names this).
- **Cross-refs:** FEAT-37; non-goal: "Multi-shop shelf-life planning".

### DEC-38 — Plan date-overlap rule with past-plan exemption

- **Chosen:** New plans cannot overlap with non-deleted plans whose `endDate >= today`. Past plans are not considered.
- **Alternatives:** No overlap rule; overlap allowed with explicit confirmation; overlap rejected against any plan ever.
- **Why it won:** Two simultaneous active plans in the household are almost always a mistake. Past plans are historical and shouldn't constrain new ones — re-planning the same dates from a year ago is a legitimate operation.
- **Consequences (+):** Prevents the most common user error. Past plans remain accessible for reference and duplication.
- **Consequences (−):** "Today" depends on the timezone constant (DEC-33). The rule needs explicit test cases at the boundary (a plan ending today should not block a new plan starting today, depending on semantics — the plan tests both directions).
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-27, FEAT-28.

### DEC-39 — Soft warning (non-blocking) for batch-version slots with no upstream base supply

- **Chosen:** When a batch-version meal has no base supply earlier in the plan or in the same slot, the planner shows a warning but doesn't block save.
- **Alternatives:** Hard block on save; no warning.
- **Why it won:** The cook may have base supply from a previous plan, a freezer stash, or an intent to cook outside the plan model. Blocking save would force workarounds (a "fake" base cook to silence the warning) that pollute the data.
- **Consequences (+):** User retains autonomy. The model doesn't pretend to know about freezer contents.
- **Consequences (−):** It is possible to plan a batch-version meal with literally no base supply anywhere and have the shopping list silently underprovision. The cook is presumed to know.
- **Revisit when:** Real cooking shows underprovisioning becoming a recurring failure mode.
- **Cross-refs:** FEAT-32.

### DEC-40 — Migrations run via Fly `release_command` on deploy to `main`

- **Chosen:** GitHub Actions deploy workflow runs `flyctl deploy --release-command "pnpm drizzle-kit migrate"`. Migrations execute before the new release accepts traffic.
- **Alternatives:** Run migrations inside the app on startup; run them as a separate manual step.
- **Why it won:** `release_command` is the Fly idiom for "do this before traffic shifts" — fails-fast if the migration fails. Running on startup races between machines; running manually is error-prone.
- **Consequences (+):** A failing migration aborts the deploy before the new code accepts traffic. Bad migrations don't half-apply on rolling machines.
- **Consequences (−):** Migrations run against production directly — see DEC-65 (no staging). A migration that takes a long lock can stall deploys. Migration rollback is by code revert + new migration, not by re-running an "undo" — standard but worth knowing.
- **Revisit when:** Migration mistakes become a real cost — at which point a staging environment (DEC-65) is the named upgrade.
- **Cross-refs:** FEAT-48; non-goal: "Staging environment".

---

## Security

### DEC-41 — Magic-link authentication only; no passwords

- **Chosen:** Better Auth's magic-link provider via Resend. 10-minute link expiry. Cross-device delivery (request on phone, click on laptop) and same-device both supported. No password fields anywhere in the app.
- **Alternatives:** Email + password; OAuth providers; password + magic-link both.
- **Why it won:** Passwordless removes credential management entirely — no hashing, no reset flow, no breach surface, no password-strength UX. Matches the cross-device story for the recipe-editor autosave.
- **Consequences (+):** Smallest possible auth surface. No password-storage liability.
- **Consequences (−):** Total dependency on email deliverability. If Resend's deliverability degrades, sign-in is broken — no fallback path. Magic links require an email client to be reachable; offline-first sign-in is impossible. Phishing surface shifts to email-spoofing of the magic-link sender.
- **Revisit when:** Resend deliverability degrades persistently *and* Postmark migration also fails. At that point, password fallback becomes a recovery mechanism, not a primary path.
- **Cross-refs:** FEAT-13, FEAT-14, FEAT-15; non-goal: "Password authentication".

### DEC-42 — Better Auth (over Lucia or roll-your-own)

- **Chosen:** Better Auth with its Drizzle adapter, magic-link provider, and session helpers. Better Auth owns `users`, `sessions`, `accounts`, `verifications`; domain code references `user_id` directly.
- **Alternatives:** Lucia (more mature, less batteries-included); roll-your-own session table.
- **Why it won:** Magic-link provider + Drizzle adapter + session helpers out of the box. Saves several days of work that would otherwise have to ship before Phase 2 testing. Acknowledged risk: young library (initial release 2024).
- **Consequences (+):** Auth is a small surface to wire up.
- **Consequences (−):** Young library, smaller community, less battle-tested than Lucia. Mitigation: Better Auth owns a small, well-scoped table set; the rest of the app references `user_id` directly with no other coupling. Migration to Lucia or roll-your-own is bounded.
- **Revisit when:** Better Auth becomes unmaintained, suffers an unresolved security issue, or breaks its API in a way costlier to follow than to leave. Migration path: replace the auth router and session-reading code; the user table can stay structurally similar.
- **Cross-refs:** FEAT-10, FEAT-14; cross-cutting concern #17; non-goal: "Better Auth migration path".

### DEC-43 — Session cookies: HttpOnly, SameSite=lax, CSRF token validation

- **Chosen:** Better Auth's default session cookie posture — `HttpOnly`, `Secure`, `SameSite=lax`. CSRF token validation enabled on state-changing requests.
- **Alternatives:** Bearer tokens in `Authorization` header; `SameSite=strict`; no CSRF tokens (relying on SameSite alone).
- **Why it won:** HttpOnly cookies are unreachable from JavaScript — eliminates token-exfiltration via XSS as an attack on session theft. SameSite=lax allows top-level GETs (the magic-link click) while blocking cross-site POSTs. CSRF tokens cover the residual gap for browsers that don't enforce SameSite consistently.
- **Consequences (+):** Defense in depth on session theft.
- **Consequences (−):** Same-origin assumption is load-bearing (DEC-44). Browser cookie quirks can occasionally surprise (Safari ITP, third-party cookie deprecation drift).
- **Revisit when:** Browser cookie policy shifts make the current posture unworkable.
- **Cross-refs:** FEAT-14.

### DEC-44 — CORS in dev only; production is same-origin via `@fastify/static`

- **Chosen:** `@fastify/cors` configured for the Vite dev origin in development. In production the frontend is served by the same Fastify process via `@fastify/static`, so CORS plays no role.
- **Alternatives:** CORS enabled in prod against a separate frontend domain.
- **Why it won:** Same-origin in prod eliminates the cross-site cookie dance. Session cookies work without `SameSite=none` and `Secure` workarounds. CORS surface area exists only on the developer's machine.
- **Consequences (+):** Simpler cookie/security model in prod. No preflight overhead.
- **Consequences (−):** Splitting the frontend onto a CDN or a separate hostname later is a non-trivial change. The frontend cannot easily be hosted independently. Vite's `server.proxy` reproduces same-origin in dev — works well but adds one config surface.
- **Revisit when:** Splitting the frontend hosting becomes desirable (it should not at this scale).
- **Cross-refs:** FEAT-03, FEAT-05, FEAT-04 (Vite proxy).

### DEC-45 — Rate limits sized for household traffic

- **Chosen:** `@fastify/rate-limit` configured: 100 req/min per IP for unauthenticated routes, 300 req/min per session for authenticated, 5 magic-link requests per email per hour.
- **Alternatives:** Higher limits ("won't ever hit"); lower limits (tighter abuse resistance); per-procedure custom limits.
- **Why it won:** Nobody legitimate hits 300 req/min from a single session, but the planner with optimistic updates can fire bursts of slot-assignment mutations during bulk planning — 300/min keeps that comfortable. The tighter magic-link-per-email rate is specifically the email-spam abuse vector.
- **Consequences (+):** Smaller abuse surface. Magic-link spam from a single email address is bounded.
- **Consequences (−):** Genuine bursts (importing a large recipe list, scripted backfills) hit the limit. Per-IP limits hurt households behind a shared NAT — academic at two-user scale.
- **Revisit when:** Cloudflare's edge sees patterns suggesting limits are wrong in either direction. Bulk-edit features would also force a revisit.
- **Cross-refs:** FEAT-45.

### DEC-46 — Explicit CSP policy

- **Chosen:** CSP configured explicitly via `@fastify/helmet`: `img-src` includes `res.cloudinary.com` and `data:`; `connect-src` includes Sentry's browser ingest; `script-src` and `style-src` allow `'self'` plus the minimum needed for shadcn's styles; everything else defaults to `'self'`.
- **Alternatives:** Helmet's defaults; no CSP; report-only mode.
- **Why it won:** Explicit allow-list is the strong-default. The dependencies that need cross-origin (Cloudinary, Sentry) are few and named.
- **Consequences (+):** Tight XSS containment. Any new cross-origin dependency is a deliberate policy edit.
- **Consequences (−):** Adding a third-party (analytics, a CMS, a chat widget) requires a CSP edit before it works in prod — easy to miss in dev where Vite serves with different headers. Inline styles needed by some shadcn components require `unsafe-inline` for `style-src` or a hash/nonce strategy — the plan accepts the minimum needed; if that turns out to be `unsafe-inline`, a hash/nonce upgrade is the harder path.
- **Revisit when:** Adding a new cross-origin source; tightening `style-src` away from `unsafe-inline` if currently permitted.
- **Cross-refs:** FEAT-47.

### DEC-47 — `@fastify/helmet` for security headers

- **Chosen:** `@fastify/helmet` configured with HSTS, X-Frame-Options, secure-cookie flags, plus the explicit CSP from DEC-46.
- **Alternatives:** Custom header middleware; no headers.
- **Why it won:** A vetted set of secure defaults with one plugin. Cheaper than writing them by hand and getting one wrong.
- **Consequences (+):** Standard security headers without per-route ceremony.
- **Consequences (−):** Helmet's defaults must be reviewed when upgrading the plugin — a major version can change defaults.
- **Revisit when:** Helmet major version upgrade.
- **Cross-refs:** FEAT-03, FEAT-47.

### DEC-48 — Fastify pre-handler hook enforces auth outside `/api/auth/*`

- **Chosen:** A single pre-handler hook rejects requests without a valid session cookie unless the path is under `/api/auth/*`. Auth context is attached to tRPC's per-request context.
- **Alternatives:** Per-procedure auth checks; tRPC middleware only.
- **Why it won:** A single gate catches every route — no procedure can forget. tRPC middleware is layered on top for finer checks but doesn't replace the gate.
- **Consequences (+):** Default-deny posture. A new procedure is authenticated by default.
- **Consequences (−):** Any future public-readable surface (a shared recipe link, a public health endpoint beyond `/api/health`) requires an explicit allow-list edit at the hook.
- **Revisit when:** A public-readable surface is needed.
- **Cross-refs:** FEAT-14, FEAT-46 (`/api/health` is unauthenticated by Fly's requirement).

### DEC-49 — All user-generated text rendered as plain text; no markdown, no HTML

- **Chosen:** Recipe names, descriptions, method steps, and comments are stored as plain text and rendered through React's default text-content escaping. `dangerouslySetInnerHTML` is not used anywhere.
- **Alternatives:** Markdown with a sanitiser (DOMPurify, sanitize-html); a rich-text editor (TipTap, Slate); plain text but allow newlines only.
- **Why it won:** Plain text + React escaping eliminates XSS from user-generated content as a class of bug — no sanitiser dependency to keep current, no CSP carve-outs, no render-parity bugs between surfaces. The aesthetic gain of rich text is minimal at household scale.
- **Consequences (+):** Hardest part of XSS hardening solved by not opting in. CSP can stay tight.
- **Consequences (−):** Method steps cannot use bold/italic for emphasis. Two cooks negotiate that verbally.
- **Revisit when:** Method steps become structurally hard to parse without emphasis. The two-cook scope makes this unlikely.
- **Cross-refs:** FEAT-21 (editor), FEAT-25 (comments); non-goal: "Rich text in user-generated content".

### DEC-50 — Direct browser → Cloudinary upload with signed credentials

- **Chosen:** A tRPC procedure issues signed Cloudinary upload credentials with constraints (`allowed_formats: ['jpg','jpeg','png','webp']`, `max_file_size: 5 MB`, fixed transformation preset). The browser uploads directly to Cloudinary. The returned URL is stored on the recipe via a standard update procedure. The backend never proxies binary data.
- **Alternatives:** Upload to the backend, validate, forward to Cloudinary; upload to S3/R2 instead; client-side direct upload without signed credentials (insecure).
- **Why it won:** Constraints baked into the signing parameters mean Cloudinary enforces them — the backend never sees megabyte-scale request bodies. The Fly machine's memory budget and request lifetime stay reserved for typed RPC.
- **Consequences (+):** API path stays small-payload. Cloudinary handles format conversion and resizing.
- **Consequences (−):** Cloudinary vendor lock-in for media — moving to a different host means re-uploading every asset and updating every URL. Orphaned uploads (signed credential issued, recipe never saved) accumulate; no cleanup job in v1.
- **Revisit when:** Cloudinary's signed-upload model changes such that constraints can't be enforced at signing; or storage cost / asset clutter becomes visible.
- **Cross-refs:** FEAT-18, FEAT-21; non-goal: "Backend proxying of image uploads", "Cloudinary orphan cleanup job".

---

## UI

### DEC-51 — Tailwind + shadcn/ui

- **Chosen:** Tailwind CSS for utility-first styling. shadcn/ui as copy-paste primitive components owned in the codebase. Dark-mode handled by Tailwind's `dark:` variant.
- **Alternatives:** CSS Modules, styled-components, Emotion, MUI, Mantine.
- **Why it won:** Utility-first scales well with component reuse. shadcn/ui components live in the codebase rather than as an external dependency — patching is a normal edit, not a vendor PR. Dark mode is supported out of the box.
- **Consequences (+):** No styled-components runtime cost. Components are owned outright. Dark mode is mostly free.
- **Consequences (−):** Tailwind classes in JSX get long; readability degrades on complex components without abstraction. shadcn updates are manual — pulling improvements from upstream requires diffing.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-04, FEAT-16 (theme), every UI feature.

### DEC-52 — Click-to-assign slot interaction (over drag-and-drop)

- **Chosen:** Tap a recipe in the sidebar to select it; tap an empty slot to assign. Assigned slots are tappable to edit, change, or clear. Same gesture works for touch, mouse, and keyboard.
- **Alternatives:** Drag-and-drop with library (dnd-kit, react-dnd); both DnD and click.
- **Why it won:** Primary use is one-handed on a phone in a kitchen. Click-to-assign is faster for bulk planning, works identically across input modalities, and satisfies WCAG 2.1 AA without dedicated DnD a11y machinery (key bindings, screen-reader announcements). DnD on mobile is fiddly.
- **Consequences (+):** Same code path across input modalities. Accessibility comes for free.
- **Consequences (−):** Desktop power users may prefer DnD on first encounter. The two-step interaction (select, then place) is slightly less direct than dragging.
- **Revisit when:** Usability testing shows the interaction confuses or slows users in practice. Desktop-power-user feedback alone is not a sufficient trigger.
- **Cross-refs:** FEAT-31; non-goal: "Drag-and-drop slot assignment".

### DEC-53 — Phone-first responsive design

- **Chosen:** Responsive across mobile, tablet, desktop, with the planner and shopping list designed for one-handed kitchen use first. Desktop is a derived view.
- **Alternatives:** Desktop-first with mobile adaptations; separate mobile app.
- **Why it won:** Real-use context is the kitchen — both meal planning (often on the sofa with a phone) and shopping (in the supermarket with a phone). Designing desktop-first would invert the constraint hierarchy.
- **Consequences (+):** The hardest layout (small screen, one thumb) drives design; desktop falls out.
- **Consequences (−):** Desktop power features (keyboard shortcuts, dense displays) get less attention. The recipe editor on a small screen is constrained.
- **Revisit when:** Desktop usage becomes the dominant pattern. Unlikely.
- **Cross-refs:** FEAT-31, FEAT-39, FEAT-21.

### DEC-54 — Theme preference (system / light / dark) persisted per-user in DB

- **Chosen:** `users.theme_preference enum('system','light','dark') DEFAULT 'system'`. `ThemeProvider` reads from the session profile; toggle in settings.
- **Alternatives:** localStorage; cookie; no persistence beyond the session.
- **Why it won:** Persisted per-user follows the user across devices and browsers — consistent with the magic-link cross-device story.
- **Consequences (+):** Theme follows the user, not the device. One source of truth.
- **Consequences (−):** A theme change is an authenticated DB write — heavier than localStorage. Unauthenticated initial render falls back to `system`, which can cause a brief flash if the user prefers `light` against a dark OS.
- **Revisit when:** Initial-render flash becomes a complaint.
- **Cross-refs:** FEAT-10 (column), FEAT-16 (ThemeProvider + settings).

### DEC-55 — WCAG 2.1 AA, spot-checked via `axe-core` in Playwright

- **Chosen:** AA conformance on primary flows, validated via `axe-core` in Playwright against both light and dark themes. Not AAA. Not a full manual audit. Not screen-reader-tested across every component.
- **Alternatives:** AAA conformance; full manual audit; no a11y target.
- **Why it won:** AA is the floor for "anyone using assistive tech can use the app." AAA materially constrains design choices (contrast ratios, language requirements) for marginal gain on a two-user app. Full manual audit is professional-services money.
- **Consequences (+):** Keyboard navigation, contrast, focus management are non-negotiable and enforced automatically. Catches regressions in CI.
- **Consequences (−):** `axe-core` catches a subset of real a11y issues; some screen-reader-specific bugs slip through. Not a substitute for testing with assistive tech if the app's audience expands.
- **Revisit when:** App is made publicly accessible to users with disabilities at any scale.
- **Cross-refs:** FEAT-53.

---

## Testing

### DEC-56 — Vitest + Testcontainers for backend integration tests

- **Chosen:** Vitest with Testcontainers spinning up ephemeral Postgres for backend integration tests. Tests run against the actual SQL Drizzle emits, FK constraints, seed data, and the tRPC procedure surface (including auth context).
- **Alternatives:** Mocked DB layer; SQLite in-memory; a shared dev DB reset between tests.
- **Why it won:** Mocking the DB misses constraint behaviour, query bugs, and the actual SQL Drizzle generates. Testcontainers gives a real Postgres per test run — slow per-run but trustworthy. Particularly important without a staging environment (DEC-65), where Testcontainers tests are the only pre-prod check on migration SQL.
- **Consequences (+):** Tests catch FK violations, CHECK failures, trigger behaviour, and Drizzle-emitted SQL bugs.
- **Consequences (−):** Slower per-run than mocks (container boot + migration apply). Requires Docker on the CI runner.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-02, FEAT-07, every backend procedure feature.

### DEC-57 — React Testing Library for component-level frontend tests

- **Chosen:** RTL focused on conditional rendering — own vs. others' comments, soft-delete states, slot type variants, batch-cook vs single-recipe card rendering, theme rendering.
- **Alternatives:** Enzyme (legacy); test only via Playwright; no component tests.
- **Why it won:** RTL exercises components the way a user does. The named surfaces (conditional rendering, theme) are component-level concerns; pushing them to Playwright would over-load the E2E suite.
- **Consequences (+):** Fast feedback on UI logic. Catches regressions before E2E.
- **Consequences (−):** Cannot exercise real network or storage. Real-DOM details (focus order, animations) can drift from tests.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-21, FEAT-31, FEAT-32, FEAT-16, FEAT-25.

### DEC-58 — Playwright E2E for critical paths with `storageState` auth reuse

- **Chosen:** Playwright covers sign-in via magic link, create recipe, plan a week including a batch-cook slot, generate shopping list, check off items. Auth reused across tests via `storageState` to bypass magic-link redemption.
- **Alternatives:** Cypress; Selenium; no E2E.
- **Why it won:** Playwright's `storageState` makes auth reuse trivial — without it, every test pays the magic-link round trip. Cross-browser support is a free benefit. Critical-path coverage at this layer protects the integration points the unit tests cannot.
- **Consequences (+):** Confidence that the full stack works end-to-end before deploys.
- **Consequences (−):** Slow to run. Flaky tests have outsize cost. Magic-link bypass via `storageState` means the auth flow itself is only exercised once (in the seed test).
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-52.

### DEC-59 — Coverage is not a target; behaviour-focused tests on high-value surfaces

- **Chosen:** No `--coverage` threshold enforced. Tests concentrate on aggregation math (including base-cook contributions and no-double-count for batch-version meals), plant-points traversal, shelf-life warnings, and date-overlap / date-edit migrations.
- **Alternatives:** Coverage threshold (75%, 80%, 90%); branch coverage requirement.
- **Why it won:** Coverage as a metric rewards uniform test density regardless of risk profile. The plan names the high-value surfaces explicitly; pushing coverage past those creates ceremonial tests that slow iteration without finding bugs.
- **Consequences (+):** Tests where they earn their keep. No ceremonial coverage for trivial code.
- **Consequences (−):** A code path with no test can slip past — relies on judgment about which paths matter. Regressions in low-coverage areas are possible.
- **Revisit when:** A real regression sneaks through in a code path that "should have had a test." The question then is whether to test that one path, not to globally lift coverage.
- **Cross-refs:** FEAT-07 (CI), every test-containing feature.

---

## Deployment

### DEC-60 — Single Fly.io app serves both API and frontend same-origin

- **Chosen:** One Fly app. Production image is multi-stage: stage 1 builds the frontend (`vite build`); stage 2 builds the backend via `esbuild`; the final image runs Fastify with `@fastify/static` serving `dist/` at the root and the API at `/api/*`.
- **Alternatives:** Separate frontend hosting (Vercel, Netlify, Cloudflare Pages) + Fly for the API; one Fly app per workspace.
- **Why it won:** Same-origin in production removes the cross-site cookie dance. One deploy artifact, one rollback target, one log stream, one bill. The frontend bundle is small enough that Fastify static serving is not a bottleneck — and Cloudflare in front (DEC-72) handles cache.
- **Consequences (+):** Cookies just work. One thing to deploy and roll back.
- **Consequences (−):** The Fly machine serves static assets — a misuse of compute compared to a dedicated CDN, but compute is cheap at this scale. A frontend change requires a full backend deploy.
- **Revisit when:** Static-asset bandwidth becomes a meaningful cost, or the frontend's build time slows the deploy unacceptably.
- **Cross-refs:** FEAT-05, FEAT-06; non-goal (implicit): separate hosting per workspace.

### DEC-61 — esbuild bundle in production, `tsx` in dev

- **Chosen:** Production backend is a single bundled JS file via `esbuild`. Local dev runs `tsx` directly on the TS sources.
- **Alternatives:** `tsx` in prod; `tsc` emit + Node; `swc` bundle.
- **Why it won:** A single bundle starts faster than `tsx` (no on-the-fly compilation per request) — important under auto-stop where every cold-start pays compile cost. `esbuild` is fast enough that the build step is trivial. `tsx` in dev keeps the inner loop snappy.
- **Consequences (+):** Fast prod startup. Small image. Different toolchain in dev/prod is conventional and well-understood.
- **Consequences (−):** Two toolchains means one more thing to keep working. `esbuild` doesn't do type-checking; `pnpm typecheck` is the separate gate.
- **Revisit when:** Bundle quirks (a dependency that doesn't bundle cleanly) make `tsx` cheaper. Unlikely for typical Node deps.
- **Cross-refs:** FEAT-05.

### DEC-62 — Multi-stage Dockerfile

- **Chosen:** Stage 1 builds the frontend; stage 2 builds the backend bundle; the final image carries only the runtime essentials.
- **Alternatives:** Single-stage Dockerfile; separate Docker images per workspace.
- **Why it won:** Final image stays small — no build toolchain in production. Standard Docker pattern.
- **Consequences (+):** Smaller image, smaller attack surface, faster pull.
- **Consequences (−):** Slightly more complex Dockerfile. Layer caching needs attention to avoid rebuild churn.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-05.

### DEC-63 — Single Fly region (`lhr`); Postgres co-located

- **Chosen:** One Fly region (`lhr`), Fly Postgres in the same region attached via `flyctl postgres attach`. Private-network connection.
- **Alternatives:** Multi-region with replication; a different single region.
- **Why it won:** Both cooks are in the UK. `lhr` is the lowest-latency region for the household. Multi-region adds replication topology, eventual-consistency reasoning, and meaningful cost for zero latency benefit.
- **Consequences (+):** Lowest latency for the intended users. Private network removes a public-internet hop. Cheapest sensible deploy.
- **Consequences (−):** A regional Fly outage takes the app down entirely — no warm failover. Mitigation: Fly snapshots + R2 dump (DEC-73) for restore, not for HA.
- **Revisit when:** The user base ever leaves the UK.
- **Cross-refs:** FEAT-05, FEAT-06, FEAT-09; non-goal (implicit): multi-region deployment.

### DEC-64 — Auto-stop enabled; 3-second cold-start budget; reconsider always-on if exceeded

- **Chosen:** Fly auto-stop enabled — the machine sleeps when idle and wakes on first request. Cold-start time measured in Phase 6. If it exceeds 3 seconds, reconsider always-on (~$5/month).
- **Alternatives:** Always-on from day one; auto-stop without a budget.
- **Why it won:** Single-region two-user app is idle 23 hours/day. Auto-stop means compute is paid only when used. Three seconds is roughly the threshold at which "did it load?" becomes "did I tap right?" — beyond that, the household-level UX cost is real.
- **Consequences (+):** Minimal hosting cost.
- **Consequences (−):** First request after idle pays cold-start latency. Lock interactions with pool size (DEC-71) and machine class — more connections = longer first-request — covered in cross-cutting concern #18.
- **Revisit when:** Phase 6 measurement shows >3s. Also revisit if the household notices lag in practice; measured budgets and lived experience aren't always aligned.
- **Cross-refs:** FEAT-05, FEAT-51; cross-cutting concern #18; non-goal: "Always-on vs. auto-stop".

### DEC-65 — No staging environment

- **Chosen:** Migrations and code ship straight to production via `release_command` on push to `main`. Mitigation is Testcontainers integration tests (DEC-56) covering actual SQL Drizzle emits, plus rehearsed restore drills (DEC-73 / FEAT-50).
- **Alternatives:** Full staging environment (separate Fly app + Postgres); production-shadow / canary deploys.
- **Why it won:** Staging doubles infra cost and operational surface (drift, seeding, secret rotation across two environments). For a household-scale app, the Testcontainers + restore-drill posture is a credible substitute.
- **Consequences (+):** Half the infrastructure. No drift between staging and prod.
- **Consequences (−):** Migration mistakes go straight to prod data. A bad migration that passes tests but loses data in production is the named failure mode. Restore drill is rehearsed; recovery is not zero-time.
- **Revisit when:** Migration mistakes against prod become a real cost — even one production data-loss incident is a sufficient trigger.
- **Cross-refs:** FEAT-48, FEAT-50, FEAT-49; non-goal: "Staging environment".

### DEC-66 — GitHub Actions for CI/CD

- **Chosen:** GitHub Actions for lint / typecheck / test on push, and deploy on push to `main` via `flyctl`. Nightly scheduled workflow for `pg_dump → R2`.
- **Alternatives:** CircleCI, GitLab CI, Jenkins, BuildKite.
- **Why it won:** Sufficient at this scale. Free tier covers the workflow. `flyctl` integrates trivially.
- **Consequences (+):** One vendor for source control and CI. Cheap.
- **Consequences (−):** GitHub Actions outages stop deploys. Action-marketplace dependencies (e.g. for setting up flyctl) introduce supply-chain risk.
- **Revisit when:** GitHub Actions limits become binding or pricing changes shift the calculus.
- **Cross-refs:** FEAT-07, FEAT-48, FEAT-49.

### DEC-67 — Vite `server.proxy` for dev same-origin

- **Chosen:** Local dev runs Fastify and Vite as separate processes. Vite's `server.proxy` forwards `/api/*` to Fastify, reproducing prod same-origin behaviour without an extra proxy layer.
- **Alternatives:** Run a real reverse proxy locally (Caddy, Nginx); ship dev with CORS open.
- **Why it won:** Built into Vite, no extra moving parts. Same-origin in dev means cookies behave the same way as in prod.
- **Consequences (+):** Dev mirrors prod cookie behaviour. No CORS surprises crossing into prod.
- **Consequences (−):** WebSocket / HMR routing through the proxy occasionally hiccups; rarely an issue in practice.
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-04.

### DEC-68 — Cloudinary for media (vendor lock-in accepted)

- **Chosen:** Cloudinary for image storage, transforms, and CDN delivery. Direct browser uploads via signed credentials (DEC-50).
- **Alternatives:** S3 + CloudFront, Cloudflare R2 + Workers + image-transform, self-hosted.
- **Why it won:** Cloudinary handles upload, format conversion, resizing, and CDN delivery in one. Free tier covers household-scale traffic. The alternatives require either glue code (R2 + transform worker) or a self-hosted pipeline.
- **Consequences (+):** Image pipeline is one provider away.
- **Consequences (−):** Vendor lock-in for media — moving away means re-uploading every asset and updating every URL. URLs are Cloudinary-shaped; `image_url` is stored as-is.
- **Revisit when:** Cloudinary pricing / policy changes; or the signed-upload model changes such that constraints can't be enforced at signing.
- **Cross-refs:** FEAT-18, FEAT-21; non-goal: "Backend proxying of image uploads".

### DEC-69 — Resend for transactional email; Postmark as documented fallback

- **Chosen:** Resend for magic-link delivery. Domain verified with Resend; SPF, DKIM, DMARC configured. Postmark named in the plan as the conservative migration path if deliverability degrades.
- **Alternatives:** Postmark from day one; SendGrid; Amazon SES; self-hosted SMTP.
- **Why it won:** Good developer experience, easy domain verification, fits Better Auth's provider abstraction. Postmark is the proven-deliverability fallback at higher cost.
- **Consequences (+):** Magic-link UX hinges on this — Resend's deliverability has been good across the threshold of email-anti-abuse machinery.
- **Consequences (−):** If Resend deliverability degrades, sign-in is broken. The fallback requires a configuration change and a new domain verification with Postmark — bounded but not instant.
- **Revisit when:** Resend deliverability issues affect magic-link receipt. Status-page monitoring is the early-warning system.
- **Cross-refs:** FEAT-13, FEAT-14; non-goal: "Email-provider fallback".

---

## Infrastructure

### DEC-70 — Fly Postgres (managed, in-region, private network)

- **Chosen:** A Fly Postgres cluster in `lhr`, attached via `flyctl postgres attach`. Private-network connection — no public-internet hop.
- **Alternatives:** Self-managed Postgres on a Fly machine; Supabase; Neon; RDS.
- **Why it won:** Managed by Fly within the same private network. No DBA work. Snapshot management is built in.
- **Consequences (+):** No public DB endpoint. Snapshots automated.
- **Consequences (−):** Fly Postgres is less feature-rich than e.g. RDS (no read replicas easily, no point-in-time recovery beyond snapshots). Single point of failure within the region.
- **Revisit when:** Fly Postgres feature gaps become binding (PITR, read replicas).
- **Cross-refs:** FEAT-06, FEAT-09.

### DEC-71 — `pg-pool` size committed once after Phase 1 measurement

- **Chosen:** A static `pg-pool` size, chosen against measured memory profile on the smallest Fly machine class (expected 5–10).
- **Alternatives:** Dynamic pool sizing; library defaults; guess.
- **Why it won:** Dynamic pool sizing introduces tuning surface and observability needs for a workload whose ceiling is two concurrent users. Static and measured is correct-enough.
- **Consequences (+):** Predictable connection behaviour. No autotuning complexity.
- **Consequences (−):** Locked-in until Phase 6 measurement reveals problems. Interacts with cold-start (more connections = longer first-request) and machine class changes (cross-cutting concern #18).
- **Revisit when:** Memory pressure or connection-exhaustion errors appear in Phase 6 observability. Also if Fly machine class is upgraded.
- **Cross-refs:** FEAT-08, FEAT-09, FEAT-51; cross-cutting concern #18.

### DEC-72 — Cloudflare in front: registrar, DNS, CDN, TLS — with `/api/*` cache bypass

- **Chosen:** Cloudflare Registrar for the domain. Orange-cloud DNS proxies the Fly app. Edge caching for static-asset paths; `/api/*` bypasses cache via a cache rule. TLS terminates at Cloudflare; Fly's origin cert remains for the Cloudflare-to-Fly hop.
- **Alternatives:** Direct Fly DNS (no edge); a different CDN (Fastly, CloudFront); registrar elsewhere.
- **Why it won:** Registrar, DNS, and CDN in one vendor. Edge caching for static assets reduces Fly egress and cold-path latency. DDoS protection at the edge. TLS terminated edge-side.
- **Consequences (+):** Cheap edge cache, free TLS, one DNS console.
- **Consequences (−):** Cloudflare in front means Cloudflare outages affect availability. Cache rules must keep `/api/*` excluded — a misconfigured rule could cache an authenticated response. Vendor lock-in for DNS/registrar is mild but real.
- **Revisit when:** Cloudflare pricing / policy changes meaningfully; or a misconfigured cache rule causes a security incident.
- **Cross-refs:** FEAT-06.

### DEC-73 — Off-site backup: nightly `pg_dump` to Cloudflare R2 (atop Fly daily snapshots)

- **Chosen:** Fly Postgres takes automated daily snapshots (in-vendor). A nightly GitHub Actions workflow runs `pg_dump` via `flyctl proxy` and uploads to a Cloudflare R2 bucket — off-site insurance. Restore drills documented in `OPERATIONS.md`: Fly snapshot list + restore-to-new-cluster procedure, and R2-dump-to-fresh-cluster procedure. Both rehearsed once before launch.
- **Alternatives:** Rely on Fly snapshots only; backup to S3; no backups (unacceptable).
- **Why it won:** Two backup tiers, different failure modes. Fly snapshots cover routine recovery; R2 dumps cover Fly-level catastrophe (account loss, regional disaster, vendor closure). R2 is cheap (~$0.50/month at this volume).
- **Consequences (+):** Vendor-catastrophe insurance at trivial cost. Two recovery paths.
- **Consequences (−):** `pg_dump` is logical — restore times grow with data. Restore drills require occasional re-rehearsal as procedures drift. `FLY_API_TOKEN` for the workflow is a sensitive secret to rotate.
- **Revisit when:** Restore time becomes operationally problematic (much-larger dataset).
- **Cross-refs:** FEAT-49, FEAT-50.

### DEC-74 — Docker Compose for local dev (Postgres only)

- **Chosen:** `docker-compose.yml` declares Postgres only. Fastify and Vite run on the host for fast reload and simpler debugging.
- **Alternatives:** All services in Compose; everything on the host with a system Postgres install.
- **Why it won:** Postgres is the stateful service; everything else benefits from host-level reload. A single `docker compose up postgres` is the entire infra command for local dev.
- **Consequences (+):** Fast inner loop. Host-level debugging works without container attach.
- **Consequences (−):** Two ways to run a service (containerised Postgres, host Fastify) — slightly more setup than "everything in Compose."
- **Revisit when:** Not anticipated.
- **Cross-refs:** FEAT-02.

---

## Observability

### DEC-75 — Pino → Axiom for structured logs (30-day retention)

- **Chosen:** Fastify's Pino logs ship to Axiom via the HTTP transport. JSON structured. 30-day rolling window on Axiom's free tier.
- **Alternatives:** Better Stack, Datadog, self-hosted Loki + Grafana, console-only.
- **Why it won:** Structured JSON, cheap aggregation, generous free tier at household traffic. 30 days covers the realistic incident-response window plus margin.
- **Consequences (+):** Searchable structured logs. Cheap.
- **Consequences (−):** 30 days is a real ceiling — an incident requiring older logs has to make do without. Vendor dependency.
- **Revisit when:** An incident requires logs older than 30 days and the answer would materially differ from "we'll know next time." Or if Axiom pricing changes.
- **Cross-refs:** FEAT-43.

### DEC-76 — Sentry frontend + backend with PII scrubbing; session replay disabled

- **Chosen:** Sentry React SDK + Sentry Node SDK. `beforeSend` strips cookies, authorization headers, and email addresses. Session replay disabled.
- **Alternatives:** Better Stack errors, Rollbar, self-hosted Sentry, no error tracker.
- **Why it won:** Symmetric error capture across the stack. PII scrubbing in `beforeSend` is the standard pattern. Session replay would add a meaningful PII surface and require a cookie-consent banner for GDPR compliance — debugging value is low at two-user scale where the affected user can be asked directly.
- **Consequences (+):** Errors visible without manual log scraping. No cookie-consent banner needed.
- **Consequences (−):** `beforeSend` is a custom function — drift between the redaction logic and what's actually in payloads is a real risk that needs occasional review. No session replay means some hard-to-reproduce bugs stay hard.
- **Revisit when:** Multi-household / multi-user-per-household ships — at which point the PII vs. debug-value calculus changes and session replay may earn its consent banner.
- **Cross-refs:** FEAT-44; non-goal: "Session replay in Sentry".

### DEC-77 — `req.id` propagated end-to-end (Pino → Axiom → Sentry tag)

- **Chosen:** Fastify Pino generates a `req.id` per request and logs it on every entry. Attached to Sentry events as a tag. Cross-references logs and errors.
- **Alternatives:** OpenTelemetry distributed tracing; no trace correlation; logs and errors as separate domains.
- **Why it won:** A single ID across logs and Sentry events is enough to follow a request through both surfaces. OTel is the principled answer but introduces a collector and a pricing tier not justified at this scale.
- **Consequences (+):** Cross-system debugging works ("find the Axiom logs for this Sentry error").
- **Consequences (−):** Not full distributed tracing — no spans, no flame graphs. A future move to OTel is a non-trivial upgrade.
- **Revisit when:** Distributed tracing becomes worth its cost (it should not at this scale).
- **Cross-refs:** FEAT-03, FEAT-43, FEAT-44.

### DEC-78 — Sentry alerts at absolute thresholds (>5 errors / 5 min), not percentages

- **Chosen:** A single absolute-threshold rule in Sentry: >5 errors per 5 minutes pages.
- **Alternatives:** Percentage-based ("error rate > 1%"); error-class-based; no alerts.
- **Why it won:** Percentage thresholds page constantly at low traffic — one flaky request becomes 100% error rate. Absolute thresholds align noise with real signal.
- **Consequences (+):** No flake-induced pages. Quiet by default.
- **Consequences (−):** A genuinely-low-volume bug affecting a small percentage of requests at moderate volume could stay below the absolute threshold. At household scale, irrelevant.
- **Revisit when:** Traffic grows past the point where 5 errors is invisibly small noise relative to volume.
- **Cross-refs:** FEAT-44.

### DEC-79 — `/api/health` endpoint backs Fly health checks (verifies DB connectivity)

- **Chosen:** `/api/health` returns 200 only if the app can reach the DB. Fly's health checks call it.
- **Alternatives:** TCP-only health check; an `/api/health` that returns 200 without checking the DB; no health endpoint.
- **Why it won:** A health check that doesn't verify the DB connection misses the most common real failure mode (pool exhausted, DB unreachable). A failing health check stops bad traffic at the load-balancer layer.
- **Consequences (+):** Fly takes unhealthy machines out of rotation automatically.
- **Consequences (−):** DB hiccups cascade into "machine unhealthy" — short transient blips can cause unnecessary restarts. The check timeout / threshold needs tuning.
- **Revisit when:** Health-check flapping becomes operationally noisy.
- **Cross-refs:** FEAT-46, FEAT-05.

---

## Most Worth Deep Consideration on Revisit

The following decisions are genuine tradeoffs whose costs are accepted today but plausibly become binding. They are the most likely candidates for re-evaluation as the project moves beyond v1, and the most likely to invalidate downstream features if changed.

- **DEC-17 — Single-household MVP / no scope threading.** The right multi-tenancy mechanism (RLS? subdomain routing? membership join table?) depends on what multi-tenancy *means* when it arrives. Pre-building an abstraction risks fitting none. The cost: every domain query has to be rewritten when the constant becomes a session-derived value. The trigger condition (a concrete second-household requirement) is the right one, but be aware that touching this affects every read.

- **DEC-22 — No recipe snapshotting on slot assignment.** Recipe edits propagate to past plans. Cheap today; the right answer if past-plan integrity is ever required for an external reason (regulatory, sharing, public archive) becomes a substantial migration — copy-on-assign storage and ingredient-mutation path changes.

- **DEC-36 — Last-write-wins on shopping-list check-state.** The plan accepts "last device to sync wins" for line items in the offline mutation queue. The likely first user-visible bug — "I just checked that and it came back unchecked" — is the trigger to design CRDT-lite for this surface. Until then, this is the explicitly-named MVP limitation most likely to actually bite.

- **DEC-41 / DEC-42 — Magic-link only auth on Better Auth.** Two coupled bets: passwordless removes a class of risk in exchange for total dependence on email deliverability; Better Auth saves time today at the cost of young-library risk. Either failure has a documented escape path (Postmark fallback; Lucia migration). Both should be reviewed if Better Auth's release cadence stalls *or* if a Resend deliverability incident materially degrades sign-in.

- **DEC-64 — Auto-stop with 3-second cold-start budget.** A measurement-gated decision. Phase 6 measurement is the formal trigger, but lived experience may diverge from measured budgets. Worth a follow-up after a month of real use, not just the measurement run. Interacts with pool size (DEC-71) and machine class (cross-cutting concern #18).

- **DEC-65 — No staging environment.** The most-likely-to-cause-a-bad-day decision. Testcontainers + rehearsed restore drills mitigate but don't replace a staging tier. The trigger ("one production data-loss incident") is correct but reactive; consider whether scheduling a quarterly migration-replay drill against a throwaway DB is a cheap proactive supplement.

- **DEC-31 — Quantity-bound shopping list check reset.** The decision is reasonable, but it interacts with DEC-22 (recipe edits propagate). A typo correction on a recipe mid-shop can re-uncheck items. The trigger ("user feedback says it surprises rather than helps") may take a while to surface — worth proactive observation in the first few weekly shops.

- **DEC-37 — Single-shop assumption for shelf-life.** The model is correct for one-shop weeks. Top-up shops surface as warning noise. The upgrade path (`shop_date` on plans) is named; the trigger is qualitative. Worth instrumenting: count how often a plan's shelf-life warnings are dismissed without action, as a quantitative proxy.

- **DEC-50 / DEC-68 — Cloudinary lock-in.** Vendor lock-in accepted at household scale. The migration cost grows with the asset library — moving away later means re-uploading and re-URL-ing every recipe image. If the project audience ever expands beyond the household, plan for a sooner-than-comfortable migration window.

- **DEC-23 — Two-level batch-cooking model (no nesting).** The current model is sufficient for the cooking patterns surfaced so far. A "stock that feeds a sauce that feeds a meal" pattern would force the question of whether to allow nesting (with cycle detection and recursive traversal) or to introduce a distinct "prep step" abstraction. The latter may be the better answer; revisit deliberately rather than reflexively extending the existing model.
