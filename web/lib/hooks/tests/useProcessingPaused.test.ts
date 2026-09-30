import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProcessingStatus } from "@/lib/types";
import { useProcessingPaused } from "../useProcessingPaused";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

// SWR is stubbed so each case can hand the hook a response directly.
const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn<(key: unknown, fetcher: unknown, config: unknown) => { data: ProcessingStatus | undefined }>(),
}));
vi.mock("swr", () => ({ default: useSWRMock }));

describe("useProcessingPaused", () => {
  beforeEach(() => {
    useSWRMock.mockReset();
  });

  it("is paused only once the server says processing is off", () => {
    useSWRMock.mockReturnValue({ data: { enabled: false } });

    expect(renderHook(() => useProcessingPaused()).result.current).toBe(true);
  });

  it("is not paused while processing is on", () => {
    useSWRMock.mockReturnValue({ data: { enabled: true } });

    expect(renderHook(() => useProcessingPaused()).result.current).toBe(false);
  });

  // Otherwise every page load would flash the paused notice before the first answer arrived.
  it("is not paused before the first answer", () => {
    useSWRMock.mockReturnValue({ data: undefined });

    expect(renderHook(() => useProcessingPaused()).result.current).toBe(false);
  });

  it("polls once a minute, matching the server's cache", () => {
    useSWRMock.mockReturnValue({ data: undefined });

    renderHook(() => useProcessingPaused());

    expect(useSWRMock).toHaveBeenCalledWith("processing", expect.any(Function), { refreshInterval: 60_000 });
  });
});
