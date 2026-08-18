import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRead, SplatRead, SplatStatus } from "@/lib/types";
import SplatDetailPage from "./page";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

// The viewer pulls in three.js, R3F and gaussian-splats-3d, none of which have
// a WebGL context under jsdom. Only its presence is under test here.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({ splatUrl }: { splatUrl: string }) => <div data-testid="splat-viewer">{splatUrl}</div>,
  SplatViewerLoading: () => <div data-testid="splat-loading" />,
}));

const { useSplatMock, useJobStatusMock } = vi.hoisted(() => ({
  useSplatMock: vi.fn(),
  useJobStatusMock: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useSplat: useSplatMock, useJobStatus: useJobStatusMock }));

const { useSWRMock } = vi.hoisted(() => ({ useSWRMock: vi.fn() }));
vi.mock("swr", () => ({ default: useSWRMock }));

const baseSplat: SplatRead = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ceramic mug",
  status: "processing",
  thumbnailS3Key: null,
  isShareable: false,
  createdAt: "2026-01-01T00:00:00Z",
};

const baseJob: JobRead = {
  id: "job-1",
  splatId: baseSplat.id,
  status: "training_running",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const refetchSplat = vi.fn();

function setup(options: {
  splat?: SplatRead | undefined;
  splatStatus?: SplatStatus;
  splatError?: Error;
  job?: JobRead;
  splatFile?: { url: string };
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
  useJobStatusMock.mockReturnValue({ data: options.job, error: undefined, isLoading: false });
  useSWRMock.mockReturnValue({ data: options.splatFile, error: options.splatFileError });
}

// The page reads `params` with React's `use()`, so it suspends on first render.
// RTL's own `act` scope is synchronous and cannot flush that — the render has
// to happen inside an awaited `act`.
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
    // The worker's callback moves the job and splat rows together, but only the
    // job is polled — without this refetch the page would sit on the poller.
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
    // A transient failure of the completion refetch must not replace the whole
    // page — `data` still holds the last good splat.
    setup({ splatStatus: "complete", splatError: new Error("503"), splatFile: { url: "https://s3/splat.ply" } });
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
    setup({ splatStatus: "complete", splatFile: { url: "https://s3/splat.ply" } });
    await renderPage();

    expect(screen.getByTestId("splat-viewer")).toHaveTextContent("https://s3/splat.ply");
  });
});
