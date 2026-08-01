# Architecture

Full rationale for every decision below lives in the original plan (`/home/kam/.claude/plans/i-m-writing-a-full-stack-crispy-engelbart.md` at the time this was written) — this is the condensed reference version.

## Pipeline

1. User uploads discrete multi-angle photos of one object (not a panorama sweep — walk around it, individual stills).
2. **COLMAP** (`worker/pipeline/sfm.py`): exhaustive feature matching → camera poses + sparse point cloud. Favors accuracy over speed for a small object-centric photo set. A registered-image ratio below 50% fails the job — that's a capture-quality problem, not a pipeline bug.
3. **gsplat** (`worker/pipeline/train.py`): per-object 3D Gaussian Splatting training, ~7k-15k iterations (reduced from the paper's 30k default — single-object-against-plain-background scenes converge faster). Apache 2.0 licensed, unlike the original INRIA repo's non-commercial license.
4. **Export** (`worker/pipeline/export.py`): writes the trained scene as a viewer-compatible `.ply`, plus a thumbnail rendered via gsplat's own rasterizer (reused, not a new dependency) for Open Graph previews.

The "AI" here is the training itself — a from-scratch per-object gradient-descent optimization through a differentiable rasterizer, not a pretrained inference model. COLMAP is classical computer vision (bundle adjustment), not ML.

## Compute

Each job launches a dedicated AWS EC2 `g5.xlarge` **spot** instance (`backend/app/services/ec2_launcher.py`), runs the worker container, and self-terminates in all cases (success, failure, or a CloudWatch alarm backstop). No SQS queue, no Batch, no always-on fleet — volume is bounded by the global daily job cap, and a queue only earns its complexity at higher, decoupled-worker-fleet scale (documented future enhancement).

Not Lambda: zero GPU support, hard architectural limit. Not Fargate: also no GPU. Not hand-rolled ECS orchestration: its value (bin-packing many tasks on shared instances) doesn't apply to a one-job-one-dedicated-instance pattern.

## API & data

FastAPI REST (`backend/`), not GraphQL — the API is ~9 flat endpoints, REST's ideal case. Postgres (RDS) for `users`/`objects`/`photos`/`jobs`/rate-limit counters — genuinely relational, low traffic, atomic upserts via `INSERT ... ON CONFLICT`.

Auth: Clerk (`@clerk/nextjs`), not Cognito (clunkier setup) or Auth0.

**2026-07-31 update**: the backend originally ran on App Runner, but App Runner stopped accepting new customers 2026-04-30 (existing services keep running, no new features). Since this project hadn't deployed yet, it moved to **ECS Express Mode** (`AWS::ECS::ExpressGatewayService`) instead — AWS's official replacement, launched Nov 2025. It auto-provisions the ECS cluster/service, ALB, security groups, and auto-scaling from one resource, same "no hand-wired orchestration" intent App Runner had. Only an L1 CDK construct exists so far (no L2 yet), so `backend_stack.py` configures it explicitly, same as it did for App Runner's L1 constructs.

## Abuse protection

Three independent layers (`backend/app/services/rate_limit.py`), since a per-user quota alone doesn't stop multi-accounting:

1. Per-IP rate limit (the actual multi-account defense), checked in `presign`.
2. Per-user rate limit, alongside it.
3. Global daily job cap, checked only in `process` — independent of who's calling, the backstop that bounds worst-case GPU spend.
4. AWS Budget + CloudWatch billing alarm (`infra/stacks/budgets_stack.py`), an independent ops-level safety net.

## Frontend

Next.js (App Router), not a Vite SPA — Open Graph previews for shared objects need `generateMetadata` to run server-side per route (crawlers don't execute JS). Mantine over MUI for a less generic look next to the WebGL viewer and better Next.js Server Component compatibility (native CSS Modules, no CSS-in-JS runtime). SWR owns server-derived data (job status polling via `refreshInterval`); Zustand is scoped to pure client UI state (upload progress, banners). `@mkkellogg/gaussian-splats-3d`'s `DropInViewer` renders inside react-three-fiber's `<Canvas>` via `<primitive>` — it drives itself through Three.js's native `onBeforeRender` hook, no manual frame-ticking needed.

## Infra

AWS CDK (Python), not Terraform — 100% AWS with no multi-cloud plans, so Terraform's core value proposition isn't exercised here. Originally TypeScript CDK (matching `frontend/`'s language), ported to Python on 2026-07-31 to match `backend/`'s and `worker/`'s tooling instead: all three non-frontend packages now share `uv` for dependency management and the same `ruff`+`mypy` lint/type story, so infra code reviews the same way backend/worker code does. The CDK CLI itself remains npm-distributed regardless of app language (there's no pip-installable `cdk` binary), so `infra/` still keeps a minimal `package.json` pinning just that CLI — Node stays a build-time dependency there, just not a source-code language. Five stacks (`infra/stacks/`): network (VPC/security groups), data (RDS/S3), worker-iam (the spot instance's scoped role), backend (ECS Express Mode), budgets (independent of the others, deployed to us-east-1 regardless of the app's region since billing metrics only exist there).

## Testing

Three tiers, split by CI-cheap vs. GPU-costly (`.github/workflows/ci.yml`):

- **Unit/component** (every PR): `pytest` + `moto` (mocked AWS) for backend/worker; Vitest + React Testing Library for frontend.
- **E2E against a mocked backend** (every PR): Playwright, covering what's reachable without live Clerk credentials (currently the public gallery path) against a real tiny mock HTTP server (`frontend/e2e/mock-backend.mjs`) — not browser-level route mocking, since the gallery/view pages fetch server-side during Next's SSR, which is invisible to `page.route()`.
- **Real-pipeline integration** (manual/milestone-gated, not CI): actual COLMAP + gsplat runs cost real GPU time/money. A "fast test mode" (tiny photo set, ~50 iterations) gives a cheap on-demand smoke test of the plumbing when needed.
