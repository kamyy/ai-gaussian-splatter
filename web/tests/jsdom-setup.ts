import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only auto-registers its cleanup when `globals: true`, which this project doesn't set. Without this,
// every render stays in the document and later tests match elements left behind by earlier ones.
afterEach(cleanup);

// jsdom doesn't implement matchMedia, which next-themes probes for to detect the OS color-scheme preference.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
