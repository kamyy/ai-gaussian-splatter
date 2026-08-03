# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time, interactive 3D Gaussian Splat you can view in the browser and share.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it's built and why, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for local development and operational tasks.

## Structure

- `web/` — Next.js (App Router) + Mantine + SWR + Zustand + react-three-fiber, and the REST API as Route Handlers (auth, rate limiting, job orchestration) backed by Prisma
- `worker/` — COLMAP + gsplat reconstruction pipeline, run on a GPU spot instance per job
- `infra/` — AWS CDK (Python)

## Quick start

```bash
# Web (frontend + API)
cd web && pnpm install && pnpm test && pnpm dev

# Worker
cd worker && uv sync --group dev && uv run pytest

# Infra
cd infra && pnpm install && uv sync --group dev && uv run pytest && npx cdk synth
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
