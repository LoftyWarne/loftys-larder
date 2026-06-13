#!/usr/bin/env bash
# Boot the full local dev stack: Postgres (docker), migrations, backend, frontend.
# Tear down everything with Ctrl-C.

set -euo pipefail

cd "$(dirname "$0")/.."

require_env_file() {
  local path="$1" example="$2"
  if [ ! -f "$path" ]; then
    echo "✗ Missing $path. Copy from $example and fill in the secrets:"
    echo "    cp $example $path"
    exit 1
  fi
}

require_env_file ".env" ".env.example"
require_env_file "backend/.env" "backend/.env.example"

echo "→ Bringing up Postgres (docker compose)…"
docker compose up -d postgres >/dev/null

echo "→ Waiting for Postgres to be healthy…"
until [ "$(docker inspect -f '{{.State.Health.Status}}' loftys-larder-postgres 2>/dev/null)" = "healthy" ]; do
  sleep 1
done

echo "→ Running migrations…"
pnpm --filter backend db:migrate

echo "→ Seeding dev data…"
pnpm --filter backend seed

PIDS=()

cleanup() {
  echo ""
  echo "→ Stopping dev servers…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Best-effort: nuke anything still bound to the ports.
  sleep 1
  local stragglers
  stragglers=$(lsof -ti :3000 -ti :5173 2>/dev/null || true)
  [ -n "$stragglers" ] && kill $stragglers 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "→ Starting backend on :3000…"
pnpm --filter backend dev &
PIDS+=($!)

echo "→ Starting frontend on :5173…"
pnpm --filter frontend dev &
PIDS+=($!)

echo ""
echo "  Backend:  http://localhost:3000"
echo "  Frontend: http://localhost:5173"
echo "  Sign in:  http://localhost:5173/sign-in"
echo ""
echo "  Ctrl-C to stop."
echo ""

wait
