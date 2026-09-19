"use client";

import { useEffect, useRef, useState } from "react";
import { type Box3, type BufferGeometry, Float32BufferAttribute } from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

import { AXES_HELPER_SIZE } from "./constants";

// The DC-term decode worker/pipeline/export.py documents: color = SH_C0 * f_dc + 0.5. Only "sh_dc" mode needs it. The
// COLMAP point cloud already carries plain 0-255 red/green/blue, which PLYLoader decodes into a standard color
// attribute on its own.
const SH_C0 = 0.28209479177387814;

interface PointCloudSceneProps {
  url: string;
  colorMode: "raw_rgb" | "sh_dc";
  onError: (message: string) => void;
  onFirstLoad: (box: Box3) => void;
}

export function PointCloudScene({ url, colorMode, onError, onFirstLoad }: PointCloudSceneProps) {
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
    // Captured so cleanup can dispose the GPU buffers this effect created — unlike SplatScene's DropInViewer, a
    // BufferGeometry has no owner other than this component to release it, and toggling the SegmentedControl
    // unmounts/remounts this component on every switch.
    let loadedGeometry: BufferGeometry | null = null;
    setGeometry(null);

    const loader = new PLYLoader();
    if (colorMode === "sh_dc") {
      // worker/pipeline/export.py's result.ply names these f_dc_0-2, not a property PLYLoader recognizes on its own.
      loader.setCustomPropertyNameMapping({ dcColor: ["f_dc_0", "f_dc_1", "f_dc_2"] });
    }

    loader.load(
      urlRef.current,
      loaded => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        loadedGeometry = loaded;
        if (colorMode === "sh_dc") {
          const dcColor = loaded.getAttribute("dcColor");
          if (dcColor) {
            const colors = new Float32Array(dcColor.count * 3);
            for (let i = 0; i < dcColor.count; i++) {
              colors[i * 3] = Math.min(1, Math.max(0, SH_C0 * dcColor.getX(i) + 0.5));
              colors[i * 3 + 1] = Math.min(1, Math.max(0, SH_C0 * dcColor.getY(i) + 0.5));
              colors[i * 3 + 2] = Math.min(1, Math.max(0, SH_C0 * dcColor.getZ(i) + 0.5));
            }
            loaded.setAttribute("color", new Float32BufferAttribute(colors, 3));
          }
        }
        loaded.computeBoundingBox();
        setGeometry(loaded);
        if (loaded.boundingBox && !loaded.boundingBox.isEmpty()) {
          onFirstLoad(loaded.boundingBox);
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
  }, [colorMode, onError, onFirstLoad]);

  return (
    <>
      <axesHelper args={[AXES_HELPER_SIZE]} />
      {geometry && (
        <points geometry={geometry}>
          <pointsMaterial vertexColors size={0.01} sizeAttenuation />
        </points>
      )}
    </>
  );
}
