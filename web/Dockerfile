# The Next.js app (pages plus the REST API as Route Handlers), built for ECS Fargate. The Node version tracks the repo's
# .nvmrc.

# Five stages, two of them shipped. `--target` builds only what that target depends on, not every stage above it:
#
#   deps ──FROM──> builder ──COPY──> web                (shipped)
#   deps ──FROM──> deps-prod ──COPY──> migrator          (shipped)
#
# `web` is itself FROM node:24-alpine and takes only build output from `builder`, so targeting it never builds
# `deps-prod` or `migrator` at all. Order below is presentation only.

# ======================================================================================================================
# deps — installs node_modules (dependencies + devDependencies); the base for builder and deps-prod
# ======================================================================================================================
FROM node:24-alpine AS deps

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml .
RUN pnpm install --frozen-lockfile


# ======================================================================================================================
# deps-prod — deps pruned to production-only dependencies; migrator's node_modules is COPYed from here rather than
# this stage being built FROM (see migrator's stage below for why).
# ======================================================================================================================
FROM deps AS deps-prod

# `pnpm prune --prod` removes devDependencies from node_modules, which is the only part of this stage that migrator
# COPYs.
RUN pnpm prune --prod


# ======================================================================================================================
# builder — compiles the Next.js app. Only .next/standalone and .next/static are copied out of it.
# ======================================================================================================================
FROM deps AS builder

WORKDIR /app
COPY . .

# Next's standalone output leaves out public/, so the web stage copies it separately. COPY --from fails the build when
# the path is missing, so mkdir keeps that copy valid whether or not the app has a public/ directory.
RUN mkdir -p public

# NEXT_PUBLIC_* values are read by `pnpm run build`, so everything in this block must be set before it.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# Empty leaves Google Analytics off, which is what every build but the deploy job's wants.
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID

RUN pnpm run build


# ======================================================================================================================
# migrator — SHIPPED. ECS task that applies db migrations between .github/workflows/deploy.yml's two terraform applies.
# ======================================================================================================================
FROM node:24-alpine AS migrator

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

# COPYed from deps-prod rather than built FROM it. Image layers only add to each other, so an image built FROM deps-prod
# would still carry the devDependencies that `pnpm prune --prod` removed, because the earlier layer already paid for
# them. COPY takes just the final state. `web` below COPYs from `builder` for the same reason.
COPY --from=deps-prod --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./package.json

# A migration run needs only the .sql files in drizzle/ (plus meta/_journal.json, which orders them), the script that
# applies them, and the two modules that script imports for the connection URL. drizzle.config.ts isn't used here. It
# configures the drizzle-kit CLI, which only `db:generate` and `db:studio` use.
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app lib/server/databaseUrl.ts ./lib/server/databaseUrl.ts
COPY --chown=app:app lib/server/env.ts ./lib/server/env.ts
COPY --chown=app:app scripts/db-migrate.cjs ./scripts/db-migrate.cjs

# RDS certificates chain to Amazon's own certificate authority (CA), which isn't in Node's trust store, so the image
# carries Amazon's CA bundle. The bundle is committed at web/certs/rds-global-bundle.pem rather than downloaded, because
# Amazon republishes it whenever it adds a region. This path must stay in step with local.rds_ca_bundle_path
# (infra/locals.tf), which sets DATABASE_SSL_CA to it in the task definition.
#
# Deliberately not paired with `ENV DATABASE_SSL_CA=...` here. That would make every run of this image demand TLS,
# breaking CI's migrator test against a plain Postgres with "The server does not support SSL connections". Using the
# bundle is a deployment decision, so infra/locals.tf sets DATABASE_SSL_CA. Keep the two in step if /app/certs ever
# moves.
COPY --chown=app:app certs/rds-global-bundle.pem /app/certs/rds-global-bundle.pem

USER app

# Runs the script directly rather than through `pnpm run db:migrate`: this image never installs anything at runtime,
# so nothing needs pnpm or corepack present at all.
CMD ["node", "scripts/db-migrate.cjs"]


# ======================================================================================================================
# web — SHIPPED. The long-running service ECS Fargate serves.
# ======================================================================================================================
FROM node:24-alpine AS web

WORKDIR /app
ENV NODE_ENV=production

# Matches infra/locals.tf's container_port, which the load balancer's target group also health-checks on.
ENV PORT=8000
ENV HOSTNAME=0.0.0.0
EXPOSE 8000

RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

# As in migrator, this copies Amazon's RDS CA bundle to a path that must stay in step with local.rds_ca_bundle_path
# (infra/locals.tf). It isn't paired with an unconditional ENV DATABASE_SSL_CA here. The migrator stage above explains
# why.
COPY --chown=app:app certs/rds-global-bundle.pem /app/certs/rds-global-bundle.pem

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

USER app
CMD ["node", "server.js"]
