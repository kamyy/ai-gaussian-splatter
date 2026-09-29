import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "@/lib/splatStage";
import { useStageNotification } from "../useStageNotification";

const notifications: Array<{ title: string; body?: string }> = [];

class FakeNotification {
  static permission: NotificationPermission = "granted";
  onclick: (() => void) | null = null;

  constructor(title: string, options?: NotificationOptions) {
    notifications.push({ title, body: options?.body });
  }

  close() {}
}

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
    notifications.length = 0;
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    document.title = "AI Gaussian Splatter";
    setHidden(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setHidden(false);
  });

  it("notifies once when the cameras finish in a hidden tab", () => {
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "check" } });
    rerender({ stage: { kind: "check" } });

    expect(notifications).toStrictEqual([{ title: "The shape is ready to check", body: "Vase" }]);
  });

  it("notifies when a build completes or a stage fails", () => {
    const { rerender } = renderStages({ kind: "building", progress: 90, startedAt: null });
    rerender({ stage: { kind: "complete" } });
    rerender({ stage: { kind: "placing_cameras" } });
    rerender({ stage: { kind: "failed", step: "cameras", message: null } });

    expect(notifications.map(n => n.title)).toStrictEqual(["Your 3D splat is ready", "Processing failed"]);
  });

  it("stays quiet for a splat that had already finished when the page opened", () => {
    const { rerender } = renderStages(undefined);
    rerender({ stage: { kind: "complete" } });

    expect(notifications).toStrictEqual([]);
  });

  it("stays quiet for a cancel", () => {
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "cancelled", step: "cameras" } });

    expect(notifications).toStrictEqual([]);
  });

  it("stays quiet while the tab is visible", () => {
    setHidden(false);
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "check" } });

    expect(notifications).toStrictEqual([]);
  });

  it("sends no notification without permission, but still marks the title", () => {
    FakeNotification.permission = "default";
    const { rerender } = renderStages({ kind: "placing_cameras" });
    rerender({ stage: { kind: "check" } });

    expect(notifications).toStrictEqual([]);
    expect(document.title).toBe("The shape is ready to check · Vase");
  });

  it("survives a browser that refuses to construct a notification, and still marks the title", () => {
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        constructor() {
          throw new TypeError("Illegal constructor");
        }
      },
    );
    const { rerender } = renderStages({ kind: "placing_cameras" });

    expect(() => rerender({ stage: { kind: "check" } })).not.toThrow();
    expect(document.title).toBe("The shape is ready to check · Vase");
  });

  it("names the running stage in the title and restores it afterwards", () => {
    const { rerender, unmount } = renderStages({ kind: "building", progress: 42, startedAt: null });
    expect(document.title).toBe("Building 42% · Vase");

    rerender({ stage: { kind: "building", progress: null, startedAt: null } });
    expect(document.title).toBe("Building · Vase");

    unmount();
    expect(document.title).toBe("AI Gaussian Splatter");
  });

  it("keeps the finished title until the tab is seen", () => {
    const { rerender } = renderStages({ kind: "building", progress: 99, startedAt: null });
    rerender({ stage: { kind: "complete" } });
    expect(document.title).toBe("Your 3D splat is ready · Vase");

    act(() => setHidden(false));
    expect(document.title).toBe("AI Gaussian Splatter");
  });
});
