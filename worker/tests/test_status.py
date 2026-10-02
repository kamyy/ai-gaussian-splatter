import json

import httpx
import pytest
import respx

from pipeline.status import report_status


@respx.mock
def test_report_status_sends_expected_payload_and_auth(settings):
    route = respx.patch(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/status").mock(
        return_value=httpx.Response(200)
    )

    report_status(settings, "training_running")

    assert route.called
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {settings.callback_token}"
    assert request.content == b'{"status":"training_running"}'


@pytest.mark.parametrize(
    ("status", "fields"),
    [
        (
            "complete",
            {
                "result_s3_key": "splats/x/result.ply",
                "result_spz_s3_key": "splats/x/result.spz",
                "thumbnail_s3_key": "splats/x/thumbnail.png",
            },
        ),
        ("awaiting_training", {"point_cloud_s3_key": "splats/x/point_cloud.ply"}),
        ("training_running", {"training_progress": 45}),
        ("reconstruction_running", {"booted_at": 1_767_225_660_000}),
        ("failed", {"error_message": "boom"}),
    ],
)
@respx.mock
def test_report_status_includes_optional_fields_when_provided(settings, status, fields):
    route = respx.patch(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/status").mock(
        return_value=httpx.Response(200)
    )

    report_status(settings, status, **fields)

    assert json.loads(route.calls.last.request.content) == {"status": status, **fields}


@pytest.mark.parametrize(
    "mock",
    [{"side_effect": httpx.ConnectError("connection refused")}, {"return_value": httpx.Response(500)}],
)
@respx.mock
def test_report_status_swallows_network_and_http_errors(settings, mock):
    respx.patch(f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/status").mock(**mock)

    # Must not raise. A failed status update should never crash the pipeline (see worker/pipeline/status.py's docstring
    # and worker/run_job.py's finally block).
    report_status(settings, "failed", error_message="boom")
