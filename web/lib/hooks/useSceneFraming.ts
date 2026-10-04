/**
 * Decides where the 3D view's camera starts.
 *
 * Frames the object from the photos' own camera positions when they're known, or from the first 3D file's bounding box
 * until they are. It runs inside the viewer's React Three Fiber canvas, and hands web/lib/hooks/useCameraFlight.ts the
 * up direction it chose.
 */

"use client";

import type { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Box3, Vector3 } from "three";

import type { Framing } from "@/components/viewer/cameraFraming";

/**
 * Places the camera where it starts, once per viewer: switching the view mode never re-frames. That's what makes "same
 * camera pose across a mode switch" hold with no manual save/restore: both assets share one coordinate frame, since
 * worker/pipeline/train.py seeds Gaussian means directly from COLMAP's points_xyz with no rescale.
 *
 * fromCameras is the pose framing the viewer already worked out. Otherwise the first asset to load frames it by its
 * bounding box, which the scene reports through onFirstLoad. The poses arrive separately from either asset, so when
 * they land after a bounding-box framing they replace it, once.
 *
 * onFirstLoad keeps one identity, since each scene's load effect depends on it. sceneUpRef holds the up direction the
 * framing set, which orbiting returns to after a flight has taken on a photo's roll.
 */
export function useSceneFraming(fromCameras: Framing | null) {
  const camera = useThree(state => state.camera);

  // CameraControls' makeDefault registers it here. drei's PerspectiveCamera takes over as the default camera only after
  // the first render, so the controls are rebuilt around it once.
  const controls = useThree(state => state.controls) as CameraControls | null;
  const [framing, setFraming] = useState<(Omit<Framing, "up"> & { up?: Vector3 }) | null>(null);
  const framedByRef = useRef<"nothing" | "box" | "cameras">("nothing");
  const sceneUpRef = useRef<Vector3 | null>(null);
  // Each framing is re-applied to new controls only until a frame has been drawn with it, which covers the controls
  // rebuilt at start-up. A camera mounted after that, as on a switch between perspective and orthographic, takes over
  // the view the last one had instead (ProjectionHandoff in web/components/viewer/SplatViewer.tsx).
  const appliedRef = useRef<typeof framing>(null);
  const drawnRef = useRef(false);
  useFrame(() => {
    if (appliedRef.current) {
      drawnRef.current = true;
    }
  });

  useEffect(() => {
    if (!controls || !framing || (appliedRef.current === framing && drawnRef.current)) {
      return;
    }

    appliedRef.current = framing;
    drawnRef.current = false;
    if (framing.up) {
      camera.up.copy(framing.up);
      controls.updateCameraUp();
    }

    sceneUpRef.current = camera.up.clone();
    const { position, target } = framing;
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
  }, [camera, controls, framing]);

  useEffect(() => {
    if (fromCameras && framedByRef.current !== "cameras") {
      framedByRef.current = "cameras";
      setFraming(fromCameras);
    }
  }, [fromCameras]);

  const onFirstLoad = useCallback((box: Box3) => {
    if (framedByRef.current !== "nothing") {
      return;
    }

    framedByRef.current = "box";
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    setFraming({ position: new Vector3(center.x, center.y, center.z + radius * 2.5), target: center });
  }, []);

  return { sceneUpRef, onFirstLoad };
}
