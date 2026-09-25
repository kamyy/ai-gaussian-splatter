"use client";

import { Edges, PivotControls } from "@react-three/drei";
import { useMemo } from "react";
import { type Box3, Matrix4, Quaternion, Vector3 } from "three";

import type { CropBox } from "@/lib/types";

// A mid blue between the info token's light and dark values, so it reads against both themes' viewer backgrounds and
// stays distinct from the camera frustums' terracotta. A three.js material can't take a CSS variable.
const COLOR = "#5b7bd6";
// The gizmo's on-screen size in pixels. COLMAP's scale is arbitrary per capture, so a size in world units would be
// invisible in one reconstruction and swamp another.
const GIZMO_PIXELS = 90;

/** The crop box a capture starts with: the given bounds, unrotated. */
export function cropBoxFromBounds(bounds: Box3): CropBox {
  return {
    center: bounds.getCenter(new Vector3()).toArray(),
    size: bounds.getSize(new Vector3()).toArray(),
    quaternion: [0, 0, 0, 1],
  };
}

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
 * CropBox.
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
      fixed
      scale={GIZMO_PIXELS}
      depthTest={false}
    >
      <mesh>
        <boxGeometry />
        <meshBasicMaterial color={COLOR} transparent opacity={0.08} depthWrite={false} />
        <Edges color={COLOR} />
      </mesh>
    </PivotControls>
  );
}
