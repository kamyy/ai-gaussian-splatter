# AI Gaussian Splatter

> 🚧 **Under construction.** The pipeline has run end to end on a local GPU, but nothing has run on AWS yet and several gaps remain — see [State / what's next](AGENTS.md#10-state--whats-next), [`ARCHITECTURE.md`](ARCHITECTURE.md), and [`RUNBOOK.md`](RUNBOOK.md).

Upload multi-angle photos of a physical object, get back a real-time, interactive 3D Gaussian Splat you can view in the browser and share.

Quality depends on angular coverage and overlap, not raw count. Aim for **~50 well-spaced** views (every side, a couple of heights, neighboring shots overlapping) rather than many near-duplicates. Capture tips: [`RUNBOOK.md`](RUNBOOK.md#15-capture).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it's built and why, and [`RUNBOOK.md`](RUNBOOK.md) for local development and operational tasks.

Built with the help of [Claude Code](https://claude.com/product/claude-code) and Cursor's Composer.

## Tech stack

**Frontend** — Next.js (App Router) · Tailwind CSS · Radix UI · SWR · Zustand · react-three-fiber (`@mkkellogg/gaussian-splats-3d` for splat rendering)

**Backend** — Next.js Route Handlers (REST API) · Drizzle ORM · Postgres (RDS) · Clerk (auth) · Python COLMAP + gsplat pipeline on its own EC2 GPU spot instance

**Infra** — Terraform · ECS Fargate (Spot) behind an ALB · S3 · ECR · Route 53 / ACM · GitHub Actions (CI/CD via OIDC)

## Structure

- `web/` — the frontend, and the REST API as Route Handlers (auth, rate limiting, worker-job orchestration)
- `worker/` — the reconstruction pipeline, run on a GPU spot instance per worker-job stage
- `infra/` — the Terraform configuration for the whole AWS stack

## Quick start

Developed and tested on Fedora Linux — that's why [`RUNBOOK.md`](RUNBOOK.md) talks about Podman and SELinux rather than Docker.

`pnpm dev` needs a local Postgres and a filled-in `.env` first — see [`RUNBOOK.md`](RUNBOOK.md#12-web-frontend--rest-api).

```bash
# Web (frontend + API)
cd web && pnpm install && pnpm test && pnpm dev

# Worker
cd worker && uv sync --group dev && uv run pytest

# Infra
pnpm run infra:check && terraform -chdir=infra test
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
