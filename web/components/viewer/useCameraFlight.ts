"use client";

import type { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";

import type { CameraPose } from "@/lib/types";
import {
  easeInOutCubic,
  fittedFov,
  interpolatePose,
  orbitTargetOf,
  photoViewPose,
  type ViewPose,
} from "./cameraFlight";
import { framingFromCameras } from "./cameraFraming";

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

  const flightRef = useRef<{ from: ViewPose; to: ViewPose; fromFov: number; toFov: number; elapsed: number } | null>(
    null,
  );
  const levelRef = useRef<{ from: Vector3; fromFov: number; elapsed: number } | null>(null);
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

  // Moving the view by hand ends a flight where it is, starts levelling out whatever roll and zoom it took on, and
  // leaves the selected photo's view behind. This listens for "control", which every drag and wheel step fires, rather
  // than "controlstart", which the wheel never fires and a plain press fires before the view has moved at all. A click
  // that picks a frustum is exactly such a press.
  useEffect(() => {
    if (!controls) {
      return;
    }
    const handleControl = () => {
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
  }, [camera, perspective, controls, sceneUp, onManualMove]);

  function setFov(fov: number) {
    if (perspective && perspective.fov !== fov) {
      perspective.fov = fov;
      perspective.updateProjectionMatrix();
    }
  }

  useFrame((_state, delta) => {
    if (!controls) {
      return;
    }

    const flight = flightRef.current;
    if (flight) {
      flight.elapsed = Math.min(flight.elapsed + delta, FLIGHT_SECONDS);
      const t = easeInOutCubic(flight.elapsed / FLIGHT_SECONDS);
      const pose = interpolatePose(flight.from, flight.to, t);
      const target = orbitTargetOf(pose);
      setFov(flight.fromFov + (flight.toFov - flight.fromFov) * t);
      camera.up.set(0, 1, 0).applyQuaternion(pose.quaternion);
      controls.updateCameraUp();
      void controls.setLookAt(pose.position.x, pose.position.y, pose.position.z, target.x, target.y, target.z, false);
      if (flight.elapsed === FLIGHT_SECONDS) {
        flightRef.current = null;
      }
    }

    const level = levelRef.current;
    if (level) {
      level.elapsed = Math.min(level.elapsed + delta, LEVEL_SECONDS);
      const t = easeInOutCubic(level.elapsed / LEVEL_SECONDS);
      setFov(level.fromFov + (DEFAULT_FOV - level.fromFov) * t);
      const up = sceneUp.current;
      if (up) {
        // CameraControls stores its orbit relative to camera.up, so turning up alone would swing the camera around the
        // target. Re-placing both the current and the drag's destination pose after the turn keeps the camera where
        // it is and lets the drag carry on toward where it was heading.
        const position = controls.getPosition(new Vector3(), false);
        const target = controls.getTarget(new Vector3(), false);
        const endPosition = controls.getPosition(new Vector3(), true);
        const endTarget = controls.getTarget(new Vector3(), true);
        // Turned at a steady rate rather than blended. A straight blend between two up directions nearly opposite each
        // other, as after an upside-down photo, passes close to zero halfway and spins the view.
        const turn = new Quaternion().setFromUnitVectors(level.from.clone().normalize(), up.clone().normalize());
        camera.up.copy(level.from).applyQuaternion(new Quaternion().slerp(turn, t));
        controls.updateCameraUp();
        void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
        void controls.setLookAt(
          endPosition.x,
          endPosition.y,
          endPosition.z,
          endTarget.x,
          endTarget.y,
          endTarget.z,
          true,
        );
      }
      if (level.elapsed === LEVEL_SECONDS) {
        levelRef.current = null;
      }
    }
  });
}
