# Knowledge Platform v0.1 - Multi-stage Docker build
# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN npm install -g pnpm@9

WORKDIR /build

# Copy workspace and package files
COPY pnpm-workspace.yaml .npmrc ./
COPY package.json pnpm-lock.yaml ./
COPY packages/codec/package.json ./packages/codec/
COPY server/package.json ./server/

# Install dependencies with frozen lockfile (ensures consistency across environments)
RUN pnpm install --frozen-lockfile

# Stage 2: Build
FROM node:22-alpine AS builder
RUN npm install -g pnpm@9

WORKDIR /build

# Copy from deps stage
COPY --from=deps /build .

# Copy source code for codec and server
COPY packages/codec/ ./packages/codec/
COPY server/ ./server/

# Build codec (shared library) and server
RUN pnpm --filter @echozedlabs/codec build && \
    pnpm --filter @echozedlabs/server build

# Stage 3: Runtime
FROM node:22-alpine AS runtime

WORKDIR /app

# Set production environment.
# DB_URL points at a SQLite file under /data — mount a volume there to persist
# data across restarts. We deliberately do NOT default to :memory: (that would
# silently lose every write on restart); the app also refuses to boot in
# production if DB_URL is unset. SQL Server is not yet wired (see db.module.ts);
# SQLite is the supported v0.1 store.
ENV NODE_ENV=production \
    PORT=3000 \
    DB_URL=/data/kp.sqlite

# Copy dist and node_modules from builder
COPY --from=builder --chown=node:node /build/server/dist ./server/dist
COPY --from=builder --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/packages/codec/dist ./packages/codec/dist

# Persistent data directory for the SQLite database, owned by the runtime user.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Use non-root user for security
USER node

# Expose the API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the application
CMD ["node", "server/dist/main.js"]
