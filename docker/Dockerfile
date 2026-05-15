# Multi-stage build for knowable-api.
#
# Stage 1 (builder): install all deps + compile src/server.ts (plus its
# src/lib/* imports) to a single dist/server.js via esbuild. We use
# esbuild with `--packages=external` so node_modules stays out of the
# bundle and gets installed cleanly in the runtime stage.
#
# Stage 2 (runtime): node:20-slim, production deps only, dist/. Runs as
# non-root `node` user.

FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Bundle src/* imports into one file; leave node_modules untouched
# (the runtime stage installs only production deps).
RUN npx esbuild src/server.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --packages=external \
      --outfile=dist/server.js

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]
