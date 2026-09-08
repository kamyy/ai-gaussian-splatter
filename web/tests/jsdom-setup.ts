import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only auto-registers its cleanup when `globals: true`, which this project doesn't set. Without this,
// every render stays in the document and later tests match elements left behind by earlier ones.
afterEach(cleanup);

// jsdom doesn't implement matchMedia. Mantine's color-scheme detection needs it, so component tests using
// MantineProvider fail without this.
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

// jsdom doesn't implement ResizeObserver either. Mantine's SegmentedControl uses one (FloatingIndicator, to track the
// active segment's size) — never needed until this component's first use in the app.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
