# Runbook

## Local development

### Worker (local pipeline run, per plan M0/M1)

Requires a real GPU with the CUDA toolkit and `colmap` on PATH — not available in every dev environment (this repo was scaffolded in a sandbox with a GPU driver but no CUDA toolkit, so the training path was smoke-tested but never run end-to-end; verify on real hardware before trusting it).

```bash
cd worker
uv sync --group dev
JOB_ID=local-test OBJECT_ID=local-test CALLBACK_TOKEN=none \
BACKEND_URL=http://localhost:8000 UPLOADS_BUCKET=... SPLATS_BUCKET=... \
FAST_TEST_MODE=true \
  uv run python run_job.py
```

### Web (frontend + REST API)

Needs a real Postgres — the API layer lives here now:

```bash
podman run -d --rm --name splatter-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=test postgres:18
```

```bash
cd web
pnpm install                # postinstall runs `prisma generate`
cp .env.example .env.local  # fill in Clerk keys, DATABASE_URL, buckets, worker IDs
pnpm db:migrate             # apply migrations (prisma migrate dev)
pnpm dev
```

`pnpm db:studio` opens Prisma Studio to browse/edit rows.

### Full test suite

```bash
(cd web && npx tsc --noEmit && npx biome ci . && npx vitest run && npx playwright test)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && npx cdk synth)
```

The `lib/server/**` Vitest project's Postgres-dependent tests (rate limiting,
`getOrCreateUser`, the worker callback token) skip unless `TEST_DATABASE_URL`
is set — CI wires it to a service container:

```bash
(cd web && TEST_DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres npx vitest run)
```

### Applying migrations to a deployed environment

The container image deliberately does not run migrations on boot (Express Mode
runs up to 3 tasks, which would race, and the running app would need DDL
rights it otherwise doesn't). Run it as a deploy step instead:

```bash
(cd web && DATABASE_URL=<production-url> npx prisma migrate deploy)
```

## Debugging a failed job

1. Check `jobs.status` and `jobs.error_message` for the object (`GET /api/v1/objects/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm self-termination actually fired: the instance should not still be running after the job reaches a terminal state. If it is, the CloudWatch alarm backstop (kills anything worker-tagged running >90 min) is the safety net — verify it's configured (`infra/stacks/budgets_stack.py` handles cost alarms; the instance-runtime alarm is a documented addition, not yet in this stack).
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Deploying infra

```bash
cd infra
export AWS_ACCOUNT_ID=<your real account id>   # otherwise this targets the placeholder account and fails
npx cdk diff    # review changes
npx cdk deploy --all
```

The `WorkerIamStack` and `DataStack` must exist before `BackendStack` (CDK resolves this automatically via cross-stack references in `app.py`). `BudgetsStack` deploys to `us-east-1` regardless of the app's primary region — billing metrics only exist there.

`app.py`'s `workerAmiId` context value is a placeholder (`ami-000000000000`) until the worker image is actually built and pushed (plan M5/M10) — `cdk synth`/`diff` work fine with the placeholder, but don't `deploy` the `BackendStack` with it still set, since job launches would fail.
