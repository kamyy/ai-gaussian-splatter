# Runbook

Most procedures below run a script from `scripts/dev/` or `scripts/prod/`, and each works from any directory in the checkout. Every one of them takes `-h`/`--help`, which prints what it does and what arguments it takes without running anything. A script that uses the AWS CLI needs you signed in. It will then print the account it's about to act on. A script that creates or deletes anything asks you to confirm first.

- [1. Local development](#1-local-development)
  - [1.1 First-time setup](#11-first-time-setup)
  - [1.2 Web (frontend + REST API)](#12-web-frontend--rest-api)
  - [1.3 Capture](#13-capture)
  - [1.4 Local worker runs](#14-local-worker-runs)
  - [1.5 Full test suite](#15-full-test-suite)
- [2. Deploying to production](#2-deploying-to-production)
  - [2.1 Signing in to AWS](#21-signing-in-to-aws)
  - [2.2 Going live](#22-going-live)
  - [2.3 Releasing a worker change](#23-releasing-a-worker-change)
  - [2.4 Running Terraform locally](#24-running-terraform-locally)
  - [2.5 Choosing the landing page's examples](#25-choosing-the-landing-pages-examples)
  - [2.6 Tuning runtime settings](#26-tuning-runtime-settings)
- [3. Troubleshooting](#3-troubleshooting)
  - [3.1 Fixing a bad migration](#31-fixing-a-bad-migration)
  - [3.2 Debugging a failed worker job](#32-debugging-a-failed-worker-job)
  - [3.3 Reading logs and alarms](#33-reading-logs-and-alarms)
- [4. Tearing down](#4-tearing-down)

---

## 1. Local development

Local development runs against the dev buckets and the `splat-pg` container, never the deployed account.

### 1.1 First-time setup

`scripts/dev/setup.sh` installs the dependencies, the Terraform CLI version `infra/providers.tf` pins, the dev AWS resources, and GPU access for the worker container. Its `--help` lists each step. Sign in to AWS as an admin first ([Signing in to AWS](#21-signing-in-to-aws)), or the dev AWS resources step is skipped.

```bash
scripts/dev/setup.sh
```

`infra/` only describes production, so dev's uploads and splats buckets are created outside it, along with an `ai-gaussian-splatter-dev` IAM user that can reach only those two buckets. The script copies `web/.env.example` to `web/.env` when that's missing and writes the IAM user's key pair into it. An existing `web/.env` is never replaced. If the IAM user already has an access key, the script can't fill the pair in, because AWS shows a secret only once. Copy the pair from another checkout's `web/.env`, or delete the key with `aws iam delete-access-key` and run the script again. The default bucket names end in the AWS account id, because one S3 bucket namespace spans every account.

Then fill in the Clerk keys in `web/.env`, from the development Clerk instance.

### 1.2 Web (frontend + REST API)

```bash
pnpm dev        # from the repo root: starts splat-pg, applies pending migrations, then runs next dev on localhost:3000
```

The `splat-pg` container holds the dev database `ai_gaussian_splatter` and the test database `ai_gaussian_splatter_test`. `pnpm dev`, `pnpm db:migrate` and `pnpm db:studio` reach it on `localhost:5432`, since they run on the host rather than in a container.

```bash
scripts/dev/db.sh down          # deletes splat-pg and its volume, and both databases with them
pnpm --dir web db:studio        # opens Drizzle Studio to browse and edit rows
```

After editing `web/lib/server/db/schema.ts`, run `pnpm --dir web db:generate` to emit a migration into `web/drizzle/`. The next `pnpm dev` applies it.

### 1.3 Capture

Walk around the object shooting individual stills: every side, a couple of heights, each shot overlapping its neighbors. Aim for ~50. The API's floor of 20 (the `min-photos-per-splat` runtime setting, HTTP 400 below it) is a hard minimum, not a quality target, and its ceiling is 100 (`MAX_PHOTOS_PER_SPLAT`). Extra frames only help where they close a coverage gap, and near-duplicates just add COLMAP matching cost.

Object choice matters more than photo count. COLMAP triangulates surface features that hold still, so these kinds of objects can defeat it:

- **Transparent or mirrored** — what's seen through or reflected slides as the camera moves, and every such match is discarded as an outlier.
- **Thin and flat** — front and back arcs share no features and edge-on views show almost nothing, so the orbit can't close and the reconstruction fragments.
- **A flat printed face** (poster, book cover) — a degenerate initial pair; COLMAP reports `No good initial image pair found` and gives up.

Pick something opaque, matte, and genuinely three-dimensional. Stand it on a patterned surface with static clutter in frame. A plain floor or wall gives the solve nothing to hold on to.

### 1.4 Local worker runs

Under `pnpm dev`, each stage of a worker job runs on your own GPU in Podman instead of on an EC2 spot instance. It needs a real NVIDIA GPU with its driver installed, and `scripts/dev/setup.sh gpu` sets up the rest.

Create a splat at `/splats/new` as normal. Uploading its photos starts the worker job, and the splat's page shows each stage live. Each stage rebuilds its image from `worker/` first, so a `worker/` edit is picked up by the next stage.

A worker job's files land in `worker/jobdir/<jobId>/`, including `worker.log`, `colmap/database.db` and `result.ply`.

When a set registers poorly, `colmap/database.db` says why. Its `keypoints` table has the keypoint count per image, and its `two_view_geometries` table shows how many other images each image matches. Very low counts in either point at blur, low texture, or an orbit that doesn't connect, rather than a pipeline bug. No healthy thresholds are recorded yet, so compare the counts against each other.

To judge a change to `worker/pipeline/train.py`, set `EVAL_HOLDOUT=true` in `web/.env`. The train stage then holds back every 8th photo and logs PSNR and SSIM against those photos, with side-by-side renders in `worker/jobdir/<jobId>/eval/`. Training loss can't judge a change, because it keeps falling even while the splat overfits. Identical runs differ by up to about 1 dB, so repeat each side a few times. Each run is a new splat.

### 1.5 Full test suite

```bash
pnpm format     # from the repo root: apply every formatter and sort imports
pnpm lint       # from the repo root: every format check, lint rule and typecheck CI runs
pnpm test       # from the repo root: every test suite CI runs
```

Several of the web tests need Postgres. They use `TEST_DATABASE_URL`, which `web/vitest.config.mts` defaults to `ai_gaussian_splatter_test` on `splat-pg`, and fail if that container is down. `web/tests/migrate-test-db.ts` migrates that database before those tests run.

---

## 2. Deploying to production

1. [Signing in to AWS](#21-signing-in-to-aws)
2. [Going live](#22-going-live), once per account

After that, a human only releases worker changes ([Releasing a worker change](#23-releasing-a-worker-change)), previews a plan ([Running Terraform locally](#24-running-terraform-locally)), picks the landing page's examples ([Choosing the landing page's examples](#25-choosing-the-landing-pages-examples)), and tunes the runtime settings ([Tuning runtime settings](#26-tuning-runtime-settings)).

CI's `deploy` job (`.github/workflows/deploy.yml`) does every deploy, including the first one into an empty account:

1. Creates the `ai-gaussian-splatter` and `ai-gaussian-splatter-worker` ECR repositories (`infra/registry.tf`) — first deploy only.
2. Builds both web images (`<tree>-web` and `<tree>-migrate`, tagged with `web/`'s git tree id) and pushes them — skipped when that tag is already there.
3. Applies the rest of the stack.
4. Runs the migration.
5. Rolls the service forward.

It runs on a push to `main` that changes more than just `.md` files or `LICENSE`, and on a run started by hand on `main` (`gh workflow run ci.yml --ref main`), but only while the `DEPLOY_ENABLED` repository variable is `true`.

Steps 2 and 5 do nothing on a push that leaves `web/` untouched, so a `worker/`, `scripts/` or `infra/` change applies Terraform and runs the migration without building an image ([Image tags](ARCHITECTURE.md#111-image-tags)). Step 3 still replaces the running tasks whenever it changes the web task definition, which carries the two worker image URIs and `KEEP_ALIVE_TIMEOUT` as well as the image. That replacement is what [Releasing a worker change](#23-releasing-a-worker-change) relies on.

### 2.1 Signing in to AWS

Run every script in this section as an admin IAM identity signed in with `aws login`, which needs AWS CLI 2.32.0 or later. Neither the `ai-gaussian-splatter-dev` user from [First-time setup](#11-first-time-setup) nor the CI role can stand in for it. The scripts also need `gh` signed in with write access to this repository.

```bash
aws login # Needed again only after the session expires, up to 12 hours later.
```

### 2.2 Going live

`scripts/prod/bootstrap.sh` takes a fresh account to a live deploy. Its `--help` lists each step and what it creates. Run with no arguments, it runs them all, in order:

1. Creates what `infra/` never manages: the Clerk secret `ai-gaussian-splatter/clerk-secret-key` (it prompts for the `sk_live_...` value), the account-wide `AWSServiceRoleForEC2Spot` role, and the Terraform state bucket `ai-gaussian-splatter-tfstate-<account-id>`.
2. Creates GitHub's OIDC provider and the `ai-gaussian-splatter-ci-deploy` role the `deploy` job assumes.
3. Sets the GitHub repository variables `.github/workflows/deploy.yml` reads.
4. Turns the `deploy` job on.
5. Runs the first deploy and waits for it, which takes around 20 minutes, most of it ACM certificate validation.
6. Builds and pushes the worker images ([Releasing a worker change](#23-releasing-a-worker-change)).

```bash
scripts/prod/bootstrap.sh
```

Every step skips what already exists, so re-running the script, or one step of it (`scripts/prod/bootstrap.sh gh-vars`), is safe.

It looks up `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID` and `CLERK_SECRET_KEY_ARN`. The hosted zone is referenced only, not created, so it must already exist. It asks for these, defaulting to each one's current value:

- `DOMAIN_ZONE_NAME` is the public DNS zone the app is served from, e.g. `orky.net`. A trailing dot or uppercase is normalized away. Everything carrying the app's public name is built from it:
  - The hostname, the ACM certificate, and the Route 53 record.
  - The S3 CORS origins.
  - The origin the worker PATCHes status back to.
  - The origin `.github/workflows/deploy.yml` smoke-checks after a rollout.
- `ALERT_EMAIL` is where the AWS Budget (`infra/budgets.tf`) sends spend alerts, and where the worker sweeper (`infra/worker_sweeper.tf`) and the alarms send theirs. A typo'd but well-formed address deploys green.
- `CLERK_PUBLISHABLE_KEY` is the `pk_live_...` key, not the secret one. `web/Dockerfile` compiles it into the browser bundle, so a later change to it reaches users on the next deploy that changes `web/` ([Image tags](ARCHITECTURE.md#111-image-tags)).
- `GA_MEASUREMENT_ID` is the Google Analytics 4 measurement ID (`G-...`) and is optional. Leaving it empty builds the app without Google Analytics or its privacy banner. An empty answer keeps the current value, so turning analytics off is `gh variable delete GA_MEASUREMENT_ID`. Like `CLERK_PUBLISHABLE_KEY`, it is compiled into the browser bundle.
- `WORKER_AMI_ID` is the AMI every worker instance boots. User data does no provisioning of its own, so the image must already carry Docker, the NVIDIA driver and container toolkit, and the AWS CLI. AWS's Deep Learning Base GPU AMIs do, and the script lists the newest five before asking.

`WORKER_IMAGE_TAG` is set to `worker/`'s tree id on `origin/main` while it's unset, which is the tag step 6 pushes. After that only [Releasing a worker change](#23-releasing-a-worker-change) changes it.

The CI role's policy, `scripts/prod/ci-role-policies/deploy.json`, is a reasonable starting point, not an exhaustively verified minimal policy, so expect `AccessDenied` during the first deploy, which is the first time the role creates every resource rather than updating it. Add the missing action to that file, run `scripts/prod/bootstrap.sh ci-role`, then rerun the `deploy` job (`gh run rerun <run-id> --failed-jobs`).

On a first deploy, the service starts before the migration runs, so real routes 500 until the migration finishes.

Four things have no API the script could call, so do them by hand once it finishes:

1. Click the subscription link AWS emails to `ALERT_EMAIL`, or the sweeper's and the alarms' emails are never delivered ([Compute](ARCHITECTURE.md#3-compute)). A subscription that still reads `PendingConfirmation` after the email should have arrived usually means a typo'd address:
   ```bash
   aws sns list-subscriptions --region "$(source scripts/lib/terraform.sh && tf_get_aws_region)" \
     --query "Subscriptions[?ends_with(TopicArn, ':ai-gaussian-splatter-alerts')].SubscriptionArn"
   ```
2. In the production Clerk instance's dashboard, open the Legal page, turn on **Require express consent to legal documents**, and set the terms of service and privacy policy URLs to the app's `/terms` and `/privacy` pages. Clerk's sign-up form then requires a checkbox, and that acceptance is what makes `web/app/(public)/terms/page.tsx` binding on users.
3. On the same dashboard's **User & authentication** page, in the **User model** section, turn off **Allow users to delete their accounts**. Users delete their accounts through the app's own account menu item, which deletes their splats too. Deleting through Clerk's profile page would remove only the Clerk account.
4. Check that the web service can read its runtime settings. `scripts/prod/ssm.sh` should list every setting, and the new-splat page should show no "Processing is paused" notice. The notice with every setting present means the task role can't read them ([Runtime settings](ARCHITECTURE.md#95-runtime-settings)).

To change the Clerk secret's value later, update it directly in Secrets Manager, then force a new ECS deployment (`aws ecs update-service --force-new-deployment`), since ECS only resolves secrets at task start.

`deployment_minimum_healthy_percent = 100` will keep any old task serving until the new one passes health checks. If the new image fails those checks, the circuit breaker rolls back to the previous task definition. To roll back by hand, revert the change and push. A schema change gets a corrective migration instead ([Fixing a bad migration](#31-fixing-a-bad-migration)).

Only the last few releases are kept (`local.releases_kept` in `infra/locals.tf`). That bounds the circuit breaker's automatic rollback and any fresh task placement onto an older task definition, both of which need the image still present. Reverting and pushing by hand reaches further back: an expired tag is free to push again, so that build is simply remade.

To check month-to-date spend: Billing console → **Billing Home**, or **Cost Explorer** for a per-service breakdown. `aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" --region us-east-1` returns the budget's `CalculatedSpend`.

### 2.3 Releasing a worker change

No deploy builds the worker images, so a merged `worker/` change reaches worker instances only through this script. It builds `worker/` as `main` holds it on GitHub, never this checkout, so the branch you're on and anything uncommitted don't matter.

```bash
scripts/prod/worker-push-image.sh
```

It pushes both images to the `ai-gaussian-splatter-worker` ECR repository tagged with `worker/`'s tree id, sets the `WORKER_IMAGE_TAG` repository variable to that tag, then starts a run of `.github/workflows/ci.yml` on `main` and waits for it. That run's deploy points both worker image URIs on the web task definition at the new images and replaces the running tasks. Until it finishes, every worker instance still launches with the old images. A tag that is already built and deployed is a no-op, so a re-run after a failure finishes only what is left.

Only the last `local.worker_releases_kept` images are kept (`infra/locals.tf`), which makes a `WORKER_IMAGE_TAG` that was set but never deployed the risk. Once that many newer images exist, the lifecycle policy expires the tag the web app still names, and every worker instance then fails its image pull and bills until its lifetime-ceiling shutdown (the `worker-max-lifetime-minutes` runtime setting it launched with).

### 2.4 Running Terraform locally

A `terraform plan` preview and a teardown are the only Terraform a human runs against `infra/`. Don't `apply` from here, because only the `deploy` job runs migrations before rolling the service.

`scripts/prod/terraform-plan.sh` needs you signed in ([Signing in to AWS](#21-signing-in-to-aws)) to the account the `AWS_ACCOUNT_ID` repository variable names. It takes every Terraform variable from the repository variables except `web_image_tag`, which it reads from the task definition the service is running so the plan doesn't show an image change that isn't coming.

```bash
scripts/prod/terraform-plan.sh
```

### 2.5 Choosing the landing page's examples

The landing page shows the newest eight complete, shareable splats of one showcase account. With no showcase account set, or one with no such splats, it shows its point-cloud hero instead. The showcase account is an ordinary user of the live app. Sign in as it to add, remove or unshare examples through the normal UI.

To pick the account, copy its user ID (`user_...`) from the production Clerk instance's Users page and set it as the `showcase-clerk-user-id` runtime setting. Setting `none` shows no examples.

```bash
scripts/prod/ssm.sh showcase-clerk-user-id user_...
```

For local dev, set `SHOWCASE_CLERK_USER_ID` in `web/.env` to a user ID from the development Clerk instance.

### 2.6 Tuning runtime settings

The processing switch, the usage limits, the worker's instance types, lifetime ceiling and training iterations, and the showcase account are runtime settings ([Runtime settings](ARCHITECTURE.md#95-runtime-settings)). A change reaches the web service within a minute, with no deploy.

```bash
scripts/prod/ssm.sh                            # prints every setting
scripts/prod/ssm.sh processing-enabled false   # changes one
```

`scripts/prod/ssm.sh --help` lists every setting and the values it accepts. It refuses a value the web service would reject, since the web service would otherwise fall back to that setting's default and pause processing site-wide.

- **Pausing processing** stops new reconstruct and train launches only. Stages already running finish, and the new-splat page and the splat page tell visitors processing is paused.
- **A new lifetime ceiling** applies to instances launched after the change. Each running instance keeps the ceiling it launched with.
- **A new train instance type** must be one whose GPU `worker/Dockerfile` compiles gsplat's kernels for, so the script accepts only those.

For local dev, each setting except the lifetime ceiling and the two instance types is an env var in `web/.env` named after it, such as `MAX_JOBS_PER_DAY` (`web/.env.example`). Those three only an EC2 launch reads, and `pnpm dev` never makes one.

---

## 3. Troubleshooting

Where to start once a migration or a worker job has already failed.

### 3.1 Fixing a bad migration

The only supported production apply is the `deploy` job (`.github/workflows/deploy.yml`), which runs the `migrator` image (`web/Dockerfile`) as a one-off ECS task before rolling the service forward. There is no supported way to reach the database by hand. The RDS instance (`infra/data.tf`) sits in an isolated subnet with no NAT gateway and no bastion. It accepts connections only from `aws_security_group.web` on port 5432, which is how the migration task gets to it.

Fix a bad migration the same way you'd fix any other bug: write a corrective migration following the expand/contract discipline in [Schema & migrations (Drizzle)](AGENTS.md#101-schema--migrations-drizzle) (edit `web/lib/server/db/schema.ts`, `pnpm db:generate`, review the emitted SQL in `web/drizzle/`), commit it, and land it through a normal PR to `main`. It applies when `DEPLOY_ENABLED` is `true` and that commit reaches `main` ([Going live](#22-going-live)).

If the `deploy` job's migration step fails for an infra reason rather than a bad migration (a transient AWS error, a placement failure), retry the whole `deploy` job rather than reaching for manual AWS commands. It is idempotent (safe to repeat) end to end: `gh run rerun <run-id> --failed-jobs`.

### 3.2 Debugging a failed worker job

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. A job whose instance has gone without reporting moves to `failed` on the splat page's next poll, once it has gone 15 minutes without a callback (`web/lib/server/reconcileJob.ts`). A job that stays in progress with no callback still has a running instance. Check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log. `aws ec2 get-console-output --instance-id <id>` prints the same log, and keeps it for a short while after the instance terminates.
3. Confirm the instance actually went away. It self-terminates once the worker job reaches a terminal state, and `web/lib/server/ec2Launcher.ts` schedules a hard `shutdown` at the instance's lifetime ceiling (its `MaxLifetimeMinutes` tag, 30 minutes by default) as the first thing user-data runs.
   - **Still running past that ceiling means cloud-init, which runs user-data, never started.** That is a boot failure (a bad AMI, or an instance metadata or networking problem), the one case the scheduled shutdown can't catch.
   - The sweeper (`infra/worker_sweeper.tf`) terminates such an instance within 10 minutes of it passing the ceiling plus 15 minutes, and emails `ALERT_EMAIL` its ID.
4. `scripts/prod/logs-tail.sh worker` for the actual COLMAP/gsplat stack trace. Each stage writes its own log stream, named `<job_id>-<stage>` ([Reading logs and alarms](#33-reading-logs-and-alarms)). A stage whose container never started has no stream, because the instance failed before `docker run`. Use the system log from step 2 instead.

### 3.3 Reading logs and alarms

`scripts/prod/logs-tail.sh SOURCE [SINCE]` follows one CloudWatch log group. Each group keeps its logs for 30 days.

| Source | Shows |
|---|---|
| `web` | The web service's own output: API errors, stack traces, failed database queries. |
| `migrate` | Each deploy's database migration task. |
| `sweeper` | The Lambda that terminates overdue worker instances. It prints one line when it terminates something. |
| `worker` | COLMAP and gsplat output from every worker instance. |

The ALB access logs are in the S3 bucket named by `terraform output access_logs_bucket`, kept for 90 days. They record every request, including ones the ALB rejected before the web service saw them, so use them to investigate abuse.

CloudTrail records who called which AWS API. Its 90-day event history needs no setup. For example, `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances` lists each launch of a worker instance with the role that made it. Nothing in `infra/` configures a trail that writes to S3, so history older than 90 days is gone.

CloudWatch also keeps default metrics for the ALB (`TargetResponseTime`, `HTTPCode_Target_5XX_Count`), the ECS service (CPU and memory), and RDS (CPU, connections, free storage). Look at them in the CloudWatch console.

`infra/alarms.tf` emails `ALERT_EMAIL` through the same SNS topic as the sweeper ([Going live](#22-going-live)). Each alarm names a first step:

- **`ai-gaussian-splatter-alb-target-5xx`:** the web tasks returned several 5xx responses in five minutes. Run `scripts/prod/logs-tail.sh web`.
- **`ai-gaussian-splatter-alb-unhealthy-hosts`:** a web task is failing its health check. Check the ECS service's events with `aws ecs describe-services --cluster ai-gaussian-splatter --services ai-gaussian-splatter-web`.
- **`ai-gaussian-splatter-worker-sweeper-errors`:** the sweeper failed, so an overdue worker instance may keep billing. Run `scripts/prod/logs-tail.sh sweeper`, then list instances tagged `Role=worker` in the EC2 console.
- **`ai-gaussian-splatter-rds-low-storage`:** the database has under 2 GB free. Raise `allocated_storage` in `infra/data.tf`.

---

## 4. Tearing down

`scripts/prod/teardown.sh` undoes [Going live](#22-going-live). Its `--help` lists each step. Run with no arguments, it runs them all, in order:

1. Turns the `deploy` job off, or the next push to `main` would find an empty state and deploy the whole stack again.
2. Runs `terraform destroy` on everything in `infra/`'s state, including the 3 S3 buckets (force-destroyed, contents and all), the RDS instance (no final snapshot), and both ECR repositories with every image in them.
3. Deletes the Terraform state bucket, once the state in it is empty.
4. Schedules the Clerk secret for deletion, deletes the `ai-gaussian-splatter-ci-deploy` role, and deletes the GitHub repository variables. Until the secret's 30-day recovery window ends, `scripts/prod/bootstrap.sh` restores it with its value instead of asking for the key again.

```bash
scripts/prod/teardown.sh
```

Each step refuses while a CI run on `main` is unfinished, where that run could still deploy ([CI/CD](ARCHITECTURE.md#11-cicd)). Each skips what is already gone, so a teardown that stopped partway is finished by running the script again.

**This is a full, unconditional teardown.** Nothing here is protected from deletion, because there's no real data yet to protect (see `infra/data.tf`'s comments on `force_destroy`/`skip_final_snapshot`).

Revisit that before a deploy holds real uploads or splats:

- Add `lifecycle { prevent_destroy = true }` to the 3 buckets (`uploads` and `splats` in `infra/data.tf`, `access_logs` in `infra/web.tf`) and to `aws_db_instance.main`.
- Drop `force_destroy` and `skip_final_snapshot`.

`AWSServiceRoleForEC2Spot`, the GitHub OIDC provider, and the Route 53 hosted zone `DOMAIN_ZONE_NAME` names stay. Each is shared with anything else in the account, and none costs anything meaningful to leave in place.
