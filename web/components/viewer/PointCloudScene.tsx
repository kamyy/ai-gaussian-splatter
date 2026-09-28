"use client";

import { useEffect, useRef, useState } from "react";
import type { Box3, BufferGeometry } from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

import { trimmedBox } from "./cameraFraming";

// In world units. COLMAP's reconstruction has no fixed scale, so what looks right varies from one splat to the next,
// which is why web/components/splats/SplatStageViewer.tsx offers a slider over it.
export const DEFAULT_POINT_SIZE = 0.0125;

interface PointCloudSceneProps {
  url: string;
  pointSize: number;
  onError: (message: string) => void;
  onLoad: () => void;
  // positions is the point cloud's interleaved x, y, z, which the viewer fits its first crop box to.
  onFirstLoad: (box: Box3, positions: ArrayLike<number>) => void;
}

export function PointCloudScene({ url, pointSize, onError, onLoad, onFirstLoad }: PointCloudSceneProps) {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);

  // Read by the load effect below instead of being a dependency of it, for the reason SplatScene
  // (web/components/viewer/SplatViewer.tsx) gives: a re-minted presigned URL is the same object, and reloading on it
  // would re-download the whole point cloud.
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  useEffect(() => {
    let disposed = false;
    // Captured so cleanup can dispose the GPU buffers this effect created. Nothing but this component owns a
    // BufferGeometry, and every switch of the viewer's mode unmounts and remounts it.
    let loadedGeometry: BufferGeometry | null = null;
    setGeometry(null);

    // COLMAP's point cloud carries plain 0-255 red/green/blue, which PLYLoader decodes into a color attribute itself.
    new PLYLoader().load(
      urlRef.current,
      loaded => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        loadedGeometry = loaded;
        setGeometry(loaded);
        onLoad();
        const positions = loaded.getAttribute("position").array;
        const box = trimmedBox(positions);
        if (!box.isEmpty()) {
          onFirstLoad(box, positions);
        }
      },
      undefined,
      (err: unknown) => {
        if (!disposed) {
          onError(err instanceof Error ? err.message : "Failed to load point cloud");
        }
      },
    );

    return () => {
      disposed = true;
      loadedGeometry?.dispose();
    };
  }, [onError, onLoad, onFirstLoad]);

  if (!geometry) {
    return null;
  }
  return (
    <points geometry={geometry}>
      <pointsMaterial vertexColors size={pointSize} sizeAttenuation />
    </points>
  );
}
