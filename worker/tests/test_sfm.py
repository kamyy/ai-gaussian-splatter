import subprocess

from pipeline.sfm import SfmResult, _count_registered_images

FAKE_ANALYZER_OUTPUT = "Cameras: 1\nImages: 50\nRegistered images: 47\nPoints: 12345\n"


def _fake_run(stdout: str, stderr: str):
    def fake_run(cmd, check, capture_output, text):
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr=stderr)

    return fake_run


def test_count_registered_images_reads_stderr(monkeypatch, tmp_path):
    """Where COLMAP actually reports it: the count goes through glog, which
    writes to stderr and never to stdout. A fixture that puts it on stdout
    passes while the real pipeline raises on every successful reconstruction.
    """
    monkeypatch.setattr("pipeline.sfm.subprocess.run", _fake_run("", FAKE_ANALYZER_OUTPUT))

    assert _count_registered_images(tmp_path) == 47


def test_count_registered_images_reads_stdout(monkeypatch, tmp_path):
    """Both streams are searched, so a future COLMAP that prints the summary
    directly keeps working."""
    monkeypatch.setattr("pipeline.sfm.subprocess.run", _fake_run(FAKE_ANALYZER_OUTPUT, ""))

    assert _count_registered_images(tmp_path) == 47


def test_sfm_result_registered_ratio():
    result = SfmResult(sparse_dir="/tmp/x", num_images_input=50, num_images_registered=47)
    assert result.registered_ratio == 47 / 50


def test_sfm_result_registered_ratio_handles_zero_input():
    result = SfmResult(sparse_dir="/tmp/x", num_images_input=0, num_images_registered=0)
    assert result.registered_ratio == 0.0
