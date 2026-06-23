# OPERATIONS

Production runbook for Lofty's Larder. Single Fly app in `lhr`, Fly Postgres alongside, Cloudflare in front. Read this before responding to an alert, restoring data, or rolling back.

The document is the artefact; the [rehearsal log](#rehearsal-log) at the bottom is the proof the procedures work. Re-rehearse whenever `flyctl` syntax visibly changes or after any meaningful schema migration.

## Contents

- [Production surfaces](#production-surfaces)
- [Secrets — where each one lives](#secrets--where-each-one-lives)
- [Alerts and response](#alerts-and-response)
- [Cross-referencing an incident (Sentry ↔ Axiom)](#cross-referencing-an-incident-sentry--axiom)
- [Releases and rollback](#releases-and-rollback)
- [Restore A — Fly Postgres snapshot to a fork cluster](#restore-a--fly-postgres-snapshot-to-a-fork-cluster)
- [Restore B — R2 dump to a fresh local Postgres](#restore-b--r2-dump-to-a-fresh-local-postgres)
- [Rate limits](#rate-limits)
- [Accessibility — documented axe-core exceptions](#accessibility--documented-axe-core-exceptions)
- [Secret rotation](#secret-rotation)
- [Rehearsal log](#rehearsal-log)

---

## Production surfaces

| Thing | Value |
|---|---|
| Fly app (backend + SPA) | `loftys-larder-prod` |
| Fly Postgres cluster | `loftys-larder-prod-db` (canonical name; verify with `flyctl apps list`) |
| Fly region | `lhr` (single — DEC-63) |
| Edge / DNS / TLS | Cloudflare, orange-cloud; `/api/*` cache-bypassed (DEC-72) |
| Backups (off-site) | Cloudflare R2 bucket, key `dumps/YYYY-MM-DD.dump` (DEC-73) |
| Logs (30-day) | Axiom dataset configured via `AXIOM_DATASET` (DEC-75) |
| Errors | Sentry, frontend + backend (DEC-76) |
| Deploy trigger | Push to `main` → CI → `Deploy` workflow → `flyctl deploy`; the `fly.toml` `release_command` (`node /app/migrate.js`) applies migrations before traffic shifts (DEC-40) |
| Off-hours backup cron | GitHub Actions `Backup` workflow, daily `0 3 * * *` UTC |

No staging environment by design (DEC-65). Migrations land in production via release-command; Testcontainers + the restore drills below are the mitigation.

The CLI tools assumed below: `flyctl` (authenticated against `FLY_API_TOKEN`'s org), `psql` and `pg_restore` from `postgresql-client-16` (server major — keep in lockstep), `aws` CLI (against R2's S3-compatible endpoint), `jq`. Versions current at the date of each rehearsal entry.

---

## Secrets — where each one lives

The complete inventory with values, sources, and the first-deploy bootstrap script is in [`docs/secrets-checklist.md`](docs/secrets-checklist.md). That file is the source of truth; the table below is the operations-time pointer.

Two stores:

- **Fly app secrets** — `flyctl secrets list --app loftys-larder-prod`. Consumed by the backend at boot; validated by `backend/src/config.ts` (Zod). Missing or malformed values fail boot loudly.
- **GitHub Actions secrets and variables** — repo Settings → Secrets and variables → Actions. Consumed by the `Deploy` and `Backup` workflows.

| Surface | Where | Notes |
|---|---|---|
| Backend runtime config (DB, auth, Resend, Cloudinary, Axiom, Sentry) | Fly app secrets | See `docs/secrets-checklist.md` § "Fly app secrets" |
| `VITE_SENTRY_DSN` (frontend) | Docker build arg, **not** Fly secret | Build-time only; bundled into the SPA. Not yet wired through the Dockerfile (FEAT-46 follow-up) — frontend Sentry no-ops in production until then |
| `FLY_API_TOKEN` (deploy token, API app) | GitHub Actions secret | `Deploy` workflow |
| `FLY_API_TOKEN_BACKUP` (deploy token, Postgres app), `BACKUP_DATABASE_URL`, `R2_*` | GitHub Actions secrets | `Backup` workflow |
| `FLY_PG_APP` | GitHub Actions **variable** (not secret) | Postgres cluster name is non-sensitive; surfaces in step summaries |

For rotation of each, see [§ Secret rotation](#secret-rotation) below.

---

## Alerts and response

There are five channels worth watching. None of them page a phone today — at household scale, an email inbox check the morning after is the operational tempo.

### Sentry — error threshold

- **Rule:** >5 errors per 5 minutes per project (absolute threshold, DEC-78). One rule each on the backend and frontend projects.
- **Where you see it:** Sentry Issues view; email to the project's notification list.
- **Response:** open the most recent issue. The `reqId` tag is on backend events (`backend/src/plugins/sentry.ts:67`); cross-reference into Axiom (see below). PII is scrubbed in `beforeSend` (`shared/src/index.ts → scrubPii`); if a stack trace reveals user-identifying content, that's a `scrubPii` regression — log it and fix the redactor, don't manually purge the event.
- **False-positive shape to expect:** a single user hitting a transient browser network condition can fire 5 events from one tab. Look at distinct `reqId`s before declaring an incident.

### Axiom — manual investigation only, no alerts wired

No Axiom monitors are configured in v1. Axiom is the searchable structured-log destination; alerts are Sentry's job.

- **30-day retention** (DEC-75). An incident requiring older logs has to make do without — recommendation: pull a relevant slice to local CSV the moment you start investigating.
- **`/api/health` log noise is suppressed** by `logLevel: 'warn'` (`backend/src/routes/health.ts:44`); failed probes still log.

### Fly — health check failure

- **Probe:** machine-level TCP liveness on port 3000 (`fly.toml`), with the in-app HTTP `/api/health` endpoint backed by a DB `select 1` (DEC-79, `backend/src/routes/health.ts`).
- **Where you see it:** Fly dashboard (Monitoring → Checks); the machine cycles in/out of rotation. Repeated cycling visible in Axiom as Fastify boot logs.
- **Response:** check whether the database is reachable — `flyctl postgres connect --app loftys-larder-prod-db` and `select 1;`. If the DB is healthy, suspect connection-pool exhaustion or an in-process deadlock; restart the machine: `flyctl machines restart --app loftys-larder-prod`. If the DB is unreachable, see [§ Restore A](#restore-a--fly-postgres-snapshot-to-a-fork-cluster).
- **Known shape:** auto-stop cold starts (DEC-64) can flap the probe briefly during wake. Single transient blips are not incidents.

### GitHub Actions — workflow failure email

- **Deploy:** failure surfaces as a red workflow run in the Actions tab and a GitHub email to repo admins. If the failure is at the `release_command` step (migration), the prior release continues serving — no traffic shift (DEC-40). Capture logs immediately: `flyctl logs --app loftys-larder-prod` while the release-command machine is still around (it gets torn down quickly).
- **Backup:** scheduled-workflow-failure email from GitHub. The most common cause is a transient `flyctl proxy` connection blip; rerun via `workflow_dispatch`. If it fails twice in a row, the cluster is the suspect — see [§ Restore A](#restore-a--fly-postgres-snapshot-to-a-fork-cluster) for the fallback path.

### Rate limits — operator awareness, no external alert

`@fastify/rate-limit` returns `429` with `{ "error": "TooManyRequests", "code": "RATE_LIMITED", "retryAfterSeconds": <n> }` and a `Retry-After` header. Limits below.

Visible in Axiom by filtering on `statusCode: 429`. No alert — at household scale a sustained `429` storm would indicate either a buggy client or an actual abuse attempt; in both cases investigation is interactive, not paged. See [§ Rate limits](#rate-limits) for the configured buckets.

---

## Cross-referencing an incident (Sentry ↔ Axiom)

The `reqId` field is identical across Pino (Axiom payload), Sentry tags, and Fastify's request lifecycle (DEC-77). One value follows a request from edge to error.

**From Sentry → Axiom:**

1. Open the Sentry issue. Note the `reqId` tag (sidebar → Tags).
2. In Axiom, query the backend dataset:
   ```
   ['<dataset>'] | where reqId == '<value-from-sentry>'
   ```
3. The matching log lines surface the request URL, response code, duration, and surrounding traffic from the same machine.

**From Axiom → Sentry:**

1. Find the log line of interest in Axiom; copy the `reqId`.
2. In Sentry, search `reqId:<value>` in the issues view.

If a Sentry event has no `reqId` tag, it was emitted outside an HTTP request lifecycle (background task, init-time crash). Fall back to timestamp + machine id.

---

## Releases and rollback

### Find the current release id

```sh
flyctl status --app loftys-larder-prod
flyctl releases --app loftys-larder-prod              # human-readable list
flyctl releases --app loftys-larder-prod --json | jq -r '.[0] | "v\(.Version)"'   # latest only
```

The `Deploy` workflow's step summary in GitHub Actions also lists the deployed release version next to the commit SHA.

### Roll back

```sh
flyctl releases --app loftys-larder-prod                  # find the target version
flyctl releases rollback v<n> --app loftys-larder-prod    # roll back to v<n>
```

Rollback re-runs the previous image's `release_command`. **If the migration baked into the *current* release is one-way** (e.g. dropped a column), rollback will fail at the release-command step because the prior code can't run against the new schema. In that case the recovery path is [§ Restore B](#restore-b--r2-dump-to-a-fresh-local-postgres) (or a forward fix), not `releases rollback`.

The deploy workflow's `concurrency: deploy-production, cancel-in-progress: false` queues subsequent deploys — a rollback launched while another deploy is in flight will wait, not interleave.

---

## Restore A — Fly Postgres snapshot to a fork cluster

Fly takes automated daily snapshots of the Postgres volume. This path verifies a snapshot is intact and restorable without disturbing the live cluster, by forking it into a temporary cluster and probing.

**When to use:** routine corruption, accidental data loss, restore drill. **Not** suitable for an account-loss or regional disaster scenario — for those, see Restore B.

```sh
# 1. List available snapshots and pick one.
flyctl volumes list --app loftys-larder-prod-db
flyctl volumes snapshots list <volume-id> --app loftys-larder-prod-db

# 2. Fork the cluster from the chosen snapshot. The fork is a new app,
#    independent of production; it costs whatever a small Postgres machine
#    costs per hour until destroyed.
flyctl postgres create \
  --name loftys-larder-restore-drill \
  --region lhr \
  --vm-size shared-cpu-1x \
  --volume-size 1 \
  --fork-from <volume-id>:<snapshot-id>

# 3. Connect to the fork and verify a canary row. The canary is the
#    `RESTORE-DRILL-CANARY` ingredient seeded once into production for this
#    purpose; verify by name (case-sensitive).
flyctl postgres connect --app loftys-larder-restore-drill
```

Then at the `postgres=#` prompt:

```sql
\dt
SELECT id, name, created_at
FROM ingredients
WHERE name = 'RESTORE-DRILL-CANARY';
-- Expect: exactly one row.
\q
```

```sh
# 4. Tear down the fork — important, it keeps billing.
flyctl apps destroy loftys-larder-restore-drill
```

**Stopwatch from step 2 → step 3 first prompt** is the meaningful number for the rehearsal log. Step 4 is hygiene; don't count it.

**Common gotchas:**
- `flyctl postgres create --fork-from` syntax has changed historically. If the command above is rejected, run `flyctl postgres create --help | head -40` and adjust; capture the new form in the next rehearsal entry.
- The fork inherits the source cluster's role passwords, but Fly may regenerate them on creation. If `flyctl postgres connect` fails to authenticate, run `flyctl postgres list` and use the dashboard's connection-string panel for the fork.
- Don't point the production app at the fork "to see if it works." That's a staging environment by accident (DEC-65 forbids).

---

## Restore B — R2 dump to a fresh local Postgres

The nightly workflow (FEAT-50) writes `dumps/YYYY-MM-DD.dump` to R2 as a `pg_dump --format=custom --no-owner --no-acl` artefact. This path verifies the off-site copy is intact and restorable independently of Fly.

**When to use:** vendor catastrophe (Fly account loss, regional disaster), one-way-migration recovery target, restore drill.

```sh
# 1. Pick a dump. List the bucket via the R2 dashboard or:
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="auto" \
aws s3 ls "s3://$R2_BUCKET/dumps/" \
  --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"

# 2. Download the chosen dump.
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="auto" \
aws s3 cp "s3://$R2_BUCKET/dumps/<YYYY-MM-DD>.dump" /tmp/restore.dump \
  --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"

# 3. Start a fresh local Postgres. Use the project's compose file with an
#    isolated container name and volume so the dev DB is untouched.
docker run --rm --name restore-drill -d \
  -e POSTGRES_USER=lofty -e POSTGRES_PASSWORD=lofty -e POSTGRES_DB=lofty_restore \
  -p 55432:5432 \
  postgres:16

# 4. Wait for ready, then restore. The dump has no owner/acl statements;
#    pg_restore runs cleanly as the bootstrap superuser.
until pg_isready -h 127.0.0.1 -p 55432 -U lofty >/dev/null 2>&1; do sleep 0.5; done
PGPASSWORD=lofty pg_restore \
  -h 127.0.0.1 -p 55432 -U lofty -d lofty_restore \
  --no-owner --no-acl --exit-on-error \
  /tmp/restore.dump

# 5. Verify the canary row.
PGPASSWORD=lofty psql -h 127.0.0.1 -p 55432 -U lofty -d lofty_restore \
  -c "SELECT id, name FROM ingredients WHERE name = 'RESTORE-DRILL-CANARY';"
# Expect: exactly one row.

# 6. Tear down.
docker stop restore-drill
rm -f /tmp/restore.dump
```

**Stopwatch from step 2 → step 5 result visible** is the meaningful number.

**Common gotchas:**
- `pg_restore` major version must match (or exceed) the source server's major. The backup workflow installs `postgresql-client-16`; if the cluster moves to 17, bump both in lockstep.
- `--exit-on-error` is deliberate — a restore that prints errors but exits zero is the failure mode that gives false confidence (FEAT-50's < 1 KiB-floor exists for the same reason). If you see errors, stop and investigate before declaring the dump good.
- Port `55432` avoids colliding with the dev Postgres on `5433` and a host-Postgres on `5432`.

---

## Rate limits

`@fastify/rate-limit` (`backend/src/plugins/rate-limit.ts`) applies three buckets:

| Scope | Limit | Window | Key |
|---|---|---|---|
| Unauthenticated traffic | 100 requests | 1 minute | `ip:<client IP>` (Cloudflare's forwarded IP) |
| Authenticated traffic | 300 requests | 1 minute | `session:<session id>` |
| Magic-link send (`POST /api/auth/sign-in/magic-link`) | 5 requests | 1 hour | `magic-email:<lowercased email>` (falls back to `magic-ip:<ip>` if the body has no email) |

`/api/health` is exempt — Fly's liveness probe hits it on a tight cadence.

A blocked request returns HTTP `429` with the body:

```json
{ "error": "TooManyRequests", "code": "RATE_LIMITED", "retryAfterSeconds": <n> }
```

and a `Retry-After` header. The body is an HTTP-level envelope, not a tRPC one — the rate-limit hook runs before the tRPC adapter, so even tRPC URLs see this shape on 429.

**Operational notes:**

- Store is in-memory. The single Fly machine in `lhr` plus auto-stop (DEC-63 / DEC-64) means counters reset whenever the machine wakes from sleep. Accepted v1 trade-off — if scaled out, plug Redis via the plugin's `redis` option.
- Limits sized for household traffic, not adversarial scale (`docs/non-goals.md`). If Cloudflare's edge surfaces patterns that suggest these are wrong in either direction, revisit.
- Under `NODE_ENV=test` the caps are raised to 10 000 IP / 30 000 session per minute (`backend/src/server.ts`) so the e2e suite — particularly the axe-core spot-check, which does many navigations in quick succession and pays IP-bucket cost on every `/api/auth/get-session` call — does not trip the limiter. Production sizing is unaffected.

---

## Accessibility — documented axe-core exceptions

The `e2e/specs/a11y.spec.ts` spot-check runs axe-core against the main views (sign-in, home, recipe browse, recipe editor, plan list, planner, shopping list, ingredients, settings) in both light and dark themes, with WCAG 2.1 AA tags enabled. The gate fails on any `serious` or `critical` violation; `moderate` and `minor` findings are surfaced in the test report but do not fail CI.

| View | Theme | Rule | Reason for exception |
|---|---|---|---|

*No accepted exceptions at the time of writing — all serious/critical findings have been fixed in source.* If you waive a future finding, prefer fixing it in the component; add a row here only after exhausting that route, and link to the rule's `dequeuniversity.com` page in the reason column.

---

## Secret rotation

Generic rotation procedure for both stores is in `docs/secrets-checklist.md` § "Rotation". The per-secret notes below capture surface-specific gotchas — *what breaks if this is rotated wrong*, not just the mechanics.

### Fly app secrets

`flyctl secrets set --stage --app loftys-larder-prod KEY=newvalue` followed by `flyctl machines restart --app loftys-larder-prod` rotates without triggering a deploy. Drop `--stage` if you want the secret-set to deploy as a side-effect.

| Secret | Rotation gotcha |
|---|---|
| `DATABASE_URL` | Managed by Fly Postgres; rotate via `flyctl postgres users` + `flyctl postgres attach`. Hand-editing risks drift from the cluster's actual password |
| `BETTER_AUTH_SECRET` | Rotating invalidates every existing session cookie (DEC-43). Users get signed out and have to magic-link in again. Schedule with awareness, or accept the blast |
| `BETTER_AUTH_URL`, `MAGIC_LINK_TRUSTED_ORIGIN` | Must match the actual frontend / backend origins; mismatch breaks magic-link callback (AGENTS.md trap row) |
| `MAGIC_LINK_ALLOWED_EMAILS` | Comma-separated, lowercased internally. Removing an email immediately blocks future magic-link sends for that address; existing sessions remain |
| `RESEND_API_KEY` | Rotate at Resend dashboard first, then set in Fly. A stale key fails magic-link sends silently from the user's perspective (they see a generic "sent" UI per FEAT-15) — watch Axiom for `magic-link.send.error` |
| `CLOUDINARY_API_SECRET` | Signs short-lived upload credentials (DEC-50). In-flight uploads keep working until their signed URL expires; rotate during a quiet window |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` | Rarely rotate — usually only when migrating Cloudinary accounts |
| `AXIOM_TOKEN`, `AXIOM_DATASET` | A bad value crashes boot (config refinement is strict in production). Stage and verify the new token at the Axiom dashboard before restarting |
| `AXIOM_ENDPOINT` | Only rotated to switch regions; not a credential |
| `SENTRY_DSN`, `SENTRY_BROWSER_INGEST_ORIGIN` | Mismatched DSN ⇒ Sentry init no-ops silently. Verify by introducing a deliberate error after the restart and checking it lands |
| `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Cosmetic / sampling; safe to rotate any time |

### GitHub Actions secrets and variables

Takes effect on the next workflow run; no Fly restart needed.

| Secret | Rotation gotcha |
|---|---|
| `FLY_API_TOKEN` | App-scoped deploy token for `loftys-larder-prod`. Regenerate with `flyctl tokens create deploy --app loftys-larder-prod --name github-actions-deploy --expiry 8760h \| gh secret set FLY_API_TOKEN --repo LoftyWarne/loftys-larder`. Rotating immediately invalidates the prior token; the next `Deploy` run uses the new one |
| `FLY_API_TOKEN_BACKUP` | App-scoped deploy token for the Postgres cluster (`loftys-larder-prod-db`). Regenerate the same way against that app and pipe into `gh secret set FLY_API_TOKEN_BACKUP`. Never concatenate with `FLY_API_TOKEN` into a single secret — a newline between two deploy tokens corrupts the macaroon discharge and `flyctl` fails with `missing third-party discharge token` |
| `BACKUP_DATABASE_URL` | Host stays `127.0.0.1:5432` (script tunnels via `flyctl proxy`); only the credentials in the URL change. Validate by triggering `Backup` via `workflow_dispatch` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Rotate the R2 key at the Cloudflare dashboard, set the new value in GitHub, then trigger `Backup` to confirm. The bucket name is non-sensitive but in secrets to keep all R2 config in one place |
| `FLY_PG_APP` (variable) | Only rotates if the Postgres cluster is renamed — uncommon |

### Frontend Sentry DSN

`VITE_SENTRY_DSN` is a Docker build arg, not a runtime secret (see above and `docs/secrets-checklist.md` § "Frontend Sentry DSN"). Rotating requires a new deploy so the SPA gets rebuilt with the new DSN baked in. Not wired through the Dockerfile yet — tracked as a FEAT-46 follow-up.

---

## Rehearsal log

Both restore paths and the rollback must be rehearsed at least once before launch and re-rehearsed whenever the procedure visibly drifts (`flyctl` syntax change, schema migration that materially changes restore behaviour, Postgres major bump). Record each rehearsal below with date, who ran it, the dump / snapshot / release id involved, and the stopwatch number.

If you change the canary-row scheme, note that here too — the value of the rehearsal is that the next reader knows exactly what to look for.

### Canary row

A deterministic marker row seeded into production so each rehearsal has an unambiguous "did the data come back" check. Insert once, never delete (it's intentionally weird so it can't be mistaken for real data):

```sql
INSERT INTO ingredients (name, unit, created_at, updated_at)
VALUES ('RESTORE-DRILL-CANARY', 'g', NOW(), NOW())
ON CONFLICT DO NOTHING;
```

Run the insert against production after the first deploy that creates an `ingredients` table. The exact column list will need to track the schema as it evolves — the principle (unique sentinel name, present in both backup paths) is what matters, not the literal SQL above.

### Entries

> Drills not yet performed. The procedures above are written and reviewed but the validation step is outstanding. Each rehearsal must produce one entry here. Use the template below.

```
### YYYY-MM-DD — <restore A | restore B | rollback>

- **Operator:** <name>
- **Target:**
  - restore A: snapshot id, source volume, fork cluster name
  - restore B: R2 key restored, local Postgres version
  - rollback: from release v<n> to v<n-1>, deploy SHA of the noop
- **Time-to-restore (stopwatch):** <e.g. 4m 12s>
- **Outcome:** verified canary row / verified prior release serving / etc.
- **Notes:** drift from the procedure above, surprises, follow-ups
```
