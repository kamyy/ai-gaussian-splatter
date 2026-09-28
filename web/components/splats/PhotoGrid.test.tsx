import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PhotoListItem } from "@/lib/types";

import { PhotoGrid } from "./PhotoGrid";

// jsdom does no layout, so the grid reports a fixed width. At 392 wide with the default 16px root font, a row holds
// three 4:3 photos at 95px tall, so a page of three rows holds 9.
vi.mock("@/lib/useElementWidth", () => ({ useElementWidth: () => [() => {}, 392] }));

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
    render(<PhotoGrid photos={makePhotos(9)} placedPhotoIds={null} selection={null} onSelect={() => {}} />);
    expect(screen.getAllByRole("img")).toHaveLength(9);
    expect(screen.queryByRole("navigation", { name: "Photo pages" })).not.toBeInTheDocument();
  });

  it("pages through the photos three rows at a time", () => {
    render(<PhotoGrid photos={makePhotos(30)} placedPhotoIds={null} selection={null} onSelect={() => {}} />);
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
      />,
    );
    expect(shownFilenames().slice(0, 3)).toEqual(["IMG_1.jpg", "IMG_2.jpg (couldn't be placed)", "IMG_3.jpg"]);
  });

  it("falls back to the last page when the photo list shrinks under it", () => {
    const { rerender } = render(
      <PhotoGrid photos={makePhotos(30)} placedPhotoIds={null} selection={null} onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Page 4" }));

    rerender(<PhotoGrid photos={makePhotos(20)} placedPhotoIds={null} selection={null} onSelect={() => {}} />);
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
      />,
    );
    // They don't fill a row, so they keep the 96px target height.
    const [landscapeTile, portraitTile, unknownTile] = screen.getAllByRole("img").map(img => img.closest("li"));
    expect(landscapeTile).toHaveStyle({ width: "128px", height: "96px" });
    expect(portraitTile).toHaveStyle({ width: "72px", height: "96px" });
    expect(unknownTile).toHaveStyle({ width: "96px", height: "96px" });
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "https://example.com/thumbnails/1.jpg");
    // A placeholder icon sits under each photo until it loads.
    expect(portraitTile?.querySelector("svg + img")).not.toBeNull();
  });

  it("fills each page with whole rows", () => {
    render(<PhotoGrid photos={makePhotos(13)} placedPhotoIds={null} selection={null} onSelect={() => {}} />);
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
      <PhotoGrid photos={photos} placedPhotoIds={placed} selection={null} onSelect={() => {}} />,
    );

    rerender(
      <PhotoGrid photos={photos} placedPhotoIds={placed} selection={{ photoId: "photo-20" }} onSelect={() => {}} />,
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
      <PhotoGrid photos={photos} placedPhotoIds={placed} selection={{ photoId: "photo-21" }} onSelect={() => {}} />,
    );
    expect(screen.getByText("19–27 of 30")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Page 1" }));
    rerender(
      <PhotoGrid photos={photos} placedPhotoIds={placed} selection={{ photoId: "photo-21" }} onSelect={() => {}} />,
    );
    expect(screen.getByText("19–27 of 30")).toBeInTheDocument();
  });
});
