import subprocess

from pipeline.sfm import SfmResult, _count_registered_images


def test_count_registered_images_parses_model_analyzer_output(monkeypatch, tmp_path):
    fake_output = "Cameras: 1\nImages: 50\nRegistered images: 47\nPoints: 12345\n"

    def fake_run(cmd, check, capture_output, text):
        return subprocess.CompletedProcess(cmd, 0, stdout=fake_output, stderr="")

    monkeypatch.setattr("pipeline.sfm.subprocess.run", fake_run)

    assert _count_registered_images(tmp_path) == 47


def test_sfm_result_registered_ratio():
    result = SfmResult(sparse_dir="/tmp/x", num_images_input=50, num_images_registered=47)
    assert result.registered_ratio == 47 / 50


def test_sfm_result_registered_ratio_handles_zero_input():
    result = SfmResult(sparse_dir="/tmp/x", num_images_input=0, num_images_registered=0)
    assert result.registered_ratio == 0.0
