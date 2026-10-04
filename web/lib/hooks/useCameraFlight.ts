/**
 * Flies the 3D view to a picked photo's viewpoint, and levels it out again afterwards.
 *
 * When the visitor picks a photo, the view animates to where that photo was taken, matching its angle and zoom, so the
 * 3D scene lines up with the photo. The photo a page opens on is placed there at once. Once the visitor drags the view
 * away, it tilts back upright and zooms back out. This runs inside the viewer's React Three Fiber canvas, animating a
 * little every frame.
 */

"use client";

import type { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useRef } from "react";
import { type Camera, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from "three";

import {
  easeInOutCubic,
  fittedFov,
  interpolatePose,
  orbitTargetOf,
  orthographicZoom,
  photoViewPose,
  type ViewPose,
} from "@/components/viewer/cameraFlight";
import { useClickPress } from "@/lib/hooks/useClickPress";
import { useLatestRef } from "@/lib/hooks/useLatestRef";
import type { CameraPose } from "@/lib/types";

// How long the camera takes to fly to a selected photo's view.
const FLIGHT_SECONDS = 0.8;
// How long the view takes to level out and zoom back out once the visitor starts orbiting away from a photo's view.
const LEVEL_SECONDS = 0.4;
/** The vertical field of view, in degrees, everywhere but a photo's view. R3F's own default camera has the same. */
export const DEFAULT_FOV = 75;

/**
 * A camera picked by index into the viewer's cameras. Every new object flies the view there, so selecting the same
 * camera again after orbiting away flies back to it. opening is the photo the page opens on, which is placed at once
 * rather than flown to.
 */
export interface CameraSelection {
  index: number;
  // True for the photo the page opens on. A pick from the grid leaves this off.
  opening?: boolean;
}

// A flight from the view the visitor had to a photo's view. A perspective flight changes the field of view. An
// orthographic one changes the zoom, since that camera has no field of view.
interface Flight {
  from: ViewPose;
  to: ViewPose;
  fromFov: number;
  toFov: number;
  fromZoom: number;
  toZoom: number;
  orthographic: boolean;
  elapsed: number;
}

// Levelling out: turning camera.up from where a flight left it back to the scene's up, and widening back to
// DEFAULT_FOV.
interface Level {
  from: Vector3;
  fromFov: number;
  elapsed: number;
}

function setFov(perspective: PerspectiveCamera | null, fov: number) {
  if (perspective && perspective.fov !== fov) {
    perspective.fov = fov;
    perspective.updateProjectionMatrix();
  }
}

// Puts the camera on pose, with the field of view or zoom that goes with it.
function placePose(
  pose: ViewPose,
  fov: number,
  zoom: number,
  orthographic: boolean,
  camera: Camera,
  perspective: PerspectiveCamera | null,
  controls: CameraControls,
) {
  setFov(perspective, fov);
  if (orthographic && camera instanceof OrthographicCamera) {
    // A photo can sit inside the scene. A near plane in front of the camera would clip it.
    if (camera.near !== 0) {
      camera.near = 0;
      camera.updateProjectionMatrix();
    }
    void controls.zoomTo(zoom, false);
  }

  camera.up.set(0, 1, 0).applyQuaternion(pose.quaternion);
  controls.updateCameraUp();
  const target = orbitTargetOf(pose);
  void controls.setLookAt(pose.position.x, pose.position.y, pose.position.z, target.x, target.y, target.z, false);
}

// Advances flight by delta seconds and places the camera on it. Returns whether the flight has landed.
function stepFlight(
  flight: Flight,
  delta: number,
  camera: Camera,
  perspective: PerspectiveCamera | null,
  controls: CameraControls,
): boolean {
  flight.elapsed = Math.min(flight.elapsed + delta, FLIGHT_SECONDS);
  const t = easeInOutCubic(flight.elapsed / FLIGHT_SECONDS);
  placePose(
    interpolatePose(flight.from, flight.to, t),
    flight.fromFov + (flight.toFov - flight.fromFov) * t,
    flight.fromZoom + (flight.toZoom - flight.fromZoom) * t,
    flight.orthographic,
    camera,
    perspective,
    controls,
  );

  return flight.elapsed === FLIGHT_SECONDS;
}

// Advances level by delta seconds toward sceneUp and DEFAULT_FOV. Returns whether the view has levelled out.
function stepLevel(
  level: Level,
  delta: number,
  sceneUp: Vector3 | null,
  camera: Camera,
  perspective: PerspectiveCamera | null,
  controls: CameraControls,
): boolean {
  level.elapsed = Math.min(level.elapsed + delta, LEVEL_SECONDS);
  const t = easeInOutCubic(level.elapsed / LEVEL_SECONDS);

  setFov(perspective, level.fromFov + (DEFAULT_FOV - level.fromFov) * t);
  if (sceneUp) {
    // CameraControls stores its orbit relative to camera.up, so turning up alone would swing the camera around the
    // target. Re-placing both the current and the drag's destination pose after the turn keeps the camera where it is
    // and lets the drag carry on toward where it was heading.
    const position = controls.getPosition(new Vector3(), false);
    const target = controls.getTarget(new Vector3(), false);
    const endPosition = controls.getPosition(new Vector3(), true);
    const endTarget = controls.getTarget(new Vector3(), true);

    // Turned at a steady rate rather than blended. A straight blend between two up directions nearly opposite each
    // other, as after an upside-down photo, passes close to zero halfway and spins the view.
    const turn = new Quaternion().setFromUnitVectors(level.from.clone().normalize(), sceneUp.clone().normalize());
    camera.up.copy(level.from).applyQuaternion(new Quaternion().slerp(turn, t));
    controls.updateCameraUp();
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
    void controls.setLookAt(endPosition.x, endPosition.y, endPosition.z, endTarget.x, endTarget.y, endTarget.z, true);
  }

  return level.elapsed === LEVEL_SECONDS;
}

/**
 * Flies the view to each new selection's photo, landing on its position, direction and roll. The photo the page opens
 * on is placed there immediately. A pick from the grid flies, including a pick that is the first one this viewer
 * receives. A perspective camera also matches the photo's field of view. An orthographic camera matches that framing
 * with zoom. Once the visitor grabs the view, it levels back out to sceneUp and widens back to DEFAULT_FOV. The
 * orthographic camera has no field of view, so a level there only takes out the roll. sceneUp holds the up direction
 * the viewer's framing set, if it has run.
 *
 * A flight drives CameraControls to a new pose on every frame, so the controls stay the only thing placing the camera.
 * CameraControls keeps the view level to camera.up, so a flight turns camera.up along with the view to take on the
 * photo's roll, and levelling turns it back.
 */
export function useCameraFlight(
  cameras: Omit<CameraPose, "photoId">[] | null,
  selectedCamera: CameraSelection | null,
  sceneUp: RefObject<Vector3 | null>,
  // The point the photos look toward, which each flight's orbit target lines up with. Null when their axes don't pin
  // one down, in which case a flight keeps whatever the view is already aimed at.
  captureTarget: Vector3 | null,
  // Called as the visitor moves the view by hand, which leaves the selected photo's view behind.
  onManualMove?: () => void,
) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as CameraControls | null;
  const perspective = camera instanceof PerspectiveCamera ? camera : null;
  // Read when a flight starts, rather than depended on, so resizing the window doesn't restart it.
  const sizeRef = useLatestRef(useThree(state => state.size));

  const flightRef = useRef<Flight | null>(null);
  const levelRef = useRef<Level | null>(null);
  const flownRef = useRef<CameraSelection | null>(null);
  // Set once a frame has drawn the opening photo. Until then that photo is placed again if the controls are rebuilt,
  // which happens once at start-up. A pick from the grid flies even when no photo has been placed yet.
  const openingSettledRef = useRef(false);
  // Whether a flight has turned or zoomed the view since it last levelled out. Only a flight's roll and zoom
  // are undone, so a view placed some other way, such as the viewer's front, side or top view, keeps its own up.
  const flownSinceLevelRef = useRef(false);

  // Clearing the selection stops a flight where it is, so whatever cleared it can place the camera instead. The
  // flight's roll is no longer waiting to be undone, so a front, side or top view keeps its own up. A drag still
  // levels: it starts the level before this runs.
  useEffect(() => {
    if (!selectedCamera) {
      flightRef.current = null;
      flownSinceLevelRef.current = false;
    }
  }, [selectedCamera]);

  useEffect(() => {
    const photo = selectedCamera ? cameras?.[selectedCamera.index] : undefined;
    const opening = selectedCamera?.opening === true;

    // The same pick is not flown twice. The opening photo is the exception until a frame has drawn it, so the controls
    // rebuilt at start-up get that pose too.
    if (!controls || !photo || (flownRef.current === selectedCamera && (!opening || openingSettledRef.current))) {
      return;
    }

    const to = photoViewPose(photo, captureTarget ?? controls.getTarget(new Vector3()));
    let fromFov = DEFAULT_FOV;
    let toFov = DEFAULT_FOV;
    const fromZoom = camera.zoom;
    let toZoom = camera.zoom;
    let orthographic = false;

    if (perspective) {
      fromFov = perspective.fov;
      toFov = fittedFov(photo, perspective.aspect);
    } else if (camera instanceof OrthographicCamera) {
      orthographic = true;
      const frustumHeight = camera.top - camera.bottom;
      if (frustumHeight > 0) {
        const aspect = sizeRef.current.width / Math.max(sizeRef.current.height, 1);
        toZoom = orthographicZoom(frustumHeight, photo, to.distance, aspect);
      }
    } else {
      return;
    }

    flownRef.current = selectedCamera;
    flownSinceLevelRef.current = true;
    levelRef.current = null;
    if (opening && !openingSettledRef.current) {
      flightRef.current = null;
      placePose(to, toFov, toZoom, orthographic, camera, perspective, controls);
      return;
    }

    flightRef.current = {
      from: { position: camera.position.clone(), quaternion: camera.quaternion.clone(), distance: controls.distance },
      to,
      fromFov,
      toFov,
      fromZoom,
      toZoom,
      orthographic,
      elapsed: 0,
    };
  }, [camera, perspective, controls, cameras, captureTarget, selectedCamera, sizeRef]);

  const isClickPress = useClickPress();

  // Moving the view by hand ends a flight where it is, starts levelling out whatever roll and zoom it took on, and
  // leaves the selected photo's view behind. This listens for "control", which every drag and wheel step fires, rather
  // than "controlstart", which the wheel never fires and a plain press fires before the view has moved at all.
  //
  // A press counts only once it has moved further than a click allows. A press that only wobbles a pixel would
  // otherwise leave the selected photo's view before the visitor has dragged.
  useEffect(() => {
    if (!controls) {
      return;
    }

    const handleControl = () => {
      if (isClickPress()) {
        return;
      }

      flightRef.current = null;

      const up = sceneUp.current;
      const rolled = up !== null && camera.up.angleTo(up) > 1e-4;
      // Zooming back out needs a field of view. The orthographic camera only has the roll to undo.
      const fovOff = perspective !== null && perspective.fov !== DEFAULT_FOV;
      if (flownSinceLevelRef.current && !levelRef.current && (rolled || fovOff)) {
        flownSinceLevelRef.current = false;
        levelRef.current = { from: camera.up.clone(), fromFov: perspective?.fov ?? DEFAULT_FOV, elapsed: 0 };
      }

      onManualMove?.();
    };
    controls.addEventListener("control", handleControl);

    return () => controls.removeEventListener("control", handleControl);
  }, [camera, perspective, controls, sceneUp, onManualMove, isClickPress]);

  // A flight belongs to the camera it started on. Switching between perspective and orthographic drops it. The new
  // camera keeps the pose it already had. A level already turning the view upright keeps going.
  useEffect(() => {
    const flight = flightRef.current;
    if (flight && flight.orthographic !== !perspective) {
      flightRef.current = null;
    }
  }, [perspective]);

  useFrame((_state, delta) => {
    if (flownRef.current?.opening) {
      openingSettledRef.current = true;
    }

    if (!controls) {
      return;
    }

    if (flightRef.current && stepFlight(flightRef.current, delta, camera, perspective, controls)) {
      flightRef.current = null;
    }

    if (levelRef.current && stepLevel(levelRef.current, delta, sceneUp.current, camera, perspective, controls)) {
      levelRef.current = null;
    }
  });
}
