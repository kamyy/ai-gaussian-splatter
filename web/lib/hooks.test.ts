import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useJobStatus, useSplat, useSplats } from "./hooks";
import { JOB_ENDED_STATUSES, type JobRead, type JobStatus } from "./types";

// Clerk resolves getToken() to null once it has loaded without a session, so the token is mutable here rather than a
// fixed string.
const { auth } = vi.hoisted(() => ({ auth: { token: "test-token" as string | null } }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => auth.token }),
}));

// Mocked so a fetcher that skipped the token guard fails the test rather than reaching fetch() and rejecting on jsdom's
// absent network for the wrong reason.
const { getLatestJobMock, getSplatMock, listSplatsMock } = vi.hoisted(() => ({
  getLatestJobMock: vi.fn<(token: string, ...rest: string[]) => Promise<unknown>>(),
  getSplatMock: vi.fn<(token: string, ...rest: string[]) => Promise<unknown>>(),
  listSplatsMock: vi.fn<(token: string, ...rest: string[]) => Promise<unknown>>(),
}));
vi.mock("./api", () => ({
  getLatestJob: getLatestJobMock,
  getSplat: getSplatMock,
  listSplats: listSplatsMock,
}));

interface JobPollConfig {
  refreshInterval: (latest: JobRead | undefined) => number;
}

// SWR is stubbed so the config it receives can be inspected directly — that config is the contract under test, not
// anything SWR does with it.
const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn<(key: unknown, fetcher: unknown, config: JobPollConfig) => { data: undefined }>(),
}));
vi.mock("swr", () => ({ default: useSWRMock }));

function capturedConfig(callIndex = 0) {
  return useSWRMock.mock.calls[callIndex][2];
}

function runFetcher(callIndex = 0) {
  return (useSWRMock.mock.calls[callIndex][1] as () => Promise<unknown>)();
}

const baseJob: JobRead = {
  id: "job-1",
  splatId: "splat-1",
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
    // SWR keys its polling effect on this function's identity. A fresh closure per render tears down the pending
    // timeout and restarts the interval, so a page re-rendering faster than the interval would never poll at all.
    const { rerender } = renderHook(() => useJobStatus("splat-1"));
    rerender();
    rerender();

    expect(useSWRMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(capturedConfig(1).refreshInterval).toBe(capturedConfig(0).refreshInterval);
    expect(capturedConfig(2).refreshInterval).toBe(capturedConfig(0).refreshInterval);
  });

  it("keeps polling while no job has been fetched yet", () => {
    renderHook(() => useJobStatus("splat-1"));
    expect(capturedConfig().refreshInterval(undefined)).toBeGreaterThan(0);
  });

  it("keeps polling while the job is still running", () => {
    renderHook(() => useJobStatus("splat-1"));
    const { refreshInterval } = capturedConfig();

    for (const status of ["queued", "launching", "colmap_running", "training_running", "uploading_result"] as const) {
      expect(refreshInterval({ ...baseJob, status })).toBeGreaterThan(0);
    }
  });

  it("polls faster as the job approaches completion", () => {
    // Never speeds up then slows down again — a later phase polling slower than an earlier one would only add latency.
    renderHook(() => useJobStatus("splat-1"));
    const { refreshInterval } = capturedConfig();

    const intervals = (["queued", "launching", "colmap_running", "training_running", "uploading_result"] as const).map(
      status => refreshInterval({ ...baseJob, status }),
    );

    expect(intervals.every(interval => interval > 0)).toBe(true);
    expect(intervals).toStrictEqual([...intervals].sort((a, b) => b - a));
    expect(intervals.at(-1)).toBeLessThan(intervals[0]);
  });

  it("stops polling once the job has ended", () => {
    renderHook(() => useJobStatus("splat-1"));
    const { refreshInterval } = capturedConfig();

    // Derived, so a status added to JOB_ENDED_STATUSES without a zero interval fails here.
    for (const status of JOB_ENDED_STATUSES as readonly JobStatus[]) {
      expect(refreshInterval({ ...baseJob, status })).toBe(0);
    }
  });
});

describe("session token guard", () => {
  // render is widened to unknown because the three hooks return differently typed SWR responses, and only the call is
  // under test here.
  const hooks: { name: string; render: () => unknown; api: typeof listSplatsMock }[] = [
    { name: "useSplats", render: () => useSplats(), api: listSplatsMock },
    { name: "useSplat", render: () => useSplat("splat-1"), api: getSplatMock },
    { name: "useJobStatus", render: () => useJobStatus("splat-1"), api: getLatestJobMock },
  ];

  beforeEach(() => {
    useSWRMock.mockClear();
    useSWRMock.mockReturnValue({ data: undefined });
    for (const { api } of hooks) {
      api.mockClear();
      api.mockResolvedValue(undefined);
    }
    auth.token = "test-token";
  });

  it.each(hooks)("$name rejects without calling the API when the session has ended", async ({ render, api }) => {
    // Rejecting is what puts SWR in its error state; resolving to an empty result instead would render as a signed-in
    // user with no data.
    auth.token = null;
    renderHook(render);

    await expect(runFetcher()).rejects.toThrow("Not signed in");
    expect(api).not.toHaveBeenCalled();
  });

  it.each(hooks)("$name forwards the token once Clerk has a session", async ({ render, api }) => {
    renderHook(render);

    await expect(runFetcher()).resolves.toBeUndefined();
    expect(api.mock.calls[0][0]).toBe("test-token");
  });
});
