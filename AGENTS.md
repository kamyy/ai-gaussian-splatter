# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. Portfolio project — secondary goal is demonstrating AI/ML engineering skill, so it's public-facing with real abuse protection, not a private tool.

**Read `docs/ARCHITECTURE.md` for the "why" behind every stack choice, and `docs/RUNBOOK.md` for local dev/ops commands before making changes.** This file is orientation + gotchas, not a duplicate of those.

**Code comments and markdown docs (this file, `docs/`, etc.) describe current behavior only — never the history of what changed to get here.** No prior libraries that were replaced, no old version numbers, no "this used to fail with X" or "this was blocked until Y." That's what `git log`/commit messages are for; a reader here wants the current fact, not an implementation's backstory.

**Be concise — say the fact and the non-obvious reason for it, not a tl;dr essay around it.** A comment or doc paragraph should be the shortest accurate statement of the current behavior and its reason, not a walkthrough of alternatives considered or a restatement of the same point from multiple angles.

## Structure

Monorepo, three independent packages, each with its own dependency manager:

- `web/` — Next.js 16 (App Router) + Mantine + SWR + Zustand + react-three-fiber, **and** the REST API as Route Handlers under `app/api/v1/` backed by Drizzle. `pnpm`.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job. `uv`.
- `infra/` — AWS CDK (Python), 6 stacks. `uv` + `pnpm` (the CDK CLI itself is npm-distributed regardless of app language).

Server-only code lives in `web/lib/server/` — never import it from a `"use client"` file, or the database client and AWS SDK end up in the browser bundle. The one thing shared across that boundary is `web/lib/types.ts`, which holds the status-value tuples the Drizzle schema builds its `pgEnum`s from; the import runs client-safe-module → schema, never the reverse.

## Environment gotchas hit while building this

These cost real debugging time — check here before assuming standard behavior. Grouped by area so you can jump to the part you're touching.

### Auth (Clerk)

- **Next.js 16 renamed `middleware.ts` → `proxy.ts`** (function name `middleware` → `proxy` too). `@clerk/nextjs`'s `clerkMiddleware()` works unchanged under the new name. **It must sit at the package root, beside `app/`, not inside it** — Next loads it from nowhere else and says nothing when it's misplaced; the symptom is every authenticated route 500'ing with "clerkMiddleware() was not run". Verify `ƒ Proxy (Middleware)` appears in `next build`'s route table.
- **`proxy.ts`'s two matchers do different jobs, and narrowing the wrong one breaks `auth()` app-wide.** `config.matcher` decides which requests Next runs the proxy for at all; `isProtectedRoute` decides which of those Clerk forces a login on. `/api/*` is deliberately in the first and not the second: `clerkMiddleware()` doesn't only block, it also parses the session and attaches the auth context that `auth()` later reads inside a Route Handler. Drop `/(api|trpc)(.*)` from `config.matcher` and every handler calling `auth()` throws "clerkMiddleware() was not run"; add `/api` to `isProtectedRoute` instead and the public endpoints (gallery, healthz, and the worker's token-authenticated callback, which has no Clerk session by design) start demanding a login.
- **Dummy Clerk publishable keys must still be structurally valid.** `clerkMiddleware()` parses the key and rejects a malformed one outright. CI uses `pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk` — base64 of `"example.clerk.accounts.dev$"` — which parses offline without contacting Clerk.
- **`NEXT_PUBLIC_*` is inlined at build time, not read at runtime.** Setting `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a container env var does nothing — it has to be a `docker build --build-arg` (see `web/Dockerfile`). Only `CLERK_SECRET_KEY` is a genuine runtime secret, injected from Secrets Manager.

### Next.js & TypeScript

- **Prefer `function` declarations/expressions over arrow functions**, except when a function is assigned to a locally-scoped variable (a closure over surrounding state/props, e.g. `const handleClick = () => {...}` inside a component) or passed inline as an argument (`.map(x => ...)`, `useEffect(() => {...})`). This includes top-level exports: `export function foo() {}`, not `export const foo = () => {}` — a module-scope `const` that just names a function declaration isn't a closure, so it doesn't qualify for the exception even though it "assigns to a variable."
- **`if`/`for`/`while`/`do` bodies always use a `{ }`-scoped block, correctly indented — never a same-line statement** (`if (x) return;` is disallowed, even for a single-statement body). Enforced by Biome's `style/useBlockStatements`, explicitly enabled in `biome.json` since it's not part of the `recommended` preset.
- **`next typegen` must run before `tsc --noEmit` on a clean checkout.** Our Route Handlers type `params` with the global `RouteContext<"/path">` helper. Next normally writes that (and the rest of the App Router types) into `web/.next/types/` as a side effect of `next dev` or `next build` — but that directory is gitignored, so a fresh clone has never run either command and the helpers are missing. Plain `tsc --noEmit` then fails with `TS2304: Cannot find name 'RouteContext'`. `next typegen` exists for exactly this: emit those route types without starting the app or doing a full build. CI and `scripts/typecheck.js` run it first; locally it often "just works" only because you already ran `next dev`/`next build` earlier.
- **`web/` runs TypeScript `^7.0.2`, which has no JS Compiler API — Next.js's typecheck step needs `useTypeScriptCli` for that reason, and it defaults on as of Next `16.3.0`.** Without it, Next can't load `typescript` at all, including failing to load `next.config.ts` itself. No manual flag is needed on `16.3.0+`; confirmed by both `pnpm typecheck` and `pnpm build`'s own "Running TypeScript" step passing clean. `infra/` has no TypeScript dependency at all (Python CDK).
- **Server Components reading request-time data need `export const dynamic = "force-dynamic"`** — otherwise `next build` tries to statically prerender them and bakes the data into the build. They call `web/lib/server/data.ts` directly rather than fetching this app's own API over HTTP.
- **Playwright's `page.route()` can't intercept server-side work** done in Next's SSR process (a different Node process than the browser) — gallery/share pages read the database via `lib/server/data.ts` directly, so `web/e2e/mock-backend.mjs` and `NEXT_PUBLIC_API_BASE_URL` in `playwright.config.ts` are unused (the gallery E2E stays `test.skip`). Seed a test database for E2E instead of mocking HTTP; see Known gaps.

### Mantine & React Server Components

- **`@mantine/core` v9's compound static properties don't resolve through the bundler** (`AppShell.Header`, `Card.Section`, etc. resolve to `undefined` at runtime under both Turbopack and Webpack, despite working via plain Node `require()`). Use the standalone named exports instead: `AppShellHeader`, `AppShellMain`, `CardSection`, etc.
- **Don't pass a component reference as a prop across the Server→Client boundary** (e.g. Mantine's `<Card component={Link} href=...>` from an async Server Component) — RSC serialization forbids it. Nest `<Link>` around the component instead.
- **Check `https://mantine.dev/llms.txt` before writing Mantine code or answering an API question.** Mantine's API has moved across versions (see the v9 compound-static-property gotcha above), so training data is not a reliable source for current usage.

### CI & repo tooling

- **Renaming or removing a CI job blocks every merge to `main` until branch protection is updated too.** `main`'s required status checks name jobs individually (currently `worker`, `web`, `infra`), and a required context that never reports leaves PRs permanently unmergeable — `enforce_admins` is on, so `--admin` doesn't override it either. The coupling is invisible from the repo: the rules live in GitHub Settings → Branches, not in `ci.yml`. Update both in the same change, and read the current list with `gh api repos/kamyy/ai-gaussian-splatter/branches/main/protection`.
- **Biome still doesn't format Markdown or YAML in this toolchain** (`@biomejs/biome@2.5.6` ignores `.md`/`.yml`). YAML stabilization is on Biome's 2026 roadmap; Markdown is seeking a community champion and isn't shipping. `.md` and `.yml`/`.yaml` (including `.github/workflows/ci.yml`) aren't auto-formatted — keep them consistent by hand/by eye. There is deliberately no maximum source line width for Markdown prose: GitHub's renderer (and any GitHub-styled preview, including the VS Code extension) reflows a paragraph to its container's width regardless of where the source line breaks fall, so a fixed character count buys nothing on the rendered side and only adds unnecessary diff noise on the source side. Write each paragraph and list item as one line.
- **Node version is pinned in root `.nvmrc` (`24.18.0`), and every Node-using CI job reads that same file via `setup-node`'s `node-version-file` input** (`lint-format`, `web`, `infra`) — instead of a separately hardcoded `node-version:`, so local dev and CI can't silently drift onto different majors. Run `nvm use` from repo root to match. Nothing in the repo executes `.ts` directly via Node (`web/`'s TS goes through Next.js/Vitest/Playwright's own transforms; root `scripts/*` are plain `.js`) — the pin is kept for Node 24 being the current Active LTS, supported through April 2028.

### Git workflow

- **`main` is push-protected — all changes land via PR.** Create a feature branch for any change, however small (docs, config, `.gitignore` included); a direct push to `main` is rejected.
- **Branch names are mandatorily prefixed with their change type** (`chore/`, `refactor/`, `rename/`, `docs/`, `fix/`, etc.), e.g. `chore/upgrade-next-16.3-typescript-7`, `refactor/prisma-to-drizzle`, `rename/dashboard-to-authenticated-route-group`. This applies to the branch name only — commit messages follow their own convention (e.g. Conventional Commits' `chore:`, `fix:`), which is a separate, unrelated style and not a substitute for the branch prefix.
- **Merge PRs with `gh pr merge --merge`, not `--squash` or `--rebase`.** Branch history here is kept as logically-scoped, individually-described commits (see e.g. the infra Python port PR), and `--merge` preserves that granularity in `main`'s history instead of collapsing it into one commit or dropping the "this is where the PR landed" marker.
- **To bring a stale PR branch up to date with `main`, `git rebase main` (then `push --force-with-lease`), not `git merge origin/main` into the branch.** A merge commit works too, but it adds noise to the branch's history that rebase avoids; CI needs to re-run on the rebased commits before merging.

### Worker (GPU pipeline)

- **No CUDA toolkit in typical dev sandboxes** (a GPU driver alone isn't enough — `gsplat`'s kernels need `nvcc` to JIT-compile). `worker/pipeline/train.py` has real, structurally-validated code but its actual training loop has not been run end-to-end on real hardware. Don't claim it's "working" without doing so on a real GPU box.

### Infra (CDK / AWS)

- **The ALB's ACM certificate must be issued in the ALB's own region (`us-west-2`), not `us-east-1`.** An ALB is regional and can only reference a certificate in its region; a `us-east-1` certificate for the same hostname cannot be attached to it. `us-east-1` is special only for CloudFront, which reads certificates from that region alone regardless of where its origin runs — there is no CloudFront here. `backend_stack.py` declares the certificate inline, which is what places it in the right region. Public ACM certificates are free, so the same hostname having a certificate in more than one region is normal and costs nothing. The listener's `ssl_policy` is also set explicitly (`RECOMMENDED_TLS`, i.e. TLS 1.2/1.3 only): leaving it unset does *not* inherit the strong default seen in the console — listeners created through the API or CloudFormation fall back to `ELBSecurityPolicy-2016-08`, which still negotiates TLS 1.0 and 1.1.
- **The Route 53 zone is imported with `from_hosted_zone_attributes`, never `from_lookup()`.** `from_lookup()` is a context lookup: it needs live credentials and caches account-specific data into the checked-in `cdk.context.json`, the same local-login-state dependence the `AWS_ACCOUNT_ID` handling below exists to avoid. The zone ID arrives as CDK context (`-c hostedZoneId=...`) with a placeholder default so `cdk synth` still works with no credentials. Importing also keeps the zone outside the stack's resource set, so no CloudFormation operation — `cdk destroy` included — can alter or delete the zone itself or any record the stack did not create. The only record in the template is the app's own A-alias, which a destroy removes; the certificate's DNS validation CNAME is added by ACM rather than by CloudFormation ("the `HostedZoneId` option ... causes ACM to add your CNAME to the domain record"), so it is not a template resource either way.
- **A security group attached to the ECS service is an ingress path in its own right.** The tasks run in private subnets with no public IP, and `backend_security_group`'s single ingress rule (from the ALB's security group, on `CONTAINER_PORT`) is what makes the ALB their only reachable route. Adding another rule to that group re-opens a path around the load balancer. `network_stack.py` owns both that group and the ALB's — deliberately, since creating the ALB's group in `BackendStack` instead makes the rule cross-stack and `cdk synth` fails with a `DependencyCycle` (`BackendStack` already depends on `NetworkStack`).
- **`CDK_DEFAULT_REGION` can't be used to control the deploy region via shell export.** The CDK CLI unconditionally overwrites it right before spawning `app.py`, using the AWS SDK's own default-region resolution — which falls back to `us-east-1` with no credentials configured, clobbering whatever you exported. `app.py` hardcodes the deploy region (`us-west-2`) directly for this reason. Account deliberately avoids `CDK_DEFAULT_ACCOUNT` too, for the inverse reason: whenever real AWS credentials _are_ active, the CLI resolves them via a live STS call and overwrites `CDK_DEFAULT_ACCOUNT` with that real account ID before spawning `app.py` — which would make `cdk synth`'s AZ-lookup cache writes to `cdk.context.json` depend on whoever's local login state happens to be active (real account IDs from a dev's SSO session have ended up as unwanted diffs to this checked-in file). `app.py` instead reads `AWS_ACCOUNT_ID`, a name the CDK CLI never touches, falling back to AWS's well-known placeholder account ID (`123456789012`) when unset — so `cdk synth` behaves identically regardless of local AWS login state, and only a deliberate `AWS_ACCOUNT_ID` (a GitHub Actions secret in CI, or an explicit export for a manual deploy) changes it. This is CDK-CLI-level behavior, not specific to the language `infra/` is written in. `cdk.context.json` caches the AZ lookups for both `us-west-2` (main stacks) and `us-east-1` (`BudgetsStack`, pinned there since billing metrics only publish in that region) against the placeholder account, so `cdk synth` works without live credentials or setup.

## Database

Postgres/Drizzle/RDS-specific gotchas, grouped by area. Written assuming no prior background in Postgres TLS or how RDS hands out credentials — the "Connecting to RDS in production" entries spell out the underlying mechanics rather than just the fix, since that's where this project actually lost time.

### Schema & migrations (Drizzle)

- **There is no codegen step, so a schema edit alone changes nothing on disk — but `drizzle-kit generate` must still be run.** The types update the instant you save `web/lib/server/db/schema.ts` (it's ordinary TypeScript), which is exactly the trap: `tsc` stays green while the schema and the actual database drift apart, and the failure only shows up as a runtime SQL error. Edit the schema → `pnpm db:generate` → review the emitted SQL in `web/drizzle/` → `pnpm db:migrate`. The `drizzle/meta/` JSON snapshots are checked in and are what `generate` diffs against; don't hand-edit them. The whole `web/drizzle/` tree is excluded from Biome in `biome.json`.
- **Column names are written out explicitly (`uuid("user_id")`), and drizzle's `casing: "snake_case"` option is deliberately unused.** That option would have to be set in *two* places — `drizzle.config.ts` for what `drizzle-kit generate` emits, and the runtime `drizzle()` call for what queries reference. Setting one and not the other produces a schema and a query layer that disagree silently. Note it governs *identifiers* only; it never touches enum values.
- **Enum values are snake_case in Postgres, TypeScript, and the JSON wire format alike.** Drizzle's `pgEnum` values *are* the database labels — there's no mapping layer that lets the TypeScript spelling diverge from the Postgres one. The tuples live in `web/lib/types.ts` and `schema.ts` imports them, so the unions and the labels are one list. The worker already emits these exact strings from `run_job.py` (status.py just POSTs whatever it's given), so the callback route needs no translation table.

### Query patterns

- **Path params must be UUID-checked before they reach the database.** The id columns are `uuid`, so `/api/v1/gallery/abc` makes Postgres raise `22P02`, which surfaces as a 500. Use `requireUuid()` (routes) or `isUuid()` (`lib/server/data.ts`, which returns null so pages can `notFound()`).
- **A missing row is `undefined`, not `null`.** Queries return arrays, so the idiom is `const [row] = await getDb().select()…limit(1)` and then `if (row === undefined)`. A leftover `=== null` check compiles fine and is always false — the row is silently treated as found.
- **`onConflictDoNothing()` returns zero rows from `.returning()`.** That's why `getOrCreateUser` uses `onConflictDoUpdate` with a no-op `set: { clerkUserId }`: on a conflict the update has to touch something for Postgres to hand the row back, otherwise an existing user comes back `undefined`.
- **The `set` clause of an upsert must reference the column, not a JS value.** The rate-limit counters use ``set: { count: sql`${rateLimitCounters.count} + 1` }`` so Postgres computes the increment; a plain `{ count: n + 1 }` bakes in a number read before the statement ran and reopens the read-then-write race the single-statement upsert exists to close. Verify what the database actually received rather than what the ORM appears to say — `ALTER SYSTEM SET log_statement='all'` plus `podman logs` shows the real SQL, and `drizzle(pool, { logger: true })` is the lighter-weight version.
- **`.$onUpdate(() => new Date())` is what keeps `updatedAt` moving** — there is no database trigger. It fires on drizzle `.update()` calls only, so a raw `sql` UPDATE bypasses it and freezes the column.

### Local dev & tests

- **DB-backed tests must `await closeDb()` in `afterAll`** or Vitest hangs after the last assertion: an open `pg` Pool keeps the event loop alive. `test/server-global-setup.ts` has its own separate pool for the migration and closes it in a `finally`.
- **Postgres may not be available in a dev sandbox** — try `podman run postgres:18` before assuming it isn't. `web/lib/server/rateLimit.test.ts` and the DB-backed auth tests skip unless `TEST_DATABASE_URL` is set (CI wires a service container; see `.github/workflows/ci.yml`).

### Connecting to RDS in production

#### Why the app assembles its own connection string

RDS generates its credentials into a Secrets Manager secret whose value is a JSON blob (`username`/`password` keys). ECS can inject a secret into a container's environment, but only one field of the JSON at a time (via a `secretArn:jsonKey::` reference) — there's no ECS feature that formats a `postgresql://...` URL out of a JSON secret. So `backend_stack.py` projects `DATABASE_USER`/`DATABASE_PASSWORD` out of the secret, passes `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_NAME` as plain env vars from the RDS construct, and `web/lib/server/databaseUrl.ts` reassembles all five into one connection string at runtime — percent-encoding the username and password first, since nothing rules out an RDS-generated password containing `:` `?` `#` `%`, any of which would otherwise corrupt the URL.

`resolveDatabaseUrl()` uses this same assembly everywhere, not just production: local dev, CI, and `drizzle-kit` set the same five parts rather than a single `DATABASE_URL`, so there's one code path to keep working, not two. Both halves are pinned by tests: `infra/tests/test_backend_stack.py` (the CDK secret projection) and `web/lib/server/databaseUrl.test.ts` (the TS assembly + percent-encoding).

#### Getting TLS actually verified against RDS

RDS Postgres requires TLS, and getting a Node client to properly validate it took three separate, layered fixes — worth reading in full rather than skimming, since each fix's error message is what leads to the next layer:

1. **No TLS setting at all fails outright.** RDS for PostgreSQL 15+ ships with `rds.force_ssl = 1`, so it rejects any unencrypted connection, while `pg` defaults to no TLS. A bare assembled URL with no `ssl` option gets refused with an error like `no pg_hba.conf entry ... no encryption`. `/api/v1/healthz` won't catch this ahead of time — it never touches the database, so ECS reports the task healthy while every real query 500s.
2. **`?sslmode=require` does something different than Postgres docs suggest.** In libpq (what most Postgres docs, and `psql`, are written around), `sslmode=require` means "encrypt, but don't bother checking the server's certificate" — it stops a passive eavesdropper but not a machine-in-the-middle. Node's driver doesn't carry over that leniency: its URL parser (`pg-connection-string`) treats `require` as an alias for the strictest mode, `verify-full` (`rejectUnauthorized: true`). So `?sslmode=require` trades the connection-refused error for `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, since RDS's certificate chains to Amazon's own root CA, which isn't in Node's built-in trust store.
3. **The fix supplies the missing CA certificate rather than weakening verification.** The tempting shortcut, `rejectUnauthorized: false`, would silently accept any certificate, including a forged one — defeating the point of TLS. Instead, `web/Dockerfile` downloads Amazon's public RDS CA bundle at image-build time, `backend_stack.py` points `DATABASE_SSL_CA` at it in the running task, and `web/lib/server/databaseUrl.ts` passes `ssl: { ca: <bundle contents> }` to `pg`. `rejectUnauthorized` is left unset so it stays at Node's default `true` — verification stays on, with the right CA supplied.

All five `sslmode` variants (`disable`, `require`, `prefer`, `verify-ca`, `verify-full`) were checked empirically against a real TLS-only Postgres instance using a private CA — confirmed by observation, not derived from the `sslmode` docs, which describe libpq's behavior and don't transfer to this driver.

## Testing

```bash
(cd web && pnpm typecheck && pnpm biome:ci && pnpm test && pnpm test:e2e)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && pnpm synth)
```

`web/`'s Postgres-dependent tests skip unless `TEST_DATABASE_URL` is set — pass it to actually run them (see `docs/RUNBOOK.md`).

Run the relevant subset after any change — all of the above pass cleanly as of this writing. Real bugs were caught this way repeatedly during initial scaffolding (see `docs/ARCHITECTURE.md`'s testing section and git history) — don't skip validation because something "looks right."

Note: `pnpm biome:ci` above validates the same thing CI checks, but not from inside CI's `web` job — it's a separate root-scoped `lint-format` job (its own `pnpm biome:ci`, run from repo root, covering `scripts/*.js` too, not just `web/`). The `web` job itself only runs `next typegen`/`tsc`/`drizzle-kit migrate`/`vitest`/`next build`/`playwright`.

## State / what's next

Repo scaffolding (all 3 packages + CI) is done and validated per above. The API layer was verified against a real Postgres 18: migrations, all 12 Route Handlers, the worker status callback, and rate-limit atomicity under concurrency — both single-statement upserts confirmed at the database level with `log_statement='all'` rather than inferred from the ORM. The container image was then built with podman (~213 MB) and run against that same Postgres: healthz, the gallery and public-share endpoints, the worker status callback (including the job/splat transaction and the set-once stage timestamps), the malformed-UUID guard, and SSR pages with `generateMetadata`'s Open Graph tags all served correctly.

Note if you try to reproduce that outside a container: some sandboxes block the loopback connection Next's proxy makes back to the server process, which makes a host-run `next dev`/`next start` 500 on every request with `ECONNREFUSED ::1`. It is an environment limitation, not an app bug — the container has its own network namespace and is unaffected.

Known gaps, in priority order:

1. **`web/e2e/mock-backend.mjs` is stale** — the pages it covers query the database directly, so it serves data nothing requests, and `playwright.config.ts` still sets the unused `NEXT_PUBLIC_API_BASE_URL`. Its one test is skipped; redesign around a seeded test database before trusting E2E coverage.
2. **`web/Dockerfile` builds and runs, but has never run on AWS.** Validated locally under podman (see above). What remains unproven is everything outside the image: the ECS task definition wiring and image pull from ECR.
3. **`hostedZoneId` must be passed on every real deploy** (`-c hostedZoneId=...`, the `orky.net` zone). It defaults to a placeholder so `cdk synth` works with no credentials, and a deploy carrying that placeholder fails.

Per the plan's build order, **M0 is still next**: a real physical object needs to be photographed (~50 photos, multi-angle) so the COLMAP→gsplat pipeline can be validated end-to-end on real hardware before anything else is trusted. That step needs the user, not an agent.
