# Runbook

## Local development

### Development AWS resources (two S3 buckets)

Almost nothing in the deployed stack is a dev dependency — the VPC, ALB, and Fargate service exist to serve the app from the cloud in production. During development the app is served from localhost using `next dev`. S3 is the exception: `components/upload/PhotoDropzone.tsx` has the browser PUT to the presigned URL directly, and the worker reads and writes both buckets with boto3, so the bytes need somewhere real to go. S3 is a plain regional endpoint, so this needs no VPC and no other stack, and costs pennies.

These are created by hand rather than in `infra/`, which describes the production topology only.

```bash
for b in ai-gaussian-splatter-dev-uploads ai-gaussian-splatter-dev-splats; do
  aws s3api create-bucket --bucket "$b" --region us-west-2 \
    --create-bucket-configuration LocationConstraint=us-west-2
done

# Uploads take a cross-origin PUT from the app; splats take a cross-origin GET
# from the viewer. Without these rules the browser blocks both — the presigned
# URL is valid, so the failure shows only in the browser console.
#
# Both origins: 3000 is `next dev`, 8000 is the local container built below.
aws s3api put-bucket-cors --bucket ai-gaussian-splatter-dev-uploads --cors-configuration '{
  "CORSRules": [{"AllowedMethods": ["PUT"],
                 "AllowedOrigins": ["http://localhost:3000", "http://localhost:8000"],
                 "AllowedHeaders": ["*"]}]
}'
aws s3api put-bucket-cors --bucket ai-gaussian-splatter-dev-splats --cors-configuration '{
  "CORSRules": [{"AllowedMethods": ["GET", "HEAD"],
                 "AllowedOrigins": ["http://localhost:3000", "http://localhost:8000"],
                 "AllowedHeaders": ["*"]}]
}'
```

Then an IAM user scoped to just those two buckets, so `web/.env` never holds admin credentials:

```bash
aws iam create-user --user-name ai-gaussian-splatter-dev
aws iam put-user-policy --user-name ai-gaussian-splatter-dev \
  --policy-name dev-buckets --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::ai-gaussian-splatter-dev-uploads", "arn:aws:s3:::ai-gaussian-splatter-dev-uploads/*",
        "arn:aws:s3:::ai-gaussian-splatter-dev-splats", "arn:aws:s3:::ai-gaussian-splatter-dev-splats/*"
      ]
    }]
  }'
aws iam create-access-key --user-name ai-gaussian-splatter-dev
```

Put the returned key pair in `web/.env` as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. A 403 on the browser's PUT means either the CORS rule or this policy; the browser console distinguishes them (a CORS failure never reaches S3).

### Capture

Walk around the object shooting individual stills — every side, a couple of heights, each shot overlapping its neighbors. Aim for ~50. The API's floor is 20 (`MIN_PHOTOS_PER_OBJECT`, a 400 below it), which is a hard minimum rather than a quality target. Extra frames pay off only where they close a coverage gap; near-duplicates just add COLMAP matching cost. A set whose views don't connect fails outright in COLMAP instead of yielding a poor splat.

### Worker (local pipeline run, per plan M0/M1)

Needs an NVIDIA GPU. Run it as the container rather than on the host: the image carries CUDA and a CUDA-enabled COLMAP build, so nothing but the driver and `nvidia-container-toolkit` has to be installed locally. The toolkit lets Podman pass the host GPU into the container (`--device nvidia.com/gpu=all`).

One-time GPU passthrough setup. `nvidia-container-toolkit` is not in Fedora's repositories or RPM Fusion's — those carry the driver only — so it comes from NVIDIA's own:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit

# Writes the CDI spec that podman resolves `--device nvidia.com/gpu=all` against.
# Generated as root into /etc/cdi even though the containers run rootless.
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi
```

`--security-opt=label=disable` is required on every GPU run, not just this check: without it SELinux blocks access to the device nodes and NVML fails with `Insufficient Permissions` rather than anything mentioning SELinux.

Upload a photo set to the dev uploads bucket, then run the job against it:

```bash
OBJECT_ID=$(uuidgen)
aws s3 sync ./photos "s3://ai-gaussian-splatter-dev-uploads/objects/$OBJECT_ID/photos/"

podman build -t splat-worker:dev worker/    # ~19 GB image; most of the time is the torch/CUDA download

podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  -e JOB_ID=local-test -e OBJECT_ID="$OBJECT_ID" \
  -e CALLBACK_TOKEN=none -e BACKEND_URL=http://localhost:3000 \
  -e UPLOADS_BUCKET=ai-gaussian-splatter-dev-uploads \
  -e SPLATS_BUCKET=ai-gaussian-splatter-dev-splats \
  -e AWS_DEFAULT_REGION=us-west-2 \
  -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... \
  -e FAST_TEST_MODE=true \
  splat-worker:dev
```

`AWS_DEFAULT_REGION`, not `AWS_REGION`: botocore's region setting reads only the former, and with neither set `boto3.client("s3")` silently falls back to the global endpoint while `boto3.client("ec2")` raises `NoRegionError`. On a real worker instance the region comes from IMDS instead, so this matters only when running locally.

Nothing needs to be listening at `BACKEND_URL`: `pipeline/status.py` logs and swallows callback failures by design, and `terminate_self()` no-ops when IMDS doesn't answer, so the pipeline runs standalone. `FAST_TEST_MODE=true` cuts training to 20 iterations — use it to prove the plumbing before paying for a full run. Success leaves `result.ply` and `thumbnail.png` under `s3://ai-gaussian-splatter-dev-splats/objects/$OBJECT_ID/`.

### Web (frontend + REST API)

The REST API is served via Route Handlers in this package (`web/app/api/v1/`), backed by Postgres via Drizzle — start a database before `pnpm dev`:

```bash
podman run -d --name splat-pg --restart=always \
  -p 5432:5432 \
  -v splat-pg-data:/var/lib/postgresql \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=ai_gaussian_splatter \
  postgres:18
```

This is the only database container you need. The published port serves everything: `next dev` and `drizzle-kit` reach it on `localhost:5432`, and the `splat-web` container below comes back in through the host as `host.containers.internal:5432`. Mount the volume at `/var/lib/postgresql`, since `postgres:18` stores data in a major-version subdirectory below that. Enable the restart helper once so `--restart=always` is honored after boot:

```bash
systemctl --user enable --now podman-restart.service
```

```bash
cd web
pnpm install                # no codegen step — Drizzle's schema is plain TypeScript
cp .env.example .env        # fill in Clerk keys, database parts, buckets, worker IDs
pnpm db:migrate             # apply pending migrations (drizzle-kit migrate)
pnpm dev
```

`pnpm db:studio` opens Drizzle Studio to browse/edit rows.

After editing `web/lib/server/db/schema.ts`, run `pnpm db:generate` to emit a migration into `web/drizzle/`, read the SQL it produced, then `pnpm db:migrate` to apply it. The types update the moment you save the schema, so `tsc` will not catch a schema you forgot to generate a migration for.

### Full test suite

```bash
(cd web && pnpm typecheck && pnpm biome:ci && pnpm test && pnpm test:e2e)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && pnpm cdk:synth)
```

The `server` Vitest project's Postgres-dependent tests (rate limiting, `getOrCreateUser`, the worker callback token) skip unless `TEST_DATABASE_URL` is set — CI wires it to a service container:

```bash
(cd web && TEST_DATABASE_URL=postgresql://postgres:test@localhost:5432/ai_gaussian_splatter pnpm test)
```

### Building and running the container locally

Exercises the production path — the standalone build, not `next dev`. Also the way to test SSR locally if your environment blocks the loopback connection Next's proxy makes to itself (a host-run `next dev` then 500s on every request with `ECONNREFUSED ::1`; the container has its own netns and is unaffected).

Uses the `splat-pg` container from above — nothing extra to start.

```bash
cd web
podman build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk \
  -t splat-web:test .
podman run -d --name splat-web -p 8000:8000 \
  --env-file .env \
  -e DATABASE_HOST=host.containers.internal \
  -e APP_PUBLIC_URL=http://localhost:8000 \
  splat-web:test

curl -s http://localhost:8000/api/v1/healthz   # {"status":"ok"}
```

`--env-file .env` supplies everything else the container needs (Clerk, S3 buckets, worker IDs, fake AWS credentials) straight from the same file `next dev` and `db:migrate` already use. Only `DATABASE_HOST` and `APP_PUBLIC_URL` stay on the command line, since they differ by context: `localhost` inside a container is that container, so it reaches Postgres through `host.containers.internal` (a name Podman resolves to the host, where 5432 is published), and it serves on 8000 rather than `next dev`'s 3000. The publishable key must be a `--build-arg`, not `-e`/`--env-file`: `NEXT_PUBLIC_*` is inlined into the browser bundle at build time. It's baked in as the dummy CI key above, which won't pair with a real `CLERK_SECRET_KEY` from `.env` — so this container exercises unauthenticated paths only; pass your own publishable key as the build-arg to reach signed-in routes. Tear down with `podman rm -f splat-web` — leave `splat-pg` up, it's your dev database.

### Applying migrations to a deployed environment

The container image deliberately does not run migrations on boot (the service runs up to 3 tasks, which would race — drizzle-kit takes no advisory lock — and the running app would need DDL rights it otherwise doesn't). Run it as a deploy step instead:

`drizzle.config.ts` resolves its connection the same way the running app does (`lib/server/databaseUrl.ts`), from the `DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` parts — read those straight out of the RDS secret, plus `DATABASE_SSL_CA`:

```bash
curl -fsSo /tmp/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export DATABASE_SSL_CA=/tmp/rds-global-bundle.pem
eval "$(aws secretsmanager get-secret-value --secret-id <rds-secret-arn> \
  --query SecretString --output text | jq -r \
  '"export DATABASE_HOST=\(.host) DATABASE_PORT=\(.port) DATABASE_NAME=\(.dbname) DATABASE_USER=\(.username) DATABASE_PASSWORD=\(.password)"')"
(cd web && pnpm db:migrate)
```

`DATABASE_SSL_CA` is what makes this work against RDS at all: without it `databaseSsl()` returns undefined, drizzle-kit opens an unencrypted connection, and `rds.force_ssl = 1` refuses it. The bundle is the same one `web/Dockerfile` bakes into the image — the running task gets the path from `backend_stack.py`, but a shell running migrations has to fetch its own copy. Exported variables win over `web/.env`, which dotenv never overwrites, so a local `.env` can't redirect this at your production database.

The database lives in a private subnet, so run this from somewhere inside the VPC, not a laptop. Prefer a bastion that can reach the RDS endpoint directly: a port-forward makes the client connect to `localhost`, which fails certificate hostname verification — and the fix for *that* is disabling verification, which defeats the point of supplying the CA.

## Debugging a failed job

1. Check `jobs.status` and `jobs.error_message` for the object (`GET /api/v1/objects/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm self-termination actually fired: the instance should not still be running after the job reaches a terminal state. **If it is, terminate it by hand** — the instance-runtime alarm meant to catch this is not in any stack yet (`AGENTS.md`, Known gaps), so nothing else will.
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Deploying infra

Set these first, whichever deploy this is:

```bash
cd infra
export AWS_ACCOUNT_ID=<your real account id>   # the default placeholder account won't work
# --output text tab-separates multiple matches on one line, so filter out any
# private zone for the same name before taking the id.
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name orky.net \
  --query "HostedZones[?Name=='orky.net.' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text | cut -d/ -f3)
```

`hostedZoneId`, `clerkSecretArn`, and `imageTag` then go on **every** `cdk` invocation, `diff` and single-stack deploys included — `cdk deploy OneStack` still synthesizes the whole app, so `BackendStack` is built either way.

`hostedZoneId` is the `orky.net` zone the ALB's DNS record and its ACM certificate validation go into. Without it the placeholder zone ID is used, which fails at deploy time. The zone is imported rather than managed, so it is not part of the stack's resource set: `cdk destroy` removes the app's own A-alias record, but cannot delete the zone itself or any record the stack did not create.

`imageTag` is the commit the service runs — `git rev-parse --short HEAD` of the build you pushed. A per-release tag rather than a moving one, so every deploy writes its own task definition; that is what lets the circuit breaker roll back to an image that still exists, and what makes rolling back by hand just this flag with an older SHA. `BackendStack` refuses anything that is not a SHA, and the repository refuses to repoint a tag that already exists.

`clerkSecretArn` is the complete ARN — including Secrets Manager's six-character suffix, which is why it is captured from the CLI rather than written out — of the Clerk secret. `BackendStack` imports that secret instead of creating it, and checks the ARN against its own account and region, so a forgotten flag fails at `cdk synth` rather than silently deploying tasks that cannot start.

### First deploy: bootstrap, secret, registry, image, everything else

A fresh account needs `cdk bootstrap` once per region before any deploy — every template carries a `BootstrapVersion` SSM lookup, so without it the first stack fails before creating anything. `BudgetsStack` lives in `us-east-1`, so both regions need it:

```bash
npx cdk bootstrap aws://$AWS_ACCOUNT_ID/us-west-2 aws://$AWS_ACCOUNT_ID/us-east-1
```

The Clerk secret comes next: nothing creates it, so it has to exist before the stack that reads it. Create it with the real `CLERK_SECRET_KEY` from Clerk's dashboard:

```bash
printf '%s' 'sk_live_...' > clerk-key.txt   # printf, not echo: a trailing
                                            # newline becomes part of the key
CLERK_SECRET_ARN=$(aws secretsmanager create-secret --region us-west-2 \
  --name ai-gaussian-splatter/clerk-secret-key \
  --description "Clerk CLERK_SECRET_KEY" \
  --secret-string file://clerk-key.txt \
  --query ARN --output text)
rm clerk-key.txt
```

`file://` rather than the key itself, which would otherwise sit in shell history — and `--secret-string file://` stores the file's bytes verbatim, so a trailing newline ends up in `CLERK_SECRET_KEY` and every Clerk call fails while the deploy stays green. No `--kms-key-id`: the default `aws/secretsmanager` key already lets the task execution role decrypt, while a customer-managed key would need an `encryption_key=` on the import in `backend_stack.py` and a `kms:Decrypt` grant alongside it.

Creating it up front is what makes one deploy enough. `BackendStack` only reads this secret, so the first task to start already has the real key — nothing to put there afterwards, and no second rollout to pick it up.

`BackendStack`'s service is pinned to an image tag, so an image must already be in ECR when that stack deploys — `cdk deploy --all` on a fresh account creates an empty repository and then a service whose tasks have nothing to pull, and the deployment circuit breaker rolls `BackendStack` back. `RegistryStack` holds the repository on its own for exactly this reason. It is in `--all` like every other stack; deploying it alone first is what creates a pause for the image push, which `--all` has nowhere to stop for. Deploy it, push, then deploy everything — `RegistryStack` is a no-op the second time:

```bash
pnpm cdk:deploy:registry -c hostedZoneId=$ZONE_ID -c clerkSecretArn=$CLERK_SECRET_ARN \
  -c imageTag=$(git rev-parse --short HEAD)
aws ecr get-login-password --region us-west-2 | podman login --username AWS --password-stdin \
  $AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com
REPO=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-backend
IMAGE_TAG=$(git rev-parse --short HEAD)
podman build -t $REPO:$IMAGE_TAG \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:$IMAGE_TAG

pnpm cdk:deploy:all -c hostedZoneId=$ZONE_ID -c clerkSecretArn=$CLERK_SECRET_ARN -c imageTag=$IMAGE_TAG
```

`cdk:deploy:registry` belongs to this section only: it exists to create the repository before there is an image to push, so once the repository exists it is never run again. The stack itself is permanent, and `cdk:deploy:all` carries it like every other stack — that is how a change to it, `RELEASES_KEPT` say, actually reaches AWS.

The first deploy waits on ACM DNS validation, which can take several minutes; ACM writes the validation record into the zone itself.

`AWSServiceRoleForEC2Spot` is one account-wide role shared by every Spot workload, and `WorkerIamStack` creates it. Check first, because creating a second one fails the whole stack:

```bash
aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1 && echo "already exists"
```

If it exists, add `-c createSpotServiceLinkedRole=false` to every `cdk deploy`/`cdk diff` in this section and the stack will leave it alone. (Don't delete the role to make the default path work — that breaks Spot for everything else in the account.)

Turn on billing alerts, or `BudgetsStack`'s CloudWatch alarm never fires. `AWS/Billing EstimatedCharges` publishes no data at all until the account preference is set, and there is no API or CloudFormation resource for it — Billing console → Billing preferences → **Receive AWS Free Tier alerts and billing alerts**, in `us-east-1`. The AWS Budget half of that stack works regardless; only the alarm depends on this.

**Applying migrations is not part of `cdk deploy --all`** and must be done before the site works, even though the target group reports healthy without it — `/api/v1/healthz` never touches the database. See "Applying migrations to a deployed environment" above; without it the database has no tables and every real request 500s.

### Every deploy after that

The secret already exists, so read its ARN back rather than creating one, then diff before deploying:

```bash
CLERK_SECRET_ARN=$(aws secretsmanager describe-secret --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key --query ARN --output text)
IMAGE_TAG=$(git rev-parse --short HEAD)
pnpm cdk:diff -c hostedZoneId=$ZONE_ID -c clerkSecretArn=$CLERK_SECRET_ARN -c imageTag=$IMAGE_TAG
pnpm cdk:deploy:all -c hostedZoneId=$ZONE_ID -c clerkSecretArn=$CLERK_SECRET_ARN -c imageTag=$IMAGE_TAG
```

Pass the flags straight after the script name — **never** after a `--` separator. pnpm forwards them, but cdk's own parser then discards everything past the separator, and the app synthesizes against `app.py`'s placeholders. `BackendStack` rejects the placeholder ARN, so this fails loudly; the equivalent mistake on `hostedZoneId` alone would not.

A `web/` change is the same path with a build and push in front of it — see "Shipping a new image" below. Images need no `update-service` step: the tag is part of the task definition, so a new tag *is* a template change and `cdk deploy` rolls it out.

### Rotating the Clerk key

Changing `CLERK_SECRET_KEY` later is a write plus a rollout, because ECS resolves secrets at task start and never on live update. The ARN does not change, so no `cdk deploy` is involved:

```bash
printf '%s' 'sk_live_...' > clerk-key.txt   # no trailing newline, as above
aws secretsmanager put-secret-value --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key --secret-string file://clerk-key.txt
rm clerk-key.txt
```

Then force a new deployment, as under "Shipping a new image" below.

### Shipping a new image

The tag is part of the task definition, so building under a new commit is what rolls a release out — `cdk deploy` sees a changed template and replaces the tasks:

```bash
REPO=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-backend
IMAGE_TAG=$(git rev-parse --short HEAD)
podman build -t $REPO:$IMAGE_TAG \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:$IMAGE_TAG
pnpm cdk:deploy:all -c hostedZoneId=$ZONE_ID -c clerkSecretArn=$CLERK_SECRET_ARN -c imageTag=$IMAGE_TAG
```

The repository refuses to repoint a tag it already holds, so a rebuild of a commit that was already pushed fails at `podman push` with `ImageTagAlreadyExists`. Commit the change — even an amend gives a new SHA — and push that. This is deliberate: a repointable tag is what would leave the previous task definition naming an image that is no longer there.

`min_healthy_percent=100` keeps the old task serving until the new one passes health checks. If the new image fails them, the circuit breaker rolls back to the previous task definition, which names its own still-present tag, so ECS re-pulls the build that was working. Rolling back by hand is the same deploy with an older SHA:

```bash
pnpm cdk:deploy:all -c hostedZoneId=$ZONE_ID -c clerkSecretArn=$CLERK_SECRET_ARN -c imageTag=<older-sha>
```

Only the last few releases are kept (`RELEASES_KEPT` in `registry_stack.py`); older tags are expired and can no longer be rolled back to.

### Which release is deployed

The tag names the commit, so this answers "what code is live" without correlating push times by hand. Ask the service what it intends to run:

```bash
aws ecs describe-services --region us-west-2 \
  --cluster ai-gaussian-splatter --services ai-gaussian-splatter-backend \
  --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition' --output text
aws ecs describe-task-definition --region us-west-2 --task-definition <arn-from-above> \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

Read `deployments[?status=='PRIMARY']` rather than `services[0].taskDefinition`: mid-deploy there are two, the one rolling out and the one draining, and only this distinguishes them.

For what the running tasks actually pulled, digest included — the ground truth if a task looks out of step with the service:

```bash
aws ecs describe-tasks --region us-west-2 --cluster ai-gaussian-splatter \
  --tasks $(aws ecs list-tasks --region us-west-2 --cluster ai-gaussian-splatter \
              --service-name ai-gaussian-splatter-backend --query 'taskArns' --output text) \
  --query 'tasks[].containers[].{image:image,digest:imageDigest}'
```

Then `git log -1 <tag>` for what is in production and `git diff <tag>..HEAD` for what is not. The tag can only ever resolve to the image it was pushed with, so the mapping cannot drift.

To see which releases are still available to roll back to, newest first:

```bash
aws ecr describe-images --region us-west-2 --repository-name ai-gaussian-splatter-backend \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[].{tag:imageTags[0],pushed:imagePushedAt}' --output table
```

The `WorkerIamStack`, `DataStack`, and `RegistryStack` must exist before `BackendStack` (CDK resolves this automatically via cross-stack references in `app.py`). `BudgetsStack` deploys to `us-east-1` regardless of the app's primary region — billing metrics only exist there.

`app.py`'s `workerAmiId` context value is a placeholder (`ami-000000000000`) until the worker image is actually built and pushed (plan M5/M10) — `cdk synth`/`diff` work fine with the placeholder, but don't `deploy` the `BackendStack` with it still set, since job launches would fail.
