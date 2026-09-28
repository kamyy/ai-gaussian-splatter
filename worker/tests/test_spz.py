import gzip
import struct

import numpy as np
import pytest
import torch

from pipeline.spz import write_spz
from pipeline.train import SH_DEGREE, GaussianModel

SH_COUNT = ((SH_DEGREE + 1) ** 2 - 1) * 3


def _model() -> GaussianModel:
    # Quaternions are w, x, y, z. The second's largest component is y, and negative. The third's is w.
    quats = torch.tensor([[1.0, 0.0, 0.0, 0.0], [0.1, 0.2, -0.9, 0.3], [0.8, -0.4, 0.3, 0.2]])
    sh_n = torch.zeros((3, SH_COUNT // 3, 3))
    sh_n[1, 0, 0] = 0.3  # a degree-1 value
    sh_n[1, 5, 2] = -0.45  # a degree-2 value
    sh_n[2, 14, 1] = 5.0  # clamps high
    return GaussianModel(
        means=torch.tensor([[0.0, 0.0, 0.0], [1.5, -2.25, 0.001], [-100.0, 3.0, 7.0]]),
        scales=torch.tensor([[-3.0, -4.0, -5.0], [0.0, 0.5, -1.0], [-20.0, 10.0, -2.0]]),  # the last two clamp
        quats=quats,
        opacities=torch.tensor([0.0, 3.0, -3.0]),
        sh0=torch.tensor([[[0.0, 1.0, -1.0]], [[4.0, -4.0, 0.5]], [[0.2, 0.3, 0.4]]]),  # 4 and -4 clamp
        shN=sh_n,
    )


def _decode(path):
    data = gzip.decompress(path.read_bytes())
    magic, version, n, sh_degree, fractional_bits, flags, _reserved = struct.unpack_from("<IIIBBBB", data)
    offset = 16

    def take(count):
        nonlocal offset
        chunk = np.frombuffer(data, dtype=np.uint8, count=count, offset=offset)
        offset += count
        return chunk

    raw_positions = take(n * 9).reshape(n, 3, 3).astype(np.int32)
    fixed = raw_positions[..., 0] | (raw_positions[..., 1] << 8) | (raw_positions[..., 2] << 16)
    fixed = np.where(fixed & 0x800000, fixed - (1 << 24), fixed)
    alphas = take(n)
    colors = take(n * 3).reshape(n, 3)
    scales = take(n * 3).reshape(n, 3)
    rotations = take(n * 4).reshape(n, 4)
    sh = take(n * SH_COUNT).reshape(n, SH_COUNT)
    assert offset == len(data)
    return {
        "header": (magic, version, n, sh_degree, fractional_bits, flags),
        "positions": fixed / (1 << fractional_bits),
        "alphas": alphas / 255,
        "colors": (colors / 255 - 0.5) / 0.15,
        "scales": scales / 16 - 10,
        "quats_xyzw": np.array([_unpack_quaternion(r) for r in rotations]),
        "sh": (sh.astype(np.float64) - 128) / 128,
    }


def _unpack_quaternion(r):
    comp = int(r[0]) | int(r[1]) << 8 | int(r[2]) << 16 | int(r[3]) << 24
    largest = comp >> 30
    q = np.zeros(4)
    for i in reversed(range(4)):
        if i == largest:
            continue
        magnitude = comp & 511
        negative = (comp >> 9) & 1
        comp >>= 10
        q[i] = np.sqrt(0.5) * magnitude / 511 * (-1 if negative else 1)
    q[largest] = np.sqrt(1 - np.sum(q**2))
    return q


@pytest.fixture
def decoded(tmp_path):
    path = tmp_path / "result.spz"
    write_spz(_model(), path)
    return _decode(path)


def test_header_describes_a_version_3_degree_3_file(decoded):
    assert decoded["header"] == (0x5053474E, 3, 3, SH_DEGREE, 12, 0)


def test_positions_round_trip_to_fixed_point_precision(decoded):
    expected = _model().means.numpy()
    assert decoded["positions"] == pytest.approx(expected, abs=0.5 / 4096)


def test_a_far_point_lowers_the_precision_instead_of_wrapping(tmp_path):
    model = _model()
    model.means[2] = torch.tensor([3000.0, -5000.0, 1.0])
    path = tmp_path / "result.spz"

    write_spz(model, path)
    decoded = _decode(path)

    fractional_bits = decoded["header"][4]
    assert fractional_bits == 10  # 5000 * 2**10 fits in 23 bits; 5000 * 2**11 doesn't.
    assert decoded["positions"] == pytest.approx(model.means.numpy(), abs=0.5 / (1 << fractional_bits))


def test_opacities_are_stored_after_the_sigmoid(decoded):
    assert decoded["alphas"] == pytest.approx(1 / (1 + np.exp(-np.array([0.0, 3.0, -3.0]))), abs=0.5 / 255)


def test_colors_round_trip_and_clamp(decoded):
    assert decoded["colors"][0] == pytest.approx([0.0, 1.0, -1.0], abs=0.5 / 255 / 0.15)
    assert decoded["colors"][1] == pytest.approx([127.5 / 255 / 0.15, -127.5 / 255 / 0.15, 0.5], abs=0.5 / 255 / 0.15)


def test_scales_round_trip_and_clamp(decoded):
    assert decoded["scales"][:2] == pytest.approx(np.array([[-3.0, -4.0, -5.0], [0.0, 0.5, -1.0]]), abs=0.5 / 16)
    assert decoded["scales"][2] == pytest.approx([-10.0, 255 / 16 - 10, -2.0], abs=0.5 / 16)


def test_rotations_round_trip_up_to_sign(decoded):
    quats = _model().quats.numpy()
    expected = quats[:, [1, 2, 3, 0]] / np.linalg.norm(quats, axis=1, keepdims=True)
    for got, want in zip(decoded["quats_xyzw"], expected, strict=True):
        assert abs(np.dot(got, want)) == pytest.approx(1, abs=1e-5)
        assert np.abs(got - want).max() < 2e-3 or np.abs(got + want).max() < 2e-3


def test_sh_uses_coarser_buckets_above_degree_1(decoded):
    sh = decoded["sh"]
    # 0.3 * 128 = 38.4 rounds to 38, 166 on the byte scale, whose nearest multiple of 8 is 168.
    assert sh[1, 0] == pytest.approx((168 - 128) / 128)
    # Coefficient 5 (degree 2), blue: -0.45 * 128 = -57.6 rounds to -58, byte 70, nearest multiple of 16 is 64.
    assert sh[1, 5 * 3 + 2] == pytest.approx((64 - 128) / 128)
    assert sh[2, 14 * 3 + 1] == pytest.approx(127 / 128)
    assert sh[0] == pytest.approx(np.zeros(SH_COUNT))
