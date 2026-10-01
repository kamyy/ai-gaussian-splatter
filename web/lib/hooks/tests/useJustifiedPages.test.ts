import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useJustifiedPages } from "../useJustifiedPages";

// jsdom does no layout, so the area reports a fixed width. At 400 wide with the default 16px root font, a row holds
// three square tiles at 128px tall, so a page of one row holds three.
vi.mock("../useElementWidth", () => ({ useElementWidth: () => [() => {}, 400] }));

const OPTIONS = { rowHeightRem: 8, columnGapRem: 0.5, rowGapRem: 0.5, rowsPerPage: 1 };

describe("useJustifiedPages", () => {
  it("counts the picked items on each page, leaving out pages with none", () => {
    const aspects = Array.from({ length: 7 }, () => 1);
    const { result } = renderHook(() => useJustifiedPages(aspects, OPTIONS));
    expect(result.current.pageCount).toBe(3);

    const counts = result.current.countByPage(index => [0, 2, 6].includes(index));
    expect(counts).toEqual(
      new Map([
        [1, 2],
        [3, 1],
      ]),
    );
  });
});
