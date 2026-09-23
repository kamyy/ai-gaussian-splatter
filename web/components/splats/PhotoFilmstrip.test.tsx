import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, PhotoListItem } from "@/lib/types";
import { PhotoFilmstrip } from "./PhotoFilmstrip";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

const { usePhotosMock, useLatestJobMock } = vi.hoisted(() => ({
  usePhotosMock: vi.fn(),
  useLatestJobMock: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ usePhotos: usePhotosMock, useLatestJob: useLatestJobMock }));

const photos: PhotoListItem[] = [{ id: "photo-1", originalFilename: "a.jpg", url: "https://s3/a.jpg" }];

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: "training_running",
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

async function renderFilmstrip() {
  await act(async () => {
    render(<PhotoFilmstrip splatId="splat-1" />);
  });
}

describe("PhotoFilmstrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePhotosMock.mockReturnValue({ data: photos, isLoading: false, mutate: vi.fn() });
  });

  it("shows Start reconstruction when there is no active job", async () => {
    useLatestJobMock.mockReturnValue({ data: undefined, isLoading: false, mutate: vi.fn() });
    await renderFilmstrip();

    expect(screen.getByRole("button", { name: "Start reconstruction" })).toBeInTheDocument();
  });

  it("hides Start reconstruction while the first job fetch is still in flight", async () => {
    // data is also undefined while loading, same as "no job yet" — isLoading is what tells them apart. Missing this
    // check let a click during that window insert a second job for an already-finished splat.
    useLatestJobMock.mockReturnValue({ data: undefined, isLoading: true, mutate: vi.fn() });
    await renderFilmstrip();

    expect(screen.queryByRole("button", { name: "Start reconstruction" })).not.toBeInTheDocument();
  });

  it("hides Start reconstruction while a job is active", async () => {
    useLatestJobMock.mockReturnValue({ data: baseJob, mutate: vi.fn() });
    await renderFilmstrip();

    expect(screen.queryByRole("button", { name: "Start reconstruction" })).not.toBeInTheDocument();
  });

  it("shows Start reconstruction again after a job fails, allowing a retry", async () => {
    // process/route.ts's partial unique index only blocks *active* jobs, so a failed one can be retried.
    useLatestJobMock.mockReturnValue({ data: { ...baseJob, status: "failed" }, mutate: vi.fn() });
    await renderFilmstrip();

    expect(screen.getByRole("button", { name: "Start reconstruction" })).toBeInTheDocument();
  });

  it("starts reconstruction and refetches the job", async () => {
    const refetchJob = vi.fn();
    useLatestJobMock.mockReturnValue({ data: undefined, mutate: refetchJob });
    apiFetchMock.mockResolvedValue({ ...baseJob, status: "queued" });
    await renderFilmstrip();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start reconstruction" }));
    });

    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/process", "POST", "test-token");
    expect(refetchJob).toHaveBeenCalled();
  });

  it("renders the uploaded photos filmstrip", async () => {
    useLatestJobMock.mockReturnValue({ data: undefined, mutate: vi.fn() });
    await renderFilmstrip();

    expect(screen.getByAltText("a.jpg")).toBeInTheDocument();
  });

  it("opens when the handle is tapped, and closes again on a second tap", async () => {
    useLatestJobMock.mockReturnValue({ data: undefined, mutate: vi.fn() });
    await renderFilmstrip();

    const handle = screen.getByRole("button", { name: "Open photos panel" });
    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent.pointerUp(handle);
    expect(screen.getByRole("button", { name: "Close photos panel" })).toBeInTheDocument();

    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent.pointerUp(handle);
    expect(screen.getByRole("button", { name: "Open photos panel" })).toBeInTheDocument();
  });
});
