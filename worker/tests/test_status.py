import httpx
import respx

from pipeline.status import report_status


@respx.mock
def test_report_status_sends_expected_payload_and_auth(settings):
    route = respx.patch(
        f"{settings.backend_url}/api/v1/internal/jobs/{settings.job_id}/status"
    ).mock(return_value=httpx.Response(200))

    report_status(settings, "training_running")

    assert route.called
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {settings.callback_token}"
    assert request.content == b'{"status":"training_running"}'


@respx.mock
def test_report_status_includes_optional_fields_when_provided(settings):
    route = respx.patch(
        f"{settings.backend_url}/api/v1/internal/jobs/{settings.job_id}/status"
    ).mock(return_value=httpx.Response(200))

    report_status(
        settings, "complete", result_s3_key="objects/x/result.ply", thumbnail_s3_key="objects/x/thumbnail.png"
    )

    import json

    payload = json.loads(route.calls.last.request.content)
    assert payload == {
        "status": "complete",
        "result_s3_key": "objects/x/result.ply",
        "thumbnail_s3_key": "objects/x/thumbnail.png",
    }


@respx.mock
def test_report_status_swallows_network_errors(settings):
    respx.patch(f"{settings.backend_url}/api/v1/internal/jobs/{settings.job_id}/status").mock(
        side_effect=httpx.ConnectError("connection refused")
    )

    # Must not raise — a failed status update should never crash the pipeline
    # (see status.py docstring and run_job.py's finally block).
    report_status(settings, "failed", error_message="boom")
