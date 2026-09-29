/**
 * A ref that always holds a value's latest version.
 *
 * For an effect or a cleanup that has to read a value without re-running every time that value changes. The ref is
 * updated after each render commits.
 */

import { useEffect, useRef } from "react";

export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
