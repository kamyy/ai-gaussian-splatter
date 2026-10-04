/**
 * The draggable crop box in the 3D view.
 *
 * The owner drags its handles to fit the box around the object in a finished splat's point cloud, so a crop can leave
 * out the room around it. The box is sent when the owner applies the crop.
 */

"use client";

import { PivotControls } from "@react-three/drei";
import { useMemo } from "react";
import { DoubleSide, Matrix4, Quaternion, Vector3 } from "three";

import type { CropBox } from "@/lib/types";

// The x, y and z handles' colors, PivotControls' own defaults. Each pair of opposite faces takes its axis's color, so
// a face shows which handle moves it. A three.js material can't take a CSS variable.
const AXIS_COLORS: [string, string, string] = ["#ff2060", "#20df80", "#2080ff"];
// In BoxGeometry's order of faces, which is how each material attaches to its face.
const FACES = ["+x", "-x", "+y", "-y", "+z", "-z"].map((name, face) => ({
  name,
  color: AXIS_COLORS[Math.floor(face / 2)],
}));
// Faint enough that the points inside the box stay visible through two faces.
const FACE_OPACITY = 0.15;
// The gizmo's on-screen size in pixels. A point cloud's scale is COLMAP's, which is arbitrary per capture, so a size in
// world units would be invisible in one reconstruction and swamp another.
const GIZMO_PIXELS = 70;
// The arrows' line width in pixels, half PivotControls' default. With a fixed-size gizmo it also sets how wide each
// arrowhead is.
const GIZMO_LINE_PIXELS = 2;

function toMatrix({ center, size, quaternion }: CropBox): Matrix4 {
  return new Matrix4().compose(new Vector3(...center), new Quaternion(...quaternion), new Vector3(...size));
}

function fromMatrix(matrix: Matrix4): CropBox {
  const center = new Vector3();
  const quaternion = new Quaternion();
  const size = new Vector3();
  matrix.decompose(center, quaternion, size);

  return { center: center.toArray(), size: size.toArray(), quaternion: quaternion.toArray() };
}

/**
 * A unit box transformed by the crop box's matrix, so the matrix's scale is the box's size. PivotControls' spheres
 * scale it along the box's own axes, which keeps the matrix a plain translate-rotate-scale that decomposes back into a
 * CropBox. Its rotation handles are off, because the box keeps the upright orientation it was fitted with.
 */
export function CropBoxGizmo({ box, onChange }: { box: CropBox; onChange: (box: CropBox) => void }) {
  // PivotControls reads this matrix on every frame. A drag mutates it in place, so the box follows the pointer without
  // a React render, and the page only hears the result once the drag ends.
  const matrix = useMemo(() => toMatrix(box), [box]);

  return (
    <PivotControls
      matrix={matrix}
      autoTransform={false}
      onDrag={local => matrix.copy(local)}
      onDragEnd={() => onChange(fromMatrix(matrix))}
      disableRotations
      fixed
      scale={GIZMO_PIXELS}
      lineWidth={GIZMO_LINE_PIXELS}
      axisColors={AXIS_COLORS}
      depthTest={false}
    >
      {/* DoubleSide draws the far faces too, seen through the near ones, so the box reads as a solid. */}
      <mesh>
        <boxGeometry />
        {FACES.map(({ name, color }, face) => (
          <meshBasicMaterial
            key={name}
            attach={`material-${face}`}
            color={color}
            transparent
            opacity={FACE_OPACITY}
            side={DoubleSide}
            depthWrite={false}
          />
        ))}
      </mesh>
    </PivotControls>
  );
}
