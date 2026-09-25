import boto3
import pytest
import torch
from moto import mock_aws

from pipeline.config import CropBox
from pipeline.export import _crop_scene, upload_result
from pipeline.train import GaussianModel, TrainedScene


def _scene(means: list[list[float]]) -> TrainedScene:
    n = len(means)
    return TrainedScene(
        model=GaussianModel(
            means=torch.tensor(means),
            scales=torch.arange(n, dtype=torch.float32)[:, None].repeat(1, 3),
            quats=torch.zeros((n, 4)),
            opacities=torch.arange(n, dtype=torch.float32),
            colors=torch.zeros((n, 3)),
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


def test_crop_scene_fails_when_the_box_holds_nothing():
    box = CropBox(center=(10, 10, 10), size=(1, 1, 1), quaternion=(0, 0, 0, 1))
    with pytest.raises(RuntimeError, match="crop box"):
        _crop_scene(_scene([[0, 0, 0]]), box)


def test_crop_box_is_read_from_its_json_env_var(monkeypatch, settings):
    monkeypatch.setenv("CROP_BOX", '{"center":[1,2,3],"size":[4,5,6],"quaternion":[0,0,0,1]}')
    loaded = type(settings)(**settings.model_dump(exclude={"crop_box"}))

    assert loaded.crop_box == CropBox(center=(1, 2, 3), size=(4, 5, 6), quaternion=(0, 0, 0, 1))


@mock_aws
def test_upload_result_puts_files_at_expected_keys(settings, tmp_path):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)

    ply_path = tmp_path / "result.ply"
    ply_path.write_bytes(b"fake-ply-data")
    thumbnail_path = tmp_path / "thumbnail.png"
    thumbnail_path.write_bytes(b"fake-png-data")

    result_key, thumbnail_key = upload_result(ply_path, thumbnail_path, settings)

    assert result_key == f"splats/{settings.splat_id}/result.ply"
    assert thumbnail_key == f"splats/{settings.splat_id}/thumbnail.png"

    body = s3.get_object(Bucket=settings.splats_bucket, Key=result_key)["Body"].read()
    assert body == b"fake-ply-data"
