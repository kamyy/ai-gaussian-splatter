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
    render(<PhotoGrid photos={makePhotos(9)} placedPhotoIds={null} />);
    expect(screen.getAllByRole("img")).toHaveLength(9);
    expect(screen.queryByRole("navigation", { name: "Photo pages" })).not.toBeInTheDocument();
  });

  it("pages through the photos three rows at a time", () => {
    render(<PhotoGrid photos={makePhotos(30)} placedPhotoIds={null} />);
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
      <PhotoGrid photos={photos} placedPhotoIds={new Set(photos.filter(p => p.id !== "photo-2").map(p => p.id))} />,
    );
    expect(shownFilenames().slice(0, 3)).toEqual(["IMG_1.jpg", "IMG_2.jpg (couldn't be placed)", "IMG_3.jpg"]);
  });

  it("falls back to the last page when the photo list shrinks under it", () => {
    const { rerender } = render(<PhotoGrid photos={makePhotos(30)} placedPhotoIds={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Page 4" }));

    rerender(<PhotoGrid photos={makePhotos(20)} placedPhotoIds={null} />);
    expect(shownFilenames()[0]).toBe("IMG_19.jpg");
    expect(screen.getByText("19–20 of 20")).toBeInTheDocument();
  });

  it("sizes each tile to its photo's stored shape, and square when no size was recorded", () => {
    const [landscape, portrait, unknown] = makePhotos(3);
    render(
      <PhotoGrid
        photos={[landscape, { ...portrait, width: 3024, height: 4032 }, { ...unknown, width: null, height: null }]}
        placedPhotoIds={null}
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
    render(<PhotoGrid photos={makePhotos(13)} placedPhotoIds={null} />);
    for (const tile of screen.getAllByRole("img").map(img => img.closest("li"))) {
      expect(tile).toHaveStyle({ width: "126.66px", height: "95px" });
    }
  });
});
