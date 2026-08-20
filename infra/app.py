#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stacks.budgets_stack import BudgetsStack
from stacks.data_stack import DataStack
from stacks.network_stack import NetworkStack
from stacks.registry_stack import RegistryStack
from stacks.web_stack import APP_HOSTNAME, CLERK_SECRET_KEY_NAME, WebStack
from stacks.worker_iam_stack import WorkerIamStack


def build_stacks(
    app: cdk.App,
    account: str,
    region: str,
    *,
    worker_ami_id: str,
    alert_email: str,
    app_public_url: str,
    hosted_zone_id: str,
    clerk_secret_key_arn: str,
    image_tag: str,
) -> dict[str, cdk.Stack]:
    """Wires all 6 stacks together. Pulled out of module scope so
    infra/tests/conftest.py can import and reuse this exact wiring instead
    of hand-duplicating it — keeps the test suite's stack graph from
    silently drifting out of sync with what actually gets deployed.
    """
    env = cdk.Environment(account=account, region=region)
    network = NetworkStack(app, "NetworkStack", env=env)

    # Deploys before WebStack and holds the image its service pulls, so
    # the image can be pushed in between. See RegistryStack's own docstring.
    registry = RegistryStack(app, "RegistryStack", env=env)

    data = DataStack(
        app,
        "DataStack",
        env=env,
        vpc=network.vpc,
        db_security_group=network.db_security_group,
        # The browser reaches both buckets directly via presigned URLs, so this
        # is the origin their CORS rules admit. Normalized rather than passed
        # through: app_public_url is a base URL that paths get appended to, so
        # a trailing slash in it is harmless, while S3 matches the browser's
        # Origin header exactly and would reject every upload and every splat
        # fetch — with the presigned URL still valid, so the only symptom is a
        # console error.
        app_origin=app_public_url.rstrip("/"),
    )

    worker_iam = WorkerIamStack(
        app,
        "WorkerIamStack",
        env=env,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
    )

    web = WebStack(
        app,
        "WebStack",
        env=env,
        vpc=network.vpc,
        web_security_group=network.web_security_group,
        repository=registry.repository,
        database=data.database,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
        access_logs_bucket=data.access_logs_bucket,
        worker_ami_id=worker_ami_id,
        worker_instance_profile_arn=worker_iam.instance_profile_arn,
        worker_role_arn=worker_iam.role.role_arn,
        worker_security_group_id=network.worker_security_group.security_group_id,
        # Public, so the worker's multi-GB ECR image pull goes out through the
        # internet gateway rather than being billed per-GB by a NAT gateway.
        worker_subnet_id=network.vpc.public_subnets[0].subnet_id,
        app_public_url=app_public_url,
        alb_security_group=network.alb_security_group,
        hosted_zone_id=hosted_zone_id,
        clerk_secret_key_arn=clerk_secret_key_arn,
        image_tag=image_tag,
    )

    # Pinned to us-east-1 — see budgets_stack.py.
    budgets = BudgetsStack(
        app,
        "BudgetsStack",
        env=cdk.Environment(account=account, region="us-east-1"),
        alert_email=alert_email,
    )

    return {
        "network": network,
        "registry": registry,
        "data": data,
        "worker_iam": worker_iam,
        "web": web,
        "budgets": budgets,
    }


# AWS's own documentation placeholder. Deploys target a real account, so this
# doubles as the marker for "nobody supplied one".
PLACEHOLDER_AWS_ACCOUNT_ID = "123456789012"

# Stands in for a commit SHA so `cdk synth` works on a clean checkout. Refused
# below against a real account, since deploying it would name a tag that does
# not exist in ECR and every task would fail to pull.
PLACEHOLDER_IMAGE_TAG = "0000000"


def read_context(app: cdk.App, account: str) -> dict[str, str]:
    """Every `-c` value build_stacks needs, keyed by its parameter name.

    Separate from __main__ so the context *keys* are testable. Nothing else
    reads them: a renamed key here would otherwise leave the suite green while
    every real deploy silently synthesized against the placeholders below —
    the failure this app's guards exist to prevent.
    """
    # Worker AMI/subnet are filled in once M5 (see ARCHITECTURE.md's build
    # order) actually builds the worker image and picks a subnet — placeholders
    # here are what let `cdk synth` succeed before those exist.
    worker_ami_id = app.node.try_get_context("workerAmiId") or "ami-000000000000"

    # Where BudgetsStack sends spend alerts. No stack validates it — any
    # syntactically valid address deploys green — so the default is left
    # visibly unedited rather than plausible: an unreplaced `replace-with-`
    # address is recognisable in the SNS console, where a real-looking one
    # would read as someone's deliberate choice. Passed as `-c alertEmail=`
    # from ALERT_EMAIL, see RUNBOOK.md.
    alert_email = app.node.try_get_context("alertEmail") or "replace-with-your-email@example.com"

    # Where the worker PATCHes job status back to. A stable custom domain, so
    # there is no chicken-and-egg with the ALB this app creates: the ALB is
    # aliased to this name rather than the name being read off the ALB.
    app_public_url = app.node.try_get_context("appPublicUrl") or f"https://{APP_HOSTNAME}"

    # The orky.net hosted zone's ID. The placeholder default keeps `cdk synth`
    # working with no credentials; a real deploy passes `-c hostedZoneId=Z...`
    # — see AGENTS.md.
    hosted_zone_id = app.node.try_get_context("hostedZoneId") or "Z00000000000000000000"

    # The Clerk secret is created by hand before the first deploy and imported
    # by WebStack, so its ARN — suffix and all — has to be passed in. The
    # placeholder keeps `cdk synth` working with no credentials, and names the
    # placeholder account deliberately: WebStack checks the ARN against its
    # own account, so a real deploy that forgets `-c clerkSecretKeyArn=` fails at
    # synth rather than at task start. See AGENTS.md.
    clerk_secret_key_arn = (
        app.node.try_get_context("clerkSecretKeyArn")
        or f"arn:aws:secretsmanager:us-west-2:{PLACEHOLDER_AWS_ACCOUNT_ID}:secret:{CLERK_SECRET_KEY_NAME}-AAAAAA"
    )

    # Which build the service runs. A commit SHA rather than a moving tag, so
    # every release is its own task definition and the circuit breaker can roll
    # back to one that still names the image it was deployed with — see
    # web_stack.py. Rolling back by hand is this same flag with an older SHA.
    image_tag = app.node.try_get_context("imageTag") or PLACEHOLDER_IMAGE_TAG
    if image_tag == PLACEHOLDER_IMAGE_TAG and account != PLACEHOLDER_AWS_ACCOUNT_ID:
        raise ValueError("a real deploy must pass -c imageTag=<sha> — the placeholder names no image in ECR")

    return {
        "worker_ami_id": worker_ami_id,
        "alert_email": alert_email,
        "app_public_url": app_public_url,
        "hosted_zone_id": hosted_zone_id,
        "clerk_secret_key_arn": clerk_secret_key_arn,
        "image_tag": image_tag,
    }


if __name__ == "__main__":
    app = cdk.App()

    # Region and account are set here rather than read from CDK_DEFAULT_REGION /
    # CDK_DEFAULT_ACCOUNT, both of which the CDK CLI overwrites — see AGENTS.md.
    # The account falls back to AWS's placeholder so `cdk synth` works with no
    # setup; `pnpm cdk:bootstrap and pnpm cdk:deploy:*` require real credentials.
    account = os.environ.get("AWS_ACCOUNT_ID", PLACEHOLDER_AWS_ACCOUNT_ID)
    region = "us-west-2"

    build_stacks(app, account, region, **read_context(app, account))

    app.synth()
