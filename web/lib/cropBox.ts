/**
 * Tests whether a point falls inside a crop box.
 *
 * A crop box (web/lib/types.ts's CropBox) can be rotated, so the test can't just compare coordinates against its
 * corners. The server uses it to decide which Gaussians a crop keeps, and the 3D viewer uses the same test to hide the
 * point cloud's points outside an applied crop, so the two always agree on what the box contains.
 */

import type { CropBox } from "./types";

/** True when the point is inside the box or on its surface. */
export function insideCropBox(x: number, y: number, z: number, box: CropBox): boolean {
  // Rotating the offset by the box's inverse rotation expresses it along the box's own axes.
  const [qx, qy, qz, qw] = box.quaternion;
  const norm = Math.hypot(qx, qy, qz, qw);
  const ux = -qx / norm;
  const uy = -qy / norm;
  const uz = -qz / norm;
  const w = qw / norm;

  const vx = x - box.center[0];
  const vy = y - box.center[1];
  const vz = z - box.center[2];

  // v' = v + 2w(u × v) + 2u × (u × v)
  const tx = 2 * (uy * vz - uz * vy);
  const ty = 2 * (uz * vx - ux * vz);
  const tz = 2 * (ux * vy - uy * vx);
  const lx = vx + w * tx + (uy * tz - uz * ty);
  const ly = vy + w * ty + (uz * tx - ux * tz);
  const lz = vz + w * tz + (ux * ty - uy * tx);

  return Math.abs(lx) <= box.size[0] / 2 && Math.abs(ly) <= box.size[1] / 2 && Math.abs(lz) <= box.size[2] / 2;
}
