import subprocess

from pipeline.sfm import SfmResult, _count_registered_images, run_colmap

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


def test_run_colmap_excludes_non_image_files_from_image_path(monkeypatch, tmp_path):
    """COLMAP scans --image_path itself. A stray non-image file left in photos_dir (a phone's video sidecar, a
    thumbnail) must never reach it: --ImageReader.single_camera locks every photo's intrinsics to whichever file
    COLMAP reads first, so a wrong-sized stray file poisons every real photo with CAMERA_SINGLE_DIM_ERROR.
    """
    photos_dir = tmp_path / "photos"
    photos_dir.mkdir()
    (photos_dir / "a.jpg").write_bytes(b"fake")
    (photos_dir / "b.jpg").write_bytes(b"fake")
    (photos_dir / "video.mp4").write_bytes(b"fake")

    workdir = tmp_path / "colmap"
    seen_image_paths = []

    def fake_run(cmd, capture=False):
        if "--image_path" in cmd:
            seen_image_paths.append(cmd[cmd.index("--image_path") + 1])
        if cmd[1] == "mapper":
            (workdir / "sparse" / "0").mkdir(parents=True, exist_ok=True)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr("pipeline.sfm._run", fake_run)
    monkeypatch.setattr("pipeline.sfm._count_registered_images", lambda model_dir: 2)

    result = run_colmap(photos_dir, workdir)

    images_dir = workdir / "images"
    assert sorted(p.name for p in images_dir.iterdir()) == ["a.jpg", "b.jpg"]
    assert seen_image_paths == [str(images_dir)] * len(seen_image_paths)
    assert result.num_images_input == 2
