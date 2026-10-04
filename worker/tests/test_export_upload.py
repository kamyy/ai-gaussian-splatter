import gzip
from pathlib import Path

import boto3
import torch
from moto import mock_aws
from plyfile import PlyData

from pipeline.export import ExportedFiles, _write_ply, upload_result
from pipeline.spz import write_spz
from pipeline.train import SH_DEGREE, GaussianModel, TrainedScene

# The .ply and .spz web/lib/server/tests/cropSplat.test.ts crops. Regenerating them is running this test's scene
# through the two writers; gzip's timestamp differs per call, so the .spz is compared after decompressing.
CROP_FIXTURE = Path(__file__).parent / "fixtures" / "crop"


def _scene(means: list[list[float]]) -> TrainedScene:
    n = len(means)
    return TrainedScene(
        model=GaussianModel(
            means=torch.tensor(means),
            scales=torch.arange(n, dtype=torch.float32)[:, None].repeat(1, 3),
            quats=torch.zeros((n, 4)),
            opacities=torch.arange(n, dtype=torch.float32),
            sh0=torch.arange(n, dtype=torch.float32)[:, None, None].repeat(1, 1, 3),
            shN=torch.arange(n, dtype=torch.float32)[:, None, None].repeat(1, (SH_DEGREE + 1) ** 2 - 1, 3),
        ),
        canonical_viewmat=torch.eye(4),
        canonical_K=torch.eye(3),
        canonical_width=4,
        canonical_height=3,
    )


def _crop_fixture_scene() -> TrainedScene:
    """Three Gaussians: two inside the unit box at the origin, and one at x=5 outside it."""
    means = [[0.0, 0.0, 0.0], [5.0, 0.0, 0.0], [0.5, -0.5, 0.5]]
    n = len(means)
    return TrainedScene(
        model=GaussianModel(
            means=torch.tensor(means),
            scales=torch.arange(n, dtype=torch.float32)[:, None].repeat(1, 3),
            quats=torch.tensor([[1.0, 0.0, 0.0, 0.0]]).repeat(n, 1),
            opacities=torch.arange(n, dtype=torch.float32),
            sh0=torch.arange(n, dtype=torch.float32)[:, None, None].repeat(1, 1, 3),
            shN=torch.arange(n, dtype=torch.float32)[:, None, None].repeat(1, (SH_DEGREE + 1) ** 2 - 1, 3),
        ),
        canonical_viewmat=torch.eye(4),
        canonical_K=torch.eye(3),
        canonical_width=4,
        canonical_height=3,
    )


def test_crop_fixture_matches_the_writers(tmp_path):
    scene = _crop_fixture_scene()
    ply = tmp_path / "result.ply"
    spz = tmp_path / "result.spz"
    _write_ply(scene, ply)
    write_spz(scene.model, spz)

    assert ply.read_bytes() == (CROP_FIXTURE / "result.ply").read_bytes()
    assert gzip.decompress(spz.read_bytes()) == gzip.decompress((CROP_FIXTURE / "result.spz").read_bytes())


def test_write_ply_orders_higher_sh_coefficients_channel_major(tmp_path):
    scene = _scene([[0, 0, 0]])
    scene.model.quats = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
    k = (SH_DEGREE + 1) ** 2 - 1
    scene.model.shN = torch.arange(k * 3, dtype=torch.float32).reshape(1, k, 3)  # coefficient c, channel ch = 3c + ch
    path = tmp_path / "result.ply"

    _write_ply(scene, path)

    vertex = PlyData.read(str(path))["vertex"]
    f_rest = [float(vertex[f"f_rest_{i}"][0]) for i in range(k * 3)]
    assert f_rest == [3 * c + ch for ch in range(3) for c in range(k)]


@mock_aws
def test_upload_result_puts_files_at_expected_keys(settings, tmp_path):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)

    files = ExportedFiles(ply=tmp_path / "result.ply", spz=tmp_path / "result.spz", thumbnail=tmp_path / "t.png")
    files.ply.write_bytes(b"fake-ply-data")
    files.spz.write_bytes(b"fake-spz-data")
    files.thumbnail.write_bytes(b"fake-png-data")

    keys = upload_result(files, settings)

    assert keys.ply == f"splats/{settings.splat_id}/result.ply"
    assert keys.spz == f"splats/{settings.splat_id}/result.spz"
    assert keys.thumbnail == f"splats/{settings.splat_id}/thumbnail.png"

    def body(key: str) -> bytes:
        return s3.get_object(Bucket=settings.splats_bucket, Key=key)["Body"].read()

    assert body(keys.ply) == b"fake-ply-data"
    assert body(keys.spz) == b"fake-spz-data"
    assert body(keys.thumbnail) == b"fake-png-data"
