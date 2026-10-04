import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CameraPose, CropBox, Job } from "@/lib/types";
import { SplatStageViewer } from "../SplatStageViewer";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

vi.mock("notistack", () => ({ useSnackbar: () => ({ enqueueSnackbar: () => {} }) }));

// The object the panel last handed the viewer. A new one flies the camera, so a reload must keep this reference.
const { selectedCameraSeen } = vi.hoisted(() => ({
  selectedCameraSeen: { current: null as { index: number } | null },
}));

const BOX: CropBox = { center: [1, 2, 3], size: [4, 5, 6], quaternion: [0, 0, 0, 1] };

// Stands in for the WebGL viewer, which jsdom can't run. It shows the mode, the camera and the URL a scene would mount
// with. It offers buttons for what the real viewer does on its own: fitting a crop box, and turning the view away from
// the front, side or top view it animated to.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({
    mode,
    projection,
    axisView,
    onLeaveAxisView,
    splatUrl,
    cropping,
    onCropBoxChange,
    appliedCropBox,
    selectedCamera,
  }: {
    mode: string;
    projection: string;
    axisView: string | null;
    onLeaveAxisView: () => void;
    splatUrl: string | null;
    cropping: boolean;
    onCropBoxChange?: (box: CropBox) => void;
    appliedCropBox?: CropBox | null;
    selectedCamera?: { index: number } | null;
  }) => {
    selectedCameraSeen.current = selectedCamera ?? null;
    let fit: React.ReactNode = null;
    if (cropping && mode === "colmap_points") {
      fit = (
        <button type="button" onClick={() => onCropBoxChange?.(BOX)}>
          fit box
        </button>
      );
    }

    const turn = (
      <button type="button" onClick={onLeaveAxisView}>
        turn view
      </button>
    );

    return (
      <div>
        <p>viewer: {splatUrl}</p>
        <p>mode: {mode}</p>
        <p>projection: {projection}</p>
        <p>view: {axisView ?? "none"}</p>
        <p>applied crop: {appliedCropBox ? "yes" : "no"}</p>
        {fit}
        {turn}
      </div>
    );
  },
}));

const job = { pointCloudS3Key: null, cropBox: null, updatedAt: "2026-01-01T00:00:00.000Z" } as Job;
// The crop box is fitted in the point cloud, so a crop needs one.
const withPoints: Job = { ...job, pointCloudS3Key: "splats/x/points.ply" };

// SWR's default cache is the app's, and like the app's it outlives a viewer across navigations. Each test uses its own
// splat so the tests share nothing in it.
function viewer(splatId: string, { latestJob = job, complete = true, onJobChanged = () => {} } = {}) {
  return (
    <SplatStageViewer
      splatId={splatId}
      job={latestJob}
      complete={complete}
      cameras={undefined}
      selection={null}
      onClearSelection={() => {}}
      onJobChanged={onJobChanged}
    />
  );
}

// The crop controls show in the point cloud view only.
function openCropView() {
  fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
}

function deleteCalls() {
  return apiFetchMock.mock.calls.filter(call => call[1] === "DELETE");
}

describe("SplatStageViewer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    apiFetchMock.mockReset();
    selectedCameraSeen.current = null;
  });

  it("reuses a recent visit's URL straight away", async () => {
    apiFetchMock.mockResolvedValueOnce("url-1").mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(viewer("splat-recent"));
    expect(await screen.findByText("viewer: url-1")).toBeInTheDocument();
    rerender(<p>another page</p>);
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    rerender(viewer("splat-recent"));
    expect(screen.getByText("viewer: url-1")).toBeInTheDocument();
  });

  it("re-mints the viewer URL well inside its 15-minute expiry", async () => {
    apiFetchMock.mockResolvedValueOnce("url-1").mockResolvedValueOnce("url-2");
    render(viewer("splat-refresh"));
    expect(await screen.findByText("viewer: url-1")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't reuse the last visit's URL on a return to the page", async () => {
    apiFetchMock.mockResolvedValueOnce("url-1");
    const { rerender } = render(viewer("splat-return"));
    expect(await screen.findByText("viewer: url-1")).toBeInTheDocument();
    rerender(<p>another page</p>);
    await act(() => vi.advanceTimersByTimeAsync(11 * 60_000));

    let resolveFresh: (url: string) => void = () => {};
    apiFetchMock.mockReturnValueOnce(new Promise(resolve => (resolveFresh = resolve)));
    rerender(viewer("splat-return"));
    expect(screen.queryByText("viewer: url-1")).not.toBeInTheDocument();

    await act(async () => resolveFresh("url-2"));
    expect(await screen.findByText("viewer: url-2")).toBeInTheDocument();
  });

  it("fits the box in the point cloud, then applies it without leaving that view", async () => {
    apiFetchMock.mockImplementation(async (path: string) => (path.endsWith("/crop") ? { cropBox: BOX } : "url-1"));
    const onJobChanged = vi.fn();
    render(viewer("splat-apply", { latestJob: withPoints, onJobChanged }));
    await screen.findByText("viewer: url-1");
    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));

    await waitFor(() => expect(onJobChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-apply/crop", "POST", "test-token", { box: BOX });
    expect(screen.getByText("mode: colmap_points")).toBeInTheDocument();
    expect(screen.getByText("projection: orthographic")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply crop" })).not.toBeInTheDocument();
  });

  it("stays in the point cloud with the box when the crop fails", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/crop")) {
        throw new Error("The crop box doesn't contain any of the splat");
      }

      return "url-1";
    });
    render(viewer("splat-apply-fails", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled());
    expect(screen.getByText("mode: colmap_points")).toBeInTheDocument();
  });

  it("keeps the cropped point cloud when any of the four crop buttons is pressed", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-points", { latestJob: { ...withPoints, cropBox: BOX } }));
    await screen.findByText("viewer: url-1");

    openCropView();
    expect(screen.getByText("applied crop: yes")).toBeInTheDocument();

    for (const name of ["Front view", "Side view", "Top view", "Crop"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByText("applied crop: yes")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();
    }

    expect(deleteCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();
  });

  it("keeps a crop in progress, and its box, across a switch of view", async () => {
    apiFetchMock.mockImplementation(async (path: string) => (path.endsWith("/crop") ? { cropBox: BOX } : "url-1"));
    render(viewer("splat-switch", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    fireEvent.click(screen.getByRole("button", { name: "3D splat" }));
    expect(screen.queryByRole("button", { name: "fit box" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply crop" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));

    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-switch/crop", "POST", "test-token", { box: BOX }),
    );
  });

  it("offers every crop control in the point cloud view under either camera, and never over the splat", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-splat-view", { latestJob: { ...withPoints, cropBox: BOX } }));
    await screen.findByText("viewer: url-1");

    expect(screen.getByText("mode: splat")).toBeInTheDocument();
    expect(screen.getByText("projection: perspective")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orthographic camera" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo crop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Front view" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    expect(screen.getByRole("button", { name: "Front view" })).toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: "Front view" }));
    expect(await screen.findByRole("tooltip", { name: "Frame the crop from the front" })).toBeInTheDocument();
    fireEvent.blur(screen.getByRole("button", { name: "Front view" }));
    const camera = screen.getByRole("group", { name: "Camera" });
    const view = screen.getByRole("group", { name: "View" });
    const crop = screen.getByRole("group", { name: "Crop" });
    expect(view.parentElement).toBe(crop.parentElement);
    expect(camera.parentElement).toContainElement(view.parentElement);
    expect(crop).toContainElement(screen.getByRole("button", { name: "Crop" }));
    expect(crop).toContainElement(screen.getByRole("button", { name: "Undo crop" }));

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(crop).toContainElement(screen.getByRole("button", { name: "Apply crop" }));
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));

    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));
    expect(screen.getByRole("button", { name: "Crop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo crop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3D splat" }));
    expect(screen.getByText("projection: perspective")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orthographic camera" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    expect(screen.getByText("projection: orthographic")).toBeInTheDocument();
  });

  it("opens the crop box from a front, side or top view", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-axis-crop", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Front view" }));
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Top view" }));
    expect(screen.getByText("view: top")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();
  });

  it("opens an applied crop from a front, side or top view", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-axis-applied", { latestJob: { ...withPoints, cropBox: BOX } }));
    await screen.findByText("viewer: url-1");

    openCropView();
    expect(screen.getByRole("button", { name: "Undo crop" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Side view" }));
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("applied crop: yes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Undo crop" })).not.toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(0);
  });

  it("keeps the chosen front, side or top view pressed after leaving the point cloud", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-axis-view", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Side view" }));
    expect(screen.getByRole("button", { name: "Side view" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "3D splat" }));
    expect(screen.queryByRole("button", { name: "Side view" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    expect(screen.getByRole("button", { name: "Side view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Front view" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Top view" })).toHaveAttribute("aria-pressed", "false");
  });

  it("snaps to a view only when one is picked, and lets go of it once the view is turned", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-orthographic", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    expect(screen.getByText("projection: perspective")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orthographic camera" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));
    expect(screen.getByText("projection: orthographic")).toBeInTheDocument();
    expect(screen.getByText("view: none")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Perspective camera" }));
    expect(screen.getByText("view: none")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Top view" }));
    expect(screen.getByText("view: top")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "turn view" }));
    expect(screen.getByText("view: none")).toBeInTheDocument();
    for (const name of ["Front view", "Side view", "Top view"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();
  });

  it("leaves a front, side or top view when a photo is selected under the orthographic camera", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    const cameras: CameraPose[] = [
      {
        photoId: "photo-1",
        center: [0, 0, 0],
        rotation: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        width: 4,
        height: 3,
        fx: 4,
        fy: 4,
      },
    ];
    const { rerender } = render(viewer("splat-ortho-photo", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));
    fireEvent.click(screen.getByRole("button", { name: "Top view" }));
    expect(screen.getByText("view: top")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();

    rerender(
      <SplatStageViewer
        splatId="splat-ortho-photo"
        job={withPoints}
        complete
        cameras={cameras}
        selection={{ photoId: "photo-1" }}
        onClearSelection={() => {}}
        onJobChanged={() => {}}
      />,
    );
    expect(screen.getByText("view: none")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "fit box" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply crop" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();

    rerender(
      <SplatStageViewer
        splatId="splat-ortho-photo"
        job={withPoints}
        complete
        cameras={cameras}
        selection={{ photoId: "photo-1" }}
        onClearSelection={() => {}}
        onJobChanged={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "fit box" })).not.toBeInTheDocument();
  });

  it("keeps an open crop when the camera list reloads under the same photo", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    const cameras: CameraPose[] = [
      {
        photoId: "photo-1",
        center: [0, 0, 0],
        rotation: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        width: 4,
        height: 3,
        fx: 4,
        fy: 4,
      },
    ];
    const selection = { photoId: "photo-1" };
    const { rerender } = render(
      <SplatStageViewer
        splatId="splat-cameras-reload"
        job={withPoints}
        complete
        cameras={cameras}
        selection={selection}
        onClearSelection={() => {}}
        onJobChanged={() => {}}
      />,
    );
    await screen.findByText("viewer: url-1");

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Top view" }));
    fireEvent.click(screen.getByRole("button", { name: "turn view" }));
    expect(screen.getByText("view: none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    const flight = selectedCameraSeen.current;

    rerender(
      <SplatStageViewer
        splatId="splat-cameras-reload"
        job={withPoints}
        complete
        cameras={cameras.map(camera => ({ ...camera }))}
        selection={selection}
        onClearSelection={() => {}}
        onJobChanged={() => {}}
      />,
    );
    expect(selectedCameraSeen.current).toBe(flight);
    expect(screen.getByText("view: none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();
  });

  it("snaps the perspective camera too, keeping the view across a switch of camera", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-perspective-view", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    fireEvent.click(screen.getByRole("button", { name: "Point cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Side view" }));
    expect(screen.getByText("projection: perspective")).toBeInTheDocument();
    expect(screen.getByText("view: side")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));
    expect(screen.getByText("view: side")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Perspective camera" }));
    expect(screen.getByText("view: side")).toBeInTheDocument();
  });

  it("starts with the crop box closed, and closes it when Crop is pressed again", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-crop-closed", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    openCropView();
    expect(screen.getByRole("button", { name: "Crop" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByRole("button", { name: "fit box" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.queryByRole("button", { name: "fit box" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply crop" })).not.toBeInTheDocument();
  });

  it("reopens a crop from the box already fitted", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-reopen", { latestJob: withPoints }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.queryByRole("button", { name: "Apply crop" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Front view" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();
    expect(deleteCalls()).toHaveLength(0);
  });

  it("undoes a crop", async () => {
    apiFetchMock.mockImplementation(async (path: string) => (path.endsWith("/crop") ? { cropBox: null } : "url-1"));
    const onJobChanged = vi.fn();
    render(viewer("splat-undo", { latestJob: { ...withPoints, cropBox: BOX }, onJobChanged }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Undo crop" }));

    await waitFor(() => expect(onJobChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-undo/crop", "DELETE", "test-token");
    expect(screen.getByText("applied crop: no")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeDisabled();
    expect(screen.getByText("applied crop: no")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeEnabled();
    expect(deleteCalls()).toHaveLength(1);
  });

  it("shows a crop that arrives after undo without the job reporting an empty box", async () => {
    apiFetchMock.mockImplementation(async (path: string) => (path.endsWith("/crop") ? { cropBox: null } : "url-1"));
    const cropped = { ...withPoints, cropBox: BOX };
    const { rerender } = render(viewer("splat-undo-next", { latestJob: cropped }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Undo crop" }));
    await waitFor(() => expect(screen.getByText("applied crop: no")).toBeInTheDocument());

    const sameBox: CropBox = { center: [...BOX.center], size: [...BOX.size], quaternion: [...BOX.quaternion] };
    rerender(viewer("splat-undo-next", { latestJob: { ...cropped, cropBox: sameBox } }));
    expect(screen.getByText("applied crop: no")).toBeInTheDocument();

    const next: CropBox = { center: [9, 9, 9], size: [1, 1, 1], quaternion: [0, 0, 0, 1] };
    rerender(
      viewer("splat-undo-next", {
        latestJob: { ...cropped, cropBox: next, updatedAt: "2026-01-02T00:00:00.000Z" },
      }),
    );
    expect(screen.getByText("applied crop: yes")).toBeInTheDocument();
  });

  it("shows the same crop again when it is applied after undo", async () => {
    apiFetchMock.mockImplementation(async (path: string, method?: string) => {
      if (path.endsWith("/crop") && method === "DELETE") {
        return { cropBox: null };
      }
      if (path.endsWith("/crop")) {
        return { cropBox: BOX };
      }
      return "url-1";
    });
    render(viewer("splat-reapply", { latestJob: { ...withPoints, cropBox: BOX } }));
    await screen.findByText("viewer: url-1");

    openCropView();
    fireEvent.click(screen.getByRole("button", { name: "Undo crop" }));
    await waitFor(() => expect(screen.getByText("applied crop: no")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    fireEvent.click(screen.getByRole("button", { name: "fit box" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    await waitFor(() => expect(screen.getByText("applied crop: yes")).toBeInTheDocument());
  });

  it("offers no crop controls before the splat is finished", async () => {
    apiFetchMock.mockResolvedValue("url-1");
    render(viewer("splat-unfinished", { latestJob: withPoints, complete: false }));

    expect(await screen.findByText("mode: colmap_points")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crop" })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: "Front view" }));
    expect(await screen.findByRole("tooltip", { name: "View from the front" })).toBeInTheDocument();
  });
});
