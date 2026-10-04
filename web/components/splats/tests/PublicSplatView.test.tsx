import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CameraPose, CropBox, JobTimestamps, PublicPhoto } from "@/lib/types";
import { PublicSplatView } from "../PublicSplatView";

// jsdom does no layout, so the grid reports a fixed width, as in web/components/splats/tests/PhotoGrid.test.tsx.
vi.mock("@/lib/hooks/useElementWidth", () => ({ useElementWidth: () => [() => {}, 392] }));

// Stands in for the WebGL viewer, which jsdom can't run. It shows the mode and the camera a picked photo flies to.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({
    mode,
    selectedCamera,
    appliedCropBox,
  }: {
    mode: string;
    selectedCamera: { index: number } | null;
    appliedCropBox?: { center: number[] } | null;
  }) => (
    <div>
      <p>viewer: {mode}</p>
      <p>camera: {selectedCamera?.index ?? "none"}</p>
      <p>crop: {appliedCropBox ? appliedCropBox.center.join(",") : "none"}</p>
    </div>
  ),
}));

const photos: PublicPhoto[] = [1, 2].map(n => ({
  id: `photo-${n}`,
  originalFilename: `Photo ${n}`,
  thumbnailUrl: `https://example.com/thumbnails/${n}.jpg`,
  width: 4032,
  height: 3024,
}));

const cameras: CameraPose[] = photos.map(photo => ({
  photoId: photo.id,
  center: [0, 0, 0],
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  width: 4032,
  height: 3024,
  fx: 3000,
  fy: 3000,
}));

// Cameras took 7m 52s from launch, the owner checked for 12m, and the build took 10m 15s.
const timestamps: JobTimestamps = {
  colmapBootedAt: null,
  colmapStartedAt: "2026-01-01T10:03:40Z",
  colmapFinishedAt: "2026-01-01T10:07:52Z",
  trainingLaunchedAt: "2026-01-01T10:19:52Z",
  trainingBootedAt: null,
  trainingStartedAt: "2026-01-01T10:22:57Z",
  completedAt: "2026-01-01T10:30:07Z",
  createdAt: "2026-01-01T10:00:00Z",
};

function view(pointCloudUrl: string | null, cropBox: CropBox | null = null) {
  return (
    <PublicSplatView
      title="Mug"
      splatUrl="https://example.com/splat.spz"
      pointCloudUrl={pointCloudUrl}
      cropBox={cropBox}
      cameras={cameras}
      photos={photos}
      timestamps={timestamps}
    />
  );
}

describe("PublicSplatView", () => {
  it("opens on the splat and switches to the point cloud with its controls", () => {
    render(view("https://example.com/points.ply"));
    expect(screen.getByText("viewer: splat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orthographic camera" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));

    expect(screen.getByText("viewer: colmap_points")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Point size" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));
    expect(screen.getByRole("button", { name: "Front view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crop" })).not.toBeInTheDocument();
  });

  it("shows how long each step took, without the owner's Share step", () => {
    render(view("https://example.com/points.ply"));

    expect(screen.getByRole("heading", { name: "How it was made" })).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Progress" })).getAllByRole("listitem");
    expect(steps.map(item => item.textContent)).toEqual([
      "Upload photos: done2 photos",
      "Place the cameras: done7m 52sGPU start-up 3m 40s · reconstructing 4m 12s",
      "Check the shape: done12m 00s",
      "Build the 3D splat: done10m 15sGPU start-up 3m 05s · training 7m 10s",
    ]);
    expect(screen.getByText("18m 07s of GPU time")).toBeInTheDocument();
  });

  it("hands the owner's crop to the viewer, so the point cloud matches the cropped splat", () => {
    render(view("https://example.com/points.ply", { center: [1, 2, 3], size: [1, 1, 1], quaternion: [0, 0, 0, 1] }));

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));

    expect(screen.getByText("crop: 1,2,3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo crop" })).not.toBeInTheDocument();
  });

  it("disables the point cloud when the splat has none", () => {
    render(view(null));
    expect(screen.getByRole("button", { name: "Point cloud" })).toBeDisabled();
  });

  it("flies to a photo's camera when its tile is picked", () => {
    render(view("https://example.com/points.ply"));

    fireEvent.click(screen.getByRole("button", { name: "Photo 1" }));

    expect(screen.getByRole("button", { name: "Photo 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("camera: 0")).toBeInTheDocument();
  });
});
