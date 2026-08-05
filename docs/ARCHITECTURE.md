# Architecture

Full rationale for every decision below lives in the original plan (`/home/kam/.claude/plans/i-m-writing-a-full-stack-crispy-engelbart.md` at the time this was written) — this is the condensed reference version.

## Pipeline

1. User uploads discrete multi-angle photos of one object (not a panorama sweep — walk around it, individual stills).
2. **COLMAP** (`worker/pipeline/sfm.py`): exhaustive feature matching → camera poses + sparse point cloud. Favors accuracy over speed for a small object-centric photo set. A registered-image ratio below 50% fails the job — that's a capture-quality problem, not a pipeline bug.
3. **gsplat** (`worker/pipeline/train.py`): per-object 3D Gaussian Splatting training, ~7k-15k iterations (reduced from the paper's 30k default — single-object-against-plain-background scenes converge faster). Apache 2.0 licensed, unlike the original INRIA repo's non-commercial license.
4. **Export** (`worker/pipeline/export.py`): writes the trained scene as a viewer-compatible `.ply`, plus a thumbnail rendered via gsplat's own rasterizer (reused, not a new dependency) for Open Graph previews.

The "AI" here is the training itself — a from-scratch per-object gradient-descent optimization through a differentiable rasterizer, not a pretrained inference model. COLMAP is classical computer vision (bundle adjustment), not ML.

## Compute

Each job launches a dedicated AWS EC2 `g5.xlarge` **spot** instance (`web/lib/server/ec2Launcher.ts`), runs the worker container, and self-terminates in all cases (success, failure, or a CloudWatch alarm backstop). No SQS queue, no Batch, no always-on fleet — volume is bounded by the global daily job cap, and a queue only earns its complexity at higher, decoupled-worker-fleet scale (documented future enhancement).

Not Lambda: zero GPU support, hard architectural limit. Not Fargate: also no GPU. Not hand-rolled ECS orchestration: its value (bin-packing many tasks on shared instances) doesn't apply to a one-job-one-dedicated-instance pattern.

## API & data

REST (`web/app/api/v1/`), not GraphQL — the API is ~9 flat endpoints, REST's ideal case. Postgres (RDS) for `users`/`objects`/`photos`/`jobs`/rate-limit counters — genuinely relational, low traffic, atomic upserts via `INSERT ... ON CONFLICT`.

Auth: Clerk (`@clerk/nextjs`), not Cognito (clunkier setup) or Auth0.

The API lives in the same Next.js app as the pages, not a separate service. SSR is load-bearing here (`generateMetadata` for Open Graph, server-side gallery reads), so a long-running Node process has to exist regardless — putting the API in it means one deployable instead of two, and one TypeScript program, so there is no cross-service contract to hand-sync.

The tradeoff is losing a framework that derives OpenAPI docs and response schemas for you. Response field sets are explicit column maps in `web/lib/server/selects.ts`, passed to `.select()` — the excluded columns never appear in the SQL at all, which is what keeps `callbackToken` out of a job response.

ORM is **Drizzle** (`drizzle-orm` over `node-postgres`), not Prisma. The deciding factor is that its query builder is SQL rather than a bespoke object grammar: `.select().from(jobs).innerJoin(splats, …).where(and(eq(…), …))` maps one-to-one onto the statement Postgres runs, so what a reader can see is what executes. That property is load-bearing for the rate-limit counters, which need `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count` in a single statement to keep check-and-increment race-free; it is written out as `.onConflictDoUpdate({ target, set })` rather than inferred. Prisma expresses the same thing as `upsert()`, but only compiles it to one statement when the `update` clause happens to be non-empty, silently degrading to `SELECT`-then-`INSERT` otherwise — a cliff invisible in the TypeScript. Secondary benefits: no codegen step (the schema is ordinary TypeScript, so `pnpm install` needs no `postinstall` and there is no generated client to go stale), and no query-engine binary.

The cost is that Drizzle has no equivalent of Prisma's `@@map` for enum members, so Postgres's enum labels and the TypeScript union members must be the exact same spelling — see the wire format (JSON) note below.

Wire format (the API's JSON request/response shape) is camelCase for field names. Status *values* are snake_case (`colmap_running`, not `ColmapRunning`), because a `pgEnum`'s values are simultaneously the Postgres labels and the TypeScript union members. The database keeps SQL-idiomatic labels and everything downstream inherits them, so there is one spelling end to end and no translation layer to keep correct. This also aligns the worker: `PATCH /api/v1/internal/jobs/{id}/status` parses snake_case field names because `worker/pipeline/status.py` sends that shape, and its status values need no mapping either.

Hosting is **ECS Express Mode** (`AWS::ECS::ExpressGatewayService`), not App Runner — App Runner stopped accepting new customers 2026-04-30, and Express Mode is AWS's official replacement (launched Nov 2025). It auto-provisions the ECS cluster/service, ALB, security groups, and auto-scaling from one resource, same "no hand-wired orchestration" intent App Runner had. Only an L1 CDK construct exists so far (no L2 yet), so `backend_stack.py` configures it explicitly.

## Abuse protection

Three independent layers (`web/lib/server/rateLimit.ts`), since a per-user quota alone doesn't stop multi-accounting:

1. Per-IP rate limit (the actual multi-account defense), checked in `presign`. **The IP comes from the _last_ `X-Forwarded-For` hop, not the first** — an ALB appends the address it actually saw to whatever the client sent, so trusting the first entry would let anyone mint a fresh bucket per request with a spoofed header, which defeats the whole layer. This assumes exactly one trusted proxy; adding CloudFront in front of the ALB moves the trustworthy position again and requires revisiting `getClientIp`.
2. Per-user rate limit, alongside it.
3. Global daily job cap, checked only in `process` — independent of who's calling, the backstop that bounds worst-case GPU spend.
4. AWS Budget + CloudWatch billing alarm (`infra/stacks/budgets_stack.py`), an independent ops-level safety net.

## Frontend

Next.js (App Router), not a Vite SPA — Open Graph previews for shared objects need `generateMetadata` to run server-side per route (crawlers don't execute JS). Mantine over MUI for a less generic look next to the WebGL viewer and better Next.js Server Component compatibility (native CSS Modules, no CSS-in-JS runtime). SWR owns server-derived data (job status polling via `refreshInterval`); Zustand is scoped to pure client UI state (upload progress, banners). `@mkkellogg/gaussian-splats-3d`'s `DropInViewer` renders inside react-three-fiber's `<Canvas>` via `<primitive>` — it drives itself through Three.js's native `onBeforeRender` hook, no manual frame-ticking needed.

## Infra

AWS CDK (Python), not Terraform — 100% AWS with no multi-cloud plans, so Terraform's core value proposition isn't exercised here. Python rather than TypeScript so it shares `worker/`'s tooling — both use `uv` and the same `ruff`+`mypy` story, so infra reviews the same way pipeline code does. The CDK CLI itself remains npm-distributed regardless of app language (there's no pip-installable `cdk` binary), so `infra/` still keeps a minimal `package.json` pinning just that CLI — Node stays a build-time dependency there, just not a source-code language. Five stacks (`infra/stacks/`): network (VPC/security groups), data (RDS/S3), worker-iam (the spot instance's scoped role), backend (ECS Express Mode, running the `web/` image), budgets (independent of the others, deployed to us-east-1 regardless of the app's region since billing metrics only exist there).

## Testing

Three tiers, split by CI-cheap vs. GPU-costly (`.github/workflows/ci.yml`):

- **Unit/component** (every PR): `pytest` + `moto` (mocked AWS) for `worker/`; Vitest for `web/`, split into `client` (jsdom, React Testing Library) and `server` (Node, plus a real Postgres for the rate-limit tier).
- **E2E against a mocked backend** (every PR): Playwright, covering what's reachable without live Clerk credentials (currently the public gallery path) against a real tiny mock HTTP server (`web/e2e/mock-backend.mjs`) — not browser-level route mocking, since the gallery/view pages fetch server-side during Next's SSR, which is invisible to `page.route()`.

`web/`'s AWS tests use `aws-sdk-client-mock`, which stubs calls rather than emulating a backend the way `moto` does for `worker/` — so `ec2Launcher.test.ts` asserts on the arguments `RunInstancesCommand` received rather than on state afterwards.

`web/e2e/mock-backend.mjs` **is knowingly stale**: the gallery pages it covers query the database directly, so it serves data nothing requests and Playwright can pass while exercising a path production doesn't use. Deferred deliberately — E2E's job here is UI flows, and server-side correctness is covered by the Vitest `server` project — but don't mistake it for working coverage of the real data path.
- **Real-pipeline integration** (manual/milestone-gated, not CI): actual COLMAP + gsplat runs cost real GPU time/money. A "fast test mode" (tiny photo set, ~50 iterations) gives a cheap on-demand smoke test of the plumbing when needed.
