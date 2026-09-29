"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { DoubleSide, type MeshBasicMaterial, Vector3 } from "three";

import type { CameraPose } from "@/lib/types";

// A frustum's depth as a fraction of the cameras' median distance from their own centroid. COLMAP's scale is arbitrary
// per capture, so any fixed size would be invisible in one reconstruction and swamp another.
const FRUSTUM_DEPTH_FRACTION = 0.08;
// The light theme's accent, a mid terracotta that reads against both themes' viewer backgrounds. A three.js material
// can't take a CSS variable.
const COLOR = "#d4764a";
// How faint the other frustums go while one is selected. WebGL draws every line 1px wide, so fading the rest is what
// makes the selected one stand out.
const UNSELECTED_OPACITY = 0.3;
// The selected frustum's far rectangle is filled at this opacity when seen from a distance.
const FILL_OPACITY = 0.35;
// The fill fades out as the viewer nears the selected camera, measured in frustum depths from its tip: invisible within
// the first, full by the last. A flight parks the viewer on the tip, where the fill would tint most of the view.
const FILL_FADE_DEPTHS: [number, number] = [1, 3];
// Four side triangles from the camera center plus two for the far rectangle.
const TRIANGLES_PER_FRUSTUM = 6;
// How far, in pixels, the pointer may move between press and release for the release to still count as a click
// rather than the end of an orbit drag.
export const CLICK_SLOP_PX = 4;

type Vec3 = [number, number, number];

interface Frustum {
  center: Vec3;
  // The far rectangle, in order around its edge.
  corners: Vec3[];
  // How far the far rectangle sits in front of center.
  depth: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function frustums(cameras: Omit<CameraPose, "photoId">[]): Frustum[] {
  const centroid = cameras
    .reduce<Vec3>((sum, { center }) => [sum[0] + center[0], sum[1] + center[1], sum[2] + center[2]], [0, 0, 0])
    .map(v => v / cameras.length);
  const depth =
    FRUSTUM_DEPTH_FRACTION * median(cameras.map(({ center }) => Math.hypot(...center.map((v, i) => v - centroid[i]))));

  return cameras.map(({ center, rotation, width, height, fx, fy }) => {
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
    return {
      center,
      depth,
      corners: [
        toWorld(-halfWidth, -halfHeight, depth),
        toWorld(halfWidth, -halfHeight, depth),
        toWorld(halfWidth, halfHeight, depth),
        toWorld(-halfWidth, halfHeight, depth),
      ],
    };
  });
}

// Line-segment vertex pairs: four edges from the camera center to its far rectangle's corners, then that rectangle's
// four sides.
function segments(list: Frustum[]): Float32Array {
  const out: number[] = [];
  for (const { center, corners } of list) {
    corners.forEach((corner, i) => {
      out.push(...center, ...corner);
      out.push(...corner, ...corners[(i + 1) % corners.length]);
    });
  }
  return new Float32Array(out);
}

// TRIANGLES_PER_FRUSTUM triangles per frustum, in the frustums' order, so a hit triangle's index says which camera it
// belongs to.
function triangles(list: Frustum[]): Float32Array {
  const out: number[] = [];
  for (const { center, corners } of list) {
    corners.forEach((corner, i) => {
      out.push(...center, ...corner, ...corners[(i + 1) % corners.length]);
    });
    out.push(...corners[0], ...corners[1], ...corners[2]);
    out.push(...corners[0], ...corners[2], ...corners[3]);
  }
  return new Float32Array(out);
}

function farFace({ corners }: Frustum): Float32Array {
  return new Float32Array([...corners[0], ...corners[1], ...corners[2], ...corners[0], ...corners[2], ...corners[3]]);
}

interface CameraFrustumsProps {
  cameras: Omit<CameraPose, "photoId">[];
  // An index into cameras.
  selected: number | null;
  // Offered only when clicking a frustum should select it.
  onSelect?: (index: number) => void;
}

function SelectedFrustum({ frustum }: { frustum: Frustum }) {
  const lines = useMemo(() => segments([frustum]), [frustum]);
  const face = useMemo(() => farFace(frustum), [frustum]);
  const tip = useMemo(() => new Vector3(...frustum.center), [frustum]);
  const fillRef = useRef<MeshBasicMaterial>(null);

  useFrame(({ camera }) => {
    if (!fillRef.current) {
      return;
    }
    const [near, far] = FILL_FADE_DEPTHS;
    const t = (camera.position.distanceTo(tip) / frustum.depth - near) / (far - near);
    fillRef.current.opacity = FILL_OPACITY * Math.min(1, Math.max(0, t));
  });

  return (
    <>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[lines, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={COLOR} />
      </lineSegments>
      <mesh>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[face, 3]} />
        </bufferGeometry>
        <meshBasicMaterial
          ref={fillRef}
          color={COLOR}
          transparent
          opacity={FILL_OPACITY}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

/**
 * The camera a picked triangle belongs to, as an index into the full camera list. The pick mesh leaves the selected
 * camera out (FrustumPicker, below), so every camera after it sits one place earlier in the mesh than in the list.
 */
export function cameraOfTriangle(faceIndex: number, selected: number | null): number {
  const index = Math.floor(faceIndex / TRIANGLES_PER_FRUSTUM);
  return selected !== null && index >= selected ? index + 1 : index;
}

// An invisible solid version of every frustum, which is what the pointer hits. A line is too thin to hit reliably. The
// selected frustum is left out: a flight parks the viewer inside it, where it would be the nearest hit for every click
// within the photo's view and hide every other camera behind it.
function FrustumPicker({
  list,
  selected,
  onSelect,
}: {
  list: Frustum[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const positions = useMemo(() => triangles(list.filter((_, i) => i !== selected)), [list, selected]);
  const canvas = useThree(state => state.gl.domElement);
  useEffect(
    () => () => {
      canvas.style.removeProperty("cursor");
    },
    [canvas],
  );

  // R3F reports one hit per object, the nearest, so the triangle here is on the frustum closest to the viewer when
  // the pointer passes through several.
  function handleClick(event: ThreeEvent<MouseEvent>) {
    if (event.delta > CLICK_SLOP_PX || event.faceIndex == null) {
      return;
    }
    event.stopPropagation();
    onSelect(cameraOfTriangle(event.faceIndex, selected));
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a three.js mesh, not a DOM element. The photo grid is the keyboard route to the same selection.
    <mesh
      onClick={handleClick}
      onPointerOver={() => canvas.style.setProperty("cursor", "pointer")}
      onPointerOut={() => canvas.style.removeProperty("cursor")}
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      {/* Raycasting still hits a mesh that draws nothing, so it stays out of the picture without being hidden. */}
      <meshBasicMaterial side={DoubleSide} colorWrite={false} depthWrite={false} />
    </mesh>
  );
}

export function CameraFrustums({ cameras, selected, onSelect }: CameraFrustumsProps) {
  const list = useMemo(() => frustums(cameras), [cameras]);
  const positions = useMemo(() => segments(list), [list]);

  if (cameras.length === 0) {
    return null;
  }

  const selectedFrustum = selected === null ? undefined : list[selected];
  let highlight: React.ReactNode = null;
  if (selectedFrustum) {
    // Keyed so a new selection mounts fresh geometry. Three.js computes a geometry's bounding sphere once and culls by
    // it, so geometry reused for another camera keeps the old camera's sphere and vanishes whenever that one is out of
    // view.
    highlight = <SelectedFrustum key={`highlight-${selected}`} frustum={selectedFrustum} />;
  }
  let picker: React.ReactNode = null;
  if (onSelect) {
    // Keyed for the same reason as the highlight: its geometry changes with the selection. The two keys share a list of
    // siblings, so each carries its own prefix. With the same key, React can't tell them apart and leaves stale copies
    // of earlier highlights mounted.
    picker = <FrustumPicker key={`picker-${selected}`} list={list} selected={selected} onSelect={onSelect} />;
  }

  return (
    <>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        {/* Always transparent, with only the opacity changing. three.js compiles an opaque material's shader to draw
            every pixel fully opaque and keeps that shader when transparent is turned on later. */}
        <lineBasicMaterial color={COLOR} transparent opacity={selectedFrustum ? UNSELECTED_OPACITY : 1} />
      </lineSegments>
      {highlight}
      {picker}
    </>
  );
}
