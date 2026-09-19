# Architecture

Why the system is shaped this way: decisions, alternatives rejected, costs accepted. [`AGENTS.md`](AGENTS.md) is what breaks if you don't know it; [`RUNBOOK.md`](RUNBOOK.md) is how to run it. Each fact lives in exactly one of the three.

## Monorepo tooling

- **pnpm**, not npm or yarn, for `web/` and the root scripts. `infra/` needs no Node tooling at all: Terraform ships as a standalone CLI binary, installed directly rather than through a package manager.
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
- Fallback if a worker dies without reporting: `web/lib/server/ec2Launcher.ts` schedules `shutdown -h +WORKER_MAX_LIFETIME_MINUTES` as the first thing user-data does, before the failure-prone steps (ECR login, `docker run`) that could otherwise leave `worker/pipeline/instance.py`'s own self-terminate unreached. `InstanceInitiatedShutdownBehavior = "terminate"` on the launch makes that shutdown actually terminate the instance rather than just stop it. If scheduling that shutdown fails, user-data powers the instance off immediately rather than run the job without a ceiling. Losing one job costs less than a GPU instance billing with no bound. A CloudWatch runtime alarm was considered instead (or in addition) for alerting when this fires, but nothing in the request path needs to *know* a job hung, only to stop it from billing — so the ceiling alone was built; alerting is [gap 5](AGENTS.md#state--whats-next).
- No SQS, Batch, or always-on fleet — job volume is bounded by the global daily job cap instead.
- A queue is only worth the added complexity at higher, decoupled-fleet scale.

Job wall clock splits into three parts:

- **Fixed overhead**: pulling and extracting the ~19 GB worker image, then gsplat's `nvcc` kernel build. `docker run --rm` repeats that build on every job.
- **COLMAP**: a few minutes, CPU-bound by `mapper`'s incremental bundle adjustment.
- **Training**: the majority of wall clock.

M10's baked AMI therefore attacks the smaller half — fixed overhead, not training. Training cost is set by the resolution the photos are rasterized at (`MAX_TRAINING_EDGE` in `worker/pipeline/train.py`), not by boot latency. All of this is read off the code rather than observed; M0/M5 is the first run that will produce real numbers.

- Not Lambda or Fargate: neither offers GPU.
- Not hand-rolled ECS orchestration: bin-packing shared instances doesn't fit a one-job-one-instance model.

## API design

- REST (`web/app/api/v1/`), not GraphQL. 12 flat endpoints don't need GraphQL's query flexibility.
- Postgres (RDS) for `users`, `splats`, `photos`, `jobs`, and rate-limit/job counters. Relational, low traffic, and needs atomic `INSERT ... ON CONFLICT`.
- Auth: Clerk (`@clerk/nextjs`). Simple and easy to integrate — this app doesn't need enterprise features (SSO, SCIM, custom identity federation).
- API and pages share one Next.js app.
  - SSR is needed anyway for Open Graph (`generateMetadata`) and server-side share-page reads, so a long-running Node process already exists.
  - Putting the API in that same process means one deploy and one TypeScript codebase, with no separate API service whose request/response shapes need to be kept in sync by hand.

## Frontend

- Next.js App Router: Open Graph needs server `generateMetadata`, since crawlers don't run JS.
- UI: **MUI** over Mantine. Mantine's `ColorSchemeScript`/`MantineProvider` setup produced SSR hydration mismatches under the App Router; `@mui/material-nextjs`'s `AppRouterCacheProvider` is a mature, documented fix for emotion's SSR style-injection-order problem, the exact failure mode Mantine hit. Trade-off accepted: MUI's default styling engine is emotion, a CSS-in-JS runtime, unlike Mantine's static CSS Modules — a small bundle/runtime cost accepted in exchange for hydration correctness.
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

- TLS is required only where RDS enforces it (`rds.force_ssl = 1`), not by `web/lib/server/databaseUrl.ts`.
- `databaseSsl()`/`resolveDatabaseUrl()` (`web/lib/server/databaseUrl.ts`) make TLS conditional on `DATABASE_SSL_CA` being set.
- Local dev and CI run a plain, un-TLS'd Postgres.
- CI's Postgres starts as a plain `podman run` step (`.github/workflows/ci.yml`'s `web` job), not GitHub Actions' declarative `services:` block. The migrator-image test ([CI/CD](#cicd), below) needs to reach it by container name from a sibling podman container, and a Docker-managed `services:` container isn't reachable that way.
- It runs on a dedicated podman network, not `--network host`. Host networking doesn't reliably provide true loopback under rootless podman here — verified directly against this runner setup.

### Master password refresh

RDS's `manage_master_user_password` rotates its Secrets Manager secret every 7 days by default. A value ECS injects once as an env var at task start goes stale for the web service, which stays up for weeks: Postgres doesn't re-authenticate already-open connections, but rejects new ones with the old password, so this would show up as growing, intermittent connection failures rather than a clean cutover.

Two fixes were considered:

- **Scheduled forced redeployment**: an EventBridge Scheduler rule calling `ecs:UpdateService(forceNewDeployment)` on a cadence under 7 days, via a direct "universal target" API call with no Lambda needed. Fully infra-only and cheap, but adds a routine rolling restart as a permanent fixture of the architecture, and only patches the symptom — the app still never verifies it's holding a current password between restarts.
- **Fetch the password at connect time** (chosen): the web service re-fetches the current password from Secrets Manager on every new `pg` connection instead of trusting a cached value, so it's never more than a few minutes stale regardless of when RDS rotates. This is also what Secrets Manager rotation is designed around — the alternative treats an env var as a cache of something meant to be read live.

The migration task (`web/scripts/db-migrate.cjs`) keeps the old static-env-var behavior: it runs for seconds and exits, well inside the 7-day window, so there's nothing for it to go stale against, and changing it would need its own Secrets Manager IAM grant for no benefit.

## Infra

- Infra: **Terraform**. One configuration (`infra/`) holding one state. The S3 bucket that state lives in is created by hand ([Creating account prerequisites](RUNBOOK.md#creating-account-prerequisites)). `terraform init` needs the bucket before any apply. Managing it inside `infra/` would store state in a bucket `infra/` also owns. A second Terraform module with its own local state was rejected.
- Six logical areas, one per `.tf` file rather than one per CloudFormation-style stack — a single state resolves the dependencies between them directly, so there's no cross-stack export/import to keep in sync:
  - **network** — VPC, subnets, security groups.
  - **data** — RDS, S3.
  - **registry** — ECR alone, so the image can push before the service exists.
  - **worker_iam** — IAM for the GPU worker instances.
  - **web** — ALB + Fargate.
  - **budgets** — a second, `us-east-1`-aliased provider, since the Budgets API only operates there.
- `infra/tests/*.tftest.hcl` (native `terraform test`, `mock_provider "aws" {}`) replaces hand-written assertions against synthesized templates with the same offline, zero-credential guarantee, run by `.github/workflows/ci.yml`'s `infra` job on every PR.

## Hosting

The web app runs on **Fargate** behind an **Application Load Balancer** (`infra/web.tf`: `aws_lb`, `aws_ecs_service`). Tasks use the `FARGATE_SPOT` capacity provider (~70% cheaper than on-demand).

### Spot tradeoffs

- AWS can reclaim a task at any time. With one task running, the site is down until a replacement passes health checks.
- Spot capacity can also be unavailable, which blocks new placements.
- Setting an on-demand `base` would avoid that, but a single-task service would then run entirely on-demand and lose the discount.
- `min_healthy_percent=100` only applies during deployments, not to Spot reclaim.
- The service auto-scales on CPU between 1 and 3 tasks.

### Networking

- Tasks share public subnets with the ALB and have a public IP, for EC2 API egress via the IGW. S3 calls instead go through a gateway VPC endpoint (free, no IGW hop).
- No NAT: it costs ~$33/mo + $0.045/GB, and a multi-GB worker ECR pull would cost more per job than the spot instance itself.
- Tradeoff: `web_security_group`'s single ingress rule, from `alb_security_group` on `CONTAINER_PORT`, is the only network control between the tasks and the internet.
- RDS sits in a private subnet whose route table carries no default route out: it has no outbound need.
- That route table is a resource in its own right, not inferred from the subnet — an explicit table with no `0.0.0.0/0` route is the only thing that actually blocks outbound traffic; nothing about a subnet being "private" does that on its own.
- Both security groups live in `infra/network.tf`. A single Terraform state has no cross-stack boundary for declaring the ALB group elsewhere to trip over.

### TLS & DNS

- TLS terminates at the ALB (ACM cert for `local.app_hostname`, the project name under `var.domain_zone_name`; 80→443).
- The cert is declared in `infra/web.tf` so it lands in the ALB's region — ALBs can't use out-of-region certs.
- For ACM specifically, `us-east-1` only matters for CloudFront, which this app doesn't use — the cert stays in the ALB's own region. `us-east-1` does matter elsewhere in `infra/`, for an unrelated reason: the Budgets API (`infra/budgets.tf`) only operates there.
- Route 53 zone is referenced by ID only (`var.hosted_zone_id`), never looked up or created — `infra/` only ever adds records to an existing zone.
- The app's public origin is derived (`local.app_origin`), not passed in. Taking the hostname and the callback origin as two separate inputs let them drift apart, and a mismatch shows up only as the worker's status callbacks failing against a host that doesn't answer.

### Image tags

- The web and migrator images are tagged with the git tree id of `web/`, truncated to a fixed 12 characters (`scripts/lib/terraform.sh`'s `tf_get_web_image_tag`), in an ECR repository `infra/` owns (`infra/registry.tf`). The tag travels as a Terraform variable (`web_image_tag`).
- `web/` is the whole build context both images are built from, so the tag is a function of exactly their inputs. A push that leaves that tree untouched resolves to the tag already in ECR, so `.github/workflows/deploy.yml` builds nothing and leaves the service with no image change for either `terraform apply` to roll out.
- A fixed width rather than `git rev-parse --short`, whose length is the shortest prefix unique in the local object database. That varies between CI's shallow checkout and a full clone, and grows with the repository, so an abbreviated tag is not a function of the tree it names — and a tag that moves on its own rebuilds and rolls out code that did not change.
- That gating is the point. Measured over twelve commits on `main`, the commit SHA moved twelve times, `infra/`'s tree three times and `web/`'s once — so tagging by commit spent 22 of 24 image builds and 11 of 12 ECS rollouts on byte-identical application code, each rollout a real task replacement and a consumed rollback slot.
- A moving tag like `latest` would be simpler to push, but it leaves every release sharing one task definition. That disarms the deployment circuit breaker: rollback restarts the previous deployment against that same string, so Fargate re-pulls whatever was pushed most recently — the image that just failed.
- Per-build tags make each deploy its own task definition instead. The repository is also `IMMUTABLE`, so a pushed tag can never be repointed.
- Costs of this approach:
  - A variable is required on every `terraform apply`.
  - The tag names no commit. Map it back with `git log --format='%h' -- web`, then `git rev-parse <commit>:web | cut -c1-12` for each.
  - A build input outside `web/` reaches production only through a change under `web/`. That covers the `CLERK_PUBLISHABLE_KEY` repository variable, which `web/Dockerfile` bakes into the browser bundle, and a patched `node:24-alpine` base.
  - The rollback window is bounded by `RELEASES_KEPT`, not unlimited.
- Rejected alternative: **a path filter on `.github/workflows/ci.yml`'s `deploy` job**, skipping the deploy outright unless the push touched `web/` or `infra/`. It saves nothing on the common case, since `infra/` changes more often than `web/` here and an `infra/` change still has to deploy. Worse, any filter that skips a push also stops `infra/` converging, and converging `infra/` is how a new `WORKER_IMAGE_TAG` reaches the web task definition ([Building and pushing the worker image](RUNBOOK.md#building-and-pushing-the-worker-image)) — on a `worker/`-only push, exactly the push that carries a new worker image.

### Clerk secret

- The Clerk secret is referenced by its complete ARN (`var.clerk_secret_key_arn`), not created.
- A Terraform-created secret comes up holding a value `infra/` would have to generate and never actually use. ECS resolves secrets at task start, not on live update, so putting the real key in afterward would cost a second rollout on every fresh environment.
- Creating it would also claim the secret's name, making a hand-created secret collide as an out-of-band `ResourceExistsException` on the next apply.
- Complete ARN, not just the secret name, because ECS matches a task definition's `valueFrom` on the six-character suffix Secrets Manager assigns.
- Cost: a second required variable on every `terraform apply`, and a credential whose lifecycle nothing in `infra/` owns.

## Abuse protection

Three request-path layers (`web/lib/server/rateLimit.ts`). A per-user quota alone doesn't stop multi-accounting:

1. Per-IP (real multi-account defense), in `presign`.
   - **IP is the _last_ `X-Forwarded-For` hop.** ALB appends the address it saw; trusting the first lets clients spoof.
   - Assumes one trusted proxy. Adding CloudFront in front would move that.
2. Per-user, alongside it.
3. Global daily job cap, in `process` only — bounds worst-case GPU spend regardless of caller.

Ops fallback: an AWS Budget (`infra/budgets.tf`) for spend the request path never sees.

## CI/CD

- CI (`.github/workflows/deploy.yml`) applies `infra/` and migrates on every push to `main`, and builds a new web image only when `web/` changed, the first deploy into an empty account included ([Image tags](#image-tags)). It still rolls the service out whenever an apply changes the web task definition, which carries far more than the image. A human never applies `infra/` itself.
- Whether that job runs is a repository variable (`DEPLOY_ENABLED` on `.github/workflows/ci.yml`'s deploy job), not a committed `if:` in the workflow file. A committed flag makes going live and tearing down a workflow edit. The file would then differ between "the account exists" and "the account is gone" for a one-bit operational state. An unset variable is `""`. A fork or a torn-down account deploys nothing until someone sets it to `true` ([Going live](RUNBOOK.md#going-live)).
- `.github/workflows/ci.yml` records that variable in a trivial job at the start of each run on `main`. The deploy job's `if:` reads that copy, not live `vars` when the deploy job starts. A flip that lands after the recording cannot change what the run does, which narrows the window from the whole check suite to that one job's dispatch. `scripts/prod/set-deploy-enabled.sh` and `scripts/prod/terraform-destroy.sh` refuse while a run on `main` is unfinished, because a flip inside that remaining window still reaches it.
- Creating the state bucket and tearing down are done locally. CI can't `terraform init` against a bucket that doesn't exist yet. A teardown is too rare and too destructive to put behind a push.
- No manual approval gate: there's no live traffic yet to protect, and this is the first real deploy (M9).
- GPU worker deployment stays manual ([State / what's next](AGENTS.md#state--whats-next), gap 5): no ECR pull permissions yet.

- Migrations run as a one-off Fargate task from a **separate `migrator` image** (`web/Dockerfile`). Not bundled into the `web` runtime image, and not run at container boot.
- Two reasons:
  - The service runs up to 3 tasks with no advisory lock between them, so boot-time migration would race.
  - The migration SQL plus the script that applies it have no reason to bloat the lean `web` standalone build that actually serves traffic.
- `migrator`'s `node_modules` is copied from a `deps-prod` stage — `deps` with `pnpm prune --prod` applied, plus its now-unreferenced pnpm store deleted — rather than from `deps` directly.
- That's because the migration script needs only `@next/env`, `drizzle-orm`, and `pg`, which are regular dependencies. It never needs the devDependencies (`typescript`, `drizzle-kit`, `vitest`, `@playwright/test`, ...) that `deps` carries for `builder`'s build.

## Migration ordering

Two separate images are in play here: the **migrator image** (runs the one-off migration task) and the **web image** (runs the service). Both are built from the same `web/` tree, but `terraform apply` tracks their tags independently — `migrate_image_tag` for the migrator image, `web_image_tag` for the web image.

The core ordering problem:

- A migration must finish before any task running the new **web image** starts serving traffic.
- But `ecs:RunTask` can only run an already-registered task-definition revision.
- And a single `terraform apply` that updates both the migrator image and the web image together gives Terraform no place to pause between them.

Solved by giving the migration task its own variable (`migrate_image_tag`, defaulting to `web_image_tag` so every existing manual invocation is unaffected), then calling `terraform apply` twice:

1. Apply with `migrate_image_tag` on the new tag but `web_image_tag` still on the old one. This registers the migration task against the new **migrator image** while the service stays pinned to its old **web image** — no diff on the service, so no rollout.
2. Only if the migration task exits 0, apply again with `web_image_tag` also updated to the new tag (now equal to `migrate_image_tag`). This second apply is what actually moves the service onto the new **web image**.

The migration task runs on every deploy, including one whose tag is unchanged. An unchanged tag says `web/drizzle/` is unchanged, not that the database matches it — the first apply can replace `aws_db_instance.main`, and a first deploy whose migration failed leaves the service already on the new tag with nothing applied. Re-applying migrations that already ran is a no-op, so running it unconditionally is cheaper than any test for whether it is needed.

Terraform stays the sole owner of "what's currently deployed" — nothing calls `aws ecs update-service` out of band.

The first deploy into an empty account skips this ordering. With no service in the Terraform state there is no older image to pin the service to, so the first apply creates it on the new image and the migration runs afterwards. Real routes 500 until the migration finishes. That costs nothing, because nothing was serving before.

Rejected alternative: **running migrations from a local machine through a bastion.** The RDS instance (`infra/data.tf`) sits in an isolated subnet with no NAT gateway and no security-group path for an ad hoc host, and no bastion exists in `infra/`. So there's no manual fallback: a bad migration is fixed the same way as any other bug, with a corrective migration through a normal PR (see [Fixing a bad migration](RUNBOOK.md#fixing-a-bad-migration)).

A rolled-back *service* deployment does not undo an already-applied migration. Rollback and "was the migration a good idea" are orthogonal once the migration has committed. This is why every migration has to follow the expand/contract discipline in [`AGENTS.md`](AGENTS.md), not an incidental style preference.

## CI authentication

- CI authenticates to AWS via **GitHub OIDC**, not static IAM access keys — no long-lived credential to leak or rotate.
- The identity token's `sub` claim scopes it specifically to `repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/main`, so PRs and forks can't assume the role.
- That role, `ai-gaussian-splatter-ci-deploy`, is created by hand once ([Creating the OIDC provider and CI role](RUNBOOK.md#creating-the-oidc-provider-and-ci-role)), not by `infra/`, because it's chicken-and-egg: CI can't apply the config that grants CI its own apply permission.
- Unlike a design that delegates through a separate bootstrap role, this role holds the AWS permissions `terraform apply` itself needs directly — ec2, ecr, rds, s3, iam, ecs, elasticloadbalancing, route53, acm, budgets, logs, secretsmanager — scoped by resource-name prefix where a service supports it. Same reasoning that already keeps the Clerk secret, the state bucket, and `AWSServiceRoleForEC2Spot` as hand-run, RUNBOOK-documented one-time setup rather than Terraform-managed resources: whoever can grant broad infrastructure permissions to a CI role is a step this repo keeps out of any automated apply.

## Testing

Three tiers (`.github/workflows/ci.yml`):

- **Unit/component** (every PR): `pytest` + `moto` for `worker/`; Vitest `client` (jsdom) and `server` (Node + real Postgres for rate limits).
- **E2E** (every PR): Playwright without live Clerk. No specs yet (SSR reads DB; `page.route()` can't intercept; no seed — see [State / what's next](AGENTS.md#state--whats-next)). Server correctness is the Vitest `server` project.
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
- **M8** — Share links, OG thumbnails.
- **M9** — IaC + first real deploy.
- **M10** — Packer-baked worker AMI; measure boot-latency improvement.
