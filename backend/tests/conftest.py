import os

import pytest

# Populated before any `app.*` module is imported, since Settings() reads
# these at import time via get_settings()'s module-level cache.
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://test:test@localhost/test")
os.environ.setdefault("CLERK_JWKS_URL", "https://example.clerk.accounts.dev/.well-known/jwks.json")
os.environ.setdefault("CLERK_ISSUER", "https://example.clerk.accounts.dev")
os.environ.setdefault("UPLOADS_BUCKET", "test-uploads")
os.environ.setdefault("SPLATS_BUCKET", "test-splats")
os.environ.setdefault("WORKER_AMI_ID", "ami-0123456789")
os.environ.setdefault("WORKER_SUBNET_ID", "subnet-0123456789")
os.environ.setdefault("WORKER_SECURITY_GROUP_ID", "sg-0123456789")
os.environ.setdefault("WORKER_INSTANCE_PROFILE_ARN", "arn:aws:iam::123456789012:instance-profile/worker")
os.environ.setdefault("BACKEND_PUBLIC_URL", "https://api.example.com")


@pytest.fixture(autouse=True)
def aws_test_credentials(monkeypatch):
    for var, value in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_SECURITY_TOKEN": "testing",
        "AWS_SESSION_TOKEN": "testing",
        "AWS_DEFAULT_REGION": "us-east-1",
    }.items():
        monkeypatch.setenv(var, value)


def requires_postgres(reason: str = "needs a real Postgres — see plan §8, run against CI's service container"):
    """Marks tests that exercise Postgres-specific behavior (dialect-specific
    ON CONFLICT upserts in rate_limit.py) that SQLite can't faithfully
    substitute for. Skipped unless TEST_DATABASE_URL points at a real
    Postgres instance.
    """
    import pytest as _pytest

    return _pytest.mark.skipif("TEST_DATABASE_URL" not in os.environ, reason=reason)
