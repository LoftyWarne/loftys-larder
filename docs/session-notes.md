# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

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
