import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, PhotoListItem, Splat } from "@/lib/types";
import SplatPage from "./page";

// The viewer pulls in three.js, R3F and gaussian-splats-3d, none of which have a WebGL context under jsdom.
vi.mock("@/components/splats/SplatStageViewer", () => ({
  SplatStageViewer: ({ complete }: { complete: boolean }) => <div data-testid="viewer">{String(complete)}</div>,
}));
vi.mock("@/components/splats/StageCard", () => ({
  StageCard: ({ stage }: { stage: { kind: string } }) => <div data-testid="stage-card">{stage.kind}</div>,
}));
vi.mock("@/components/splats/SplatActions", () => ({
  DeleteSplatButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock("@/components/splats/SharePanel", () => ({
  SharePanel: () => <div data-testid="share-panel" />,
}));

const { useSplatMock, useLatestJobMock, usePhotosMock, useCamerasMock } = vi.hoisted(() => ({
  useSplatMock: vi.fn(),
  useLatestJobMock: vi.fn(),
  usePhotosMock: vi.fn(),
  useCamerasMock: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({
  useSplat: useSplatMock,
  useLatestJob: useLatestJobMock,
  usePhotos: usePhotosMock,
  useCameras: useCamerasMock,
}));

const splat: Splat = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ceramic mug",
  status: "processing",
  thumbnailS3Key: null,
  isShareable: true,
  createdAt: "2026-01-01T00:00:00Z",
};

const job: Job = {
  id: "job-1",
  splatId: splat.id,
  status: "awaiting_training",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: "pc.ply",
  trainingStartedAt: null,
  trainingProgress: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const photos: PhotoListItem[] = [
  { id: "p1", originalFilename: "a.jpg", url: "https://example.com/a.jpg" },
  { id: "p2", originalFilename: "b.jpg", url: "https://example.com/b.jpg" },
];

const refetchSplat = vi.fn();

function setup(options: { splat?: Splat; job?: Job; jobLoading?: boolean; placed?: string[] }) {
  useCamerasMock.mockReturnValue({
    data: options.placed?.map(photoId => ({ photoId, center: [0, 0, 0], rotation: [] })),
  });
  useSplatMock.mockReturnValue({ data: options.splat, isLoading: false, mutate: refetchSplat });
  useLatestJobMock.mockReturnValue({ data: options.job, isLoading: options.jobLoading ?? false, mutate: vi.fn() });
  usePhotosMock.mockReturnValue({ data: photos, isLoading: false });
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <SplatPage params={Promise.resolve({ id: splat.id })} />
      </Suspense>,
    );
  });
}

describe("SplatPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waits for the job's first fetch before deciding the stage", async () => {
    setup({ splat, job: undefined, jobLoading: true });
    await renderPage();
    expect(screen.queryByTestId("stage-card")).not.toBeInTheDocument();
  });

  it("shows the name, the stage card for the current stage, and the photos", async () => {
    setup({ splat, job });
    await renderPage();
    expect(screen.getByRole("heading", { name: "Ceramic mug" })).toBeInTheDocument();
    expect(screen.getByTestId("stage-card")).toHaveTextContent("check");
    expect(screen.getByRole("list", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "a.jpg" })).toBeInTheDocument();
    expect(screen.queryByTestId("share-panel")).not.toBeInTheDocument();
    // The check stage's own card offers "Discard" instead.
    expect(screen.queryByRole("button", { name: "Delete splat" })).not.toBeInTheDocument();
  });

  it("flags a photo the cameras don't include as not placed", async () => {
    setup({ splat, job, placed: ["p1"] });
    await renderPage();
    expect(screen.getByText(/1 couldn.t be placed/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "b.jpg (couldn't be placed)" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "a.jpg" })).toBeInTheDocument();
  });

  it("offers the share panel once the splat is complete and shareable", async () => {
    setup({ splat: { ...splat, status: "complete" }, job: { ...job, status: "complete" } });
    await renderPage();
    expect(screen.getByTestId("share-panel")).toBeInTheDocument();
    expect(screen.getByTestId("viewer")).toHaveTextContent("true");
    expect(screen.getByRole("button", { name: "Delete splat" })).toBeInTheDocument();
  });

  it("refetches the splat once its job has ended", async () => {
    setup({ splat, job: { ...job, status: "failed" } });
    await renderPage();
    expect(refetchSplat).toHaveBeenCalled();
  });

  it("says so when the splat doesn't exist", async () => {
    setup({ splat: undefined, job: undefined });
    await renderPage();
    expect(screen.getByText("Splat not found.")).toBeInTheDocument();
  });
});
