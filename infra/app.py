#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stacks.backend_stack import BackendStack
from stacks.budgets_stack import BudgetsStack
from stacks.data_stack import DataStack
from stacks.network_stack import NetworkStack
from stacks.worker_iam_stack import WorkerIamStack

app = cdk.App()

# Region is hardcoded, not read from CDK_DEFAULT_REGION: the CDK CLI
# unconditionally overwrites that env var right before spawning this app,
# using the SDK's own default-region resolution (which falls back to
# us-east-1 with no credentials configured) — any value we export for it
# gets silently clobbered.
#
# Account deliberately does NOT read CDK_DEFAULT_ACCOUNT either, even
# though the CLI leaves that one alone when it can't resolve an account.
# The problem is the inverse case: whenever real AWS credentials ARE
# active (e.g. an SSO login on a dev machine), the CLI resolves them via a
# real STS call and sets CDK_DEFAULT_ACCOUNT to that real account ID
# before spawning this app — so reading it would make `cdk synth`'s
# behavior (and its AZ-lookup cache writes to cdk.context.json) depend on
# whoever's local login state happens to be active. AWS_ACCOUNT_ID is a
# name the CDK CLI never touches, so this app's account resolution is
# fully decoupled from STS and from local/CI login state — it only ever
# changes when a real deploy deliberately sets it (a GitHub Actions
# secret in CI, or an explicit export for a manual deploy). The fallback
# below is AWS's own well-known placeholder account ID, used so
# `cdk synth` works out of the box with no setup — it only ever lands in
# template ARNs, never in an actual deploy, since `cdk deploy` still needs
# real credentials to authenticate against CloudFormation regardless of
# this value.
env = cdk.Environment(account=os.environ.get("AWS_ACCOUNT_ID", "123456789012"), region="us-west-2")

# Worker AMI/subnet are filled in once M5 (EC2 spot launch, per plan §7)
# actually builds the worker image and picks a subnet — placeholders here
# are what let `cdk synth` succeed before those exist.
worker_ami_id = app.node.try_get_context("workerAmiId") or "ami-000000000000"

network = NetworkStack(app, "NetworkStack", env=env)

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

BackendStack(
    app,
    "BackendStack",
    env=env,
    vpc=network.vpc,
    backend_security_group=network.backend_security_group,
    database=data.database,
    uploads_bucket=data.uploads_bucket,
    splats_bucket=data.splats_bucket,
    worker_ami_id=worker_ami_id,
    worker_instance_profile_arn=worker_iam.instance_profile_arn,
    worker_role_arn=worker_iam.role.role_arn,
    worker_security_group_id=network.worker_security_group.security_group_id,
    worker_subnet_id=network.vpc.private_subnets[0].subnet_id,
)

# Billing metrics only exist in us-east-1 regardless of where the rest of
# the app is deployed — see budgets_stack.py.
BudgetsStack(
    app,
    "BudgetsStack",
    env=cdk.Environment(account=env.account, region="us-east-1"),
    alert_email=app.node.try_get_context("alertEmail") or "kam.yin.yip@gmail.com",
)

app.synth()
