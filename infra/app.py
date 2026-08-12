#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stacks.backend_stack import APP_HOSTNAME, BackendStack
from stacks.budgets_stack import BudgetsStack
from stacks.data_stack import DataStack
from stacks.network_stack import NetworkStack
from stacks.registry_stack import RegistryStack
from stacks.worker_iam_stack import WorkerIamStack


def build_stacks(
    app: cdk.App,
    env: cdk.Environment,
    *,
    worker_ami_id: str,
    alert_email: str,
    app_public_url: str,
    hosted_zone_id: str,
) -> dict[str, cdk.Stack]:
    """Wires all 6 stacks together. Pulled out of module scope so
    infra/tests/conftest.py can import and reuse this exact wiring instead
    of hand-duplicating it — keeps the test suite's stack graph from
    silently drifting out of sync with what actually gets deployed.
    """
    network = NetworkStack(app, "NetworkStack", env=env)

    # Deploys before BackendStack and holds the image its service pulls, so
    # the image can be pushed in between. See RegistryStack's own docstring.
    registry = RegistryStack(app, "RegistryStack", env=env)

    data = DataStack(
        app,
        "DataStack",
        env=env,
        vpc=network.vpc,
        db_security_group=network.db_security_group,
    )

    worker_iam = WorkerIamStack(
        app,
        "WorkerIamStack",
        env=env,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
    )

    backend = BackendStack(
        app,
        "BackendStack",
        env=env,
        vpc=network.vpc,
        backend_security_group=network.backend_security_group,
        repository=registry.repository,
        database=data.database,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
        worker_ami_id=worker_ami_id,
        worker_instance_profile_arn=worker_iam.instance_profile_arn,
        worker_role_arn=worker_iam.role.role_arn,
        worker_security_group_id=network.worker_security_group.security_group_id,
        worker_subnet_id=network.vpc.private_subnets[0].subnet_id,
        app_public_url=app_public_url,
        alb_security_group=network.alb_security_group,
        hosted_zone_id=hosted_zone_id,
    )

    # Pinned to us-east-1 — see budgets_stack.py.
    budgets = BudgetsStack(
        app,
        "BudgetsStack",
        env=cdk.Environment(account=env.account, region="us-east-1"),
        alert_email=alert_email,
    )

    return {
        "network": network,
        "registry": registry,
        "data": data,
        "worker_iam": worker_iam,
        "backend": backend,
        "budgets": budgets,
    }


if __name__ == "__main__":
    app = cdk.App()

    # Region and account are set here rather than read from CDK_DEFAULT_REGION /
    # CDK_DEFAULT_ACCOUNT, both of which the CDK CLI overwrites — see AGENTS.md.
    # The account falls back to AWS's placeholder so `cdk synth` works with no
    # setup; `cdk deploy` still needs real credentials.
    env = cdk.Environment(account=os.environ.get("AWS_ACCOUNT_ID", "123456789012"), region="us-west-2")

    # Worker AMI/subnet are filled in once M5 (EC2 spot launch, per plan §7)
    # actually builds the worker image and picks a subnet — placeholders here
    # are what let `cdk synth` succeed before those exist.
    worker_ami_id = app.node.try_get_context("workerAmiId") or "ami-000000000000"

    alert_email = app.node.try_get_context("alertEmail") or "kam.yin.yip@gmail.com"

    # Where the worker PATCHes job status back to. A stable custom domain, so
    # there is no chicken-and-egg with the ALB this app creates: the ALB is
    # aliased to this name rather than the name being read off the ALB.
    app_public_url = app.node.try_get_context("appPublicUrl") or f"https://{APP_HOSTNAME}"

    # The orky.net hosted zone's ID. The placeholder default keeps `cdk synth`
    # working with no credentials; a real deploy passes `-c hostedZoneId=Z...`
    # — see AGENTS.md.
    hosted_zone_id = app.node.try_get_context("hostedZoneId") or "Z00000000000000000000"

    build_stacks(
        app,
        env,
        worker_ami_id=worker_ami_id,
        alert_email=alert_email,
        app_public_url=app_public_url,
        hosted_zone_id=hosted_zone_id,
    )

    app.synth()
