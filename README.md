# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time, interactive 3D Gaussian Splat you can view in the browser and share.

Quality depends on angular coverage and overlap, not raw count — aim for **~50 well-spaced** views (every side, a couple of heights, neighboring shots overlapping) rather than many near-duplicates. Capture tips: [`RUNBOOK.md`](RUNBOOK.md#capture).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it's built and why, and [`RUNBOOK.md`](RUNBOOK.md) for local development and operational tasks.

## Structure

- `web/` — Next.js (App Router) + Mantine + SWR + Zustand + react-three-fiber, and the REST API as Route Handlers (auth, rate limiting, job orchestration) backed by Drizzle
- `worker/` — COLMAP + gsplat reconstruction pipeline, run on a GPU spot instance per job
- `infra/` — AWS CDK (Python)

## Quick start

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
