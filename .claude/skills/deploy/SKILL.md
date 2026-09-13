---
name: deploy
description: Deploy the AWS Terraform config or ship a new web image to ECS. Use whenever asked to deploy, redeploy, ship, roll out, or promote changes to AWS, including the first deploy into a fresh account, and diagnosing a deploy that reported success but left the site broken.
---

# Deploying

**Deploying is outward-facing and spends money. Get the user's explicit go-ahead before any `terraform apply`, `podman push`, or `aws ecs update-service`, and treat approval as covering that one deploy only.**

[`RUNBOOK.md` § "Deploying to production"](../../../RUNBOOK.md#deploying-to-production) holds the exact command blocks for every step below except the pre-deploy diff, and is the single source for them. Read it before starting. This file is the order to run them in, the decisions along the way, and what bites afterwards.

The `deploy` job is currently off. See [State / what's next](../../../AGENTS.md#state--whats-next). Until it is re-enabled, every ship is a hand apply using the RUNBOOK commands this skill orders. This skill is also the path for a fresh account, an infra-only change, a manual rollback, or a deploy that reported success but left the site broken.

## Pick the path first

| Change | What to run | Why not the other |
|---|---|---|
| `web/` only (no infra) | Build and push both `$SHA-web` and `$SHA-migrate` into `ai-gaussian-splatter` (`web/Dockerfile` targets `web` and `migrator`), then `terraform apply` with `TF_VAR_web_image_tag` set to that SHA (`migrate_image_tag` defaults to the same SHA) | The tag is part of the task definition, so a new tag is a config change. There is no `update-service` step. Apply also points the migrator task definition at `$SHA-migrate` without checking that the tag exists, so push it too or that task has nothing to pull when it runs. Worker images go to `ai-gaussian-splatter-worker` and are a separate RUNBOOK path, not this one |
| `infra/*.tf` | `terraform apply` (all seven `TF_VAR_*` values already exported) | — |
| Fresh account | Create the Clerk secret → create `AWSServiceRoleForEC2Spot` if missing → bootstrap the state backend (`infra/bootstrap/`) → apply just the ECR repository (`-target`) → build + push both `$SHA-web` and `$SHA-migrate` → `terraform apply` → build + push the worker image ([RUNBOOK § "Building and pushing the worker image"](../../../RUNBOOK.md#building-and-pushing-the-worker-image)) | The task definitions reference the secret rather than creating it; the Spot role is referenced too, and has to exist before the first worker job launches; with an empty web repository its tasks have nothing to pull and the circuit breaker (`deployment_circuit_breaker { rollback = true }`) rolls the service back. The worker image can come after the main apply, since `WORKER_IMAGE_URI` is just a string env var. Nothing tries to pull it until a real job launches. |

## Before running anything

1. `export AWS_ACCOUNT_ID=<real account>`. In this flow it names the state bucket for `terraform init`'s `-backend-config` and the ECR registry host that `podman login` and `podman push` target. It doesn't choose the account for `aws` commands, which act on whatever account the current credentials belong to.
2. On a fresh account, start [RUNBOOK § "First-time account setup"](../../../RUNBOOK.md#first-time-account-setup) with its first two blocks. Create the Clerk secret (the `aws secretsmanager create-secret` block), then create `AWSServiceRoleForEC2Spot` if it doesn't already exist. Both are referenced, not created by this config, so applying neither makes them nor checks they exist. Skip the Spot role and the failure doesn't surface until the first worker job tries to launch a Spot instance.
3. Resolve `HOSTED_ZONE_ID`, `CLERK_SECRET_KEY_ARN`, `ALERT_EMAIL`, `APP_PUBLIC_URL`, `WORKER_AMI_ID`, `WEB_IMAGE_TAG`, and `WORKER_IMAGE_TAG` ([RUNBOOK § "Deploying to production"](../../../RUNBOOK.md#deploying-to-production) has the lookup for each), and export each as the matching `TF_VAR_*` (`TF_VAR_hosted_zone_id`, `TF_VAR_clerk_secret_key_arn`, `TF_VAR_alert_email`, `TF_VAR_app_public_url`, `TF_VAR_worker_ami_id`, `TF_VAR_web_image_tag`, `TF_VAR_worker_image_tag`) once per shell session. Terraform picks these up automatically on every invocation below, `plan` included, with no repeated `-var` flags. A forgotten one fails immediately (`terraform plan`/`apply` refuses to proceed with a required variable unset) rather than silently substituting a placeholder. `CLERK_SECRET_KEY_ARN` comes from `describe-secret`, so on a fresh account it needs step 2 done first. What none of this catches is a well-formed wrong value, and `alert_email` is the one that stays silent about it. A mistyped address applies green with no subscription state to check, since the AWS Budget emails it directly. Confirm the address with the user rather than inferring one. `app_public_url` is the one variable whose default is already correct (`https://ai-gaussian-splatter.orky.net`); export it anyway, and only change it alongside `local.app_hostname` in `infra/locals.tf`. Unlike `web_image_tag`, `worker_image_tag` doesn't move on every deploy. GPU worker deployment stays manual, so it only changes when someone hand-pushes a new worker image (step 7). An eighth variable, `TF_VAR_migrate_image_tag`, defaults to `web_image_tag` when unset. Leave it out for a normal manual deploy. It only needs to diverge for the two-phase migrate-then-deploy sequence `.github/workflows/ci.yml` is written to run. That sequence does not run while the `deploy` job is off ([State / what's next](../../../AGENTS.md#state--whats-next)).
4. On a fresh account, finish [RUNBOOK § "First-time account setup"](../../../RUNBOOK.md#first-time-account-setup) before any full `terraform apply`. Bootstrap the state backend (`cd infra/bootstrap && terraform init && terraform apply`), then `terraform init` in `infra/` itself against that bucket, then apply just the ECR repository (`terraform apply -target=aws_ecr_repository.web -target=aws_ecr_lifecycle_policy.web`). The targeted apply still needs step 3's variables. Skip the bootstrap and `terraform init` fails before creating anything.
5. Run the plan and show the user what it says before proceeding.

   ```bash
   cd infra && terraform plan
   ```

   RDS currently carries `deletion_protection = false` and `skip_final_snapshot = true` (no live data to protect yet, see `infra/data.tf`), so a replacing change is both recoverable-in-principle and immediately destructive in practice. It must never be a surprise. Treat any plan touching `aws_db_instance.main` or the 3 S3 buckets with extra care until those get `prevent_destroy` ([RUNBOOK § "Tearing down"](../../../RUNBOOK.md#tearing-down)).
6. If job launches matter for this deploy, a real `TF_VAR_worker_ami_id` is necessary but not sufficient. The worker also needs an actual image pushed under `TF_VAR_worker_image_tag`. Neither variable's `validation` block checks that the AMI or the image tag actually exists, only their shape, so confirm both for real before relying on a job launch working. See step 7 if the worker image hasn't been pushed yet.
7. Building and pushing the worker image is a separate, occasional step, not part of every deploy ([RUNBOOK § "Building and pushing the worker image"](../../../RUNBOOK.md#building-and-pushing-the-worker-image)). Needed once per account before the first real job, and again only when `worker/` changes.

## After a deploy reports success

**A manual `terraform apply` never applies migrations.** Not on boot, and not from this config. The only supported runner is `.github/workflows/ci.yml`'s `deploy` job, and that job is off ([State / what's next](../../../AGENTS.md#state--whats-next)). A fresh environment has no tables and every real route 500s. The target group reports healthy anyway, because `/api/v1/healthz` never touches the database, so a green deploy is not a working site. Launching the migrator task by hand is possible but not a supported path, so don't ([RUNBOOK § "Fixing a bad migration"](../../../RUNBOOK.md#fixing-a-bad-migration)). Do not treat the next two sentences as the rest of this apply. Finishing ["Configuring continuous deployment"](../../../RUNBOOK.md#configuring-continuous-deployment) and re-enabling the job is a later session. After that, a push that touches at least one non-Markdown file is what runs the migrator.

Confirm with a request that actually hits the database, not with healthz.

## When it goes wrong

- **A bad image rolls back on its own.** The circuit breaker restores the previous task definition, which names its own still-present tag. To roll back by hand, redeploy with an older SHA; only `local.releases_kept` of them survive.
- **`ImageTagAlreadyExists` on push.** That commit was already built. The repository is immutable by design, so commit again rather than retagging.
- **Intermittent 502s with nothing in the application logs.** The app never saw those requests. Check `KEEP_ALIVE_TIMEOUT` against the ALB idle timeout ([Networking & TLS](../../../AGENTS.md#networking--tls)).
- **Tasks stop before serving, or start then fail health checks.** Check the task's stopped reason before redeploying. A wrong or partial Clerk secret ARN stops the task at start with a `ResourceInitializationError`. An image built without a real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` starts but 500s every route, `/api/v1/healthz` included, so it fails health checks. An unreachable database fails neither, because healthz never touches it. It shows up as a green deploy whose real routes 500 ([After a deploy reports success](#after-a-deploy-reports-success)).
- **`terraform apply` conflicts with a state lock or a stale plan.** Someone else's apply (or a previous run that didn't clean up) may still hold the S3-native lock; wait for it to finish rather than force-unlocking unless you're certain no other apply is in flight.
