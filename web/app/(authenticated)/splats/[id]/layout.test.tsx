import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, Splat, SplatStatus } from "@/lib/types";
import SplatLayout from "./layout";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/splats/11111111-1111-4111-8111-111111111111/point-cloud",
}));

vi.mock("@/components/splats/PhotoFilmstrip", () => ({
  PhotoFilmstrip: () => <div data-testid="photo-filmstrip" />,
  HANDLE_HEIGHT: 40,
}));

const { useSplatMock, useLatestJobMock } = vi.hoisted(() => ({
  useSplatMock: vi.fn(),
  useLatestJobMock: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useSplat: useSplatMock, useLatestJob: useLatestJobMock }));

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

function setup(options: { splat?: Splat | undefined; splatStatus?: SplatStatus; splatError?: Error; job?: Job }) {
  const splat =
    options.splat === undefined && options.splatStatus === undefined
      ? undefined
      : { ...baseSplat, ...(options.splatStatus ? { status: options.splatStatus } : {}) };

  useSplatMock.mockReturnValue({ data: splat, isLoading: false, error: options.splatError, mutate: refetchSplat });
  useLatestJobMock.mockReturnValue({ data: options.job, error: undefined, isLoading: false, mutate: vi.fn() });
}

async function renderLayout() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <SplatLayout params={Promise.resolve({ id: baseSplat.id })}>
          <div>child content</div>
        </SplatLayout>
      </Suspense>,
    );
  });
}

describe("SplatLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refetches the splat when the job ends, so the viewer can appear", async () => {
    // The worker's callback moves the job and splat rows together, but only the job is polled. Without this refetch
    // the layout would sit on a stale splat status.
    setup({ splatStatus: "processing", job: { ...baseJob, status: "complete" } });
    await renderLayout();

    expect(refetchSplat).toHaveBeenCalled();
  });

  it("does not refetch while the job is still running", async () => {
    setup({ splatStatus: "processing", job: baseJob });
    await renderLayout();

    expect(refetchSplat).not.toHaveBeenCalled();
  });

  it("keeps rendering a cached splat when a revalidation fails", async () => {
    // A transient failure of the completion refetch must not replace the whole layout. `data` still holds the last
    // good splat.
    setup({ splatStatus: "complete", splatError: new Error("503") });
    await renderLayout();

    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(screen.queryByText(/Splat not found/i)).not.toBeInTheDocument();
  });

  it("shows not-found only when there is no splat at all", async () => {
    setup({ splat: undefined, splatError: new Error("404") });
    await renderLayout();

    expect(screen.getByText(/Splat not found/i)).toBeInTheDocument();
  });

  it("renders the child route once the splat has loaded", async () => {
    setup({ splatStatus: "processing", job: baseJob });
    await renderLayout();

    expect(screen.getByText("child content")).toBeInTheDocument();
  });

  it("shows a cancelled confirmation, the one terminal status with no other UI surface", async () => {
    setup({ splatStatus: "failed", job: { ...baseJob, status: "cancelled" } });
    await renderLayout();

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("does not show the job status card once a non-cancelled job has loaded", async () => {
    // awaiting_training/complete have their own UI elsewhere in the route; in-progress/failed have the snackbar.
    setup({ splatStatus: "processing", job: baseJob });
    await renderLayout();

    expect(screen.queryByText(/Loading job status/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
  });
});
