/**
 * Flies the 3D view to a picked photo's viewpoint, and levels it out again afterwards.
 *
 * When the visitor picks a photo, the view animates to where that photo was taken, matching its angle and zoom, so the
 * 3D scene lines up with the photo. Once the visitor drags the view away, it tilts back upright and zooms back out.
 * This runs inside the viewer's React Three Fiber canvas, animating a little every frame.
 */

"use client";

import type { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { type Camera, PerspectiveCamera, Quaternion, Vector3 } from "three";

import {
  easeInOutCubic,
  fittedFov,
  interpolatePose,
  orbitTargetOf,
  photoViewPose,
  type ViewPose,
} from "@/components/viewer/cameraFlight";
import { framingFromCameras } from "@/components/viewer/cameraFraming";
import { useClickPress } from "@/lib/hooks/useClickPress";
import type { CameraPose } from "@/lib/types";

// How long the camera takes to fly to a selected photo's view.
const FLIGHT_SECONDS = 0.8;
// How long the view takes to level out and zoom back out once the visitor starts orbiting away from a photo's view.
const LEVEL_SECONDS = 0.4;
// The vertical field of view, in degrees, everywhere but a photo's view. R3F's own default camera has the same.
export const DEFAULT_FOV = 75;

// A camera picked by index into the viewer's cameras. Every new object flies the view there, so selecting the same
// camera again after orbiting away flies back to it.
export interface CameraSelection {
  index: number;
}

// A flight from the view the visitor had to a photo's view, including its field of view.
interface Flight {
  from: ViewPose;
  to: ViewPose;
  fromFov: number;
  toFov: number;
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
  const pose = interpolatePose(flight.from, flight.to, t);
  const target = orbitTargetOf(pose);
  setFov(perspective, flight.fromFov + (flight.toFov - flight.fromFov) * t);
  camera.up.set(0, 1, 0).applyQuaternion(pose.quaternion);
  controls.updateCameraUp();
  void controls.setLookAt(pose.position.x, pose.position.y, pose.position.z, target.x, target.y, target.z, false);
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
 * Flies the view to each new selection's photo, landing on its position, direction, roll and field of view. Once the
 * visitor grabs the view, it levels back out to sceneUp and widens back to DEFAULT_FOV. sceneUp holds the up direction
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
  // Called as the visitor moves the view by hand, which leaves the selected photo's view behind.
  onManualMove?: () => void,
) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as CameraControls | null;
  const perspective = camera instanceof PerspectiveCamera ? camera : null;
  // The point the photos look toward, which each flight's orbit target lines up with.
  const captureTarget = useMemo(() => (cameras ? (framingFromCameras(cameras)?.target ?? null) : null), [cameras]);

  const flightRef = useRef<Flight | null>(null);
  const levelRef = useRef<Level | null>(null);
  const flownRef = useRef<CameraSelection | null>(null);

  useEffect(() => {
    const photo = selectedCamera ? cameras?.[selectedCamera.index] : undefined;
    // The controls are rebuilt once after the first render, which must not restart a flight already under way.
    if (!controls || !photo || flownRef.current === selectedCamera) {
      return;
    }
    flownRef.current = selectedCamera;
    levelRef.current = null;
    flightRef.current = {
      from: { position: camera.position.clone(), quaternion: camera.quaternion.clone(), distance: controls.distance },
      to: photoViewPose(photo, captureTarget ?? controls.getTarget(new Vector3())),
      fromFov: perspective?.fov ?? DEFAULT_FOV,
      toFov: perspective ? fittedFov(photo, perspective.aspect) : DEFAULT_FOV,
      elapsed: 0,
    };
  }, [camera, perspective, controls, cameras, captureTarget, selectedCamera]);

  const isClickPress = useClickPress();

  // Moving the view by hand ends a flight where it is, starts levelling out whatever roll and zoom it took on, and
  // leaves the selected photo's view behind. This listens for "control", which every drag and wheel step fires, rather
  // than "controlstart", which the wheel never fires and a plain press fires before the view has moved at all.
  //
  // A press counts only once it has moved further than a click allows. Otherwise a click on a frustum that wobbles a
  // pixel would clear the selection mid-click, and the pick mesh rebuilt for the cleared selection is not the object
  // R3F saw pressed, so the click would never arrive.
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
      const fov = perspective?.fov ?? DEFAULT_FOV;
      if (!levelRef.current && ((up && camera.up.angleTo(up) > 1e-4) || fov !== DEFAULT_FOV)) {
        levelRef.current = { from: camera.up.clone(), fromFov: fov, elapsed: 0 };
      }
      onManualMove?.();
    };
    controls.addEventListener("control", handleControl);
    return () => controls.removeEventListener("control", handleControl);
  }, [camera, perspective, controls, sceneUp, onManualMove, isClickPress]);

  useFrame((_state, delta) => {
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
