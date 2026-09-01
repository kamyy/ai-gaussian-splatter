#!/usr/bin/env python3
import os
import re

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
    web_image_tag: str,
    migrate_image_tag: str,
) -> dict[str, cdk.Stack]:
    """Wires all 6 stacks together. Pulled out of module scope so
    infra/tests/conftest.py can import and reuse this exact wiring instead
    of hand-duplicating it. That keeps the test suite's stack graph from
    silently drifting out of sync with what actually gets deployed.
    """
    # Normalized here rather than at either use, because both consumers append to it and neither tolerates the trailing
    # slash. worker/pipeline/status.py builds its callback URL with an f-string, so a slash gives it a double-slashed
    # path nothing routes. The buckets' CORS rules also match the browser's Origin header exactly, so a slash rejects
    # every upload and every splat fetch with the presigned URLs still valid. Both surface only as a console error or a
    # swallowed callback, never as a failed deploy.
    app_public_url = app_public_url.rstrip("/")

    # Applied at the app level so it lands on every stack and every taggable resource inside them. Without it, Resource
    # Groups & Tag Editor and Cost Explorer have no way to isolate this app's resources from another app's in the same
    # account.
    cdk.Tags.of(app).add("Project", "ai-gaussian-splatter")

    env = cdk.Environment(account=account, region=region)
    network = NetworkStack(app, "NetworkStack", stack_name="ai-gaussian-splatter-network", env=env)

    # Deploys before WebStack and holds the image its service pulls, so the image can be pushed in between. See
    # RegistryStack's own docstring.
    registry = RegistryStack(app, "RegistryStack", stack_name="ai-gaussian-splatter-registry", env=env)

    data = DataStack(
        app,
        "DataStack",
        stack_name="ai-gaussian-splatter-data",
        env=env,
        vpc=network.vpc,
        db_security_group=network.db_security_group,
        # The browser reaches both buckets directly via presigned URLs, so this is the origin their CORS rules admit.
        app_origin=app_public_url,
    )

    worker_iam = WorkerIamStack(
        app,
        "WorkerIamStack",
        stack_name="ai-gaussian-splatter-worker-iam",
        env=env,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
    )

    web = WebStack(
        app,
        "WebStack",
        stack_name="ai-gaussian-splatter-web",
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
        # Public, so the worker's multi-GB ECR image pull goes out through the internet gateway rather than being billed
        # per-GB by a NAT gateway.
        worker_subnet_id=network.vpc.public_subnets[0].subnet_id,
        app_public_url=app_public_url,
        alb_security_group=network.alb_security_group,
        hosted_zone_id=hosted_zone_id,
        clerk_secret_key_arn=clerk_secret_key_arn,
        web_image_tag=web_image_tag,
        migrate_image_tag=migrate_image_tag,
    )

    # Pinned to us-east-1 — see infra/stacks/budgets_stack.py.
    budgets = BudgetsStack(
        app,
        "BudgetsStack",
        stack_name="ai-gaussian-splatter-budgets",
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


# AWS's own documentation placeholder. Deploys target a real account, so this doubles as the marker for "nobody supplied
# one".
PLACEHOLDER_AWS_ACCOUNT_ID = "123456789012"

# The four values a real deploy must supply, standing in so `cdk synth` and `cdk diff` work on a clean checkout with no
# credentials. CI runs them with no context at all. read_context refuses all four against a real account, because synth
# is the last point where the omission is free: past it they cost a rolled-back deploy at best, and at worst a green one
# that mails no spend alert and fails every job launch.
PLACEHOLDER_WEB_IMAGE_TAG = "0000000"
PLACEHOLDER_WORKER_AMI_ID = "ami-000000000000"
PLACEHOLDER_HOSTED_ZONE_ID = "Z00000000000000000000"
# Left visibly unedited rather than plausible: nothing downstream validates an address, so a real-looking default would
# read in the SNS console as someone's deliberate choice.
PLACEHOLDER_ALERT_EMAIL = "replace-with-your-email@example.com"


def read_account() -> str:
    """The account every stack targets, from AWS_ACCOUNT_ID.

    Unset falls back to PLACEHOLDER_AWS_ACCOUNT_ID, so `cdk synth` works on a
    clean checkout with no credentials and read_context's guards below stay
    quiet.

    Must be 12 digits, so "" raises. Without this check read_context would
    read "" as a real deploy. The same check catches a truncated id or a
    whole ARN.
    """
    account = os.environ.get("AWS_ACCOUNT_ID")
    if account is None:
        return PLACEHOLDER_AWS_ACCOUNT_ID
    if re.fullmatch(r"\d{12}", account) is None:
        raise ValueError(
            f"AWS_ACCOUNT_ID must be a 12-digit account id, or unset to synthesize against the "
            f"placeholder account {PLACEHOLDER_AWS_ACCOUNT_ID}; got {account!r}"
        )
    return account


def read_context(app: cdk.App, account: str) -> dict[str, str]:
    """Every `-c` value build_stacks needs, keyed by its parameter name.

    Separate from __main__ so the context *keys* are testable. Nothing else
    reads them: a renamed key here would otherwise leave the suite green while
    every real deploy silently synthesized against the placeholders above —
    the failure this app's guards exist to prevent.
    """

    def required(key: str, placeholder: str, consequence: str) -> str:
        """One `-c` value, refused against a real account while it still holds
        its placeholder. Uniform rather than per-key: the placeholders differ
        only in what they break, never in whether synth and deploy accept them.
        """
        value = app.node.try_get_context(key) or placeholder
        if value == placeholder and account != PLACEHOLDER_AWS_ACCOUNT_ID:
            raise ValueError(f"a real deploy must pass -c {key}= — {consequence}")
        return value

    # The AMI each job's spot instance boots. WebStack only forwards it to the web task as WORKER_AMI_ID, so the first
    # thing to test it is the RunInstances call in web/lib/server/ec2Launcher.ts, a job at a time.
    worker_ami_id = required(
        "workerAmiId",
        PLACEHOLDER_WORKER_AMI_ID,
        "the placeholder AMI exists in no account, so every job launch fails",
    )

    # Where BudgetsStack sends spend alerts, as an SNS email subscription — see PLACEHOLDER_ALERT_EMAIL. Passed as `-c
    # alertEmail=` from ALERT_EMAIL, see RUNBOOK.md.
    alert_email = required(
        "alertEmail",
        PLACEHOLDER_ALERT_EMAIL,
        "nobody confirms the placeholder's subscription, so every spend alert goes nowhere",
    )

    # The orky.net hosted zone, imported for the ALB's alias record and ACM's validation record — see AGENTS.md.
    hosted_zone_id = required(
        "hostedZoneId",
        PLACEHOLDER_HOSTED_ZONE_ID,
        "the placeholder zone does not exist and fails partway through the deploy",
    )

    # Where the worker PATCHes job status back to. A stable custom domain, so there is no chicken-and-egg with the ALB
    # this app creates: the ALB is aliased to this name rather than the name being read off the ALB. The default is that
    # same hostname, so there is no placeholder to refuse. The scheme is checked instead: the ALB answers https only.
    # A worker whose callbacks all fail says nothing about it either way. worker/pipeline/status.py logs and swallows
    # them by design, leaving the job to look stuck rather than broken.
    app_public_url = app.node.try_get_context("appPublicUrl") or f"https://{APP_HOSTNAME}"
    if not app_public_url.startswith("https://"):
        raise ValueError(f"-c appPublicUrl= must be an https:// URL, got {app_public_url!r}")

    # The Clerk secret is created by hand before the first deploy and imported by WebStack, so its ARN — suffix and all
    # — has to be passed in. The placeholder keeps `cdk synth` working with no credentials. It also names the
    # placeholder account deliberately: WebStack checks the ARN against its own account, so a real deploy that forgets
    # `-c clerkSecretKeyArn=` fails at synth rather than at task start. See AGENTS.md.
    clerk_secret_key_arn = (
        app.node.try_get_context("clerkSecretKeyArn")
        or f"arn:aws:secretsmanager:us-west-2:{PLACEHOLDER_AWS_ACCOUNT_ID}:secret:{CLERK_SECRET_KEY_NAME}-AAAAAA"
    )

    # Which build the service runs. A commit SHA rather than a moving tag, so every release is its own task definition
    # and the circuit breaker can roll back to one that still names the image it was deployed with — see
    # infra/stacks/web_stack.py. Rolling back by hand is this same flag with an older SHA.
    web_image_tag = required(
        "webImageTag",
        PLACEHOLDER_WEB_IMAGE_TAG,
        "the placeholder tag names no image in ECR, so every task fails to pull",
    )

    # Which build the migration task runs. Not a required() flag like web_image_tag: it has a safe default (mirror the
    # service's own tag), so a bare `-c webImageTag=` with no `-c migrateImageTag=` keeps working unchanged. That is
    # every existing manual RUNBOOK invocation. .github/workflows/ci.yml's deploy job diverges the two on purpose: it
    # registers the migration task against the *new* build while the service stays on the currently-live one, runs the
    # migration, and only then redeploys with both equal — see RUNBOOK.md.
    migrate_image_tag = app.node.try_get_context("migrateImageTag") or web_image_tag

    return {
        "worker_ami_id": worker_ami_id,
        "alert_email": alert_email,
        "app_public_url": app_public_url,
        "hosted_zone_id": hosted_zone_id,
        "clerk_secret_key_arn": clerk_secret_key_arn,
        "web_image_tag": web_image_tag,
        "migrate_image_tag": migrate_image_tag,
    }


if __name__ == "__main__":
    app = cdk.App()

    # CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION change with whomever you log in as, so the account comes from
    # AWS_ACCOUNT_ID and the region is hardcoded — see AGENTS.md.
    account = read_account()
    region = "us-west-2"

    build_stacks(app, account, region, **read_context(app, account))

    app.synth()
