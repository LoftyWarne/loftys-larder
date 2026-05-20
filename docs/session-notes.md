# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

---

## 2026-05-17 — FEAT-06 (Fly.io initial deploy + Cloudflare DNS)

**Status:** implementation complete on 2026-05-20. Live URL is `https://loftys-larder.co.uk`, `www` 301s to apex, `/api/trpc/health.ping` round-trips through Cloudflare → Fly (`lhr`). Browser load + DevTools clean. Definition-of-done boxes in `docs/feature-specs.md §FEAT-06` left unticked — human action.

### Drift from runbook

1. **Cert ownership via `_fly-ownership` TXT, not the A/AAAA path Fly "recommended".** Behind Cloudflare orange-cloud, public DNS returns Cloudflare IPs, not Fly's — so Fly's IP-based ownership check can never validate while proxying is on. TXT is the right path here. Runbook Step 4/5 updated mid-execution to reflect this; same fix will apply for any future hostname added to the Fly app.

2. **Cache rule needed a UI-builder fix.** Initial config used `URI Full` + `wildcard` with the raw expression syntax pasted as the wildcard value — that never matches. Final: `URI Path` + `starts with` + `/api/`, action `Bypass cache`. Rule shows Active in dashboard.

3. **`cf-cache-status` reports `DYNAMIC`, not `BYPASS`, on `/api/*` probes.** Accepted: tRPC responses carry no `Cache-Control`, so Cloudflare's default classifier independently marks them uncacheable before the bypass rule's signal is attributed in the header. Defense-in-depth holds (classifier + rule both say don't cache). Worth knowing if a future endpoint inadvertently sets cacheable headers — that's when we'd start seeing `BYPASS` instead.

4. **`www → apex` redirect went Dynamic, not Static.** Static + "Preserve path suffix" toggle dropped the path on test probes — only query string came through. Switched to Dynamic with expression `concat("https://loftys-larder.co.uk", http.request.uri)`. `http.request.uri` is already path+query, so the expression is short. The `if`/`len` builtins from typical filter expressions aren't available in `target_url` expressions — caused one false start.

### Implementation decisions worth carrying

- **`flyctl deploy --remote-only` for the first deploy** because local Docker has no `buildx` (see FEAT-05 entry below). Once `docker-buildx` is installed, the flag can be dropped.
- **Fly issues only the LE cert** in `flyctl certs show`. The FEAT-06 gotcha's mention of "two certs (LE + Cloudflare-origin)" refers to Fly's LE cert plus Cloudflare's edge SSL cert — the latter is implicit and verified by Full (strict) SSL mode being on without TLS errors on the live URL.
- **Cloudflare SSL/TLS mode: Full (strict).** "Always Use HTTPS" left **off** — Fly's `force_https = true` (in `fly.toml`) is the single redirect authority. No loops.
- **`fly-request-id` flows through Cloudflare untouched.** Confirmed in probes. This is the foundation for FEAT-43's `reqId` propagation (DEC-77 / cross-cutting #1).
- **All helmet security headers survive the Cloudflare hop.** CSP, HSTS, X-Frame-Options, etc. all present on responses fetched through the proxied URL.

### Decisions taken at kick-off

- **App name:** `loftys-larder-prod`. Now pinned in `fly.toml`. Renaming is painful — treat as permanent.
- **Canonical host:** apex. `www` 301-redirects to apex. Done at Cloudflare with a Single Redirect rule (cheapest place — keeps the redirect off the Fly machine's wake path).
- **HTTPS redirect authority:** Fly. `force_https = true` stays in `fly.toml`; Cloudflare "Always Use HTTPS" stays **off**. Single source of truth, no loop (FEAT-06 gotcha line 266).
- **Cloudflare SSL mode:** Full (strict). Fly issues a real LE cert; Flexible would downgrade the Cloudflare→Fly hop to HTTP and break `force_https`.
- **Cache bypass pattern:** the rule matches `/api/*` — broad enough to cover the tRPC URL shape `/api/trpc/<procedure>?batch=1&input=...` (cross-cutting #16). Do not narrow it.

### Runbook — first-time prod deploy

Substitute `<DOMAIN>` throughout once chosen. Capture every command's exit status / output worth keeping; FEAT-50 lifts this into `OPERATIONS.md`.

#### Step 0 — Domain (manual, Cloudflare Registrar)

1. Pick a domain. Cloudflare Registrar charges at-cost (no markup, no upsell). Avoid `.app` (HSTS preloaded — debugging cert issues is harder); `.io` has had reliability wobbles. A plain `.com` or `.co.uk` is the boring correct choice.
2. Register / transfer at <https://dash.cloudflare.com/?to=/:account/registrar>. Cloudflare Registrar requires the domain's DNS already be on Cloudflare — if it's elsewhere, add the zone first, change nameservers at the current registrar, then transfer.
3. Once registered, the zone appears in the Cloudflare dashboard. Note the zone's API account-id and zone-id — useful for later Cloudflare automation but not required here.

Record: chosen domain, registration date, registrar account email.

#### Step 1 — Install + auth flyctl

```sh
brew install flyctl          # if missing
flyctl version               # record
flyctl auth login            # opens browser
flyctl auth whoami           # record the org / email
```

`flyctl` was not installed locally at FEAT-05 (see 2026-05-17 entry below). Do not commit any flyctl config files that land in `~/`.

#### Step 2 — Create the Fly app (no deploy yet)

```sh
flyctl apps create loftys-larder-prod --org <org>
```

The repo's `fly.toml` already names the app; do **not** run `flyctl launch` — it would prompt to overwrite `fly.toml`, the `Dockerfile`, and `.dockerignore`, all of which are correct as-is from FEAT-05. `apps create` is the surgical equivalent.

Verify:

```sh
flyctl config validate        # reads ./fly.toml
flyctl apps list | grep loftys-larder-prod
```

#### Step 3 — First deploy

No Postgres yet (FEAT-09 attaches it). The app boots without `DATABASE_URL`; `health.ping` doesn't touch the DB, so this is sufficient for FEAT-06's acceptance criteria.

```sh
flyctl deploy --remote-only
```

`--remote-only` uses Fly's remote builder (BuildKit), sidestepping the local-Docker-29-no-buildx situation noted in FEAT-05.

Once it returns healthy:

```sh
flyctl status
flyctl logs                   # sanity-check Pino output
curl -I https://loftys-larder-prod.fly.dev/
curl 'https://loftys-larder-prod.fly.dev/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D'
```

The `*.fly.dev` URL bypasses Cloudflare entirely — use it later to A/B against the Cloudflare-fronted custom domain when diagnosing edge issues.

#### Step 4 — Attach the custom domain at Fly

Apex and www both need Fly certs.

```sh
flyctl certs add <DOMAIN>
flyctl certs add www.<DOMAIN>
flyctl certs list             # both should appear "Not verified"
flyctl ips list -a loftys-larder-prod                 # IPv4 + IPv6 for the app
flyctl certs setup <DOMAIN>                            # prints exact DNS instructions, incl. _fly-ownership TXT
flyctl certs setup www.<DOMAIN>
```

Record the IPv4, IPv6, and the two `_fly-ownership` TXT values verbatim — they go into Cloudflare next.

#### Step 5 — Cloudflare DNS records (TXT for ownership + proxied A/AAAA/CNAME for traffic)

**Why two record types per hostname.** Per DEC-72 we proxy DNS through Cloudflare (orange cloud). When proxied, public DNS lookups return Cloudflare's edge IPs, not Fly's — so Fly's IP-based cert-ownership check via A/AAAA records cannot succeed through the proxy. The fix is a `_fly-ownership` TXT record (TXT records are never proxied), which is what proves ownership to Fly. The A/AAAA/CNAME records still go in, proxied, because that's how live traffic reaches Fly through Cloudflare — they just aren't the ownership proof.

In the Cloudflare dashboard → DNS → Records:

| # | Type | Name | Content | Proxy |
|---|---|---|---|---|
| 1 | TXT | `_fly-ownership` | (value from `flyctl certs setup <DOMAIN>`) | DNS only — TXT never proxies |
| 2 | TXT | `_fly-ownership.www` | (value from `flyctl certs setup www.<DOMAIN>`) | DNS only |
| 3 | A | `@` | (IPv4 from `flyctl ips list`) | Proxied (orange cloud) |
| 4 | AAAA | `@` | (IPv6 from `flyctl ips list`) | Proxied (orange cloud) |
| 5 | CNAME | `www` | `loftys-larder-prod.fly.dev` | Proxied (orange cloud) |

Notes:
- Cloudflare strips the zone suffix in the Name field — entering `_fly-ownership` produces FQDN `_fly-ownership.<DOMAIN>`. Same for the `www` variant.
- Don't add MX / SPF / DKIM / DMARC records here — email lands in FEAT-13.

After DNS propagates (usually < 60s on Cloudflare; TXT records occasionally take a couple of minutes to be visible externally):

```sh
dig +short TXT _fly-ownership.<DOMAIN>      # sanity: TXT visible publicly?
dig +short TXT _fly-ownership.www.<DOMAIN>
flyctl certs check <DOMAIN>                  # re-triggers Fly's validation
flyctl certs check www.<DOMAIN>
flyctl certs show <DOMAIN>
flyctl certs show www.<DOMAIN>
```

Wait until both certs show `Issued` for both Let's Encrypt and Cloudflare-origin (FEAT-06 gotcha line 265 — wait for **both** before declaring done).

#### Step 6 — Cloudflare SSL/TLS settings

Cloudflare dashboard → SSL/TLS → Overview:

- **Encryption mode: Full (strict).** Not Flexible, not Full — Full (strict) requires the origin to present a trusted cert, which Fly does.

SSL/TLS → Edge Certificates:

- **Always Use HTTPS: OFF.** Fly does the redirect (`force_https = true` in `fly.toml`). Two redirect authorities loop.
- **Automatic HTTPS Rewrites: ON** (safe default; rewrites in-page links).
- **Minimum TLS Version: 1.2** (1.3 if no client compatibility worries — fine here).

#### Step 7 — Cloudflare cache rule: bypass `/api/*`

Dashboard → Caching → Cache Rules → Create rule.

- **Rule name:** `bypass-api`
- **When incoming requests match:** custom filter expression
  ```
  (starts_with(http.request.uri.path, "/api/"))
  ```
- **Then:**
  - Cache eligibility: **Bypass cache**
  - (No other settings needed.)
- **Save and deploy.**

Verify with a hit to the protected path:

```sh
curl -sI "https://<DOMAIN>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D" | grep -i 'cf-cache-status\|cf-ray'
```

Expect `cf-cache-status: BYPASS` (or `DYNAMIC` if the rule hasn't matched but Cloudflare classified it as uncacheable anyway — BYPASS is the desired explicit signal).

#### Step 8 — Cloudflare Single Redirect: `www` → apex

Dashboard → Rules → Redirect Rules → Create rule.

- **Rule name:** `www-to-apex`
- **When incoming requests match:** custom filter expression
  ```
  (http.host eq "www.<DOMAIN>")
  ```
- **Then:**
  - Type: **Static**
  - URL: `https://<DOMAIN>${http.request.uri.path}` (use Dynamic with expression `concat("https://<DOMAIN>", http.request.uri.path)` and preserve query string if you want querystrings forwarded — simpler to enable "Preserve query string" toggle on Static).
  - Status code: **301**
  - Preserve query string: **on**

Verify:

```sh
curl -sI https://www.<DOMAIN>/ | grep -i 'location\|HTTP/'
```

Expect `HTTP/2 301` + `location: https://<DOMAIN>/`.

#### Step 9 — Final probes (acceptance criteria mapping)

| Probe | Expected | Maps to AC |
|---|---|---|
| `curl -I https://<DOMAIN>/` | `200`, `server: cloudflare`, `cf-ray:` present | line 260 |
| `curl 'https://<DOMAIN>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D'` | tRPC success shape | line 261 |
| Response headers on `/api/*` probe | `cf-cache-status: BYPASS` (or `DYNAMIC`) | line 262 / line 250 |
| Browser load on `https://<DOMAIN>/` | frontend renders, no mixed-content warnings | line 251 / 252 |
| Browser load on `https://www.<DOMAIN>/` | 301s to apex | line 251 |
| `flyctl certs show <DOMAIN>` / `www.<DOMAIN>` | both `Issued` for LE + Cloudflare-origin | line 248 |

When all six pass: report back. **Do not** tick the FEAT-06 boxes in `feature-specs.md`; that's a human action after the browser check.

### Deferred to later FEATs (do NOT do as part of FEAT-06)

- `flyctl postgres create` / `flyctl postgres attach` — **FEAT-09**.
- `flyctl secrets set DATABASE_URL=…` — **FEAT-09** (or implicit via `postgres attach`).
- SPF / DKIM / DMARC DNS records for Resend — **FEAT-13**.
- Swap TCP `[checks.tcp_alive]` for HTTP `/api/health` check — **FEAT-46**.
- Wire `release_command "pnpm drizzle-kit migrate"` into CI on push to `main` — **FEAT-48**.
- Cold-start measurement against 3-second budget (DEC-64) — **FEAT-51**.
- Nightly `pg_dump → R2` (DEC-73) — **FEAT-49 / 50**.

### Captured values (live record — for FEAT-50's `OPERATIONS.md` lift)

Fly app: `loftys-larder-prod`, region `lhr`, org TBD.

From `flyctl certs setup` (2026-05-20):

| Hostname | Type | Value |
|---|---|---|
| `loftys-larder.co.uk` | A | `66.241.124.105` |
| `loftys-larder.co.uk` | AAAA | `2a09:8280:1::118:845e:0` |
| `www.loftys-larder.co.uk` | A | `66.241.124.105` |
| `www.loftys-larder.co.uk` | AAAA | `2a09:8280:1::118:845e:0` |
| `loftys-larder.co.uk` | TXT `_fly-ownership` | `app-xkjgdnn` |
| `www.loftys-larder.co.uk` | TXT `_fly-ownership.www` | `app-xkjgdnn` (same value — Fly's token is app-scoped) |

Both hostnames share the same Fly machine IPs (single app, shared edge).

Certificate issuance (2026-05-20): both `loftys-larder.co.uk` and `www.loftys-larder.co.uk` validated via `_fly-ownership` TXT within ~1 min of DNS propagation. LE certs issued (rsa + ecdsa), 2-month expiry. Fly handles renewal automatically.

Cache rule `bypass-api` configured at Cloudflare → Caching → Cache Rules. Initial misconfig used UI builder fields `URI Full` + `wildcard` with the raw expression syntax pasted as the wildcard value — that pattern never matched anything. Corrected to `URI Path` + `starts with` + `/api/`. Probe still shows `cf-cache-status: DYNAMIC` rather than `BYPASS`; the AC is configuration (rule listed + enabled + bypass action), not the header value. Defense-in-depth holds: tRPC responses carry no `Cache-Control` so Cloudflare's default classifier independently marks them uncacheable. The rule remains as the explicit second layer in case a future endpoint inadvertently sets cacheable headers.

### Open ops questions worth resolving before run

- **Domain not yet chosen.** Step 0 above; user will pick at Cloudflare Registrar.
- **Fly org.** `flyctl orgs list` after auth — confirm which org owns this app. Personal org is fine for household-scale.

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
