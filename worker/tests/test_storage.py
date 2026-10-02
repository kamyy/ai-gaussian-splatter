import httpx
import pytest
import respx

from pipeline.storage import s3_client


def test_local_run_keeps_default_credentials(settings):
    client = s3_client(settings)

    assert client._request_signer._credentials.access_key == "testing"


@respx.mock
def test_aws_run_uses_the_apps_scoped_credentials(settings):
    settings.s3_credentials_from_app = True
    route = respx.post(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/s3-credentials").mock(
        return_value=httpx.Response(
            200, json={"access_key_id": "ASIA", "secret_access_key": "secret", "session_token": "session"}
        )
    )

    client = s3_client(settings)

    assert route.called
    assert route.calls.last.request.headers["Authorization"] == f"Bearer {settings.callback_token}"
    credentials = client._request_signer._credentials
    assert (credentials.access_key, credentials.secret_key, credentials.token) == ("ASIA", "secret", "session")


@respx.mock
def test_aws_run_raises_at_once_when_the_app_refuses(settings, monkeypatch):
    # A 409 means the job has ended, so asking again gets the same answer. Falling back to the instance role would only
    # fail later, on the first S3 call, with a less useful error.
    sleeps: list[float] = []
    monkeypatch.setattr("pipeline.storage.time.sleep", sleeps.append)
    settings.s3_credentials_from_app = True
    route = respx.post(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/s3-credentials").mock(
        return_value=httpx.Response(409)
    )

    with pytest.raises(httpx.HTTPStatusError):
        s3_client(settings)

    assert route.call_count == 1
    assert sleeps == []


@respx.mock
def test_aws_run_retries_while_the_app_is_unreachable(settings, monkeypatch):
    # The load balancer answers 502 or 503 while ECS replaces the app's tasks during a deploy.
    sleeps: list[float] = []
    monkeypatch.setattr("pipeline.storage.time.sleep", sleeps.append)
    settings.s3_credentials_from_app = True
    route = respx.post(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/s3-credentials").mock(
        side_effect=[
            httpx.ConnectError("connection refused"),
            httpx.Response(503),
            httpx.Response(
                200, json={"access_key_id": "ASIA", "secret_access_key": "secret", "session_token": "session"}
            ),
        ]
    )

    client = s3_client(settings)

    assert route.call_count == 3
    assert sleeps == [2.0, 4.0]
    assert client._request_signer._credentials.access_key == "ASIA"


@respx.mock
def test_aws_run_gives_up_after_the_last_retry(settings, monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr("pipeline.storage.time.sleep", sleeps.append)
    settings.s3_credentials_from_app = True
    route = respx.post(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/s3-credentials").mock(
        return_value=httpx.Response(502)
    )

    with pytest.raises(httpx.HTTPStatusError):
        s3_client(settings)

    assert route.call_count == 5
    assert sleeps == [2.0, 4.0, 8.0, 16.0]
