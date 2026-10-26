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
  - [2.7 Setting up Google sign-in](#27-setting-up-google-sign-in)
- [3. Troubleshooting](#3-troubleshooting)
  - [3.1 Fixing a bad migration](#31-fixing-a-bad-migration)
  - [3.2 Debugging a failed worker job](#32-debugging-a-failed-worker-job)
  - [3.3 Reading logs and alarms](#33-reading-logs-and-alarms)
  - [3.4 Rotating the Clerk secret](#34-rotating-the-clerk-secret)
  - [3.5 Refreshing the RDS CA bundle](#35-refreshing-the-rds-ca-bundle)
- [4. Tearing down](#4-tearing-down)

---

## 1. Local development

Local development runs against the dev buckets and the `splat-pg` container, never the deployed account.

```text
                      ┌──────────┐   sign in ┌───────────────────┐
                      │ Browser  ├──────────►│ Clerk development │
                      └──┬──┬──▲─┘           │ instance          │
                         │  │  │             └───────────────────┘
                         │  │  │ GET .spz
                         │  │  └────────────────────────────────────────────────────┐
                         │  │ PUT photos                                            │
                         │  └───────────────────────────────────────┐               │
             pages + API │                                          │               │
                         │                                          │               │
┌─ Your machine ─────────┼───────────────────────────────┐   ┌──────┼─ AWS account ─┼───┐
│                        │                               │   │      ▼               │   │
│                        ▼                               │   │  ╭───────────────╮   │   │
│ ┌──────────┐ Clerk + ┌─────────────────┐  ╭──────────╮ │   │  │ dev uploads   │   │   │
│ │ web/.env ├────────►│ next dev        ├─►│ splat-pg │ │   │  │ bucket        │   │   │
│ └──────────┘         │ localhost:3000  │  ╰──────────╯ │   │  ╰───────┬───────╯   │   │
│             dev keys └──┬───────────▲──┘               │   │          │           │   │
│       podman run with   │           │                  │   │          │           │   │
│       dev keys          │           │ status callback  │   │          │           │   │
│                         ▼           │                  │   │          │           │   │
│                      ┌──────────────┴──┐               │   │          │           │   │
│                      │ Podman worker   │◄──────────────┼───┼──────────┘           │   │
│                      │ container,      │               │   │  ╭───────────────╮   │   │
│                      │ per stage       ├───────────────┼───┼─►│ dev splats    ├───┘   │
│                      └───────┬─────────┘               │   │  │ bucket        │       │
│                              ▼                         │   │  ╰───────────────╯       │
│                      ╭─────────────────╮               │   │                          │
│                      │ worker/jobdir/  │               │   │                          │
│                      │ <jobId>/        │               │   └──────────────────────────┘
│                      ╰─────────────────╯               │
└────────────────────────────────────────────────────────┘
```

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

Under `pnpm dev`, each stage of a worker job runs in Podman on your own machine instead of on an EC2 spot instance. The train stage needs a real NVIDIA GPU with its driver installed, and `scripts/dev/setup.sh gpu` sets up the rest. The reconstruct stage runs COLMAP on your CPU.

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

After that, a human only releases worker changes ([Releasing a worker change](#23-releasing-a-worker-change)), previews a plan ([Running Terraform locally](#24-running-terraform-locally)), picks the landing page's examples ([Choosing the landing page's examples](#25-choosing-the-landing-pages-examples)), and tunes the runtime settings ([Tuning runtime settings](#26-tuning-runtime-settings)). Going live's Google sign-in step has its own section ([Setting up Google sign-in](#27-setting-up-google-sign-in)).

CI's `deploy` job (`.github/workflows/deploy.yml`) does every deploy, including the first one into an empty account. It runs on a push to `main` that changes more than just `.md` files or `LICENSE`, and on a run started by hand on `main`, but only while the `DEPLOY_ENABLED` GitHub repository variable is `true`.

```text
┌───────────────────────────────────┐
│ scripts/prod/bootstrap.sh deploy  │
│ or                                │
│ scripts/prod/worker-push-image.sh │
└─────────────────┬─────────────────┘
                  ▼
┌──────────────────────┐   ┌───────────────────────┐
│ push to main         │   │ gh workflow run       │
│ changing more than   │   │ ci.yml --ref main     │
│ .md or LICENSE       │   └───────────┬───────────┘
└──────────┬───────────┘               │
           └──────────────┬────────────┘
                          │
┌─────────────────────────┼──── .github/workflows/ci.yml ──┐
│               ┌─────────┴─────────────┐                  │
│               ▼                       ▼                  │
│   ┌──────────────────┐   ┌──────────────────────────┐    │
│   │ lint-format      │   │ capture-deploy-enabled   │    │
│   │ worker           │   │ records DEPLOY_ENABLED   │    │
│   │ web              │   └─────────────┬────────────┘    │
│   │ infra            │                 │                 │
│   └─────────┬────────┘                 │                 │
│             │ all pass                 │ enabled is true │
│             └────────────┬─────────────┘                 │
│                          ▼                               │
│                    ┌──────────┐                          │
│                    │ deploy   │                          │
│                    └─────┬────┘                          │
└──────────────────────────┼───────────────────────────────┘
                           │ workflow_call
                           ▼
              ┌──────────────────────────────┐
              │ .github/workflows/deploy.yml │
              └──────────────────────────────┘
```

Each deploy builds the web images only when `web/` changed, and runs the migration between two `terraform apply` calls so that no task serves new code before its migration has run ([Migration ordering](ARCHITECTURE.md#113-migration-ordering)).

```text
┌────────────────────────────┐
│ Check repository variables │
└─────┬──────────────────────┘
      ▼
┌─────────────────────────────────────────────┐
│ Resolve tags                                │
│ NEW_TAG is web/'s tree id                   │
│ OLD_TAG is the image the service runs now   │
└─────┬───────────────────────────────────────┘
      ▼
   aws_ecs_service.web in Terraform state?
      │ yes                  │ no, first deploy
      │                      ▼
      │      ┌───────────────────────────────┐
      │      │ 1 · apply ECR repository only │
      │      │ OLD_TAG = NEW_TAG             │
      │      └───────────────┬───────────────┘
      ├──────────────────────┘
      ▼
   NEW_TAG-web and NEW_TAG-migrate already in ECR?
      │ yes                  │ no
      │                      ▼
      │      ┌────────────────────────────────┐
      │      │ 2 · build and push both images │
      │      └───────────────┬────────────────┘
      ├──────────────────────┘
      ▼
┌─────────────────────────────────────────────┐
│ 3 · terraform apply                         │
│ service image OLD_TAG, migration task       │
│ NEW_TAG                                     │
└─────┬───────────────────────────────────────┘
      ▼
┌───────────────────┐
│ 4 · Run migration │
└─────┬─────────────┘
      ▼
   migration task exit code 0?
      │ yes                  │ no
      ▼                      ▼
┌───────────────────────┐  ╭─────────────────────────────╮
│ 5 · terraform apply   │  │ run fails                   │
│ service image NEW_TAG │  │ service image stays OLD_TAG │
└─────┬─────────────────┘  ╰─────────────────────────────╯
      ▼
┌────────────────────────────┐
│ Smoke test                 │
│ a DB-backed route must 404 │
└────────────────────────────┘
```

1. **Create the ECR repository**, on the first deploy only. The service can't be created before the image it names is pushed, so the `ai-gaussian-splatter` ECR repository (`infra/registry.tf`) goes first.
2. **Build and push the web images**, tagged `<tree>-web` and `<tree>-migrate` ([Image tags](ARCHITECTURE.md#111-image-tags)). Skipped when both tags are already in ECR.
3. **Apply the rest of the stack**, with the migration task on the new image and the service still on the old one. On the first deploy `OLD_TAG` equals `NEW_TAG`, so this creates the whole stack, service included.
4. **Run the migration** as a one-off ECS task. A failure stops the run here, so the service keeps serving its old image.
5. **Roll the service forward** to the new image, with a second `terraform apply`. The deployment circuit breaker rolls it back if the new tasks fail their health checks.

A push that leaves `web/` untouched keeps `NEW_TAG` equal to `OLD_TAG`, so steps 2 and 5 do nothing. Step 3 can still replace the running tasks, because the web task definition carries the two worker image URIs and `KEEP_ALIVE_TIMEOUT` as well as the image. [Releasing a worker change](#23-releasing-a-worker-change) relies on that replacement.

```text
change under web/
 └─► NEW_TAG differs from OLD_TAG
      ├─► step 2 builds new images
      └─► step 5 replaces the tasks with the new image

change only under infra/, worker/ or scripts/, or a new WORKER_IMAGE_TAG
 ├─► NEW_TAG equals OLD_TAG
 │    └─► steps 2 and 5 do nothing
 └─► step 3 changes the web task definition?
      ├─ yes ─► step 3 replaces the tasks: same image, new settings
      └─ no ──► tasks keep running
```

### 2.1 Signing in to AWS

Run every script in this section as an admin IAM identity signed in with `aws login`, which needs AWS CLI 2.32.0 or later. Neither the `ai-gaussian-splatter-dev` user from [First-time setup](#11-first-time-setup) nor the CI role can stand in for it. The scripts also need `gh` signed in with write access to this GitHub repository.

```bash
aws login # Needed again only after the session expires, up to 12 hours later.
```

### 2.2 Going live

`scripts/prod/bootstrap.sh` takes a fresh account to a live deploy. Its `--help` lists each step and what it creates. Run with no arguments, it runs them all, in order:

1. Creates what `infra/` never manages: the Clerk secret `ai-gaussian-splatter/clerk-secret-key` (it prompts for the `sk_live_...` value), the account-wide `AWSServiceRoleForEC2Spot` role, and the Terraform state bucket `ai-gaussian-splatter-tfstate-<account-id>`.
2. Requests two spot vCPU quotas, because a new account's GPU quota is 0 and its standard quota can be lower than one reconstruct instance needs. It asks before the first deploy so the approval overlaps the deploy's wait. Declining, or a failed request, doesn't stop the run.
   - A GPU quota of 8 ("All G and VT Spot Instance Requests") lets two train stages run at once. Until AWS raises it, every train launch fails.
   - A standard quota of 64 ("All Standard Spot Instance Requests") lets two reconstruct stages run at once, since each reconstruct instance has 32 vCPUs. Until AWS raises it, every reconstruct launch fails.
3. Creates GitHub's OIDC provider and the `ai-gaussian-splatter-ci-deploy` role the `deploy` job assumes.
4. Sets the GitHub repository variables `.github/workflows/deploy.yml` reads.
5. Turns the `deploy` job on.
6. Runs the first deploy and waits for it, which takes around 20 minutes, most of it ACM certificate validation.
7. Builds and pushes the worker images ([Releasing a worker change](#23-releasing-a-worker-change)).

```bash
scripts/prod/bootstrap.sh
```

What each step creates, and what reads it afterwards:

```text
scripts/prod/bootstrap.sh
 │
 ├─ prereqs ─┬─► ai-gaussian-splatter/clerk-secret-key ───── read at start ───► web task
 │           ├─► AWSServiceRoleForEC2Spot ────────────────── needed by ───────► worker instances
 │           └─► ai-gaussian-splatter-tfstate-<account-id> ─ terraform init ──► deploy job
 │
 ├─ quota ─────► GPU and standard spot vCPU quota requests ── allow ───────────► worker instances
 │
 ├─ ci-role ─┬─► GitHub OIDC provider ────────────────────── signs in ────────► deploy job
 │           └─► ai-gaussian-splatter-ci-deploy ──────────── assumed by ──────► deploy job
 │
 ├─ gh-vars ───► GitHub repository variables ─────────────── read by ─────────► deploy job
 │
 ├─ enable ────► DEPLOY_ENABLED ──────────────────────────── gates ───────────► deploy job
 │
 ├─ deploy ──────────────────────────────────────────────── starts ──────────► deploy job
 │
 └─ worker ──┬─► worker images ───────────────────────────── pulled by ───────► worker instances
             └─► WORKER_IMAGE_TAG ────────────────────────── read by ─────────► deploy job
```

Every step skips what already exists, so re-running the script, or one step of it (`scripts/prod/bootstrap.sh gh-vars`), is safe.

It looks up `AWS_ACCOUNT_ID`, `HOSTED_ZONE_ID` and `CLERK_SECRET_KEY_ARN`. The hosted zone is referenced only, not created, so it must already exist. It asks for these, defaulting to each one's current value:

- `DOMAIN_ZONE_NAME` is the public DNS zone the app is served from, e.g. `orky.net`. The app's hostname, certificate, DNS record and CORS origins are all built from it.
- `ALERT_EMAIL` is where the AWS Budget (`infra/budgets.tf`) sends spend alerts, and where the worker sweeper (`infra/worker_sweeper.tf`) and the alarms send theirs.
- `CLERK_PUBLISHABLE_KEY` is the `pk_live_...` key, not the secret one. `web/Dockerfile` compiles it into the browser bundle, so a later change to it reaches users on the next deploy that changes `web/` ([Image tags](ARCHITECTURE.md#111-image-tags)).
- `GA_MEASUREMENT_ID` is the Google Analytics 4 measurement ID (`G-...`) and is optional. Leaving it empty builds the app without Google Analytics or its privacy banner. An empty answer keeps the current value, so turning analytics off is `gh variable delete GA_MEASUREMENT_ID`.
- `WORKER_AMI_ID` is the AMI every worker instance boots. The image must already carry Docker, the NVIDIA driver and container toolkit, and the AWS CLI. AWS's Deep Learning Base GPU AMIs do, and the script lists the newest five before asking. The driver is for the train stage. The reconstruct stage's CPU instance boots the same AMI and leaves the driver unused.

The script doesn't ask for `WORKER_IMAGE_TAG`. When it is unset, the script sets it to the tag step 7 pushes the worker images under, which is `worker/`'s git tree id on `origin/main`. After that, only [Releasing a worker change](#23-releasing-a-worker-change) changes it.

The CI role's policy, `scripts/prod/ci-role-policies/deploy.json`, is a reasonable starting point, not an exhaustively verified minimal policy, so expect `AccessDenied` during the first deploy. Add the missing action to that file, run `scripts/prod/bootstrap.sh ci-role`, then rerun the `deploy` job (`gh run rerun <run-id> --failed-jobs`).

Seven things are left for you once the script finishes:

1. Click the subscription link AWS emails to `ALERT_EMAIL`, or the sweeper's and the alarms' emails are never delivered ([Compute](ARCHITECTURE.md#3-compute)). A subscription still reading `PendingConfirmation` after the email should have arrived usually means a typo'd address:
   ```bash
   aws sns list-subscriptions --region "$(source scripts/lib/terraform.sh && tf_get_aws_region)" \
     --query "Subscriptions[?ends_with(TopicArn, ':ai-gaussian-splatter-alerts')].SubscriptionArn"
   ```
2. In the production Clerk dashboard's Legal page, turn on **Require express consent to legal documents** and set the terms and privacy policy URLs to the app's `/terms` and `/privacy` pages.
3. On Clerk's [Domains page](https://dashboard.clerk.com/last-active?path=domains), press **Deploy certificates** once every record shows as verified. The deploy creates those records from `local.clerk_cnames` in `infra/locals.tf`. If the Clerk production instance is ever replaced, copy its new targets into `local.clerk_cnames` first.
4. On Clerk's **User & authentication** page, turn off **Allow users to delete their accounts**. Users delete their accounts through the app's own account menu item instead, which also deletes their splats.
5. Run `scripts/prod/ssm.sh` and check it lists every runtime setting. The new-splat page showing "Processing is paused" with every setting present means the task role can't read them ([Runtime settings](ARCHITECTURE.md#95-runtime-settings)).
6. Set up Google sign-in ([Setting up Google sign-in](#27-setting-up-google-sign-in)).
7. Wait for AWS to approve the quota requests from step 2, which takes hours to a couple of days. Until then every worker job fails at launch with "GPU processing isn't available on this site yet". `scripts/prod/bootstrap.sh quota` reports whether the request is still pending.

If a new image fails its health checks, the circuit breaker rolls back to the previous task definition. To roll back by hand, revert the change and push. A schema change gets a corrective migration instead ([Fixing a bad migration](#31-fixing-a-bad-migration)).

### 2.3 Releasing a worker change

No deploy builds the worker images, so a merged `worker/` change reaches worker instances only through this script. It builds `worker/` as `main` holds it on GitHub, never this checkout, so the branch you're on and anything uncommitted don't matter.

```bash
scripts/prod/worker-push-image.sh
```

It pushes both images to the `ai-gaussian-splatter-worker` ECR repository tagged with `worker/`'s tree id, sets the `WORKER_IMAGE_TAG` GitHub repository variable to that tag, then starts a run of `.github/workflows/ci.yml` on `main` and waits for it. That run's deploy points both worker image URIs on the web task definition at the new images and replaces the running tasks. Until it finishes, every worker instance still launches with the old images. A tag that is already built and deployed is a no-op, so a re-run after a failure finishes only what is left.

```text
scripts/prod/worker-push-image.sh                                            ai-gaussian-splatter-worker ECR
                                 GitHub               web tasks     worker instance
          │                         │                     │                │                │
          │ push both images        │                     │                │                │
          ├─────────────────────────┼─────────────────────┼────────────────┼───────────────►│
          │                         │                     │                │                │
          │ set WORKER_IMAGE_TAG,   │                     │                │                │
          │ start ci.yml on main    │                     │                │                │
          ├────────────────────────►│                     │                │                │
          │                         │                     │                │                │
          │                         │ deploy job swaps in │                │                │
          │                         │ new worker image    │                │                │
          │                         │ URIs                │                │                │
          │                         ├────────────────────►│                │                │
          │                         │                     │                │                │
          │                         │ until then,         │                │                │
          │                         │ launches use the    │                │                │
          │                         │ old images          │                │                │
          │                         │                     │                │                │
          │                         │                     │ RunInstances   │                │
          │                         │                     ├───────────────►│                │
          │                         │                     │                │                │
          │                         │                     │                │ pull its image │
          │                         │                     │                ├───────────────►│
          │                         │                     │                │                │
```

Only the last `local.worker_releases_kept` images are kept (`infra/locals.tf`), which makes a `WORKER_IMAGE_TAG` that was set but never deployed the risk. Once that many newer images exist, the lifecycle policy expires the tag the web app still names, and every worker instance then fails its image pull and bills until its lifetime-ceiling shutdown (the `worker-max-lifetime-minutes` runtime setting it launched with).

### 2.4 Running Terraform locally

A `terraform plan` preview and a teardown are the only Terraform a human runs against `infra/`. Don't `apply` from here, because only the `deploy` job runs migrations before rolling the service.

`scripts/prod/terraform-plan.sh` needs you signed in ([Signing in to AWS](#21-signing-in-to-aws)) to the account the `AWS_ACCOUNT_ID` GitHub repository variable names. It takes every Terraform variable from the GitHub repository variables except `web_image_tag`, which it reads from the task definition the service is running so the plan doesn't show an image change that isn't coming.

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

```text
┌─────────────────────┐
│ scripts/prod/ssm.sh │
└──────────┬──────────┘
           │ validates, then writes
           ▼
╭─────────────────────────────╮                  ╭──────────────────────╮
│ SSM parameters              │                  │ web/.env             │
│ under RUNTIME_SETTINGS_PATH │                  │ MAX_JOBS_PER_DAY, …  │
╰──────────┬──────────────────╯                  ╰──────────┬───────────╯
           │ one read, cached for a minute                  │
           ▼                                                ▼
┌───────────────────────────────────┐            ┌─────────────────────────────┐
│ web service                       │            │ next dev                    │
│ web/lib/server/runtimeSettings.ts │            │ RUNTIME_SETTINGS_PATH unset │
└──────────┬────────────────────────┘            └─────────────────────────────┘
           │ RunInstances with the instance type
           │ and MaxLifetimeMinutes tag
           ▼
┌─────────────────┐
│ worker instance │
└─────────────────┘
```

```bash
scripts/prod/ssm.sh                            # prints every setting
scripts/prod/ssm.sh processing-enabled false   # changes one
```

`scripts/prod/ssm.sh --help` lists every setting and the values it accepts. It refuses a value the web service would reject, since the web service would otherwise fall back to that setting's default and pause processing site-wide.

- **Pausing processing** stops new reconstruct and train launches only. Stages already running finish, and the new-splat page and the splat page tell visitors processing is paused.
- **A new lifetime ceiling** applies to instances launched after the change. Each running instance keeps the ceiling it launched with.
- **A new train instance type** must be one whose GPU `worker/Dockerfile` compiles gsplat's kernels for, so the script accepts only those.
- **A new reconstruct instance type** must be a CPU type, because the reconstruct stage's container is given no GPU. The script accepts only the types `web/lib/server/runtimeSettings.ts` lists.

For local dev, each setting except the lifetime ceiling and the two instance types is an env var in `web/.env` named after it, such as `MAX_JOBS_PER_DAY` (`web/.env.example`). Those three only an EC2 launch reads, and `pnpm dev` never makes one.

### 2.7 Setting up Google sign-in

A production Clerk instance has no shared Google client. Without its own credentials, the sign-in button fails at Google with "Missing required parameter: client_id". Keep the Clerk tab open throughout, because step 1 produces a value step 4 needs.

1. In the production Clerk dashboard's [SSO connections page](https://dashboard.clerk.com/last-active?path=user-authentication/sso-connections), add Google for all users, or open it if it is listed. Turn on **Enable for sign-up and sign-in** and **Use custom credentials**, then copy the **Authorized Redirect URI** Clerk shows.
2. In the [Google Cloud Console](https://console.cloud.google.com/), pick or create a project. Any project works, since only the OAuth client lives there. Under **APIs & Services**, open **OAuth consent screen**. If it offers **Get started**, press it, enter the app name and your support email, choose **External** as the audience, and add a contact email.
3. On the consent screen, set the publishing status to **In production**. **Testing** lets only listed test users sign in, up to 100. Google may ask to verify the app name, logo and scopes first.
4. Under **APIs & Services**, then **Credentials**, create an **OAuth client ID** of type **Web application**. Add `https://ai-gaussian-splatter.<DOMAIN_ZONE_NAME>` as an authorized JavaScript origin, using the `DOMAIN_ZONE_NAME` value from the script. Add the redirect URI from step 1 as an authorized redirect URI.
5. Copy the **Client ID** and **Client secret** from the dialog Google shows. The secret is hard to find again later. Paste both into the Google connection in Clerk and press **Save**.
6. Check it: in a private window, open the app's sign-in page and press **Continue with Google**. Google's account chooser should appear. If an error appears instead, look for an `oauth_callback.failed` event in Clerk's Application Logs.

---

## 3. Troubleshooting

Where to start once a migration or a worker job has already failed.

### 3.1 Fixing a bad migration

The only supported production apply is the `deploy` job (`.github/workflows/deploy.yml`), which runs the `migrator` image (`web/Dockerfile`) as a one-off ECS task before rolling the service forward. There is no supported way to reach the database by hand. The RDS instance (`infra/data.tf`) sits in an isolated subnet with no NAT gateway and no bastion. It accepts connections only from `aws_security_group.web` on port 5432, which is how the migration task gets to it.

Fix a bad migration the same way you'd fix any other bug: write a corrective migration following the expand/contract discipline in [Schema & migrations (Drizzle)](AGENTS.md#101-schema--migrations-drizzle) (edit `web/lib/server/db/schema.ts`, `pnpm db:generate`, review the emitted SQL in `web/drizzle/`), commit it, and land it through a normal PR to `main`. It applies when `DEPLOY_ENABLED` is `true` and that commit reaches `main` ([Going live](#22-going-live)).

If the `deploy` job's migration step fails for an infra reason rather than a bad migration (a transient AWS error, a placement failure), retry the whole `deploy` job rather than reaching for manual AWS commands. It is idempotent (safe to repeat) end to end: `gh run rerun <run-id> --failed-jobs`.

### 3.2 Debugging a failed worker job

Each step below narrows down where the worker job failed:

```text
jobs.status
 ├─ failed ────────────────────────────────────────────────────┐
 └─ still in progress                                          │
     │                                                         │
     ▼                                                         │
    EC2 instance tagged JobId=<job_id> running?                │
     ├─ no ──► the splat page's next poll marks it failed      │
     │         after 15 minutes without a callback ────────────┤
     └─ yes                                                    │
         │                                                     │
         ▼                                                     │
        past its MaxLifetimeMinutes tag?                       │
         ├─ yes ─► boot failure: cloud-init never ran.         │
         │         Read the system log.                        │
         │         The sweeper terminates it and emails.       │
         └─ no, still working ─────────────────────────────────┤
                                                               ▼
                                     log stream <job_id>-<stage> exists?
                                      ├─ no ──► container never started:
                                      │         read the system log
                                      └─ yes ─► scripts/prod/logs-tail.sh worker
                                                scripts/prod/logs-timings.sh
```

1. Check `jobs.status` and `jobs.error_message` for the splat (`GET /api/v1/splats/{id}/jobs/latest`).
2. A job whose instance has gone without reporting moves to `failed` on the splat page's next poll, once it has gone 15 minutes without a callback (`web/lib/server/reconcileJob.ts`). A job that stays in progress with no callback still has a running instance. Check the EC2 console for the tagged instance (`Role=worker`, `JobId=<job_id>`) and its system log. `aws ec2 get-console-output --instance-id <id>` prints the same log, and keeps it for a short while after the instance terminates.
3. Confirm the instance actually went away. It self-terminates once the worker job reaches a terminal state, and `web/lib/server/workerLauncher.ts` schedules a hard `shutdown` at the instance's lifetime ceiling (its `MaxLifetimeMinutes` tag, 30 minutes by default) as the first thing user-data runs.
   - **Still running past that ceiling means cloud-init, which runs user-data, never started.** That is a boot failure (a bad AMI, or an instance metadata or networking problem), the one case the scheduled shutdown can't catch.
   - The sweeper (`infra/worker_sweeper.tf`) terminates such an instance within 10 minutes of it passing the ceiling plus 15 minutes, and emails `ALERT_EMAIL` its ID.
4. `scripts/prod/logs-tail.sh worker` for the actual COLMAP/gsplat stack trace. Each stage writes its own log stream, named `<job_id>-<stage>` ([Reading logs and alarms](#33-reading-logs-and-alarms)). A stage whose container never started has no stream, because the instance failed before `docker run`. Use the system log from step 2 instead.
5. `scripts/prod/logs-timings.sh 1d <job_id>` lists how long each phase of the job ran, with `ok=false` on the phase that failed. See its `--help`.

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

### 3.4 Rotating the Clerk secret

Update the secret's value in Secrets Manager, then start a new deployment:

```bash
aws ecs update-service --region "$(source scripts/lib/terraform.sh && tf_get_aws_region)" \
  --cluster ai-gaussian-splatter --service ai-gaussian-splatter-web --force-new-deployment
```

ECS only resolves secrets at task start, so the running tasks keep the old value until that new deployment replaces them.

### 3.5 Refreshing the RDS CA bundle

The web service and the migration task trust RDS's TLS certificate through `web/certs/rds-global-bundle.pem`, Amazon's RDS certificate authority (CA) bundle. Refresh it before moving the app to a region the bundle has no root CA for, or when Amazon rotates its RDS root CAs. A connection that fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` points to a stale bundle.

```bash
curl -sSfo web/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

The download is only as trustworthy as curl's HTTPS check of `truststore.pki.rds.amazonaws.com`, so never fetch it with `-k` or over plain HTTP.

Before opening the PR, compare the certificates in the new file against the committed ones. This prints one line per certificate that was added or removed, with its subject and SHA-256 fingerprint:

```bash
list_certs() {
  local dir f
  dir=$(mktemp -d)
  awk -v d="$dir" '/BEGIN CERT/{n++} {print > (d "/" n ".pem")}'
  for f in "$dir"/*.pem; do
    openssl x509 -in "$f" -noout -subject -fingerprint -sha256 | paste -sd ' '
  done | sort
  rm -r "$dir"
}
diff <(git show HEAD:web/certs/rds-global-bundle.pem | list_certs) <(list_certs < web/certs/rds-global-bundle.pem)
```

Every line should be an added `OU=Amazon RDS` root CA for a region or rotation you expected. A removed or changed root for the region the app runs in, or any subject outside `OU=Amazon RDS`, means the download is wrong. Don't commit it.

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
