# Runbook

Most procedures below have you run a script from `scripts/dev/` (local) or `scripts/prod/` (the deployed AWS account). Each works from any directory in the checkout. A script that uses the AWS CLI exits straight away unless `aws sts get-caller-identity` succeeds. For AWS they also print the account they're about to act on. Scripts that create or delete anything ask for confirmation first.

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
  - [First-time account setup](#first-time-account-setup)
  - [Configuring continuous deployment](#configuring-continuous-deployment)
  - [Going live](#going-live)
  - [Building and pushing the worker image](#building-and-pushing-the-worker-image)
  - [Running Terraform locally](#running-terraform-locally)
- [Fixing a bad migration](#fixing-a-bad-migration)
- [Debugging a failed job](#debugging-a-failed-job)
- [Tearing down](#tearing-down)

## Dev AWS resources

The `infra/` config only describes production, so dev's uploads/splats buckets are created outside it. `web/lib/uploadPhotos.ts` PUTs to a presigned S3 URL and the worker reads/writes both buckets via boto3, so real buckets are needed. `scripts/dev/create-dev-resources.sh` creates the two buckets `web/.env` names in `UPLOADS_BUCKET` and `SPLATS_BUCKET`, plus an `ai-gaussian-splatter-dev` IAM user that can reach only those two buckets. Run it as an admin ([Signing in to AWS](#signing-in-to-aws)). It creates `web/.env` first when it's missing, and writes the user's key pair into it whenever it creates the user's access key. An existing `web/.env` is never replaced. S3 bucket names are unique across every AWS account, so if the default names are taken, change both variables and run it again.

```bash
scripts/dev/create-dev-resources.sh
```

## Web (frontend + REST API)

The REST API is served via route handlers in `web/app/api/v1/`, backed by Postgres via Drizzle.

Start Postgres before running `pnpm dev`. `scripts/dev/db-up.sh` creates/starts the `splat-pg` container if needed before creating the empty `ai_gaussian_splatter` and `ai_gaussian_splatter_test` databases within it. `scripts/dev/db-down.sh` stops and removes the container and the `splat-pg-data` volume. Dev and test databases are then gone.

```bash
scripts/dev/db-up.sh
```

`pnpm dev` and `drizzle-kit` reach that container on `localhost:5432`, since they run on the host rather than in a container. The [`splat-web` container](#building-and-running-the-splat-web-container-locally) reaches it on `host.containers.internal:5432` instead — Podman's built-in alias for the host, no shared network needed. Data is stored at `/var/lib/postgresql`.

One-time setup: [Dev AWS resources](#dev-aws-resources) creates `web/.env` along with the dev buckets and IAM user. Fill in its Clerk keys. The `DATABASE_*` values already match the container above.

```bash
# Enable the restart helper once so splat-pg's --restart=always is honored after boot:
systemctl --user enable --now podman-restart.service

cd web          # make sure you're in the right folder
pnpm install    # no codegen step — Drizzle's schema is plain TypeScript
pnpm db:migrate # apply pending migrations (scripts/db-migrate.cjs)
pnpm dev

pnpm db:studio  # opens Drizzle Studio to browse/edit rows.
```

After editing `web/lib/server/db/schema.ts`, run `pnpm db:generate` to emit a migration into `web/drizzle/`, then `pnpm db:migrate` to apply it. The types update the moment you save the schema, so `tsc` will not catch a schema you forgot to generate a migration for.

## Building and running the splat-web container locally

Substitutes for `pnpm dev` to exercise the `splat-web` container that production runs. Uses the `splat-pg` container from above.

```bash
scripts/dev/run-web-container.sh
```

## Worker (local pipeline run)

A real Nvidia GPU is required. Run the pipeline using the [worker image](#running-the-pipeline). That image carries CUDA and a CUDA-enabled COLMAP build, so nothing but the Nvidia GPU driver and `nvidia-container-toolkit` has to be installed locally. The toolkit lets Podman pass the host GPU into the container (`--device nvidia.com/gpu=all`).

### One-time GPU passthrough setup

```bash
scripts/dev/setup-gpu-passthrough.sh
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

A run is two stages, one script each, and both rebuild the `splat-worker:dev` image before running. Both take the dev IAM key pair, region, and bucket names from `web/.env`, which [Dev AWS resources](#dev-aws-resources) fills in. Only those reach the container, never the rest of `web/.env`. `scripts/dev/worker-reconstruct.sh` uploads the photos under a new splat ID, runs COLMAP, and prints the command for the train stage.

```bash
scripts/dev/worker-reconstruct.sh              # photos from worker/photos, or pass another directory
scripts/dev/worker-train.sh <splat-id>         # add --fast for a 20-iteration smoke test
```

### Triggering the worker from pnpm dev

Set `WORKER_LOCAL_LAUNCH=true` in `web/.env` to make the web app's Process button run the worker on your own GPU instead of launching a real EC2 spot instance. `web/lib/server/ec2Launcher.ts`'s `launchJobLocal()` then does what the [Running the pipeline](#running-the-pipeline) scripts do: it shells out to `podman run` against the `splat-worker:dev` image, with output landing in `worker/jobdir/<jobId>/worker.log` for the same [registration debugging](#capture) the manual flow uses. Requires the same one-time [GPU passthrough setup](#one-time-gpu-passthrough-setup) and an image already built, by either pipeline script or the `podman build` below. This path never builds it for you.

```bash
cd worker && podman build -t splat-worker:dev . # once, and again after any worker code change
cd ../web && pnpm dev
```

Upload photos and click Process in the browser as normal — the job goes through the same DB rows, callback token, and `/api/v1/internal/jobs/[jobId]/status` route a real EC2 run would use, so its status updates in the dashboard live. Leave `WORKER_LOCAL_LAUNCH` unset (or `false`) to go back to launching a real spot instance; `WORKER_AMI_ID` and the rest of that block stay unused either way.

## Installing Terraform

`infra/providers.tf` pins an exact `required_version`, so any other CLI version fails `terraform init`. Install that exact release as a standalone binary:

```bash
scripts/prod/install-terraform.sh
```

## Full test suite

```bash
scripts/dev/run-tests.sh
```

Several of the tests `pnpm test` runs in `web/` need Postgres (rate limiting, `getOrCreateUser`, the worker callback token). They use `TEST_DATABASE_URL` from `web/.env` (`ai_gaussian_splatter_test` on `splat-pg`, created by `scripts/dev/db-up.sh`). `pnpm test` fails if that container is down or the variable is missing from `web/.env`. CI's `web` job in `.github/workflows/ci.yml` sets the same variable itself.

`web/tests/migrate-test-db.ts` migrates the test database at `TEST_DATABASE_URL` before those tests run.

## Deploying to production

Required one-time manual setup, in this order:

1. [First-time account setup](#first-time-account-setup)
2. [Configuring continuous deployment](#configuring-continuous-deployment)
3. [Going live](#going-live) to turn the job on

After that, a human only builds the worker image ([Building and pushing the worker image](#building-and-pushing-the-worker-image)) and runs Terraform for a `terraform plan` preview or a teardown ([Running Terraform locally](#running-terraform-locally)).

CI's `deploy` job (`.github/workflows/deploy.yml`) does every deploy, including the first one into an empty account ([Going live](#going-live)):

1. Creates the `ai-gaussian-splatter` ECR repository (`aws_ecr_repository.web` in `infra/registry.tf`) so the images have somewhere to go (first deploy only).
2. Builds both web images (`<sha>-web` and `<sha>-migrate`) before pushing them into that repository.
3. Applies the rest of the stack.
4. Runs the migration.
5. Rolls the service forward.

The job is currently disabled ([State / what's next](AGENTS.md#state--whats-next)).

### Signing in to AWS

Run every script and command in this section as an admin IAM identity signed in with `aws login`, which needs AWS CLI 2.32.0 or later. The `ai-gaussian-splatter-dev` user from [Dev AWS resources](#dev-aws-resources) can only reach the two dev buckets. The CI role from [Configuring continuous deployment](#configuring-continuous-deployment) can only be assumed by the `deploy` job itself.

```bash
aws login # Needed again only after the session expires, up to 12 hours later.
```

### First-time account setup

One-time per account. Complete all this before turning the `deploy` job on. `scripts/prod/first-time-account-setup.sh` creates three things the root module never manages, and keeps any that already exist:

- **The Clerk secret**, `ai-gaussian-splatter/clerk-secret-key`. The script prompts for its `sk_live_...` value. `infra/` references it by ARN only ([Setting GitHub repository variables](#setting-github-repository-variables)). To change the value later, update it directly in Secrets Manager, then force a new ECS deployment (`aws ecs update-service --force-new-deployment`) since ECS only resolves secrets at task start.
- **`AWSServiceRoleForEC2Spot`**. It's one account-wide role shared by every other Spot workload in the account. It has to exist before `web/lib/server/ec2Launcher.ts`'s first `RunInstances` call, and this app cannot auto-create it.
- **The Terraform state bucket**, `ai-gaussian-splatter-tfstate-<account-id>`. `terraform init` (the `deploy` job's, or a local [plan](#running-terraform-locally)) needs it before any apply.

```bash
scripts/prod/first-time-account-setup.sh
```

To see current estimated month-to-date spend, Billing console → **Billing Home** shows it on the landing page; **Cost Explorer** breaks it down by service. To check the budget directly instead of hunting the console, `aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" --region us-east-1` returns its `CalculatedSpend` — the Budgets API is `us-east-1`-only regardless of the resources it's tracking.

### Configuring continuous deployment

One-time, after [First-time account setup](#first-time-account-setup) and before [Going live](#going-live). The CI role's policy names roles and repositories that only the first deploy creates. IAM allows that, since it doesn't check that a policy's resources exist. The `ai-gaussian-splatter-ci-deploy` role created below can't be Terraform-managed, since CI would need it to apply the config that creates it.

#### Creating the OIDC provider and CI role

`scripts/prod/configure-ci-role.sh` creates GitHub's OIDC provider if the account doesn't have it yet, then creates the role and writes both of its policies. It rewrites both policies on every run.

```bash
scripts/prod/configure-ci-role.sh
```

#### Granting deploy permissions

Unlike a design that delegates through a separate bootstrap role, this role needs the AWS permissions `terraform apply` itself uses directly, since nothing else stands between it and the resources it manages. IAM permissions are scoped by resource-name prefix where the service supports it (this app's own resources are all named or tagged `ai-gaussian-splatter-*`); the networking/database/load-balancer/budgets services in it mostly don't support resource-level permissions for their create/modify/delete actions at all, so those stay `Resource: "*"` the same way they would under any tool. It's a reasonable starting point, not an exhaustively verified minimal policy. Expect `AccessDenied` errors during the first deploy, which is the first time this role creates every resource rather than updating it. Add the missing action to `DEPLOY_POLICY` in `scripts/prod/configure-ci-role.sh`, re-run the script, then rerun the job (`gh run rerun <run-id> --failed-jobs`).

`ecs:DescribeTaskDefinition` and most of the networking/database/load-balancer/budgets actions in that policy have no resource-level permissions to scope to, hence `Resource: "*"` — this is an AWS API limitation these services share regardless of which tool manages them. `ecs:RunTask`'s task-definition ARN uses the wildcard-revision form (`:*`), not a pinned revision. A pinned one would break on every new migration image push, since each push registers a new revision. The last statement grants read/write on the Terraform state bucket itself, without which `terraform init`/`apply` can't read or update state at all. The role can't read any secret's value. Its only Secrets Manager grant is `CreateSecret` and `TagResource` on RDS's own `rds!` secrets, plus `kms:DescribeKey`, which RDS requires from whoever creates an instance with `manage_master_user_password`. Reading the Clerk and database secrets at runtime is the ECS execution and task roles' job (`infra/web.tf`).

#### Setting GitHub repository variables

`.github/workflows/deploy.yml` reads its configuration from GitHub repository variables (`vars.*`). `scripts/prod/set-gh-repo-variables.sh` sets all of them. `scripts/prod/terraform-plan.sh` and `scripts/prod/terraform-destroy.sh` read the same ones back. It needs `gh` signed in with write access to the repository, and the Clerk secret from [First-time account setup](#first-time-account-setup).

```bash
scripts/prod/set-gh-repo-variables.sh
```

It looks these up rather than asking:

- `AWS_ACCOUNT_ID` is the signed-in account. The deploy job builds the CI role's ARN and the state bucket name from it.
- `HOSTED_ZONE_ID` is the `orky.net` zone for the ALB's DNS record and ACM validation. The zone is referenced only, not created, so it must already exist. Terraform adds the app's A-alias and ACM's validation CNAME to it; nothing else in the zone is this app's concern.
- `CLERK_SECRET_KEY_ARN` is the full ARN, including Secrets Manager's six-character suffix. ECS matches a task definition's `valueFrom` against that suffix, so a partial ARN applies clean and only fails at task start.
- `APP_PUBLIC_URL` is where the worker PATCHes job status back to, and what the ALB is aliased to. It's read from `local.app_hostname` in `infra/locals.tf`, which the certificate and the Route 53 record are built from too.

It asks for these, defaulting to each one's current value:

- `ALERT_EMAIL` is where the AWS Budget (`infra/budgets.tf`) sends spend alerts directly, with no subscription-confirmation step to check. Nothing can tell a wrong address from a right one, and a wrong one applies green with the alerts never arriving. The only way to catch a typo is to watch for a real alert once spend crosses a threshold, or temporarily lower `monthly_budget_limit_usd` to force one.
- `CLERK_PUBLISHABLE_KEY` is the `pk_live_...` key, not the secret one.
- `WORKER_AMI_ID` is the AMI each job's spot instance boots. `web/lib/server/ec2Launcher.ts`'s user data runs `aws ecr get-login-password` and `docker run --gpus all` with no provisioning of its own, so the image must already carry Docker, the NVIDIA driver and container toolkit, and the AWS CLI. AWS's Deep Learning Base GPU AMIs do, and the script lists the newest five before asking.

`WORKER_IMAGE_TAG` is set to the current commit only while it's unset. GPU worker deployment stays manual ([`ARCHITECTURE.md`](ARCHITECTURE.md)), so after that it changes only through [Building and pushing the worker image](#building-and-pushing-the-worker-image). Terraform can't verify the tag has been pushed. Its validation checks only the shape.

Live re-resolution (`aws route53 list-hosted-zones-by-name`, etc.) was deliberately skipped for these in CI — one production environment, rarely-changing values, and a `vars.*` edit is itself a reviewable, logged event, unlike giving the CI role extra read permissions just to re-derive them every run.

With the role and repository variables in place, turn the job on under [Going live](#going-live).

### Going live

Once [Configuring continuous deployment](#configuring-continuous-deployment) is done, turn the `deploy` job on: delete `false && ` from its `if:` in `.github/workflows/ci.yml` and land that through a PR. Merging it to `main` is the first deploy.

The job finds no service in the Terraform state, so it treats the run as a first deploy. It applies the ECR repository on its own, pushes both images into it, then applies everything else on this commit's image. The service starts before the migration runs, so real routes 500 until the migration finishes. The first apply also waits on ACM DNS validation, which can take several minutes. ACM writes the validation record into the zone itself.

`deployment_minimum_healthy_percent = 100` will keep any old task serving until the new one passes health checks. If the new image fails those checks, the circuit breaker rolls back to the previous task definition, which names its own still-present tag, so ECS re-pulls the build that was working. To roll back by hand, revert the change and push. A schema change gets a corrective migration instead ([Fixing a bad migration](#fixing-a-bad-migration)).

Only the last few releases are kept (`local.releases_kept` in `infra/registry.tf`); older tags are expired and can no longer be rolled back to.

A push that touches only `.md` files doesn't deploy. `.github/workflows/ci.yml`'s `paths-ignore` skips the whole workflow for it.

### Building and pushing the worker image

Unlike the web/migrate images, nothing builds or pushes this on its own — GPU worker deployment stays manual ([`ARCHITECTURE.md`](ARCHITECTURE.md)). Do this whenever `worker/` changes and you want a job to actually pick up the new build. Its repository, `aws_ecr_repository.worker`, comes from the first deploy. That deploy doesn't need an image in it yet, since `WORKER_IMAGE_URI` is just a string env var the web task carries, not something ECS itself tries to pull.

The image is tagged with the current commit, so commit any `worker/` changes first.

```bash
scripts/prod/push-worker-image.sh
```

After the push, the script sets the `WORKER_IMAGE_TAG` repository variable ([Setting GitHub repository variables](#setting-github-repository-variables)) to the new tag. The next deploy passes it as `TF_VAR_worker_image_tag`, which points `WORKER_IMAGE_URI` on the web task definition at the new image. Until then, job launches keep using the old one.

Only the last `local.worker_releases_kept` images are kept (`infra/registry.tf`) — far fewer than the web repository's `local.releases_kept`, since the ~19 GB worker image isn't part of any ECS rollback mechanism: `WORKER_IMAGE_URI` just names whatever tag `worker_image_tag` currently points at, with nothing to roll back to the way a task definition revision does. That makes a stale `WORKER_IMAGE_TAG` the risk. Once `local.worker_releases_kept` newer images exist, the lifecycle policy expires the tag it names, and every job launch then fails its pull and bills until the `WORKER_MAX_LIFETIME_MINUTES` shutdown.

### Running Terraform locally

A `terraform plan` preview and a teardown are the only Terraform a human runs against `infra/`. Don't `apply` from here, because only the `deploy` job runs migrations before rolling the service. `scripts/prod/terraform-plan.sh` needs you signed in ([Signing in to AWS](#signing-in-to-aws)) to the account the `AWS_ACCOUNT_ID` repository variable names. It takes every Terraform variable from the repository variables ([Setting GitHub repository variables](#setting-github-repository-variables)) except `web_image_tag`. That one comes from the task definition the service is running, or the plan would show an image change that isn't coming.

```bash
scripts/prod/terraform-plan.sh
```

## Fixing a bad migration

The only supported production apply is the `deploy` job (`.github/workflows/deploy.yml`), which runs the `migrator` image (`web/Dockerfile`) as a one-off ECS task before rolling the service forward. That job is currently off ([State / what's next](AGENTS.md#state--whats-next)). There is no supported way to reach the database by hand instead: the RDS instance (`infra/data.tf`) sits in an isolated subnet with no NAT gateway (`infra/network.tf`), reachable only from `aws_security_group.web` on port 5432, and no bastion exists in this infra. The migration task reaches it only because the `deploy` job launches it with the web service's own network configuration. Launching that task by hand with `aws ecs run-task` is possible, but it isn't a supported path.

Fix a bad migration the same way you'd fix any other bug: write a corrective migration following the expand/contract discipline in [Schema & migrations (Drizzle)](AGENTS.md#schema--migrations-drizzle) (edit `web/lib/server/db/schema.ts`, `pnpm db:generate`, review the emitted SQL in `web/drizzle/`), commit it, and land it through a normal PR to `main`. It applies when the `deploy` job is re-enabled and that commit reaches `main`.

If the `deploy` job's migration step fails for an infra reason rather than a bad migration (a transient AWS error, a placement failure), retry the whole job rather than reaching for manual AWS commands — it's designed to be idempotent end to end (each image build step already skips if that commit's tag is already pushed): `gh run rerun <run-id> --failed-jobs`.

## Debugging a failed job

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. If `status` is stuck (no update in ~20 min) rather than `failed`: the instance likely died without reporting — check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log.
3. Confirm the instance actually went away. It should self-terminate the moment the job reaches a terminal state, and — even if it never does — `web/lib/server/ec2Launcher.ts` schedules a hard `shutdown` at its `WORKER_MAX_LIFETIME_MINUTES` constant (2 hours) as the very first thing user-data runs, so it should disappear on its own by then regardless of what happened inside the container. **Still running well past that ceiling means cloud-init/user-data itself never started** — a boot failure (bad AMI, IMDS/networking issue), not a job failure, since that's the one case the scheduled shutdown can't catch: it's never scheduled if user-data never runs. Terminate it by hand in that case. There's still no alerting when any of this fires ([State / what's next](AGENTS.md#state--whats-next), Known gaps), so this check has to be done by hand.
4. `docker logs` on the instance (if still running) or CloudWatch Logs (once wired up) for the actual COLMAP/gsplat stack trace.

## Tearing down

`scripts/prod/terraform-destroy.sh` removes everything in `infra/`'s state, including the 3 data S3 buckets (force-destroyed, contents and all) and the RDS instance (no final snapshot). It reads its variables the same way as [Running Terraform locally](#running-terraform-locally). `scripts/prod/delete-tf-state-bucket.sh` below checks the `AWS_ACCOUNT_ID` one against the signed-in account. Delete the repository variables only after both have finished.

Turn the `deploy` job off first (`if: false && …` in `.github/workflows/ci.yml`) and land that on `main` before destroying. Otherwise the next push to `main` finds an empty state and deploys the whole stack again. The script refuses to run until `origin/main` has the job off.

```bash
scripts/prod/terraform-destroy.sh
```

**This is a full, unconditional teardown** — unlike some infrastructure-as-code setups that protect data resources from deletion by default, nothing here does, because there's no real data yet to protect (see `infra/data.tf`'s comments on `force_destroy`/`skip_final_snapshot`). Revisit this before a real deploy holds real uploads or splats: add `lifecycle { prevent_destroy = true }` to the 3 buckets and `aws_db_instance.main`, and drop `force_destroy`/`skip_final_snapshot`, so a `terraform destroy` run by mistake fails loudly on those resources instead of quietly deleting user data.

The ECR repository (`infra/registry.tf`) is destroyed too — `force_delete = true` means every image in it goes as well, leaving no orphan under that fixed name for the next apply to collide with.

Resources this config never owned — hand-created in [First-time account setup](#first-time-account-setup) and [Configuring continuous deployment](#configuring-continuous-deployment) — are untouched by `terraform destroy` and need their own manual cleanup, if you want them gone too: the Clerk secret (`ai-gaussian-splatter/clerk-secret-key`), the `ai-gaussian-splatter-ci-deploy` IAM role and its inline policy, the GitHub OIDC provider (skip if another app in the account still uses it), the `orky.net` Route 53 hosted zone (referenced only — this app never owned it), `AWSServiceRoleForEC2Spot` (account-wide, shared with any other Spot workload), the GitHub repository variables, and the state bucket itself. None of these cost anything meaningful to leave in place, and several (the OIDC provider, the Spot service-linked role, the hosted zone) are shared or reused, so deleting them isn't a like-for-like undo of `terraform apply`.

Only delete the state bucket after `scripts/prod/terraform-destroy.sh` has finished with it. The script refuses while the state still tracks any resource.

```bash
scripts/prod/delete-tf-state-bucket.sh
```
