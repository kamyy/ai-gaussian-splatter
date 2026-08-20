# The Next.js app — pages plus the REST API (Route Handlers) — for ECS
# Fargate. Node version tracks the repo's .nvmrc (24.x, current Active LTS).
#
# Built and run locally under podman (~213 MB) against a real Postgres 18:
# healthz, the gallery/public read endpoints, the worker status callback, and
# SSR pages including generateMetadata's Open Graph tags all served correctly.
# Still unproven on real AWS infrastructure — ECS task wiring, the RDS secret
# shape, and image pull are untested.
FROM node:24-alpine AS deps

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# No codegen step to accommodate: Drizzle's schema is ordinary TypeScript, so
# nothing has to be generated into node_modules before the build.
RUN pnpm install --frozen-lockfile


FROM node:24-alpine AS builder

RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js inlines NEXT_PUBLIC_* into the client bundle at build time, so the
# Clerk publishable key has to be present *here* — passing it as a container
# environment variable at runtime has no effect on the browser bundle.
# It is not a secret (it is public by design); CLERK_SECRET_KEY is the one that
# must stay out of the image, and that one is injected at runtime from Secrets
# Manager (see infra/stacks/web_stack.py).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# Baked in rather than passed as a build-arg: it is the same value for every
# image, and `.dockerignore` excludes `.env`, so a local image built with a
# pk_test_* key would otherwise ship a browser bundle with telemetry on.
ENV NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED=1

# Same build-time inlining rule as the publishable key above, but these are
# fixed route paths rather than per-environment values, so they're baked in
# rather than passed as build-args. Omitting them sends users to Clerk's
# hosted Account Portal instead of the app's own sign-in page.
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
ENV NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
ENV NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard

RUN pnpm exec next build


FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Matches infra/stacks/web_stack.py's CONTAINER_PORT, which the load
# balancer's target group also health-checks on.
ENV PORT=8000
ENV HOSTNAME=0.0.0.0
EXPOSE 8000

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# RDS for PostgreSQL 15+ defaults to rds.force_ssl=1, so the connection must be
# TLS — and RDS server certificates chain to Amazon's own RDS root CAs, which
# are not in Node's bundled trust store. Without this bundle the only way to
# connect is to stop verifying the server, so it ships in the image and
# lib/server/databaseUrl.ts verifies against it. The global bundle covers every
# region's CA.
#
# Deliberately NOT paired with `ENV DATABASE_SSL_CA=...` here: that would make
# every run of this image demand TLS, breaking a local container pointed at a
# plain Postgres with "The server does not support SSL connections". Using the
# bundle is a deployment decision, so infra/stacks/web_stack.py sets
# DATABASE_SSL_CA to this path. Keep the two in step if it ever moves.
ADD --chown=nextjs:nodejs \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/certs/rds-global-bundle.pem

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# No `COPY /app/public` — this package has no public/ directory, and COPY of a
# missing path is a hard build failure. Add it back alongside creating one.

USER nextjs

# Migrations are NOT run here. `drizzle-kit migrate` belongs to the deploy
# pipeline, not container startup: the service runs up to 3 tasks, and booting
# tasks would race to apply the same migration with nothing serialising them —
# drizzle-kit takes no advisory lock. Keeping DDL out of the container also
# means the running app never needs DDL rights on the database. See
# RUNBOOK.md.
CMD ["node", "server.js"]
