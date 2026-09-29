import { useEffect, useRef } from "react";

// A ref holding the latest committed value, for an effect or cleanup that has to read value without re-running each
// time it changes.
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
