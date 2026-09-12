# Runbook

## Dev AWS resources

The `infra/` config only describes production, so dev's uploads/splats buckets must be created and configured by hand. `web/components/upload/PhotoDropzone.tsx` PUTs to a presigned S3 URL and the worker reads/writes both buckets via boto3, so real buckets are needed.

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

When a set registers poorly, `worker/jobdir/colmap/database.db` says why — guessing from the photos doesn't. Check the keypoint count per image in `keypoints`, and how many other images each one has enough inlier matches with in `two_view_geometries`: very few of either points at blur, low texture, or an orbit that doesn't connect, rather than a pipeline bug. No specific healthy thresholds are established yet. Nothing here has been checked against a real capture (M0 in [State / what's next](AGENTS.md#state--whats-next) is still pending).

### Running the pipeline

The pipeline can run standalone — nothing has to be listening at `APP_PUBLIC_URL`. `worker/pipeline/status.py` logs and swallows callback failures by design, and `terminate_self()` no-ops when IMDS doesn't answer.

```bash
cd worker # Make sure you're in the right folder.

# Build the image when anything here has changed. ./pipeline/ and ./run_job.py are copied in the final two layers, so a
# code-only edit rebuilds in seconds; touching pyproject.toml or uv.lock re-runs uv sync as well. Only a cold build
# downloads torch/CUDA.
podman build -t splat-worker:dev . # ~19 GB cold

# Create .env from worker/.env.example.
export $(grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|DEFAULT_REGION)=' .env)

SPLAT_ID=$(uuidgen) # Needs to be different for every run.

# Upload photo set to the dev uploads bucket. The AWS CLI reads the same AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
# AWS_DEFAULT_REGION the SDKs do, so exporting those out of .env is enough to run as the IAM user
# ai-gaussian-splatter-dev.
aws s3 sync ./photos "s3://ai-gaussian-splatter-dev-uploads/splats/$SPLAT_ID/photos/"

# The rm -rf / mkdir is required to setup ./jobdir for a new run.
rm -rf ./jobdir && mkdir ./jobdir

# A full run is two container runs, one per STAGE, because in production each stage is its own spot instance and the
# pause between them is where the user decides whether to pay for training. STAGE is passed with -e rather than living
# in .env for the same reason SPLAT_ID is: it differs between the two runs.
#
# Pipeline output lands in ./jobdir and will persist after the container exits. The reconstruct stage leaves the COLMAP
# workspace in ./jobdir/colmap and uploads the sparse model and point_cloud.ply under
# s3://ai-gaussian-splatter-dev-splats/splats/$SPLAT_ID/.
podman run --rm \
  --security-opt=label=disable \
  --device nvidia.com/gpu=all \
  --env-file .env \
  -e SPLAT_ID=$SPLAT_ID \
  -e STAGE=reconstruct \
  -v ./jobdir:/tmp/job \
  splat-worker:dev

# The train stage downloads the sparse model the reconstruct stage uploaded, so it needs nothing left in ./jobdir and
# can run on a different machine or days later. Pass -e FAST_TEST_MODE=true to reduce training to 20 iterations. This
# doesn't cut GPU memory. Every photo stays resident at full resolution whatever the iteration count, so a GPU smaller
# than a 24GB A10G needs fewer or downscaled photos to even get through a smoke test.
# Success leaves result.ply and thumbnail.png under s3://ai-gaussian-splatter-dev-splats/splats/$SPLAT_ID/.
podman run --rm \
  --security-opt=label=disable \
  --device nvidia.com/gpu=all \
  --env-file .env \
  -e SPLAT_ID=$SPLAT_ID \
  -e STAGE=train \
  -v ./jobdir:/tmp/job \
  splat-worker:dev
```

### Triggering the worker from pnpm dev

Set `WORKER_LOCAL_LAUNCH=true` in `web/.env` to make the web app's Process button run the worker on your own GPU
instead of launching a real EC2 spot instance. `web/lib/server/ec2Launcher.ts`'s `launchJobLocal()` then does what the
[Running the pipeline](#running-the-pipeline) command above does by hand: it shells out to `podman run` against the
`splat-worker:dev` image, with output landing in `worker/jobdir/<jobId>/worker.log` for the same
[registration debugging](#capture) the manual flow uses. Requires the same one-time
[GPU passthrough setup](#one-time-gpu-passthrough-setup) and an image already built via `podman build` above — this
path never builds it for you.

```bash
cd worker && podman build -t splat-worker:dev . # once, and again after any worker code change
cd ../web && pnpm dev
```

Upload photos and click Process in the browser as normal — the job goes through the same DB rows, callback token, and
`/api/v1/internal/jobs/[jobId]/status` route a real EC2 run would use, so its status updates in the dashboard live.
Leave `WORKER_LOCAL_LAUNCH` unset (or `false`) to go back to launching a real spot instance; `WORKER_AMI_ID` and the
rest of that block stay unused either way.

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

One-time setup: create `web/.env` from [`web/.env.example`](web/.env.example), then fill in the Clerk keys, the dev IAM key pair, and the worker IDs. The database and bucket values already match the container above.

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
(cd infra && terraform test)
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

# The Clerk publishable key is a --build-arg because it's inlined into the browser bundle at build time. Every route,
# not just authenticated ones, 500s unless this is a real key.
podman build --target web --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_test_...> -t splat-web:test .

# .env supplies several important variables to the container. DATABASE_HOST, APP_PUBLIC_URL stay on the command line to
# override variables in .env. host.containers.internal is Podman's built-in alias for the host, which is where
# splat-pg (above) publishes its port — no shared network needed to reach it.
podman run -d --name splat-web -p 8000:8000 --env-file .env \
  -e DATABASE_HOST=host.containers.internal \
  -e APP_PUBLIC_URL=http://localhost:8000 \
  splat-web:test

curl -s http://localhost:8000/api/v1/healthz   # should be {"status":"ok"}
```

## Deploying to production

**This whole section is one-time setup, not something repeated per release.** It walks a fresh account to the point where `.github/workflows/ci.yml`'s `deploy` job can take over every future deploy: push to `main`, and CD builds, migrates, and rolls the service out on its own (see ["Fixing a bad migration"](#fixing-a-bad-migration) and ["Configuring continuous deployment"](#configuring-continuous-deployment) below). After that, a human runs `terraform` by hand again only for two rare exceptions: a rollback, or previewing an infra change with `terraform plan` before it applies — both reuse the same variable values and commands below.

Start by finishing **[First-time account setup](#first-time-account-setup)** before `terraform apply`. Those steps create the Clerk secret, create `AWSServiceRoleForEC2Spot` if it doesn't already exist, turn on billing alerts, bootstrap the Terraform state backend, and stand up the ECR repository. Skip the secret and tasks fail at start: the web/migration task definitions reference it rather than creating it. Skip the Spot role and the failure doesn't surface until the first real worker job tries to launch a Spot instance. Skip the bootstrap and `terraform init` fails before creating anything. Skip the registry (or the push into it) and Fargate has nothing to pull; the circuit breaker rolls the service back. ["Configuring continuous deployment"](#configuring-continuous-deployment) is also one-time, but it needs the web service's IAM roles to already exist, so it waits until after the first full apply.

### Resolving variable values

Every `terraform` invocation below — the full apply, and a diff preview — needs the same six values. Resolve them once per shell session and reuse them for everything that follows. Terraform reads a `TF_VAR_<name>` environment variable for the matching variable automatically, matching each name in `infra/variables.tf`, so once these are exported no invocation below needs a repeated `-var` flag. `AWS_ACCOUNT_ID` isn't a Terraform variable — it's used below to name the state bucket and build the CI role's ARN — so export it separately.

```bash
export AWS_ACCOUNT_ID=replace-with-your-account-id # Use a real AWS account id.
```

`TF_VAR_alert_email` is where the AWS Budget and CloudWatch billing alarm (`infra/budgets.tf`) send spend alerts. Omitting it fails `terraform plan`/`apply` immediately, but nothing can tell a wrong address from a right one, and a wrong one applies green with the alerts never arriving. AWS emails a confirmation link on the first apply; until it's clicked the subscription stays pending and sends nothing, so check for it.

```bash
export TF_VAR_alert_email=replace-with-your-email
```

`TF_VAR_app_public_url` is where the worker PATCHes job status back to, and what the ALB is aliased to. Keep it in step with `local.app_hostname` in `infra/locals.tf`, which is what the certificate and the Route 53 record are built from — nothing cross-checks the two, so a mismatch sends every status callback at a host that won't answer.

```bash
export TF_VAR_app_public_url=https://ai-gaussian-splatter.orky.net
```

`TF_VAR_worker_ami_id` is the AMI each job's spot instance boots. `ec2Launcher.ts`'s user data runs `aws ecr get-login-password` and `docker run --gpus all` with no provisioning of its own, so the image must already carry Docker, the NVIDIA driver and container toolkit, and the AWS CLI. AWS's Deep Learning Base GPU AMIs do; this lists them newest first:

```bash
aws ec2 describe-images --region us-west-2 --owners amazon \
  --filters "Name=name,Values=Deep Learning Base*GPU AMI*Ubuntu*" \
            "Name=architecture,Values=x86_64" \
            "Name=state,Values=available" \
  --query 'reverse(sort_by(Images,&CreationDate))[:5].{id:ImageId,name:Name,created:CreationDate}' \
  --output table
export TF_VAR_worker_ami_id=<ami-... from the table>
```

`TF_VAR_web_image_tag` is the pushed build SHA. Per-release, not moving — each deploy gets its own task definition, so the circuit breaker (and manual rollback) can point at an older SHA that still exists in the repo. `infra/variables.tf`'s validation block requires a SHA; the ECR repo refuses to repoint an existing tag. `migrate_image_tag` (the migration task's own image) is deliberately not passed below. It defaults to `web_image_tag`, which is exactly what a manual "build once, deploy once" flow wants. `ci.yml`'s `deploy` job is the one caller that ever diverges the two on purpose.

```bash
export TF_VAR_web_image_tag=$(git rev-parse --short HEAD)
```

`TF_VAR_clerk_secret_key_arn` includes Secrets Manager's six-character suffix. ECS matches a task definition's `valueFrom` against that suffix, so a partial ARN applies clean and only fails at task start. This `describe-secret` call needs the Clerk secret to already exist, so only run this after creating the secret in ["First-time account setup"](#first-time-account-setup).

```bash
export TF_VAR_clerk_secret_key_arn=$(aws secretsmanager describe-secret \
  --region us-west-2 \
  --secret-id ai-gaussian-splatter/clerk-secret-key \
  --query ARN \
  --output text)
```

`TF_VAR_hosted_zone_id` is the orky.net zone for the ALB's DNS record and ACM validation. Omitting it fails `terraform plan`/`apply`. The zone is referenced only, not created — it must already exist. Terraform adds the app's A-alias and ACM's validation CNAME to it; nothing else in the zone is this app's concern.

```bash
export TF_VAR_hosted_zone_id=$(aws route53 list-hosted-zones-by-name \
  --dns-name orky.net \
  --query "HostedZones[?Name=='orky.net.' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text | cut -d/ -f3)
```

### First-time account setup

One-time per account. Complete all this before the first `terraform apply`.

Clerk secret is referenced, not created by this config. See `describe-secret` in ["Resolving variable values"](#resolving-variable-values) to retrieve the ARN for the value. To change the value later, update it directly in Secrets Manager, then force a new ECS deployment (`aws ecs update-service --force-new-deployment`) since ECS only resolves secrets at task start.

```bash
aws secretsmanager create-secret \
  --region us-west-2 \
  --name ai-gaussian-splatter/clerk-secret-key \
  --description "clerk-secret-key" \
  --secret-string <sk_live_...> \
  --query ARN --output text
```

`AWSServiceRoleForEC2Spot` is also not created by this config. It's one account-wide role shared by every other Spot workload in the account. It has to exist before `ec2Launcher.ts`'s first `RunInstances` call. This app cannot auto-create it. Trying to create it a second time fails outright, hence the guard before  creating it:

```bash
aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1 || \
  aws iam create-service-linked-role --aws-service-name spot.amazonaws.com
```

Turn on billing alerts, or the CloudWatch billing alarm (`infra/budgets.tf`) never fires. `AWS/Billing EstimatedCharges` publishes no data at all until the account preference is set, and there is no API or Terraform resource for it — Billing console → Billing preferences → **Receive AWS Free Tier alerts and billing alerts**, in `us-east-1`. The AWS Budget half works regardless; only the alarm depends on this.

That console checkbox only wires up the alarm; it isn't where spend itself is visible. To see current estimated month-to-date spend, Billing console → **Billing Home** shows it on the landing page; **Cost Explorer** breaks it down by service. To check the budget directly instead of hunting the console, `aws budgets describe-budgets --account-id $AWS_ACCOUNT_ID --region us-east-1` returns its `CalculatedSpend` — the Budgets API is `us-east-1`-only regardless of the resources it's tracking.

Now resolve the six variable values in ["Resolving variable values"](#resolving-variable-values) above, in the same shell.

A fresh account needs the Terraform state backend bootstrapped once. `infra/bootstrap/` is a separate, tiny root module (its own local state) that creates only the S3 bucket `infra/`'s own `backend "s3"` block points at — nothing in `infra/`'s real config can apply before that bucket exists. It takes no variables at all.

```bash
cd infra/bootstrap # Make sure you're in the right folder.

terraform init
terraform apply
terraform output state_bucket # confirm the bucket name, used below
```

Now initialize `infra/` itself against that bucket, and deploy the ECR repository by itself first. Then push both images under ["Going live"](#going-live). This order matters: a plain `terraform apply` would try to create the web service too, and the web service pins to a specific image tag — running it before the registry exists and the web image is pushed leaves nothing to pull.

```bash
cd ../ # Back to infra/.

terraform init \
  -backend-config="bucket=ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID" \
  -backend-config="key=infra.tfstate" \
  -backend-config="region=us-west-2"

# -target is otherwise best avoided with Terraform (it can leave state subtly out of sync with config), but this
# is a deliberate one-time exception: the ECR repository has to exist before either image can be pushed, and the
# web service can't be created before the image it names has actually been pushed.
terraform apply -target=aws_ecr_repository.web -target=aws_ecr_lifecycle_policy.web
```

### Going live

This is the step that actually ships code — push both images and bring the web service up, completing the one-time setup. It's also the exact command reused for the two rare exceptions after CD is live: a rollback (an older `TF_VAR_web_image_tag`) or a `terraform plan` preview.

```bash
cd infra # Make sure you're in the right folder.

ECR_TOKEN=$(aws ecr get-login-password --region us-west-2)
REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com
REPO=$REGISTRY/ai-gaussian-splatter

# Push both images whenever you have a new build. The -migrate image backs the migration task definition
# (infra/web.tf). Push it too, or a manual `aws ecs run-task` against that family has nothing to pull.
# CI's deploy job builds and pushes both the same way (ci.yml).
podman login --username AWS --password-stdin $REGISTRY <<< "$ECR_TOKEN"

podman build --target web -t $REPO:$TF_VAR_web_image_tag-web \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_...> ../web
podman push $REPO:$TF_VAR_web_image_tag-web

podman build --target migrator -t $REPO:$TF_VAR_web_image_tag-migrate ../web
podman push $REPO:$TF_VAR_web_image_tag-migrate

terraform apply
```

The first apply waits on ACM DNS validation, which can take several minutes; ACM writes the validation record into the zone itself.

`deployment_minimum_healthy_percent = 100` will keep any old task serving until the new one passes health checks. If the new image fails those checks, the circuit breaker rolls back to the previous task definition, which names its own still-present tag, so ECS re-pulls the build that was working. Rolling back by hand is the same `terraform apply` using an older `TF_VAR_web_image_tag`.

Only the last few releases are kept (`local.releases_kept` in `infra/registry.tf`); older tags are expired and can no longer be rolled back to.

**`terraform apply` never applies migrations.** The database has no tables yet, but the target group reports healthy anyway — `/api/v1/healthz` never touches the database. There's no supported out-of-band way to apply one by hand either (see ["Fixing a bad migration"](#fixing-a-bad-migration) below).

So the site stays broken after this first deploy until CD applies the first migration. Finish ["Configuring continuous deployment"](#configuring-continuous-deployment) below, then push a commit touching at least one non-Markdown file to `main`. `.github/workflows/ci.yml`'s `paths-ignore` skips the whole workflow, deploy included, for a commit that only touches `.md` files. That push is what actually runs the first migration. That `deploy` job run builds the migrator image, applies it, and rolls the service forward, exactly like every release after it.

## Configuring continuous deployment

One-time, and only possible **after** [First-time account setup](#first-time-account-setup). Policy below names the migration task role and execution role, neither of which exist before the first `terraform apply`. The `ai-gaussian-splatter-ci-deploy` role created below cannot be Terraform-managed either, or it would lead to a chicken-egg situation.

### Creating the OIDC provider and CI role

```bash
# IAM allows only one OIDC provider per URL per account. Skip this call if `aws iam list-open-id-connect-providers`
# already lists token.actions.githubusercontent.com — another app in this account created it already, and a repeat
# call fails with EntityAlreadyExists. Reuse that provider; only this app's role and its trust policy are new.
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
# No --thumbprint-list: IAM validates GitHub's TLS cert against its own trusted root CA library first, since GitHub's
# OIDC endpoint chains to a public CA, and only falls back to thumbprint matching when it doesn't.

# {owner}/{repo} are gh's own placeholders, resolved from this checkout's origin remote — nothing to substitute by
# hand, and unlike <owner>/<repo> they're not shell redirection operators if this line is pasted as-is.
REPO_INFO=$(gh api repos/{owner}/{repo} --jq '[.owner.login, .name, .owner.id, .id] | @tsv')
read -r OWNER REPO OWNER_ID REPO_ID <<< "$REPO_INFO"

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
        "token.actions.githubusercontent.com:sub": "repo:$OWNER@$OWNER_ID/$REPO@$REPO_ID:ref:refs/heads/main"
      }
    }
  }]
}
EOF

aws iam create-role --role-name ai-gaussian-splatter-ci-deploy \
  --assume-role-policy-document file://trust-policy.json
```

### Granting deploy permissions

Unlike a design that delegates through a separate bootstrap role, this role needs the AWS permissions `terraform apply` itself uses directly, since nothing else stands between it and the resources it manages. IAM permissions are scoped by resource-name prefix where the service supports it (this app's own resources are all named or tagged `ai-gaussian-splatter-*`); the networking/database/load-balancer/budgets services below mostly don't support resource-level permissions for their create/modify/delete actions at all, so those stay `Resource: "*"` the same way they would under any tool. Expect to refine this policy against real `AccessDenied` errors during the first live apply — it's a reasonable starting point, not a exhaustively verified minimal policy.

```bash
cat > ci-deploy-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:PutImage", "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        "ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories",
        "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:TagResource", "ecr:PutImageTagMutability"
      ], "Resource": "arn:aws:ecr:us-west-2:$AWS_ACCOUNT_ID:repository/ai-gaussian-splatter"},
    {"Effect": "Allow", "Action": "ecs:RunTask", "Resource": [
        "arn:aws:ecs:us-west-2:$AWS_ACCOUNT_ID:task-definition/ai-gaussian-splatter-migrate:*",
        "arn:aws:ecs:us-west-2:$AWS_ACCOUNT_ID:cluster/ai-gaussian-splatter"
      ]},
    {"Effect": "Allow", "Action": ["ecs:DescribeTasks", "ecs:DescribeServices"], "Resource": "*",
      "Condition": {"ArnEquals": {"ecs:cluster": "arn:aws:ecs:us-west-2:$AWS_ACCOUNT_ID:cluster/ai-gaussian-splatter"}}},
    {"Effect": "Allow", "Action": [
        "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition",
        "ecs:CreateCluster", "ecs:DeleteCluster", "ecs:DescribeClusters", "ecs:PutClusterCapacityProviders",
        "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:TagResource",
        "ecs:PutAccountSetting", "ecs:ListTagsForResource"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "application-autoscaling:RegisterScalableTarget", "application-autoscaling:DeregisterScalableTarget",
        "application-autoscaling:PutScalingPolicy", "application-autoscaling:DeleteScalingPolicy",
        "application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": "iam:PassRole", "Resource": [
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-execution",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-migrate-task",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-task",
        "arn:aws:iam::$AWS_ACCOUNT_ID:role/ai-gaussian-splatter-worker"
      ]},
    {"Effect": "Allow", "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies",
        "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile"
      ], "Resource": "arn:aws:iam::$AWS_ACCOUNT_ID:*/ai-gaussian-splatter-*"},
    {"Effect": "Allow", "Action": [
        "s3:CreateBucket", "s3:DeleteBucket*", "s3:ListBucket", "s3:GetBucket*", "s3:PutBucket*",
        "s3:PutObject", "s3:GetObject", "s3:DeleteObject",
        "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration",
        "s3:PutLifecycleConfiguration", "s3:GetLifecycleConfiguration"
      ], "Resource": [
        "arn:aws:s3:::ai-gaussian-splatter-*", "arn:aws:s3:::ai-gaussian-splatter-*/*"
      ]},
    {"Effect": "Allow", "Action": [
        "ec2:CreateVpc", "ec2:DeleteVpc", "ec2:DescribeVpcs", "ec2:ModifyVpcAttribute",
        "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:DescribeSubnets", "ec2:ModifySubnetAttribute",
        "ec2:CreateInternetGateway", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway", "ec2:DescribeInternetGateways",
        "ec2:CreateRouteTable", "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:DeleteRoute",
        "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:DescribeRouteTables",
        "ec2:CreateVpcEndpoint", "ec2:DeleteVpcEndpoints", "ec2:DescribeVpcEndpoints",
        "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:DescribeSecurityGroups",
        "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress",
        "ec2:DescribeSecurityGroupRules", "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
        "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
        "ec2:CreateTags", "ec2:DeleteTags", "ec2:DescribeTags", "ec2:DescribeAvailabilityZones"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "rds:CreateDBInstance", "rds:DeleteDBInstance", "rds:ModifyDBInstance", "rds:DescribeDBInstances",
        "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:DescribeDBSubnetGroups",
        "rds:AddTagsToResource", "rds:ListTagsForResource"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:CreateListener", "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:AddTags", "elasticloadbalancing:DescribeTags"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "route53:ChangeResourceRecordSets", "route53:GetHostedZone", "route53:ListResourceRecordSets",
        "route53:GetChange"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "acm:RequestCertificate", "acm:DeleteCertificate", "acm:DescribeCertificate", "acm:AddTagsToCertificate"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "kms:CreateKey", "kms:ScheduleKeyDeletion", "kms:DescribeKey", "kms:PutKeyPolicy", "kms:GetKeyPolicy",
        "kms:EnableKeyRotation", "kms:GetKeyRotationStatus", "kms:TagResource", "kms:CreateAlias", "kms:DeleteAlias"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "sns:CreateTopic", "sns:DeleteTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes",
        "sns:Subscribe", "sns:Unsubscribe", "sns:ListSubscriptionsByTopic", "sns:TagResource"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "budgets:ViewBudget", "budgets:ModifyBudget"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms",
        "cloudwatch:TagResource"
      ], "Resource": "*"},
    {"Effect": "Allow", "Action": [
        "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups", "logs:PutRetentionPolicy",
        "logs:TagResource"
      ], "Resource": "arn:aws:logs:us-west-2:$AWS_ACCOUNT_ID:log-group:/ecs/ai-gaussian-splatter-*"},
    {"Effect": "Allow", "Action": ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:us-west-2:$AWS_ACCOUNT_ID:secret:*"},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], "Resource": [
        "arn:aws:s3:::ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID",
        "arn:aws:s3:::ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID/*"
      ]}
  ]
}
EOF
aws iam put-role-policy --role-name ai-gaussian-splatter-ci-deploy \
  --policy-name deploy --policy-document file://ci-deploy-policy.json
```

`ecs:DescribeTaskDefinition` and most of the networking/database/load-balancer/budgets actions above have no resource-level permissions to scope to, hence `Resource: "*"` — this is an AWS API limitation these services share regardless of which tool manages them. `ecs:RunTask`'s task-definition ARN uses the wildcard-revision form (`:*`), not a pinned revision. A pinned one would break on every new migration image push, since each push registers a new revision. The last statement grants read/write on the Terraform state bucket itself, without which `terraform init`/`apply` can't read or update state at all.

### Setting GitHub repository variables

Set these as GitHub repository variables (Settings → Secrets and variables → Actions → Variables). `.github/workflows/ci.yml`'s `deploy` job reads them as `vars.*`:

- `AWS_ACCOUNT_ID`
- `HOSTED_ZONE_ID`
- `CLERK_SECRET_KEY_ARN`
- `ALERT_EMAIL`
- `APP_PUBLIC_URL`
- `WORKER_AMI_ID`
- `CLERK_PUBLISHABLE_KEY` (the `pk_live_...` key, not the secret one)

Live re-resolution (`aws route53 list-hosted-zones-by-name`, etc.) was deliberately skipped for these in CI — one production environment, rarely-changing values, and a `vars.*` edit is itself a reviewable, logged event, unlike giving the CI role extra read permissions just to re-derive them every run.

**Setup is done — CD owns every deploy from here.** Push to `main` and `ci.yml`'s `deploy` job builds, migrates, and rolls the service forward on its own. Come back to ["Going live"](#going-live) only for the two exceptions: a rollback, or previewing an infra change with `terraform plan` first.

## Fixing a bad migration

**CI applies migrations automatically on every push to `main`.** The `deploy` job in `.github/workflows/ci.yml` runs the `migrator` image (`web/Dockerfile`) as a one-off ECS task before rolling the service forward. There is no supported way to reach the database by hand instead: the RDS instance (`infra/data.tf`) sits in an isolated subnet with no NAT gateway (`infra/network.tf`), reachable only from `aws_security_group.web` on port 5432, and no bastion exists in this infra. The CD migration task works because Terraform registers it with the web service's own network configuration; a human's laptop, or any other host, has no path to reproduce that.

So fix a bad migration the same way you'd fix any other bug: write a corrective migration following the expand/contract discipline in [Schema & migrations (Drizzle)](AGENTS.md#schema--migrations-drizzle) (edit `web/lib/server/db/schema.ts`, `pnpm db:generate`, review the emitted SQL in `web/drizzle/`), commit it, and land it through a normal PR to `main`. CD builds the new `migrator` image, applies it, and rolls the service forward exactly like every other release.

If the `deploy` job's migration step fails for an infra reason rather than a bad migration (a transient AWS error, a placement failure), retry the whole job rather than reaching for manual AWS commands — it's designed to be idempotent end to end (each image build step already skips if that commit's tag is already pushed): `gh run rerun <run-id> --failed-jobs`.

## Debugging a failed job

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm self-termination actually fired: the instance should not still be running after the job reaches a terminal state. **If it is, terminate it by hand.** The instance-runtime alarm meant to catch this isn't implemented in `infra/` yet ([State / what's next](AGENTS.md#state--whats-next), Known gaps), so nothing else will.
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Tearing down

`terraform destroy` removes everything in `infra/`'s state, including the 3 data S3 buckets (force-destroyed, contents and all) and the RDS instance (no final snapshot). It needs the same six variable values as a deploy, resolved the same way ([Resolving variable values](#resolving-variable-values)) and exported as `TF_VAR_*` — a missing one fails before anything is destroyed, same as a missing value fails `apply`.

```bash
cd infra # Make sure you're in the right folder.

terraform destroy
```

**This is a full, unconditional teardown** — unlike some infrastructure-as-code setups that protect data resources from deletion by default, nothing here does, because there's no real data yet to protect (see `infra/data.tf`'s comments on `force_destroy`/`skip_final_snapshot`). Revisit this before a real deploy holds real uploads or splats: add `lifecycle { prevent_destroy = true }` to the 3 buckets and `aws_db_instance.main`, and drop `force_destroy`/`skip_final_snapshot`, so a `terraform destroy` run by mistake fails loudly on those resources instead of quietly deleting user data.

The ECR repository (`infra/registry.tf`) is destroyed too — `force_delete = true` means every image in it goes as well, leaving no orphan under that fixed name for the next apply to collide with.

Resources this config never owned — hand-created in [First-time account setup](#first-time-account-setup) and [Configuring continuous deployment](#configuring-continuous-deployment) — are untouched by `terraform destroy` and need their own manual cleanup, if you want them gone too: the Clerk secret (`ai-gaussian-splatter/clerk-secret-key`), the `ai-gaussian-splatter-ci-deploy` IAM role and its inline policy, the GitHub OIDC provider (skip if another app in the account still uses it), the `orky.net` Route 53 hosted zone (referenced only — this app never owned it), `AWSServiceRoleForEC2Spot` (account-wide, shared with any other Spot workload), the billing-alerts console preference, the GitHub repository variables, and the `infra/bootstrap/`-created state bucket itself (`terraform -chdir=infra/bootstrap destroy`, only after `infra/`'s own destroy has finished with it). None of these cost anything meaningful to leave in place, and several (the OIDC provider, the Spot service-linked role, the hosted zone) are shared or reused, so deleting them isn't a like-for-like undo of `terraform apply`.
