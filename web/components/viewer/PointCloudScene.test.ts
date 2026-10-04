import { BufferGeometry, Float32BufferAttribute, Uint8BufferAttribute } from "three";
import { describe, expect, it } from "vitest";

import type { CropBox } from "@/lib/types";
import { croppedGeometry } from "./PointCloudScene";

const UNIT_BOX: CropBox = { center: [0, 0, 0], size: [2, 2, 2], quaternion: [0, 0, 0, 1] };

describe("croppedGeometry", () => {
  it("keeps only the points inside the box, with their colors", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 5, 0, 0, 0.5, -0.5, 1], 3));
    geometry.setAttribute("color", new Float32BufferAttribute([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], 3));

    const cropped = croppedGeometry(geometry, UNIT_BOX);

    expect(Array.from(cropped.getAttribute("position").array)).toEqual([0, 0, 0, 0.5, -0.5, 1]);
    expect(Array.from(cropped.getAttribute("color").array)).toEqual(
      [0.1, 0.2, 0.3, 0.7, 0.8, 0.9].map(value => Math.fround(value)),
    );
  });

  it("scales a normalized attribute to its real range", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute("color", new Uint8BufferAttribute([255, 0, 51], 3, true));

    const color = croppedGeometry(geometry, UNIT_BOX).getAttribute("color");

    expect(color.normalized).toBe(false);
    expect(Array.from(color.array)).toEqual([1, 0, Math.fround(0.2)]);
  });

  it("keeps nothing when every point is outside", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([9, 9, 9], 3));

    expect(croppedGeometry(geometry, UNIT_BOX).getAttribute("position").count).toBe(0);
  });
});
