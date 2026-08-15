import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useJobStatus } from "./hooks";
import type { JobRead, JobStatus } from "./types";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

interface JobPollConfig {
  refreshInterval: (latest: JobRead | undefined) => number;
}

// SWR is stubbed so the config it receives can be inspected directly — that
// config is the contract under test, not anything SWR does with it.
const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn<(key: unknown, fetcher: unknown, config: JobPollConfig) => { data: undefined }>(),
}));
vi.mock("swr", () => ({ default: useSWRMock }));

function capturedConfig(callIndex = 0) {
  return useSWRMock.mock.calls[callIndex][2];
}

const baseJob: JobRead = {
  id: "job-1",
  splatId: "obj-1",
  status: "training_running",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("useJobStatus", () => {
  beforeEach(() => {
    useSWRMock.mockClear();
    useSWRMock.mockReturnValue({ data: undefined });
  });

  it("reuses one refreshInterval function across renders", () => {
    // SWR keys its polling effect on this function's identity. A fresh closure
    // per render tears down the pending timeout and restarts the interval, so
    // a page re-rendering faster than the interval would never poll at all.
    const { rerender } = renderHook(() => useJobStatus("obj-1"));
    rerender();
    rerender();

    expect(useSWRMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(capturedConfig(1).refreshInterval).toBe(capturedConfig(0).refreshInterval);
    expect(capturedConfig(2).refreshInterval).toBe(capturedConfig(0).refreshInterval);
  });

  it("keeps polling while no job has been fetched yet", () => {
    renderHook(() => useJobStatus("obj-1"));
    expect(capturedConfig().refreshInterval(undefined)).toBeGreaterThan(0);
  });

  it("keeps polling while the job is still running", () => {
    renderHook(() => useJobStatus("obj-1"));
    const { refreshInterval } = capturedConfig();

    for (const status of ["queued", "launching", "colmap_running", "training_running", "uploading_result"] as const) {
      expect(refreshInterval({ ...baseJob, status })).toBeGreaterThan(0);
    }
  });

  it("stops polling once the job has ended", () => {
    renderHook(() => useJobStatus("obj-1"));
    const { refreshInterval } = capturedConfig();

    for (const status of ["complete", "failed", "cancelled"] as JobStatus[]) {
      expect(refreshInterval({ ...baseJob, status })).toBe(0);
    }
  });

  it("passes a null key when there is no object, so nothing is fetched", () => {
    renderHook(() => useJobStatus(undefined));
    expect(useSWRMock.mock.calls[0][0]).toBeNull();
  });
});
