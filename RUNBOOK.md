# Runbook

## Dev AWS resources

The `infra/` stack only describes production, so dev's uploads/splats buckets must be created and configured by hand. `web/components/upload/PhotoDropzone.tsx` PUTs to a presigned S3 URL and the worker reads/writes both buckets via boto3, so real buckets are needed.

```bash
for b in ai-gaussian-splatter-dev-uploads ai-gaussian-splatter-dev-splats; do
  aws s3api create-bucket --bucket "$b" --region us-west-2 \
    --create-bucket-configuration LocationConstraint=us-west-2
done

# Without these rules the browser blocks both a cross-origin GET and PUT. The presigned URL is valid, so the failure
# only shows up in the browser console, which distinguishes a CORS-rule 403 from an IAM-policy 403.
#
# localhost:3000 for pnpm dev. localhost:8000 for splat-web container on localhost
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

# Create an IAM user called ai-gaussian-splatter-dev scoped to just those two buckets:
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

# Put the newly created key pair in web/.env and worker/.env as AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
aws iam create-access-key --user-name ai-gaussian-splatter-dev
```

## Worker (local pipeline run)

A real Nvidia GPU is required. Run the pipeline using the [worker image](#running-the-pipeline). That image carries CUDA and a CUDA-enabled COLMAP build, so nothing but the Nvidia GPU driver and `nvidia-container-toolkit` has to be installed locally. The toolkit lets Podman pass the host GPU into the container (`--device nvidia.com/gpu=all`).

### One-time GPU passthrough setup

```bash
# nvidia-container-toolkit isn't in Fedora's repos or RPM Fusion's. RPM Fusion nonfree carries the NVIDIA GPU driver,
# but not the toolkit.
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit

# Writes the CDI spec that podman resolves --device nvidia.com/gpu=all against. Generated as root into /etc/cdi even
# though the containers run rootless.
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

# Verify the passthrough against a stock CUDA image. nvidia-smi should report the host GPU and driver.
# --security-opt=label=disable required on every GPU run, not just this check. Without it SELinux blocks access to the
# device nodes and NVML fails with an insufficient permissions error.
podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi
```

### Capture

Walk around the object shooting individual stills — every side, a couple of heights, each shot overlapping its neighbors. Aim for ~50. The API's floor of 20 (`MIN_PHOTOS_PER_SPLAT`, HTTP 400 below it) is a hard minimum, not a quality target: more frames only help where they close a coverage gap, near-duplicates just add COLMAP matching cost, and a set whose views don't connect fails outright rather than yielding a poor splat.

Object choice matters more than photo count. COLMAP triangulates surface features that hold still, so these kinds of objects can defeat it:

- **Transparent or mirrored** — what's seen through or reflected slides as the camera moves, and every such match is discarded as an outlier.
- **Thin and flat** — front and back arcs share no features and edge-on views show almost nothing, so the orbit can't close and the reconstruction fragments.
- **A flat printed face** (poster, book cover) — a degenerate initial pair; COLMAP reports `No good initial image pair found` and gives up.

Pick something opaque, matte, and genuinely three-dimensional. Stand it on a patterned surface with static clutter in frame. A plain floor or wall gives the solve nothing to hold on to.

When a set registers poorly, `worker/jobdir/colmap/database.db` says why — guessing from the photos doesn't. Check the keypoint count per image in `keypoints`, and how many other images each one has enough inlier matches with in `two_view_geometries`: very few of either points at blur, low texture, or an orbit that doesn't connect, rather than a pipeline bug. No specific healthy thresholds are established yet. Nothing here has been checked against a real capture (`AGENTS.md`'s M0 is still pending).

### Running the pipeline

The pipeline can run standalone — nothing has to be listening at `APP_PUBLIC_URL`. `worker/pipeline/status.py` logs and swallows callback failures by design, and `terminate_self()` no-ops when IMDS doesn't answer.

```bash
cd worker # Make sure you're in the right folder.

# Build the image when anything here has changed. ./pipeline/ and ./run_job.py are copied in the final two layers, so a
# code-only edit rebuilds in seconds; touching pyproject.toml or uv.lock re-runs uv sync as well. Only a cold build
# downloads torch/CUDA.
podman build -t splat-worker:dev . # ~19 GB cold

# Create .env from the SHARED and WORKER sections of the repo root's .env.example.
export $(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|DEFAULT_REGION)=' .env)

SPLAT_ID=$(uuidgen) # Needs to be different for every run.

# Upload photo set to the dev uploads bucket. The AWS CLI reads the same AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
# AWS_DEFAULT_REGION the SDKs do, so exporting those out of .env is enough to run as the IAM user
# ai-gaussian-splatter-dev.
aws s3 sync ./photos "s3://ai-gaussian-splatter-dev-uploads/splats/$SPLAT_ID/photos/"

# The rm -rf / mkdir is required to setup ./jobdir for a new run.
rm -rf ./jobdir && mkdir ./jobdir

# Pipeline output lands in ./jobdir and will persist after the container exits. Pass -e FAST_TEST_MODE=true to reduce
# training to 20 iterations. This doesn't cut GPU memory. Every photo stays resident at full resolution whatever the
# iteration count, so a GPU smaller than a 24GB A10G needs fewer or downscaled photos to even get through a smoke test.
# Success leaves result.ply and thumbnail.png under s3://ai-gaussian-splatter-dev-splats/splats/$SPLAT_ID/.
podman run --rm \
  --security-opt=label=disable \
  --device nvidia.com/gpu=all \
  --env-file .env \
  -e SPLAT_ID=$SPLAT_ID \
  -v ./jobdir:/tmp/job \
  splat-worker:dev
```

## Web (frontend + REST API)

The REST API is served via route handlers in `web/app/api/v1/`, backed by Postgres via Drizzle.

Start the database before running `pnpm dev`:

```bash
podman run -d --name splat-pg --restart=always \
  -p 5432:5432 \
  -v splat-pg-data:/var/lib/postgresql \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=ai_gaussian_splatter \
  postgres:18
```

`pnpm dev` and `drizzle-kit` reach the database on `localhost:5432`, since they run natively rather than in a container. The `splat-web` container below reaches it on `host.containers.internal:5432` instead — Podman's built-in alias for the host, no shared network needed. Data is stored at `/var/lib/postgresql`.

One-time setup: create `web/.env` from the SHARED and WEB sections of [`.env.example`](.env.example), then fill in the Clerk keys, the dev IAM key pair, and the worker IDs. The database and bucket values already match the container above.

```bash
# Enable the restart helper once so --restart=always is honored after boot:
systemctl --user enable --now podman-restart.service

cd web          # make sure you're in the right folder
pnpm install    # no codegen step — Drizzle's schema is plain TypeScript
pnpm db:migrate # apply pending migrations (scripts/db-migrate.cjs)
pnpm dev

pnpm db:studio  # opens Drizzle Studio to browse/edit rows.
```

After editing `web/lib/server/db/schema.ts`, run `pnpm db:generate` to emit a migration into `web/drizzle/`, then `pnpm db:migrate` to apply it. The types update the moment you save the schema, so `tsc` will not catch a schema you forgot to generate a migration for.

## Full test suite

```bash
pnpm biome:ci
pnpm run scripts:check
pnpm run web:check
pnpm run worker:check
pnpm run infra:check
# Each line below runs in a subshell, so it starts from the repo root. A bare cd would leave the shell in web/ and the
# next line would fail to find its folder.
(cd web && pnpm test && pnpm test:e2e)
(cd worker && uv run pytest -v)
(cd infra && uv run pytest -v && pnpm cdk:synth)
```

The `server` Vitest project's Postgres-dependent tests (rate limiting, `getOrCreateUser`, the worker callback token) skip unless `TEST_DATABASE_URL` is set — CI wires this up itself (`.github/workflows/ci.yml`'s `web` job).

Point it at a separate database on the same `splat-pg` instance, not `ai_gaussian_splatter` itself — the test run applies migrations and writes rows, which would otherwise land in your dev data. One-time setup:

```bash
podman exec splat-pg createdb -U postgres ai_gaussian_splatter_test
```

```bash
cd web && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_gaussian_splatter_test pnpm test
```

## Building and running the splat-web container locally

Substitutes for `pnpm dev` to exercise the `splat-web` container that production runs. Uses the `splat-pg` container from above.

```bash
cd web # Make sure you're in the right folder

# The Clerk publishable key is a --build-arg because it's inlined into the browser bundle at build time.
# pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk is usable but fake. Substitute for a real Clerk publishable key to
# exercise Clerk authentication.
podman build --target web \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk \
  -t splat-web:test .

# .env supplies several important variables to the container. DATABASE_HOST, APP_PUBLIC_URL stay on the command line to
# override variables in .env. host.containers.internal is Podman's built-in alias for the host, which is where
# splat-pg (above) publishes its port — no shared network needed to reach it.
podman run -d --name splat-web -p 8000:8000 \
  --env-file .env \
  -e DATABASE_HOST=host.containers.internal \
  -e APP_PUBLIC_URL=http://localhost:8000 \
  splat-web:test

curl -s http://localhost:8000/api/v1/healthz   # should be {"status":"ok"}
```

## Applying migrations to a deployed database

**CI now applies migrations automatically on every push to `main`.** The `deploy` job in `.github/workflows/ci.yml` runs the `migrator` image (`web/Dockerfile`) as a one-off ECS task before rolling the service forward, using a real AWS deploy, not the bastion-less procedure below. What follows is for out-of-band fixes only — a migration needed outside a normal deploy, or a broken automated run to retry by hand.

The container image deliberately does not run migrations on boot (the service runs up to 3 tasks, which would race. The migrator takes no advisory lock). Run it as a deploy step instead:

`web/drizzle.config.ts` resolves its connection the same way the running app does (`web/lib/server/databaseUrl.ts`), from the `DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` parts. Read those straight out of the RDS secret, plus `DATABASE_SSL_CA`:

```bash
cd web # Make sure you're in the right folder

secret=$(aws secretsmanager get-secret-value \
  --secret-id <rds-secret-arn> \
  --query SecretString \
  --output text)

# Used to create URL to postgres DB in pnpm db:migrate
export DATABASE_HOST=$(jq -r .host <<< "$secret")
export DATABASE_PORT=$(jq -r .port <<< "$secret")
export DATABASE_NAME=$(jq -r .dbname <<< "$secret")
export DATABASE_USER=$(jq -r .username <<< "$secret")
export DATABASE_PASSWORD=$(jq -r .password <<< "$secret")

# RDS's CA bundle so that the TLS connection can be verified in pnpm db:migrate.
curl -fsSo /tmp/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export DATABASE_SSL_CA=/tmp/rds-global-bundle.pem

pnpm db:migrate
```

`DATABASE_SSL_CA` is what makes this work against RDS at all: without it `databaseSsl()` returns undefined, `pnpm db:migrate` (`web/scripts/db-migrate.cjs`) opens an unencrypted connection, and `rds.force_ssl = 1` refuses it. The bundle is the same one `web/Dockerfile` bakes into the image. The running task gets the path from `infra/stacks/web_stack.py`, but a shell running migrations has to fetch its own copy. Exported variables win over `web/.env`, which dotenv never overwrites, so a local `.env` can't redirect this at your production database.

The database lives in a private subnet, so run this from somewhere inside the VPC, not a laptop. Prefer a bastion that can reach the RDS endpoint directly: a port-forward makes the client connect to `localhost`, which fails certificate hostname verification. The fix for *that* is disabling verification, which defeats the point of supplying the CA.

## Debugging a failed job

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm self-termination actually fired: the instance should not still be running after the job reaches a terminal state. **If it is, terminate it by hand.** The instance-runtime alarm meant to catch this is not in any stack yet (`AGENTS.md`, Known gaps), so nothing else will.
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Deploying to production

**A routine push to `main` needs none of this by hand.** The `deploy` job in `.github/workflows/ci.yml` builds, migrates, and rolls the service out automatically (see "Applying migrations to a deployed database" below and "GitHub Actions OIDC role for CI deploys"). What follows is the manual flow: still the only path for a fresh account's first deploy, for infra-only changes where a human wants to run `cdk diff` first, or for a rollback.

 The variables set below are required on every `pnpm cdk:*` invocation. `RegistryStack` itself  reads none of these values, but `pnpm cdk:*` always builds the whole app first, `WebStack` included, and that's where they're required. Only `AWS_ACCOUNT_ID` needs `export`. `infra/app.py` reads it straight from its environment; the rest are only ever expanded into `-c key=value` flags by this same shell, so a plain assignment reaches them just as well.

```bash
cd infra # Make sure you're in the right folder.

export AWS_ACCOUNT_ID=<your real account id> # Use a real AWS account id.

# Where BudgetsStack sends spend alerts. Omitting it breaks pnpm cdk:*, but nothing can tell a wrong address from a
# right one, and a wrong one deploys green with the alerts never arriving. AWS emails a confirmation link on the first
# deploy. Until it's clicked the subscription stays pending and sends nothing, so check for it.
ALERT_EMAIL=<your email>

# Where the worker PATCHes job status back to, and what the ALB is aliased to. Keep it in step with APP_HOSTNAME in
# web_stack.py, which is what the certificate and the Route 53 record are built from — nothing cross-checks the two, so
# a mismatch sends every status callback at a host that won't answer.
APP_PUBLIC_URL=https://ai-gaussian-splatter.orky.net

# The AMI each job's spot instance boots. ec2Launcher.ts's user data runs aws ecr get-login-password and docker run
# --gpus all with no provisioning of its own, so the image must already carry Docker, the NVIDIA driver and container
# toolkit, and the AWS CLI. AWS's Deep Learning Base GPU AMIs do; this lists them newest first:
aws ec2 describe-images --region us-west-2 --owners amazon \
  --filters "Name=name,Values=Deep Learning Base*GPU AMI*Ubuntu*" \
            "Name=architecture,Values=x86_64" \
            "Name=state,Values=available" \
  --query 'reverse(sort_by(Images,&CreationDate))[:5].{id:ImageId,name:Name,created:CreationDate}' \
  --output table
WORKER_AMI_ID=<ami-... from the table>

# WEB_IMAGE_TAG is the pushed build SHA. Per-release, not moving — each deploy gets its own task definition, so the
# circuit breaker (and manual rollback) can point at an older SHA that still exists in the repo. WebStack requires a
# SHA; the ECR repo refuses to repoint an existing tag. migrateImageTag (the migration task's own image) is deliberately
# not passed below. It defaults to webImageTag, which is exactly what a manual "build once, deploy once" flow wants.
# ci.yml's deploy job is the one caller that ever diverges the two on purpose.
WEB_IMAGE_TAG=$(git rev-parse --short HEAD)

# One time only; Copy the real Clerk sk_live_... secret key from Clerk's dashboard to AWS Secrets Manager. On any later
# run this returns ResourceExistsException. That is the secret already being there, not a failed deploy. Skip to the
# describe-secret below; to change the value use "Rotating the Clerk key".
printf '%s' 'sk_live_...' > clerk-secret-key.txt   # printf, prevents any newline becoming part of the key.
aws secretsmanager create-secret \
  --region us-west-2 \
  --name ai-gaussian-splatter/clerk-secret-key \
  --description "clerk-secret-key" \
  --secret-string file://clerk-secret-key.txt \
  --query ARN --output text
rm clerk-secret-key.txt

# CLERK_SECRET_KEY_ARN includes Secrets Manager's six-character suffix. WebStack reads the secret and validates the
# ARN's account/region on every pnpm cdk:* invocation.
CLERK_SECRET_KEY_ARN=$(aws secretsmanager describe-secret \
  --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key \
  --query ARN \
  --output text)

# The orky.net zone for the ALB's DNS record and ACM validation. Omitting it breaks pnpm cdk:*. The zone is imported
# only, not created. It must already exist. CDK adds the app's A-alias and ACM's validation CNAME to it; nothing else
# in the zone is this app's concern.
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name orky.net \
  --query "HostedZones[?Name=='orky.net.' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text | cut -d/ -f3)

# A fresh account needs pnpm cdk:bootstrap once per region before any deploy. It creates a CDKToolkit stack that CDK
# uploads templates/assets to. Every template carries a BootstrapVersion SSM lookup, so without it the first stack fails
# before creating anything. BudgetsStack lives in us-east-1; the rest live in us-west-2.
#
# cdk.json's app command runs app.py for every CLI invocation, bootstrap included, so it still needs all six -c flags
# below even though bootstrap deploys no stack of its own. cdk bootstrap takes multiple environment targets in one call.
pnpm cdk:bootstrap aws://$AWS_ACCOUNT_ID/us-east-1 aws://$AWS_ACCOUNT_ID/us-west-2 \
  -c hostedZoneId=$HOSTED_ZONE_ID \
  -c clerkSecretKeyArn=$CLERK_SECRET_KEY_ARN \
  -c alertEmail=$ALERT_EMAIL \
  -c appPublicUrl=$APP_PUBLIC_URL \
  -c workerAmiId=$WORKER_AMI_ID \
  -c webImageTag=$WEB_IMAGE_TAG

# One time only, on a fresh account: WebStack pins the web service to an image tag, but a brand-new ECR repo starts
# empty, so pnpm cdk:deploy:all would fail trying to pull an image that was never pushed. Deploy RegistryStack by itself
# first. The image gets pushed into it below (podman push), then cdk:deploy:all can run on every change.
pnpm cdk:deploy:registry \
  -c hostedZoneId=$HOSTED_ZONE_ID \
  -c clerkSecretKeyArn=$CLERK_SECRET_KEY_ARN \
  -c alertEmail=$ALERT_EMAIL \
  -c appPublicUrl=$APP_PUBLIC_URL \
  -c workerAmiId=$WORKER_AMI_ID \
  -c webImageTag=$WEB_IMAGE_TAG

ECR_TOKEN=$(aws ecr get-login-password --region us-west-2)
REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com
REPO=$REGISTRY/ai-gaussian-splatter

# Push both images whenever you have a new build. The -migrate image backs MigrationTaskDefinition
# (infra/stacks/web_stack.py). Push it too, or a manual `aws ecs run-task` against that family has nothing to pull.
# CI's deploy job builds and pushes both the same way (ci.yml).
podman login --username AWS --password-stdin $REGISTRY <<< "$ECR_TOKEN"
podman build --target web -t $REPO:$WEB_IMAGE_TAG-web \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:$WEB_IMAGE_TAG-web
podman build --target migrator -t $REPO:$WEB_IMAGE_TAG-migrate ../web
podman push $REPO:$WEB_IMAGE_TAG-migrate

# Deploy on any change
pnpm cdk:deploy:all \
  -c hostedZoneId=$HOSTED_ZONE_ID \
  -c clerkSecretKeyArn=$CLERK_SECRET_KEY_ARN \
  -c alertEmail=$ALERT_EMAIL \
  -c appPublicUrl=$APP_PUBLIC_URL \
  -c workerAmiId=$WORKER_AMI_ID \
  -c webImageTag=$WEB_IMAGE_TAG
```

 The first deploy waits on ACM DNS validation, which can take several minutes; ACM writes the validation record into the zone itself.

`min_healthy_percent=100` will keep any old task serving until the new one passes health checks. If the new image fails those checks, the circuit breaker rolls back to the previous task definition, which names its own still-present tag, so ECS re-pulls the build that was working. Rolling back by hand is the same `cdk:deploy:all` call using an older `WEB_IMAGE_TAG`.

Only the last few releases are kept (`RELEASES_KEPT` in `infra/stacks/registry_stack.py`); older tags are expired and can no longer be rolled back to.

`AWSServiceRoleForEC2Spot` is one account-wide role shared by every Spot workload, and `WorkerIamStack` creates it. Check first, because creating a second one fails the whole stack:

```bash
aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1 && echo "already exists"
```

If it exists, add `-c createSpotServiceLinkedRole=false` to every `pnpm cdk:deploy:registry`/`pnpm cdk:deploy:all`/`pnpm cdk:diff` invocation and the stack will leave it alone. (Don't delete the role to make the default path work. That breaks Spot for everything else in the account.)

CI's `deploy` job always passes that flag: by the time it runs, the role exists either way. If the manual deploy above created it, CI's first run drops it from the template. The role itself is `RETAIN` and stays, so Spot keeps working.

Turn on billing alerts, or `BudgetsStack`'s CloudWatch alarm never fires. `AWS/Billing EstimatedCharges` publishes no data at all until the account preference is set, and there is no API or CloudFormation resource for it — Billing console → Billing preferences → **Receive AWS Free Tier alerts and billing alerts**, in `us-east-1`. The AWS Budget half of that stack works regardless; only the alarm depends on this.

**Applying migrations is not part of** `pnpm cdk:deploy:all` and must be done before the site works, even though the target group reports healthy without it — `/api/v1/healthz` never touches the database. See "Applying migrations to a deployed database" above; without it the database has no tables and every real request 500s. (CI's `deploy` job handles this automatically for a routine push to `main` — this only matters for the manual flow above.)

### GitHub Actions OIDC role for CI deploys

One-time, and only possible **after** the manual bootstrap sequence above has run at least once — the policy below names `MigrationTaskRole`'s fixed ARN and `ExecutionRole`'s CloudFormation-generated one, neither of which exists before the first `WebStack` deploy.

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
# No --thumbprint-list: IAM validates GitHub's TLS cert against its own trusted root CA library first, since GitHub's
# OIDC endpoint chains to a public CA, and only falls back to thumbprint matching when it doesn't.

cat > trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::$AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:ref:refs/heads/main"
      }
    }
  }]
}
EOF
aws iam create-role --role-name ai-gaussian-splatter-ci-deploy \
  --assume-role-policy-document file://trust-policy.json

# ExecutionRole's name is CloudFormation-generated (unlike MigrationTaskRole's fixed one below), and so is CDK's logical
# ID for it — a hash suffix like `ExecutionRole605A040B`, not the bare construct ID — so this matches by prefix instead
# of guessing the hash. Look it up once:
EXECUTION_ROLE_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name WebStack \
  --query "StackResources[?starts_with(LogicalResourceId, 'ExecutionRole')].PhysicalResourceId | [0]" \
  --output text)
EXECUTION_ROLE_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:role/$EXECUTION_ROLE_ARN"

cat > ci-deploy-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:PutImage", "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"
      ], "Resource": "arn:aws:ecr:us-west-2:$AWS_ACCOUNT_ID:repository/ai-gaussian-splatter"},
    {"Effect": "Allow", "Action": "ecs:RunTask", "Resource": [
        "arn:aws:ecs:us-west-2:$AWS_ACCOUNT_ID:task-definition/ai-gaussian-splatter-migrate:*",
        "arn:aws:ecs:us-west-2:$AWS_ACCOUNT_ID:cluster/ai-gaussian-splatter"
      ]},
    {"Effect": "Allow", "Action": ["ecs:DescribeTasks", "ecs:DescribeServices"], "Resource": "*",
      "Condition": {"ArnEquals": {"ecs:cluster": "arn:aws:ecs:us-west-2:$AWS_ACCOUNT_ID:cluster/ai-gaussian-splatter"}}},
    {"Effect": "Allow", "Action": "ecs:DescribeTaskDefinition", "Resource": "*"},
    {"Effect": "Allow", "Action": "iam:PassRole", "Resource": [
        "$EXECUTION_ROLE_ARN", "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-migrate-task"
      ]},
    {"Effect": "Allow", "Action": "sts:AssumeRole", "Resource": [
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/cdk-hnb659fds-deploy-role-$AWS_ACCOUNT_ID-*",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/cdk-hnb659fds-file-publishing-role-$AWS_ACCOUNT_ID-*",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/cdk-hnb659fds-lookup-role-$AWS_ACCOUNT_ID-*"
      ]}
  ]
}
EOF
aws iam put-role-policy --role-name ai-gaussian-splatter-ci-deploy \
  --policy-name deploy --policy-document file://ci-deploy-policy.json
```

`sts:AssumeRole` on the CDK bootstrap roles needs no trust-policy change on their end — they already trust any principal in the same account (`Principal: {"AWS": <account>}`), gated only by the assuming principal's own identity policy, which is exactly what the statement above grants. The trailing `-*` covers both `us-west-2` (everything but `BudgetsStack`) and `us-east-1` (`BudgetsStack` only, billing metrics only exist there). `pnpm cdk:deploy:all` deploys both in one invocation, so both regions' bootstrap roles are needed even though the app's primary region is `us-west-2`. `ecs:DescribeTaskDefinition` has no resource-level permissions to scope to, hence `Resource: "*"`. `ecs:RunTask`'s task-definition ARN uses the wildcard-revision form (`:*`), not a pinned revision. A pinned one would break on every new migration image push, since each push registers a new revision.

Then set these as GitHub repository variables (Settings → Secrets and variables → Actions → Variables) — `.github/workflows/ci.yml`'s `deploy` job reads them as `vars.*`: `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID`, `CLERK_SECRET_KEY_ARN`, `ALERT_EMAIL`, `APP_PUBLIC_URL`, `WORKER_AMI_ID`, `CLERK_PUBLISHABLE_KEY` (the `pk_live_...` key, not the secret one). Live re-resolution (`aws route53 list-hosted-zones-by-name`, etc.) was deliberately skipped for these in CI — one production environment, rarely-changing values, and a `vars.*` edit is itself a reviewable, logged event, unlike giving the CI role extra read permissions just to re-derive them every run.

### Rotating the Clerk key

Changing `CLERK_SECRET_KEY` later is a write plus a rollout, because ECS only resolves secrets at task start.

```bash
printf '%s' 'sk_live_...' > clerk-secret-key.txt
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key \
  --secret-string file://clerk-secret-key.txt
rm clerk-secret-key.txt

# Nothing has changed image wise so force a new deployment to use that fresh Clerk secret key.
aws ecs update-service --region us-west-2 \
  --cluster ai-gaussian-splatter --service ai-gaussian-splatter-web \
  --force-new-deployment

```

This is the one rollout that is not a deploy, which is why `CLUSTER_NAME`/`SERVICE_NAME` are fixed in `infra/stacks/web_stack.py` rather than left to CloudFormation. The command can be written out here instead of looked up.

### Which release is deployed

The tag names the commit, so this answers "what code is live" without correlating push times by hand. Ask the service what it intends to run:

```bash
aws ecs describe-services --region us-west-2 \
  --cluster ai-gaussian-splatter --services ai-gaussian-splatter-web \
  --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition' --output text
aws ecs describe-task-definition --region us-west-2 --task-definition <arn-from-above> \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

Read `deployments[?status=='PRIMARY']` rather than `services[0].taskDefinition`: mid-deploy there are two, the one rolling out and the one draining, and only this distinguishes them.

For what the running tasks actually pulled, digest included — the ground truth if a task looks out of step with the service:

```bash
aws ecs describe-tasks --region us-west-2 --cluster ai-gaussian-splatter \
  --tasks $(aws ecs list-tasks --region us-west-2 --cluster ai-gaussian-splatter \
              --service-name ai-gaussian-splatter-web --query 'taskArns' --output text) \
  --query 'tasks[].containers[].{image:image,digest:imageDigest}'
```

Then `git log -1 <sha>` for what is in production and `git diff <sha>..HEAD` for what is not, where `<sha>` is the tag with its `-web`/`-migrate` suffix removed. The tag can only ever resolve to the image it was pushed with, so the mapping cannot drift.

To see which releases are still available to roll back to, newest first:

```bash
aws ecr describe-images --region us-west-2 --repository-name ai-gaussian-splatter \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[].{tag:imageTags[0],pushed:imagePushedAt}' --output table
```

The `WorkerIamStack`, `DataStack`, and `RegistryStack` must exist before `WebStack` (CDK resolves this automatically via cross-stack references in `infra/app.py`). `BudgetsStack` deploys to `us-east-1` regardless of the app's primary region. Billing metrics only exist there.

Against a real `AWS_ACCOUNT_ID`, `read_context` refuses every placeholder it defines — `workerAmiId`, `alertEmail`, `hostedZoneId`, `webImageTag` — by name, so a forgotten `-c` flag fails at synth rather than deploying green and breaking a job launch or a spend alert later. `pnpm cdk:synth`/`pnpm cdk:diff` on a clean checkout still work with no flags and no credentials, because the placeholder account is what tells the two apart. `migrateImageTag` is the one flag with no placeholder to refuse. It silently defaults to `webImageTag` when omitted, which is what every command above relies on. Passing a real AMI is not on its own enough to make a job run: the worker still has no ECR repository or pull permissions (`AGENTS.md`, gap 5, M5).
