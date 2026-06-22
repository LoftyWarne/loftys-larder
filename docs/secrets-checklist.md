# Secrets checklist

Every secret the app needs in production, where it lives, and how to set it.
Run through this **before the first deploy** — the deploy workflow assumes the
runtime secrets are already present on the Fly app, and the
`release_command` migration will fail to boot the new release without
`DATABASE_URL`, `BETTER_AUTH_SECRET`, and friends (`backend/src/config.ts`).

There are two stores:

- **Fly app secrets** (`flyctl secrets set …`) — exposed to the running
  Machine as env vars; consumed by the backend at boot.
- **GitHub Actions secrets** (repo Settings → Secrets and variables → Actions)
  — exposed to the workflow runner; used by `flyctl` and the nightly backup.

## GitHub Actions secrets

| Secret | Purpose | Required by |
|---|---|---|
| `FLY_API_TOKEN` | Authenticates `flyctl` from the deploy workflow | FEAT-49 (this) |
| `R2_ACCOUNT_ID` | Cloudflare account for the off-site backup bucket | FEAT-50 |
| `R2_ACCESS_KEY_ID` | R2 access key | FEAT-50 |
| `R2_SECRET_ACCESS_KEY` | R2 secret | FEAT-50 |
| `R2_BUCKET` | R2 bucket name (e.g. `loftys-larder-backups`) | FEAT-50 |

Generate `FLY_API_TOKEN` with `flyctl auth token` (scoped to the deploy
machine user, not your personal token, if you have an organisation token
available).

## Fly app secrets

Set via `flyctl secrets set KEY=value --app loftys-larder-prod`. Setting a
secret triggers a deploy unless `--stage` is used; for first-deploy
bootstrap, stage everything then run the deploy workflow.

| Secret | Notes | Source |
|---|---|---|
| `DATABASE_URL` | Set automatically by `flyctl postgres attach` (FEAT-09); only override for an external Postgres | Fly Postgres |
| `BETTER_AUTH_SECRET` | ≥32 bytes; `openssl rand -hex 32` | Generated |
| `BETTER_AUTH_URL` | Backend origin, e.g. `https://loftys-larder.co.uk` | Domain (FEAT-05) |
| `MAGIC_LINK_TRUSTED_ORIGIN` | Origin the magic-link callback is allowed to land on | Domain |
| `MAGIC_LINK_ALLOWED_EMAILS` | Comma-separated allow-list (single-household, DEC-17) | Manual |
| `MAGIC_LINK_FROM` | Optional; defaults to `magic@loftys-larder.co.uk` | Manual |
| `RESEND_API_KEY` | Magic-link sender (DEC-69) | Resend dashboard |
| `CLOUDINARY_CLOUD_NAME` | Direct browser upload (DEC-50, DEC-68) | Cloudinary |
| `CLOUDINARY_API_KEY` | | Cloudinary |
| `CLOUDINARY_API_SECRET` | Server-side signature only — never shipped to the client | Cloudinary |
| `AXIOM_TOKEN` | Pino → Axiom transport (DEC-75); required in `production` | Axiom |
| `AXIOM_DATASET` | Axiom dataset name; required in `production` | Axiom |
| `AXIOM_ENDPOINT` | Optional; defaults to `https://api.axiom.co` | Axiom |
| `SENTRY_DSN` | Backend Sentry DSN (DEC-76); unset = no-op init | Sentry |
| `SENTRY_ENVIRONMENT` | Optional Sentry environment tag | Manual |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional, 0–1; defaults to 0 (DEC-77 punts tracing) | Manual |
| `SENTRY_BROWSER_INGEST_ORIGIN` | Added to CSP `connect-src` so the SPA can POST events | Sentry |

### Frontend Sentry DSN

`VITE_SENTRY_DSN` is bundled into the SPA at **build time**, not runtime — it
lives in the image, not in Fly secrets. With remote `flyctl deploy --remote-only`
the build happens on Fly's remote builder, so the DSN needs to be passed as a
build arg through the Dockerfile. The Dockerfile does not currently expose
that arg; until it does, the frontend Sentry SDK no-ops in production. Wiring
the build arg is a follow-up — track against FEAT-46.

## First-deploy bootstrap

```sh
# 1. Attach Postgres (sets DATABASE_URL).
flyctl postgres attach <pg-app> --app loftys-larder-prod

# 2. Stage runtime secrets so they don't each trigger a deploy.
flyctl secrets set --stage --app loftys-larder-prod \
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  BETTER_AUTH_URL="https://loftys-larder.co.uk" \
  MAGIC_LINK_TRUSTED_ORIGIN="https://loftys-larder.co.uk" \
  MAGIC_LINK_ALLOWED_EMAILS="you@example.com" \
  RESEND_API_KEY="re_…" \
  CLOUDINARY_CLOUD_NAME="…" \
  CLOUDINARY_API_KEY="…" \
  CLOUDINARY_API_SECRET="…" \
  AXIOM_TOKEN="xaat-…" \
  AXIOM_DATASET="loftys-larder" \
  SENTRY_DSN="https://…@sentry.io/…" \
  SENTRY_BROWSER_INGEST_ORIGIN="https://o0.ingest.sentry.io"

# 3. Trigger the first deploy from GitHub (push to main, or run the Deploy
#    workflow via workflow_dispatch).
```

## Rotation

Changing a Fly secret triggers a redeploy unless `--stage` is used. To rotate
without an immediate deploy, stage the new value and restart the machine:

```sh
flyctl secrets set --stage --app loftys-larder-prod KEY=newvalue
flyctl machines restart --app loftys-larder-prod
```

Changing a GitHub Actions secret takes effect on the next workflow run — no
deploy or restart needed.

## Deploy verification (post-merge gate-check)

When the **Deploy** workflow finishes on `main`, walk through these:

1. **Golden path.** Workflow shows ✅; the summary lists a commit SHA and
   release. `flyctl status --app loftys-larder-prod` shows the new release
   ID running; `curl -fsSL https://loftys-larder.co.uk/api/health` returns
   `200`.
2. **Migration-failure path.** Verified at least once before relying on the
   safety net: open a branch with a deliberately-broken migration, merge to
   `main`, observe the workflow fail at the `Deploy` step, confirm
   `flyctl status` still shows the prior release. `flyctl logs --app
   loftys-larder-prod` captures the migration error before the
   release-command machine is torn down — capture immediately if needed
   (see FEAT-49 gotcha).
3. **CI gate.** A push to `main` whose CI run fails must **not** trigger
   Deploy. Verify by inspecting the Deploy workflow run list — there
   should be no run for the failing SHA.

## Rollback

```sh
# List recent releases.
flyctl releases --app loftys-larder-prod

# Roll back to a known-good version.
flyctl releases rollback <version> --app loftys-larder-prod
```

Rollback re-runs the `release_command` for the prior image, so a migration
that's incompatible with the rolled-back code will fail loudly — same safety
net as forward deploys. If the rollback target is older than the current
schema and the migration is one-way, a `pg_restore` from the latest R2 dump
(FEAT-50 / FEAT-51) is the recovery path, not `releases rollback`.
