import sys
from pathlib import Path
from types import ModuleType

import pytest

import pipeline
import run_job
from pipeline.colmap_model import Image, SparseModel
from pipeline.sfm import SfmResult


@pytest.fixture
def calls(mocker, tmp_path):
    """Replaces every step run_job.py calls, recording status reports and whether the instance terminated itself."""
    statuses: list[tuple[str, dict]] = []
    mocker.patch.object(run_job.status, "report_status", lambda _settings, s, **kw: statuses.append((s, kw)))
    terminate = mocker.patch.object(run_job, "terminate_self")
    mocker.patch.object(run_job.fetch, "fetch_photos", return_value=tmp_path / "photos")
    mocker.patch.object(run_job.sparse_export, "upload_sparse_model")
    mocker.patch.object(run_job.sparse_export, "export_and_upload_point_cloud", return_value="splats/s/point_cloud.ply")
    mocker.patch.object(run_job.sparse_export, "export_and_upload_cameras")
    mocker.patch.object(run_job.sparse_export, "download_sparse_model")
    return statuses, terminate


def _colmap_result(registered: int, total: int) -> SfmResult:
    return SfmResult(sparse_dir=Path("sparse/0"), num_images_input=total, num_images_registered=registered)


def test_reconstruct_pauses_at_awaiting_training_with_the_point_cloud_and_terminates(mocker, settings, calls):
    statuses, terminate = calls
    mocker.patch.object(run_job.sfm, "run_colmap", return_value=_colmap_result(20, 20))

    assert run_job._run_reconstruct(settings) == 0

    assert statuses == [
        ("reconstruction_running", {"booted_at": None}),
        ("awaiting_training", {"point_cloud_s3_key": "splats/s/point_cloud.ply"}),
    ]
    terminate.assert_called_once()


def test_reconstruct_fails_a_capture_that_mostly_didnt_register_before_uploading_anything(mocker, settings, calls):
    statuses, terminate = calls
    mocker.patch.object(run_job.sfm, "run_colmap", return_value=_colmap_result(9, 20))

    assert run_job._run_reconstruct(settings) == 1

    status, fields = statuses[-1]
    assert status == "failed"
    assert "45%" in fields["error_message"]
    run_job.sparse_export.upload_sparse_model.assert_not_called()
    terminate.assert_called_once()


def test_reconstruct_reports_a_crash_and_still_terminates(mocker, settings, calls):
    statuses, terminate = calls
    mocker.patch.object(run_job.sfm, "run_colmap", side_effect=RuntimeError("feature_extractor exited 1"))

    assert run_job._run_reconstruct(settings) == 1

    assert statuses[-1] == ("failed", {"error_message": "feature_extractor exited 1"})
    terminate.assert_called_once()


def _fake_module(mocker, name: str, **attrs) -> ModuleType:
    """Stands in for a torch-backed module that worker/run_job.py imports inside _run_train. `from pipeline import x`
    reads the package attribute when an earlier test already imported the real module, so both places are patched.
    """
    module = ModuleType(f"pipeline.{name}")
    for attr, value in attrs.items():
        setattr(module, attr, value)
    mocker.patch.dict(sys.modules, {f"pipeline.{name}": module})
    mocker.patch.object(pipeline, name, module, create=True)
    return module


def test_train_reports_every_result_key_on_completion_and_terminates(mocker, settings, calls, tmp_path):
    statuses, terminate = calls
    (tmp_path / "photos").mkdir()
    (tmp_path / "photos" / "a.jpg").touch()
    sparse = SparseModel(cameras={}, images={1: Image(1, None, None, 1, "a.jpg")}, points_xyz=None, points_rgb=None)
    mocker.patch.object(run_job, "read_sparse_model", return_value=sparse)
    keys = type("Keys", (), {"ply": "r.ply", "spz": "r.spz", "thumbnail": "t.jpg"})()
    _fake_module(mocker, "train", train=lambda *_args, **_kwargs: "scene")
    _fake_module(mocker, "export", export_scene=lambda *_args: "files", upload_result=lambda *_args: keys)

    assert run_job._run_train(settings) == 0

    assert [status for status, _ in statuses] == ["training_running", "uploading_result", "complete"]
    assert statuses[0][1] == {"booted_at": None}
    assert statuses[-1][1] == {"result_ply_s3_key": "r.ply", "result_spz_s3_key": "r.spz", "thumbnail_s3_key": "t.jpg"}
    terminate.assert_called_once()


def test_train_fails_clearly_when_a_photo_colmap_used_is_gone(mocker, settings, calls, tmp_path):
    statuses, terminate = calls
    (tmp_path / "photos").mkdir()
    sparse = SparseModel(cameras={}, images={1: Image(1, None, None, 1, "gone.jpg")}, points_xyz=None, points_rgb=None)
    mocker.patch.object(run_job, "read_sparse_model", return_value=sparse)
    train = _fake_module(mocker, "train", train=mocker.Mock())
    _fake_module(mocker, "export")

    assert run_job._run_train(settings) == 1

    status, fields = statuses[-1]
    assert status == "failed"
    assert "gone.jpg" in fields["error_message"]
    train.train.assert_not_called()
    terminate.assert_called_once()


def test_train_reports_a_failed_torch_import_and_still_terminates(monkeypatch, settings, calls):
    # The reconstruct image carries no torch, so a train stage launched on it fails at the import inside the try.
    statuses, terminate = calls
    monkeypatch.setitem(sys.modules, "pipeline.train", None)
    monkeypatch.delattr(pipeline, "train", raising=False)

    assert run_job._run_train(settings) == 1

    assert [status for status, _ in statuses] == ["training_running", "failed"]
    assert "pipeline.train" in statuses[-1][1]["error_message"]
    terminate.assert_called_once()


def test_each_stage_reports_its_boot_time_with_its_first_status(mocker, settings, calls):
    statuses, _ = calls
    mocker.patch.object(run_job.sfm, "run_colmap", return_value=_colmap_result(20, 20))

    run_job._run_reconstruct(settings.model_copy(update={"booted_at": 1_767_225_660_000}))

    assert statuses[0] == ("reconstruction_running", {"booted_at": 1_767_225_660_000})
    assert "booted_at" not in statuses[1][1]


def test_train_reports_its_start_before_loading_torch(monkeypatch, settings, calls):
    # The gap from the boot time to this first report is shown as the image pull, so it mustn't include the import.
    statuses, _ = calls
    monkeypatch.setitem(sys.modules, "pipeline.train", None)
    monkeypatch.delattr(pipeline, "train", raising=False)

    run_job._run_train(settings.model_copy(update={"booted_at": 1_767_225_660_000}))

    assert statuses[0] == ("training_running", {"booted_at": 1_767_225_660_000})
