ARG NODE_VERSION=24

# --- deps: hydrate the pnpm workspace from the lockfile (cacheable layer) ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /repo
ENV CI=1
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

RUN pnpm install --frozen-lockfile

# --- build: produce frontend/dist and backend/dist/server.js ---
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo
ENV CI=1
RUN corepack enable

COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend

RUN pnpm --filter @loftys-larder/frontend build \
 && pnpm --filter @loftys-larder/backend build

# --- runtime: minimal node image carrying only the bundle and SPA assets ---
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/public
WORKDIR /app

COPY --from=build --chown=node:node /repo/backend/dist/server.js ./server.js
# migrate.js + the generated SQL run as the Fly release_command (see fly.toml).
COPY --from=build --chown=node:node /repo/backend/dist/migrate.js ./migrate.js
COPY --from=build --chown=node:node /repo/backend/drizzle ./drizzle
COPY --from=build --chown=node:node /repo/frontend/dist ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
