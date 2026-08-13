import json
from pathlib import Path

import aws_cdk as cdk
import pytest

from app import build_stacks

ENV = cdk.Environment(account="123456789012", region="us-west-2")

CDK_JSON = Path(__file__).resolve().parent.parent / "cdk.json"


@pytest.fixture(scope="session")
def wired_stacks():
    """Wires all 6 stacks together via app.py's own build_stacks(), so
    cross-stack props are real CDK tokens and the test suite's stack graph
    can't drift out of sync with what app.py actually deploys. Session-scoped
    since no test mutates the stacks — all of them only read via
    Template.from_stack(...).

    cdk.json's context is loaded by hand because only the CDK CLI passes it to
    the app (as CDK_CONTEXT_JSON); a bare cdk.App() sees none of it. Without
    this the suite asserts against templates synthesized with every feature
    flag off — a different app from the one that deploys, which is worse than
    no assertion at all.
    """
    app = cdk.App(context=json.loads(CDK_JSON.read_text())["context"])
    return build_stacks(
        app,
        ENV,
        worker_ami_id="ami-000000000000",
        alert_email="kam.yin.yip@gmail.com",
        app_public_url="https://ai-gaussian-splatter.orky.net",
        hosted_zone_id="Z00000000000000000000",
    )
