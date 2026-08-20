import aws_cdk as cdk
import pytest

from app import PLACEHOLDER_AWS_ACCOUNT_ID, PLACEHOLDER_IMAGE_TAG, read_context
from stacks.backend_stack import CLERK_SECRET_KEY_NAME

REAL_ACCOUNT = "999999999999"

# What a real deploy passes. The keys are the contract with RUNBOOK.md's
# `-c` flags; the values only have to be well-formed.
DEPLOY_CONTEXT = {
    "workerAmiId": "ami-0123456789abcdef0",
    "alertEmail": "nobody@example.com",
    "appPublicUrl": "https://example.test",
    "hostedZoneId": "Z09876543210987654321",
    "clerkSecretKeyArn": f"arn:aws:secretsmanager:us-west-2:{REAL_ACCOUNT}:secret:{CLERK_SECRET_KEY_NAME}-AbCdEf",
    "imageTag": "a1b2c3d",
}


def test_every_context_key_is_read():
    """The `-c` key spellings are the contract with RUNBOOK.md, and nothing
    else reads them: the stack tests call build_stacks with explicit kwargs, so
    renaming a key here would leave the whole suite green while every real
    deploy silently synthesized against the placeholders instead.
    """
    values = read_context(cdk.App(context=DEPLOY_CONTEXT), REAL_ACCOUNT)

    assert values == {
        "worker_ami_id": "ami-0123456789abcdef0",
        "alert_email": "nobody@example.com",
        "app_public_url": "https://example.test",
        "hosted_zone_id": "Z09876543210987654321",
        "clerk_secret_key_arn": DEPLOY_CONTEXT["clerkSecretKeyArn"],
        "image_tag": "a1b2c3d",
    }


def test_placeholders_fill_in_when_nothing_is_passed():
    """`cdk synth` has to work on a clean checkout with no credentials — CI
    runs it with no context at all — so every value needs a default.
    """
    values = read_context(cdk.App(), PLACEHOLDER_AWS_ACCOUNT_ID)

    assert values["image_tag"] == PLACEHOLDER_IMAGE_TAG
    assert values["hosted_zone_id"] == "Z00000000000000000000"
    assert PLACEHOLDER_AWS_ACCOUNT_ID in values["clerk_secret_key_arn"]


def test_a_real_account_must_name_a_real_image():
    """The placeholder tag names nothing in ECR, so deploying it would leave
    every task failing to pull. Caught here rather than at task start, since a
    forgotten flag is otherwise indistinguishable from a deliberate one.
    """
    with pytest.raises(ValueError, match="imageTag"):
        read_context(cdk.App(), REAL_ACCOUNT)
