import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { CameraPose } from "@/lib/types";
import { easeInOutCubic, fittedFov, interpolatePose, orbitTargetOf, photoViewPose } from "./cameraFlight";

// COLMAP axes: x right, y down the image, z forward. This camera sits at (0, 0, 10) looking toward -z with the image's
// down along -y, so its world up is +y.
const camera: Omit<CameraPose, "photoId"> = {
  center: [0, 0, 10],
  rotation: [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ],
  width: 4,
  height: 3,
  fx: 4,
  fy: 4,
};

function rounded(v: Vector3) {
  return v.toArray().map(x => Number(x.toFixed(6)) + 0);
}

describe("photoViewPose", () => {
  it("stands at the photo and looks along its optical axis", () => {
    const pose = photoViewPose(camera, new Vector3(0, 0, 0));

    expect(rounded(pose.position)).toEqual([0, 0, 10]);
    expect(rounded(new Vector3(0, 0, -1).applyQuaternion(pose.quaternion))).toEqual([0, 0, -1]);
    expect(rounded(new Vector3(0, 1, 0).applyQuaternion(pose.quaternion))).toEqual([0, 1, 0]);
    expect(pose.distance).toBeCloseTo(10);
  });

  it("takes on the photo's roll", () => {
    // The same camera turned 90° about its viewing axis, so the image's down points along world +x.
    const rolled = {
      ...camera,
      rotation: [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, -1],
      ] as [number, number, number][],
    };
    const pose = photoViewPose(rolled, new Vector3(0, 0, 0));

    expect(rounded(new Vector3(0, 1, 0).applyQuaternion(pose.quaternion))).toEqual([-1, 0, 0]);
    expect(rounded(new Vector3(0, 0, -1).applyQuaternion(pose.quaternion))).toEqual([0, 0, -1]);
  });

  it("orbits where the optical axis passes the target", () => {
    const pose = photoViewPose(camera, new Vector3(3, 0, 4));

    expect(pose.distance).toBeCloseTo(6);
    expect(rounded(orbitTargetOf(pose))).toEqual([0, 0, 4]);
  });

  it("keeps a short orbit distance when the target is behind the photo", () => {
    const pose = photoViewPose(camera, new Vector3(0, 0, 20));

    expect(pose.distance).toBeCloseTo(1);
  });
});

describe("fittedFov", () => {
  // A 4:3 photo whose frame spans 90° across: half its width over the focal length is tan 45°.
  const photo = { ...camera, width: 4, height: 3, fx: 2, fy: 2 };

  it("matches the photo's vertical field of view in a view wider than the photo", () => {
    expect(fittedFov(photo, 2)).toBeCloseTo((2 * Math.atan(0.75) * 180) / Math.PI);
  });

  it("widens until the photo's full width fits in a view narrower than the photo", () => {
    // A square view needs the same 90° vertically to show 90° across.
    expect(fittedFov(photo, 1)).toBeCloseTo(90);
  });
});

describe("interpolatePose", () => {
  it("runs from one pose to the other", () => {
    const from = { position: new Vector3(0, 0, 0), quaternion: new Quaternion(), distance: 2 };
    const to = {
      position: new Vector3(4, 0, 0),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
      distance: 6,
    };

    const halfway = interpolatePose(from, to, 0.5);

    expect(rounded(halfway.position)).toEqual([2, 0, 0]);
    expect(halfway.quaternion.angleTo(from.quaternion)).toBeCloseTo(Math.PI / 4);
    expect(halfway.distance).toBe(4);
    expect(interpolatePose(from, to, 1).quaternion.angleTo(to.quaternion)).toBeCloseTo(0);
  });
});

describe("easeInOutCubic", () => {
  it("starts at rest, passes the midpoint halfway, and ends at rest", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
  });
});
