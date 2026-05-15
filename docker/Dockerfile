# Multi-stage build for knowable-api.
#
# Stage 1 (builder): install all deps + compile src/server.ts (plus its
# src/lib/* imports) to a single dist/server.js via esbuild. We use
# esbuild with `--packages=external` so node_modules stays out of the
# bundle and gets installed cleanly in the runtime stage.
#
# Stage 2 (runtime): node:20-slim, production deps only, dist/. Runs as
# non-root `node` user.
#
# Base image is pinned to ECR Public (`public.ecr.aws/docker/library/...`)
# rather than Docker Hub. CodeBuild runs from a shared IP pool that
# routinely hits Docker Hub's 100 pulls / 6h anonymous limit. AWS-to-AWS
# pulls of the ECR Public mirror don't count against any rate limit.

FROM public.ecr.aws/docker/library/node:20-slim AS builder
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

FROM public.ecr.aws/docker/library/node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]
