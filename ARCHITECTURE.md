# Architecture

Why the system is shaped this way: the decisions, the alternatives rejected, and the costs accepted. `AGENTS.md` covers what breaks if you don't know it, and `RUNBOOK.md` covers how to run and operate it — each fact lives in exactly one of the three.

## Pipeline

1. User uploads discrete multi-angle photos of one object (not a panorama sweep — walk around it, individual stills).
2. **COLMAP** (`worker/pipeline/sfm.py`): exhaustive feature matching → camera poses + sparse point cloud. Favors accuracy over speed for a small object-centric photo set. `run_job.py` fails the job when the registered-image ratio falls below 50% — that's a capture-quality problem, not a pipeline bug.
3. **gsplat** (`worker/pipeline/train.py`): per-object 3D Gaussian Splatting training, 10k iterations by default (`worker/pipeline/config.py`), against the paper's 30k — single-object-against-plain-background scenes converge faster. Apache 2.0 licensed, unlike the original INRIA repo's non-commercial license.
4. **Export** (`worker/pipeline/export.py`): writes the trained scene as a viewer-compatible `.ply`, plus a thumbnail rendered via gsplat's own rasterizer (reused, not a new dependency) for Open Graph previews.

The "AI" here is the training itself — a from-scratch per-object gradient-descent optimization through a differentiable rasterizer, not a pretrained inference model. COLMAP is classical computer vision (bundle adjustment), not ML.

## Compute

Each job launches a dedicated AWS EC2 GPU **spot** instance (`web/lib/server/ec2Launcher.ts` — type from `WORKER_INSTANCE_TYPE`, defaulting to `g5.xlarge` in `lib/server/env.ts`), runs the worker container, and self-terminates on both success and failure. An instance-runtime CloudWatch alarm is the intended backstop for a worker that dies without reporting; it is not in `infra/` yet. No SQS queue, no Batch, no always-on fleet — volume is bounded by the global daily job cap, and a queue only earns its complexity at higher, decoupled-worker-fleet scale (documented future enhancement).

Not Lambda: zero GPU support, hard architectural limit. Not Fargate: also no GPU. Not hand-rolled ECS orchestration: its value (bin-packing many tasks on shared instances) doesn't apply to a one-job-one-dedicated-instance pattern.

## API & data

REST (`web/app/api/v1/`), not GraphQL — the API is 12 flat endpoints, REST's ideal case. Postgres (RDS) for `users`/`objects`/`photos`/`jobs`/rate-limit counters — genuinely relational, low traffic, atomic upserts via `INSERT ... ON CONFLICT`.

Auth: Clerk (`@clerk/nextjs`), not Cognito (clunkier setup) or Auth0.

The API lives in the same Next.js app as the pages, not a separate service. SSR is load-bearing here (`generateMetadata` for Open Graph, server-side gallery reads), so a long-running Node process has to exist regardless — putting the API in it means one deployable instead of two, and one TypeScript program, so there is no cross-service contract to hand-sync.

The tradeoff is losing a framework that derives OpenAPI docs and response schemas for you. Response field sets are explicit column maps in `web/lib/server/selects.ts`, passed to `.select()` — the excluded columns never appear in the SQL at all, which is what keeps `callbackToken` out of a job response.

ORM is **Drizzle** (`drizzle-orm` over `node-postgres`), not Prisma. The deciding factor: its query builder maps one-to-one onto the SQL Postgres runs, which is load-bearing for the rate-limit counters — they need `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count` in a single statement to stay race-free, written explicitly as `.onConflictDoUpdate({ target, set })`. Prisma's `upsert()` only compiles to one statement when its `update` clause is non-empty, silently degrading to `SELECT`-then-`INSERT` otherwise — a cliff invisible in the TypeScript. Secondary benefits: no codegen step and no query-engine binary.

The cost is that Drizzle has no equivalent of Prisma's `@@map` for enum members, so Postgres's enum labels and the TypeScript union members must be the exact same spelling — see the wire format (JSON) note below.

Wire format (the API's JSON request/response shape) is camelCase for field names. Status *values* are snake_case (`colmap_running`, not `ColmapRunning`), because a `pgEnum`'s values are simultaneously the Postgres labels and the TypeScript union members. The database keeps SQL-idiomatic labels and everything downstream inherits them, so there is one spelling end to end and no translation layer to keep correct. This also aligns the worker: `PATCH /api/v1/internal/jobs/{id}/status` parses snake_case field names because `worker/pipeline/status.py` sends that shape, and its status values need no mapping either.

Hosting is **Fargate behind an Application Load Balancer** (`ecs_patterns.ApplicationLoadBalancedFargateService`), on the `FARGATE_SPOT` capacity provider — ~70% off on-demand, in exchange for a reclaim taking the single task down until a replacement passes health checks, and for Spot capacity shortages being able to block placement entirely. `min_healthy_percent=100` does not help with either; it governs deployments only. An on-demand `base` would remove the exposure but also the discount, since a single-task service would then be entirely on-demand. Auto-scaling is CPU-based, 1 to 3 tasks.

The tasks share the public subnets with the ALB and carry a public IP, so their calls to S3 and the EC2 API egress through the internet gateway. There is no NAT gateway anywhere in the VPC: one costs ~$33/month plus $0.045/GB, and the GPU worker's multi-GB ECR pull alone would be billed more per job than its spot instance costs. The price is that `backend_security_group`, whose only ingress rule names `alb_security_group` as its source, is the entire barrier between the tasks and the internet — there is no second layer behind it.

RDS alone keeps the stronger placement, in `PRIVATE_ISOLATED` subnets: it makes no outbound calls, so it gives up nothing by having no route in either direction. The type is stated explicitly because CDK does not infer it — `PRIVATE_WITH_EGRESS` alongside `nat_gateways=0` synthesizes without complaint into subnets that are isolated in everything but name. `network_stack.py` owns both security groups rather than letting `BackendStack` declare the ALB's: that would make the ingress rule cross-stack, and `cdk synth` fails with a `DependencyCycle` since `BackendStack` already depends on `NetworkStack`.

TLS terminates at the ALB using an ACM certificate for `ai-gaussian-splatter.orky.net`, with port 80 redirected to 443. The certificate is declared in `backend_stack.py` so it lands in the ALB's own region — an ALB can only reference a certificate issued in its region; `us-east-1` is special only for CloudFront, unused here.

The Route 53 zone is *imported* (`from_hosted_zone_attributes`, zone ID passed as CDK context), not looked up or created: a lookup needs live credentials and caches account-specific data into the checked-in `cdk.context.json`, while an imported zone stays outside the stack's resource set, so a deploy only ever adds records to it.

## Abuse protection

Three request-path layers (`web/lib/server/rateLimit.ts`), since a per-user quota alone doesn't stop multi-accounting:

1. Per-IP rate limit (the actual multi-account defense), checked in `presign`. **The IP comes from the _last_ `X-Forwarded-For` hop, not the first** — an ALB appends the address it actually saw to whatever the client sent, so trusting the first entry would let anyone mint a fresh bucket per request with a spoofed header, which defeats the whole layer. This assumes exactly one trusted proxy; adding CloudFront in front of the ALB moves the trustworthy position again and requires revisiting `getClientIp`.
2. Per-user rate limit, alongside it.
3. Global daily job cap, checked only in `process` — independent of who's calling, the backstop that bounds worst-case GPU spend.

Behind all three, an AWS Budget plus a CloudWatch billing alarm (`infra/stacks/budgets_stack.py`) is a separate ops-level net: it catches spend the request path never sees, so a bug in this logic can't quietly run up a bill.

## Frontend

Next.js (App Router), not a Vite SPA — Open Graph previews for shared objects need `generateMetadata` to run server-side per route (crawlers don't execute JS). Mantine over MUI for a less generic look next to the WebGL viewer and better Next.js Server Component compatibility (native CSS Modules, no CSS-in-JS runtime). SWR owns server-derived data (job status polling via `refreshInterval`); Zustand is scoped to pure client UI state (upload progress, banners). `@mkkellogg/gaussian-splats-3d`'s `DropInViewer` renders inside react-three-fiber's `<Canvas>` via `<primitive>` — it drives itself through Three.js's native `onBeforeRender` hook, no manual frame-ticking needed.

## Infra

AWS CDK (Python), not Terraform — 100% AWS with no multi-cloud plans, so Terraform's core value proposition isn't exercised here. Python rather than TypeScript so it shares `worker/`'s tooling — both use `uv` and the same `ruff`+`mypy` story, so infra reviews the same way pipeline code does. The CDK CLI itself remains npm-distributed regardless of app language (there's no pip-installable `cdk` binary), so `infra/` still keeps a minimal `package.json` pinning just that CLI — Node stays a build-time dependency there, just not a source-code language. Six stacks (`infra/stacks/`): network (VPC/security groups), data (RDS/S3), registry (the ECR repository, split out so the image can be pushed before the service that pulls it exists), worker-iam (the spot instance's scoped role), backend (ALB + Fargate, running the `web/` image), budgets (independent of the others, deployed to us-east-1 regardless of the app's region since billing metrics only exist there).

## Testing

Three tiers, split by CI-cheap vs. GPU-costly (`.github/workflows/ci.yml`):

- **Unit/component** (every PR): `pytest` + `moto` (mocked AWS) for `worker/`; Vitest for `web/`, split into `client` (jsdom, React Testing Library) and `server` (Node, plus a real Postgres for the rate-limit tier).
- **E2E** (every PR): Playwright against the app itself, scoped to what's reachable without live Clerk credentials — currently the public gallery path. The one spec **is skipped, so the tier asserts nothing today**: the gallery pages read the database during SSR, which `page.route()` cannot intercept, and they render empty without seeded data. Deferred deliberately — E2E's job here is UI flows, and server-side correctness is covered by the Vitest `server` project.
- **Real-pipeline integration** (manual/milestone-gated, not CI): actual COLMAP + gsplat runs cost real GPU time/money. A "fast test mode" (tiny photo set, ~50 iterations) gives a cheap on-demand smoke test of the plumbing when needed.

`web/`'s AWS tests use `aws-sdk-client-mock`, which stubs calls rather than emulating a backend the way `moto` does for `worker/` — so `ec2Launcher.test.ts` asserts on the arguments `RunInstancesCommand` received rather than on state afterwards.

## Build order

The milestones referenced from code comments and `AGENTS.md` (`M0`, `M5`, `M10`, and so on). They name phases of work, not a schedule, and the work did not follow their order: the web app and infrastructure are largely built while M0 and M1 are not. This list defines what each milestone means; `AGENTS.md` is where their status is tracked, so it is not repeated here.

- **M0** — Shoot ~50 multi-angle photos of one real object and hand-run COLMAP → gsplat training → export, viewing the result in a standalone page. Proves the pipeline yields a good splat before anything is built on top of it.
- **M1** — The same run driven by scripted `worker/pipeline/` modules rather than by hand.
- **M2** — Backend skeleton: the objects/photos/jobs schema and the CRUD endpoints over it.
- **M3** — S3 upload flow: the presign and complete endpoints against a real bucket.
- **M4** — End-to-end job trigger running the pipeline locally, proving upload → process → result before any cloud orchestration exists to complicate it.
- **M5** — EC2 spot launch: the worker image, `ec2Launcher.ts`, the worker's status callback, and self-termination verified on both success and induced failure.
- **M6** — Auth, plus the three rate-limiting layers.
- **M7** — The authenticated frontend: upload flow, job status polling, splat viewer.
- **M8** — Public gallery and share links, including the thumbnails Open Graph previews need.
- **M9** — Infrastructure as code, and a first real deploy.
- **M10** — A Packer-baked worker AMI, with the boot-latency improvement measured rather than assumed.
