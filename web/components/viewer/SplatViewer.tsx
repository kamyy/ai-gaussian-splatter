"use client";

import { CameraControls, PerspectiveCamera } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Box3, Vector3 } from "three";

import { Center } from "@/components/layout/Center";
import { Spinner } from "@/components/ui/Spinner";
import type { CameraPose, CropBox } from "@/lib/types";
import { CameraFrustums } from "./CameraFrustums";
import { CropBoxGizmo, cropBoxFromBounds } from "./CropBoxGizmo";
import { framingFromCameras, trimmedBox } from "./cameraFraming";
import { PointCloudScene } from "./PointCloudScene";

export type ViewerMode = "splat" | "colmap_points";

interface SplatViewerProps {
  mode: ViewerMode;
  splatUrl: string | null;
  pointCloudUrl: string | null;
  // Where the photos were taken from, in the same coordinate frame as both assets. They frame the view in either mode.
  cameras?: Omit<CameraPose, "photoId">[] | null;
  // Draws the cameras as frustums, in the point cloud view only.
  showCameras?: boolean;
  // Shows a crop box over the point cloud, which the visitor moves, rotates, and resizes. A null box while cropping is
  // replaced by one fitted to the point cloud once it loads, through onCropBoxChange.
  cropping?: boolean;
  cropBox?: CropBox | null;
  onCropBoxChange?: (box: CropBox) => void;
  height?: string;
}

/**
 * Spark draws every SplatMesh in the scene through one SparkRenderer, which has to be in the same scene and share R3F's
 * WebGLRenderer. Both are plain Three.js objects, so R3F's own render loop drives them through <primitive>.
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
  const gl = useThree(state => state.gl);
  const spark = useMemo(() => new SparkRenderer({ renderer: gl }), [gl]);
  useEffect(() => () => spark.dispose(), [spark]);

  const [mesh, setMesh] = useState<SplatMesh | null>(null);

  // The load effect below reads the URL from here instead of depending on it. Every presign mints a different URL
  // string for the same object (web/lib/server/s3.ts), so depending on it would restart the whole download whenever
  // the page re-minted one. A mount is what loads instead, and ViewerSceneManager (below) mounts a fresh scene on
  // every mode switch.
  const splatUrlRef = useRef(splatUrl);
  useEffect(() => {
    splatUrlRef.current = splatUrl;
  }, [splatUrl]);

  useEffect(() => {
    let disposed = false;
    // fileType is required, not inferred: splatUrl is a presigned S3 URL, and the query string after .ply defeats
    // extension-based detection.
    const splatMesh = new SplatMesh({ url: splatUrlRef.current, fileType: SplatFileType.PLY });
    splatMesh.initialized
      .then(() => {
        if (disposed) {
          return;
        }
        setMesh(splatMesh);

        // isEmpty() guards a degenerate box (e.g. a training collapse to a single point). Three.js represents an
        // empty Box3 as min=+Infinity/max=-Infinity, which is truthy, not null. getCenter()/getSize() on one yield
        // NaN, silently producing a camera pointed nowhere with no error surfaced.
        const centers: number[] = [];
        splatMesh.forEachSplat((_index, center) => {
          centers.push(center.x, center.y, center.z);
        });
        const box = trimmedBox(centers);
        if (!box.isEmpty()) {
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
      splatMesh.dispose();
    };
  }, [onError, onFirstLoad]);

  return (
    <>
      <primitive object={spark} />
      {mesh && <primitive object={mesh} />}
    </>
  );
}

/**
 * Lives inside <Canvas> (needs useThree()) so it can place the camera directly, unlike SplatViewer itself. Owns the
 * camera framing, which happens once per viewer: switching the mode toggle never re-frames. That's what makes "same
 * camera pose across the toggle" hold with no manual save/restore: both assets share one coordinate frame, since
 * worker/pipeline/train.py seeds Gaussian means directly from COLMAP's points_xyz with no rescale.
 *
 * The photos' own camera poses frame it when they're known (web/components/viewer/cameraFraming.ts). Otherwise the
 * first asset to load frames it by its bounding box. The poses arrive separately from either asset, so when they land
 * after a bounding-box framing they replace it, once.
 */
function ViewerSceneManager({
  mode,
  splatUrl,
  pointCloudUrl,
  cameras,
  onError,
  onPointCloudLoad,
}: {
  mode: ViewerMode;
  splatUrl: string | null;
  pointCloudUrl: string | null;
  cameras: Omit<CameraPose, "photoId">[] | null;
  onError: (message: string) => void;
  onPointCloudLoad: (box: Box3) => void;
}) {
  const camera = useThree(state => state.camera);
  // CameraControls' makeDefault registers it here. drei's PerspectiveCamera takes over as the default camera only after
  // the first render, so the controls are rebuilt around it once, and the framing below is re-applied to whichever
  // controls are current.
  const controls = useThree(state => state.controls) as CameraControls | null;
  const [framing, setFraming] = useState<{ position: Vector3; target: Vector3; up?: Vector3 } | null>(null);
  const framedByRef = useRef<"nothing" | "box" | "cameras">("nothing");

  useEffect(() => {
    if (!controls || !framing) {
      return;
    }
    if (framing.up) {
      camera.up.copy(framing.up);
      controls.updateCameraUp();
    }
    const { position, target } = framing;
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
  }, [camera, controls, framing]);

  useEffect(() => {
    const fromCameras = cameras ? framingFromCameras(cameras) : null;
    if (fromCameras && framedByRef.current !== "cameras") {
      framedByRef.current = "cameras";
      setFraming(fromCameras);
    }
  }, [cameras]);

  const onFirstLoad = useCallback((box: Box3) => {
    if (framedByRef.current !== "nothing") {
      return;
    }
    framedByRef.current = "box";
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    setFraming({ position: new Vector3(center.x, center.y, center.z + radius * 2.5), target: center });
  }, []);

  // Stable for the same reason as onFirstLoad: PointCloudScene's load effect depends on it.
  const onPointCloudFirstLoad = useCallback(
    (box: Box3) => {
      onPointCloudLoad(box);
      onFirstLoad(box);
    },
    [onPointCloudLoad, onFirstLoad],
  );

  // Switching mode renders a different component here, so React unmounts one scene and mounts the other. That mount is
  // what starts a load: both scenes read their URL from a ref (see SplatScene above) rather than reloading on a prop
  // change.
  if (mode === "splat" && splatUrl) {
    return <SplatScene key="splat" splatUrl={splatUrl} onError={onError} onFirstLoad={onFirstLoad} />;
  }
  if (mode === "colmap_points" && pointCloudUrl) {
    return (
      <PointCloudScene
        key="colmap_points"
        url={pointCloudUrl}
        colorMode="raw_rgb"
        onError={onError}
        onFirstLoad={onPointCloudFirstLoad}
      />
    );
  }
  return null;
}

export function SplatViewer({
  mode,
  splatUrl,
  pointCloudUrl,
  cameras = null,
  showCameras = false,
  cropping = false,
  cropBox = null,
  onCropBoxChange,
  height = "70vh",
}: SplatViewerProps) {
  // The failing mode is stored with the message so only that mode shows it. A bare string would leave one asset's
  // failure pinned over every other toggle position for the rest of the page's life.
  const [error, setError] = useState<{ mode: ViewerMode; message: string } | null>(null);

  // Re-created whenever the mode changes, which is deliberate: it is what tags a message with the mode that produced
  // it. The scenes take this as an effect dependency, and a mode change already remounts them, so the new identity
  // costs no extra load.
  const handleError = useCallback((message: string) => setError({ mode, message }), [mode]);

  const activeError = error?.mode === mode ? error.message : null;

  const [pointCloudBounds, setPointCloudBounds] = useState<Box3 | null>(null);
  useEffect(() => {
    if (cropping && cropBox === null && pointCloudBounds !== null) {
      onCropBoxChange?.(cropBoxFromBounds(pointCloudBounds));
    }
  }, [cropping, cropBox, pointCloudBounds, onCropBoxChange]);

  // The caller decides which modes it offers, so an unavailable one is not normally reachable. Saying so still beats
  // the alternative when it is, which is an empty canvas that looks like a load that never finishes.
  const hasAsset = mode === "colmap_points" ? pointCloudUrl !== null : splatUrl !== null;

  return (
    <div className="relative w-full overflow-hidden rounded-3xl bg-muted" style={{ height }}>
      {/* flat: R3F's default ACESFilmicToneMapping would bend every color through a filmic curve. The output stays
          sRGB, which both Spark's splats and PLYLoader's linearized point colors expect. */}
      <Canvas flat>
        {/* R3F's own default camera has a 75° field of view, which this keeps. The up direction only lasts until the
            photos' poses replace it. */}
        <PerspectiveCamera makeDefault fov={75} up={[0, -1, -0.6]} />
        <ViewerSceneManager
          mode={mode}
          splatUrl={splatUrl}
          pointCloudUrl={pointCloudUrl}
          cameras={cameras}
          onError={handleError}
          onPointCloudLoad={setPointCloudBounds}
        />
        {mode === "colmap_points" && showCameras && cameras && <CameraFrustums cameras={cameras} />}
        {mode === "colmap_points" && cropping && cropBox && onCropBoxChange && (
          <CropBoxGizmo box={cropBox} onChange={onCropBoxChange} />
        )}
        <CameraControls makeDefault dollyDragInverted />
      </Canvas>
      {activeError && (
        <Center className="pointer-events-none absolute inset-0">
          <p className="text-error">{activeError}</p>
        </Center>
      )}
      {!activeError && !hasAsset && (
        <Center className="pointer-events-none absolute inset-0">
          <p className="text-muted-foreground">Not available for this splat.</p>
        </Center>
      )}
    </div>
  );
}

export function SplatViewerLoading() {
  return (
    <Center className="h-[70vh] w-full">
      <Spinner className="h-8 w-8 text-muted-foreground" />
    </Center>
  );
}
