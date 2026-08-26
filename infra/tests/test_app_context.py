import aws_cdk as cdk
import pytest

from app import (
    PLACEHOLDER_ALERT_EMAIL,
    PLACEHOLDER_AWS_ACCOUNT_ID,
    PLACEHOLDER_HOSTED_ZONE_ID,
    PLACEHOLDER_WEB_IMAGE_TAG,
    PLACEHOLDER_WORKER_AMI_ID,
    read_account,
    read_context,
)
from stacks.web_stack import CLERK_SECRET_KEY_NAME

REAL_ACCOUNT = "999999999999"

# What a real deploy passes. The keys are the contract with RUNBOOK.md's `-c` flags; the values only have to be
# well-formed.
DEPLOY_CONTEXT = {
    "workerAmiId": "ami-0123456789abcdef0",
    "alertEmail": "nobody@example.com",
    "appPublicUrl": "https://example.test",
    "hostedZoneId": "Z09876543210987654321",
    "clerkSecretKeyArn": f"arn:aws:secretsmanager:us-west-2:{REAL_ACCOUNT}:secret:{CLERK_SECRET_KEY_NAME}-AbCdEf",
    "webImageTag": "a1b2c3d",
}

# Each guarded key against the placeholder read_context refuses for it. migrateImageTag is deliberately absent. It has
# a safe default (mirror webImageTag) rather than a placeholder to refuse, see
# test_migrate_image_tag_defaults_to_the_web_image_tag below.
PLACEHOLDERS = {
    "workerAmiId": PLACEHOLDER_WORKER_AMI_ID,
    "alertEmail": PLACEHOLDER_ALERT_EMAIL,
    "hostedZoneId": PLACEHOLDER_HOSTED_ZONE_ID,
    "webImageTag": PLACEHOLDER_WEB_IMAGE_TAG,
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
        "web_image_tag": "a1b2c3d",
        # No migrateImageTag in DEPLOY_CONTEXT — defaults to webImageTag.
        "migrate_image_tag": "a1b2c3d",
    }


def test_placeholders_fill_in_when_nothing_is_passed():
    """`cdk synth` has to work on a clean checkout with no credentials — CI
    runs it with no context at all — so every value needs a default.
    """
    values = read_context(cdk.App(), PLACEHOLDER_AWS_ACCOUNT_ID)

    assert values["worker_ami_id"] == PLACEHOLDER_WORKER_AMI_ID
    assert values["alert_email"] == PLACEHOLDER_ALERT_EMAIL
    assert values["hosted_zone_id"] == PLACEHOLDER_HOSTED_ZONE_ID
    assert values["web_image_tag"] == PLACEHOLDER_WEB_IMAGE_TAG
    assert values["migrate_image_tag"] == PLACEHOLDER_WEB_IMAGE_TAG
    assert PLACEHOLDER_AWS_ACCOUNT_ID in values["clerk_secret_key_arn"]


def test_migrate_image_tag_defaults_to_the_web_image_tag():
    """migrateImageTag has no placeholder to refuse, unlike the four keys in
    PLACEHOLDERS above. It has a safe default (mirror webImageTag), so every
    existing manual RUNBOOK invocation that never mentions it keeps working
    unchanged. ci.yml's deploy job is the one caller that ever diverges the
    two on purpose (RUNBOOK.md).
    """
    values = read_context(cdk.App(context=DEPLOY_CONTEXT), REAL_ACCOUNT)
    assert values["migrate_image_tag"] == DEPLOY_CONTEXT["webImageTag"]

    context = {**DEPLOY_CONTEXT, "migrateImageTag": "e5f6a7b"}
    values = read_context(cdk.App(context=context), REAL_ACCOUNT)
    assert values["migrate_image_tag"] == "e5f6a7b"


@pytest.mark.parametrize("key", sorted(PLACEHOLDERS))
def test_a_real_account_refuses_each_placeholder(key):
    """One case per guarded key, each dropping only that flag: a single
    no-context call would stop at whichever key is checked first and leave the
    rest unguarded without failing anything.

    Every placeholder synthesizes cleanly, and past synth they cost a
    rolled-back deploy at best — at worst a green one whose spend alerts go
    nowhere. The account is what separates the two: `cdk synth` on a clean
    checkout is the same call with the placeholder account.
    """
    context = {**DEPLOY_CONTEXT, key: PLACEHOLDERS[key]}

    with pytest.raises(ValueError, match=key):
        read_context(cdk.App(context=context), REAL_ACCOUNT)

    read_context(cdk.App(context=context), PLACEHOLDER_AWS_ACCOUNT_ID)


def test_an_absent_account_falls_back_to_the_placeholder(monkeypatch):
    """The offline path every `cdk synth` without credentials takes, CI's own
    infra job included. It is also what disarms read_context's placeholder
    guards, so it has to stay reachable.
    """
    monkeypatch.delenv("AWS_ACCOUNT_ID", raising=False)

    assert read_account() == PLACEHOLDER_AWS_ACCOUNT_ID


def test_a_real_account_is_taken_as_given(monkeypatch):
    monkeypatch.setenv("AWS_ACCOUNT_ID", REAL_ACCOUNT)

    assert read_account() == REAL_ACCOUNT


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty-what-an-unset-github-repository-variable-expands-to"),
        pytest.param(" ", id="whitespace"),
        pytest.param("12345", id="truncated"),
        pytest.param(f"arn:aws:iam::{REAL_ACCOUNT}:root", id="an-arn-pasted-whole"),
    ],
)
def test_a_malformed_account_is_refused(monkeypatch, value):
    """Empty is the case that matters, and it is not the same as absent: an
    empty variable is present, so os.environ.get's default never applies.
    Left through, it is neither a real account nor the placeholder, and
    read_context reads it as a real deploy and blames the first `-c` flag it
    checks instead of the account.
    """
    monkeypatch.setenv("AWS_ACCOUNT_ID", value)

    with pytest.raises(ValueError, match="AWS_ACCOUNT_ID"):
        read_account()


def test_app_public_url_must_be_https():
    """The ALB answers https only, and a worker whose callbacks all fail is
    silent about it — status.py swallows them — so the job looks stuck rather
    than misconfigured. Cheaper to refuse the scheme here.
    """
    context = {**DEPLOY_CONTEXT, "appPublicUrl": "http://example.test"}

    with pytest.raises(ValueError, match="appPublicUrl"):
        read_context(cdk.App(context=context), REAL_ACCOUNT)
