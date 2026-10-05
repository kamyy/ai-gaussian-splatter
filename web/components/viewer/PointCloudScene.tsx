/**
 * Loads and draws COLMAP's point cloud in the 3D view.
 *
 * The point cloud is the rough cloud of colored points COLMAP (the structure-from-motion tool in worker/) builds from
 * the photos. It's the "shape sketch" the visitor checks before training, and the view the owner fits a crop box in.
 * web/components/viewer/SplatViewer.tsx starts the .ply download as soon as it has a link, so the front, side and top
 * views can fit a crop box before this scene is on screen. This component draws that same download. Once a crop is
 * applied, it hides the points outside the box, matching the Gaussians the crop removed.
 */

"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Box3,
  BufferGeometry,
  Float32BufferAttribute,
  OrthographicCamera,
  type PointsMaterial,
  Vector2,
} from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

import { insideCropBox } from "@/lib/cropBox";
import { useLatestRef } from "@/lib/hooks/useLatestRef";
import type { CropBox } from "@/lib/types";
import { trimmedBoundingBox } from "./cameraFraming";

/**
 * In world units. COLMAP's reconstruction has no fixed scale, so what looks right varies from one splat to the next,
 * which is why web/components/splats/SplatViewerPanel.tsx offers a slider over it.
 */
export const DEFAULT_POINT_SIZE = 0.0125;

// Reused by every frame's size update, which would otherwise allocate one per frame.
const drawingBuffer = new Vector2();
// One download per link. Each caller claims it, and the last release frees the geometry.
const pointCloudLoads = new Map<string, { promise: Promise<BufferGeometry>; users: number }>();

interface PointCloudSceneProps {
  url: string;
  pointSize: number;
  // The download web/components/viewer/SplatViewer.tsx already started for the crop box. Null until that claim exists,
  // in which case this scene claims url itself.
  geometryPromise: Promise<BufferGeometry> | null;
  // Hides every point outside this box. Null shows them all.
  cropBox: CropBox | null;
  onError: (message: string) => void;
  onLoad: () => void;
  onFirstLoad: (box: Box3) => void;
}

/** One shared download of the point cloud at url. Each caller keeps it until releasePointCloudGeometry. */
export function retainPointCloudGeometry(url: string): Promise<BufferGeometry> {
  let load = pointCloudLoads.get(url);
  if (!load) {
    const promise = new Promise<BufferGeometry>((resolve, reject) => {
      new PLYLoader().load(url, resolve, undefined, () => {
        reject(new Error("Failed to load point cloud"));
      });
    });
    load = { promise, users: 0 };
    pointCloudLoads.set(url, load);
    const created = load;
    void promise.catch(() => {
      if (pointCloudLoads.get(url) === created && created.users === 0) {
        pointCloudLoads.delete(url);
      }
    });
  }

  load.users += 1;

  return load.promise;
}

/** Drops one claim on url's point cloud. The last claim frees the geometry. */
export function releasePointCloudGeometry(url: string) {
  const load = pointCloudLoads.get(url);
  if (!load) {
    return;
  }

  load.users -= 1;
  if (load.users > 0) {
    return;
  }

  pointCloudLoads.delete(url);
  void load.promise.then(geometry => geometry.dispose()).catch(() => undefined);
}

/** A copy of geometry holding only the points inside box, with every attribute they carry. */
export function croppedGeometry(geometry: BufferGeometry, box: CropBox): BufferGeometry {
  const positions = geometry.getAttribute("position");
  const kept: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    if (insideCropBox(positions.getX(i), positions.getY(i), positions.getZ(i), box)) {
      kept.push(i);
    }
  }

  // getComponent returns each value already scaled to its real range, so every copy is a plain float attribute.
  const cropped = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const { itemSize } = attribute;
    const values = new Float32Array(kept.length * itemSize);
    kept.forEach((index, row) => {
      for (let component = 0; component < itemSize; component++) {
        values[row * itemSize + component] = attribute.getComponent(index, component);
      }
    });
    cropped.setAttribute(name, new Float32BufferAttribute(values, itemSize));
  }

  return cropped;
}

export function PointCloudScene({
  url,
  pointSize,
  geometryPromise,
  cropBox,
  onError,
  onLoad,
  onFirstLoad,
}: PointCloudSceneProps) {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);

  // Read by the load effect below instead of being a dependency of it, for the reason SplatScene
  // (web/components/viewer/SplatViewer.tsx) gives: a re-minted presigned URL names the same file, and reloading on it
  // would re-download the whole point cloud.
  const urlRef = useLatestRef(url);

  useEffect(() => {
    let disposed = false;
    // Null when geometryPromise is the shared download. This scene only releases a claim it opened itself.
    const retainedUrl = geometryPromise ? null : urlRef.current;
    setGeometry(null);

    // COLMAP's point cloud carries plain 0-255 red/green/blue, which PLYLoader decodes into a color attribute itself.
    const pending = geometryPromise ?? retainPointCloudGeometry(urlRef.current);
    pending
      .then(loaded => {
        if (disposed) {
          return;
        }

        setGeometry(loaded);
        onLoad();

        const box = trimmedBoundingBox(loaded.getAttribute("position").array);
        if (!box.isEmpty()) {
          onFirstLoad(box);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          onError(err instanceof Error ? err.message : "Failed to load point cloud");
        }
      });

    return () => {
      disposed = true;
      if (retainedUrl) {
        releasePointCloudGeometry(retainedUrl);
      }
    };
  }, [geometryPromise, urlRef, onError, onLoad, onFirstLoad]);

  const shown = useMemo(
    () => (geometry && cropBox ? croppedGeometry(geometry, cropBox) : geometry),
    [geometry, cropBox],
  );
  useEffect(() => {
    if (shown === null || shown === geometry) {
      return;
    }

    return () => shown.dispose();
  }, [shown, geometry]);

  // Three.js scales a point's size by its distance only under a perspective camera. Under an orthographic one it draws
  // size as raw pixels, so the world-unit size is converted to pixels on every frame, following the camera's zoom.
  const materialRef = useRef<PointsMaterial>(null);
  useFrame(({ camera, gl }) => {
    const material = materialRef.current;
    if (!material) {
      return;
    }

    if (camera instanceof OrthographicCamera) {
      const pixelsPerUnit = (gl.getDrawingBufferSize(drawingBuffer).y * camera.zoom) / (camera.top - camera.bottom);
      material.size = pointSize * pixelsPerUnit;
    } else {
      material.size = pointSize;
    }
  });

  if (!shown) {
    return null;
  }

  return (
    <points geometry={shown}>
      <pointsMaterial ref={materialRef} vertexColors size={pointSize} sizeAttenuation />
    </points>
  );
}
