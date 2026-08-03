# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. Portfolio project — secondary goal is demonstrating AI/ML engineering skill, so it's public-facing with real abuse protection, not a private tool.

**Read `docs/ARCHITECTURE.md` for the "why" behind every stack choice, and `docs/RUNBOOK.md` for local dev/ops commands before making changes.** This file is orientation + gotchas, not a duplicate of those.

## Structure

Monorepo, four independent packages, each with its own dependency manager:

- `frontend/` — Next.js 16 (App Router) + Mantine + SWR + Zustand + react-three-fiber. `pnpm`.
- `backend/` — FastAPI REST API. `uv`.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job. `uv`.
- `infra/` — AWS CDK (Python), 5 stacks. `uv` + `pnpm` (the CDK CLI itself is npm-distributed regardless of app language).

## Environment gotchas hit while building this (2026-07-30)

These cost real debugging time — check here before assuming standard behavior:

- **Next.js 16 renamed `middleware.ts` → `proxy.ts`** (function name `middleware` → `proxy` too). `@clerk/nextjs`'s `clerkMiddleware()` still works, just needs to live in `proxy.ts` now.
- **`@mantine/core` v9's compound static properties don't resolve through the bundler** (`AppShell.Header`, `Card.Section`, etc. resolve to `undefined` at runtime under both Turbopack and Webpack, despite working via plain Node `require()`). Use the standalone named exports instead: `AppShellHeader`, `AppShellMain`, `CardSection`, etc.
- **Don't pass a component reference as a prop across the Server→Client boundary** (e.g. Mantine's `<Card component={Link} href=...>` from an async Server Component) — RSC serialization forbids it. Nest `<Link>` around the component instead.
- **Server Components that fetch the backend need `export const dynamic = "force-dynamic"`** — otherwise `next build` tries to statically prerender them and fails with `ECONNREFUSED` since the backend isn't running at build time.
- **Playwright's `page.route()` can't intercept server-side `fetch()` calls** made by Next's SSR process (a different Node process than the browser). For pages doing server-side data fetching, use a real mock HTTP server instead (see `frontend/e2e/mock-backend.mjs` + the two-`webServer` setup in `playwright.config.ts`).
- **`frontend/` is pinned to TypeScript `^6.0.3`, not 7.x — this pin's original justification no longer applies, but the version hasn't been re-evaluated yet.** It was set because `typescript-eslint` (pulled in transitively via `eslint-config-next`) reached into TS 7's not-yet-stable internal/programmatic compiler API. As of 2026-08-03, ESLint (and `typescript-eslint` with it) has been removed from this repo entirely in favor of Biome — see the Testing section — so that constraint is gone. Bumping past 6.x is now a separate, deliberate decision to make on its own merits, not something to do silently as a side effect of an unrelated change. `infra/` still has no TypeScript dependency at all (Python CDK port).
- **Biome has no Markdown support** (not on their 2026 roadmap) — `.md` files aren't auto-formatted by anything. Keep formatting consistent by hand/by eye when editing docs.
- **No CUDA toolkit in typical dev sandboxes** (a GPU driver alone isn't enough — `gsplat`'s kernels need `nvcc` to JIT-compile). `worker/pipeline/train.py` has real, structurally-validated code but its actual training loop has not been run end-to-end on real hardware. Don't claim it's "working" without doing so on a real GPU box.
- **No real Postgres available in this sandbox** — `backend/tests/test_rate_limit.py` is real but skips unless `TEST_DATABASE_URL` is set (CI wires this via a Postgres service container; see `.github/workflows/ci.yml`).
- **Node version is pinned in root `.nvmrc` (`24.18.0`), and `frontend`/`infra` CI jobs read that same file via `setup-node`'s `node-version-file` input** (2026-08-01) — instead of a separately hardcoded `node-version:`, so local dev and CI can't silently drift onto different majors. Run `nvm use` from repo root to match. Pinned to 24 specifically because Node's native TypeScript type-stripping (run `.ts` files directly, no `ts-node`/`tsx`) only works unflagged from 23.6+; CI was previously on 22, which would've needed `--experimental-strip-types` for that to work.
- **`CDK_DEFAULT_REGION` can't be used to control the deploy region via shell export.** The CDK CLI unconditionally overwrites it right before spawning `app.py`, using the AWS SDK's own default-region resolution — which falls back to `us-east-1` with no credentials configured, clobbering whatever you exported. `app.py` hardcodes the deploy region (`us-west-2`) directly for this reason. Account deliberately avoids `CDK_DEFAULT_ACCOUNT` too, for the inverse reason: whenever real AWS credentials _are_ active, the CLI resolves them via a live STS call and overwrites `CDK_DEFAULT_ACCOUNT` with that real account ID before spawning `app.py` — which would make `cdk synth`'s AZ-lookup cache writes to `cdk.context.json` depend on whoever's local login state happens to be active (real account IDs from a dev's SSO session have ended up as unwanted diffs to this checked-in file). `app.py` instead reads `AWS_ACCOUNT_ID`, a name the CDK CLI never touches, falling back to AWS's well-known placeholder account ID (`123456789012`) when unset — so `cdk synth` behaves identically regardless of local AWS login state, and only a deliberate `AWS_ACCOUNT_ID` (a GitHub Actions secret in CI, or an explicit export for a manual deploy) changes it. This is CDK-CLI-level behavior, not language-specific — it applied identically when `infra/` was TypeScript and applies identically now that it's Python. `cdk.context.json` caches the AZ lookups for both `us-west-2` (main stacks) and `us-east-1` (`BudgetsStack`, pinned there since billing metrics only publish in that region) against the placeholder account, so `cdk synth` works without live credentials or setup.

## Testing

```bash
(cd backend && uv run ruff check . && uv run mypy app && uv run pytest -v)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd frontend && npx tsc --noEmit && npx biome ci . && npx vitest run && npx playwright test)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && npx cdk synth)
```

Run the relevant subset after any change — all of the above pass cleanly as of this writing. Real bugs were caught this way repeatedly during initial scaffolding (see `docs/ARCHITECTURE.md`'s testing section and git history) — don't skip validation because something "looks right."

## State / what's next

Repo scaffolding (all 4 packages + CI) is done and validated per above. Per the plan's build order, **M0 is next**: a real physical object needs to be photographed (~50 photos, multi-angle) so the COLMAP→gsplat pipeline can be validated end-to-end on real hardware before anything else is trusted. That step needs the user, not an agent.
