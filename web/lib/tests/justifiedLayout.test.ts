import { describe, expect, it } from "vitest";

import { layoutPages, layoutRows } from "../justifiedLayout";

function rowWidth(row: { tiles: { width: number }[] }, gap: number) {
  return row.tiles.reduce((sum, tile) => sum + tile.width, 0) + gap * (row.tiles.length - 1);
}

describe("layoutRows", () => {
  it("scales every full row to the exact width, keeping each photo's shape", () => {
    const aspects = [0.75, 1.3333, 0.75, 0.75, 1.7778, 1.3333, 0.75, 1, 1.3333, 0.75];
    const rows = layoutRows(aspects, 400, 100, 8);
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row, 8)).toBeCloseTo(400, 6);
      for (const tile of row.tiles) {
        expect(tile.width / tile.height).toBeCloseTo(aspects[tile.index], 6);
      }
    }

    expect(rows.flatMap(row => row.tiles.map(tile => tile.index))).toEqual(aspects.map((_, i) => i));
  });

  it("leaves a part-filled last row at the target height instead of stretching it", () => {
    const rows = layoutRows([1, 1, 1, 1, 1], 400, 100, 0);
    expect(rows.map(row => row.tiles.length)).toEqual([4, 1]);
    expect(rows[1].height).toBe(100);
  });

  it("breaks a row where its height lands nearest the target", () => {
    // Three squares at 100 leave the row 300 wide of 400. Adding a fourth, wide photo would shrink the row to 57, so
    // the row closes at three and grows to 133 instead.
    const rows = layoutRows([1, 1, 1, 4], 400, 100, 0);
    expect(rows[0].tiles).toHaveLength(3);
    expect(rows[0].height).toBeCloseTo(400 / 3, 6);
  });

  it("never makes a row wider than the area, however wide a photo is", () => {
    // Closing the first row before the 8:1 panorama leaves that photo alone on the last row, where at the 96px target
    // it would be 768px wide.
    const rows = layoutRows([2, 3.9, 8], 600, 96, 6);
    for (const row of rows) {
      expect(rowWidth(row, 6)).toBeLessThanOrEqual(600 + 1e-9);
    }

    expect(rows.at(-1)?.height).toBeCloseTo(600 / 8, 6);
  });
});

describe("layoutPages", () => {
  it("puts whole rows on each page, so only the last page can end part-filled", () => {
    // Four squares fill each 400-wide row, so 18 photos make four full rows and a last row of two.
    const pages = layoutPages(
      Array.from({ length: 18 }, () => 1),
      400,
      100,
      0,
      2,
    );
    expect(pages.map(page => [page.start, page.end])).toEqual([
      [0, 8],
      [8, 16],
      [16, 18],
    ]);
    expect(pages[0].rows).toHaveLength(2);
  });

  it("lays out nothing before the area has a width", () => {
    expect(layoutPages([1, 1], 0, 100, 0, 2)).toEqual([]);
  });
});
