import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia — Mantine's color-scheme detection
// needs it, so component tests using MantineProvider fail without this.
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
