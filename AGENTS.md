# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. Portfolio project — secondary goal is demonstrating AI/ML engineering skill, so it's public-facing with real abuse protection, not a private tool.

**Read `docs/ARCHITECTURE.md` for the "why" behind every stack choice, and `docs/RUNBOOK.md` for local dev/ops commands before making changes.** This file is orientation + gotchas, not a duplicate of those.

## Structure

Monorepo, three independent packages, each with its own dependency manager:

- `web/` — Next.js 16 (App Router) + Mantine + SWR + Zustand + react-three-fiber, **and** the REST API as Route Handlers under `app/api/v1/` backed by Prisma. `pnpm`.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job. `uv`.
- `infra/` — AWS CDK (Python), 5 stacks. `uv` + `pnpm` (the CDK CLI itself is npm-distributed regardless of app language).

Server-only code lives in `web/lib/server/` — never import it from a
`"use client"` file, or Prisma and the AWS SDK end up in the browser bundle.

## Environment gotchas hit while building this

These cost real debugging time — check here before assuming standard behavior:

- **Next.js 16 renamed `middleware.ts` → `proxy.ts`** (function name `middleware` → `proxy` too). `@clerk/nextjs`'s `clerkMiddleware()` works unchanged under the new name. **It must sit at the package root, beside `app/`, not inside it** — Next loads it from nowhere else and says nothing when it's misplaced; the symptom is every authenticated route 500'ing with "clerkMiddleware() was not run". Verify `ƒ Proxy (Middleware)` appears in `next build`'s route table.
- **`proxy.ts`'s two matchers do different jobs, and narrowing the wrong one breaks `auth()` app-wide.** `config.matcher` decides which requests Next runs the proxy for at all; `isProtectedRoute` decides which of those Clerk forces a login on. `/api/*` is deliberately in the first and not the second: `clerkMiddleware()` doesn't only block, it also parses the session and attaches the auth context that `auth()` later reads inside a Route Handler. Drop `/(api|trpc)(.*)` from `config.matcher` and every handler calling `auth()` throws "clerkMiddleware() was not run"; add `/api` to `isProtectedRoute` instead and the public endpoints (gallery, healthz, and the worker's token-authenticated callback, which has no Clerk session by design) start demanding a login.
- **Dummy Clerk publishable keys must still be structurally valid.** `clerkMiddleware()` parses the key and rejects a malformed one outright. CI uses `pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk` — base64 of `"example.clerk.accounts.dev$"` — which parses offline without contacting Clerk.
- **`NEXT_PUBLIC_*` is inlined at build time, not read at runtime.** Setting `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a container env var does nothing — it has to be a `docker build --build-arg` (see `web/Dockerfile`). Only `CLERK_SECRET_KEY` is a genuine runtime secret, injected from Secrets Manager.
- **Prisma 7 moved the datasource URL out of `schema.prisma`.** `datasource db { url = env("DATABASE_URL") }` is a hard error; the migration CLI reads it from `web/prisma.config.ts`, and the runtime client needs an explicit driver adapter (`@prisma/adapter-pg`). Upside: the adapters are pure JS with no query-engine binary, so `output: "standalone"` file tracing picks Prisma up without special handling.
- **`prisma generate` must re-run after every schema edit** or the client keeps the stale mapping — a renamed enum `@@map` fails at runtime (`type "public.x" does not exist`) while `tsc` stays green. `postinstall` covers installs; re-run it by hand after editing `schema.prisma`.
- **`next typegen` must run before `tsc --noEmit` on a clean checkout.** Route Handlers reference `RouteContext<"...">`, a global Next emits into `web/.next/types/` — which is gitignored, so `tsc` alone fails with `TS2304: Cannot find name 'RouteContext'`. Both `.github/workflows/ci.yml` and `scripts/typecheck.js` run it first; it passes locally without that only because a previous `next dev`/`next build` left the types behind.
- **Renaming or removing a CI job blocks every merge to `main` until branch protection is updated too.** `main`'s required status checks name jobs individually (currently `worker`, `web`, `infra`), and a required context that never reports leaves PRs permanently unmergeable — `enforce_admins` is on, so `--admin` doesn't override it either. The coupling is invisible from the repo: the rules live in GitHub Settings → Branches, not in `ci.yml`. Update both in the same change, and read the current list with `gh api repos/kamyy/ai-gaussian-splatter/branches/main/protection`.
- **Path params must be UUID-checked before they reach Prisma.** The id columns are `@db.Uuid`, so `/api/v1/gallery/abc` makes Postgres raise `22P02`, which surfaces as a 500. Use `requireUuid()` (routes) or `isUuid()` (`lib/server/data.ts`, which returns null so pages can `notFound()`).
- **Prisma's `upsert()` is not an atomic upsert.** Query logs confirm it issues a `SELECT` then an `INSERT`/`UPDATE`, even for the simplest single-unique-field case — so it cannot substitute for `INSERT ... ON CONFLICT` where a check-and-increment must be race-free. `web/lib/server/rateLimit.ts` uses `$queryRaw` for exactly this reason; don't "simplify" it.
- **`@mantine/core` v9's compound static properties don't resolve through the bundler** (`AppShell.Header`, `Card.Section`, etc. resolve to `undefined` at runtime under both Turbopack and Webpack, despite working via plain Node `require()`). Use the standalone named exports instead: `AppShellHeader`, `AppShellMain`, `CardSection`, etc.
- **Don't pass a component reference as a prop across the Server→Client boundary** (e.g. Mantine's `<Card component={Link} href=...>` from an async Server Component) — RSC serialization forbids it. Nest `<Link>` around the component instead.
- **Server Components reading request-time data need `export const dynamic = "force-dynamic"`** — otherwise `next build` tries to statically prerender them and bakes the data into the build. They call `web/lib/server/data.ts` directly rather than fetching this app's own API over HTTP.
- **Playwright's `page.route()` can't intercept server-side `fetch()` calls** made by Next's SSR process (a different Node process than the browser). For pages doing server-side data fetching, use a real mock HTTP server instead (see `web/e2e/mock-backend.mjs` + the two-`webServer` setup in `playwright.config.ts`).
- **`web/` is pinned to TypeScript `^6.0.3`, not 7.x — Next.js's own TypeScript integration is broken on TS 7.0.** Next resolves and loads `typescript` as a JS module via the old Compiler API; TS 7.0's package layout dropped that JS API entirely, so Next reports TypeScript as missing even when `typescript@7.x` is installed — including failing to load `next.config.ts` itself. Vercel's fix is an `experimental.useTypeScriptCli` flag that shells out to `tsc` directly instead, but that only exists starting in **Next.js 16.3 Preview** — this repo is on `16.2.12`. Don't bump past 6.x until either Next.js is upgraded past 16.2.12 with that flag enabled and verified working, or TS 7.1 restores the programmatic API and Next drops the requirement entirely. `infra/` still has no TypeScript dependency at all (Python CDK port).
- **Biome has no Markdown or YAML support** (Markdown isn't on their 2026 roadmap; YAML was never in scope) — `.md` and `.yml`/`.yaml` files (including `.github/workflows/ci.yml`) aren't auto-formatted by anything, unlike under the old Prettier setup. Keep formatting consistent by hand/by eye when editing these.
- **No CUDA toolkit in typical dev sandboxes** (a GPU driver alone isn't enough — `gsplat`'s kernels need `nvcc` to JIT-compile). `worker/pipeline/train.py` has real, structurally-validated code but its actual training loop has not been run end-to-end on real hardware. Don't claim it's "working" without doing so on a real GPU box.
- **Postgres may not be available in a dev sandbox** — try `podman run postgres:18` before assuming it isn't. `web/lib/server/rateLimit.test.ts` and the DB-backed auth tests skip unless `TEST_DATABASE_URL` is set (CI wires a service container; see `.github/workflows/ci.yml`).
- **Node version is pinned in root `.nvmrc` (`24.18.0`), and `web`/`infra` CI jobs read that same file via `setup-node`'s `node-version-file` input** — instead of a separately hardcoded `node-version:`, so local dev and CI can't silently drift onto different majors. Run `nvm use` from repo root to match. The pin originally bought Node's native TypeScript type-stripping for root `scripts/*`, which are plain `.js` now; nothing in the repo executes `.ts` directly via Node any more (`web/`'s TS goes through Next.js/Vitest/Playwright's own transforms). It stays regardless: Node 24 is the current Active LTS, supported through April 2028.
- **`CDK_DEFAULT_REGION` can't be used to control the deploy region via shell export.** The CDK CLI unconditionally overwrites it right before spawning `app.py`, using the AWS SDK's own default-region resolution — which falls back to `us-east-1` with no credentials configured, clobbering whatever you exported. `app.py` hardcodes the deploy region (`us-west-2`) directly for this reason. Account deliberately avoids `CDK_DEFAULT_ACCOUNT` too, for the inverse reason: whenever real AWS credentials _are_ active, the CLI resolves them via a live STS call and overwrites `CDK_DEFAULT_ACCOUNT` with that real account ID before spawning `app.py` — which would make `cdk synth`'s AZ-lookup cache writes to `cdk.context.json` depend on whoever's local login state happens to be active (real account IDs from a dev's SSO session have ended up as unwanted diffs to this checked-in file). `app.py` instead reads `AWS_ACCOUNT_ID`, a name the CDK CLI never touches, falling back to AWS's well-known placeholder account ID (`123456789012`) when unset — so `cdk synth` behaves identically regardless of local AWS login state, and only a deliberate `AWS_ACCOUNT_ID` (a GitHub Actions secret in CI, or an explicit export for a manual deploy) changes it. This is CDK-CLI-level behavior, not language-specific — it applied identically when `infra/` was TypeScript and applies identically now that it's Python. `cdk.context.json` caches the AZ lookups for both `us-west-2` (main stacks) and `us-east-1` (`BudgetsStack`, pinned there since billing metrics only publish in that region) against the placeholder account, so `cdk synth` works without live credentials or setup.

## Testing

```bash
(cd web && npx tsc --noEmit && npx biome ci . && npx vitest run && npx playwright test)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && npx cdk synth)
```

`web/`'s Postgres-dependent tests skip unless `TEST_DATABASE_URL` is set — pass
it to actually run them (see `docs/RUNBOOK.md`).

Run the relevant subset after any change — all of the above pass cleanly as of this writing. Real bugs were caught this way repeatedly during initial scaffolding (see `docs/ARCHITECTURE.md`'s testing section and git history) — don't skip validation because something "looks right."

Note: `npx biome ci .` above validates the same thing CI checks, but not from inside CI's `web` job — it's a separate root-scoped `lint-format` job (single `biome ci .` run from repo root, covering `scripts/*.js` too, not just `web/`). The `web` job itself only runs `tsc`/`prisma migrate deploy`/`vitest`/`next build`/`playwright`.

## State / what's next

Repo scaffolding (all 3 packages + CI) is done and validated per above. The API
layer was verified against a real Postgres 18 end to end: migrations, all 12
Route Handlers, the worker status callback, rate-limit atomicity under
concurrency, and the standalone production build serving live requests.

Known gaps, in priority order:

1. **`web/e2e/mock-backend.mjs` is stale** — the pages it covers read Prisma
   directly, so it serves data nothing requests, and `playwright.config.ts`
   still sets the unused `NEXT_PUBLIC_API_BASE_URL`. Its one test is skipped;
   redesign around a seeded test database before trusting E2E coverage.
2. **`web/Dockerfile` has never been built.** No container runtime was available
   to validate it. `next build` with `output: "standalone"` was verified, and the
   standalone server was run directly, but the image itself is unproven.
3. **`APP_PUBLIC_URL` is a placeholder** (`https://app.example.com`). It can't be
   derived from the stack that creates the ALB without a circular CloudFormation
   dependency, so pass `-c appPublicUrl=...` after the first deploy or set up a
   custom domain. The worker cannot report status until this is real.

Per the plan's build order, **M0 is still next**: a real physical object needs
to be photographed (~50 photos, multi-angle) so the COLMAP→gsplat pipeline can
be validated end-to-end on real hardware before anything else is trusted. That
step needs the user, not an agent.
