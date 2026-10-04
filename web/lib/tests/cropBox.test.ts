import { describe, expect, it } from "vitest";

import { insideCropBox } from "@/lib/cropBox";
import type { CropBox } from "@/lib/types";

describe("insideCropBox", () => {
  it("counts points on the surface as inside", () => {
    const box: CropBox = { center: [1, 2, 3], size: [2, 4, 6], quaternion: [0, 0, 0, 1] };
    const points = [
      [1, 2, 3],
      [2, 4, 6],
      [2.01, 2, 3],
      [0, 0, 0],
      [1, 2, -0.01],
    ];

    expect(points.map(([x, y, z]) => insideCropBox(x, y, z, box))).toEqual([true, true, false, true, false]);
  });

  it("measures each axis along the box's own rotated axes", () => {
    // A quarter turn about z lines the box's long x axis up with world y.
    const half = Math.PI / 4;
    const box: CropBox = { center: [0, 0, 0], size: [4, 1, 1], quaternion: [0, 0, Math.sin(half), Math.cos(half)] };

    expect(insideCropBox(0, 1.9, 0, box)).toBe(true);
    expect(insideCropBox(1.9, 0, 0, box)).toBe(false);
    expect(insideCropBox(0, -1.9, 0.4, box)).toBe(true);
  });

  it("normalizes a quaternion that isn't unit length", () => {
    const box: CropBox = { center: [0, 0, 0], size: [2, 2, 2], quaternion: [0, 0, 0, 5] };

    expect(insideCropBox(0.9, 0, 0, box)).toBe(true);
    expect(insideCropBox(1.1, 0, 0, box)).toBe(false);
  });
});
