/**
 * Measures an element's width, and keeps measuring as it changes.
 *
 * Returns a setter to pass as the element's ref, and its content-box width, kept current with a ResizeObserver (the
 * browser API that reports size changes). The width is 0 until the element has rendered and been measured.
 */

import { useEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (element === null) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [element]);

  return [setElement, width] as const;
}
