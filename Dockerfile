# Knowledge E3 — self-hosted production image.
# Single container serving BOTH the JSON API and the built web UI.
#
# Runtime data lives under /data — mount a volume there to persist it:
#   - /data/kp.sqlite   the derived index (DB)   [DB_URL]
#   - /data/wiki        the git-of-record mirror [GIT_MIRROR_ROOT]
#
# Per ADR-0001 the Markdown in git is the source of truth and the database is a
# derived, rebuildable index — so /data/wiki is the valuable half of that volume.
# SQLite is the supported store (Postgres/SQL Server are not wired — see ADR-0002).
#
# Quick start:
#   docker build -t knowledge-e3 .
#   docker run -p 3000:3000 -v knowledge-e3-data:/data knowledge-e3
#   # then seed the first admin (once):
#   docker exec -it <container> node server/dist/seed.js

# ---------- Stage 1: install workspace dependencies ----------
FROM node:22-alpine AS deps
RUN npm install -g pnpm@9
WORKDIR /build

# Only the manifests, so this layer caches until a dependency changes.
# .npmrc is required, not incidental: it sets node-linker=hoisted, which decides
# the node_modules layout the runtime stage below inherits wholesale.
COPY pnpm-workspace.yaml .npmrc package.json pnpm-lock.yaml ./
COPY packages/codec/package.json ./packages/codec/
COPY packages/okf/package.json ./packages/okf/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

# ---------- Stage 2: build codec, okf, server, and the web UI ----------
FROM node:22-alpine AS builder
RUN npm install -g pnpm@9
WORKDIR /build
COPY --from=deps /build .
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY server/ ./server/
COPY web/ ./web/
# Topological order: codec -> okf -> server (imports both) ; codec -> web.
RUN pnpm --filter @echozedlabs/codec build \
 && pnpm --filter @echozedlabs/okf build \
 && pnpm --filter @echozedlabs/server build \
 && pnpm --filter @echozedlabs/web build

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runtime
# git is required, not optional: the git-of-record mirror and rebuild-from-git
# shell out to it.
RUN apk add --no-cache git ca-certificates
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/node \
    DB_URL=/data/kp.sqlite \
    WEB_DIST=/app/web/dist \
    GIT_MIRROR_ROOT=/data/wiki

# Copy the whole built tree so the workspace node_modules layout produced by the
# builder stays intact. Bigger image, but correct and simple.
COPY --from=builder --chown=node:node /build /app
COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh

# Persistent data dir (SQLite + git mirror) + a writable HOME for gitconfig.
RUN chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /data /home/node \
 && chown node:node /data /home/node
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/v1/healthz',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Configures git identity/auth from the environment, then execs the server.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
