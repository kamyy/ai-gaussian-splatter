# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. Portfolio project — secondary goal is demonstrating AI/ML engineering skill, so it's public-facing with real abuse protection, not a private tool.

**Read `docs/ARCHITECTURE.md` for the "why" behind every stack choice, and `docs/RUNBOOK.md` for local dev/ops commands before making changes.** This file is orientation + gotchas, not a duplicate of those.

## Structure

Monorepo, three independent packages, each with its own dependency manager:

- `web/` — Next.js 16 (App Router) + Mantine + SWR + Zustand + react-three-fiber, **and** the REST API as Route Handlers under `app/api/v1/` backed by Drizzle. `pnpm`.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job. `uv`.
- `infra/` — AWS CDK (Python), 5 stacks. `uv` + `pnpm` (the CDK CLI itself is npm-distributed regardless of app language).

Server-only code lives in `web/lib/server/` — never import it from a
`"use client"` file, or the database client and AWS SDK end up in the browser
bundle. The one thing shared across that boundary is `web/lib/types.ts`, which
holds the status-value tuples the Drizzle schema builds its `pgEnum`s from;
the import runs client-safe-module → schema, never the reverse.

## Environment gotchas hit while building this

These cost real debugging time — check here before assuming standard behavior:

- **Next.js 16 renamed `middleware.ts` → `proxy.ts`** (function name `middleware` → `proxy` too). `@clerk/nextjs`'s `clerkMiddleware()` works unchanged under the new name. **It must sit at the package root, beside `app/`, not inside it** — Next loads it from nowhere else and says nothing when it's misplaced; the symptom is every authenticated route 500'ing with "clerkMiddleware() was not run". Verify `ƒ Proxy (Middleware)` appears in `next build`'s route table.
- **`proxy.ts`'s two matchers do different jobs, and narrowing the wrong one breaks `auth()` app-wide.** `config.matcher` decides which requests Next runs the proxy for at all; `isProtectedRoute` decides which of those Clerk forces a login on. `/api/*` is deliberately in the first and not the second: `clerkMiddleware()` doesn't only block, it also parses the session and attaches the auth context that `auth()` later reads inside a Route Handler. Drop `/(api|trpc)(.*)` from `config.matcher` and every handler calling `auth()` throws "clerkMiddleware() was not run"; add `/api` to `isProtectedRoute` instead and the public endpoints (gallery, healthz, and the worker's token-authenticated callback, which has no Clerk session by design) start demanding a login.
- **Dummy Clerk publishable keys must still be structurally valid.** `clerkMiddleware()` parses the key and rejects a malformed one outright. CI uses `pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk` — base64 of `"example.clerk.accounts.dev$"` — which parses offline without contacting Clerk.
- **`NEXT_PUBLIC_*` is inlined at build time, not read at runtime.** Setting `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a container env var does nothing — it has to be a `docker build --build-arg` (see `web/Dockerfile`). Only `CLERK_SECRET_KEY` is a genuine runtime secret, injected from Secrets Manager.
- **There is no codegen step, so a schema edit alone changes nothing on disk — but `drizzle-kit generate` must still be run.** The types update the instant you save `web/lib/server/db/schema.ts` (it's ordinary TypeScript), which is exactly the trap: `tsc` stays green while the schema and the actual database drift apart, and the failure only shows up as a runtime SQL error. Edit the schema → `pnpm db:generate` → review the emitted SQL in `web/drizzle/` → `pnpm db:migrate`. The `drizzle/meta/` JSON snapshots are checked in and are what `generate` diffs against; don't hand-edit them. They're excluded from Biome in `biome.json`.
- **Column names are written out explicitly (`uuid("user_id")`), and drizzle's `casing: "snake_case"` option is deliberately unused.** That option would have to be set in *two* places — `drizzle.config.ts` for what `drizzle-kit generate` emits, and the runtime `drizzle()` call for what queries reference. Setting one and not the other produces a schema and a query layer that disagree silently. Note it governs *identifiers* only; it never touches enum values.
- **Enum values are snake_case in Postgres, TypeScript, and the JSON wire format alike.** Drizzle's `pgEnum` values *are* the database labels — there's no equivalent of Prisma's `@@map`, which used to let `ColmapRunning` in TS mean `colmap_running` in Postgres. The tuples live in `web/lib/types.ts` and `schema.ts` imports them, so the unions and the labels are one list. `worker/pipeline/status.py` already speaks these exact strings, so the callback route needs no translation table.
- **`next typegen` must run before `tsc --noEmit` on a clean checkout.** Route Handlers reference `RouteContext<"...">`, a global Next emits into `web/.next/types/` — which is gitignored, so `tsc` alone fails with `TS2304: Cannot find name 'RouteContext'`. Both `.github/workflows/ci.yml` and `scripts/typecheck.js` run it first; it passes locally without that only because a previous `next dev`/`next build` left the types behind.
- **Renaming or removing a CI job blocks every merge to `main` until branch protection is updated too.** `main`'s required status checks name jobs individually (currently `worker`, `web`, `infra`), and a required context that never reports leaves PRs permanently unmergeable — `enforce_admins` is on, so `--admin` doesn't override it either. The coupling is invisible from the repo: the rules live in GitHub Settings → Branches, not in `ci.yml`. Update both in the same change, and read the current list with `gh api repos/kamyy/ai-gaussian-splatter/branches/main/protection`.
- **Path params must be UUID-checked before they reach the database.** The id columns are `uuid`, so `/api/v1/gallery/abc` makes Postgres raise `22P02`, which surfaces as a 500. Use `requireUuid()` (routes) or `isUuid()` (`lib/server/data.ts`, which returns null so pages can `notFound()`).
- **A missing row is `undefined`, not `null`.** Queries return arrays, so the idiom is `const [row] = await getDb().select()…limit(1)` and then `if (row === undefined)`. A leftover `=== null` check compiles fine and is always false — the row is silently treated as found.
- **`onConflictDoNothing()` returns zero rows from `.returning()`.** That's why `getOrCreateUser` uses `onConflictDoUpdate` with a no-op `set: { clerkUserId }`: on a conflict the update has to touch something for Postgres to hand the row back, otherwise an existing user comes back `undefined`.
- **The `set` clause of an upsert must reference the column, not a JS value.** The rate-limit counters use ``set: { count: sql`${rateLimitCounters.count} + 1` }`` so Postgres computes the increment; a plain `{ count: n + 1 }` bakes in a number read before the statement ran and reopens the read-then-write race the single-statement upsert exists to close. Verify what the database actually received rather than what the ORM appears to say — `ALTER SYSTEM SET log_statement='all'` plus `podman logs` shows the real SQL, and `drizzle(pool, { logger: true })` is the lighter-weight version.
- **`.$onUpdate(() => new Date())` is what keeps `updatedAt` moving** (Prisma's `@updatedAt` before it) — there is no database trigger. It fires on drizzle `.update()` calls only, so a raw `sql` UPDATE bypasses it and freezes the column.
- **In production there is no `DATABASE_URL` — the app builds it from parts, and that indirection is load-bearing.** RDS writes its generated credentials to Secrets Manager as a JSON blob (`{"username":…,"password":…,"host":…}`), and ECS can only project *individual fields* of a secret into an environment variable — it cannot assemble a connection string. Passing the bare secret ARN as `DATABASE_URL` (which is what `backend_stack.py` originally did) hands the container that JSON where `postgresql://…` is expected, and every query fails. So `backend_stack.py` projects `DATABASE_USER`/`DATABASE_PASSWORD` via the `arn:json-key::` selector, passes host/port/name as plain env, and `web/lib/server/databaseUrl.ts` assembles the URL — percent-encoding the credentials, since nothing stops a generated password containing `:` `?` `#` or `%`. `DATABASE_URL` still wins when set, which is why local dev, CI and `drizzle-kit` are unaffected. Both halves are pinned by tests (`infra/tests/test_backend_stack.py`, `web/lib/server/databaseUrl.test.ts`).
- **`?sslmode=require` does not do what it does in libpq, and RDS requires TLS.** RDS for PostgreSQL 15+ ships `rds.force_ssl = 1` in the default parameter group, while `pg` defaults to no TLS — so a production connection is refused with `no pg_hba.conf entry ... no encryption`, and `/api/v1/healthz` won't catch it because that endpoint never touches the database (the task reports healthy while every query 500s). But appending `?sslmode=require` swaps that for `UNABLE_TO_VERIFY_LEAF_SIGNATURE`: `pg-connection-string` currently treats `require` as an alias for `verify-full` (it sets `ssl = {}`, leaving Node's `rejectUnauthorized: true`) and RDS certificates chain to Amazon's own root CAs, absent from Node's trust store. The fix is to supply the CA: `web/Dockerfile` downloads Amazon's global bundle and `DATABASE_SSL_CA` points at it, with verification left **on**. All five variants were checked against a TLS-only Postgres using a private CA; don't re-derive it from the `sslmode` docs, which describe libpq, not this driver.
- **DB-backed tests must `await closeDb()` in `afterAll`** or Vitest hangs after the last assertion: an open `pg` Pool keeps the event loop alive. `test/server-global-setup.ts` has its own separate pool for the migration and closes it in a `finally`.
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

Note: `npx biome ci .` above validates the same thing CI checks, but not from inside CI's `web` job — it's a separate root-scoped `lint-format` job (single `biome ci .` run from repo root, covering `scripts/*.js` too, not just `web/`). The `web` job itself only runs `tsc`/`drizzle-kit migrate`/`vitest`/`next build`/`playwright`.

## State / what's next

Repo scaffolding (all 3 packages + CI) is done and validated per above. The API
layer was verified against a real Postgres 18: migrations, all 12 Route
Handlers, the worker status callback, and rate-limit atomicity under
concurrency. After the Prisma→Drizzle port the same suite was re-run green
against Postgres 18, and both single-statement upserts were confirmed at the
database level with `log_statement='all'` rather than inferred from the ORM.
The container image was then built with podman (~213 MB) and run against that
same Postgres: healthz, the gallery and public-share endpoints, the worker
status callback (including the job/splat transaction and the set-once stage
timestamps), the malformed-UUID guard, and SSR pages with `generateMetadata`'s
Open Graph tags all served correctly.

Note if you try to reproduce that outside a container: some sandboxes block the
loopback connection Next's proxy makes back to the server process, which makes
a host-run `next dev`/`next start` 500 on every request with `ECONNREFUSED
::1`. It is an environment limitation, not an app bug — the container has its
own network namespace and is unaffected.

Known gaps, in priority order:

1. **`web/e2e/mock-backend.mjs` is stale** — the pages it covers query the database
   directly, so it serves data nothing requests, and `playwright.config.ts`
   still sets the unused `NEXT_PUBLIC_API_BASE_URL`. Its one test is skipped;
   redesign around a seeded test database before trusting E2E coverage.
2. **`web/Dockerfile` builds and runs, but has never run on AWS.** Validated
   locally under podman (see above). What remains unproven is everything
   outside the image: the ECS task definition wiring and image pull from ECR.
3. **`APP_PUBLIC_URL` is a placeholder** (`https://app.example.com`). It can't be
   derived from the stack that creates the ALB without a circular CloudFormation
   dependency, so pass `-c appPublicUrl=...` after the first deploy or set up a
   custom domain. The worker cannot report status until this is real.

Per the plan's build order, **M0 is still next**: a real physical object needs
to be photographed (~50 photos, multi-angle) so the COLMAP→gsplat pipeline can
be validated end-to-end on real hardware before anything else is trusted. That
step needs the user, not an agent.
