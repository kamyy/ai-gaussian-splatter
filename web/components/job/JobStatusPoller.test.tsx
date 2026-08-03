import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { JobRead } from "@/lib/types";
import { JobStatusPoller } from "./JobStatusPoller";

const { useJobStatusMock } = vi.hoisted(() => ({ useJobStatusMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useJobStatus: useJobStatusMock }));

function renderPoller() {
  return render(
    <MantineProvider>
      <JobStatusPoller objectId="obj-1" />
    </MantineProvider>,
  );
}

const baseJob: JobRead = {
  id: "job-1",
  splatId: "obj-1",
  status: "TrainingRunning",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("JobStatusPoller", () => {
  it("shows a loading state while fetching", () => {
    useJobStatusMock.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
    renderPoller();
    expect(screen.getByText(/Loading job status/i)).toBeInTheDocument();
  });

  it("shows a fallback when there is no job yet", () => {
    useJobStatusMock.mockReturnValue({
      data: undefined,
      error: new Error("404"),
      isLoading: false,
    });
    renderPoller();
    expect(screen.getByText(/No processing job yet/i)).toBeInTheDocument();
  });

  it("renders the human-readable label for the current status", () => {
    useJobStatusMock.mockReturnValue({ data: baseJob, error: undefined, isLoading: false });
    renderPoller();
    expect(screen.getByText(/Training the Gaussian Splat/i)).toBeInTheDocument();
  });

  it("surfaces the error message when a job fails", () => {
    useJobStatusMock.mockReturnValue({
      data: { ...baseJob, status: "Failed", errorMessage: "COLMAP registered only 40% of photos" },
      error: undefined,
      isLoading: false,
    });
    renderPoller();
    expect(screen.getByText(/Processing failed/i)).toBeInTheDocument();
    expect(screen.getByText(/COLMAP registered only 40%/i)).toBeInTheDocument();
  });
});
