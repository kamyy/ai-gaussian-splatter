import aws_cdk as cdk
import pytest

from stacks.backend_stack import BackendStack
from stacks.budgets_stack import BudgetsStack
from stacks.data_stack import DataStack
from stacks.network_stack import NetworkStack
from stacks.worker_iam_stack import WorkerIamStack

ENV = cdk.Environment(account="123456789012", region="us-west-2")


@pytest.fixture
def wired_stacks():
    """Wires all 5 stacks together exactly like app.py does, so cross-stack
    props (vpc, security groups, buckets, ARNs) are real CDK tokens rather
    than mocks — the same shape the real app synthesizes.
    """
    app = cdk.App()

    network = NetworkStack(app, "NetworkStack", env=ENV)

    data = DataStack(
        app,
        "DataStack",
        env=ENV,
        vpc=network.vpc,
        db_security_group=network.db_security_group,
    )

    worker_iam = WorkerIamStack(
        app,
        "WorkerIamStack",
        env=ENV,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
    )

    backend = BackendStack(
        app,
        "BackendStack",
        env=ENV,
        vpc=network.vpc,
        backend_security_group=network.backend_security_group,
        database=data.database,
        uploads_bucket=data.uploads_bucket,
        splats_bucket=data.splats_bucket,
        worker_ami_id="ami-000000000000",
        worker_instance_profile_arn=worker_iam.instance_profile_arn,
        worker_role_arn=worker_iam.role.role_arn,
        worker_security_group_id=network.worker_security_group.security_group_id,
        worker_subnet_id=network.vpc.private_subnets[0].subnet_id,
    )

    budgets = BudgetsStack(
        app,
        "BudgetsStack",
        env=cdk.Environment(account=ENV.account, region="us-east-1"),
        alert_email="kam.yin.yip@gmail.com",
    )

    return {
        "network": network,
        "data": data,
        "worker_iam": worker_iam,
        "backend": backend,
        "budgets": budgets,
    }
