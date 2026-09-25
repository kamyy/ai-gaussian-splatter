import { Matrix3, Vector3 } from "three";

import type { CameraPose } from "@/lib/types";

// How far behind the first photo's own position the viewer starts, so that camera's neighbors are in view too.
const PULL_BACK = 1.8;

/**
 * Where to put the viewer's camera so the object is framed the way it was photographed: aimed at the point the
 * photos' optical axes pass closest to, from just behind the first photo's position.
 *
 * The capture's bounding box is a worse guide, because a few stray points far from the object inflate it until the
 * object is a speck. null when the axes don't pin down a point, such as a single photo or photos all taken in one
 * direction.
 */
export function framingFromCameras(cameras: CameraPose[]): { target: Vector3; position: Vector3 } | null {
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
  const first = new Vector3(...cameras[0].center);
  const position = target.clone().add(first.sub(target).multiplyScalar(PULL_BACK));
  return { target, position };
}
