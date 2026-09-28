import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { CameraPose } from "@/lib/types";
import { fittedCropBox, framingFromCameras, trimmedBox } from "./cameraFraming";

// A camera at `center` looking at `target`. Only the rotation's third row, the viewing direction, matters here.
function lookingAt(center: [number, number, number], target: [number, number, number]): CameraPose {
  const d = center.map((v, i) => target[i] - v);
  const length = Math.hypot(...d);
  const forward = d.map(v => v / length) as [number, number, number];
  return { photoId: "p", center, rotation: [[1, 0, 0], [0, 1, 0], forward], width: 4, height: 3, fx: 4, fy: 4 };
}

describe("framingFromCameras", () => {
  it("aims at the point every camera is looking at, from the first camera", () => {
    const target: [number, number, number] = [1, 2, 3];
    const cameras = [lookingAt([11, 2, 3], target), lookingAt([1, 12, 3], target), lookingAt([1, 2, 13], target)];

    const framing = framingFromCameras(cameras);

    expect(framing?.target.toArray().map(v => Number(v.toFixed(6)))).toEqual(target);
    expect(framing?.position.toArray().map(v => Number(v.toFixed(6)))).toEqual([11, 2, 3]);
  });

  it("takes up from the photos, where COLMAP's image y axis points down", () => {
    const cameras = [lookingAt([11, 2, 3], [1, 2, 3]), lookingAt([1, 2, 13], [1, 2, 3])].map(camera => ({
      ...camera,
      rotation: [camera.rotation[0], [0, 0, -1], camera.rotation[2]] as [number, number, number][],
    }));

    expect(framingFromCameras(cameras)?.up.toArray()).toEqual([0, 0, 1]);
  });

  it("gives up when the cameras don't pin down a point", () => {
    expect(framingFromCameras([lookingAt([0, 0, 5], [0, 0, 0])])).toBeNull();
    expect(framingFromCameras([lookingAt([0, 0, 5], [0, 0, 0]), lookingAt([0, 0, 9], [0, 0, 0])])).toBeNull();
  });
});

describe("trimmedBox", () => {
  it("ignores a stray point far from the rest", () => {
    const positions = Array.from({ length: 100 }, (_, i) => [i % 10, Math.floor(i / 10), 0]).flat();
    positions.push(1000, 1000, 1000);

    const box = trimmedBox(positions);

    expect(box.max.toArray().every(v => v < 10)).toBe(true);
  });

  it("is empty without positions", () => {
    expect(trimmedBox([]).isEmpty()).toBe(true);
  });
});

describe("fittedCropBox", () => {
  // The corners of a 2 x 4 x 6 box centered on (1, 2, 3), tilted 30° about x, so its axes are none of the world's.
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 6);
  const center = new Vector3(1, 2, 3);
  const corners = [-1, 1].flatMap(x =>
    [-2, 2].flatMap(y => [-3, 3].flatMap(z => new Vector3(x, y, z).applyQuaternion(tilt).add(center).toArray())),
  );
  const round = (values: number[]) => values.map(v => Number(v.toFixed(6)) + 0);

  it("stands the box on the photos' up and faces it toward the first photo", () => {
    const up = new Vector3(0, 1, 0).applyQuaternion(tilt);
    const towardPhoto = new Vector3(0, 0, 1).applyQuaternion(tilt);
    // The photo sits a little above the box, which the fit ignores.
    const position = center.clone().addScaledVector(towardPhoto, 10).addScaledVector(up, 3);

    const box = fittedCropBox(corners, { target: center, position, up });

    expect(round(box?.center ?? [])).toEqual([1, 2, 3]);
    expect(round(box?.size ?? [])).toEqual([2, 4, 6]);
    expect(round(box?.quaternion ?? [])).toEqual(round(tilt.toArray()));
  });

  it("keeps COLMAP's axes without a framing", () => {
    expect(fittedCropBox(corners, null)?.quaternion).toEqual([0, 0, 0, 1]);
  });

  it("is null without positions", () => {
    expect(fittedCropBox([], null)).toBeNull();
  });
});
