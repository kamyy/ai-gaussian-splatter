import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only auto-registers its cleanup when `globals: true`, which this project doesn't set. Without this,
// every render stays in the document and later tests match elements left behind by earlier ones.
//
// Unmounting a Radix dialog schedules a zero-delay timer in its focus scope, which dispatches an event on the removed
// element. When it fires after the last test of a file, jsdom is already torn down and Vitest reports an unhandled
// "dispatchEvent" error. Waiting one timer tick after cleanup lets that timer fire while jsdom is still alive.
afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
});

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
