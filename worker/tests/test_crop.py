import math

import numpy as np

from pipeline.config import CropBox
from pipeline.crop import inside_crop_box


def test_axis_aligned_box_keeps_points_inside_and_on_a_face():
    box = CropBox(center=(1, 2, 3), size=(2, 4, 6), quaternion=(0, 0, 0, 1))
    points = np.array([[1, 2, 3], [2, 2, 3], [2.01, 2, 3], [1, 4, 6], [1, 4, 6.01]])

    assert inside_crop_box(points, box).tolist() == [True, True, False, True, False]


def test_rotated_box_tests_along_its_own_axes():
    # 45 degrees about z: the box's local x axis points along world (1, 1, 0).
    half = math.pi / 8
    box = CropBox(center=(0, 0, 0), size=(4, 1, 1), quaternion=(0, 0, math.sin(half), math.cos(half)))
    diagonal = 1.9 / math.sqrt(2)
    points = np.array([[diagonal, diagonal, 0], [1.9, 0, 0], [-diagonal, -diagonal, 0.4]])

    assert inside_crop_box(points, box).tolist() == [True, False, True]


def test_unnormalized_quaternion_is_treated_as_its_rotation():
    box = CropBox(center=(0, 0, 0), size=(2, 2, 2), quaternion=(0, 0, 0, 5))
    points = np.array([[0.9, 0.9, 0.9], [1.1, 0, 0]])

    assert inside_crop_box(points, box).tolist() == [True, False]
