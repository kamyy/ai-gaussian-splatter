/**
 * Reports what the pointer is over only once it has rested there for a moment.
 *
 * For a hover effect too large to fire on every element the pointer crosses, such as the photo grid's enlarged photo.
 * Sweeping the pointer across the grid passes over many photos, and only the photo it stops on should react.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Call begin with a value when the pointer enters its element, and end when the pointer leaves. settled is that value
 * once delayMs has passed without an end or another begin, and null otherwise.
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

  return { settled, begin, end };
}
