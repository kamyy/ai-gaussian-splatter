# The Next.js app — pages plus the REST API (Route Handlers) — for ECS Express
# Mode. Node version tracks the repo's .nvmrc (24.x, current Active LTS).
#
# NOT YET BUILT/RUN in CI or on real infrastructure. Build it before trusting a
# deploy.
FROM node:24-alpine AS deps

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# --ignore-scripts would skip the postinstall that runs `prisma generate`, so
# it is deliberately not passed here.
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

# Migrations are NOT run here. `prisma migrate deploy` belongs to the deploy
# pipeline, not container startup: Express Mode runs up to 3 tasks, so booting
# tasks would race (Prisma's advisory lock makes that safe but serialises every
# cold start), and the running app then wouldn't need DDL rights on the
# database at all. See docs/RUNBOOK.md.
CMD ["node", "server.js"]
