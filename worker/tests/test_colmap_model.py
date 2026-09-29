import struct

import numpy as np
import pytest

from pipeline.colmap_model import qvec_to_rotmat, read_sparse_model

# Writers for the layout worker/pipeline/colmap_model.py reads, following COLMAP's read_write_model.py.


def _write_cameras(path, cameras):
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(cameras)))
        for camera_id, model_id, width, height, params in cameras:
            f.write(struct.pack("<iiQQ", camera_id, model_id, width, height))
            f.write(struct.pack(f"<{len(params)}d", *params))


def _write_images(path, images):
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(images)))
        for image_id, qvec, tvec, camera_id, name, num_points2d in images:
            f.write(struct.pack("<i", image_id))
            f.write(struct.pack("<4d", *qvec))
            f.write(struct.pack("<3d", *tvec))
            f.write(struct.pack("<i", camera_id))
            f.write(name.encode() + b"\x00")
            f.write(struct.pack("<Q", num_points2d))
            f.write(struct.pack("<ddq", 1.0, 2.0, -1) * num_points2d)


def _write_points(path, points):
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(points)))
        for point_id, xyz, rgb, track_length in points:
            f.write(struct.pack("<Q", point_id))
            f.write(struct.pack("<3d", *xyz))
            f.write(struct.pack("<3B", *rgb))
            f.write(struct.pack("<d", 0.5))
            f.write(struct.pack("<Q", track_length))
            f.write(struct.pack("<ii", 1, 0) * track_length)


@pytest.fixture
def model_dir(tmp_path):
    _write_cameras(
        tmp_path / "cameras.bin",
        [
            (1, 1, 4000, 3000, (3200.0, 3100.0, 2000.0, 1500.0)),  # PINHOLE: fx, fy, cx, cy
            (2, 2, 1920, 1080, (1500.0, 960.0, 540.0, 0.01)),  # SIMPLE_RADIAL: f, cx, cy, k
        ],
    )
    # Each image and point carries data the reader skips, so a wrong skip length shifts every record after it.
    _write_images(
        tmp_path / "images.bin",
        [
            (1, (1.0, 0.0, 0.0, 0.0), (1.0, 2.0, 3.0), 1, "a.jpg", 3),
            (2, (0.0, 1.0, 0.0, 0.0), (4.0, 5.0, 6.0), 2, "b.jpg", 0),
        ],
    )
    _write_points(
        tmp_path / "points3D.bin",
        [(1, (0.5, 1.5, 2.5), (10, 20, 30), 2), (2, (-1.0, 0.0, 1.0), (40, 50, 60), 0)],
    )
    return tmp_path


def test_reads_each_camera_model_into_focal_lengths_and_principal_point(model_dir):
    cameras = read_sparse_model(model_dir).cameras

    pinhole, simple_radial = cameras[1], cameras[2]
    assert (pinhole.width, pinhole.height) == (4000, 3000)
    assert (pinhole.fx, pinhole.fy, pinhole.cx, pinhole.cy) == (3200.0, 3100.0, 2000.0, 1500.0)
    assert (simple_radial.fx, simple_radial.fy, simple_radial.cx, simple_radial.cy) == (1500.0, 1500.0, 960.0, 540.0)


def test_reads_images_past_their_2d_points(model_dir):
    images = read_sparse_model(model_dir).images

    assert [images[1].name, images[2].name] == ["a.jpg", "b.jpg"]
    np.testing.assert_array_equal(images[2].qvec, [0.0, 1.0, 0.0, 0.0])
    np.testing.assert_array_equal(images[2].tvec, [4.0, 5.0, 6.0])
    assert images[2].camera_id == 2


def test_reads_points_past_their_tracks(model_dir):
    model = read_sparse_model(model_dir)

    np.testing.assert_array_equal(model.points_xyz, [[0.5, 1.5, 2.5], [-1.0, 0.0, 1.0]])
    np.testing.assert_array_equal(model.points_rgb, [[10, 20, 30], [40, 50, 60]])
    assert model.points_rgb.dtype == np.uint8


def test_qvec_to_rotmat_turns_a_quarter_turn_about_z():
    half = np.sqrt(0.5)

    rotation = qvec_to_rotmat(np.array([half, 0.0, 0.0, half]))

    np.testing.assert_allclose(rotation @ [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(qvec_to_rotmat(np.array([1.0, 0.0, 0.0, 0.0])), np.eye(3))
