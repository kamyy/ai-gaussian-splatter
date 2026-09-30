import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHoverIntent } from "../useHoverIntent";

describe("useHoverIntent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles on a value only after the delay", () => {
    const { result } = renderHook(() => useHoverIntent<string>(120));

    act(() => result.current.begin("a"));
    act(() => void vi.advanceTimersByTime(119));
    expect(result.current.settled).toBeNull();

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.settled).toBe("a");
  });

  it("never settles on a value the pointer left before the delay", () => {
    const { result } = renderHook(() => useHoverIntent<string>(120));

    act(() => result.current.begin("a"));
    act(() => void vi.advanceTimersByTime(60));
    act(() => result.current.end());
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current.settled).toBeNull();
  });

  it("restarts the delay for each new value and clears on end", () => {
    const { result } = renderHook(() => useHoverIntent<string>(120));

    act(() => result.current.begin("a"));
    act(() => void vi.advanceTimersByTime(100));
    act(() => result.current.begin("b"));
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.settled).toBeNull();

    act(() => void vi.advanceTimersByTime(20));
    expect(result.current.settled).toBe("b");

    act(() => result.current.end());
    expect(result.current.settled).toBeNull();
  });
});
