#!/usr/bin/env bash
# Nightly off-site Postgres backup (DEC-73): tunnel into the Fly Postgres
# cluster via `flyctl proxy`, run `pg_dump --format=custom`, upload the dump
# to Cloudflare R2 under a date-stamped key. Invoked from
# `.github/workflows/backup.yml`.

set -euo pipefail

: "${FLY_API_TOKEN:?FLY_API_TOKEN must be set}"
: "${FLY_PG_APP:?FLY_PG_APP must be set (Fly Postgres cluster name)}"
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL must be set (postgres://...@localhost:5432/...)}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID must be set}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID must be set}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY must be set}"
: "${R2_BUCKET:?R2_BUCKET must be set}"

LOCAL_PORT="${LOCAL_PORT:-5432}"
DATE_STAMP="$(date -u +%Y-%m-%d)"
DUMP_FILE="$(mktemp -t backup.XXXXXX).dump"
KEY="dumps/${DATE_STAMP}.dump"

cleanup() {
  if [ -n "${PROXY_PID:-}" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

echo "→ Opening flyctl proxy to ${FLY_PG_APP} on 127.0.0.1:${LOCAL_PORT}…"
flyctl proxy "${LOCAL_PORT}:5432" --app "${FLY_PG_APP}" &
PROXY_PID=$!

# Wait up to 30s for the local port to accept TCP. The classic backup-rot
# pattern is `sleep N && pg_dump` — if the proxy isn't up yet, pg_dump fails
# silently from cron's perspective. Probe explicitly.
ready=0
for _ in $(seq 1 30); do
  if (echo > "/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "✗ flyctl proxy exited before opening :${LOCAL_PORT}"
    exit 1
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "✗ flyctl proxy never opened :${LOCAL_PORT} within 30s"
  exit 1
fi

echo "→ Running pg_dump → ${DUMP_FILE}"
pg_dump \
  "${BACKUP_DATABASE_URL}" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="${DUMP_FILE}"

DUMP_SIZE="$(stat -c%s "${DUMP_FILE}")"
echo "  dump size: ${DUMP_SIZE} bytes"

# A successful pg_dump against an empty/unreachable DB can still produce a
# tiny "valid" custom-format file. 1 KiB floor catches the obvious
# pathological case before we push it to R2.
if [ "${DUMP_SIZE}" -lt 1024 ]; then
  echo "✗ Dump suspiciously small (<1024 bytes). Refusing to upload."
  exit 1
fi

echo "→ Uploading to s3://${R2_BUCKET}/${KEY}"
AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
AWS_DEFAULT_REGION="auto" \
aws s3 cp "${DUMP_FILE}" "s3://${R2_BUCKET}/${KEY}" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --no-progress

echo "✓ Backup complete: ${KEY} (${DUMP_SIZE} bytes)"
