import json
from pathlib import Path

import aws_cdk as cdk
import pytest

from app import build_stacks
from stacks.web_stack import CLERK_SECRET_KEY_NAME

ACCOUNT = "123456789012"
REGION = "us-west-2"

# A complete secret ARN — the six trailing characters are Secrets Manager's own suffix — for ACCOUNT and REGION, since
# WebStack checks it against both. Shared with the tests that assert on what the container receives.
CLERK_SECRET_KEY_ARN = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{CLERK_SECRET_KEY_NAME}-AbCdEf"

CDK_JSON = Path(__file__).resolve().parent.parent / "cdk.json"


def build_app_stacks(*, context: dict | None = None, **overrides) -> dict[str, cdk.Stack]:
    """Wires all 6 stacks together via infra/app.py's own build_stacks(), so
    cross-stack props are real CDK tokens and the test suite's stack graph
    can't drift out of sync with what infra/app.py actually deploys.

    cdk.json's context is loaded by hand because only the CDK CLI passes it to
    the app (as CDK_CONTEXT_JSON); a bare cdk.App() sees none of it. Without
    this the suite asserts against templates synthesized with every feature
    flag off — a different app from the one that deploys, which is worse than
    no assertion at all.

    Callable rather than fixture-only so tests whose whole point is a
    non-default input — an extra context value, or one WebStack rejects at
    synth — can build their own app without restating this wiring.
    """
    app = cdk.App(context={**json.loads(CDK_JSON.read_text())["context"], **(context or {})})
    return build_stacks(
        app,
        ACCOUNT,
        REGION,
        **{
            "worker_ami_id": "ami-000000000000",
            "alert_email": "replace-with-your-email@example.com",
            "app_public_url": "https://ai-gaussian-splatter.orky.net",
            "hosted_zone_id": "Z00000000000000000000",
            "clerk_secret_key_arn": CLERK_SECRET_KEY_ARN,
            "web_image_tag": "0f1e2d3",
            "migrate_image_tag": "0f1e2d3",
            **overrides,
        },
    )


@pytest.fixture(scope="session")
def wired_stacks():
    """Session-scoped since no test mutates the stacks. All of them only read
    via Template.from_stack(...).
    """
    return build_app_stacks()
