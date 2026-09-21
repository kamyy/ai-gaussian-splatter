---
name: deploy
description: Deploy the AWS Terraform config or ship a new web image to ECS. Use whenever asked to deploy, redeploy, ship, roll out, or promote changes to AWS, including the first deploy into a fresh account, and diagnosing a deploy that reported success but left the site broken.
---

# Deploying

**Deploying is outward-facing and spends money. Get the user's explicit go-ahead before turning the `deploy` job on, merging anything that triggers it, pushing an image, or running `terraform destroy`, and treat approval as covering that one action only.**

[`RUNBOOK.md` § "Deploying to production"](../../../RUNBOOK.md#2-deploying-to-production) names the script in `scripts/prod/` that runs each step, and those scripts are the single source for the commands. Read it before starting. This file is the order to run them in, the decisions along the way, and what bites afterwards.

The `deploy` job (`.github/workflows/deploy.yml`) does every deploy, the first one into an empty account included. It runs only when `DEPLOY_ENABLED` is `true` ([Going live](../../../RUNBOOK.md#26-going-live)). While that variable is not `true`, nothing deploys. There is no hand-apply path for `infra/`.

## Pick the path first

| Situation | What to do |
|---|---|
| `web/` change, `deploy` job on | Land it on `main` through a PR. The `deploy` job builds, migrates, and rolls out. A push touching only `.md` files or `LICENSE` skips the whole workflow (`paths-ignore`). |
| `infra/*.tf` change, `deploy` job on | Same PR route. The `deploy` job applies Terraform and migrates but builds no image, because the image tag is `web/`'s tree id ([Image tags](../../../ARCHITECTURE.md#111-image-tags)). It still replaces the running tasks when the apply changes the web task definition, so treat it as a rollout and check the plan. |
| Fresh or torn-down account | [Creating account prerequisites](../../../RUNBOOK.md#22-creating-account-prerequisites) (`scripts/prod/create-account-prereqs.sh`) → [Configuring continuous deployment](../../../RUNBOOK.md#23-configuring-continuous-deployment) (`scripts/prod/configure-ci-role.sh`, then `scripts/prod/set-gh-repo-variables.sh`) → [Going live](../../../RUNBOOK.md#26-going-live) (`scripts/prod/set-deploy-enabled.sh true`). After the first run, `scripts/prod/worker-push-image.sh`. |
| New worker image | `scripts/prod/worker-push-image.sh` ([Building and pushing the worker image](../../../RUNBOOK.md#27-building-and-pushing-the-worker-image)). It also updates `WORKER_IMAGE_TAG`, and the next deploy points `WORKER_RECONSTRUCT_IMAGE_URI` and `WORKER_TRAIN_IMAGE_URI` at it. |
| Preview a change | `scripts/prod/terraform-plan.sh` ([Running Terraform locally](../../../RUNBOOK.md#28-running-terraform-locally)). Never `apply` from there. Only the `deploy` job runs migrations before rolling the service. |
| Roll back | The circuit breaker rolls a bad image back on its own. To roll back by hand, revert the change and push; that reuses the image already in ECR when it hasn't expired, and rebuilds it when it has. A schema change gets a corrective migration instead ([Fixing a bad migration](../../../RUNBOOK.md#31-fixing-a-bad-migration)). |
| Tear down | `scripts/prod/set-deploy-enabled.sh false`, then `scripts/prod/terraform-destroy.sh`. Both refuse while CI is unfinished ([Tearing down](../../../RUNBOOK.md#4-tearing-down)). |

## Before turning the `deploy` job on

1. `aws` commands act on whatever account the signed-in credentials belong to. Each script prints that account before creating anything. Confirm it's the account the user means before answering the script's prompt.
2. Every repository variable must be set. An unset one arrives as `""`, which each Terraform variable's `validation` block rejects, so the `deploy` job fails at its first apply rather than deploying a placeholder. `DOMAIN_ZONE_NAME` also gets an earlier check step, because that job builds an image before its first apply. On a fresh account no worker image exists for `WORKER_IMAGE_TAG` to name. Any commit SHA passes validation until one is pushed.
3. Validation can't catch a well-formed wrong value, and `ALERT_EMAIL` is the one that stays silent about it. A mistyped address applies green with no subscription state to check, since the AWS Budget emails it directly. Confirm the address with the user rather than inferring one. `DOMAIN_ZONE_NAME` is the only place the app's domain is set; the hostname, certificate, DNS record, CORS origins, and the deploy job's smoke-check origin are all derived from it.
4. If worker jobs matter, confirm the AMI in `WORKER_AMI_ID` and the image under `WORKER_IMAGE_TAG` both exist. Their `validation` blocks check shape only.
5. The state bucket must already exist ([Creating account prerequisites](../../../RUNBOOK.md#22-creating-account-prerequisites)). Skip it and the `deploy` job's `terraform init` fails.

## Before merging an `infra/` change

Run `scripts/prod/terraform-plan.sh` and show the user what it says. RDS currently carries `deletion_protection = false` and `skip_final_snapshot = true` (no live data to protect yet, see `infra/data.tf`), so a replacing change is immediately destructive. It must never be a surprise. Treat any plan touching `aws_db_instance.main` or the 3 S3 buckets (`infra/data.tf`, plus `access_logs` in `infra/web.tf`) with extra care until those get `prevent_destroy` ([Tearing down](../../../RUNBOOK.md#4-tearing-down)).

## After a deploy reports success

The job's smoke test waits for the service to settle, then requests a route that queries the database. A green run means the database answered. `/api/v1/healthz` never touches the database, so a healthy target group alone says nothing about it.

On the first deploy the service starts before its migration, so real routes 500 until the migration task finishes. The smoke test runs after both.

## When it goes wrong

- **`AccessDenied` on the first deploy.** It's the first time the CI role creates every resource rather than updating them, and its policy ([Creating the OIDC provider and CI role](../../../RUNBOOK.md#24-creating-the-oidc-provider-and-ci-role)) is a starting point, not a verified minimum. Add the missing action to `DEPLOY_POLICY` in `scripts/prod/configure-ci-role.sh`, re-run that script, then `gh run rerun <run-id> --failed-jobs`. The job is safe to rerun from any step.
- **A bad image rolls back on its own.** The circuit breaker restores the previous task definition, which names its own still-present tag. Only `local.releases_kept` releases survive.
- **`ImageTagAlreadyExists` pushing the worker image.** That commit was already built. The repository is immutable by design, so commit again rather than retagging.
- **Intermittent 502s with nothing in the application logs.** The app never saw those requests. Check `KEEP_ALIVE_TIMEOUT` against the ALB idle timeout ([Networking & TLS](../../../AGENTS.md#82-networking--tls)).
- **Tasks stop before serving, or start then fail health checks.** Check the task's stopped reason before redeploying. A wrong or partial Clerk secret ARN stops the task at start with a `ResourceInitializationError`. An image built without a real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` starts but 500s every route, `/api/v1/healthz` included, so it fails health checks. An unreachable database fails neither, because healthz never touches it. The smoke test is what catches that.
- **`terraform` conflicts with a state lock.** Another apply (or a previous run that didn't clean up) may still hold the S3-native lock. Wait for it to finish rather than force-unlocking unless you're certain no other apply is in flight.
