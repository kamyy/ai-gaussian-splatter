# Runbook

## Local development

### Development AWS resources (two S3 buckets)

The deployed stack's VPC, ALB, and Fargate service exist to serve production from the cloud whereas `pnpm dev` serves from localhost. `components/upload/PhotoDropzone.tsx` PUTs to a presigned S3 URL and the worker reads/writes both buckets via boto3, so real buckets are needed.

The `infra/` stack only describes production so create the dev buckets by hand as outlined below:

```bash
for b in ai-gaussian-splatter-dev-uploads ai-gaussian-splatter-dev-splats; do
  aws s3api create-bucket --bucket "$b" --region us-west-2 \
    --create-bucket-configuration LocationConstraint=us-west-2
done

# Without these rules the browser blocks both a cross-origin GET and PUT — the presigned
# URL is valid, so the failure only shows up in the browser console.
#
# localhost:3000 for `pnpm dev`.
# localhost:8000 for splat-web container running on localhost
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

# Create an IAM user called `ai-gaussian-splatter-dev` scoped to just those two buckets:
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

# Put the newly created key pair in web/.env and worker/.env as AWS_ACCESS_KEY_ID and 
# AWS_SECRET_ACCESS_KEY. A 403 on the browser PUT points at the CORS rule or this policy.
# The browser console will distinguish between them.
aws iam create-access-key --user-name ai-gaussian-splatter-dev
```

### Worker (local pipeline run)

A real Nvidia GPU is required. Run the pipeline using the [worker image](#running-the-pipeline). That image carries CUDA and a CUDA-enabled COLMAP build, so nothing but the driver and `nvidia-container-toolkit` has to be installed locally. The toolkit lets Podman pass the host GPU into the container (`--device nvidia.com/gpu=all`).

#### One-time GPU passthrough setup

`nvidia-container-toolkit` isn't in Fedora's repos or RPM Fusion's (RPM Fusion nonfree carries the NVIDIA driver, not the toolkit) — it comes from NVIDIA's own repo:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit

# Writes the CDI spec that podman resolves `--device nvidia.com/gpu=all` against.
# Generated as root into /etc/cdi even though the containers run rootless.
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

# Verify the passthrough against a stock CUDA image. nvidia-smi should report the 
# host GPU and driver. --security-opt=label=disable` required on every GPU run, 
# not just this check. Without it SELinux blocks access to the device nodes and 
# NVML fails with an insufficient permissions error.
podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi
```

#### Capture

Walk around the object shooting individual stills — every side, a couple of heights, each shot overlapping its neighbors. Aim for ~50. The API's floor of 20 (`MIN_PHOTOS_PER_SPLAT`, HTTP 400 below it) is a hard minimum, not a quality target: more frames only help where they close a coverage gap, near-duplicates just add COLMAP matching cost, and a set whose views don't connect fails outright rather than yielding a poor splat.

Object choice matters more than photo count. COLMAP triangulates surface features that hold still, so three kinds of object defeat it:

- **Transparent or mirrored** — what's seen through or reflected slides as the camera moves, and every such match is discarded as an outlier.
- **Thin and flat** — front and back arcs share no features and edge-on views show almost nothing, so the orbit can't close and the reconstruction fragments.
- **A flat printed face** (poster, book cover) — a degenerate initial pair; COLMAP reports `No good initial image pair found` and gives up.

Pick something opaque, matte, and genuinely three-dimensional. Stand it on a patterned surface with static clutter in frame: a plain floor or wall gives the solve nothing to hold onto where the object's own features drop out.

When a set registers poorly, `./jobdir/database.db` says why — guessing from the photos doesn't. Per image, count the keypoints in `keypoints`, and the partners in `two_view_geometries` with 100+ inlier rows:

| Keypoints | Partners | Reading |
|---|---|---|
| 10k+ | 6–12 | healthy orbit |
| 10k+ | 0–3 | the views themselves don't connect |
| a few thousand | any | blur, or bare featureless surfaces |

#### Running the pipeline

The pipeline runs standalone — nothing has to be listening at `BACKEND_URL`. `pipeline/status.py` logs and swallows callback failures by design, and `terminate_self()` no-ops when IMDS doesn't answer.

```bash
# Build the image when ./worker/ has changed — source is copied in the final two layers.
# A code-only edit rebuilds in seconds and only a cold build has to download torch/CUDA.
podman build -t splat-worker:dev worker/ # ~19 GB cold

# Create `worker/.env` from the SHARED and WORKER sections of .env.example.
export $(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|DEFAULT_REGION)=' worker/.env)

SPLAT_ID=$(uuidgen) # Needs to be different for every run.

# Upload photo set to the dev uploads bucket. The AWS CLI reads the same AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION the SDKs do, so exporting those out of 
# worker/.env is enough to run as the IAM user ai-gaussian-splatter-dev.
aws s3 sync ./photos "s3://ai-gaussian-splatter-dev-uploads/splats/$SPLAT_ID/photos/"

# The `rm -rf`/`mkdir` is required to setup ./jobdir for a new run.
rm -rf ./jobdir && mkdir ./jobdir

# Pipeline output lands in ./jobdir and will persist after the container exits.
# Pass `-e FAST_TEST_MODE=true` to cut training to 20 iterations. It does not cut GPU memory. 
# Every photo stays resident at full resolution whatever the iteration count, so a GPU 
# smaller than a 24GB A10G needs fewer or downscaled photos to get through even a smoke test.
podman run --rm \
  --security-opt=label=disable \
  --device nvidia.com/gpu=all \
  --env-file worker/.env \
  -e SPLAT_ID=$SPLAT_ID \
  -v ./jobdir:/tmp/job \
  splat-worker:dev

# Success leaves result.ply and thumbnail.png under 
# s3://ai-gaussian-splatter-dev-splats/splats/$SPLAT_ID/.
```

Botocore's region setting reads `AWS_DEFAULT_REGION` only, never `AWS_REGION` — which is why `.env.example`'s SHARED section carries both names. With neither set `boto3.client("s3")` silently falls back to the global endpoint while `boto3.client("ec2")` raises `NoRegionError`. On a real worker instance the region comes from IMDS instead, so this matters only for local runs.


### Web (frontend + REST API)

The REST API is served via route handlers in `web/app/api/v1/`, backed by Postgres via Drizzle. Start the database before running `pnpm dev`:

```bash
podman run -d --name splat-pg --restart=always \
  -p 5432:5432 \
  -v splat-pg-data:/var/lib/postgresql \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=ai_gaussian_splatter \
  postgres:18
```

 `pnpm dev` and `drizzle-kit` reach the database on `localhost:5432`, and the `splat-web` container below comes back in through the host as `host.containers.internal:5432`. Data is stored at `/var/lib/postgresql`.

One-time setup: create `web/.env` from the SHARED and WEB sections of [`.env.example`](.env.example), then fill in the Clerk keys, the dev IAM key pair, and the worker IDs. The database and bucket values already match the container above.

```bash
# Enable the restart helper once so `--restart=always` is honored after boot:
systemctl --user enable --now podman-restart.service

cd web          # make sure you're in the right folder
pnpm install    # no codegen step — Drizzle's schema is plain TypeScript
pnpm db:migrate # apply pending migrations (drizzle-kit migrate)
pnpm dev

pnpm db:studio # opens Drizzle Studio to browse/edit rows.
```

After editing `web/lib/server/db/schema.ts`, run `pnpm db:generate` to emit a migration into `web/drizzle/`, then `pnpm db:migrate` to apply it. The types update the moment you save the schema, so `tsc` will not catch a schema you forgot to generate a migration for.

### Full test suite

```bash
# Subshells, so each line starts from the repo root — a bare `cd` would leave
# the shell in web/ and the next two lines would fail to find their folder.
(cd web && pnpm typecheck && pnpm biome:ci && pnpm test && pnpm test:e2e)
(cd worker && uv run ruff check . && uv run mypy pipeline && uv run pytest -v)
(cd infra && uv run ruff check . && uv run mypy app.py stacks && uv run pytest -v && pnpm cdk:synth)
```

The `server` Vitest project's Postgres-dependent tests (rate limiting, `getOrCreateUser`, the worker callback token) skip unless `TEST_DATABASE_URL` is set — CI wires it to a service container:

```bash
cd web && TEST_DATABASE_URL=postgresql://postgres:test@localhost:5432/ai_gaussian_splatter pnpm test
```

### Building and running the splat-web container locally

Substitutes for `pnpm dev` to exercise the `splat-web` container that production also runs. Uses the `splat-pg` container from above — nothing extra to start.

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

`--env-file .env` supplies Clerk, S3 buckets, worker IDs, fake AWS credentials to the container. `DATABASE_HOST` and `APP_PUBLIC_URL` stay on the command line because they differ by context. The container reaches Postgres via `host.containers.internal` and it serves on 8000. The Clerk publishable key must be a `--build-arg` because it's inlined into the browser bundle at build time. Tear down with `podman rm -f splat-web` — leave your dev database `splat-pg` up.

The `--build-arg` above uses a secret key that isn't real: it parses, so the app boots and public pages render, but it never pairs with the real `CLERK_SECRET_KEY` coming from `.env` and therefore every signed-in route fails. Build with your own `pk_test_...` secret key to exercise auth.

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

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm self-termination actually fired: the instance should not still be running after the job reaches a terminal state. **If it is, terminate it by hand** — the instance-runtime alarm meant to catch this is not in any stack yet (`AGENTS.md`, Known gaps), so nothing else will.
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Deploying infrastructure on AWS

 The exports listed below are required on every `pnpm cdk:*` invocation. `RegistryStack` itself  reads none of these values, but `cdk synth` always builds the whole app first, `BackendStack` included, and that's where they're required. The commands interleaved between the exports are not: `create-secret`, `cdk:bootstrap`, and `cdk:deploy:registry` each run once for the life of the account, and each says so above itself.

```bash
cd infra # Make sure you're in the right folder.

export AWS_ACCOUNT_ID=<your real account id> # Use a real AWS account id.

# Where BudgetsStack sends spend alerts. Nothing validates this address, so a wrong one deploys 
# green and the alerts never arrive. AWS emails a confirmation link on the first deploy — until 
# it's clicked the subscription stays pending and sends nothing.
export ALERT_EMAIL=<your email>

# IMAGE_TAG is the pushed build SHA. Per-release, not moving — each deploy gets its own task definition, 
# so the circuit breaker (and manual rollback) can point at an older SHA that still exists in the repo. 
# BackendStack requires a SHA; the ECR repo refuses to repoint an existing tag.
export IMAGE_TAG=$(git rev-parse --short HEAD)

# One time only; Copy the real Clerk sk_live_... secret key from Clerk's dashboard to AWS Secrets Manager.
# On any later run this returns ResourceExistsException — that is the secret already being there, not a 
# failed deploy. Skip to the describe-secret below; to change the value use "Rotating the Clerk key".
printf '%s' 'sk_live_...' > clerk-secret-key.txt   # printf, prevents any newline becoming part of the key.
aws secretsmanager create-secret --region us-west-2 \
  --name ai-gaussian-splatter/clerk-secret-key \
  --description "clerk-secret-key" \
  --secret-string file://clerk-secret-key.txt \
  --query ARN --output text
rm clerk-secret-key.txt

# CLERK_SECRET_KEY_ARN includes Secrets Manager's six-character suffix. BackendStack reads the secret and 
# validates the ARN's account/region in `pnpm cdk:synth`.
export CLERK_SECRET_KEY_ARN=$(aws secretsmanager describe-secret \
  --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key \
  --query ARN \
  --output text)

# The orky.net zone for the ALB's DNS record and ACM validation. Omitting it deploys against a 
# placeholder and fails. The zone is imported only, so must be managed out-of-band.
export HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name orky.net \
  --query "HostedZones[?Name=='orky.net.' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text | cut -d/ -f3)

# A fresh account needs pnpm cdk:bootstrap once per region before any deploy. It creates a CDKToolkit 
# stack that CDK uploads templates/assets to. Every template carries a BootstrapVersion SSM lookup, so 
# without it the first stack fails before creating anything. BudgetsStack lives in `us-east-1`; the 
# rest live in `us-west-2`.
pnpm cdk:bootstrap aws://$AWS_ACCOUNT_ID/us-east-1
pnpm cdk:bootstrap aws://$AWS_ACCOUNT_ID/us-west-2

# BackendStack pins the web service to an image tag, so the image must already be in the ECR repo. 
# pnpm cdk:deploy:all on a fresh account creates an empty ECR repo with no image to pull. So one 
# time only, deploy RegistryStack by itself first.
pnpm cdk:deploy:registry \
  -c hostedZoneId=$HOSTED_ZONE_ID \
  -c clerkSecretKeyArn=$CLERK_SECRET_KEY_ARN \
  -c alertEmail=$ALERT_EMAIL \
  -c imageTag=$IMAGE_TAG

ECR_TOKEN=$(aws ecr get-login-password --region us-west-2)
REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com
REPO=$REGISTRY/ai-gaussian-splatter-backend

# Push the image whenever you have a new web build
podman login --username AWS --password-stdin $REGISTRY <<< "$ECR_TOKEN"
podman build -t $REPO:$IMAGE_TAG \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:$IMAGE_TAG

# Deploy on any change
pnpm cdk:deploy:all \
  -c hostedZoneId=$HOSTED_ZONE_ID \
  -c clerkSecretKeyArn=$CLERK_SECRET_KEY_ARN \
  -c alertEmail=$ALERT_EMAIL \
  -c imageTag=$IMAGE_TAG
```

 The first deploy waits on ACM DNS validation, which can take several minutes; ACM writes the validation record into the zone itself.

`min_healthy_percent=100` will keep any old task serving until the new one passes health checks. If the new image fails those checks, the circuit breaker rolls back to the previous task definition, which names its own still-present tag, so ECS re-pulls the build that was working. Rolling back by hand is the same `cdk:deploy:all` call using an older `IMAGE_TAG`.

Only the last few releases are kept (`RELEASES_KEPT` in `registry_stack.py`); older tags are expired and can no longer be rolled back to.

`AWSServiceRoleForEC2Spot` is one account-wide role shared by every Spot workload, and `WorkerIamStack` creates it. Check first, because creating a second one fails the whole stack:

```bash
aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1 && echo "already exists"
```

If it exists, add `-c createSpotServiceLinkedRole=false` to every `pnpm cdk:deploy:registry`/`pnpm cdk:deploy:all`/`pnpm cdk:diff` invocation and the stack will leave it alone. (Don't delete the role to make the default path work — that breaks Spot for everything else in the account.)

Turn on billing alerts, or `BudgetsStack`'s CloudWatch alarm never fires. `AWS/Billing EstimatedCharges` publishes no data at all until the account preference is set, and there is no API or CloudFormation resource for it — Billing console → Billing preferences → **Receive AWS Free Tier alerts and billing alerts**, in `us-east-1`. The AWS Budget half of that stack works regardless; only the alarm depends on this.

**Applying migrations is not part of** `pnpm cdk:deploy:all` and must be done before the site works, even though the target group reports healthy without it — `/api/v1/healthz` never touches the database. See "Applying migrations to a deployed environment" above; without it the database has no tables and every real request 500s.

### Rotating the Clerk key

Changing `CLERK_SECRET_KEY` later is a write plus a rollout, because ECS only resolves secrets at task start.

```bash
printf '%s' 'sk_live_...' > clerk-secret-key.txt
aws secretsmanager put-secret-value --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key --secret-string file://clerk-secret-key.txt
rm clerk-secret-key.txt

# Nothing has changed image wise so force a new deployment to use that fresh Clerk secret key.
aws ecs update-service --region us-west-2 \
  --cluster ai-gaussian-splatter --service ai-gaussian-splatter-backend \
  --force-new-deployment

```

This is the one rollout that is not a deploy, which is why `CLUSTER_NAME`/`SERVICE_NAME` are fixed in `backend_stack.py` rather than left to CloudFormation — the command can be written out here instead of looked up.

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

`app.py`'s `workerAmiId` context value is a placeholder (`ami-000000000000`) until the worker image is actually built and pushed (plan M5/M10) — `pnpm cdk:synth`/`pnpm cdk:diff` work fine with the placeholder, but don't run `pnpm cdk:deploy:all` against `BackendStack` with it still set, since job launches would fail.
