import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_ENDED_STATUSES, JOB_STATUSES, type JobStatus } from "@/lib/statuses";
import type { Job } from "@/lib/types";
import { useLatestJob } from "../useLatestJob";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: "training_running",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  colmapBootedAt: null,
  colmapStartedAt: null,
  colmapFinishedAt: null,
  trainingLaunchedAt: null,
  trainingBootedAt: null,
  trainingStartedAt: null,
  trainingProgress: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// SWR is stubbed so the config it receives can be inspected directly. That config is the contract under test, not
// anything SWR does with it.
const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn<(key: unknown, fetcher: unknown, config: JobPollConfig) => { data: undefined }>(),
}));
vi.mock("swr", () => ({ default: useSWRMock }));

interface JobPollConfig {
  refreshInterval: (latest: Job | undefined) => number;
  refreshWhenHidden?: boolean;
}

function capturedConfig(callIndex = 0) {
  return useSWRMock.mock.calls[callIndex][2];
}

describe("useLatestJob", () => {
  beforeEach(() => {
    useSWRMock.mockClear();
    useSWRMock.mockReturnValue({ data: undefined });
  });

  it("reuses one refreshInterval function across renders", () => {
    // SWR keys its polling effect on this function's identity. A fresh closure per render tears down the pending
    // timeout and restarts the interval, so a page re-rendering faster than the interval would never poll at all.
    const { rerender } = renderHook(() => useLatestJob("splat-1"));
    rerender();
    rerender();

    expect(useSWRMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(capturedConfig(1).refreshInterval).toBe(capturedConfig(0).refreshInterval);
    expect(capturedConfig(2).refreshInterval).toBe(capturedConfig(0).refreshInterval);
  });

  it("keeps polling in a background tab", () => {
    // The tab title only announces a finished stage for a transition a poll has seen, and a visitor who switched tabs
    // is the one it's for.
    renderHook(() => useLatestJob("splat-1"));
    expect(capturedConfig().refreshWhenHidden).toBe(true);
  });

  it("keeps polling while no job has been fetched yet", () => {
    renderHook(() => useLatestJob("splat-1"));
    expect(capturedConfig().refreshInterval(undefined)).toBeGreaterThan(0);
  });

  it("polls faster as the job approaches completion", () => {
    // Polling never speeds up and then slows down again. A later phase polling slower than an earlier one would only
    // add latency.
    renderHook(() => useLatestJob("splat-1"));
    const { refreshInterval } = capturedConfig();

    const intervals = (
      ["queued", "launching", "reconstruction_running", "training_running", "uploading_result"] as const
    ).map(status => refreshInterval({ ...baseJob, status }));

    expect(intervals.every(interval => interval > 0)).toBe(true);
    expect(intervals).toStrictEqual([...intervals].sort((a, b) => b - a));
    expect(intervals.at(-1)).toBeLessThan(intervals[0]);
  });

  it("stops polling once the job has ended, and only then", () => {
    // SWR keys its polling effect on the refreshInterval function's identity, not on the data, so returning 0 stops
    // polling for the life of the mounted hook. A later mutate() does not restart the timer. Any non-terminal status
    // returning 0 would therefore freeze the UI for the rest of the job. The cases are derived from the status lists,
    // so a new status can't be added with the wrong interval.
    renderHook(() => useLatestJob("splat-1"));
    const { refreshInterval } = capturedConfig();

    for (const status of JOB_STATUSES as readonly JobStatus[]) {
      if (JOB_ENDED_STATUSES.includes(status)) {
        expect(refreshInterval({ ...baseJob, status })).toBe(0);
      } else {
        expect(refreshInterval({ ...baseJob, status })).toBeGreaterThan(0);
      }
    }
  });
});
