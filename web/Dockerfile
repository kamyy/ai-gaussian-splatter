# The Next.js app — pages plus the REST API (Route Handlers) — for ECS Express
# Mode. Node version tracks the repo's .nvmrc (24.x, current Active LTS).
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
# Manager (see infra/stacks/backend_stack.py).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

RUN pnpm exec next build


FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Matches infra/stacks/backend_stack.py's CONTAINER_PORT, which the Express
# Mode health check (HTTP:8000/api/v1/healthz) also derives from.
ENV PORT=8000
ENV HOSTNAME=0.0.0.0
EXPOSE 8000

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# No `COPY /app/public` — this package has no public/ directory, and COPY of a
# missing path is a hard build failure. Add it back alongside creating one.

USER nextjs

# Migrations are NOT run here. `drizzle-kit migrate` belongs to the deploy
# pipeline, not container startup: Express Mode runs up to 3 tasks, and booting
# tasks would race to apply the same migration with nothing serialising them —
# drizzle-kit takes no advisory lock. Keeping DDL out of the container also
# means the running app never needs DDL rights on the database. See
# docs/RUNBOOK.md.
CMD ["node", "server.js"]
