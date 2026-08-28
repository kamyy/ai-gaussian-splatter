# AI Gaussian Splatter

> 🚧 **Under construction.** Scaffolding is in place but the pipeline is unproven on real hardware and several gaps remain — see [State / what's next](AGENTS.md#state--whats-next), [`ARCHITECTURE.md`](ARCHITECTURE.md), and [`RUNBOOK.md`](RUNBOOK.md).

Upload multi-angle photos of a physical object, get back a real-time, interactive 3D Gaussian Splat you can view in the browser and share.

Quality depends on angular coverage and overlap, not raw count. Aim for **~50 well-spaced** views (every side, a couple of heights, neighboring shots overlapping) rather than many near-duplicates. Capture tips: [`RUNBOOK.md`](RUNBOOK.md#capture).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it's built and why, and [`RUNBOOK.md`](RUNBOOK.md) for local development and operational tasks.

Built with the help of [Claude Code](https://claude.com/product/claude-code) and Cursor's Composer.

## Tech stack

**Frontend** — Next.js (App Router) · Mantine · SWR · Zustand · react-three-fiber (`@mkkellogg/gaussian-splats-3d` for splat rendering)

**Backend** — Next.js Route Handlers (REST API) · Drizzle ORM · Postgres (RDS) · Clerk (auth) · Python COLMAP + gsplat pipeline on an EC2 GPU spot instance per job

**Infra** — AWS CDK (Python) · ECS Fargate (Spot) behind an ALB · S3 · ECR · Route 53 / ACM · GitHub Actions (CI/CD via OIDC)

## Structure

- `web/` — Next.js (App Router) + Mantine + SWR + Zustand + react-three-fiber, and the REST API as Route Handlers (auth, rate limiting, job orchestration) backed by Drizzle
- `worker/` — COLMAP + gsplat reconstruction pipeline, run on a GPU spot instance per job
- `infra/` — AWS CDK (Python)

## Quick start

Developed and tested on Fedora Linux — that's why [`RUNBOOK.md`](RUNBOOK.md) talks about Podman and SELinux rather than Docker.

`pnpm dev` needs a local Postgres and a filled-in `.env` first — see [`RUNBOOK.md`](RUNBOOK.md#web-frontend--rest-api).

```bash
# Web (frontend + API)
cd web && pnpm install && pnpm test && pnpm dev

# Worker
cd worker && uv sync --group dev && uv run pytest

# Infra
cd infra && pnpm install && uv sync --group dev && uv run pytest && pnpm cdk:synth
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
