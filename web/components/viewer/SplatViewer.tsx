"use client";

import { Center, Loader, Text } from "@mantine/core";
import { DropInViewer, SceneFormat } from "@mkkellogg/gaussian-splats-3d";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Box3, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { PointCloudScene } from "./PointCloudScene";

export type ViewerMode = "splat" | "trained_points" | "colmap_points";

interface SplatViewerProps {
  mode: ViewerMode;
  splatUrl: string | null;
  colmapPointCloudUrl: string | null;
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
  onFirstLoad,
}: {
  splatUrl: string;
  onError: (message: string) => void;
  onFirstLoad: (box: Box3) => void;
}) {
  const [viewer, setViewer] = useState<DropInViewer | null>(null);
  const [boundingBox, setBoundingBox] = useState<Box3 | null>(null);

  // The load effect below reads the URL from here instead of depending on it. Every presign mints a different URL
  // string for the same object (web/lib/server/s3.ts), so depending on it would restart the whole download whenever
  // the page re-minted one. A remount is what reloads instead, and ViewerSceneManager gives each mode its own key so
  // that a mode switch is a remount.
  const splatUrlRef = useRef(splatUrl);
  useEffect(() => {
    splatUrlRef.current = splatUrl;
  }, [splatUrl]);

  useEffect(() => {
    let disposed = false;
    // sharedMemoryForWorkers defaults to true in this library version, with no runtime check for
    // self.crossOriginIsolated — only an iOS-version fallback. This app sends no COOP/COEP headers, so
    // crossOriginIsolated is false here, and the library's SharedArrayBuffer postMessage to its sort worker throws an
    // unhandled rejection deep inside its own promise chain: never caught, never surfaced to our onError, so the
    // loading spinner it already showed just never clears.
    const dropInViewer = new DropInViewer({ sharedMemoryForWorkers: false });
    const loadSettled = dropInViewer
      // format is required, not inferred: splatUrl is a presigned S3 URL, and the library's own extension-based
      // detection fails on the query string that follows .ply.
      .addSplatScenes([{ path: splatUrlRef.current, format: SceneFormat.Ply }])
      .then(() => {
        if (disposed) {
          return;
        }
        setViewer(dropInViewer);

        // COLMAP's reconstruction scale and origin are arbitrary per capture, so a fixed camera position can end up
        // pointed at empty space light-years from the actual splats. Framing from the loaded geometry's own bounding
        // box instead works for any capture.
        //
        // isEmpty() guards a degenerate box (e.g. a training collapse to a single point). Three.js represents an
        // empty Box3 as min=+Infinity/max=-Infinity, which is truthy, not null. getCenter()/getSize() on one yield
        // NaN, silently producing a camera pointed nowhere with no error surfaced.
        const box = dropInViewer.splatMesh?.computeBoundingBox();
        if (box && !box.isEmpty()) {
          setBoundingBox(box);
          onFirstLoad(box);
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
      // alone. Calling it immediately hangs forever with the library's own loading spinner stuck on screen. React's
      // dev-only mount-cleanup-remount cycle triggers this on every load, so the dispose is deferred until the load
      // has already settled above, at which point there's nothing left in flight for it to hang on. addSplatScenes()
      // returns the library's own AbortablePromise, which has .then()/.catch() but not .finally(). Promise.resolve()
      // adopts its state into a real Promise that does.
      Promise.resolve(loadSettled).finally(() => dropInViewer.dispose());
    };
  }, [onError, onFirstLoad]);

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

/**
 * Lives inside <Canvas> (needs useThree()) so it can place the camera directly, unlike SplatViewer itself. Owns the
 * one-shot-per-viewer camera framing: whichever of the three assets (splat / trained points / COLMAP points) loads
 * first frames the camera, and later loads — including switching the mode toggle to a not-yet-loaded asset — never
 * re-frame it. That's what makes "same camera pose across the toggle" hold with no manual save/restore: all three
 * assets share one coordinate frame, since worker/pipeline/train.py seeds Gaussian means directly from COLMAP's
 * points_xyz with no rescale.
 */
function ViewerSceneManager({
  mode,
  splatUrl,
  colmapPointCloudUrl,
  onError,
  controlsRef,
}: {
  mode: ViewerMode;
  splatUrl: string | null;
  colmapPointCloudUrl: string | null;
  onError: (message: string) => void;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();
  const hasFramedRef = useRef(false);

  const onFirstLoad = useCallback(
    (box: Box3) => {
      if (hasFramedRef.current) {
        return;
      }
      hasFramedRef.current = true;
      const center = box.getCenter(new Vector3());
      const radius = box.getSize(new Vector3()).length() / 2;
      camera.position.set(center.x, center.y, center.z + radius * 2.5);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      if (controlsRef.current) {
        controlsRef.current.target.copy(center);
        controlsRef.current.update();
      }
    },
    [camera, controlsRef],
  );

  // Each branch carries its own key. The two point-cloud modes would otherwise reconcile as one component instance
  // whose props merely changed, and neither scene reloads on a prop change any more.
  if (mode === "splat" && splatUrl) {
    return <SplatScene key="splat" splatUrl={splatUrl} onError={onError} onFirstLoad={onFirstLoad} />;
  }
  if (mode === "trained_points" && splatUrl) {
    return (
      <PointCloudScene
        key="trained_points"
        url={splatUrl}
        colorMode="sh_dc"
        onError={onError}
        onFirstLoad={onFirstLoad}
      />
    );
  }
  if (mode === "colmap_points" && colmapPointCloudUrl) {
    return (
      <PointCloudScene
        key="colmap_points"
        url={colmapPointCloudUrl}
        colorMode="raw_rgb"
        onError={onError}
        onFirstLoad={onFirstLoad}
      />
    );
  }
  return null;
}

export function SplatViewer({ mode, splatUrl, colmapPointCloudUrl }: SplatViewerProps) {
  // The failing mode is stored with the message so only that mode shows it. A bare string would leave one asset's
  // failure pinned over every other toggle position for the rest of the page's life.
  const [error, setError] = useState<{ mode: ViewerMode; message: string } | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  // Re-created whenever the mode changes, which is deliberate: it is what tags a message with the mode that produced
  // it. The scenes take this as an effect dependency, and a mode change already remounts them, so the new identity
  // costs no extra load.
  const handleError = useCallback((message: string) => setError({ mode, message }), [mode]);

  const activeError = error?.mode === mode ? error.message : null;

  // The caller decides which modes it offers, so an unavailable one is not normally reachable. Saying so still beats
  // the alternative when it is, which is an empty canvas that looks like a load that never finishes.
  const hasAsset = mode === "colmap_points" ? colmapPointCloudUrl !== null : splatUrl !== null;

  return (
    <div style={{ width: "100%", height: "70vh", position: "relative" }}>
      {/* flat/linear: R3F's default ACESFilmicToneMapping + SRGBColorSpace runs the splat shader's raw, untoneMapped
          color output through a curve it was never designed for. This library predates R3F's color-managed
          defaults. */}
      <Canvas flat linear camera={{ up: [0, -1, -0.6] }}>
        <ViewerSceneManager
          mode={mode}
          splatUrl={splatUrl}
          colmapPointCloudUrl={colmapPointCloudUrl}
          onError={handleError}
          controlsRef={controlsRef}
        />
        <OrbitControls ref={controlsRef} makeDefault />
      </Canvas>
      {activeError && (
        <Center style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <Text c="red">{activeError}</Text>
        </Center>
      )}
      {!activeError && !hasAsset && (
        <Center style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <Text c="dimmed">Not available for this splat.</Text>
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
