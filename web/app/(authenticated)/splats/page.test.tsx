import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JobStatus } from "@/lib/statuses";
import type { SplatListItem } from "@/lib/types";

import LibraryPage from "./page";

const { useSplatsMock } = vi.hoisted(() => ({ useSplatsMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useSplats: useSplatsMock }));
// jsdom does no layout, so the card list reports a fixed width. At 1000 wide with the default 16px root font, a row
// holds three 4:3 cards at 238px tall, so a page of three rows holds 9.
vi.mock("@/lib/useElementWidth", () => ({ useElementWidth: () => [() => {}, 1000] }));

function makeSplat(i: number, overrides: Partial<SplatListItem> = {}): SplatListItem {
  return {
    id: `splat-${i}`,
    name: `Splat ${i}`,
    status: "complete",
    thumbnailS3Key: null,
    isShareable: false,
    createdAt: "2026-01-01T00:00:00Z",
    photoCount: 30,
    latestJobStatus: JobStatus.complete,
    thumbnailPhotoUrl: `https://example.com/${i}.jpg`,
    thumbnailWidth: 4032,
    thumbnailHeight: 3024,
    ...overrides,
  };
}

function cardHrefs() {
  return screen.getAllByRole("link").map(link => link.getAttribute("href"));
}

describe("LibraryPage", () => {
  beforeEach(() => {
    useSplatsMock.mockReset();
  });

  it("shows placeholder blocks with an image icon while the library loads", () => {
    useSplatsMock.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<LibraryPage />);
    expect(container.querySelectorAll(".animate-pulse svg")).toHaveLength(4);
  });

  it("pages the library three rows at a time, keeping the tallest page's height so the pager stays put", () => {
    useSplatsMock.mockReturnValue({ data: Array.from({ length: 14 }, (_, i) => makeSplat(i + 1)), isLoading: false });
    render(<LibraryPage />);
    expect(screen.getAllByRole("link")).toHaveLength(9);
    // Three 238px images, each with its 44px name line, and two 28px gaps between the rows.
    const area = screen.getByRole("list").parentElement;
    expect(area).toHaveStyle({ minHeight: "902px" });

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(cardHrefs()).toEqual([
      "/splats/splat-10",
      "/splats/splat-11",
      "/splats/splat-12",
      "/splats/splat-13",
      "/splats/splat-14",
    ]);
    expect(area).toHaveStyle({ minHeight: "902px" });
  });

  it("goes back to the first page when the filter changes", () => {
    useSplatsMock.mockReturnValue({ data: Array.from({ length: 14 }, (_, i) => makeSplat(i + 1)), isLoading: false });
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));

    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
  });

  it("sizes each card to its thumbnail's shape, and 4:3 without one", () => {
    useSplatsMock.mockReturnValue({
      data: [
        makeSplat(1, { thumbnailWidth: 3024, thumbnailHeight: 4032 }),
        makeSplat(2, { thumbnailPhotoUrl: null, thumbnailWidth: null, thumbnailHeight: null, photoCount: 0 }),
      ],
      isLoading: false,
    });
    render(<LibraryPage />);
    const [portrait, empty] = screen.getAllByRole("link").map(link => link.closest("li"));
    // They don't fill a row, so they keep the 236px target height.
    expect(portrait).toHaveStyle({ width: "177px" });
    expect(empty).toHaveStyle({ width: `${Math.floor(((236 * 4) / 3) * 100) / 100}px` });
    // The icon sits under each card's image until it loads, and on its own when there is none.
    expect(portrait?.querySelector("svg + img")).not.toBeNull();
    expect(empty?.querySelector("svg")).not.toBeNull();
  });
});
