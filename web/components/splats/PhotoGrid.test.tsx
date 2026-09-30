import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PhotoListItem } from "@/lib/types";

import { expandedBox, PhotoGrid } from "./PhotoGrid";

// jsdom does no layout, so the grid reports a fixed width. At 392 wide with the default 16px root font, a row holds
// three 4:3 photos at 95px tall, so a page of three rows holds 9.
vi.mock("@/lib/hooks/useElementWidth", () => ({ useElementWidth: () => [() => {}, 392] }));

function makePhotos(count: number): PhotoListItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `photo-${i + 1}`,
    originalFilename: `IMG_${i + 1}.jpg`,
    url: `https://example.com/${i + 1}.jpg`,
    thumbnailUrl: `https://example.com/thumbnails/${i + 1}.jpg`,
    width: 4032,
    height: 3024,
  }));
}

function shownFilenames() {
  return screen.getAllByRole("img").map(img => img.getAttribute("alt"));
}

describe("PhotoGrid", () => {
  it("shows every photo and no pager when they fit on one page", () => {
    render(
      <PhotoGrid
        photos={makePhotos(9)}
        placedPhotoIds={null}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(screen.getAllByRole("img")).toHaveLength(9);
    expect(screen.queryByRole("navigation", { name: "Photo pages" })).not.toBeInTheDocument();
  });

  it("pages through the photos three rows at a time", () => {
    render(
      <PhotoGrid
        photos={makePhotos(30)}
        placedPhotoIds={null}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(shownFilenames()).toHaveLength(9);
    expect(shownFilenames()[0]).toBe("IMG_1.jpg");
    expect(screen.getByText("1–9 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(shownFilenames()[0]).toBe("IMG_10.jpg");
    expect(screen.getByText("10–18 of 30")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Page 4" }));
    expect(shownFilenames()).toEqual(["IMG_28.jpg", "IMG_29.jpg", "IMG_30.jpg"]);

    // The part-filled last page keeps a full page's height, three 95px rows and two 6px gaps, so the pager stays put.
    expect(screen.getByRole("list").parentElement).toHaveStyle({ minHeight: "297px" });
    expect(screen.getByRole("button", { name: "Page 4" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("keeps the order it's given and flags the photos that couldn't be placed where they fall", () => {
    const photos = makePhotos(9);
    render(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={new Set(photos.filter(p => p.id !== "photo-2").map(p => p.id))}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(shownFilenames().slice(0, 3)).toEqual(["IMG_1.jpg", "IMG_2.jpg (couldn't be placed)", "IMG_3.jpg"]);
  });

  it("falls back to the last page when the photo list shrinks under it", () => {
    const { rerender } = render(
      <PhotoGrid
        photos={makePhotos(30)}
        placedPhotoIds={null}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Page 4" }));

    rerender(
      <PhotoGrid
        photos={makePhotos(20)}
        placedPhotoIds={null}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(shownFilenames()[0]).toBe("IMG_19.jpg");
    expect(screen.getByText("19–20 of 20")).toBeInTheDocument();
  });

  it("sizes each tile to its photo's stored shape, and square when no size was recorded", () => {
    const [landscape, portrait, unknown] = makePhotos(3);
    render(
      <PhotoGrid
        photos={[landscape, { ...portrait, width: 3024, height: 4032 }, { ...unknown, width: null, height: null }]}
        placedPhotoIds={null}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );

    // They don't fill a row, so they keep the 96px target height.
    const [landscapeTile, portraitTile, unknownTile] = screen.getAllByRole("img").map(img => img.closest("li"));
    expect(landscapeTile).toHaveStyle({ width: "128px", height: "96px" });
    expect(portraitTile).toHaveStyle({ width: "72px", height: "96px" });
    expect(unknownTile).toHaveStyle({ width: "96px", height: "96px" });
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "https://example.com/thumbnails/1.jpg");

    // A placeholder icon sits under each photo until it loads.
    expect(portraitTile?.querySelector("svg + span > img")).not.toBeNull();
  });

  it("fills each page with whole rows", () => {
    render(
      <PhotoGrid
        photos={makePhotos(13)}
        placedPhotoIds={null}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    for (const tile of screen.getAllByRole("img").map(img => img.closest("li"))) {
      expect(tile).toHaveStyle({ width: "126.66px", height: "95px" });
    }
  });

  it("offers only the placed photos for selection", () => {
    const photos = makePhotos(3);
    const onSelect = vi.fn();
    render(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={new Set(["photo-1", "photo-3"])}
        selection={null}
        onSelect={onSelect}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "IMG_2.jpg (couldn't be placed)" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "IMG_3.jpg" }));
    expect(onSelect).toHaveBeenCalledWith("photo-3");
  });

  it("turns to the selected photo's page and marks it in the pager", () => {
    const photos = makePhotos(30);
    const placed = new Set(photos.map(photo => photo.id));
    const { rerender } = render(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );

    rerender(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={{ photoId: "photo-20" }}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(screen.getByText("19–27 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "IMG_20.jpg" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Page 3, has the selected photo" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Paging away by hand stays there, and the pager still points back.
    fireEvent.click(screen.getByRole("button", { name: "Page 1" }));
    expect(screen.getByText("1–9 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 3, has the selected photo" })).not.toHaveAttribute("aria-current");

    // A new pick turns back, even one on the same page, or the same photo picked again.
    rerender(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={{ photoId: "photo-21" }}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(screen.getByText("19–27 of 30")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Page 1" }));
    rerender(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={{ photoId: "photo-21" }}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(screen.getByText("19–27 of 30")).toBeInTheDocument();
  });

  it("reports hovered photos and marks the one hovered in the 3D view", () => {
    const photos = makePhotos(3);
    const placed = new Set(photos.map(photo => photo.id));
    const onHover = vi.fn();
    const { rerender } = render(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={onHover}
      />,
    );
    const tile = screen.getByRole("button", { name: "IMG_2.jpg" });
    fireEvent.pointerEnter(tile);
    fireEvent.pointerLeave(tile);
    expect(onHover.mock.calls).toEqual([["photo-2"], [null]]);
    expect(tile.closest("li")).not.toHaveClass("-translate-y-0.5");

    rerender(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId="photo-2"
        onHover={onHover}
      />,
    );
    expect(tile.closest("li")).toHaveClass("-translate-y-0.5");
  });

  it("moves the selection with the arrow keys and Home/End, skipping unplaced photos and turning pages", () => {
    const photos = makePhotos(12);
    const placed = new Set(photos.filter(photo => photo.id !== "photo-3").map(photo => photo.id));
    const onSelect = vi.fn();
    const { rerender } = render(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={{ photoId: "photo-2" }}
        onSelect={onSelect}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    const selected = screen.getByRole("button", { name: "IMG_2.jpg" });

    // Only the selected tile is in the tab order.
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "IMG_1.jpg" })).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(selected, { key: "ArrowRight" });
    fireEvent.keyDown(selected, { key: "ArrowLeft" });
    fireEvent.keyDown(selected, { key: "End" });
    expect(onSelect.mock.calls).toEqual([["photo-4"], ["photo-1"], ["photo-12"]]);

    // Picking a photo on the next page turns to it and focuses its tile.
    rerender(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={{ photoId: "photo-12" }}
        onSelect={onSelect}
        hoveredPhotoId={null}
        onHover={() => {}}
      />,
    );
    expect(screen.getByText("10–12 of 12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "IMG_12.jpg" })).toHaveFocus();
  });

  it("clears its own hover when a page turn removes the hovered tile", () => {
    const photos = makePhotos(30);
    const placed = new Set(photos.map(photo => photo.id));
    const onHover = vi.fn();
    const { rerender } = render(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={null}
        onSelect={() => {}}
        hoveredPhotoId={null}
        onHover={onHover}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "IMG_1.jpg" }));

    // A pick in the 3D view turns the grid to page 3, taking the hovered tile away without a pointerleave.
    rerender(
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placed}
        selection={{ photoId: "photo-20" }}
        onSelect={() => {}}
        hoveredPhotoId="photo-1"
        onHover={onHover}
      />,
    );
    expect(onHover.mock.calls).toEqual([["photo-1"], [null]]);
  });

  it("moves the selection between rows with the up and down arrows", () => {
    // jsdom does no layout, so each tile reports a layout box from its place in the list: three per row, 95px tall with
    // 6px gaps, as the grid lays them out at this width.
    const place = (item: HTMLElement) => [...(item.parentElement?.children ?? [])].indexOf(item);
    const offsets = {
      offsetTop: (item: HTMLElement) => Math.floor(place(item) / 3) * 101,
      offsetLeft: (item: HTMLElement) => (place(item) % 3) * 132,
      offsetWidth: () => 126,
      offsetHeight: () => 95,
    };
    const restore = Object.entries(offsets).map(([name, get]) => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get(this: HTMLElement) {
          return get(this);
        },
      });

      return () => {
        if (original) {
          Object.defineProperty(HTMLElement.prototype, name, original);
        }
      };
    });

    try {
      const photos = makePhotos(9);
      const onSelect = vi.fn();
      render(
        <PhotoGrid
          photos={photos}
          placedPhotoIds={new Set(photos.map(photo => photo.id))}
          selection={{ photoId: "photo-5" }}
          onSelect={onSelect}
          hoveredPhotoId={null}
          onHover={() => {}}
        />,
      );
      const middle = screen.getByRole("button", { name: "IMG_5.jpg" });
      fireEvent.keyDown(middle, { key: "ArrowDown" });
      fireEvent.keyDown(middle, { key: "ArrowUp" });
      fireEvent.keyDown(screen.getByRole("button", { name: "IMG_8.jpg" }), { key: "ArrowDown" });

      // Down from the last row has nowhere to go.
      expect(onSelect.mock.calls).toEqual([["photo-8"], ["photo-2"]]);
    } finally {
      for (const undo of restore) {
        undo();
      }
    }
  });

  it("enlarges the photo the pointer rests on, placed or not, and shrinks it when the pointer leaves", () => {
    vi.useFakeTimers();
    try {
      const photos = makePhotos(2);
      const onHover = vi.fn();
      render(
        <PhotoGrid
          photos={photos}
          placedPhotoIds={new Set(["photo-1"])}
          selection={null}
          onSelect={() => {}}
          hoveredPhotoId={null}
          onHover={onHover}
        />,
      );
      const unplaced = screen.getByRole("img", { name: "IMG_2.jpg (couldn't be placed)" });
      const tile = unplaced.closest("li") as HTMLElement;
      expect(tile).toHaveClass("opacity-55");

      fireEvent.pointerEnter(tile);
      act(() => void vi.advanceTimersByTime(399));
      expect(unplaced.parentElement).toHaveStyle({ width: "128px", height: "96px" });

      // Two 128 by 96 tiles in a 392 by 96 area. The second photo grows from its center and runs over the top of the
      // area.
      act(() => void vi.advanceTimersByTime(1));
      expect(unplaced.parentElement).toHaveStyle({ left: "-96px", top: "-144px", width: "320px", height: "240px" });
      expect(tile).not.toHaveClass("opacity-55");
      expect(onHover).not.toHaveBeenCalled();

      fireEvent.pointerLeave(tile);
      expect(unplaced.parentElement).toHaveStyle({ left: "0px", top: "0px", width: "128px", height: "96px" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("expandedBox", () => {
  const area = { width: 400, height: 300 };

  it("grows a photo from its center when there is room", () => {
    expect(expandedBox({ left: 150, top: 100, width: 100, height: 80 }, area)).toEqual({
      left: -75,
      top: -60,
      width: 250,
      height: 200,
    });
  });

  it("keeps a photo at the area's edge inside the area", () => {
    expect(expandedBox({ left: 0, top: 0, width: 100, height: 80 }, area)).toMatchObject({ left: 0, top: 0 });
    expect(expandedBox({ left: 300, top: 220, width: 100, height: 80 }, area)).toMatchObject({ left: -150, top: -120 });
  });

  it("grows a wide photo only to the area's width", () => {
    expect(expandedBox({ left: 0, top: 0, width: 200, height: 50 }, area)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 100,
    });
  });

  it("runs a photo taller than the area over the area's top", () => {
    expect(expandedBox({ left: 0, top: 0, width: 100, height: 80 }, { width: 400, height: 80 })).toMatchObject({
      top: -120,
      height: 200,
    });
  });
});
