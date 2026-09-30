import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Stage } from "@/lib/splatStage";
import { useStageNotification } from "../useStageNotification";

const ORIGINAL_TITLE = "AI Gaussian Splatter";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

function renderStages(first: Stage | undefined) {
  return renderHook(({ stage }: { stage: Stage | undefined }) => useStageNotification("Vase", stage), {
    initialProps: { stage: first },
  });
}

describe("useStageNotification", () => {
  beforeEach(() => {
    document.title = ORIGINAL_TITLE;
    setHidden(true);
  });

  afterEach(() => {
    setHidden(false);
  });

  it("marks the title when the cameras finish in a hidden tab", () => {
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "check" } });

    expect(document.title).toBe("The shape is ready to check · Vase");
  });

  it("marks the title when a build completes or a stage fails", () => {
    const { rerender } = renderStages({ kind: "building", progress: 90, startedAt: null });
    rerender({ stage: { kind: "complete" } });
    expect(document.title).toBe("Your 3D splat is ready · Vase");

    rerender({ stage: { kind: "placing_cameras" } });
    rerender({ stage: { kind: "failed", step: "cameras", message: null } });
    expect(document.title).toBe("Processing failed · Vase");
  });

  it("stays quiet for a splat that had already finished when the page opened", () => {
    const { rerender } = renderStages(undefined);
    rerender({ stage: { kind: "complete" } });

    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it("stays quiet for a cancel", () => {
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "cancelled", step: "cameras" } });

    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it("stays quiet while the tab is visible", () => {
    setHidden(false);
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "check" } });

    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it("names the running stage in the title and restores it afterwards", () => {
    const { rerender, unmount } = renderStages({ kind: "building", progress: 42, startedAt: null });
    expect(document.title).toBe("Building 42% · Vase");

    rerender({ stage: { kind: "building", progress: null, startedAt: null } });
    expect(document.title).toBe("Building · Vase");

    unmount();
    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it("keeps the finished title until the tab is seen", () => {
    const { rerender } = renderStages({ kind: "building", progress: 99, startedAt: null });
    rerender({ stage: { kind: "complete" } });
    expect(document.title).toBe("Your 3D splat is ready · Vase");

    act(() => setHidden(false));
    expect(document.title).toBe(ORIGINAL_TITLE);
  });
});
