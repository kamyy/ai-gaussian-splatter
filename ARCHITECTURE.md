# Architecture

Why the system is shaped this way: decisions, alternatives rejected, costs accepted. [`AGENTS.md`](AGENTS.md) is what breaks if you don't know it; [`RUNBOOK.md`](RUNBOOK.md) is how to run it. Each fact lives in exactly one of the three.

## Monorepo tooling

- **pnpm**, not npm or yarn, for both `web/` and `infra/`. `infra/` only needs it for the npm-distributed CDK CLI ([`AGENTS.md`](AGENTS.md)).
- Its content-addressable store keeps one copy of each package version on disk. Every project that needs a package gets it hard-linked in, rather than duplicating it per `node_modules`.
- Its `node_modules` layout also only exposes packages a project actually lists in `package.json`. Code can't accidentally import an undeclared transitive dependency — the "phantom dependency" problem npm's and yarn's flat layout allows.

## Pipeline

1. User uploads discrete multi-angle photos of one object — not a panorama, individual stills taken while walking around it.
   - Quality tracks angular coverage and overlap between neighboring views, not raw photo count.
   - Gaps in coverage surface as a low COLMAP registered ratio (step 2, below).
   - [Capture](RUNBOOK.md#capture) procedure.
2. **COLMAP** (`worker/pipeline/sfm.py`): exhaustive matching → camera poses + sparse cloud.
   - Accuracy over speed, since the object-centric photo sets are small.
   - `worker/run_job.py` fails below 50% registered images. That reflects capture quality, not a pipeline bug.
3. **gsplat** (`worker/pipeline/train.py`): the actual training step. Per-object 3DGS, default 10k iterations (`worker/pipeline/config.py`) vs. the paper's 30k — each iteration is one gradient-descent step optimizing the Gaussians against the photos.
   - Single-object, plain-background scenes converge faster, so fewer iterations suffice.
   - Apache 2.0 (INRIA's original is non-commercial).
4. **Export** (`worker/pipeline/export.py`): viewer `.ply` plus a thumbnail from gsplat's own rasterizer, for Open Graph. Using gsplat's rasterizer avoids pulling in an extra dependency just for the thumbnail.

The "AI" here is per-object gradient descent through a differentiable rasterizer, not a pretrained inference model. COLMAP is classical CV (bundle adjustment), not ML.

## Compute

- Each job gets a dedicated EC2 GPU **spot** instance (`web/lib/server/ec2Launcher.ts`; type from `WORKER_INSTANCE_TYPE`, default `g5.xlarge`). It runs the worker container, then self-terminates on success or failure.
- Intended fallback if a worker dies without reporting: an instance-runtime CloudWatch alarm. Not built in `infra/` yet.
- No SQS, Batch, or always-on fleet — job volume is bounded by the global daily job cap instead.
- A queue is only worth the added complexity at higher, decoupled-fleet scale.

Job wall clock splits into three parts:

- **Fixed overhead**: pulling and extracting the ~19 GB worker image, then gsplat's `nvcc` kernel build. `docker run --rm` repeats that build on every job.
- **COLMAP**: a few minutes, CPU-bound by `mapper`'s incremental bundle adjustment.
- **Training**: the majority of wall clock.

M10's baked AMI therefore attacks the smaller half — fixed overhead, not training. Training cost is set by the resolution the photos are rasterized at ([State / what's next](AGENTS.md#state--whats-next), gap 3), not by boot latency. All of this is read off the code rather than observed; M0/M5 is the first run that will produce real numbers.

- Not Lambda or Fargate: neither offers GPU.
- Not hand-rolled ECS orchestration: bin-packing shared instances doesn't fit a one-job-one-instance model.

## API design

- REST (`web/app/api/v1/`), not GraphQL. 12 flat endpoints don't need GraphQL's query flexibility.
- Postgres (RDS) for `users`, `splats`, `photos`, `jobs`, `gallery_items`, and rate-limit/job counters. Relational, low traffic, and needs atomic `INSERT ... ON CONFLICT`.
- Auth: Clerk (`@clerk/nextjs`). Simple and easy to integrate — this app doesn't need enterprise features (SSO, SCIM, custom identity federation).
- API and pages share one Next.js app.
  - SSR is needed anyway for Open Graph (`generateMetadata`) and server gallery reads, so a long-running Node process already exists.
  - Putting the API in that same process means one deploy and one TypeScript codebase, with no separate API service whose request/response shapes need to be kept in sync by hand.

## Frontend

- Next.js App Router: Open Graph needs server `generateMetadata`, since crawlers don't run JS.
- UI: **Mantine** over MUI. Native CSS Modules, no CSS-in-JS runtime. Chosen for its small bundle size and for being unopinionated.
- SWR for server-derived data (job polling via `refreshInterval`).
- Zustand, not Redux, for pure client UI (upload progress, banners). Zustand needs less boilerplate.
- `@mkkellogg/gaussian-splats-3d`'s `DropInViewer` runs in r3f via `<primitive>`. It drives itself with Three.js's `onBeforeRender`.

## Schema & ORM

- Response shapes are explicit column maps in `web/lib/server/selects.ts`, passed to `.select()` so excluded columns never appear in SQL (e.g. `callbackToken` stays out of job responses).
- ORM: **Drizzle**, not Prisma.
  - Drizzle's query builder maps 1:1 to SQL. Rate-limit counters need that: a single-statement `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`.
  - Prisma's `upsert()` can race unless its `update` clause is non-empty.
  - Drizzle also needs no codegen step or query-engine binary.
  - Cons: there's no `@@map` equivalent for enum members, so Postgres labels and TypeScript unions must match exactly (see status values, below).
- JSON field *names* are camelCase. Status *values* are snake_case (`colmap_running`), because `pgEnum` values are both the DB labels and the TS members — one spelling end to end.
- The GPU worker callback accepts snake_case request fields (`error_message`, `result_s3_key`, …) and remaps them to camelCase for Drizzle. Status *values* need no translation, since they're already the shared spelling.

## Postgres connectivity & TLS

- TLS is required only where RDS enforces it (`rds.force_ssl = 1`), not by this app's own client code.
- `databaseSsl()`/`resolveDatabaseUrl()` (`web/lib/server/databaseUrl.ts`) make TLS conditional on `DATABASE_SSL_CA` being set.
- Local dev and CI run a plain, un-TLS'd Postgres.
- CI's Postgres starts as a plain `podman run` step (`.github/workflows/ci.yml`'s `web` job), not GitHub Actions' declarative `services:` block. The migrator-image test ([CI/CD](#cicd), below) needs to reach it by container name from a sibling podman container, and a Docker-managed `services:` container isn't reachable that way.
- It runs on a dedicated podman network, not `--network host`. Host networking doesn't reliably provide true loopback under rootless podman here — verified directly against this runner setup.

## Infra

- Infra: **AWS CDK (Python)**. Shares `worker/`'s `uv`/`ruff`/`mypy` tooling.
- The CDK CLI is still npm-only, so `infra/` keeps a minimal `package.json`.
- Six stacks:
  - **network** — VPC, subnets, security groups.
  - **data** — RDS, S3.
  - **registry** — ECR alone, so the image can push before the service exists.
  - **worker-iam** — IAM for the GPU worker instances.
  - **web** — ALB + Fargate.
  - **budgets** — `us-east-1`, since billing metrics only exist there.

## Hosting

The web app runs on **Fargate** behind an **Application Load Balancer** (`ApplicationLoadBalancedFargateService`). Tasks use the `FARGATE_SPOT` capacity provider (~70% cheaper than on-demand).

### Spot tradeoffs

- AWS can reclaim a task at any time. With one task running, the site is down until a replacement passes health checks.
- Spot capacity can also be unavailable, which blocks new placements.
- Setting an on-demand `base` would avoid that, but a single-task service would then run entirely on-demand and lose the discount.
- `min_healthy_percent=100` only applies during deployments, not to Spot reclaim.
- The service auto-scales on CPU between 1 and 3 tasks.

### Networking

- Tasks share public subnets with the ALB and have a public IP, for S3/EC2 API egress via the IGW.
- No NAT: it costs ~$33/mo + $0.045/GB, and a multi-GB worker ECR pull would cost more per job than the spot instance itself.
- Tradeoff: `web_security_group`'s single ingress rule, from `alb_security_group` on `CONTAINER_PORT`, is the only network control between the tasks and the internet.
- RDS is `PRIVATE_ISOLATED`: it has no outbound need.
- The subnet type must be explicit — `PRIVATE_WITH_EGRESS` + `nat_gateways=0` synthesizes "isolated in everything but name," which isn't the same declaration.
- Both security groups live in `infra/stacks/network_stack.py`. Declaring the ALB group in `WebStack` instead would make the ingress rule cross-stack and trigger a `DependencyCycle`.

### TLS & DNS

- TLS terminates at the ALB (ACM cert for `ai-gaussian-splatter.orky.net`; 80→443).
- The cert is declared in `infra/stacks/web_stack.py` so it lands in the ALB's region — ALBs can't use out-of-region certs.
- `us-east-1` only matters for CloudFront, which this app doesn't use.
- Route 53 zone is *imported* (`from_hosted_zone_attributes`, zone ID as CDK context).
- Not looked up: a lookup needs live credentials and writes account-specific data into `cdk.context.json`.
- Not created either: that would put the zone itself in the stack's resource set.
- Deploy only adds records to the existing zone.

### Image tags

- The web image is tagged per release with the commit SHA, in an ECR repository this app owns (`infra/stacks/registry_stack.py`). The tag travels as CDK context.
- A moving tag like `latest` would be simpler to push, but it leaves every release sharing one task definition. That disarms the deployment circuit breaker: rollback restarts the previous deployment against that same string, so Fargate re-pulls whatever was pushed most recently — the image that just failed.
- Per-release tags make each deploy its own task definition instead. The repository is also `IMMUTABLE`, so a pushed tag can never be repointed.
- Costs of this approach:
  - A context value is required on every `cdk` invocation.
  - Rebuilding an already-pushed commit is rejected at push time.
  - The rollback window is bounded by `RELEASES_KEPT`, not unlimited.
- Rejected: `ContainerImage.from_asset`, which solves the same problem by having CDK build and publish into the bootstrap asset repository. It removes the registry stack and the push step entirely, but it moves the images out of a repository the app stacks own.

### Clerk secret

- The Clerk secret is imported the same way (`from_secret_complete_arn`, ARN as CDK context), not created.
- A stack-created secret comes up holding CloudFormation's generated random value. ECS resolves secrets at task start, not on live update, so putting the real key in afterward would cost a second rollout on every fresh environment.
- Creating it would also claim the secret's name, making a hand-created secret collide as an out-of-band `ResourceExistsException` on the next deploy.
- Complete ARN, not `from_secret_name_v2`'s partial one, because ECS matches `valueFrom` on the six-character suffix.
- Cost: a second required context value on every `cdk` invocation, and a credential whose lifecycle no stack owns.

## Abuse protection

Three request-path layers (`web/lib/server/rateLimit.ts`). A per-user quota alone doesn't stop multi-accounting:

1. Per-IP (real multi-account defense), in `presign`.
   - **IP is the _last_ `X-Forwarded-For` hop.** ALB appends the address it saw; trusting the first lets clients spoof.
   - Assumes one trusted proxy. Adding CloudFront in front would move that.
2. Per-user, alongside it.
3. Global daily job cap, in `process` only — bounds worst-case GPU spend regardless of caller.

Ops fallback: AWS Budget + CloudWatch billing alarm (`infra/stacks/budgets_stack.py`) for spend the request path never sees.

## CI/CD

- CI (`.github/workflows/ci.yml`'s `deploy` job) builds, migrates, and rolls out the web service on every push to `main`.
- No manual approval gate: there's no live traffic yet to protect, and this is the first real deploy (M9).
- GPU worker deployment stays manual ([State / what's next](AGENTS.md#state--whats-next), gap 5): no ECR pull permissions yet.

- Migrations run as a one-off Fargate task from a **separate `migrator` image** (`web/Dockerfile`). Not bundled into the `web` runtime image, and not run at container boot.
- Two reasons:
  - The service runs up to 3 tasks with no advisory lock between them, so boot-time migration would race.
  - The migration SQL plus the script that applies it have no reason to bloat the lean `web` standalone build that actually serves traffic.
- `migrator`'s `node_modules` is copied from a `deps-prod` stage — `deps` with `pnpm prune --prod` applied, plus its now-unreferenced pnpm store deleted — rather than from `deps` directly.
- That's because the migration script needs only `@next/env`, `drizzle-orm`, and `pg`, which are regular dependencies. It never needs the devDependencies (`typescript`, `drizzle-kit`, `vitest`, `@playwright/test`, ...) that `deps` carries for `builder`'s build.

## Migration ordering

Two separate images are in play here: the **migrator image** (runs the one-off migration task) and the **web image** (runs the service). Both are built from the same commit, but `cdk deploy` tracks their tags independently — `migrateImageTag` for the migrator image, `webImageTag` for the web image.

The core ordering problem:

- A migration must finish before any task running the new **web image** starts serving traffic.
- But `ecs:RunTask` can only run an already-registered task-definition revision.
- And a single `cdk deploy` that updates both the migrator image and the web image together gives CloudFormation no place to pause between them.

Solved by giving the migration task its own CDK context flag (`migrateImageTag`, defaulting to `webImageTag` so every existing manual invocation is unaffected), then calling `cdk deploy` twice:

1. Deploy with `migrateImageTag` on the new commit's SHA but `webImageTag` still on the old one. This registers the migration task against the new **migrator image** while the service stays pinned to its old **web image** — no diff on the service, so no rollout.
2. Only if the migration task exits 0, deploy again with `webImageTag` also updated to the new SHA (now equal to `migrateImageTag`). This second deploy is what actually moves the service onto the new **web image**.

CDK stays the sole owner of "what's currently deployed" — nothing calls `aws ecs update-service` out of band.

Rejected alternatives:

- **A CloudFormation custom resource** (Lambda-backed) gating the service on migration success within one `cdk deploy`. Technically tighter — one deploy call, CloudFormation-native sequencing — but it trades a plain, linear GitHub Actions log, where every step is a visible `aws`/`cdk` command, for a Lambda whose failure mode is debugged through a different service's logs.
- **Running migrations from a human's laptop through a bastion.** `DataStack`'s RDS instance sits in an isolated subnet with no NAT gateway and no security-group path for an ad hoc host, and no bastion exists in this infra. So there's no manual fallback: a bad migration is fixed the same way as any other bug, with a corrective migration through a normal PR (see [Fixing a bad migration](RUNBOOK.md#fixing-a-bad-migration)).

A rolled-back *service* deployment does not undo an already-applied migration. Rollback and "was the migration a good idea" are orthogonal once the migration has committed. This is why every migration has to follow the expand/contract discipline in [`AGENTS.md`](AGENTS.md), not an incidental style preference.

## CI authentication

- CI authenticates to AWS via **GitHub OIDC**, not static IAM access keys — no long-lived credential to leak or rotate.
- The identity token's `sub` claim scopes it specifically to `repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/main`, so PRs and forks can't assume the role.
- That role, `ai-gaussian-splatter-ci-deploy`, is created by hand once ([Creating the OIDC provider and CI role](RUNBOOK.md#creating-the-oidc-provider-and-ci-role)), not by a CDK stack, for two reasons:
  - It's chicken-and-egg: CI can't deploy the stack that grants CI its own deploy permission.
  - It's account-wide and security-sensitive: it can `sts:AssumeRole` on CDK's bootstrap roles, whose `CloudFormationExecutionRole` carries near-admin permissions by default, not permissions scoped to this app's stacks. Same reasoning that already keeps the Clerk secret and `AWSServiceRoleForEC2Spot` as hand-run, RUNBOOK-documented one-time setup rather than stack-managed resources.
- `cdk deploy` itself runs under that role via `sts:AssumeRole` on CDK's own bootstrap roles (created by `cdk bootstrap`), rather than granting the CI role broad CloudFormation/IAM permissions directly.

## Testing

Three tiers (`.github/workflows/ci.yml`):

- **Unit/component** (every PR): `pytest` + `moto` for `worker/`; Vitest `client` (jsdom) and `server` (Node + real Postgres for rate limits).
- **E2E** (every PR): Playwright without live Clerk — gallery path. Spec is **skipped** (SSR reads DB; `page.route()` can't intercept; no seed). Server correctness is the Vitest `server` project.
- **Real-pipeline** (manual/milestone-gated): real COLMAP + gsplat costs GPU money. `FAST_TEST_MODE` (20 iterations) for cheap end-to-end smoke tests; `worker/pipeline/train.py` derives its densify/log schedules from the iteration count so the short run still exercises densification.

`web/` AWS tests use `aws-sdk-client-mock` (assert command args), not `moto`-style emulation.

## Build order

Milestones (`M0`…`M10`) name phases, not a schedule — web/infra largely exist while M0/M1 do not. Definitions here; status in [State / what's next](AGENTS.md#state--whats-next).

- **M0** — shoot one real object per [Capture](RUNBOOK.md#capture); hand-run COLMAP → gsplat → export; view in a standalone page.
- **M1** — Same run via scripted `worker/pipeline/` modules.
- **M2** — Schema + CRUD endpoints.
- **M3** — S3 presign/complete against a real bucket.
- **M4** — Local end-to-end: upload → process → result (no cloud orchestration).
- **M5** — EC2 spot launch, worker image, status callback, self-termination (success + induced failure).
- **M6** — Auth + three rate-limit layers.
- **M7** — Authenticated UI: upload, job polling, splat viewer.
- **M8** — Public gallery, share links, OG thumbnails.
- **M9** — IaC + first real deploy.
- **M10** — Packer-baked worker AMI; measure boot-latency improvement.
