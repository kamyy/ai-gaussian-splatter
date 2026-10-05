/**
 * The 3D viewer: a WebGL canvas showing either the finished splat or COLMAP's point cloud.
 *
 * Built on React Three Fiber (a React renderer for the Three.js 3D library). The visitor orbits, pans and zooms with
 * the mouse or touch, through either a perspective camera or an orthographic one, which draws without perspective so
 * parallel edges stay parallel. Either camera can animate to the object's front, side or top, or to a photo picked in
 * the grid. The viewer can also show a crop box over the point cloud, and hide the points outside an applied crop.
 * Switching between the splat and the point cloud keeps the camera where it was, because both share one coordinate
 * frame.
 */

"use client";

import { CameraControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Box3,
  type BufferGeometry,
  type Camera,
  OrthographicCamera as OrthographicCameraImpl,
  PerspectiveCamera as PerspectiveCameraImpl,
  type Scene,
  Vector3,
} from "three";

import { Center } from "@/components/layout/Center";
import { Spinner } from "@/components/ui/Spinner";
import { type CameraSelection, DEFAULT_FOV, useCameraFlight } from "@/lib/hooks/useCameraFlight";
import { useLatestRef } from "@/lib/hooks/useLatestRef";
import { useSceneFraming } from "@/lib/hooks/useSceneFraming";
import type { CameraPose, CropBox } from "@/lib/types";
import { CropBoxGizmo } from "./CropBoxGizmo";
import {
  type AxisView,
  axisViewPose,
  type Framing,
  fittedCropBox,
  framingFromCameras,
  trimmedBoundingBox,
  uprightRotation,
} from "./cameraFraming";
import {
  DEFAULT_POINT_SIZE,
  PointCloudScene,
  releasePointCloudGeometry,
  retainPointCloudGeometry,
} from "./PointCloudScene";

// How many times the object's longest side fits across the shorter side of the view, once an axis view has animated
// there.
const AXIS_VIEW_FIT = 1.5;
// How far an orthographic camera sits from the object, in multiples of the object's size. Distance doesn't change
// what an orthographic camera shows, so this only has to keep the whole object in front of it.
const ORTHOGRAPHIC_DISTANCE = 50;
// How far, in radians, the visitor has to turn the view before it no longer counts as the front, side or top view.
// Panning and zooming keep the direction exactly, so this only has to absorb rounding.
const LEAVE_VIEW_RADIANS = 0.01;

export type ViewMode = "splat" | "colmap_points";
export type Projection = "perspective" | "orthographic";

interface SplatViewerProps {
  mode: ViewMode;
  // Either camera flies to a selected photo's view. The orthographic one matches the framing with zoom.
  projection?: Projection;
  // Animates the camera to this side of the object. Null leaves the view where the visitor turned it.
  axisView?: AxisView | null;
  // Called once the visitor turns the camera away from the front, side or top view.
  onLeaveAxisView?: () => void;
  splatUrl: string | null;
  // Names which splat splatUrl points at. Every presign mints a different URL for the same file, so the URL can't
  // say whether the file changed. A new version, such as a crop being applied or undone, is what reloads the splat.
  splatVersion?: string;
  pointCloudUrl: string | null;
  // Where the photos were taken from, in the same coordinate frame as both assets. They frame the view in either mode.
  cameras?: Omit<CameraPose, "photoId">[] | null;
  // Flies the view to this camera's pose. A new object flies there again, including the same photo picked again.
  selectedCamera?: CameraSelection | null;
  // Called as the visitor drags, zooms or pans the view, which leaves the selected camera's view behind.
  onManualMove?: () => void;
  // How big each point of the point cloud is drawn, in world units.
  pointSize?: number;
  // Shows a crop box over the point cloud, which the visitor moves and resizes. The splat view never shows it, because
  // the splat's Gaussians hide its edges. A null box while cropping is replaced by the splat's crop when it has one,
  // and otherwise by a box fitted to the point cloud once that has loaded, through onCropBoxChange.
  cropping?: boolean;
  cropBox?: CropBox | null;
  onCropBoxChange?: (box: CropBox) => void;
  // The crop the splat already has. The point cloud hides the points outside it. Opening the crop box leaves that
  // crop in place. Only undoing the crop shows every point again.
  appliedCropBox?: CropBox | null;
  // The box front, side and top aim at while a crop is being fitted. Dragging the handles does not change it.
  aimBox?: CropBox | null;
  height?: string;
}

// Spark's render loop starts its sort from a timeout. Nothing awaits that promise. Disposing the renderer while the
// sort is still running clears the depth target the sort is about to read. The promise then rejects with "No target".
// Leaving the page disposes the renderer at that moment. Fast Refresh does the same when it tears the canvas down.
// The sort has nowhere to land. The rejection is ignored. A rejection while the renderer is still on screen is
// rethrown.
function holdSparkSorts(spark: SparkRenderer): () => void {
  let released = false;
  // updateInternal and driveSort are private. Naming those methods on SparkRenderer would make a direct cast the type
  // never.
  const runtime = spark as unknown as {
    updateInternal: (args: { scene: Scene; camera: Camera; autoUpdate: boolean }) => Promise<void>;
    driveSort: () => Promise<void>;
  };
  const runUpdate = runtime.updateInternal.bind(runtime);
  const runSort = runtime.driveSort.bind(runtime);

  // Spark's timeout calls updateInternal and driveSort on the instance. The replacements wrap those calls so the
  // promise they return is caught.
  const guard = (run: () => Promise<void>) =>
    run().catch((err: unknown) => {
      if (!released) {
        throw err;
      }
    });
  runtime.updateInternal = args => guard(() => runUpdate(args));
  runtime.driveSort = () => guard(runSort);

  return () => {
    released = true;
    spark.autoUpdate = false;

    if (spark.updateTimeoutId !== -1) {
      clearTimeout(spark.updateTimeoutId);
      spark.updateTimeoutId = -1;
    }
    if (spark.sortTimeoutId !== -1) {
      clearTimeout(spark.sortTimeoutId);
      spark.sortTimeoutId = -1;
    }

    spark.sortDirty = false;
    spark.dispose();
  };
}

// Spark draws every SplatMesh in the scene through one SparkRenderer, which has to be in the same scene and share R3F's
// WebGLRenderer. Both are plain Three.js objects, so R3F's own render loop drives them through <primitive>.
function SplatScene({
  splatUrl,
  onError,
  onLoad,
  onFirstLoad,
}: {
  splatUrl: string;
  onError: (message: string) => void;
  onLoad: () => void;
  onFirstLoad: (box: Box3) => void;
}) {
  const gl = useThree(state => state.gl);
  const [spark, setSpark] = useState<SparkRenderer | null>(null);

  // The renderer is created here because this effect's cleanup is what disposes it. React Strict Mode runs that
  // cleanup once on mount and then runs the effect again. A renderer remembered with useMemo stays disposed after
  // that cleanup. The effect's second run would then keep drawing with it.
  useEffect(() => {
    const renderer = new SparkRenderer({ renderer: gl });
    const release = holdSparkSorts(renderer);
    setSpark(renderer);

    return () => {
      release();
      setSpark(null);
    };
  }, [gl]);

  const [mesh, setMesh] = useState<SplatMesh | null>(null);

  // The load effect below reads the URL from here instead of depending on it. Every presign mints a different URL
  // string for the same object (web/lib/server/s3.ts), so depending on it would restart the whole download whenever
  // the page re-minted one. A mount is what loads instead, and ViewerSceneManager (below) mounts a fresh scene on
  // every mode switch and every new splat version.
  const splatUrlRef = useLatestRef(splatUrl);

  useEffect(() => {
    let disposed = false;

    // fileType is stated rather than inferred, because splatUrl is a presigned S3 URL whose query string follows the
    // .spz extension.
    const splatMesh = new SplatMesh({ url: splatUrlRef.current, fileType: SplatFileType.SPZ });
    splatMesh.initialized
      .then(() => {
        if (disposed) {
          return;
        }

        setMesh(splatMesh);
        onLoad();

        // isEmpty() guards a degenerate box (e.g. a training collapse to a single point). Three.js represents an
        // empty Box3 as min=+Infinity/max=-Infinity, which is truthy, not null. getCenter() and getSize() on that empty
        // box yield NaN, silently producing a camera pointed nowhere with no error surfaced.
        const centers: number[] = [];
        splatMesh.forEachSplat((_index, center) => {
          centers.push(center.x, center.y, center.z);
        });
        const box = trimmedBoundingBox(centers);
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
  }, [splatUrlRef, onError, onLoad, onFirstLoad]);

  return (
    <>
      {spark ? <primitive object={spark} /> : null}
      {mesh ? <primitive object={mesh} /> : null}
    </>
  );
}

// How tall a slice of the scene, in world units, the camera shows at the distance of controls' target.
function visibleHeight(controls: CameraControls, camera: Camera): number | null {
  if (camera instanceof OrthographicCameraImpl) {
    return (camera.top - camera.bottom) / camera.zoom;
  }

  if (camera instanceof PerspectiveCameraImpl) {
    return (2 * controls.distance * Math.tan((camera.fov * Math.PI) / 360)) / camera.zoom;
  }

  return null;
}

// Switching between the perspective and orthographic cameras mounts a fresh camera, with fresh controls around it.
// ProjectionHandoff carries the outgoing camera's view over to the new one: the same target, direction, and up, at
// the distance or zoom that shows the target at the same size.
function ProjectionHandoff() {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as CameraControls | null;
  // The last controls seen, with the camera they drive. The camera changes one render before CameraControls rebuilds
  // around it, so a controls change is when the camera it carries is known to be the new one.
  const previousRef = useRef<{ controls: CameraControls; camera: Camera } | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    if (!controls || previous?.controls === controls) {
      return;
    }

    previousRef.current = { controls, camera };
    if (!previous) {
      return;
    }

    const height = visibleHeight(previous.controls, previous.camera);
    if (height === null || height === 0) {
      return;
    }

    const target = previous.controls.getTarget(new Vector3(), false);
    const direction = previous.controls.getPosition(new Vector3(), false).sub(target).normalize();

    let distance: number;
    if (camera instanceof OrthographicCameraImpl) {
      // Distance changes nothing an orthographic camera shows, so it only has to keep the scene in front of it.
      distance = height * ORTHOGRAPHIC_DISTANCE;
      camera.near = 0;
      camera.far = distance * 2;
      camera.updateProjectionMatrix();
      void controls.zoomTo((camera.top - camera.bottom) / height, false);
    } else if (camera instanceof PerspectiveCameraImpl) {
      distance = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      void controls.zoomTo(1, false);
    } else {
      return;
    }

    camera.up.copy(previous.camera.up);
    controls.updateCameraUp();
    const position = direction.multiplyScalar(distance).add(target);
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
  }, [camera, controls]);

  return null;
}

// Animates the camera to one side of box and fits the box to the view. A change of view or box runs it again. A new
// camera keeps the view ProjectionHandoff carried over, so the animation does not restart. The visitor can still orbit.
// Turning away from that direction reports onLeave. active is false while the point cloud, and its front, side and top
// buttons, are off screen. Orbiting the splat then must not count as leaving the view, or coming back would show no
// button pressed.
function AxisViewRig({
  view,
  box,
  active,
  onLeave,
}: {
  view: AxisView | null;
  box: CropBox | null;
  active: boolean;
  onLeave: () => void;
}) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as CameraControls | null;
  // Read when the axis view animates, rather than depended on, so resizing the window doesn't undo the visitor's zoom.
  const sizeRef = useLatestRef(useThree(state => state.size));
  const onLeaveRef = useLatestRef(onLeave);
  // The direction from the target to the camera for the current front, side or top view, until the visitor turns away.
  const snappedRef = useRef<Vector3 | null>(null);
  // The view and box last animated to. A new camera with the same view and box does not animate again.
  const lastSnapRef = useRef<{ view: AxisView; box: CropBox } | null>(null);

  useEffect(() => {
    if (!active || !view) {
      snappedRef.current = null;
      lastSnapRef.current = null;
    }

    if (!active || !controls || !box || !view) {
      return;
    }

    const last = lastSnapRef.current;
    if (last?.view === view && last.box === box) {
      return;
    }

    const { direction, target, up, extent } = axisViewPose(box, view);
    const { width, height } = sizeRef.current;
    const fitted = extent * AXIS_VIEW_FIT;

    let distance: number;
    if (camera instanceof OrthographicCameraImpl) {
      // Distance changes nothing an orthographic camera shows, so the clipping range only has to span the scene.
      distance = extent * ORTHOGRAPHIC_DISTANCE;
      camera.near = 0;
      camera.far = distance * 2;
      camera.updateProjectionMatrix();
      void controls.zoomTo(Math.min(width, height) / fitted, true);
    } else if (camera instanceof PerspectiveCameraImpl) {
      // A flight may have left the photo's field of view behind. The distance then fits the box across the narrower
      // of the view's two fields of view.
      camera.fov = DEFAULT_FOV;
      camera.updateProjectionMatrix();
      void controls.zoomTo(1, true);
      const halfAngle = Math.tan((DEFAULT_FOV * Math.PI) / 360) * Math.min(1, width / height);
      distance = fitted / 2 / halfAngle;
    } else {
      return;
    }

    camera.up.copy(up);
    controls.updateCameraUp();
    const position = direction.clone().multiplyScalar(distance).add(target);
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true);
    snappedRef.current = direction;
    lastSnapRef.current = { view, box };
  }, [active, camera, controls, box, view, sizeRef]);

  useEffect(() => {
    if (!active || !controls) {
      return;
    }

    const handleControl = () => {
      const snapped = snappedRef.current;
      if (!snapped) {
        return;
      }

      const direction = controls.getPosition(new Vector3(), false).sub(controls.getTarget(new Vector3(), false));
      if (direction.angleTo(snapped) > LEAVE_VIEW_RADIANS) {
        snappedRef.current = null;
        onLeaveRef.current();
      }
    };
    controls.addEventListener("control", handleControl);

    return () => controls.removeEventListener("control", handleControl);
  }, [active, controls, onLeaveRef]);

  return null;
}

// Lives inside <Canvas>, because these hooks place the camera through useThree(), which SplatViewer itself can't call:
// - web/lib/hooks/useCameraFlight.ts
// - web/lib/hooks/useSceneFraming.ts
function ViewerSceneManager({
  mode,
  splatUrl,
  splatVersion,
  pointCloudUrl,
  cameras,
  framing,
  selectedCamera,
  axisView,
  onManualMove,
  pointSize,
  pointsCropBox,
  pointCloudLoad,
  onError,
  onLoad,
  onSceneLoad,
  onPointCloudLoad,
}: {
  mode: ViewMode;
  splatUrl: string | null;
  splatVersion: string;
  pointCloudUrl: string | null;
  cameras: Omit<CameraPose, "photoId">[] | null;
  framing: Framing | null;
  selectedCamera: CameraSelection | null;
  // The front, side or top view, when one is showing. While the point cloud is on screen that view owns the camera,
  // and a framing that arrives must not move it.
  axisView: AxisView | null;
  onManualMove?: () => void;
  pointSize: number;
  pointsCropBox: CropBox | null;
  // The point-cloud download started for the crop box, shared with the point-cloud scene.
  pointCloudLoad: Promise<BufferGeometry> | null;
  onError: (message: string) => void;
  onLoad: () => void;
  // Called with each scene's bounding box as it loads.
  onSceneLoad: (box: Box3) => void;
  onPointCloudLoad: (positions: ArrayLike<number>) => void;
}) {
  const { sceneUpRef, onFirstLoad } = useSceneFraming(
    framing,
    selectedCamera !== null,
    mode === "colmap_points" && axisView !== null,
  );
  useCameraFlight(cameras, selectedCamera, sceneUpRef, framing?.target ?? null, onManualMove);

  // Both stable, like onFirstLoad, because each scene's load effect depends on its callback.
  const onSceneFirstLoad = useCallback(
    (box: Box3) => {
      onSceneLoad(box);
      onFirstLoad(box);
    },
    [onSceneLoad, onFirstLoad],
  );
  const onPointCloudFirstLoad = useCallback(
    (box: Box3, positions: ArrayLike<number>) => {
      onPointCloudLoad(positions);
      onSceneFirstLoad(box);
    },
    [onPointCloudLoad, onSceneFirstLoad],
  );

  // Switching mode or splat version renders a component with a different key here, so React unmounts one scene and
  // mounts the other. The splat loads on that mount. The point cloud download has already started for the crop box,
  // and this mount draws it. Both scenes read their URL from a ref (see SplatScene above) rather than reloading when a
  // presign replaces it.
  if (mode === "splat" && splatUrl) {
    return (
      <SplatScene
        key={`splat:${splatVersion}`}
        splatUrl={splatUrl}
        onError={onError}
        onLoad={onLoad}
        onFirstLoad={onSceneFirstLoad}
      />
    );
  }

  if (mode === "colmap_points" && pointCloudUrl) {
    return (
      <PointCloudScene
        key="colmap_points"
        url={pointCloudUrl}
        pointSize={pointSize}
        geometryPromise={pointCloudLoad}
        cropBox={pointsCropBox}
        onError={onError}
        onLoad={onLoad}
        onFirstLoad={onPointCloudFirstLoad}
      />
    );
  }

  return null;
}

export function SplatViewer({
  mode,
  projection = "perspective",
  axisView = null,
  onLeaveAxisView = () => {},
  splatUrl,
  splatVersion = "original",
  pointCloudUrl,
  cameras = null,
  selectedCamera = null,
  onManualMove,
  pointSize = DEFAULT_POINT_SIZE,
  cropping = false,
  cropBox = null,
  onCropBoxChange,
  appliedCropBox = null,
  aimBox = null,
  height = "70vh",
}: SplatViewerProps) {
  // Which scene is on screen: the point cloud, or one version of the splat.
  const scene = mode === "splat" ? `splat:${splatVersion}` : mode;

  // The failing scene is stored with the message so only that scene shows it. A bare string would leave one asset's
  // failure pinned over every other mode for the rest of the page's life.
  const [error, setError] = useState<{ scene: string; message: string } | null>(null);

  // Re-created whenever the scene changes, which is deliberate: it is what tags a message with the scene that produced
  // it. The scenes take this as an effect dependency, and a scene change already remounts them, so the new identity
  // costs no extra load.
  const handleError = useCallback((message: string) => setError({ scene, message }), [scene]);

  const activeError = error?.scene === scene ? error.message : null;

  // The scene that has finished loading. Like handleError, handleLoad is re-created per scene, and a change of scene
  // mounts a fresh one that loads again, so the spinner comes back until that load finishes.
  const [loadedScene, setLoadedScene] = useState<string | null>(null);
  const handleLoad = useCallback(() => setLoadedScene(scene), [scene]);

  const framing = useMemo(() => (cameras ? framingFromCameras(cameras) : null), [cameras]);

  const [pointCloudPositions, setPointCloudPositions] = useState<ArrayLike<number> | null>(null);
  const [pointCloudLoad, setPointCloudLoad] = useState<Promise<BufferGeometry> | null>(null);
  // True when the point cloud cannot be fitted, so the axis views fall back to the scene instead of waiting.
  const [pointCloudFitFailed, setPointCloudFitFailed] = useState(false);
  // The first scene's bounding box. The axis views use it only when no crop box can be fitted.
  const [sceneBox, setSceneBox] = useState<Box3 | null>(null);
  // A later presign is the same file. The effect below reads this instead of depending on the link, so a refresh does
  // not download the point cloud again.
  const pointCloudUrlRef = useLatestRef(pointCloudUrl);
  const fittedBox = useMemo(
    () => (pointCloudPositions ? fittedCropBox(pointCloudPositions, framing) : null),
    [pointCloudPositions, framing],
  );
  const handleSceneLoad = useCallback((box: Box3) => setSceneBox(current => current ?? box), []);

  // A crop that has no box yet starts from the splat's crop. A fit to the point cloud is used only when there is none.
  useEffect(() => {
    if (!cropping || cropBox !== null) {
      return;
    }

    const seed = appliedCropBox ?? fittedBox;
    if (seed) {
      onCropBoxChange?.(seed);
    }
  }, [cropping, cropBox, appliedCropBox, fittedBox, onCropBoxChange]);

  // The fit runs from the point cloud even while the splat is on screen, so front, side and top can use the crop box
  // before the visitor opens the point cloud. The claim is dropped when this effect cleans up, which happens on a real
  // unmount and on the development double-mount, and the second run starts it again.
  const hasPointCloud = pointCloudUrl !== null;
  // hasPointCloud is what restarts this once a link exists. The link itself is read from a ref, so a new presign of
  // the same file does not download it again.
  useEffect(() => {
    const url = pointCloudUrlRef.current;
    if (!hasPointCloud || !url) {
      return;
    }

    let cancelled = false;
    const pending = retainPointCloudGeometry(url);
    setPointCloudLoad(pending);
    pending
      .then(geometry => {
        if (cancelled) {
          return;
        }

        const positions = geometry.getAttribute("position")?.array;
        if (positions && positions.length >= 3) {
          setPointCloudPositions(positions);
        } else {
          setPointCloudFitFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPointCloudFitFailed(true);
        }
      });

    return () => {
      cancelled = true;
      releasePointCloudGeometry(url);
    };
  }, [hasPointCloud, pointCloudUrlRef]);

  // Front, side and top frame the box this crop started from, while one is being fitted. Otherwise they frame the
  // crop already applied, or the box fitted to the point cloud. They wait out the point cloud download. With no point
  // cloud to fit, they frame the scene. The box being dragged stays out of this. The camera keeps the view it
  // animated to.
  const axisViewBox = useMemo<CropBox | null>(() => {
    if (cropping && aimBox) {
      return aimBox;
    }

    if (appliedCropBox) {
      return appliedCropBox;
    }

    if (fittedBox) {
      return fittedBox;
    }

    if (hasPointCloud && !pointCloudFitFailed) {
      return null;
    }

    if (sceneBox) {
      return {
        center: sceneBox.getCenter(new Vector3()).toArray(),
        size: sceneBox.getSize(new Vector3()).toArray(),
        quaternion: uprightRotation(framing).toArray(),
      };
    }

    return null;
  }, [cropping, aimBox, appliedCropBox, fittedBox, hasPointCloud, pointCloudFitFailed, sceneBox, framing]);

  // The caller decides which modes it offers, so an unavailable one is not normally reachable. Saying so still beats
  // the alternative when it is, which is an empty canvas that looks like a load that never finishes.
  const hasAsset = mode === "colmap_points" ? pointCloudUrl !== null : splatUrl !== null;
  const loaded = loadedScene === scene;

  const orthographic = projection === "orthographic";

  let gizmo: React.ReactNode = null;
  if (mode === "colmap_points" && cropping && cropBox && onCropBoxChange) {
    gizmo = <CropBoxGizmo box={cropBox} onChange={onCropBoxChange} />;
  }

  // Each camera mounts as a fresh default camera, and CameraControls rebuilds itself around whichever is current.
  let camera: React.ReactNode;
  if (orthographic) {
    camera = <OrthographicCamera makeDefault />;
  } else {
    // The up direction only lasts until the photos' poses replace it.
    camera = <PerspectiveCamera makeDefault fov={DEFAULT_FOV} up={[0, -1, -0.6]} />;
  }

  let overlay: React.ReactNode = null;
  if (activeError) {
    overlay = (
      <Center className="pointer-events-none absolute inset-0">
        <p className="text-error">{activeError}</p>
      </Center>
    );
  } else if (!hasAsset) {
    overlay = (
      <Center className="pointer-events-none absolute inset-0">
        <p className="text-muted-foreground">Not available for this splat.</p>
      </Center>
    );
  } else if (!loaded) {
    overlay = (
      <Center className="pointer-events-none absolute inset-0">
        <Spinner size="large" className="text-primary" />
      </Center>
    );
  }

  return (
    <div className="relative w-full overflow-hidden rounded-3xl bg-muted" style={{ height }}>
      {/* flat: R3F's default ACESFilmicToneMapping would bend every color through a filmic curve. The output stays
          sRGB, which both Spark's splats and PLYLoader's linearized point colors expect. */}
      <Canvas flat>
        {camera}
        <ViewerSceneManager
          mode={mode}
          splatUrl={splatUrl}
          splatVersion={splatVersion}
          pointCloudUrl={pointCloudUrl}
          cameras={cameras}
          framing={framing}
          selectedCamera={selectedCamera}
          axisView={axisView}
          onManualMove={onManualMove}
          pointSize={pointSize}
          pointsCropBox={appliedCropBox}
          pointCloudLoad={pointCloudLoad}
          onError={handleError}
          onLoad={handleLoad}
          onSceneLoad={handleSceneLoad}
          onPointCloudLoad={setPointCloudPositions}
        />
        <ProjectionHandoff />
        <AxisViewRig view={axisView} box={axisViewBox} active={mode === "colmap_points"} onLeave={onLeaveAxisView} />
        {gizmo}
        <CameraControls makeDefault dollyDragInverted />
      </Canvas>
      {overlay}
    </div>
  );
}
