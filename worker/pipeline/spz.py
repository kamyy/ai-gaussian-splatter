"""Writes a trained splat as .spz, Niantic's compressed Gaussian splat format, for the web viewer to load.

This writes version 3: a 16-byte header and six attribute arrays, gzipped as one stream. Every .spz reader, including
the viewer's, accepts it. The quantization mirrors packGaussians() in Niantic's reference encoder
(https://github.com/nianticlabs/spz, src/cc/load-spz.cc), which has no Python bindings to call instead.

Coordinates are written as-is, with no axis conversion, so the viewer shows the splat in the same frame as COLMAP's
cameras and point cloud.
"""

import gzip
import struct
from pathlib import Path

import numpy as np

from .train import SH_DEGREE, GaussianModel

_MAGIC = 0x5053474E  # "NGSP" read as a little-endian u32
_VERSION = 3
# Positions are 24-bit fixed point. 12 fractional bits (the reference encoder's) resolve about 0.25 mm at metre scale
# but only reach 2048 units from the origin, so a splat reaching further trades precision for range.
_MAX_FRACTIONAL_BITS = 12
_MAX_FIXED = (1 << 23) - 1
_COLOR_SCALE = 0.15
# The reference encoder's default SH precision: 5 bits for the 9 degree-1 values, 4 bits for the rest. Each value keeps
# 8 bits, but only a multiple of the bucket size, which is what lets gzip shrink them.
_SH1_BUCKET = 1 << (8 - 5)
_SH_REST_BUCKET = 1 << (8 - 4)


def write_spz(model: GaussianModel, path: Path) -> None:
    means = model.means.detach().cpu().numpy().astype(np.float64)
    scales = model.scales.detach().cpu().numpy().astype(np.float64)  # log-space
    quats = model.quats.detach().cpu().numpy().astype(np.float64)  # w, x, y, z
    opacities = model.opacities.detach().cpu().numpy().astype(np.float64)  # logit-space
    sh0 = model.sh0.detach().cpu().numpy().astype(np.float64)[:, 0, :]
    sh_n = model.shN.detach().cpu().numpy().astype(np.float64)
    n = means.shape[0]
    fractional_bits = _fractional_bits_for(means)

    header = struct.pack("<IIIBBBB", _MAGIC, _VERSION, n, SH_DEGREE, fractional_bits, 0, 0)
    body = [
        _pack_positions(means, fractional_bits),
        _to_uint8(1 / (1 + np.exp(-opacities)) * 255),
        _to_uint8(sh0 * (_COLOR_SCALE * 255) + 0.5 * 255),
        _to_uint8((scales + 10) * 16),
        _pack_rotations(quats),
        _pack_sh(sh_n),
    ]
    path.write_bytes(gzip.compress(header + b"".join(array.tobytes() for array in body)))


def _round(x: np.ndarray) -> np.ndarray:
    """Rounds half away from zero, as C++'s std::round does, rather than numpy's round-half-to-even."""
    return np.sign(x) * np.floor(np.abs(x) + 0.5)


def _to_uint8(x: np.ndarray) -> np.ndarray:
    return np.clip(_round(x), 0, 255).astype(np.uint8)


def _fractional_bits_for(means: np.ndarray) -> int:
    """The most fractional bits that still fit the farthest coordinate in 24 bits. A coordinate that doesn't fit wraps
    around to the opposite side of the scene rather than saturating.
    """
    farthest = float(np.abs(means).max(initial=0))
    bits = _MAX_FRACTIONAL_BITS
    while bits > 0 and _round(np.array(farthest * (1 << bits))) > _MAX_FIXED:
        bits -= 1
    return bits


def _pack_positions(means: np.ndarray, fractional_bits: int) -> np.ndarray:
    """Each coordinate as a 24-bit signed integer, least significant byte first. Clipped to the 24-bit range, which only
    bites past 8 million units from the origin, where no fractional bits are left to give up.
    """
    fixed = np.clip(_round(means * (1 << fractional_bits)), -_MAX_FIXED, _MAX_FIXED).astype("<i4")
    return fixed.view(np.uint8).reshape(-1, 3, 4)[:, :, :3]


def _pack_rotations(quats_wxyz: np.ndarray) -> np.ndarray:
    """Each quaternion in 4 bytes as its "smallest three" components.

    q and -q are the same rotation, and a unit quaternion's largest component can be rebuilt from the other three. So
    the top 2 bits hold which component is largest, and each of the other three gets 10 bits: a sign relative to the
    largest one's, then a 9-bit magnitude scaled from [0, sqrt(1/2)], the most a non-largest component can be.
    """
    q = quats_wxyz[:, [1, 2, 3, 0]]  # .spz orders the components x, y, z, w.
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    largest = np.argmax(np.abs(q), axis=1)
    negate = q[np.arange(len(q)), largest] < 0

    comp = largest.astype(np.uint32)
    for i in range(4):
        sign = ((q[:, i] < 0) ^ negate).astype(np.uint32)
        magnitude = np.minimum(np.floor(511 * np.abs(q[:, i]) / np.sqrt(0.5) + 0.5), 511).astype(np.uint32)
        comp = np.where(largest == i, comp, (comp << 10) | (sign << 9) | magnitude)
    return comp.astype("<u4").view(np.uint8)


def _pack_sh(sh_n: np.ndarray) -> np.ndarray:
    """The higher-degree SH coefficients as signed bytes offset by 128, each snapped to the centre of its bucket.

    Per Gaussian they run coefficient-major with the color channel inner: the first coefficient's red, green, blue,
    then the next coefficient's.
    """
    values = sh_n.reshape(len(sh_n), -1)
    bucket = np.full(values.shape[1], _SH_REST_BUCKET)
    bucket[:9] = _SH1_BUCKET
    q = _round(values * 128) + 128
    q = np.floor((q + bucket // 2) / bucket) * bucket
    return np.clip(q, 0, 255).astype(np.uint8)
