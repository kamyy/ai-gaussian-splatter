import aws_cdk as cdk
import pytest

from app import build_stacks

ENV = cdk.Environment(account="123456789012", region="us-west-2")


@pytest.fixture(scope="session")
def wired_stacks():
    """Wires all 6 stacks together via app.py's own build_stacks(), so
    cross-stack props are real CDK tokens and the test suite's stack graph
    can't drift out of sync with what app.py actually deploys. Session-scoped
    since no test mutates the stacks — all of them only read via
    Template.from_stack(...).
    """
    app = cdk.App()
    return build_stacks(
        app,
        ENV,
        worker_ami_id="ami-000000000000",
        alert_email="kam.yin.yip@gmail.com",
        app_public_url="https://ai-gaussian-splatter.orky.net",
        hosted_zone_id="Z00000000000000000000",
    )
