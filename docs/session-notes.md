# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

---

## 2026-05-17 — FEAT-05 (Production Dockerfile + fly.toml)

**Status:** implementation complete; manual smoke (docker build + docker run probes) verified. Definition-of-done left unticked.

### Drift from kick-off plan

1. **Base image is `node:24-alpine`, not `node:24-slim`.** Plan recommended slim; first build came in at 346 MB (slim itself is ~345 MB on Apple-silicon Docker), failing the < ~300 MB acceptance criterion. No native-binding deps in the runtime image — esbuild's native bits live only in the build stage — so musl-libc risk is nil at this stage. Final image is **229 MB**. Revisit if `pg` (FEAT-09) or another native dep needs glibc; the swap is one-token (`alpine` → `slim`).

2. **Health check in `fly.toml` is a machine-level TCP check, not the HTTP `/api/health` path specified in FEAT-05.** `/api/health` ships in FEAT-46; declaring an HTTP check that resolves to a non-existent route would have marked every machine unhealthy from FEAT-06's first deploy. Inline comment in `fly.toml` flags the swap point. **FEAT-46 must replace `[checks.tcp_alive]` with an HTTP check (or add one and keep TCP).**

3. **`frontend/tsconfig.json` was modified** — not on the kick-off file list. Docker exposed that `shared/dist/` is a one-off local artefact, not reproducibly built (`shared`'s `build` script is `tsc --noEmit`). Restored a reproducible frontend build with:
   - `paths: { "@loftys-larder/shared": ["../shared/src/index.ts"] }` — resolves the type-only import to source.
   - `rootDir: ".."` (was `"src"`) — widens TS's project boundary so cross-workspace type traversal no longer trips TS6059. Safe because `noEmit: true`.

   Consistent with DEC-80's single narrow type-only exception.

4. **Dropped BuildKit-only directives from the Dockerfile.** Originally used `# syntax=docker/dockerfile:1.7` + `RUN --mount=type=cache,id=pnpm,...` for a pnpm-store cache mount. Local Docker 29 has no `buildx` plugin installed, and classic builder rejects both. Removed them; Fly's remote builder is BuildKit and will work either way — we just lose the local pnpm-store cache.

5. **Deferred verification: `flyctl config validate`.** flyctl isn't installed locally; runs as part of FEAT-06 setup.

### Implementation decisions worth carrying

- **`STATIC_DIR` is the explicit signal for SPA serving.** `security.ts` only mounts `@fastify/static` at `/` (with SPA fallback) when `STATIC_DIR` is set. The Dockerfile sets it to `/app/public`; dev never sets it (Vite's `server.proxy` covers that path). Avoids any magic `import.meta.url`-relative resolution that would break inside the bundle.

- **SPA fallback uses `setNotFoundHandler`, gated on `!req.url.startsWith('/api/')`.** Unknown `/api/*` paths return JSON 404; unknown non-`/api/*` GETs return `index.html` so TanStack Router can hydrate. Don't widen this without thinking through the tRPC URL contract (cross-cutting #16).

- **The FEAT-03 placeholder `/api/static/` mount was removed.** The original FEAT-03 comment ("real `dist/` wiring lands with FEAT-05") was the trigger. `backend/public/.gitkeep` deleted with it.

- **esbuild bundle has a CJS-interop banner.** `format: 'esm'` strips CJS shims; if a transitive dep reaches for `require` / `__dirname` / `__filename` at module-eval time it crashes. The banner restores them against `import.meta.url`. Cheap insurance; can be revisited if it ever causes confusion.

- **`shared`'s `package.json` `main` / `types` fields point at `./dist/index.js` / `./dist/index.d.ts` — neither is produced by `shared`'s `build` script.** This is now a latent inconsistency: nothing in the build graph emits them, the frontend now bypasses them via paths mapping, the backend doesn't import shared at runtime. Two clean follow-ups: (a) strip `main` / `types` (and `files`) from shared's package.json since the workspace is consumed via TS paths only, or (b) wire a real emit step (probably a stripped `tsconfig.build.json` without `noEmit` and `allowImportingTsExtensions`). Cheap to defer; worth doing before a fourth workspace needs to import shared.

### Environment notes

- Local Docker is 29.2.1, classic builder only. `docker buildx` not installed. `brew install docker-buildx` would fix it; not required for FEAT-05/06.
- `flyctl` not installed locally — install during FEAT-06.

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
