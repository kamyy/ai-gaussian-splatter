# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. This app is public-facing with real abuse protection. A secondary goal is attempting AI/ML processing in the cloud on AWS.

**Read `ARCHITECTURE.md` for the "why" behind every stack choice, and `RUNBOOK.md` for local dev/ops commands before making changes.**

**Each fact lives in exactly one of the three docs.** `ARCHITECTURE.md` is why — decisions, alternatives rejected, costs accepted. `RUNBOOK.md` is how to run and operate it. This file is what breaks if you don't know it: gotchas, conventions, and current state. Where a gotcha needs its rationale, name the other file instead of restating it.

**Docs and code comments describe current behavior only** — not prior libraries, old version numbers, or "this used to fail with X." Use `git log` for this instead.

**Be concise — fact plus the non-obvious reason.** Shortest accurate statement; no walkthrough of alternatives or restating the same point from multiple angles.

## Structure

Monorepo, three independent packages:

- `web/` — Next.js 16 (App Router) + Mantine + SWR + Zustand + react-three-fiber, **and** the REST API as Route Handlers under `app/api/v1/` backed by Drizzle.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job.
- `infra/` — AWS CDK (Python), 6 stacks. Carries a `package.json` despite being Python: the CDK CLI is npm-distributed regardless of app language.

Server-only code lives in `web/lib/server/` — never import it from a `"use client"` file. The one shared client-safe module is `web/lib/types.ts` (status-value tuples for Drizzle `pgEnum`s); import runs types → schema, never the reverse.

## Environment gotchas

Check here before assuming standard behavior. Grouped by area.

### Auth (Clerk)

`web/proxy.ts` default exports `clerkMiddleware()`. It reads the Clerk cookie so later code can tell who is signed in, if anyone. Sign-in checks happen later using `auth.protect()` on pages and `requireUser()` / `requireClerkUserId()` on API routes.

`config.matcher` in `web/proxy.ts` is the list of URL patterns that decide whether `clerkMiddleware()` is run. Keep it covering pages and `/api/*` — if not run the Clerk cookie isn't read and any later `auth()` calls will throw instead of sending the visitor to sign-in.

- **`proxy.ts` only loads from `web/`'s root, beside `app/`** — not the repo root, not inside `app/`. Next reads it from nowhere else and says nothing when it's misplaced; the symptom is every authenticated route 500ing with "clerkMiddleware() was not run". Confirm `ƒ Proxy (Middleware)` appears in `next build`'s route table.
- **The matcher skips static files by file extension (`.js`, `.png`, …), not by "the path contains a dot".** A page like `/splats/my.splat.v2` still needs `clerkMiddleware()` to run.
- **API routes check auth themselves.** Each authenticated handler calls `requireUser()` or `requireClerkUserId()` (`lib/server/auth.ts`). Public routes (gallery, healthz, the worker's token callback) simply don't call those.
- **`auth.protect()` in `app/(authenticated)/layout.tsx` only redirects unsigned visitors to sign-in.** The API is protected by `requireUser()` / `requireClerkUserId()` in each handler, not by this layout. Next reuses layouts when navigating between sibling routes (`/dashboard` → `/splats/new`), so `auth.protect()` will not re-run. If a page starts rendering protected data on the server, that page needs its own `auth.protect()`.
- **This Clerk SDK has no `<SignedIn>` / `<SignedOut>`.** Use `<Show when="signed-in">` (`components/layout/SiteHeader.tsx`). Pass `fallback` for the signed-out UI. While Clerk is still loading the session, `<Show>` renders nothing — not the fallback.
- **Set `NEXT_PUBLIC_CLERK_SIGN_IN_URL` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL` at build time**, or Clerk sends users to its hosted Account Portal instead of this app. The paths never change, so `web/Dockerfile` bakes them in as `ENV`. Both pages need an optional catch-all (`app/sign-in/[[...sign-in]]/page.tsx`) because Clerk puts verification and SSO steps on sub-paths; a plain `page.tsx` 404s mid-sign-in.
- **A dummy Clerk publishable key still has to look like a real one.** `clerkMiddleware()` parses the key and rejects a malformed string. CI uses `pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk` (base64 of `"example.clerk.accounts.dev$"`), which parses without contacting Clerk.
- **Turn off telemetry with `NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED`** (set in `ci.yml`, `web/Dockerfile`, and `.env.example`). The package reads that name on the server and also bakes it into the browser bundle. `CLERK_TELEMETRY_DISABLED` (no `NEXT_PUBLIC_`) only covers the server collector. `isCI()` hides the console notice; it does not stop reporting. A `pk_test_…` key still reports from CI and local container builds; a `pk_live_…` key does not.
- **`NEXT_PUBLIC_*` values are baked into the JS at `next build` time.** Setting `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a container env var at runtime does nothing — pass it as `docker build --build-arg`. `CLERK_SECRET_KEY` is the real secret and is injected at runtime from Secrets Manager.

### Next.js & TypeScript

- **Prefer `function` declarations over arrow functions**, except closures assigned to a local (`const handleClick = () => {...}`) or inline arguments (`.map(x => ...)`, `useEffect(() => {...})`). Top-level: `export function foo() {}`, not `export const foo = () => {}`.
- **`if`/`for`/`while`/`do` bodies always use a `{ }` block** — never `if (x) return;`. Biome `style/useBlockStatements` (enabled in `biome.json`; not in `recommended`).
- **`next typegen` before `tsc --noEmit` on a clean checkout.** Route Handlers use `RouteContext<"/path">`; Next writes those helpers into gitignored `web/.next/types/` during `next dev`/`build`. Without them: `TS2304: Cannot find name 'RouteContext'`. CI and `scripts/typecheck.js` run `typegen` first.
- **`web/` uses TypeScript `^7.0.2` (no JS Compiler API).** Next's typecheck needs `useTypeScriptCli` (default on as of Next `16.3.0`). Without it Next can't load `typescript`, including `next.config.ts`. `infra/` has no TypeScript dependency.
- **Server Components reading request-time data need `export const dynamic = "force-dynamic"`**, or `next build` statically prerenders them. They call `web/lib/server/data.ts` directly — not this app's HTTP API.
- **Playwright `page.route()` can't intercept SSR** (different Node process). Gallery/share pages read the DB via `lib/server/data.ts`, so HTTP mocks don't help and the gallery E2E stays `test.skip`. Seed a test DB instead; see Known gaps.

### Mantine & React Server Components

- **`@mantine/core` v9 compound statics don't resolve through the bundler** (`AppShell.Header`, `Card.Section` → `undefined` at runtime). Use standalone exports: `AppShellHeader`, `AppShellMain`, `CardSection`, etc.
- **Don't pass a component reference as a prop across the Server→Client boundary** (e.g. `<Card component={Link}>` from an async Server Component). Nest `<Link>` around the component instead.
- **Check `https://mantine.dev/llms.txt` before writing or answering Mantine API questions.** Training data lags the API.

### CI & repo tooling

- **Renaming/removing a CI job blocks merges until branch protection is updated too.** Required checks name jobs (`worker`, `web`, `infra`); a missing context leaves PRs unmergeable — `enforce_admins` is on, so `--admin` does not override either. Rules live in GitHub Settings → Branches, not `ci.yml`. List: `gh api repos/kamyy/ai-gaussian-splatter/branches/main/protection`.
- **Biome does not format Markdown or YAML** (`@biomejs/biome@2.5.6`). Keep `.md`/`.yml` consistent by hand. No max source line width for Markdown — GitHub reflows paragraphs; fixed wraps only add diff noise. One line per paragraph/list item.
- **Never put `--` before a `cdk:*` script's flags.** pnpm forwards them — the script sees `["--", "-c", "foo=bar"]` — and then cdk's own parser discards everything after the separator, so the app synthesizes against `app.py`'s placeholder context instead. `BackendStack` rejects the placeholder `clerkSecretArn`, which is the only reason this surfaces at all.
- **Node is pinned in root `.nvmrc` (`24.18.0`); CI jobs use `node-version-file`.** Run `nvm use` from repo root. Nothing executes `.ts` via Node directly (Next/Vitest/Playwright transform; root `scripts/*` are `.js`).

### Git workflow

- **`main` is push-protected — all changes land via PR**, including docs/config/`.gitignore`.
- **Branch names are type-prefixed** (`chore/`, `refactor/`, `docs/`, `fix/`, …). Commit messages are a separate convention.
- **Merge with `gh pr merge --merge`**, not squash/rebase — preserves scoped commits on `main`.
- **Update a stale PR with `git rebase main`** then `push --force-with-lease`, not merge `origin/main` into the branch.

### Worker (GPU pipeline)

- **Local pipeline runs are a Podman container: they need an NVIDIA GPU, the NVIDIA driver, and `nvidia-container-toolkit`.** CUDA (including `nvcc`), COLMAP, and gsplat live in the worker image — don't install those on the host. Setup and the `podman run` command are in [RUNBOOK.md](RUNBOOK.md#worker-local-pipeline-run).
- **The worker container is two hops from IMDS, so `RunInstances` sets `HttpPutResponseHopLimit: 2`** (`ec2Launcher.ts`). At EC2's default of 1 the token PUT in `pipeline/instance.py` gets no reply, `get_self_instance_id()` returns `None`, and the instance never terminates itself — logging one INFO line indistinguishable from a local run while a `g5.xlarge` keeps billing. `HttpTokens: "required"` is paired with it and depends on it: on its own it removes the IMDSv1 fallback and breaks credentials too, not just self-termination.
- **Typical agent sandboxes have none of that** (a GPU driver alone isn't enough — `gsplat` needs `nvcc` to JIT). `train.py` is structurally validated but unproven on real hardware; don't claim the training loop "works" without that.

### Infra (CDK / AWS)

- **Keep the ACM cert declared inline in `backend_stack.py`** so it issues in the ALB's region (`us-west-2`; see `ARCHITECTURE.md`). Same hostname in another region is normal (certs are free).
- **Set the listener `ssl_policy` explicitly** (`RECOMMENDED_TLS`). Unset falls back to `ELBSecurityPolicy-2016-08` (TLS 1.0/1.1), not the console's strong default.
- **Never switch the Route 53 zone to `from_lookup()`.** Lookups need live credentials and write account-specific data into checked-in `cdk.context.json`. Zone ID is CDK context (`-c hostedZoneId=...`) with a placeholder so `cdk synth` works offline. Template owns only the app A-alias; ACM adds its validation CNAME itself.
- **`infra/tests/conftest.py` loads `cdk.json`'s context by hand — keep it that way.** Only the CDK CLI passes that context to the app (as `CDK_CONTEXT_JSON`); a bare `cdk.App()` sees no feature flags at all. Without it the suite asserts against a differently-synthesized app than the one that deploys, and passes while the real template breaks.
- **The ALB's `0.0.0.0/0` ingress is written out in `network_stack.py`.** `ApplicationLoadBalancedFargateService` stops adding it once handed explicit `security_groups` (`aws-ecs-patterns:secGroupsDisablesImplicitOpenListener`, on). Deleting those two rules synthesizes and deploys fine and refuses every connection.
- **`ec2:RunInstances` needs two statements, not one.** IAM authorizes it against each resource the request touches; `ec2Launcher.ts` tags only the instance, so `aws:RequestTag` is absent for the AMI, subnet, and security group and a single conditioned statement denies the whole call. `ec2:CreateTags` (scoped by `ec2:CreateAction`) is a separate authorization that tagging-on-launch also requires. `test_backend_stack.py` pins both.
- **The Clerk secret is imported, not created — it must exist before the first deploy** (`RUNBOOK.md`). `BackendStack` takes its complete ARN via `-c clerkSecretArn=...`: ECS resolves a task definition's `valueFrom` against the six-character suffix, so a partial ARN synthesizes and deploys clean, then fails at task start. The ARN is checked against the stack's own account and region, so a forgotten flag fails at synth — including on `cdk:deploy:registry`, which synthesizes the whole app even though it deploys one stack.
- **The image tag is a commit SHA, and `RegistryStack`'s repository is `IMMUTABLE`.** A pushed tag can never be repointed, so rebuilding an already-pushed commit fails at `podman push` with `ImageTagAlreadyExists` — commit again rather than retagging. `BackendStack` refuses any tag that is not a SHA at synth. Both exist to keep the deployment circuit breaker's rollback meaningful: with a moving tag every release shares one task definition, and a rollback re-pulls the image that just failed.
- **`BudgetsStack`'s SNS topic needs a customer-managed KMS key.** `alias/aws/sns` has an uneditable policy that omits CloudWatch, so the alarm fails its action with "CloudWatch Alarms does not have authorization to access the SNS topic encryption key" and notifies nobody. Costs $1/month.
- **`@aws-cdk/core:defaultCrossStackReferences` is pinned to `strong` deliberately** — chosen over the CLI-recommended `weak`, which drops CloudFormation's refusal to delete an in-use export (so `cdk destroy DataStack` would succeed while `BackendStack` still imports its bucket ARNs) and emits `Fn::GetStackOutput`, a CDK CLI pseudo-intrinsic that `cfn-lint` rejects with `E1022`. The cost is the deadly embrace: removing a cross-stack reference takes three deploys (`BOTH` → `WEAK` → remove).
- **A second ingress rule on `backend_security_group` opens a path from the internet.** Tasks are in public subnets with a public IP and no NAT — that group's single ALB-sourced rule on `CONTAINER_PORT` is the only network control (`ARCHITECTURE.md`). `test_network_stack.py` pins rule count 1 and NAT count 0; tripping those is a security change. Both groups live in `network_stack.py` — moving the ALB group to `BackendStack` causes a cross-stack `DependencyCycle`.
- **`KEEP_ALIVE_TIMEOUT` must exceed the ALB idle timeout (60s), or healthy deploys serve intermittent 502s.** Node's default keep-alive is 5s; Next standalone only overrides via `KEEP_ALIVE_TIMEOUT`. ALB then hands requests to sockets the app already closed — no app log entry. `backend_stack.py` sets `65000` ms. Raising ALB idle without raising this reopens the gap.
- **Don't control deploy region via `CDK_DEFAULT_REGION`.** The CLI overwrites it before spawning `app.py` (falls back to `us-east-1` with no credentials). `app.py` hardcodes `us-west-2`.
- **Don't use `CDK_DEFAULT_ACCOUNT` either.** With real credentials the CLI overwrites it via STS, so `cdk.context.json` AZ caches would track whoever is logged in. `app.py` reads `AWS_ACCOUNT_ID` (CLI never touches it), defaulting to placeholder `123456789012`. `cdk.context.json` caches AZs for `us-west-2` and `us-east-1` (`BudgetsStack`) against that placeholder.

## Database

### Schema & migrations (Drizzle)

- **Schema edits don't write SQL — always `pnpm db:generate`.** Types update on save of `schema.ts`, so `tsc` stays green while the DB drifts. Flow: edit → `db:generate` → review `web/drizzle/` → `db:migrate`. Don't hand-edit `drizzle/meta/`. `web/drizzle/` is Biome-excluded.
- **Write column names explicitly (`uuid("user_id")`); don't use `casing: "snake_case"`.** That option must match in both `drizzle.config.ts` and the runtime `drizzle()` call, or schema and queries disagree silently. It affects identifiers only, not enum values.
- **Enum values are snake_case in Postgres, TypeScript, and JSON.** `pgEnum` labels *are* the DB labels; tuples live in `web/lib/types.ts`, imported by `schema.ts`. Worker emits the same strings — no translation on the callback route.

### Query patterns

- **UUID-check path params before the DB** — `uuid` columns turn `/api/v1/gallery/abc` into Postgres `22P02` → 500. Use `requireUuid()` (routes) or `isUuid()` (`data.ts`, null → `notFound()`).
- **Missing row is `undefined`, not `null`.** Idiom: `const [row] = await getDb().select()…limit(1)` then `if (row === undefined)`.
- **`onConflictDoNothing()` returns zero rows from `.returning()`.** `getOrCreateUser` uses `onConflictDoUpdate` with no-op `set: { clerkUserId }` so Postgres returns the existing row.
- **Upsert `set` must reference the column, not a pre-read JS value** — e.g. ``count: sql`${rateLimitCounters.count} + 1` ``. A plain `{ count: n + 1 }` reopens the race. Confirm real SQL with `log_statement='all'` or `drizzle(pool, { logger: true })`.
- **`.$onUpdate(() => new Date())` drives `updatedAt`** — no DB trigger; raw `sql` UPDATE skips it.

### Local dev & tests

- **`await closeDb()` in `afterAll`** or Vitest hangs (open `pg` Pool). `test/server-global-setup.ts` closes its own migration pool in `finally`.
- **DB tests skip unless `TEST_DATABASE_URL` is set** (CI service container). Try `podman run postgres:18` if Postgres seems missing.
- **`fileParallelism: false` in `web/vitest.config.mts`.** DB-backed files share one DB and clear tables in `beforeEach`; parallel runs delete each other's fixtures. Per-worker DBs would restore parallelism. Transaction-per-test can't cover the real concurrency tests (`getOrCreateUser` race, rate-limit atomicity) — one connection serializes queries.

### Connecting to RDS in production

**Connection string assembly.** RDS secrets are JSON (`username`/`password`); ECS can inject only one JSON field at a time — no formatted `postgresql://` URL. `backend_stack.py` projects `DATABASE_USER`/`DATABASE_PASSWORD` from the secret and passes `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_NAME` as env; `web/lib/server/databaseUrl.ts` reassembles and percent-encodes user/password. Same five parts everywhere (local, CI, drizzle-kit) — one path. Tests: `test_backend_stack.py`, `databaseUrl.test.ts`.

**TLS.** RDS forces SSL (`rds.force_ssl = 1`); `pg` defaults to no TLS → `no pg_hba.conf entry ... no encryption`. `/api/v1/healthz` never hits the DB, so ECS can look healthy while queries 500. Node's `?sslmode=require` is `verify-full`, not libpq's encrypt-only — without Amazon's CA you get `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Fix: bake the RDS CA bundle in `web/Dockerfile`, set `DATABASE_SSL_CA` from `backend_stack.py`, pass `ssl: { ca }` in `databaseUrl.ts`; leave `rejectUnauthorized` at default `true`. Do not use `rejectUnauthorized: false`. (Node's `sslmode` behavior was checked empirically; libpq docs don't transfer.)

## Testing

```bash
(cd web && pnpm typecheck && pnpm biome:ci && pnpm test && pnpm test:e2e)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && pnpm cdk:synth)
```

Postgres-dependent web tests need `TEST_DATABASE_URL` (see `RUNBOOK.md`). Run the relevant subset after changes.

`pnpm biome:ci` above matches CI's root `lint-format` job (covers `scripts/*.js` too). The `web` job runs `typegen`/`tsc`/migrate/vitest/`next build`/playwright only.

## State / what's next

Scaffolding (three packages + CI) is in place. Host-run `next dev`/`start` can 500 with `ECONNREFUSED ::1` in sandboxes that block loopback to the Next proxy process — use the container (own netns); not an app bug.

Known gaps, priority order:

1. **E2E asserts nothing.** One skipped gallery spec; pages SSR from the DB with no seed. Seed + un-skip.
2. **Deploy path never applies migrations.** RDS starts empty; image doesn't migrate on boot (multi-task race, no advisory lock). Hand-run per `RUNBOOK.md`; automation still open.
3. **`web/Dockerfile` never run on AWS** — local podman only; ECS/ECR path unproven.
4. **Training rasterizes at full photo resolution.** `_load_views` (`worker/pipeline/train.py`) resizes each photo to its COLMAP camera's `width`/`height`, which are the *original* dimensions — COLMAP downsamples for feature detection only and keeps intrinsics in original pixels — so that resize is a no-op and a 12 MP phone photo trains at 12 MP against the reference implementation's ~1600px longest edge. Two consequences: training dominates job wall clock, and every ground-truth image sits in VRAM at full size (~5.9 GB for 40 × 12 MP), so a large enough set OOMs the A10G. Fix is a longest-edge cap in `_load_views` scaling `fx`/`fy`/`cx`/`cy` and `width`/`height` by the same factor, or `K` no longer matches the pixels.
5. **No maximum photo count or upload size.** `MIN_PHOTOS_PER_SPLAT` has no counterpart and the presign body schema (`app/api/v1/splats/[splatId]/photos/presign/route.ts`) is `.min(1)` only. COLMAP's exhaustive matching is O(n²) pairs and the instance runs until `run_job.py` returns, so an oversized upload is unbounded GPU spend — the global daily cap in `process` bounds job count, not job cost (`ARCHITECTURE.md`).
6. **Worker can't pull its image.** One ECR repo (web only); `WorkerIamStack` has no ECR pull perms (`ecr:GetAuthorizationToken`, `BatchGetImage`, `GetDownloadUrlForLayer`). `ec2Launcher.ts` user-data runs `aws ecr get-login-password` then `docker pull`, so login fails and the instance keeps billing (see gap 7). `WORKER_IMAGE_URI`/`ECR_REGISTRY` still default to `REPLACE_WITH_ECR_IMAGE_URI`/`REPLACE_WITH_ECR_REGISTRY`. M5.
7. **No fallback for a worker that never reports.** Self-terminate is in `run_job.py`'s `finally`; no CloudWatch runtime alarm yet — only `BudgetsStack` email.
8. **`hostedZoneId`, `clerkSecretArn`, and `imageTag` required on real deploy.** The zone placeholder fails at deploy time; the ARN and tag placeholders fail at synth against a real account.
9. **`_densify_and_prune` discards optimizer state.** `train.py` rebuilds the Adam optimizer after each densification round, dropping its moment estimates every `iterations // 10` steps. Suspect this before raising the iteration count if 10k under-converges — raising it is the expensive fix.

**M0 is next:** photograph a real object per `RUNBOOK.md`'s capture guidance, then COLMAP→gsplat on real hardware. Needs the user, not an agent.
