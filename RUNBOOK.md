# Runbook

Most procedures below run a script from `scripts/dev/` or `scripts/prod/`, and each works from any directory in the checkout. Every one of them takes `-h`/`--help`, which prints what it does and what arguments it takes without running anything. A script that uses the AWS CLI needs you signed in. It will then print the account it's about to act on. A script that creates or deletes anything asks you to confirm first.

- [Dev AWS resources](#dev-aws-resources)
- [Web (frontend + REST API)](#web-frontend--rest-api)
- [Building and running the splat-web container locally](#building-and-running-the-splat-web-container-locally)
- [Worker (local pipeline run)](#worker-local-pipeline-run)
  - [One-time GPU passthrough setup](#one-time-gpu-passthrough-setup)
  - [Capture](#capture)
  - [Running the pipeline](#running-the-pipeline)
  - [Triggering the worker from pnpm dev](#triggering-the-worker-from-pnpm-dev)
- [Installing Terraform](#installing-terraform)
- [Full test suite](#full-test-suite)
- [Deploying to production](#deploying-to-production)
  - [Signing in to AWS](#signing-in-to-aws)
  - [Creating account prerequisites](#creating-account-prerequisites)
  - [Configuring continuous deployment](#configuring-continuous-deployment)
  - [Going live](#going-live)
  - [Building and pushing the worker image](#building-and-pushing-the-worker-image)
  - [Running Terraform locally](#running-terraform-locally)
- [Fixing a bad migration](#fixing-a-bad-migration)
- [Debugging a failed worker job](#debugging-a-failed-worker-job)
- [Tearing down](#tearing-down)

## Dev AWS resources

`infra/` only describes production, so dev's uploads/splats buckets are created outside it. `scripts/dev/create-resources.sh` creates the two buckets `web/.env` names in `UPLOADS_BUCKET` and `SPLATS_BUCKET`, plus an `ai-gaussian-splatter-dev` IAM user that can reach only those two buckets. Run it as an admin ([Signing in to AWS](#signing-in-to-aws)).

It copies `web/.env.example` to `web/.env` first when that's missing, and writes the IAM user's key pair into it whenever it creates the user's access key. An existing `web/.env` is never replaced. The default bucket names end in the AWS account id, because one S3 bucket namespace spans every account.

```bash
scripts/dev/create-resources.sh
```

## Web (frontend + REST API)

Start Postgres before running `pnpm dev`. `scripts/dev/db-up.sh` creates/starts the `splat-pg` container if needed before creating the empty `ai_gaussian_splatter` and `ai_gaussian_splatter_test` databases within it. `scripts/dev/db-down.sh` stops and removes the container and the `splat-pg-data` volume, taking the dev and test databases with it.

```bash
scripts/dev/db-up.sh
```

`pnpm dev` and `drizzle-kit` reach that container on `localhost:5432`, since they run on the host rather than in a container. The [`splat-web` container](#building-and-running-the-splat-web-container-locally) reaches it on `host.containers.internal:5432` instead. Data is stored at `/var/lib/postgresql`.

One-time setup: [Dev AWS resources](#dev-aws-resources) creates `web/.env` along with the dev buckets and IAM user. Fill in its Clerk keys. The `DATABASE_*` values already match the container above.

```bash
# Enable the restart helper once so splat-pg's --restart=always is honored after boot:
systemctl --user enable --now podman-restart.service

cd web
pnpm install
pnpm db:migrate # apply pending migrations (scripts/db-migrate.cjs)
pnpm dev

pnpm db:studio  # opens Drizzle Studio to browse/edit rows.
```

After editing `web/lib/server/db/schema.ts`, run `pnpm db:generate` to emit a migration into `web/drizzle/`, then `pnpm db:migrate` to apply it.

## Building and running the splat-web container locally

Substitutes for `pnpm dev` to exercise the `splat-web` container that production runs. Uses the `splat-pg` container from above.

```bash
scripts/dev/run-web-container.sh
```

## Worker (local pipeline run)

A real Nvidia GPU is required. The worker image carries CUDA and a CUDA-enabled COLMAP build, so only the Nvidia GPU driver and `nvidia-container-toolkit` have to be installed locally.

### One-time GPU passthrough setup

```bash
scripts/dev/setup-gpu-passthrough.sh
```

### Capture

Walk around the object shooting individual stills — every side, a couple of heights, each shot overlapping its neighbors. Aim for ~50. The API's floor of 20 (`MIN_PHOTOS_PER_SPLAT`, HTTP 400 below it) is a hard minimum, not a quality target: extra frames only help where they close a coverage gap, and near-duplicates just add COLMAP matching cost.

Object choice matters more than photo count. COLMAP triangulates surface features that hold still, so these kinds of objects can defeat it:

- **Transparent or mirrored** — what's seen through or reflected slides as the camera moves, and every such match is discarded as an outlier.
- **Thin and flat** — front and back arcs share no features and edge-on views show almost nothing, so the orbit can't close and the reconstruction fragments.
- **A flat printed face** (poster, book cover) — a degenerate initial pair; COLMAP reports `No good initial image pair found` and gives up.

Pick something opaque, matte, and genuinely three-dimensional. Stand it on a patterned surface with static clutter in frame. A plain floor or wall gives the solve nothing to hold on to.

When a set registers poorly, `worker/jobdir/colmap/database.db` says why — guessing from the photos doesn't. Check two tables:

- `keypoints` — the keypoint count per image.
- `two_view_geometries` — how many other images each image has enough inlier matches with.

Very few of either points at blur, low texture, or an orbit that doesn't connect, rather than a pipeline bug. No healthy thresholds are recorded yet, so read the counts relative to each other rather than against a known-good baseline.

### Running the pipeline

The pipeline can run standalone — nothing has to be listening at `APP_PUBLIC_URL`.

A run is two stages, one script each, and each rebuilds its own image (`splat-worker-reconstruct:dev` or `splat-worker-train:dev`) before running. Both take the dev IAM key pair, region, and bucket names from `web/.env`, which [Dev AWS resources](#dev-aws-resources) fills in. `scripts/dev/worker-reconstruct.sh` uploads the photos under a new splat ID, runs COLMAP, and prints the command for the train stage.

```bash
scripts/dev/worker-reconstruct.sh              # photos from worker/photos, or pass another directory
scripts/dev/worker-train.sh <splat-id>         # add --fast for a 20-iteration smoke test
```

### Triggering the worker from pnpm dev

Set `WORKER_LOCAL_LAUNCH=true` in `web/.env` to make the web app's Process button run the worker on your own GPU instead of launching a real EC2 spot instance. Output lands in `worker/jobdir/<jobId>/worker.log`, for the same [registration debugging](#capture) the manual flow uses. Needs the one-time [GPU passthrough setup](#one-time-gpu-passthrough-setup) and an image already built — this path never builds one for you.

```bash
cd worker
podman build --target reconstruct -t splat-worker-reconstruct:dev .  # once, and again after any worker code change
podman build --target train -t splat-worker-train:dev .              # only the stage you will launch is needed
cd ../web
pnpm dev
```

Upload photos and click Process in the browser as normal. The worker job goes through the same DB rows, callback token, and `/api/v1/internal/jobs/[jobId]/status` route a real EC2 run would use, so its status updates in the dashboard live. Leave `WORKER_LOCAL_LAUNCH` unset (or `false`) to go back to launching a real spot instance.

## Installing Terraform

`infra/providers.tf` pins an exact `required_version`, so any other CLI version fails `terraform init`. Install that exact release as a standalone binary:

```bash
scripts/dev/terraform-install.sh
```

## Full test suite

```bash
scripts/dev/run-tests.sh
```

Several of the tests `pnpm test` runs in `web/` need Postgres. They use `TEST_DATABASE_URL` from `web/.env` (`ai_gaussian_splatter_test` on `splat-pg`, created by `scripts/dev/db-up.sh`), and `pnpm test` fails if that container is down or the variable is missing. `web/tests/migrate-test-db.ts` migrates that database before those tests run.

## Deploying to production

Required one-time manual setup, in this order:

1. [Creating account prerequisites](#creating-account-prerequisites)
2. [Configuring continuous deployment](#configuring-continuous-deployment)
3. [Going live](#going-live) to turn the `deploy` job on

After that, a human only builds the worker image ([Building and pushing the worker image](#building-and-pushing-the-worker-image)) and runs Terraform for a `terraform plan` preview or a teardown ([Running Terraform locally](#running-terraform-locally)).

CI's `deploy` job (`.github/workflows/deploy.yml`) does every deploy, including the first one into an empty account ([Going live](#going-live)):

1. Creates the `ai-gaussian-splatter` ECR repository (`aws_ecr_repository.web` in `infra/registry.tf`) — first deploy only.
2. Builds both web images (`<tree>-web` and `<tree>-migrate`, tagged with `web/`'s git tree id) and pushes them into that repository — skipped when that tag is already there.
3. Applies the rest of the stack.
4. Runs the migration.
5. Rolls the service forward.

Steps 2 and 5 do nothing on a push that leaves `web/` untouched, so a `worker/`, `scripts/` or `infra/` change applies Terraform and runs the migration without building an image ([Image tags](ARCHITECTURE.md#image-tags)). Step 3 still replaces the running tasks whenever it changes the web task definition, which carries the two worker image URIs and `KEEP_ALIVE_TIMEOUT` as well as the image. That replacement is what [Building and pushing the worker image](#building-and-pushing-the-worker-image) relies on.

Whether the `deploy` job is on is `gh variable get DEPLOY_ENABLED` ([Going live](#going-live)).

### Signing in to AWS

Run every script and command in this section as an admin IAM identity signed in with `aws login`, which needs AWS CLI 2.32.0 or later. Neither the `ai-gaussian-splatter-dev` user from [Dev AWS resources](#dev-aws-resources) nor the CI role can stand in for it.

```bash
aws login # Needed again only after the session expires, up to 12 hours later.
```

### Creating account prerequisites

One-time per account. Complete all this before turning the `deploy` job on. `scripts/prod/create-account-prereqs.sh` creates three things `infra/` never manages, and keeps any that already exist:

- **The Clerk secret**, `ai-gaussian-splatter/clerk-secret-key`. The script prompts for its `sk_live_...` value. `infra/` references it by ARN only ([Setting GitHub repository variables](#setting-github-repository-variables)). To change the value later, update it directly in Secrets Manager, then force a new ECS deployment (`aws ecs update-service --force-new-deployment`) since ECS only resolves secrets at task start.
- **`AWSServiceRoleForEC2Spot`**. Account-wide role shared with every other Spot workload, so `infra/` leaves it alone (`infra/worker_iam.tf` says why). The first `RunInstances` call fails without it.
- **The Terraform state bucket**, `ai-gaussian-splatter-tfstate-<account-id>`. `terraform init` (the `deploy` job's, or a local [plan](#running-terraform-locally)) needs it before any apply.

```bash
scripts/prod/create-account-prereqs.sh
```

To check month-to-date spend: Billing console → **Billing Home**, or **Cost Explorer** for a per-service breakdown. `aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" --region us-east-1` returns the budget's `CalculatedSpend`.

### Configuring continuous deployment

One-time, after [Creating account prerequisites](#creating-account-prerequisites) and before [Going live](#going-live).

#### Creating the OIDC provider and CI role

`scripts/prod/configure-ci-role.sh` creates GitHub's OIDC provider if the account doesn't have it yet, then creates the `ai-gaussian-splatter-ci-deploy` role and writes both of its policies. It rewrites both policies on every run.

```bash
scripts/prod/configure-ci-role.sh
```

`DEPLOY_POLICY` in `scripts/prod/configure-ci-role.sh` is a reasonable starting point, not an exhaustively verified minimal policy, so expect `AccessDenied` during the first deploy, which is the first time the role creates every resource rather than updating it. Add the missing action, re-run the script, then rerun the `deploy` job (`gh run rerun <run-id> --failed-jobs`).

#### Setting GitHub repository variables

`.github/workflows/deploy.yml` reads its configuration from GitHub repository variables (`vars.*`). `scripts/prod/set-gh-repo-variables.sh` sets all of them, and needs `gh` signed in with write access to the repository plus the Clerk secret from [Creating account prerequisites](#creating-account-prerequisites). Two scripts read the same variables back:

- `scripts/prod/terraform-destroy.sh`
- `scripts/prod/terraform-plan.sh`

```bash
scripts/prod/set-gh-repo-variables.sh
```

It looks these up rather than asking:

- `AWS_ACCOUNT_ID` is the signed-in account.
- `HOSTED_ZONE_ID` is the public zone named by `DOMAIN_ZONE_NAME`, used for the ALB's DNS record and ACM validation. The zone is referenced only, not created, so it must already exist.
- `CLERK_SECRET_KEY_ARN` is the full ARN, including Secrets Manager's six-character suffix.

It asks for these, defaulting to each one's current value:

- `DOMAIN_ZONE_NAME` is the public DNS zone the app is served from, e.g. `orky.net`. A trailing dot or uppercase is normalized away before the variable is set. Everything carrying the app's public name is built from it:
  - The hostname, the ACM certificate, and the Route 53 record.
  - The S3 CORS origins.
  - The origin the worker PATCHes status back to.
  - The origin `.github/workflows/deploy.yml` smoke-checks after a rollout.
- `ALERT_EMAIL` is where the AWS Budget (`infra/budgets.tf`) sends spend alerts. A typo'd but well-formed address deploys green with the alerts never arriving, and nothing can catch that at apply time ([State / what's next](AGENTS.md#state--whats-next)).
- `CLERK_PUBLISHABLE_KEY` is the `pk_live_...` key, not the secret one. `web/Dockerfile` compiles it into the browser bundle, so a later change to it reaches users on the next deploy that changes `web/` ([Image tags](ARCHITECTURE.md#image-tags)).
- `WORKER_AMI_ID` is the AMI every worker instance boots. User data does no provisioning of its own, so the image must already carry Docker, the NVIDIA driver and container toolkit, and the AWS CLI. AWS's Deep Learning Base GPU AMIs do, and the script lists the newest five before asking.

`WORKER_IMAGE_TAG` is set to the current commit only while it's unset. After that it changes only through [Building and pushing the worker image](#building-and-pushing-the-worker-image).

With the role and repository variables in place, turn the `deploy` job on under [Going live](#going-live).

### Going live

Once [Configuring continuous deployment](#configuring-continuous-deployment) is done, turn the `deploy` job on.

```bash
scripts/prod/set-deploy-enabled.sh true
```

The script refuses while a CI run on `main` is unfinished ([CI/CD](ARCHITECTURE.md#cicd)).

A deploy starts on a push to `main` that changes more than just `.md` files or `LICENSE`.

On a first deploy, the service starts before the migration runs, so real routes 500 until the migration finishes. The first deploy also waits on ACM DNS validation, which can take several minutes.

`deployment_minimum_healthy_percent = 100` will keep any old task serving until the new one passes health checks. If the new image fails those checks, the circuit breaker rolls back to the previous task definition. To roll back by hand, revert the change and push. A schema change gets a corrective migration instead ([Fixing a bad migration](#fixing-a-bad-migration)).

Only the last few releases are kept (`local.releases_kept` in `infra/registry.tf`). That bounds the circuit breaker's automatic rollback and any fresh task placement onto an older task definition, both of which need the image still present. Reverting and pushing by hand reaches further back: an expired tag is free to push again, so that build is simply remade.

### Building and pushing the worker image

Nothing builds or pushes this image on its own — GPU worker deployment stays manual ([CI/CD](ARCHITECTURE.md#cicd)). Do this whenever `worker/` changes and you want worker jobs to actually pick up the new build. Its repository, `aws_ecr_repository.worker`, comes from the first deploy.

The image is tagged with the current commit, so commit any `worker/` changes first.

```bash
scripts/prod/worker-push-image.sh
```

After the push, the script sets the `WORKER_IMAGE_TAG` repository variable ([Setting GitHub repository variables](#setting-github-repository-variables)) to the new tag. A deploy then has to run to pass it as `TF_VAR_worker_image_tag`, which points both worker image URIs on the web task definition at the new images and replaces the running tasks. Until then, every worker instance still launches with the old images.

Rerun the latest `main` run to trigger that deploy (`gh run rerun <run-id>`), because the `deploy` job reads the variable as the run starts. Pushing a commit works too, but not a docs-only one: a push touching only `.md` files or `LICENSE` skips the workflow, so nothing reads the new variable.

Only the last `local.worker_releases_kept` images are kept (`infra/registry.tf`), which makes a stale `WORKER_IMAGE_TAG` the risk. Once that many newer images exist, the lifecycle policy expires the tag it names, and every worker instance then fails its image pull and bills until the `WORKER_MAX_LIFETIME_MINUTES` shutdown.

### Running Terraform locally

A `terraform plan` preview and a teardown are the only Terraform a human runs against `infra/`. Don't `apply` from here, because only the `deploy` job runs migrations before rolling the service.

`scripts/prod/terraform-plan.sh` needs you signed in ([Signing in to AWS](#signing-in-to-aws)) to the account the `AWS_ACCOUNT_ID` repository variable names. It takes every Terraform variable from the repository variables ([Setting GitHub repository variables](#setting-github-repository-variables)) except `web_image_tag`, which it reads from the task definition the service is running so the plan doesn't show an image change that isn't coming.

```bash
scripts/prod/terraform-plan.sh
```

## Fixing a bad migration

The only supported production apply is the `deploy` job (`.github/workflows/deploy.yml`), which runs the `migrator` image (`web/Dockerfile`) as a one-off ECS task before rolling the service forward. There is no supported way to reach the database by hand. The RDS instance (`infra/data.tf`) sits in an isolated subnet with no NAT gateway and no bastion. It accepts connections only from `aws_security_group.web` on port 5432, which is how the migration task gets to it.

Fix a bad migration the same way you'd fix any other bug: write a corrective migration following the expand/contract discipline in [Schema & migrations (Drizzle)](AGENTS.md#schema--migrations-drizzle) (edit `web/lib/server/db/schema.ts`, `pnpm db:generate`, review the emitted SQL in `web/drizzle/`), commit it, and land it through a normal PR to `main`. It applies when `DEPLOY_ENABLED` is `true` and that commit reaches `main` ([Going live](#going-live)).

If the `deploy` job's migration step fails for an infra reason rather than a bad migration (a transient AWS error, a placement failure), retry the whole `deploy` job rather than reaching for manual AWS commands — it's idempotent end to end: `gh run rerun <run-id> --failed-jobs`.

## Debugging a failed worker job

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm the instance actually went away. It self-terminates once the worker job reaches a terminal state, and `web/lib/server/ec2Launcher.ts` schedules a hard `shutdown` at `WORKER_MAX_LIFETIME_MINUTES` (2 hours) as the first thing user-data runs.
   - **Still running well past that ceiling means cloud-init/user-data itself never started** — a boot failure (bad AMI, IMDS/networking issue), which is the one case that scheduled shutdown can't catch. Terminate it by hand.
   - Nothing alerts when any of this fires ([State / what's next](AGENTS.md#state--whats-next)), so run this check by hand.
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Tearing down

`scripts/prod/terraform-destroy.sh` removes everything in `infra/`'s state, including the 3 data S3 buckets (force-destroyed, contents and all) and the RDS instance (no final snapshot). It reads its variables the same way as [Running Terraform locally](#running-terraform-locally). `scripts/prod/terraform-delete-state-bucket.sh` below checks the `AWS_ACCOUNT_ID` one against the signed-in account. Delete the repository variables only after both have finished.

Turn the `deploy` job off first, or the next push to `main` finds an empty state and deploys the whole stack again. Run the `false` set below even if deploys were never turned on. Both scripts refuse while a CI run on `main` is unfinished ([CI/CD](ARCHITECTURE.md#cicd)).

```bash
scripts/prod/set-deploy-enabled.sh false
```

```bash
scripts/prod/terraform-destroy.sh
```

**This is a full, unconditional teardown.** Nothing here is protected from deletion, because there's no real data yet to protect (see `infra/data.tf`'s comments on `force_destroy`/`skip_final_snapshot`).

Revisit that before a deploy holds real uploads or splats:

- Add `lifecycle { prevent_destroy = true }` to the 3 buckets (`uploads` and `splats` in `infra/data.tf`, `access_logs` in `infra/web.tf`) and to `aws_db_instance.main`.
- Drop `force_destroy` and `skip_final_snapshot`.

The ECR repository (`infra/registry.tf`) is destroyed too — `force_delete = true` means every image in it goes as well.

Resources `infra/` never owned are untouched by `terraform destroy`. They were hand-created in [Creating account prerequisites](#creating-account-prerequisites) and [Configuring continuous deployment](#configuring-continuous-deployment), and need their own manual cleanup if you want them gone:

- The Clerk secret, `ai-gaussian-splatter/clerk-secret-key`.
- The `ai-gaussian-splatter-ci-deploy` IAM role and its inline policy.
- The GitHub repository variables.
- The state bucket itself.
- `AWSServiceRoleForEC2Spot`, the GitHub OIDC provider, and the Route 53 hosted zone `DOMAIN_ZONE_NAME` names. Each is shared with anything else in the account, so leave them unless nothing else uses them.

None cost anything meaningful to leave in place.

Only delete the state bucket after `scripts/prod/terraform-destroy.sh` has finished with it. The script refuses while the state still tracks any resource.

```bash
scripts/prod/terraform-delete-state-bucket.sh
```
