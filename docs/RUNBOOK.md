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

The REST API is served via Route Handlers in this package (`web/app/api/v1/`), backed by Postgres via Drizzle — start a database before `pnpm dev`:

```bash
podman run -d --name splatter-pg --restart=always \
  -p 5432:5432 \
  -v splatter-pg-data:/var/lib/postgresql/data \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=ai_gaussian_splatter \
  postgres:18
```

Named volume keeps PG data across container recreate/reboot; `--restart=always` (and no `--rm`) brings the container back after a reboot. On Fedora with rootless Podman, also enable the restart helper once so that policy is honored after boot:

```bash
systemctl --user enable --now podman-restart.service
```

(For rootful Podman use `sudo systemctl enable --now podman-restart.service` instead.)

```bash
cd web
pnpm install                # no codegen step — Drizzle's schema is plain TypeScript
cp .env.example .env.local  # fill in Clerk keys, database parts, buckets, worker IDs
pnpm db:migrate             # apply pending migrations (drizzle-kit migrate)
pnpm dev
```

`pnpm db:studio` opens Drizzle Studio to browse/edit rows.

After editing `web/lib/server/db/schema.ts`, run `pnpm db:generate` to emit a migration into `web/drizzle/`, read the SQL it produced, then `pnpm db:migrate` to apply it. The types update the moment you save the schema, so `tsc` will not catch a schema you forgot to generate a migration for.

### Full test suite

```bash
(cd web && pnpm typecheck && pnpm biome:ci && pnpm test && pnpm test:e2e)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && pnpm synth)
```

The `lib/server/**` Vitest project's Postgres-dependent tests (rate limiting, `getOrCreateUser`, the worker callback token) skip unless `TEST_DATABASE_URL` is set — CI wires it to a service container:

```bash
(cd web && TEST_DATABASE_URL=postgresql://postgres:test@localhost:5432/ai_gaussian_splatter pnpm test)
```

### Building and running the container locally

Exercises the production path — the standalone build, not `next dev`. Also the way to test SSR locally if your environment blocks the loopback connection Next's proxy makes to itself (a host-run `next dev` then 500s on every request with `ECONNREFUSED ::1`; the container has its own netns and is unaffected).

```bash
podman network create splatnet
podman run -d --rm --name splatter-pg --network splatnet -p 5432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=ai_gaussian_splatter \
  postgres:18
(cd web && DATABASE_HOST=localhost DATABASE_NAME=ai_gaussian_splatter DATABASE_USER=postgres \
  DATABASE_PASSWORD=test pnpm db:migrate)

cd web
podman build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk \
  -t splatter-web:test .
podman run -d --name splatter-web --network splatnet -p 8000:8000 \
  -e DATABASE_HOST=splatter-pg \
  -e DATABASE_NAME=ai_gaussian_splatter \
  -e DATABASE_USER=postgres \
  -e DATABASE_PASSWORD=test \
  -e CLERK_SECRET_KEY=sk_test_fake \
  -e UPLOADS_BUCKET=test-uploads \
  -e SPLATS_BUCKET=test-splats \
  -e AWS_REGION=us-west-2 \
  -e AWS_ACCESS_KEY_ID=testing \
  -e AWS_SECRET_ACCESS_KEY=testing \
  -e WORKER_AMI_ID=ami-0123456789abcdef0 \
  -e WORKER_SUBNET_ID=subnet-0123456789abcdef0 \
  -e WORKER_SECURITY_GROUP_ID=sg-0123456789abcdef0 \
  -e WORKER_INSTANCE_PROFILE_ARN=arn:aws:iam::123456789012:instance-profile/worker \
  -e APP_PUBLIC_URL=http://localhost:8000 \
  splatter-web:test

curl -s http://localhost:8000/api/v1/healthz   # {"status":"ok"}
```

The publishable key must be a `--build-arg`, not `-e`: `NEXT_PUBLIC_*` is inlined into the browser bundle at build time. Tear down with `podman rm -f splatter-web splatter-pg && podman network rm splatnet`.

### Applying migrations to a deployed environment

The container image deliberately does not run migrations on boot (the service runs up to 3 tasks, which would race — drizzle-kit takes no advisory lock — and the running app would need DDL rights it otherwise doesn't). Run it as a deploy step instead:

`drizzle.config.ts` resolves its connection the same way the running app does (`lib/server/databaseUrl.ts`), from the `DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` parts — read those straight out of the RDS secret:

```bash
eval "$(aws secretsmanager get-secret-value --secret-id <rds-secret-arn> \
  --query SecretString --output text | jq -r \
  '"export DATABASE_HOST=\(.host) DATABASE_PORT=\(.port) DATABASE_NAME=\(.dbname) DATABASE_USER=\(.username) DATABASE_PASSWORD=\(.password)"')"
(cd web && pnpm db:migrate)
```

The database lives in a private subnet, so run this from somewhere inside the VPC (or over a bastion/SSM port-forward), not a laptop.

## Debugging a failed job

1. Check `jobs.status` and `jobs.error_message` for the object (`GET /api/v1/objects/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm self-termination actually fired: the instance should not still be running after the job reaches a terminal state. If it is, the CloudWatch alarm backstop (kills anything worker-tagged running >90 min) is the safety net — verify it's configured (`infra/stacks/budgets_stack.py` handles cost alarms; the instance-runtime alarm is a documented addition, not yet in this stack).
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Deploying infra

Common to every deploy:

```bash
cd infra
export AWS_ACCOUNT_ID=<your real account id>   # otherwise this targets the placeholder account and fails
# --output text tab-separates multiple matches on one line, so filter out any
# private zone for the same name before taking the id.
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name orky.net \
  --query "HostedZones[?Name=='orky.net.' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text | cut -d/ -f3)
npx cdk diff -c hostedZoneId=$ZONE_ID    # review changes
```

`hostedZoneId` is the `orky.net` zone the ALB's DNS record and its ACM certificate validation go into. Without it the placeholder zone ID is used, which fails at deploy time. The zone is imported rather than managed, so it is not part of the stack's resource set: `cdk destroy` removes the app's own A-alias record, but cannot delete the zone itself or any record the stack did not create.

### First deploy: registry, then image, then everything else

`BackendStack`'s service is pinned to an image tag, so an image must already be in ECR when that stack deploys — `cdk deploy --all` on a fresh account creates an empty repository and then a service whose tasks have nothing to pull, and the deployment circuit breaker rolls `BackendStack` back. `RegistryStack` holds the repository on its own for exactly this reason. Deploy it first, push, then deploy the rest:

```bash
npx cdk deploy RegistryStack
aws ecr get-login-password --region us-west-2 | podman login --username AWS --password-stdin \
  $AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com
REPO=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-backend
podman build -t $REPO:latest \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:latest

npx cdk deploy --all -c hostedZoneId=$ZONE_ID
```

The first deploy waits on ACM DNS validation, which can take several minutes; ACM writes the validation record into the zone itself.

Two things are not part of `cdk deploy --all` and must be done before the site actually works, even though the target group will report healthy without them — `/api/v1/healthz` never touches the database or Clerk:

- **Apply migrations** — see "Applying migrations to a deployed environment" above. Without this the database has no tables and every real request 500s.
- **Populate `ai-gaussian-splatter/clerk-secret-key`** — `ClerkSecretKey` in `backend_stack.py` creates the Secrets Manager entry with CDK's own generated random value, not a usable key. Set the real `CLERK_SECRET_KEY` by hand:
  ```bash
  aws secretsmanager put-secret-value --region us-west-2 \
    --secret-id ai-gaussian-splatter/clerk-secret-key --secret-string sk_live_...
  ```
  Then force a new deployment (see "Shipping a new image" below) so running tasks pick up the new value — ECS injects secrets at task start, not on live update.

### Shipping a new image

The service is pinned to the fixed tag `latest`, so a new image does **not** change `BackendStack`'s template. `cdk deploy` is then a no-op and ECS keeps running the old digest — pushing alone rolls nothing out. Force the replacement explicitly:

```bash
REPO=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-backend
podman build -t $REPO:latest \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:latest
aws ecs update-service --region us-west-2 \
  --cluster ai-gaussian-splatter --service ai-gaussian-splatter-backend \
  --force-new-deployment
```

`--force-new-deployment` starts a fresh deployment against the same task definition, which re-resolves `:latest` to the digest just pushed. `min_healthy_percent=100` keeps the old task serving until the new one passes health checks. Note the circuit breaker's rollback does **not** help on this path: a rollback restarts the previous deployment against the *same* task definition, which still points at the mutable `:latest` tag — Fargate re-pulls it and gets the same broken image, not the one that was running before the push. `min_healthy_percent=100` is what actually protects availability here; if a bad push fails health checks, push a fixed image and force another deployment rather than expecting rollback to recover the old one. The cluster and service names are set explicitly in `backend_stack.py` (`CLUSTER_NAME`/`SERVICE_NAME`) so this command needs no lookup.

Infra changes (anything that edits a stack) still go out with `npx cdk deploy --all -c hostedZoneId=$ZONE_ID`; only image-only changes need `update-service`.

The `WorkerIamStack`, `DataStack`, and `RegistryStack` must exist before `BackendStack` (CDK resolves this automatically via cross-stack references in `app.py`). `BudgetsStack` deploys to `us-east-1` regardless of the app's primary region — billing metrics only exist there.

`app.py`'s `workerAmiId` context value is a placeholder (`ami-000000000000`) until the worker image is actually built and pushed (plan M5/M10) — `cdk synth`/`diff` work fine with the placeholder, but don't `deploy` the `BackendStack` with it still set, since job launches would fail.
