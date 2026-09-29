import { useEffect, useState } from "react";

// An element's content-box width, kept current with a ResizeObserver. Pass the returned setter as the element's ref.
// The width is 0 until the element has rendered and been measured.
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
