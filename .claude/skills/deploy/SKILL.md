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
| `web/` only (no infra) | Build and push under `$(git rev-parse --short HEAD)`, then `pnpm cdk:deploy:all` with that `-c imageTag=` | The tag is part of the task definition, so a new tag is a template change — there is no `update-service` step |
| `infra/stacks/` | `pnpm cdk:deploy:all` with all three `-c` flags | — |
| Fresh account | Create the Clerk secret → `pnpm cdk:deploy:registry` → build + push → `pnpm cdk:deploy:all` | `BackendStack` imports the secret rather than creating it, and its service pins an image tag; with an empty repository its tasks have nothing to pull and the circuit breaker (`rollback=True`) rolls the stack back |

## Before running anything

1. `export AWS_ACCOUNT_ID=<real account>` — unset, `app.py` targets the placeholder `123456789012` and the deploy fails.
2. Resolve `ZONE_ID`, `CLERK_SECRET_ARN`, and the image tag, and pass all three of `-c hostedZoneId=`, `-c clerkSecretArn=`, `-c imageTag=` to **every** cdk invocation — `diff` and single-stack deploys included, since `cdk deploy OneStack` synthesizes the whole app. The zone default is a placeholder that fails at deploy time; the ARN default is one `BackendStack` rejects at synth on any real account.
3. On a fresh account the Clerk secret does not exist yet — create it first (RUNBOOK § "First deploy"), before anything else. It is imported, not created by any stack, so the deploy neither makes it nor checks it exists.
4. Run `pnpm cdk:diff` with both flags — straight after the script name, never after a `--`, which pnpm swallows instead of forwarding — and show the user what it says before proceeding. RDS carries `deletion_protection=False` with a `SNAPSHOT` removal policy, so a replacing change is recoverable but disruptive — it must never be a surprise.
5. If job launches matter for this deploy, check `app.py`'s `workerAmiId`. While it is `ami-000000000000` everything else deploys fine, but any launched job fails.

## After a deploy reports success

**Migrations never run automatically** — not on boot, not from any stack. A fresh environment has no tables and every real route 500s. The target group reports healthy anyway, because `/api/v1/healthz` never touches the database, so a green deploy is not a working site. RUNBOOK § "Applying migrations to a deployed environment" has the procedure; it needs `DATABASE_SSL_CA` and must run from inside the VPC.

Confirm with a request that actually hits the database, not with healthz.

## When it goes wrong

- **A bad image rolls back on its own** — the circuit breaker restores the previous task definition, which names its own still-present tag. To roll back by hand, redeploy with an older SHA; only `RELEASES_KEPT` of them survive.
- **`ImageTagAlreadyExists` on push** — that commit was already built. The repository is immutable by design; commit again rather than retagging.
- **Intermittent 502s with nothing in the application logs** — the app never saw those requests. Check `KEEP_ALIVE_TIMEOUT` against the ALB idle timeout (`AGENTS.md`, Infra).
- **Tasks start then fail health checks** — check the task's stopped reason before redeploying; a missing secret or an unreachable database looks identical from the ALB's side.
