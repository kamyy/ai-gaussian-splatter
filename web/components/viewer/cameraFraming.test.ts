import { describe, expect, it } from "vitest";

import type { CameraPose } from "@/lib/types";
import { framingFromCameras } from "./cameraFraming";

// A camera at `center` looking at `target`. Only the rotation's third row, the viewing direction, matters here.
function lookingAt(center: [number, number, number], target: [number, number, number]): CameraPose {
  const d = center.map((v, i) => target[i] - v);
  const length = Math.hypot(...d);
  const forward = d.map(v => v / length) as [number, number, number];
  return { photoId: "p", center, rotation: [[1, 0, 0], [0, 1, 0], forward], width: 4, height: 3, fx: 4, fy: 4 };
}

describe("framingFromCameras", () => {
  it("aims at the point every camera is looking at, from behind the first camera", () => {
    const target: [number, number, number] = [1, 2, 3];
    const cameras = [lookingAt([11, 2, 3], target), lookingAt([1, 12, 3], target), lookingAt([1, 2, 13], target)];

    const framing = framingFromCameras(cameras);

    expect(framing?.target.toArray().map(v => Number(v.toFixed(6)))).toEqual(target);
    expect(framing?.position.toArray().map(v => Number(v.toFixed(6)))).toEqual([19, 2, 3]);
  });

  it("gives up when the cameras don't pin down a point", () => {
    expect(framingFromCameras([lookingAt([0, 0, 5], [0, 0, 0])])).toBeNull();
    expect(framingFromCameras([lookingAt([0, 0, 5], [0, 0, 0]), lookingAt([0, 0, 9], [0, 0, 0])])).toBeNull();
  });
});
