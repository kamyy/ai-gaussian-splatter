/**
 * The maths for the view used when no photo is selected, for the initial crop box, and for the front, side and top views.
 *
 * Pure functions, with no React. They frame the object from the photos' own camera positions when those are known, or
 * from the point cloud's bounding box otherwise, trimming stray points so they don't pull the view away. They also fit
 * the crop box the visitor starts from, and aim the front, side and top views the viewer's buttons animate to.
 */

import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from "three";

import type { CameraPose, CropBox } from "@/lib/types";

// The fraction of points trimmed from each end of every axis before framing on a bounding box. Splats and COLMAP
// points both scatter a few strays far from the object, and an untrimmed box grows to take in every one of them.
const BOUNDING_BOX_TRIM = 0.05;
// The fraction of points, nearest the object's center, that the first crop box is fitted to. The rest of a point cloud
// is mostly the table and room around the object, which a box fitted to every point would take in.
const CROP_NEAREST = 0.5;
// Each axis view's direction from the object to the camera, along the object's upright axes (uprightRotation). The
// top view leans a hair toward the front. Straight down the up axis, the camera's up would be undefined. The lean
// puts the front at the bottom of the screen.
const AXIS_VIEWS: Record<AxisView, Vector3> = {
  front: new Vector3(0, 0, 1),
  side: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 1e-3).normalize(),
};

export interface Framing {
  target: Vector3;
  position: Vector3;
  up: Vector3;
}

/** Which side of the object an axis view looks from. */
export type AxisView = "front" | "side" | "top";

/**
 * The bounding box of interleaved x, y, z positions after dropping BOUNDING_BOX_TRIM of the values from each end of
 * every axis.
 * It is how the viewer frames a capture whose camera poses it doesn't have. An empty box when there are no positions.
 */
export function trimmedBoundingBox(positions: ArrayLike<number>): Box3 {
  const count = Math.floor(positions.length / 3);
  if (count === 0) {
    return new Box3();
  }

  const box = new Box3();
  const values = new Float32Array(count);
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < count; i++) {
      values[i] = positions[i * 3 + axis];
    }

    values.sort();
    box.min.setComponent(axis, values[Math.floor(count * BOUNDING_BOX_TRIM)]);
    box.max.setComponent(axis, values[Math.ceil(count * (1 - BOUNDING_BOX_TRIM)) - 1]);
  }

  return box;
}

/**
 * The camera used when no photo is selected: aimed at the point the photos' optical axes pass closest to, from the
 * first pose in the list, with the photos' average up direction. A splat page opens on a photo's own pose instead, and
 * keeps this as the point those poses orbit and the up direction they level back to.
 *
 * The position is on the ring of photo positions rather than behind it. Nothing trains the space outside that ring,
 * so a view from there looks through whatever floats around the capture before it reaches the object. COLMAP's world
 * axes are arbitrary per capture, which is why up comes from the photos instead of Three.js's default +Y.
 *
 * The capture's bounding box is a worse guide, because a few stray points far from the object inflate it until the
 * object is a speck. null when the axes don't pin down a point, such as a single photo or photos all taken in one
 * direction.
 */
export function framingFromCameras(cameras: Omit<CameraPose, "photoId">[]): Framing | null {
  if (cameras.length < 2) {
    return null;
  }

  // Least-squares nearest point to a set of lines: minimize Σ‖(I − ddᵀ)(p − c)‖², which gives
  // [Σ(I − ddᵀ)] p = Σ(I − ddᵀ) c. d is each camera's viewing direction in world space, the third row of its
  // world-to-camera rotation.
  const a = new Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
  const b = new Vector3();
  for (const { center, rotation } of cameras) {
    const d = new Vector3(...rotation[2]).normalize();
    const projector = new Matrix3().set(
      1 - d.x * d.x,
      -d.x * d.y,
      -d.x * d.z,
      -d.y * d.x,
      1 - d.y * d.y,
      -d.y * d.z,
      -d.z * d.x,
      -d.z * d.y,
      1 - d.z * d.z,
    );
    projector.elements.forEach((value, i) => {
      a.elements[i] += value;
    });
    b.add(new Vector3(...center).applyMatrix3(projector));
  }

  if (Math.abs(a.determinant()) < 1e-9) {
    return null;
  }

  const target = b.applyMatrix3(a.clone().invert());
  const position = new Vector3(...cameras[0].center);

  // COLMAP's camera y axis points down the image, so each photo's up is the negated second row of its rotation.
  const up = new Vector3();
  for (const { rotation } of cameras) {
    up.sub(new Vector3(...rotation[1]).normalize());
  }

  if (up.lengthSq() < 1e-12) {
    up.set(0, 1, 0);
  }

  return { target, position, up: up.normalize() };
}

/**
 * The rotation from COLMAP's axes to the object's own upright ones: y is the photos' up, z points toward the first
 * photo along the ground, and x is to the object's side. Without a framing it is no rotation, so the axes are COLMAP's.
 */
export function uprightRotation(framing: Framing | null): Quaternion {
  const rotation = new Quaternion();
  if (!framing) {
    return rotation;
  }

  const y = framing.up.clone().normalize();

  // The direction toward the first photo, with its vertical part removed so it lies in the ground plane.
  const z = framing.position.clone().sub(framing.target);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() > 1e-12) {
    z.normalize();
    rotation.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3().crossVectors(y, z), y, z));
  } else {
    rotation.setFromUnitVectors(new Vector3(0, 1, 0), y);
  }

  return rotation;
}

/**
 * Which way a camera looking at box from one side faces. Front looks along the box's z axis, side along its x axis,
 * and top down its y axis. direction is the unit vector from target toward the camera, which the caller places at
 * whatever distance its camera needs. up is always the box's y axis, so orbiting away from any of the three turns about
 * the object's own up. extent is the box's longest side, which the caller fits to the view.
 */
export function axisViewPose(
  box: CropBox,
  view: AxisView,
): { direction: Vector3; target: Vector3; up: Vector3; extent: number } {
  const rotation = new Quaternion(...box.quaternion);

  return {
    direction: AXIS_VIEWS[view].clone().applyQuaternion(rotation),
    target: new Vector3(...box.center),
    up: new Vector3(0, 1, 0).applyQuaternion(rotation),
    extent: Math.max(...box.size),
  };
}

// The middle value of values, which it sorts in place.
function median(values: Float32Array): number {
  values.sort();

  return values[Math.floor(values.length / 2)];
}

// The CROP_NEAREST of interleaved x, y, z positions nearest center, also interleaved. Every point as far as the
// cutoff distance is kept, so points at equal distances are kept or dropped together.
function nearestPositions(positions: Float32Array, center: Vector3): Float32Array {
  const count = positions.length / 3;
  const distances = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    distances[i] = Math.hypot(
      positions[i * 3] - center.x,
      positions[i * 3 + 1] - center.y,
      positions[i * 3 + 2] - center.z,
    );
  }

  const sorted = distances.slice().sort();
  const cutoff = sorted[Math.max(0, Math.ceil(count * CROP_NEAREST) - 1)];
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    if (distances[i] <= cutoff) {
      kept.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
  }

  return Float32Array.from(kept);
}

/**
 * The crop box a capture starts with, fitted the way trimmedBoundingBox fits a box to the CROP_NEAREST of the
 * positions nearest the object. With a framing, the object's center is the point the photos aim at, and the box
 * stands upright in the view it sets up: its y axis is the photos' up and its z axis points toward the first photo.
 * Without one, the center is the positions' median on each axis, and the box's axes are COLMAP's, which are arbitrary
 * per capture and so look tilted to the visitor. null when there are no positions.
 */
export function fittedCropBox(positions: ArrayLike<number>, framing: Framing | null): CropBox | null {
  const rotation = uprightRotation(framing);

  // Fit an axis-aligned box in the box's own frame, then carry its center back out to the world.
  const inverse = rotation.clone().invert();
  const local = new Float32Array(Math.floor(positions.length / 3) * 3);
  const point = new Vector3();
  for (let i = 0; i < local.length; i += 3) {
    point
      .set(positions[i], positions[i + 1], positions[i + 2])
      .applyQuaternion(inverse)
      .toArray(local, i);
  }

  if (local.length === 0) {
    return null;
  }

  let center: Vector3;
  if (framing) {
    center = framing.target.clone().applyQuaternion(inverse);
  } else {
    const axis = (offset: number) => median(local.filter((_value, i) => i % 3 === offset));
    center = new Vector3(axis(0), axis(1), axis(2));
  }

  const box = trimmedBoundingBox(nearestPositions(local, center));
  if (box.isEmpty()) {
    return null;
  }

  return {
    center: box.getCenter(new Vector3()).applyQuaternion(rotation).toArray(),
    size: box.getSize(new Vector3()).toArray(),
    quaternion: rotation.toArray(),
  };
}
