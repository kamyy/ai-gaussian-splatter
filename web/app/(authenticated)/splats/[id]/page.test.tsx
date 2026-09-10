import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, Splat, SplatStatus } from "@/lib/types";
import SplatDetailPage from "./page";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

// The viewer pulls in three.js, R3F and gaussian-splats-3d, none of which have a WebGL context under jsdom. Only its
// presence is under test here.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({ splatUrl }: { splatUrl: string | null }) => <div data-testid="splat-viewer">{splatUrl}</div>,
  SplatViewerLoading: () => <div data-testid="splat-loading" />,
}));

const { useSplatMock, useLatestJobMock } = vi.hoisted(() => ({
  useSplatMock: vi.fn(),
  useLatestJobMock: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useSplat: useSplatMock, useLatestJob: useLatestJobMock }));

const { useSWRMock } = vi.hoisted(() => ({ useSWRMock: vi.fn() }));
vi.mock("swr", () => ({ default: useSWRMock }));

const baseSplat: Splat = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ceramic mug",
  status: "processing",
  thumbnailS3Key: null,
  isShareable: false,
  createdAt: "2026-01-01T00:00:00Z",
};

const baseJob: Job = {
  id: "job-1",
  splatId: baseSplat.id,
  status: "training_running",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const refetchSplat = vi.fn();
const refetchPresignedUrl = vi.fn(async () => undefined);

// The presigned URL's age is what the page uses to decide whether to re-mint it before a mode switch, so a fixture
// has to carry one. Fresh unless a test says otherwise.
function presigned(url: string, ageMs = 0) {
  return { url, fetchedAt: Date.now() - ageMs };
}

function setup(options: {
  splat?: Splat | undefined;
  splatStatus?: SplatStatus;
  splatError?: Error;
  job?: Job;
  splatFile?: { url: string; fetchedAt: number };
  splatFileError?: Error;
}) {
  const splat =
    options.splat === undefined && options.splatStatus === undefined
      ? undefined
      : { ...baseSplat, ...(options.splatStatus ? { status: options.splatStatus } : {}) };

  useSplatMock.mockReturnValue({
    data: splat,
    isLoading: false,
    error: options.splatError,
    mutate: refetchSplat,
  });
  useLatestJobMock.mockReturnValue({ data: options.job, error: undefined, isLoading: false, mutate: vi.fn() });
  useSWRMock.mockReturnValue({
    data: options.splatFile,
    error: options.splatFileError,
    mutate: refetchPresignedUrl,
  });
}

// The page reads `params` with React's `use()`, so it suspends on first render. RTL's own `act` scope is synchronous
// and cannot flush that. The render has to happen inside an awaited `act`.
async function renderPage() {
  await act(async () => {
    render(
      <MantineProvider>
        <Suspense fallback={null}>
          <SplatDetailPage params={Promise.resolve({ id: baseSplat.id })} />
        </Suspense>
      </MantineProvider>,
    );
  });
}

describe("SplatDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refetches the splat when the job ends, so the viewer can appear", async () => {
    // The worker's callback moves the job and splat rows together, but only the job is polled. Without this refetch
    // the page would sit on the poller.
    setup({ splatStatus: "processing", job: { ...baseJob, status: "complete" } });
    await renderPage();

    expect(refetchSplat).toHaveBeenCalled();
  });

  it("does not refetch while the job is still running", async () => {
    setup({ splatStatus: "processing", job: baseJob });
    await renderPage();

    expect(refetchSplat).not.toHaveBeenCalled();
  });

  it("keeps rendering a cached splat when a revalidation fails", async () => {
    // A transient failure of the completion refetch must not replace the whole page. `data` still holds the last good
    // splat.
    setup({ splatStatus: "complete", splatError: new Error("503"), splatFile: presigned("https://s3/splat.ply") });
    await renderPage();

    expect(screen.getByText("Ceramic mug")).toBeInTheDocument();
    expect(screen.queryByText(/Splat not found/i)).not.toBeInTheDocument();
  });

  it("shows not-found only when there is no splat at all", async () => {
    setup({ splat: undefined, splatError: new Error("404") });
    await renderPage();

    expect(screen.getByText(/Splat not found/i)).toBeInTheDocument();
  });

  it("surfaces a splat fetch failure instead of spinning forever", async () => {
    setup({ splatStatus: "complete", splatFileError: new Error("404 Splat not ready") });
    await renderPage();

    expect(screen.getByText(/isn't ready yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("splat-loading")).not.toBeInTheDocument();
  });

  it("renders the viewer once the splat url arrives", async () => {
    setup({ splatStatus: "complete", splatFile: presigned("https://s3/splat.ply") });
    await renderPage();

    expect(screen.getByTestId("splat-viewer")).toHaveTextContent("https://s3/splat.ply");
  });

  it("shows the awaiting-training panel while paused for review, not the completed-splat toggle", async () => {
    setup({
      splatStatus: "processing",
      job: { ...baseJob, status: "awaiting_training", pointCloudS3Key: "splats/x/point_cloud.ply" },
      splatFile: presigned("https://s3/point_cloud.ply"),
    });
    await renderPage();

    expect(screen.getByText(/Review the point cloud below/i)).toBeInTheDocument();
    expect(screen.queryByText("Trained points")).not.toBeInTheDocument();
  });

  it("shows the 3-way toggle once the splat is complete", async () => {
    setup({
      splatStatus: "complete",
      splatFile: presigned("https://s3/splat.ply"),
      job: { ...baseJob, status: "complete", pointCloudS3Key: "splats/x/point_cloud.ply" },
    });
    await renderPage();

    expect(screen.getByText("Trained points")).toBeInTheDocument();
    expect(screen.getByText("COLMAP points")).toBeInTheDocument();
  });

  it("hides the COLMAP position for a splat that has no point cloud", async () => {
    // Anything processed before the stage split never uploaded one. Offering the toggle position would render an
    // empty canvas with nothing to explain it.
    setup({
      splatStatus: "complete",
      splatFile: presigned("https://s3/splat.ply"),
      job: { ...baseJob, status: "complete", pointCloudS3Key: null },
    });
    await renderPage();

    expect(screen.getByText("Trained points")).toBeInTheDocument();
    expect(screen.queryByText("COLMAP points")).not.toBeInTheDocument();
  });

  it("re-mints an aged download URL before the switch remounts the viewer", async () => {
    // Presigned URLs expire after 15 minutes (PRESIGN_EXPIRY_SECONDS, web/lib/server/s3.ts) while SWR would hold one
    // forever. The remount a mode switch causes is where an expired one fails, so it has to be replaced first.
    setup({ splatStatus: "complete", splatFile: presigned("https://s3/splat.ply", 20 * 60_000) });
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText("Trained points"));
    });

    expect(refetchPresignedUrl).toHaveBeenCalled();
  });

  it("does not re-mint a URL that is still fresh", async () => {
    setup({ splatStatus: "complete", splatFile: presigned("https://s3/splat.ply") });
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText("Trained points"));
    });

    expect(refetchPresignedUrl).not.toHaveBeenCalled();
  });
});
