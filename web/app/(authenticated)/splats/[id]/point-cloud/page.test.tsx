import { ThemeProvider } from "@mui/material/styles";
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/types";
import { theme } from "@/theme";
import PointCloudPage from "./page";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

// The viewer pulls in three.js, R3F and gaussian-splats-3d, none of which have a WebGL context under jsdom. Only its
// presence is under test here.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({ pointCloudUrl }: { pointCloudUrl: string | null }) => (
    <div data-testid="splat-viewer">{pointCloudUrl}</div>
  ),
  SplatViewerLoading: () => <div data-testid="splat-loading" />,
}));

const { useLatestJobMock } = vi.hoisted(() => ({ useLatestJobMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useLatestJob: useLatestJobMock }));

const { useSWRMock } = vi.hoisted(() => ({ useSWRMock: vi.fn() }));
vi.mock("swr", () => ({ default: useSWRMock }));

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: "awaiting_training",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: "splats/x/point_cloud.ply",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

async function renderPage() {
  await act(async () => {
    render(
      <ThemeProvider theme={theme}>
        <Suspense fallback={null}>
          <PointCloudPage params={Promise.resolve({ id: "splat-1" })} />
        </Suspense>
      </ThemeProvider>,
    );
  });
}

describe("PointCloudPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the awaiting-training panel while paused for review", async () => {
    useLatestJobMock.mockReturnValue({ data: baseJob, error: undefined, isLoading: false, mutate: vi.fn() });
    useSWRMock.mockReturnValue({ data: "https://s3/point_cloud.ply", error: undefined, mutate: vi.fn() });

    await renderPage();

    expect(screen.getByText(/Review the point cloud below/i)).toBeInTheDocument();
  });

  it("shows a checking message while the point cloud presign hasn't arrived yet", async () => {
    useLatestJobMock.mockReturnValue({ data: baseJob, error: undefined, isLoading: false, mutate: vi.fn() });
    useSWRMock.mockReturnValue({ data: undefined, error: new Error("404"), mutate: vi.fn() });

    await renderPage();

    expect(screen.getByText(/isn't ready yet/i)).toBeInTheDocument();
  });

  it("renders the plain viewer once training has moved past the review pause", async () => {
    // Set once by the reconstruct phase and never cleared, so the point cloud stays viewable through training and
    // after completion, not just during the awaiting_training pause.
    useLatestJobMock.mockReturnValue({
      data: { ...baseJob, status: "training_running" },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });
    useSWRMock.mockReturnValue({ data: "https://s3/point_cloud.ply", error: undefined, mutate: vi.fn() });

    await renderPage();

    expect(screen.getByTestId("splat-viewer")).toHaveTextContent("https://s3/point_cloud.ply");
  });
});
