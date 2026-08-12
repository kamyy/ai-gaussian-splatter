---
name: deploy
description: Deploy the AWS stacks or ship a new web image to ECS. Use whenever asked to deploy, redeploy, ship, roll out, or promote changes to AWS — including the first deploy into a fresh account, and diagnosing a deploy that reported success but left the site broken.
---

# Deploying

**Deploying is outward-facing and spends money. Get the user's explicit go-ahead before any `cdk deploy`, `podman push`, or `aws ecs update-service`, and treat approval as covering that one deploy only.**

`RUNBOOK.md` § "Deploying infra" holds the exact command blocks and is the single source for them — read it before starting. This file is the order to run them in, the decisions along the way, and what bites afterwards.

## Pick the path first

| Change | What to run | Why not the other |
|---|---|---|
| `web/` only (no infra) | Build, push, then `aws ecs update-service --force-new-deployment` | The service pins the fixed tag `latest`, so `cdk deploy` sees an unchanged template, does nothing, and ECS keeps running the old digest |
| `infra/stacks/` | `npx cdk deploy --all -c hostedZoneId=$ZONE_ID` | — |
| Fresh account | `RegistryStack` → build + push → `cdk deploy --all` | `BackendStack`'s service pins an image tag; with an empty repository its tasks have nothing to pull and the circuit breaker (`rollback=True`) rolls the stack back |

## Before running anything

1. `export AWS_ACCOUNT_ID=<real account>` — unset, `app.py` targets the placeholder `123456789012` and the deploy fails.
2. Resolve `ZONE_ID` and pass `-c hostedZoneId=$ZONE_ID` to **every** cdk invocation, `diff` included. The default is a placeholder that fails at deploy time.
3. Run `npx cdk diff -c hostedZoneId=$ZONE_ID` and show the user what it says before proceeding. RDS carries `deletion_protection=False` with a `SNAPSHOT` removal policy, so a replacing change is recoverable but disruptive — it must never be a surprise.
4. If job launches matter for this deploy, check `app.py`'s `workerAmiId`. While it is `ami-000000000000` everything else deploys fine, but any launched job fails.

## After a deploy reports success

The target group reports healthy without either of these, because `/api/v1/healthz` touches neither the database nor Clerk. A green deploy is not a working site.

- **Migrations never run automatically** — not on boot, not from any stack. A fresh environment has no tables and every real route 500s. RUNBOOK § "Applying migrations to a deployed environment" has the procedure; it needs `DATABASE_SSL_CA` and must run from inside the VPC.
- **`ai-gaussian-splatter/clerk-secret-key` holds a CDK-generated random value** until someone puts the real key there. After setting it, force a new deployment — ECS injects secrets at task start, not on live update.

Confirm with a request that actually hits the database, not with healthz.

## When it goes wrong

- **A bad image is not fixed by rollback.** The circuit breaker restarts the previous deployment against the *same* task definition, which still points at the mutable `:latest` tag, so Fargate re-pulls the broken image. Push a corrected image and force another deployment. `min_healthy_percent=100` is what keeps the old task serving in the meantime.
- **Intermittent 502s with nothing in the application logs** — the app never saw those requests. Check `KEEP_ALIVE_TIMEOUT` against the ALB idle timeout (`AGENTS.md`, Infra).
- **Tasks start then fail health checks** — check the task's stopped reason before redeploying; a missing secret or an unreachable database looks identical from the ALB's side.
