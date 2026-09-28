import boto3
import pytest
import torch
from moto import mock_aws
from plyfile import PlyData

from pipeline.config import CropBox
from pipeline.export import ExportedFiles, _crop_scene, _write_ply, upload_result
from pipeline.train import SH_DEGREE, GaussianModel, TrainedScene


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


def test_crop_scene_keeps_every_attribute_of_the_gaussians_inside():
    box = CropBox(center=(0, 0, 0), size=(2, 2, 2), quaternion=(0, 0, 0, 1))
    cropped = _crop_scene(_scene([[0, 0, 0], [5, 0, 0], [0.5, 0.5, 0.5]]), box).model

    assert cropped.means.tolist() == [[0, 0, 0], [0.5, 0.5, 0.5]]
    assert cropped.opacities.tolist() == [0, 2]
    assert cropped.scales[:, 0].tolist() == [0, 2]
    assert cropped.sh0[:, 0, 0].tolist() == [0, 2]
    assert cropped.shN[:, 0, 0].tolist() == [0, 2]


def test_crop_scene_fails_when_the_box_holds_nothing():
    box = CropBox(center=(10, 10, 10), size=(1, 1, 1), quaternion=(0, 0, 0, 1))
    with pytest.raises(RuntimeError, match="crop box"):
        _crop_scene(_scene([[0, 0, 0]]), box)


def test_crop_box_is_read_from_its_json_env_var(monkeypatch, settings):
    monkeypatch.setenv("CROP_BOX", '{"center":[1,2,3],"size":[4,5,6],"quaternion":[0,0,0,1]}')
    loaded = type(settings)(**settings.model_dump(exclude={"crop_box"}))

    assert loaded.crop_box == CropBox(center=(1, 2, 3), size=(4, 5, 6), quaternion=(0, 0, 0, 1))


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
