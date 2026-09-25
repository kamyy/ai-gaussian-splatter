import { Box3, Matrix3, Vector3 } from "three";

import type { CameraPose } from "@/lib/types";

// The fraction of points trimmed from each end of every axis before framing on a bounding box. Splats and COLMAP
// points both scatter a few strays far from the object, and an untrimmed box grows to take in every one of them.
const BOX_TRIM = 0.05;

/**
 * The bounding box of interleaved x, y, z positions after dropping BOX_TRIM of the values from each end of every axis.
 * It is how the viewer frames a capture whose camera poses it doesn't have. An empty box when there are no positions.
 */
export function trimmedBox(positions: ArrayLike<number>): Box3 {
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
    box.min.setComponent(axis, values[Math.floor(count * BOX_TRIM)]);
    box.max.setComponent(axis, values[Math.ceil(count * (1 - BOX_TRIM)) - 1]);
  }
  return box;
}

/**
 * Where to put the viewer's camera so the object is framed the way it was photographed: aimed at the point the
 * photos' optical axes pass closest to, from the first photo's position, with the photos' average up direction.
 *
 * The viewer starts on the ring of photo positions rather than behind it. Nothing trains the space outside that ring,
 * so a view from there looks through whatever floats around the capture before it reaches the object. COLMAP's world
 * axes are arbitrary per capture, which is why up comes from the photos instead of Three.js's default +Y.
 *
 * The capture's bounding box is a worse guide, because a few stray points far from the object inflate it until the
 * object is a speck. null when the axes don't pin down a point, such as a single photo or photos all taken in one
 * direction.
 */
export function framingFromCameras(
  cameras: Omit<CameraPose, "photoId">[],
): { target: Vector3; position: Vector3; up: Vector3 } | null {
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
