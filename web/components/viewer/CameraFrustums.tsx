"use client";

import { useMemo } from "react";

import type { CameraPose } from "@/lib/types";

// A frustum's depth as a fraction of the cameras' median distance from their own centroid. COLMAP's scale is arbitrary
// per capture, so any fixed size would be invisible in one reconstruction and swamp another.
const FRUSTUM_DEPTH_FRACTION = 0.08;
// The light theme's accent, a mid terracotta that reads against both themes' viewer backgrounds. A three.js material
// can't take a CSS variable.
const COLOR = "#d4764a";

type Vec3 = [number, number, number];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// Line-segment vertex pairs for every camera: four edges from the camera center to its far rectangle's corners, then
// that rectangle's four sides.
function frustumSegments(cameras: CameraPose[]): Float32Array {
  const centroid = cameras
    .reduce<Vec3>((sum, { center }) => [sum[0] + center[0], sum[1] + center[1], sum[2] + center[2]], [0, 0, 0])
    .map(v => v / cameras.length);
  const depth =
    FRUSTUM_DEPTH_FRACTION * median(cameras.map(({ center }) => Math.hypot(...center.map((v, i) => v - centroid[i]))));

  const out: number[] = [];
  for (const { center, rotation, width, height, fx, fy } of cameras) {
    // COLMAP's rotation is world-to-camera, so a camera-space point p lands at center + Rᵀp, which is the sum of the
    // rows of R weighted by p's components.
    function toWorld(x: number, y: number, z: number): Vec3 {
      const [r0, r1, r2] = rotation;
      return [0, 1, 2].map(i => center[i] + x * r0[i] + y * r1[i] + z * r2[i]) as Vec3;
    }
    // The far rectangle spans the photo's own field of view: half the image width over the focal length, both in
    // pixels, is the tangent of the half-angle.
    const halfWidth = (depth * width) / (2 * fx);
    const halfHeight = (depth * height) / (2 * fy);
    const corners = [
      toWorld(-halfWidth, -halfHeight, depth),
      toWorld(halfWidth, -halfHeight, depth),
      toWorld(halfWidth, halfHeight, depth),
      toWorld(-halfWidth, halfHeight, depth),
    ];
    corners.forEach((corner, i) => {
      out.push(...center, ...corner);
      out.push(...corner, ...corners[(i + 1) % corners.length]);
    });
  }
  return new Float32Array(out);
}

export function CameraFrustums({ cameras }: { cameras: CameraPose[] }) {
  const positions = useMemo(() => frustumSegments(cameras), [cameras]);

  if (cameras.length === 0) {
    return null;
  }
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={COLOR} />
    </lineSegments>
  );
}
