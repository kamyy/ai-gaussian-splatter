import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePhotoSelection } from "../usePhotoSelection";

const photos = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];

type CameraList = { photoId: string }[] | undefined;

function cameras(...photoIds: string[]) {
  return photoIds.map(photoId => ({ photoId }));
}

function renderWithCameras(cams: CameraList) {
  return renderHook((props: { cams: CameraList }) => usePhotoSelection(photos, props.cams), {
    initialProps: { cams },
  });
}

describe("usePhotoSelection", () => {
  it("opens on the first placed photo in grid order", () => {
    const { result } = renderHook(() => usePhotoSelection(photos, cameras("p2", "p1")));

    expect(result.current.selection).toEqual({ photoId: "p1", opening: true });
  });

  it("skips a leading photo that has no pose", () => {
    const { result } = renderHook(() => usePhotoSelection(photos, cameras("p2")));

    expect(result.current.selection).toEqual({ photoId: "p2", opening: true });
  });

  it("waits until the cameras have loaded", () => {
    const { result, rerender } = renderWithCameras(undefined);
    expect(result.current.selection).toBeNull();

    rerender({ cams: cameras("p1") });

    expect(result.current.selection).toEqual({ photoId: "p1", opening: true });
  });

  it("keeps a pick made before the cameras load", () => {
    const { result, rerender } = renderWithCameras(undefined);
    act(() => result.current.selectPhoto("p3"));

    rerender({ cams: cameras("p1", "p3") });

    expect(result.current.selection).toEqual({ photoId: "p3" });
  });

  it("stays cleared after the visitor leaves the opening photo", () => {
    const { result, rerender } = renderHook(
      ({ cams }: { cams: { photoId: string }[] }) => usePhotoSelection(photos, cams),
      { initialProps: { cams: cameras("p1") } },
    );
    act(() => result.current.clearSelection());

    rerender({ cams: cameras("p1", "p2") });

    expect(result.current.selection).toBeNull();
  });

  it("selects nothing when no photo has a pose", () => {
    const { result } = renderHook(() => usePhotoSelection(photos, null));

    expect(result.current.selection).toBeNull();
  });
});
