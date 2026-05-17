# AGENTS.md — Lofty's Larder

Read this file before every prompt. Your default posture is **ask, don't assume**: pausing for clarification is the cheap default, unilateral decisions are the expensive exception. If a constraint here disagrees with your instinct, the constraint wins — surface the disagreement, don't route around it.

The doc set:

- `README.md` — entry point, kept in sync with shipped features.
- `docs/plan.md` — strategy. Source of hard constraints below.
- `docs/feature-specs.md` — 53 executable units, FEAT-01 … FEAT-53.
- `docs/design-decisions.md` — ADR log, DEC-01 … DEC-79. Cross-refs to FEATs.
- `docs/non-goals.md` — deliberate exclusions. Useful to *prevent* work.
- `docs/session-notes.md` — rolling working doc; pending questions, in-flight context.
- `AGENTS.md` — this file.

---

## Hard constraints (override default behaviour)

These come from `docs/plan.md` and the corresponding DECs. They are non-negotiable inside v1. If you think a task needs one of these to bend, stop and ask.

1. **ESM-only, everywhere.** Every `package.json` is `"type": "module"`. `module: "NodeNext"`, `moduleResolution: "NodeNext"`. A CJS-only dependency is a stop-and-ask. (DEC-01)
2. **Strict TS, Node LTS pinned** in `engines`, `.nvmrc`, and the Dockerfile. Do not relax `strict`. (DEC-02)
3. **Three workspaces only:** `/backend`, `/frontend`, `/shared`. Do not introduce a build orchestrator (Turborepo/Nx). (DEC-03)
4. **Zod schemas live in `/shared/src/schemas/*`** and are imported by both sides. Never inline a schema in a procedure or component. (cross-cutting concern #2)
5. **Single-household MVP.** Every Drizzle query touching a household-scoped table must include `WHERE household_id = CURRENT_HOUSEHOLD_ID`. No `getCurrentScope()` resolver. `addedBy` / `createdBy` are informational — never authorisation predicates. (DEC-17, cross-cutting #3)
6. **`snake_case` in the DB, `camelCase` in code,** mapped via Drizzle. A stray raw SQL fragment uses snake_case. (DEC-15)
7. **`updatedAt` via Drizzle `$onUpdate`,** not triggers, not convention. All writes route through Drizzle. (DEC-16)
8. **Soft-delete recipes; never hard-delete.** Past plans depend on the row staying. The `pickable-recipes` helper encodes visibility. (DEC-21, cross-cutting #5, #19)
9. **No snapshotting on slot assignment.** Slots reference recipes by FK; edits propagate. (DEC-22)
10. **One unit per ingredient.** No conversion tables. Users convert manually on entry. (DEC-18)
11. **Whole-recipe quantities + explicit `baseServings`.** Never per-serving entry. (DEC-19)
12. **No nested base recipes.** A recipe is either `is_base` or has a `base_recipe_id` — CHECK constraint enforces it. (DEC-23)
13. **Slot states are an enum,** not dummy recipes. `slot_type ∈ {empty, recipe, eat_out, takeaway, leftovers}`. (DEC-25)
14. **Plant points are computed, never stored.** (DEC-32)
15. **Europe/London time, centralised in `dateUtils`.** Forbid `new Date()` in domain code — import from `dateUtils`. (DEC-33, cross-cutting #8)
16. **All multi-statement writes go through `withTransaction`** — never ad-hoc `db.transaction(...)`. Concentrates the audit surface. (cross-cutting #4)
17. **All user-generated text is plain text.** No markdown, no HTML, no rich-text editor, **never `dangerouslySetInnerHTML`**. (DEC-49)
18. **Magic-link auth only.** No passwords. Better Auth owns its tables; domain code references `user_id` directly and keeps the boundary small. (DEC-41, DEC-42, cross-cutting #17)
19. **Account deletion is tombstoning, not cascade.** Follow the seven-step sequence in `docs/plan.md` and FEAT-35. (DEC-29)
20. **Last-write-wins on shared resources.** No row-version columns, no row-level locks. (DEC-36)
21. **`req.id` propagates end-to-end** as `reqId`, identical across Pino, Axiom, and Sentry. Do not rename or regenerate along the way. (DEC-77, cross-cutting #1)
22. **No staging environment.** Migrations run via Fly `release_command` on push to `main`. Tests against Testcontainers + restore drills are the mitigation. (DEC-40, DEC-65)
23. **Single region (`lhr`); auto-stop enabled; 3-second cold-start budget.** Do not enable always-on without measurement (FEAT-51). (DEC-63, DEC-64)
24. **Direct browser→Cloudinary uploads.** Never proxy image bytes through Fastify. (DEC-50)
25. **Do not change the tRPC URL shape.** `httpBatchLink` produces `/api/trpc/<procedure>?batch=1&input=...` and the PWA cache rules match on the procedure segment. Reconfiguring this needs a coordinated change. (cross-cutting #16)

---

## Tech stack — use this, not that

Drawn from `docs/design-decisions.md`. If you reach for the *not-that* side, stop and ask.

| Concern | Use | Not |
|---|---|---|
| Frontend framework | React + Vite (DEC-04) | Next.js, Remix, CRA |
| Routing | TanStack Router, date range in URL search params (DEC-10) | React Router, Wouter |
| Server state | TanStack Query via `@trpc/react-query` (DEC-08) | SWR, bespoke `useEffect`, RTK Query |
| Client state | React `useState` + Context (DEC-09) | Redux, Zustand, Jotai, Recoil |
| Forms | React Hook Form + Zod resolver (DEC-11) | Formik, TanStack Form, hand-rolled controlled inputs |
| Styling | Tailwind + shadcn/ui (DEC-51) | styled-components, CSS modules, Emotion |
| Backend framework | Fastify (DEC-05) | Express, Hono, Koa, NestJS |
| API contract | tRPC, types via `/shared` (DEC-06) | REST + OpenAPI codegen, GraphQL, hand-rolled fetch |
| Validation | Zod (DEC-07) | Yup, Joi, Valibot |
| Database | PostgreSQL — Fly Postgres prod, Docker dev (DEC-12) | SQLite, MySQL, Mongo |
| ORM | Drizzle (DEC-13) | Prisma, Kysely, raw `pg`, TypeORM |
| Search | `ILIKE` + `pg_trgm` GIN index (DEC-14) | Postgres FTS, Meilisearch, Algolia, ES |
| Auth | Better Auth + Resend magic links (DEC-42) | Passwords, Lucia (named fallback only), bespoke session table |
| Email | Resend (DEC-69) | Postmark (named fallback only) |
| Media | Cloudinary direct browser upload (DEC-68) | S3 with backend proxying |
| Backend logging | Pino → Axiom (DEC-75) | `console.log`, Winston, Bunyan |
| Error tracking | Sentry (front + back), `beforeSend` PII scrub, no session replay (DEC-76) | Datadog, Rollbar; session replay |
| Edge | Cloudflare orange-cloud DNS, `/api/*` cache bypass (DEC-72) | Direct Fly exposure |
| Containers (local) | Docker Compose for Postgres only (DEC-74) | Compose for Fastify/Vite as well |
| Runtime host (prod) | Fly.io, `lhr`, auto-stop (DEC-63, DEC-64) | Render, Railway, ECS |
| Tests | Vitest + Testcontainers, RTL, Playwright with `storageState` (DEC-56, DEC-57, DEC-58) | Jest; mocked DB in backend integration tests |
| Package manager | pnpm (DEC-03) | npm, yarn |
| Dev runtime | `tsx watch` | `ts-node`, plain `node` |
| Prod backend | `esbuild` single bundle (DEC-61) | `tsx` in prod, `tsc` emit |
| CI/CD | GitHub Actions + `flyctl` (DEC-66) | CircleCI, Buildkite |

---

## Repo layout

```
/
├── AGENTS.md               ← this file
├── README.md               ← entry point; updated as features ship
├── docs/
│   ├── plan.md
│   ├── feature-specs.md
│   ├── design-decisions.md
│   ├── non-goals.md
│   └── session-notes.md    ← rolling working doc
├── package.json            ← root, private, workspaces
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml      ← Postgres only
├── Dockerfile              ← multi-stage, prod
├── fly.toml                ← single region lhr
├── .github/workflows/      ← ci.yml, deploy.yml, backup.yml
├── backend/                ← Fastify + tRPC + Drizzle
│   ├── src/
│   │   ├── server.ts
│   │   ├── config.ts       ← env via Zod
│   │   ├── plugins/        ← logger, security, auth
│   │   ├── trpc/           ← context.ts, init.ts, router.ts, procedures
│   │   ├── db/             ← schema, migrations, withTransaction
│   │   ├── domain/         ← pickable-recipes, aggregation, plant-points
│   │   └── util/           ← dateUtils
│   ├── drizzle/            ← migrations
│   └── tsconfig.json
├── frontend/               ← Vite + React + shadcn/ui
│   ├── src/
│   │   ├── main.tsx, app.tsx, router.tsx
│   │   ├── lib/            ← trpc.ts, query-client.ts
│   │   ├── routes/         ← TanStack Router
│   │   ├── components/     ← shadcn primitives + app components
│   │   ├── features/       ← recipes/, planner/, shopping-list/, settings/
│   │   └── hooks/          ← useOptimisticSlotUpdate, etc.
│   └── tsconfig.json
└── shared/                 ← type pipeline
    └── src/
        ├── index.ts        ← barrel
        ├── router-type.ts  ← exports AppRouter type
        ├── schemas/        ← Zod schemas used by both sides
        └── dto/            ← recipe DTO, shopping-list DTO
```

Cross-workspace rules:

- `/frontend` imports from `/shared` only. Never from `/backend` runtime. `import type` for the router type.
- `/backend` imports from `/shared` for schemas and DTOs.
- `/shared` is a runtime leaf — no runtime imports from `/backend` or `/frontend`. One narrow type-only exception: `shared/src/router-type.ts` does `export type { AppRouter } from '../../backend/src/trpc/router.ts'`. Type-only re-exports are erased at compile time and add no runtime dependency. See DEC-80 for the trade-off and its revisit trigger.

---

## Commands

These are the canonical script names. If `package.json` is missing one, ask before inventing it.

| Action | Command |
|---|---|
| Install | `pnpm install` |
| Start Postgres (local) | `docker compose up -d postgres` |
| Dev backend | `pnpm --filter backend dev` |
| Dev frontend | `pnpm --filter frontend dev` |
| Typecheck (all) | `pnpm -r typecheck` |
| Lint (all) | `pnpm -r lint` |
| Format (write) | `pnpm -r format` |
| Format (check) | `pnpm -r format:check` |
| Test (all) | `pnpm -r test` |
| Test (one workspace) | `pnpm --filter <ws> test` |
| Build frontend | `pnpm --filter frontend build` |
| Build backend (prod bundle) | `pnpm --filter backend build` |
| Generate migration | `pnpm --filter backend db:generate` |
| Run migration | `pnpm --filter backend db:migrate` (or `pnpm drizzle-kit migrate`) |
| Build image | `docker build .` |
| Deploy | `flyctl deploy --release-command "pnpm drizzle-kit migrate"` (CI does this on push to `main`) |
| Rollback | `flyctl releases rollback` |

Never use `--no-verify` on `git commit`. If a pre-commit hook fails, fix the underlying issue.

---

## Code conventions

- **One file, one job.** Procedures live next to their feature; cross-cutting helpers in `domain/` or `util/`.
- **Schemas: `/shared/src/schemas/`.** DTO shapes: `/shared/src/dto/`. Import these — don't redefine.
- **Errors:** `TRPCError` with a tRPC code on `code` and a domain code on `cause` of the form `{ code: string, ...metadata }`. (cross-cutting #11, DEC-35)
- **Optimistic updates:** use the shared hook (`useOptimisticSlotUpdate`, FEAT-31). Don't reimplement `onMutate`/`onError`/`onSettled` per consumer. (cross-cutting #7)
- **Pickable recipes:** use the helper. Don't filter recipes by hand. (cross-cutting #5)
- **Searchable combobox primitive** (FEAT-21) is the only combobox. Don't fork it per picker. (cross-cutting #6)
- **Slot card** (FEAT-31) has explicit slots for future content. Extend, don't rewrite. (cross-cutting #14)
- **Date logic** imports from `dateUtils`. No `new Date()` in domain code. (cross-cutting #8)
- **Multi-statement writes** go through `withTransaction`. Never ad-hoc. (cross-cutting #4)
- **Logging:** Pino only. No `console.log` (Axiom won't see it). (FEAT-03 gotcha)
- **Comments:** default to none. Only add one when the *why* is non-obvious (a hidden constraint or surprising invariant).

---

## Common traps — do NOT do these

| Trap | Why |
|---|---|
| Use `dangerouslySetInnerHTML` | All user text is plain text. React escaping is the XSS mitigation. (DEC-49) |
| Inline a Zod schema in a procedure or form | Schemas live in `/shared`. Inlining breaks the one-source promise. (cross-cutting #2) |
| Write a Drizzle query without `WHERE household_id = CURRENT_HOUSEHOLD_ID` | The single-household discipline is the only scope mechanism. (DEC-17) |
| Reach for `new Date()` in domain code | Use `dateUtils`. (DEC-33) |
| Call `db.transaction(...)` directly | Use `withTransaction`. (cross-cutting #4) |
| Hard-delete recipes | Soft-delete only — past plans depend on the row. (DEC-21) |
| Snapshot recipes onto slots | Slots reference by FK; edits propagate. (DEC-22) |
| Scope a query by `addedBy` / `createdBy` | Informational, not authorisation. (DEC-17) |
| Add a row-version column or row-level lock | LWW is the chosen model. (DEC-36) |
| Add a global state library (Redux, Zustand, Jotai) | Plain React state until a concrete need appears. (DEC-09) |
| Add a CJS-only dependency | ESM-only across the project. Verify ESM at proposal time. (DEC-01, cross-cutting #20) |
| Change the tRPC URL shape (`httpBatchLink` → `httpLink`) | PWA cache rules match on it. (cross-cutting #16) |
| Proxy image uploads through Fastify | Direct browser → Cloudinary with signed credentials. (DEC-50) |
| Introduce nested base recipes | Two levels only. (DEC-23) |
| Introduce per-user timezones | Europe/London is hardcoded. (DEC-33) |
| Add password auth, account recovery flow, or OAuth | Magic-link only. (DEC-41) |
| Cascade delete on user removal | Tombstoning sequence — preserves household data. (DEC-29) |
| Create dummy "Eat Out" / "Takeaway" / "Leftovers" recipes | Use the `slot_type` enum. (DEC-25) |
| Introduce per-serving ingredient entry | Whole-recipe + `baseServings`. (DEC-19) |
| Introduce multi-unit per ingredient | One enforced unit. (DEC-18) |
| Add a `getCurrentScope()` resolver or thread `scope` through repositories | `CURRENT_HOUSEHOLD_ID` constant is the discipline. (DEC-17) |
| Enable Sentry session replay | PII / cookie-consent cost not worth it at this scale. (DEC-76) |
| Add a coverage threshold | Coverage is not a target; behaviour is. (DEC-59) |
| Introduce drag-and-drop slot assignment | Click-to-assign is touch-first and a11y-correct. (DEC-52) |
| Create a staging Fly app | Testcontainers + restore drills are the chosen mitigation. (DEC-65) |
| Use `tsx` in production | `esbuild` single bundle. (DEC-61) |
| Add a build orchestrator (Turborepo, Nx) | Three workspaces is below the threshold. (DEC-03) |
| `console.log` for diagnostics | Pino only. (FEAT-03) |
| Skip pre-commit hooks (`--no-verify`) | Fix the underlying failure. |

---

## Formatting and linting

Prettier + ESLint + husky + lint-staged are configured at FEAT-07. Treat the config as canonical and stable.

**Rules for working with the toolchain:**

1. **Don't fight the formatter.** If Prettier disagrees with your layout, the layout changes. Never wrap a region in `// prettier-ignore` to preserve a personal preference.
2. **Don't silence ESLint rules without asking.** `eslint-disable`, `eslint-disable-next-line`, `@ts-expect-error`, and `@ts-ignore` are a stop-and-ask trigger. If a rule appears to be wrong for this codebase, the conversation is "should this rule change?" not "let me suppress it here."
3. **Don't reconfigure mid-project.** `eslint.config.js` and `.prettierrc` are part of FEAT-07's contract. Proposed changes go through the same kick-off / approval / implement flow as any other change.
4. **Don't add or swap a linter.** No Biome, no `xo`, no `tslint`. ESLint is the only linter; Prettier is the only formatter.
5. **`husky` pre-commit runs `lint-staged`,** which runs Prettier and `eslint --fix` on the staged files. If the hook fails, fix the issue and re-stage — do not bypass.
6. **CI is the source of truth.** A clean local run that fails in CI means the local environment drifted (Node version, pnpm version). Fix the environment, not the CI config.
7. **Auto-fix is allowed; rule-disable is not.** `pnpm -r lint -- --fix` for mechanical fixes is fine; suppressing a complaint is not.
8. **`@typescript-eslint` strict-type-checked rules are deliberate.** They earn their keep on the typed tRPC pipeline.

---

## Prompting this project

### Which docs to load — by prompt type

| Prompt type | Load | Don't load |
|---|---|---|
| **Kick-off** (new feature) | `AGENTS.md`; the specific `docs/feature-specs.md §FEAT-N`; the DECs cross-referenced by that FEAT; `docs/session-notes.md` | The whole of `feature-specs.md`; `docs/plan.md` in full; `docs/non-goals.md` unless ruling out scope creep |
| **Implementation** | `AGENTS.md`; the approved kick-off plan; the FEAT entry; the cross-cutting concerns section; `/shared` schemas relevant to the change | `docs/plan.md` again; other FEATs not being touched |
| **Debug** | `AGENTS.md`; `docs/design-decisions.md` for the surface in question; `docs/session-notes.md`; the failing code | `docs/feature-specs.md` (the feature has shipped) unless re-reading acceptance criteria; `docs/plan.md` in full |
| **Review** | `AGENTS.md`; the FEAT entry; the cross-ref'd DECs; `docs/non-goals.md` (to catch in-scope expansion of out-of-scope territory); the diff | `docs/plan.md` as a whole — surgical sections only |
| **Doc update** | The doc being edited; cross-referenced docs | The code, unless verifying a claim |

Read selectively. Reading "everything" is not safer than reading the right thing — it dilutes attention and burns context.

### Stop-and-ask triggers

Pause and surface the question — do not proceed unilaterally — if any of these apply:

- The work appears to contradict a DEC in `docs/design-decisions.md`.
- The work creeps into a `docs/non-goals.md` entry.
- A new dependency is needed (verify ESM support; check against the "use this not that" table).
- A schema change is needed: new table, column, FK, constraint, or index.
- The tRPC URL shape, `dateUtils`, `withTransaction`, `pickable-recipes`, the optimistic-update hook, or the slot card shape would change.
- The auth surface (Better Auth) would expand beyond reading the session.
- A test would need to mock the database (use Testcontainers).
- The obvious code path requires `eslint-disable`, `@ts-expect-error`, `@ts-ignore`, or `prettier-ignore`.
- Acceptance criteria in the FEAT are ambiguous, contradictory, or incomplete.
- Two libraries or two patterns are roughly equivalent and the choice isn't in `docs/design-decisions.md`.
- The change touches three or more places that don't already share a helper (likely a new cross-cutting concern).
- The work would mark a Definition-of-done item as complete (you never do this — see below).

When in doubt: ask. The cost of asking is one paragraph; the cost of an unwanted decision is a revert plus a DEC update.

### Three-phase feature templates

**Phase 1 — Kick off**

> We're starting FEAT-N. Read `docs/feature-specs.md §FEAT-N` and the DECs cross-referenced there. Don't write code yet. Propose:
>
> 1. The files you'll touch, grouped by workspace.
> 2. The Zod schemas that are new or extended, and confirm they'll live in `/shared/src/schemas/`.
> 3. Which cross-cutting helpers you'll reuse (`withTransaction`, `pickable-recipes`, `useOptimisticSlotUpdate`, `dateUtils`, the combobox primitive) and any new ones you're tempted to introduce.
> 4. What's ambiguous in the acceptance criteria — and your proposed reading, framed as a question.
> 5. Which DECs constrain the implementation (list them).
> 6. The test surfaces from the Definition of Done.
>
> Output: a numbered checklist I can approve or amend. Do not start implementation.

**Phase 2 — Implement after approval**

> Approved. Implement FEAT-N per the plan you proposed above.
>
> Honour every DEC referenced. Stop and ask before:
>
> - adding a new dependency,
> - making a schema change beyond what was approved,
> - introducing a new helper instead of reusing an existing one,
> - silencing a linter, formatter, or typechecker rule,
> - touching the auth surface, the tRPC URL shape, or `dateUtils`.
>
> Leave the Definition-of-done checkboxes unchecked. Verification is a human action — you do not tick them.
>
> After implementation, write a short status: what landed, what didn't, drift from the plan and why.

**Phase 3 — Verify and close out**

> Implementation reported complete. Without touching code:
>
> 1. List each acceptance criterion in FEAT-N and the evidence you have that it passes (test name + file, or manual probe).
> 2. Flag any criterion you could not verify and why.
> 3. Note any drift from the kick-off plan and the reason.
> 4. Propose a single commit message in the project's style.
>
> Do **not** tick the Definition-of-done boxes. Do **not** mark the FEAT complete. I verify and tick.

### Debugging template

> Bug: <one-sentence description>.
> Repro: <steps, or "unknown — investigate">.
> Suspected surface: <FEAT-N or area / file>.
>
> Read `AGENTS.md`, the relevant DECs in `docs/design-decisions.md`, and `docs/session-notes.md`. Don't fix yet. Propose:
>
> 1. The smallest set of files to read to confirm or refute your hypothesis.
> 2. Your hypothesis, in one sentence, plus one alternative you ruled in.
> 3. The cheapest experiment whose result would falsify the hypothesis.
> 4. Whether the bug shape suggests a DEC needs revisiting (yes/no + which).
>
> Wait for my go before changing code.

### Code-review template

> Review the current diff against `docs/feature-specs.md §FEAT-N` and the DECs cross-referenced there.
>
> For each of the following, report findings + severity (blocker / suggest / note):
>
> 1. **DEC compliance** — list each cross-ref'd DEC; for each, does the diff align?
> 2. **Cross-cutting concern reuse** — were the canonical helpers used? Any duplication of `pickable-recipes`, `withTransaction`, `dateUtils`, the combobox primitive, the optimistic-update hook, or the slot card?
> 3. **Common-trap audit** — walk the "do NOT do these" table in `AGENTS.md`. Any hits?
> 4. **Acceptance-criteria mapping** — for each criterion in the FEAT, point at the code or test that satisfies it. Do **not** tick checkboxes.
> 5. **Non-goals creep** — does anything in the diff drift into `docs/non-goals.md` territory?
> 6. **Formatter / linter suppressions** — any `eslint-disable`, `@ts-expect-error`, `prettier-ignore`? Each is a finding.
>
> Output: findings list. Do not commit fixes.

### The Definition-of-done rule

**You never mark a Definition-of-done item as complete.** The agent's job ends at "I believe these pass and here is the evidence." A human reads the evidence, runs the gate check, and ticks the box.

This applies to:

- The `[ ]` acceptance-criteria checkboxes in `docs/feature-specs.md`.
- The Definition-of-done section in each FEAT.
- The phase-end gate (no work proceeds to the next phase until tests pass in CI — that's a human assessment).

Reporting "I implemented this and the test passes" is correct. Editing `feature-specs.md` to tick the checkbox is not.
