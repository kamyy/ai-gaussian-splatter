import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEnlargedTile } from "../useEnlargedTile";

function pointer(pointerType: string) {
  return { pointerType } as React.PointerEvent;
}

describe("useEnlargedTile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enlarges a tile the mouse rests on, but never one a touch lands on", () => {
    const { result } = renderHook(() => useEnlargedTile(["a", "b"]));

    act(() => result.current.enter("a", pointer("touch")));
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.enlargedId).toBeNull();

    act(() => result.current.enter("a", pointer("mouse")));
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current.enlargedId).toBe("a");

    act(() => result.current.leave());
    expect(result.current.enlargedId).toBeNull();
  });

  it("clears the enlargement once its tile is no longer shown", () => {
    const { result, rerender } = renderHook(({ shownIds }) => useEnlargedTile(shownIds), {
      initialProps: { shownIds: ["a", "b"] },
    });
    act(() => result.current.enter("a", pointer("mouse")));
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current.enlargedId).toBe("a");

    rerender({ shownIds: ["c", "d"] });
    expect(result.current.enlargedId).toBeNull();
  });
});
