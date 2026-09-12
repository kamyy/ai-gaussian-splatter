---
name: deploy
description: Deploy the AWS stacks or ship a new web image to ECS. Use whenever asked to deploy, redeploy, ship, roll out, or promote changes to AWS — including the first deploy into a fresh account, and diagnosing a deploy that reported success but left the site broken.
---

# Deploying

**Deploying is outward-facing and spends money. Get the user's explicit go-ahead before any `terraform apply`, `podman push`, or `aws ecs update-service`, and treat approval as covering that one deploy only.**

[`RUNBOOK.md` § "Deploying to production"](../../../RUNBOOK.md#deploying-to-production) holds the exact command blocks for every step below except the pre-deploy diff, and is the single source for them. Read it before starting. This file is the order to run them in, the decisions along the way, and what bites afterwards.

**A routine push to `main` no longer needs any of this.** `ci.yml`'s `deploy` job builds, migrates, and rolls the service out on its own. This skill is for what CI doesn't cover: infra-only changes, a fresh account's first deploy, a manual rollback, or diagnosing a deploy that reported success but left the site broken.

## Pick the path first

| Change | What to run | Why not the other |
|---|---|---|
| `web/` only (no infra) | Build and push under `$(git rev-parse --short HEAD)`, then `terraform apply` with `TF_VAR_web_image_tag` set to that SHA | The tag is part of the task definition, so a new tag is a config change. There is no `update-service` step |
| `infra/*.tf` | `terraform apply` (all six `TF_VAR_*` values already exported) | — |
| Fresh account | Create the Clerk secret → create `AWSServiceRoleForEC2Spot` if missing → billing alerts → bootstrap the state backend (`infra/bootstrap/`) → apply just the ECR repository (`-target`) → build + push → `terraform apply` | The task definitions reference the secret rather than creating it; the Spot role is referenced too, and has to exist before the first worker job launches; with an empty repository its tasks have nothing to pull and the circuit breaker (`deployment_circuit_breaker { rollback = true }`) rolls the service back |

## Before running anything

1. `export AWS_ACCOUNT_ID=<real account>` — used to build the state bucket name and the CI role's ARN; unset, `terraform init`'s `-backend-config` and any hand-run `aws` command in this flow point at the wrong (or no) account.
2. Resolve `HOSTED_ZONE_ID`, `CLERK_SECRET_KEY_ARN`, `ALERT_EMAIL`, `APP_PUBLIC_URL`, `WORKER_AMI_ID`, and `WEB_IMAGE_TAG` ([RUNBOOK § "Deploying to production"](../../../RUNBOOK.md#deploying-to-production) has the lookup for each), and export each as the matching `TF_VAR_*` (`TF_VAR_hosted_zone_id`, `TF_VAR_clerk_secret_key_arn`, `TF_VAR_alert_email`, `TF_VAR_app_public_url`, `TF_VAR_worker_ami_id`, `TF_VAR_web_image_tag`) once per shell session — Terraform picks these up automatically on every invocation below, `plan` included, with no repeated `-var` flags. A forgotten one fails immediately (`terraform plan`/`apply` refuses to proceed with a required variable unset) rather than silently substituting a placeholder. `CLERK_SECRET_KEY_ARN` comes from `describe-secret`; on a fresh account that fails until step 3 has created the secret. What none of this catches is a well-formed wrong value, and `alert_email` is the one that stays silent about it. A mistyped address applies green and its SNS subscription never leaves `PendingConfirmation`, so confirm the address with the user rather than inferring one. `app_public_url` is the one variable whose default is already correct (`https://ai-gaussian-splatter.orky.net`); export it anyway, and only change it alongside `local.app_hostname` in `infra/locals.tf`. A seventh variable, `TF_VAR_migrate_image_tag`, defaults to `web_image_tag` when unset. Leave it out for a normal manual deploy; it only needs to diverge for the two-phase migrate-then-deploy dance `ci.yml` does.
3. On a fresh account, finish [RUNBOOK § "First-time account setup"](../../../RUNBOOK.md#first-time-account-setup) before any full `terraform apply`. Create the Clerk secret first (the `aws secretsmanager create-secret` block), then create `AWSServiceRoleForEC2Spot` if it doesn't already exist, then turn on billing alerts, then bootstrap the state backend (`cd infra/bootstrap && terraform init && terraform apply`), then `terraform init` in `infra/` itself against that bucket, then apply just the ECR repository (`terraform apply -target=aws_ecr_repository.web -target=aws_ecr_lifecycle_policy.web`). Both the secret and the Spot role are referenced, not created by this config, so applying neither makes them nor checks they exist. Skip the Spot role and the failure doesn't surface until the first worker job tries to launch a Spot instance. Skip the bootstrap and `terraform init` fails before creating anything.
4. Run the plan and show the user what it says before proceeding.

   ```bash
   cd infra && terraform plan
   ```

   RDS currently carries `deletion_protection = false` and `skip_final_snapshot = true` (no live data to protect yet — see `infra/data.tf`), so a replacing change is both recoverable-in-principle and immediately destructive in practice. It must never be a surprise; treat any plan touching `aws_db_instance.main` or the 3 S3 buckets with extra care until those get `prevent_destroy` back (RUNBOOK's "Tearing down").
5. If job launches matter for this deploy, a real `TF_VAR_worker_ami_id` is necessary but not sufficient. The variable's `validation` block refuses an obviously wrong shape, but the worker still has no ECR repository or pull permissions (`AGENTS.md`, gap 5, M5), so launched jobs fail on `docker login` regardless.

## After a deploy reports success

**A manual `terraform apply` never applies migrations** — not on boot, not from this config; that's only automatic in `ci.yml`'s `deploy` job. A fresh environment has no tables and every real route 500s. The target group reports healthy anyway, because `/api/v1/healthz` never touches the database, so a green deploy is not a working site. There is no out-of-band apply ([RUNBOOK § "Fixing a bad migration"](../../../RUNBOOK.md#fixing-a-bad-migration)): finish ["Configuring continuous deployment"](../../../RUNBOOK.md#configuring-continuous-deployment), then push to `main` so that job runs the migrator.

Confirm with a request that actually hits the database, not with healthz.

## When it goes wrong

- **A bad image rolls back on its own.** The circuit breaker restores the previous task definition, which names its own still-present tag. To roll back by hand, redeploy with an older SHA; only `local.releases_kept` of them survive.
- **`ImageTagAlreadyExists` on push** — that commit was already built. The repository is immutable by design; commit again rather than retagging.
- **Intermittent 502s with nothing in the application logs** — the app never saw those requests. Check `KEEP_ALIVE_TIMEOUT` against the ALB idle timeout (`AGENTS.md`, Infra).
- **Tasks start then fail health checks.** Check the task's stopped reason before redeploying; a missing secret or an unreachable database looks identical from the ALB's side.
- **`terraform apply` conflicts with a state lock or a stale plan.** Someone else's apply (or a previous run that didn't clean up) may still hold the S3-native lock; wait for it to finish rather than force-unlocking unless you're certain no other apply is in flight.
