---
name: deploy
description: Deploy the AWS stacks or ship a new web image to ECS. Use whenever asked to deploy, redeploy, ship, roll out, or promote changes to AWS — including the first deploy into a fresh account, and diagnosing a deploy that reported success but left the site broken.
---

# Deploying

**Deploying is outward-facing and spends money. Get the user's explicit go-ahead before any `cdk deploy`, `podman push`, or `aws ecs update-service`, and treat approval as covering that one deploy only.**

`RUNBOOK.md` § "Deploying to production" holds the exact command blocks for every step below except the pre-deploy diff, and is the single source for them. Read it before starting. This file is the order to run them in, the decisions along the way, and what bites afterwards.

**A routine push to `main` no longer needs any of this.** `ci.yml`'s `deploy` job builds, migrates, and rolls the service out on its own. This skill is for what CI doesn't cover: infra-only changes, a fresh account's first deploy, a manual rollback, or diagnosing a deploy that reported success but left the site broken.

## Pick the path first

| Change | What to run | Why not the other |
|---|---|---|
| `web/` only (no infra) | Build and push under `$(git rev-parse --short HEAD)`, then `pnpm cdk:deploy:all` with that `-c webImageTag=` | The tag is part of the task definition, so a new tag is a template change. There is no `update-service` step |
| `infra/stacks/` | `pnpm cdk:deploy:all` with all six `-c` flags | — |
| Fresh account | Create the Clerk secret → `pnpm cdk:bootstrap` in both regions → `pnpm cdk:deploy:registry` → build + push → `pnpm cdk:deploy:all` | `WebStack` imports the secret rather than creating it, and its service pins an image tag; with an empty repository its tasks have nothing to pull and the circuit breaker (`rollback=True`) rolls the stack back |

## Before running anything

1. `export AWS_ACCOUNT_ID=<real account>` — unset, `app.py` targets the placeholder `123456789012` and the deploy fails.
2. Resolve `HOSTED_ZONE_ID`, `CLERK_SECRET_KEY_ARN`, `ALERT_EMAIL`, `APP_PUBLIC_URL`, `WORKER_AMI_ID`, and `WEB_IMAGE_TAG` (RUNBOOK § "Deploying to production" has the lookup for each), and pass all six of `-c hostedZoneId=`, `-c clerkSecretKeyArn=`, `-c alertEmail=`, `-c appPublicUrl=`, `-c workerAmiId=`, `-c webImageTag=` to **every** cdk invocation — `diff` and single-stack deploys included, since `cdk deploy OneStack` synthesizes the whole app. A forgotten flag fails at synth against a real account. `read_context` refuses each placeholder by name. `WebStack` also checks the Clerk ARN's account and region. What it cannot catch is a well-formed wrong value, and `alertEmail` is the one that stays silent about it. A mistyped address deploys green and its SNS subscription never leaves `PendingConfirmation`, so confirm the address with the user rather than inferring one. `appPublicUrl` is the one flag whose default is already correct (`https://` + `APP_HOSTNAME`); pass it anyway, and only change it alongside `APP_HOSTNAME` itself. A seventh flag, `-c migrateImageTag=`, defaults to `webImageTag` when omitted. Leave it out for a normal manual deploy; it only needs to diverge for the two-phase migrate-then-deploy dance `ci.yml` does.
3. On a fresh account the Clerk secret does not exist yet. Create it first (the `aws secretsmanager create-secret` block in RUNBOOK § "Deploying to production"), before anything else. It is imported, not created by any stack, so the deploy neither makes it nor checks it exists. The same section then bootstraps both regions — `us-east-1` for `BudgetsStack`, `us-west-2` for the rest — without which the first stack fails before creating anything.
4. Run the diff with all six flags — straight after the script name, never after a `--`: pnpm forwards them, but cdk's own parser then discards everything past the separator, so every flag is silently dropped and the app synthesizes against its placeholders. Against a real account that now fails at synth naming the first placeholder it finds, which is the symptom to recognize — a flag you know you passed being reported as missing means the separator ate it, not that you forgot it. Then show the user what the diff says before proceeding.

   ```bash
   pnpm cdk:diff \
     -c hostedZoneId=$HOSTED_ZONE_ID \
     -c clerkSecretKeyArn=$CLERK_SECRET_KEY_ARN \
     -c alertEmail=$ALERT_EMAIL \
     -c appPublicUrl=$APP_PUBLIC_URL \
     -c workerAmiId=$WORKER_AMI_ID \
     -c webImageTag=$WEB_IMAGE_TAG
   ```

   RDS carries `deletion_protection=False` with a `SNAPSHOT` removal policy, so a replacing change is recoverable but disruptive. It must never be a surprise.
5. If job launches matter for this deploy, a real `-c workerAmiId=` is necessary but not sufficient. Synth refuses the placeholder, but the worker still has no ECR repository or pull permissions (`AGENTS.md`, gap 5, M5), so launched jobs fail on `docker login` regardless.

## After a deploy reports success

**A manual `cdk deploy` never applies migrations** — not on boot, not from any stack; that's only automatic in `ci.yml`'s `deploy` job. A fresh environment has no tables and every real route 500s. The target group reports healthy anyway, because `/api/v1/healthz` never touches the database, so a green deploy is not a working site. RUNBOOK § "Applying migrations to a deployed database" has the manual procedure; it needs `DATABASE_SSL_CA` and must run from inside the VPC.

Confirm with a request that actually hits the database, not with healthz.

## When it goes wrong

- **A bad image rolls back on its own.** The circuit breaker restores the previous task definition, which names its own still-present tag. To roll back by hand, redeploy with an older SHA; only `RELEASES_KEPT` of them survive.
- **`ImageTagAlreadyExists` on push** — that commit was already built. The repository is immutable by design; commit again rather than retagging.
- **Intermittent 502s with nothing in the application logs** — the app never saw those requests. Check `KEEP_ALIVE_TIMEOUT` against the ALB idle timeout (`AGENTS.md`, Infra).
- **Tasks start then fail health checks.** Check the task's stopped reason before redeploying; a missing secret or an unreachable database looks identical from the ALB's side.
