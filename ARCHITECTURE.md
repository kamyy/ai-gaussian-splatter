# Architecture

Why the system is shaped this way: decisions, alternatives rejected, costs accepted. `AGENTS.md` is what breaks if you don't know it; `RUNBOOK.md` is how to run it — each fact lives in exactly one of the three.

## Pipeline

1. User uploads discrete multi-angle photos of one object (not a panorama — walk around it, individual stills). Quality tracks angular coverage and overlap between neighboring views rather than raw count; gaps surface as a low COLMAP registered ratio (next step). Capture procedure: `RUNBOOK.md`.
2. **COLMAP** (`worker/pipeline/sfm.py`): exhaustive matching → camera poses + sparse cloud. Accuracy over speed for a small object-centric set. `run_job.py` fails below 50% registered images — capture quality, not a pipeline bug.
3. **gsplat** (`worker/pipeline/train.py`): per-object 3DGS, default 10k iterations (`worker/pipeline/config.py`) vs the paper's 30k — single-object/plain-background scenes converge faster. Apache 2.0 (INRIA's original is non-commercial).
4. **Export** (`worker/pipeline/export.py`): viewer `.ply` plus a thumbnail from gsplat's own rasterizer (no extra dependency) for Open Graph.

The "AI" is per-object gradient descent through a differentiable rasterizer, not a pretrained inference model. COLMAP is classical CV (bundle adjustment), not ML.

## Compute

Each job: dedicated EC2 GPU **spot** instance (`web/lib/server/ec2Launcher.ts`; type from `WORKER_INSTANCE_TYPE`, default `g5.xlarge`), run worker container, self-terminate on success or failure. Intended fallback if a worker dies without reporting: instance-runtime CloudWatch alarm — not in `infra/` yet. No SQS, Batch, or always-on fleet; volume is bounded by the global daily job cap. A queue is only worth the complexity at higher, decoupled-fleet scale.

Job wall clock splits roughly into fixed overhead — pulling and extracting the ~19 GB worker image, then gsplat's `nvcc` kernel build, which `docker run --rm` repeats on every job — a few minutes of COLMAP where `mapper`'s incremental bundle adjustment is the CPU-bound part, and training, which is the majority. M10's baked AMI therefore attacks the smaller half: training cost is set by the resolution the photos are rasterized at (`AGENTS.md`), not by boot latency. All of that is read off the code rather than observed — M0/M5 is the first run that produces real numbers.

Not Lambda or Fargate (no GPU). Not hand-rolled ECS orchestration — bin-packing shared instances doesn't fit one-job-one-instance.

## API & data

REST (`web/app/api/v1/`), not GraphQL — 12 flat endpoints. Postgres (RDS) for `users`,`objects`,`photos`,`jobs`, rate-limit counters — relational, low traffic, atomic `INSERT ... ON CONFLICT`.

Auth: Clerk (`@clerk/nextjs`), not Cognito (clunkier setup) or Auth0.

API and pages share one Next.js app. SSR is needed for Open Graph (`generateMetadata`) and server gallery reads, so a long-running Node process exists anyway. Putting the API in that same process means one deploy and one TypeScript codebase — no separate API service to keep request/response shapes in sync by hand.

Response shapes are explicit column maps in `web/lib/server/selects.ts`, passed to `.select()` so excluded columns never appear in SQL (e.g. `callbackToken` stays out of job responses).

ORM: **Drizzle**, not Prisma. The query builder maps 1:1 to SQL, which rate-limit counters need — a single-statement `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`. Prisma's `upsert()` compiles to one statement only when its `update` clause is non-empty, silently degrading to SELECT-then-INSERT otherwise — a race the TypeScript doesn't show. Also no codegen step or query-engine binary. Cost: no `@@map` equivalent for enum members, so Postgres labels and TypeScript unions must match exactly (see status values below).

JSON field *names* are camelCase; status *values* are snake_case (`colmap_running`) because `pgEnum` values are both DB labels and TS members — one spelling end to end. The GPU worker callback accepts snake_case request fields (`error_message`, `result_s3_key`, …) and remaps them to camelCase for Drizzle; status *values* need no translation.

Hosting: the web app runs on **Fargate** behind an **Application Load Balancer** (`ApplicationLoadBalancedFargateService`). Tasks use the `FARGATE_SPOT` capacity provider (~70% cheaper than on-demand).

Spot tradeoffs: AWS can reclaim a task at any time — with one task running, the site is down until a replacement passes health checks. Spot capacity can also be unavailable, which blocks new placements. Setting an on-demand `base` would avoid that, but a single-task service would then run entirely on-demand and lose the discount. `min_healthy_percent=100` only applies during deployments, not to Spot reclaim. The service auto-scales on CPU between 1 and 3 tasks.

Tasks share public subnets with the ALB and have a public IP (S3/EC2 API egress via IGW). No NAT — ~$33/mo + $0.045/GB, and a multi-GB worker ECR pull would cost more per job than the spot instance. Tradeoff: `backend_security_group`'s single ingress from `alb_security_group` on `CONTAINER_PORT` is the only network control between the tasks and the internet.

RDS is `PRIVATE_ISOLATED` (no outbound need). Type must be explicit — `PRIVATE_WITH_EGRESS` + `nat_gateways=0` synthesizes "isolated in everything but name." Both security groups live in `network_stack.py`; declaring the ALB group in `BackendStack` makes the ingress rule cross-stack → `DependencyCycle`.

TLS terminates at the ALB (ACM cert for `ai-gaussian-splatter.orky.net`; 80→443). Cert is in `backend_stack.py` so it lands in the ALB's region — ALBs can't use out-of-region certs; `us-east-1` matters only for CloudFront (unused).

Route 53 zone is *imported* (`from_hosted_zone_attributes`, zone ID as CDK context) — not looked up (credentials + dirty `cdk.context.json`) or created (would put the zone in the stack's resource set). Deploy only adds records.

The web image is tagged per release with the commit SHA, in an ECR repository this app owns (`registry_stack.py`), and the tag travels as CDK context. A moving tag like `latest` would be simpler to push but leaves every release sharing one task definition, which disarms the deployment circuit breaker: rollback restarts the previous deployment against that same string, so Fargate re-pulls whatever was pushed most recently — the image that just failed. Per-release tags make each deploy its own task definition, and the repository is `IMMUTABLE` so a pushed tag can never be repointed. Costs: a context value on every `cdk` invocation, a rebuild of an already-pushed commit is rejected at push time, and the rollback window is bounded by `RELEASES_KEPT` rather than unlimited. Rejected `ContainerImage.from_asset`, which solves the same problem by having CDK build and publish into the bootstrap asset repository — it removes the registry stack and the push step entirely, but moves the images out of a repository the app stacks own.

The Clerk secret is imported the same way (`from_secret_complete_arn`, ARN as CDK context), not created. A stack-created secret comes up holding CloudFormation's generated random value, and ECS resolves secrets at task start rather than on live update — so the real key would cost a second rollout on every fresh environment. It would also claim the name, making a hand-created secret an out-of-band `ResourceExistsException` on the next deploy. Complete ARN rather than `from_secret_name_v2`'s partial one because ECS matches `valueFrom` on the six-character suffix. Cost: a second required context value on every `cdk` invocation, and a credential whose lifecycle no stack owns.

## Abuse protection

Three request-path layers (`web/lib/server/rateLimit.ts`) — a per-user quota alone doesn't stop multi-accounting:

1. Per-IP (real multi-account defense), in `presign`. **IP is the _last_ `X-Forwarded-For` hop** — ALB appends the address it saw; trusting the first lets clients spoof. Assumes one trusted proxy; CloudFront in front would move that.
2. Per-user, alongside it.
3. Global daily job cap, in `process` only — bounds worst-case GPU spend regardless of caller.

Ops fallback: AWS Budget + CloudWatch billing alarm (`budgets_stack.py`) for spend the request path never sees.

## Frontend

Next.js App Router — Open Graph needs server `generateMetadata` (crawlers don't run JS). UI: **Mantine** over MUI (native CSS Modules, no CSS-in-JS runtime). SWR for server-derived data (job polling via `refreshInterval`); Zustand for pure client UI (upload progress, banners). `@mkkellogg/gaussian-splats-3d` `DropInViewer` in r3f via `<primitive>` — drives itself with Three.js `onBeforeRender`.

## Infra

Infra: **AWS CDK (Python)** — shares `worker/`'s `uv`/`ruff`/`mypy` tooling. The CDK CLI is still npm-only, so `infra/` keeps a minimal `package.json`. Six stacks: network, data (RDS/S3), registry (ECR alone so the image can push before the service exists), worker-iam, backend (ALB + Fargate), budgets (us-east-1 — billing metrics only exist there).

## Testing

Three tiers (`.github/workflows/ci.yml`):

- **Unit/component** (every PR): `pytest` + `moto` for `worker/`; Vitest `client` (jsdom) and `server` (Node + real Postgres for rate limits).
- **E2E** (every PR): Playwright without live Clerk — gallery path. Spec is **skipped** (SSR reads DB; `page.route()` can't intercept; no seed). Server correctness is the Vitest `server` project.
- **Real-pipeline** (manual/milestone-gated): real COLMAP + gsplat costs GPU money. `FAST_TEST_MODE` (20 iterations) for cheap end-to-end smoke tests; `train.py` derives its densify/log schedules from the iteration count so the short run still exercises densification.

`web/` AWS tests use `aws-sdk-client-mock` (assert command args), not `moto`-style emulation.

## Build order

Milestones (`M0`…`M10`) name phases, not a schedule — web/infra largely exist while M0/M1 do not. Definitions here; status in `AGENTS.md`.

- **M0** — shoot one real object per `RUNBOOK.md`'s capture guidance; hand-run COLMAP → gsplat → export; view in a standalone page.
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
