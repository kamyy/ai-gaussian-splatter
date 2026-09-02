"use client";

import { Center, Loader, Text } from "@mantine/core";
import { DropInViewer, SceneFormat } from "@mkkellogg/gaussian-splats-3d";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { type Box3, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

interface SplatViewerProps {
  splatUrl: string;
}

/**
 * DropInViewer extends THREE.Group and drives its own per-frame update via Three.js's native onBeforeRender hook (see
 * gaussian-splats-3d's source: `callbackMesh.onBeforeRender = DropInViewer.onBeforeRender...`) rather than self-driven
 * requestAnimationFrame. So simply adding it to R3F's scene via <primitive> is enough; R3F's own render loop drives it
 * with no manual useFrame ticking needed.
 */
function SplatScene({
  splatUrl,
  onError,
  controlsRef,
}: {
  splatUrl: string;
  onError: (message: string) => void;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const [viewer, setViewer] = useState<DropInViewer | null>(null);
  const [boundingBox, setBoundingBox] = useState<Box3 | null>(null);
  const { camera } = useThree();

  useEffect(() => {
    let disposed = false;
    // sharedMemoryForWorkers defaults to true in this library version, with no runtime check for
    // self.crossOriginIsolated — only an iOS-version fallback. This app sends no COOP/COEP headers, so
    // crossOriginIsolated is false here, and the library's SharedArrayBuffer postMessage to its sort worker throws an
    // unhandled rejection deep inside its own promise chain: never caught, never surfaced to our onError, so the
    // loading spinner it already showed just never clears.
    const dropInViewer = new DropInViewer({ gpuAcceleratedSort: false, sharedMemoryForWorkers: false });
    const loadSettled = dropInViewer
      // format is required, not inferred: splatUrl is a presigned S3 URL, and the library's own extension-based
      // detection fails on the query string that follows .ply.
      .addSplatScenes([{ path: splatUrl, format: SceneFormat.Ply }])
      .then(() => {
        if (disposed) {
          return;
        }
        setViewer(dropInViewer);

        // COLMAP's reconstruction scale and origin are arbitrary per capture, so a fixed camera position can end up
        // pointed at empty space light-years from the actual splats. Framing from the loaded geometry's own bounding
        // box instead works for any capture.
        const box = dropInViewer.splatMesh?.computeBoundingBox();
        if (box) {
          setBoundingBox(box);
          const center = box.getCenter(new Vector3());
          const radius = box.getSize(new Vector3()).length() / 2;
          camera.position.set(center.x, center.y, center.z + radius * 2.5);
          camera.lookAt(center);
          camera.updateProjectionMatrix();
          if (controlsRef.current) {
            controlsRef.current.target.copy(center);
            controlsRef.current.update();
          }
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          onError(err instanceof Error ? err.message : "Failed to load splat");
        }
      });

    return () => {
      disposed = true;
      // dispose() waits on the same in-flight load promise it aborts, which never actually settles from the abort
      // alone — calling it immediately hangs forever with the library's own loading spinner stuck on screen. React's
      // dev-only mount-cleanup-remount cycle triggers this on every load, so the dispose is deferred until the load
      // has already settled above, at which point there's nothing left in flight for it to hang on. addSplatScenes()
      // returns the library's own AbortablePromise, which has .then()/.catch() but not .finally() — Promise.resolve()
      // adopts its state into a real Promise that does.
      Promise.resolve(loadSettled).finally(() => dropInViewer.dispose());
    };
  }, [splatUrl, onError, camera, controlsRef]);

  if (!viewer) {
    return null;
  }
  return (
    <>
      <primitive object={viewer} />
      {boundingBox && <box3Helper args={[boundingBox]} />}
    </>
  );
}

export function SplatViewer({ splatUrl }: SplatViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  return (
    <div style={{ width: "100%", height: "70vh", position: "relative" }}>
      {/* flat/linear: R3F's default ACESFilmicToneMapping + SRGBColorSpace runs the splat shader's raw, untoneMapped
          color output through a curve it was never designed for. This library predates R3F's color-managed
          defaults. */}
      <Canvas flat linear camera={{ up: [0, -1, -0.6] }}>
        <SplatScene splatUrl={splatUrl} onError={setError} controlsRef={controlsRef} />
        <OrbitControls ref={controlsRef} makeDefault />
      </Canvas>
      {error && (
        <Center style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <Text c="red">{error}</Text>
        </Center>
      )}
    </div>
  );
}

export function SplatViewerLoading() {
  return (
    <Center style={{ width: "100%", height: "70vh" }}>
      <Loader />
    </Center>
  );
}
