import pytest

from pipeline.config import Settings


@pytest.fixture(autouse=True)
def aws_test_credentials(monkeypatch):
    """moto intercepts AWS calls but boto3 clients still need *some*
    region/credentials configured to construct. These are fake and never
    used to hit real AWS.
    """
    for var, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_SECURITY_TOKEN": "testing",
        "AWS_SESSION_TOKEN": "testing",
        "AWS_DEFAULT_REGION": "us-east-1",
    }.items():
        monkeypatch.setenv(var, value)


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        job_id="job-123",
        splat_id="splat-456",
        callback_token="test-token",
        app_public_url="https://app.example.com",
        uploads_bucket="test-uploads",
        splats_bucket="test-splats",
        local_workdir=str(tmp_path),
    )
