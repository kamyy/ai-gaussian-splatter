import { ThemeProvider } from "@mui/material/styles";
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Splat } from "@/lib/types";
import { theme } from "@/theme";
import SplatPage from "./page";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

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
  id: "splat-1",
  name: "Ceramic mug",
  status: "complete",
  thumbnailS3Key: null,
  isShareable: false,
  createdAt: "2026-01-01T00:00:00Z",
};

async function renderPage() {
  await act(async () => {
    render(
      <ThemeProvider theme={theme}>
        <Suspense fallback={null}>
          <SplatPage params={Promise.resolve({ id: "splat-1" })} />
        </Suspense>
      </ThemeProvider>,
    );
  });
}

describe("SplatPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLatestJobMock.mockReturnValue({ data: undefined });
  });

  it("shows a not-ready message before the splat completes", async () => {
    useSplatMock.mockReturnValue({ data: { ...baseSplat, status: "processing" }, isLoading: false });
    useSWRMock.mockReturnValue({ data: undefined, error: undefined });

    await renderPage();

    expect(screen.getByText(/Not ready yet/i)).toBeInTheDocument();
  });

  it("shows a generic failure message when the job has no error message yet", async () => {
    useSplatMock.mockReturnValue({ data: { ...baseSplat, status: "failed" }, isLoading: false });
    useSWRMock.mockReturnValue({ data: undefined, error: undefined });

    await renderPage();

    expect(screen.getByText("Processing failed.")).toBeInTheDocument();
    expect(screen.queryByText(/Not ready yet/i)).not.toBeInTheDocument();
  });

  it("shows the job's error message directly, not just the dismissible toast", async () => {
    // web/components/job/JobStatusSnackbar.tsx's toast can be dismissed; this is what's left once it is.
    useSplatMock.mockReturnValue({ data: { ...baseSplat, status: "failed" }, isLoading: false });
    useSWRMock.mockReturnValue({ data: undefined, error: undefined });
    useLatestJobMock.mockReturnValue({ data: { errorMessage: "COLMAP registered only 40% of photos" } });

    await renderPage();

    expect(screen.getByText("Processing failed: COLMAP registered only 40% of photos")).toBeInTheDocument();
  });

  it("surfaces a splat fetch failure instead of spinning forever", async () => {
    useSplatMock.mockReturnValue({ data: baseSplat, isLoading: false });
    useSWRMock.mockReturnValue({ data: undefined, error: new Error("404 Splat not ready") });

    await renderPage();

    expect(screen.getByText(/isn't ready yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("splat-loading")).not.toBeInTheDocument();
  });

  it("renders the viewer once the splat url arrives", async () => {
    useSplatMock.mockReturnValue({ data: baseSplat, isLoading: false });
    useSWRMock.mockReturnValue({ data: "https://s3/splat.ply", error: undefined });

    await renderPage();

    expect(screen.getByTestId("splat-viewer")).toHaveTextContent("https://s3/splat.ply");
  });
});
