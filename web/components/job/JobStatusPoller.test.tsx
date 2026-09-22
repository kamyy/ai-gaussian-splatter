import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/types";
import { theme } from "@/theme";
import { JobStatusPoller } from "./JobStatusPoller";

const { useLatestJobMock } = vi.hoisted(() => ({ useLatestJobMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useLatestJob: useLatestJobMock }));

function renderPoller() {
  return render(
    <ThemeProvider theme={theme}>
      <JobStatusPoller splatId="splat-1" />
    </ThemeProvider>,
  );
}

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: "cancelled",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// web/app/(authenticated)/splats/[id]/layout.tsx only mounts this component while the job fetch is in flight or
// once the job is "cancelled" — the only two states reachable in the app, so those are the only two covered here.
describe("JobStatusPoller", () => {
  it("shows a loading state while fetching", () => {
    useLatestJobMock.mockReturnValue({ data: undefined, isLoading: true });
    renderPoller();
    expect(screen.getByText(/Loading job status/i)).toBeInTheDocument();
  });

  it("shows a loading state if there is no job yet", () => {
    useLatestJobMock.mockReturnValue({ data: undefined, isLoading: false });
    renderPoller();
    expect(screen.getByText(/Loading job status/i)).toBeInTheDocument();
  });

  it("shows the cancelled chip once the job has ended cancelled", () => {
    useLatestJobMock.mockReturnValue({ data: baseJob, isLoading: false });
    renderPoller();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });
});
