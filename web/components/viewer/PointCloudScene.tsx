"use client";

import { useEffect, useRef, useState } from "react";
import type { Box3, BufferGeometry } from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

import { trimmedBox } from "./cameraFraming";

interface PointCloudSceneProps {
  url: string;
  onError: (message: string) => void;
  onFirstLoad: (box: Box3) => void;
}

export function PointCloudScene({ url, onError, onFirstLoad }: PointCloudSceneProps) {
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
        const box = trimmedBox(loaded.getAttribute("position").array);
        if (!box.isEmpty()) {
          onFirstLoad(box);
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
  }, [onError, onFirstLoad]);

  if (!geometry) {
    return null;
  }
  return (
    <points geometry={geometry}>
      <pointsMaterial vertexColors size={0.01} sizeAttenuation />
    </points>
  );
}
