import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CameraPose, PublicPhoto } from "@/lib/types";
import { PublicSplatView } from "./PublicSplatView";

// jsdom does no layout, so the grid reports a fixed width, as in web/components/splats/PhotoGrid.test.tsx.
vi.mock("@/lib/hooks/useElementWidth", () => ({ useElementWidth: () => [() => {}, 392] }));

// Stands in for the WebGL viewer, which jsdom can't run. It shows the mode and selected camera, and its button stands
// in for clicking the second camera's frustum.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({
    mode,
    selectedCamera,
    onSelectCamera,
  }: {
    mode: string;
    selectedCamera: { index: number } | null;
    onSelectCamera?: (index: number) => void;
  }) => (
    <div>
      <p>viewer: {mode}</p>
      <p>camera: {selectedCamera?.index ?? "none"}</p>
      <button type="button" onClick={() => onSelectCamera?.(1)}>
        frustum 1
      </button>
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

function view(pointCloudUrl: string | null) {
  return (
    <PublicSplatView
      title="Mug"
      splatUrl="https://example.com/splat.spz"
      pointCloudUrl={pointCloudUrl}
      cameras={cameras}
      photos={photos}
    />
  );
}

describe("PublicSplatView", () => {
  it("opens on the splat and switches to the point cloud with its controls", () => {
    render(view("https://example.com/points.ply"));
    expect(screen.getByText("viewer: splat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cameras" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));

    expect(screen.getByText("viewer: colmap_points")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cameras" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("slider", { name: "Point size" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crop" })).not.toBeInTheDocument();
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

  it("selects a photo's tile when its camera is clicked", () => {
    render(view("https://example.com/points.ply"));

    fireEvent.click(screen.getByRole("button", { name: "frustum 1" }));

    expect(screen.getByRole("button", { name: "Photo 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("camera: 1")).toBeInTheDocument();
  });
});
