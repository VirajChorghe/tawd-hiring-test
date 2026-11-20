# syntax=docker/dockerfile:1

# TAWD production image, built by Coolify on every push to main.
#
# Context to keep in mind when editing this file: the build runs on the shared
# velocity-reports droplet (2 vCPU / 4 GB RAM) alongside a client-facing
# production app, so the build stage is deliberately memory-capped and the
# final image carries no build tooling.

ARG NODE_VERSION=24
# Must match "packageManager" in the root package.json.
ARG PNPM_VERSION=12.5.1

# --------------------------------------------------------------------------
# Stage 1: build
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

ARG PNPM_VERSION
RUN npm install --global pnpm@${PNPM_VERSION}

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
# Node would otherwise size its heap against the whole droplet and can starve
# the neighbouring production app during a build.
ENV NODE_OPTIONS=--max-old-space-size=1536

# Manifests first, so Docker can reuse the cached install layer whenever only
# application source has changed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @tawd/web build

# --------------------------------------------------------------------------
# Stage 2: run
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# The standalone server binds to localhost by default, which is unreachable
# from outside the container. 0.0.0.0 lets Coolify's proxy reach it.
ENV HOSTNAME=0.0.0.0

# curl is the only extra package in the final image: Coolify's health check
# runs inside the container and needs it to call /api/health. Installed as
# root here, before dropping to the unprivileged user below.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# next.config.ts sets outputFileTracingRoot to the repo root, so the standalone
# output mirrors the monorepo layout: the server entry point lands at
# apps/web/server.js with its dependencies in /app/node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

# The migration runner and the one-time create-admin command, bundled into
# self-contained files with the migration SQL beside them, so they do not
# depend on anything the standalone output happened to include.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/dist-scripts ./apps/web/scripts

COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nextjs

EXPOSE 3000

# Migrations run first; the server only starts if they succeed.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
