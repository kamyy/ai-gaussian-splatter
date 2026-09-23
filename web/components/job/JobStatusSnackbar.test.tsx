import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/types";
import { JobStatusSnackbar } from "./JobStatusSnackbar";

const { useLatestJobMock } = vi.hoisted(() => ({ useLatestJobMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useLatestJob: useLatestJobMock }));

const { enqueueSnackbarMock, closeSnackbarMock } = vi.hoisted(() => ({
  enqueueSnackbarMock: vi.fn(),
  closeSnackbarMock: vi.fn(),
}));
vi.mock("@/lib/useAppSnackbar", () => ({
  useAppSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock, closeSnackbar: closeSnackbarMock }),
}));

function renderSnackbar() {
  return render(<JobStatusSnackbar splatId="splat-1" />);
}

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: "reconstruction_running",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("JobStatusSnackbar", () => {
  beforeEach(() => {
    enqueueSnackbarMock.mockClear();
    closeSnackbarMock.mockClear();
  });

  it("enqueues a message while the worker is launching", () => {
    useLatestJobMock.mockReturnValue({ data: { ...baseJob, status: "launching" } });
    renderSnackbar();

    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      "Starting GPU worker…",
      expect.objectContaining({
        variant: "info",
        persist: true,
        progress: true,
        key: expect.stringMatching(/^job-stage-/),
      }),
    );
  });

  it("enqueues a message while reconstructing", () => {
    useLatestJobMock.mockReturnValue({ data: baseJob });
    renderSnackbar();

    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      "Reconstructing camera positions (COLMAP)…",
      expect.objectContaining({
        variant: "info",
        persist: true,
        progress: true,
        key: expect.stringMatching(/^job-stage-/),
      }),
    );
  });

  it("enqueues a message while training", () => {
    useLatestJobMock.mockReturnValue({ data: { ...baseJob, status: "training_running" } });
    renderSnackbar();

    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      "Training the Gaussian Splat…",
      expect.objectContaining({
        variant: "info",
        persist: true,
        progress: true,
        key: expect.stringMatching(/^job-stage-/),
      }),
    );
  });

  it("closes the previous stage snackbar under its own key when the stage changes", () => {
    useLatestJobMock.mockReturnValue({ data: baseJob });
    const { rerender } = renderSnackbar();
    const firstKey = enqueueSnackbarMock.mock.calls[0][1].key;

    useLatestJobMock.mockReturnValue({ data: { ...baseJob, status: "training_running" } });
    rerender(<JobStatusSnackbar splatId="splat-1" />);

    const secondKey = enqueueSnackbarMock.mock.calls[1][1].key;
    expect(firstKey).not.toBe(secondKey);
    expect(closeSnackbarMock).toHaveBeenCalledWith(firstKey);
    expect(enqueueSnackbarMock).toHaveBeenLastCalledWith(
      "Training the Gaussian Splat…",
      expect.objectContaining({ variant: "info", persist: true, progress: true, key: secondKey }),
    );
  });

  // awaiting_training has its own review UI. Ended statuses are not an in-progress notice.
  it.each(["awaiting_training", "complete", "cancelled"] as const)("does not enqueue while %s", status => {
    useLatestJobMock.mockReturnValue({ data: { ...baseJob, status } });
    renderSnackbar();

    expect(closeSnackbarMock).not.toHaveBeenCalled();
    expect(enqueueSnackbarMock).not.toHaveBeenCalled();
  });

  it("does not enqueue with no job yet", () => {
    useLatestJobMock.mockReturnValue({ data: undefined });
    renderSnackbar();

    expect(closeSnackbarMock).not.toHaveBeenCalled();
    expect(enqueueSnackbarMock).not.toHaveBeenCalled();
  });

  it("still reports a failure with a generic message when the job carries no error message", () => {
    // useLatestJob stops polling once a job is "failed", and the internal status route ignores every callback once
    // a job has ended, so a message-less failed row can never later gain one — this must not stay silent for it.
    useLatestJobMock.mockReturnValue({ data: { ...baseJob, status: "failed", errorMessage: null } });
    renderSnackbar();

    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      "Processing failed.",
      expect.objectContaining({ variant: "error", preventDuplicate: true, key: "job-failed-job-1" }),
    );
  });

  it("enqueues a persistent error snackbar when a job fails", () => {
    useLatestJobMock.mockReturnValue({
      data: { ...baseJob, status: "failed", errorMessage: "COLMAP registered only 40% of photos" },
    });
    renderSnackbar();

    // persist is useAppSnackbar's job (web/lib/tests/useAppSnackbar.test.ts), not asserted again here.
    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      "Processing failed: COLMAP registered only 40% of photos",
      expect.objectContaining({ variant: "error", preventDuplicate: true, key: "job-failed-job-1" }),
    );
  });
});
