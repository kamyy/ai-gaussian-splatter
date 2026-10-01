/**
 * Reports what the pointer is over only once it has rested there for a moment.
 *
 * For a hover effect too large to fire on every element the pointer crosses, such as the photo grid's enlarged photo.
 * Sweeping the pointer across the grid passes over many photos, and only the photo it stops on should react. The
 * Escape key dismisses a settled value too, which lets a keyboard or a still pointer put the effect away.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Call begin with a value when the pointer enters its element, and end when the pointer leaves. settled is that value
 * once delayMs has passed without an end or another begin, and null otherwise. Pressing Escape while settled ends it.
 * The pointer is still over the element then, so the value settles again only after the pointer leaves and re-enters.
 */
export function useHoverIntent<T>(delayMs: number) {
  const [settled, setSettled] = useState<T | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const begin = useCallback(
    (value: T) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setSettled(value);
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  const end = useCallback(() => {
    clearTimer();
    setSettled(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const isSettled = settled !== null;
  useEffect(() => {
    if (!isSettled) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        end();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSettled, end]);

  return { settled, begin, end };
}
