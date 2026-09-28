import { describe, expect, it } from "vitest";

import { pageItems } from "../pageItems";

describe("pageItems", () => {
  it("lists every page when they all fit", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("collapses the far end while the current page is near the start", () => {
    expect(pageItems(1, 8)).toEqual([1, 2, 3, 4, 5, "gap", 8]);
    expect(pageItems(4, 17)).toEqual([1, 2, 3, 4, 5, "gap", 17]);
  });

  it("collapses both ends around a page in the middle", () => {
    expect(pageItems(5, 17)).toEqual([1, "gap", 4, 5, 6, "gap", 17]);
    expect(pageItems(9, 17)).toEqual([1, "gap", 8, 9, 10, "gap", 17]);
  });

  it("collapses the near end while the current page is near the end", () => {
    expect(pageItems(14, 17)).toEqual([1, "gap", 13, 14, 15, 16, 17]);
    expect(pageItems(8, 8)).toEqual([1, "gap", 4, 5, 6, 7, 8]);
  });
});
