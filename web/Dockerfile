# The Next.js app — pages plus the REST API (Route Handlers) — for ECS Fargate. Node version tracks the repo's .nvmrc.

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

# `pnpm prune --prod` removes devDependencies from node_modules, but the store still holds their bytes, so it has to
# go too or this stage saves nothing. Safe to rm -rf: pnpm hard-links each file into node_modules/.pnpm at install
# time, giving node_modules its own independent claim on the data. Deleting the store's claim doesn't remove those
# bytes.
RUN pnpm prune --prod && rm -rf "$(pnpm store path)"


# ======================================================================================================================
# builder — compiles the Next.js app. Only .next/standalone and .next/static are copied out of it.
# ======================================================================================================================
FROM deps AS builder

WORKDIR /app
COPY . .

# Next's standalone output excludes public/, so the web stage copies it separately — and COPY --from of a missing path
# is a hard build failure. mkdir keeps that copy valid whether or not the app has a public/ directory.
RUN mkdir -p public

# NEXT_PUBLIC_* values are read by `pnpm run build`, so everything in this block must be set before it.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# Always disabled, in every image.
ENV NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED=1

# Omitting these sends users to Clerk's hosted Account Portal (AGENTS.md).
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
ENV NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
ENV NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard

RUN pnpm run build


# ======================================================================================================================
# migrator — SHIPPED. ECS task that applies db migrations, run between the two cdk deploys in ci.yml.
# ======================================================================================================================
FROM node:24-alpine AS migrator

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

# COPYed from deps-prod rather than FROM it: OCI layers are additive, so deps-prod's own rm -rf wouldn't shrink this
# image, only hide what an earlier layer already paid for. COPY takes just the final state — same reason `web` below
# COPYs from `builder` instead of being FROM it.
COPY --from=deps-prod --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./package.json

# A migration run needs only the .sql files in drizzle/ (plus meta/_journal.json, which orders them), the script that
# applies them, and the one module it imports for the connection URL. drizzle.config.ts is not used here — it configures
# the drizzle-kit CLI, which only `db:generate` and `db:studio` still run.
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app lib/server/databaseUrl.ts ./lib/server/databaseUrl.ts
COPY --chown=app:app scripts/db-migrate.cjs ./scripts/db-migrate.cjs

# RDS certs chain to Amazon's own CA, absent from Node's trust store. This path must stay in step with
# RDS_CA_BUNDLE_PATH (infra/stacks/web_stack.py), which sets DATABASE_SSL_CA to it in the task definition.
# --checksum pins the download; if AWS updates the bundle the build fails, printing the new digest to paste in here.
#
# Deliberately NOT paired with `ENV DATABASE_SSL_CA=...` here: that would make every run of this image demand TLS,
# breaking a local container pointed at a plain Postgres with "The server does not support SSL connections". Using the
# bundle is a deployment decision, so infra/stacks/web_stack.py sets DATABASE_SSL_CA. Keep the two paths in step if this
# one ever moves.
ADD --chown=app:app --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/certs/rds-global-bundle.pem

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

# Matches infra/stacks/web_stack.py's CONTAINER_PORT, which the load balancer's target group also health-checks on.
ENV PORT=8000
ENV HOSTNAME=0.0.0.0
EXPOSE 8000

RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app

# As in migrator: Amazon's RDS CA bundle, at a path in step with RDS_CA_BUNDLE_PATH (infra/stacks/web_stack.py). Not
# paired with an unconditional ENV DATABASE_SSL_CA here — see migrator's stage above for why.
ADD --chown=app:app --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/certs/rds-global-bundle.pem

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

USER app
CMD ["node", "server.js"]
