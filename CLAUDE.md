# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. Portfolio project — secondary goal is demonstrating AI/ML engineering skill, so it's public-facing with real abuse protection, not a private tool.

**Read `docs/ARCHITECTURE.md` for the "why" behind every stack choice, and `docs/RUNBOOK.md` for local dev/ops commands before making changes.** This file is orientation + gotchas, not a duplicate of those.

## Structure

Monorepo, four independent packages, each with its own dependency manager:

- `frontend/` — Next.js 16 (App Router) + Mantine + SWR + Zustand + react-three-fiber. `pnpm`.
- `backend/` — FastAPI REST API. `uv`.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job. `uv`.
- `infra/` — AWS CDK (TypeScript), 5 stacks. `pnpm`.

## Environment gotchas hit while building this (2026-07-30)

These cost real debugging time — check here before assuming standard behavior:

- **Next.js 16 renamed `middleware.ts` → `proxy.ts`** (function name `middleware` → `proxy` too). `@clerk/nextjs`'s `clerkMiddleware()` still works, just needs to live in `proxy.ts` now.
- **`@mantine/core` v9's compound static properties don't resolve through the bundler** (`AppShell.Header`, `Card.Section`, etc. resolve to `undefined` at runtime under both Turbopack and Webpack, despite working via plain Node `require()`). Use the standalone named exports instead: `AppShellHeader`, `AppShellMain`, `CardSection`, etc.
- **Don't pass a component reference as a prop across the Server→Client boundary** (e.g. Mantine's `<Card component={Link} href=...>` from an async Server Component) — RSC serialization forbids it. Nest `<Link>` around the component instead.
- **Server Components that fetch the backend need `export const dynamic = "force-dynamic"`** — otherwise `next build` tries to statically prerender them and fails with `ECONNREFUSED` since the backend isn't running at build time.
- **Playwright's `page.route()` can't intercept server-side `fetch()` calls** made by Next's SSR process (a different Node process than the browser). For pages doing server-side data fetching, use a real mock HTTP server instead (see `frontend/e2e/mock-backend.mjs` + the two-`webServer` setup in `playwright.config.ts`).
- **Stay on TypeScript 5.x/6.x, not 7.x, for `infra/` and `frontend/` — this isn't a temporary pin.** TS 7.0 (GA'd 2026-07-08, a Go-native compiler rewrite) hasn't stabilized its internal/programmatic compiler API yet — that's slated for 7.1. `ts-node` (which `infra/`'s CDK CLI depends on to run `bin/app.ts`), plus `ts-jest`, `ts-loader`, and the TypeScript-ESLint plugins, all reach into that API directly and are deliberately holding off supporting 7.x until it stabilizes — this is the ecosystem-wide current recommendation, not tool authors lagging behind. Both `infra/` and `frontend/` are explicitly pinned to `^5.9.3` for this reason. Don't bump either past 6.x until `ts-node` (or whatever replaces it) explicitly announces TS 7.1 support.
- **No CUDA toolkit in typical dev sandboxes** (a GPU driver alone isn't enough — `gsplat`'s kernels need `nvcc` to JIT-compile). `worker/pipeline/train.py` has real, structurally-validated code but its actual training loop has not been run end-to-end on real hardware. Don't claim it's "working" without doing so on a real GPU box.
- **No real Postgres available in this sandbox** — `backend/tests/test_rate_limit.py` is real but skips unless `TEST_DATABASE_URL` is set (CI wires this via a Postgres service container; see `.github/workflows/ci.yml`).
- **`CDK_DEFAULT_REGION` can't be used to control the deploy region via shell export.** The CDK CLI unconditionally overwrites it right before spawning `bin/app.ts`, using the AWS SDK's own default-region resolution — which falls back to `us-east-1` with no credentials configured, clobbering whatever you exported. `bin/app.ts` hardcodes the deploy region (`us-west-2`) directly for this reason. Account deliberately avoids `CDK_DEFAULT_ACCOUNT` too, for the inverse reason: whenever real AWS credentials _are_ active, the CLI resolves them via a live STS call and overwrites `CDK_DEFAULT_ACCOUNT` with that real account ID before spawning `bin/app.ts` — which would make `cdk synth`'s AZ-lookup cache writes to `cdk.context.json` depend on whoever's local login state happens to be active (real account IDs from a dev's SSO session have ended up as unwanted diffs to this checked-in file). `bin/app.ts` instead reads `AWS_ACCOUNT_ID`, a name the CDK CLI never touches, falling back to AWS's well-known placeholder account ID (`123456789012`) when unset — so `cdk synth` behaves identically regardless of local AWS login state, and only a deliberate `AWS_ACCOUNT_ID` (a GitHub Actions secret in CI, or an explicit export for a manual deploy) changes it. `cdk.context.json` caches the AZ lookups for both `us-west-2` (main stacks) and `us-east-1` (`BudgetsStack`, pinned there since billing metrics only publish in that region) against the placeholder account, so `cdk synth` works without live credentials or setup.

## Testing

```bash
(cd backend && uv run pytest -v)
(cd worker && uv run pytest -v)
(cd frontend && npx tsc --noEmit && npx eslint . && npx vitest run && npx playwright test)
(cd infra && npx tsc --noEmit && npx cdk synth)
```

Run the relevant subset after any change — all of the above pass cleanly as of this writing. Real bugs were caught this way repeatedly during initial scaffolding (see `docs/ARCHITECTURE.md`'s testing section and git history) — don't skip validation because something "looks right."

## State / what's next

Repo scaffolding (all 4 packages + CI) is done and validated per above. Per the plan's build order, **M0 is next**: a real physical object needs to be photographed (~50 photos, multi-angle) so the COLMAP→gsplat pipeline can be validated end-to-end on real hardware before anything else is trusted. That step needs the user, not an agent.
