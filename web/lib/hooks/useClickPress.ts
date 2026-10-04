/**
 * Tells a click on the 3D view apart from the start of a drag.
 *
 * Pressing the mouse on the view already turns it slightly. This hook watches the pointer, so
 * web/lib/hooks/useCameraFlight.ts can ignore that small movement and keep a selected photo's view until the press
 * becomes a drag.
 */

"use client";

import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";

// How far, in pixels, the pointer may move during a press before that press counts as a drag.
const CLICK_SLOP_PX = 4;

/**
 * Tracks the press in progress on the R3F canvas. The returned function is true while that press has stayed within
 * CLICK_SLOP_PX of where it started, so it can still end as a click, even though CameraControls turns the view a
 * little for it. It is false once the press has moved further, and when no press is in progress, as for a wheel step.
 */
export function useClickPress() {
  const canvas = useThree(state => state.gl.domElement);
  const pressRef = useRef<{ x: number; y: number; dragged: boolean } | null>(null);

  useEffect(() => {
    const handleDown = (event: PointerEvent) => {
      pressRef.current = { x: event.clientX, y: event.clientY, dragged: false };
    };

    const handleMove = (event: PointerEvent) => {
      const press = pressRef.current;
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) {
        press.dragged = true;
      }
    };

    const handleUp = () => {
      pressRef.current = null;
    };

    // The window's capture phase runs before CameraControls' own listeners on the document, so a move is measured
    // before the "control" event it causes reaches web/lib/hooks/useCameraFlight.ts.
    canvas.addEventListener("pointerdown", handleDown);
    window.addEventListener("pointermove", handleMove, { capture: true });
    window.addEventListener("pointerup", handleUp, { capture: true });

    return () => {
      canvas.removeEventListener("pointerdown", handleDown);
      window.removeEventListener("pointermove", handleMove, { capture: true });
      window.removeEventListener("pointerup", handleUp, { capture: true });
    };
  }, [canvas]);

  return useCallback(() => pressRef.current !== null && !pressRef.current.dragged, []);
}
