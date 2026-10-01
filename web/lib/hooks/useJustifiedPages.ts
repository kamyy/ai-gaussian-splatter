/**
 * Lays photos out in justified rows and splits the rows into pages.
 *
 * Measures the area it's given, fits the photos into rows of that width with web/lib/justifiedLayout.ts, and tracks the
 * current page. The library, the photo grid and the new-splat previews all use it with web/components/ui/Pager.tsx.
 */

import { useCallback, useMemo, useState } from "react";

import { type LayoutTile, layoutPages } from "@/lib/justifiedLayout";
import { useElementWidth } from "./useElementWidth";

interface JustifiedPagesOptions {
  rowHeightRem: number;
  // Both must match the gap classes on the list the tiles render in.
  columnGapRem: number;
  rowGapRem: number;
  rowsPerPage: number;
  // Fixed height each tile adds below its image, such as a caption. Zero when a tile is only its image.
  captionRem?: number;
}

export interface PlacedTile extends LayoutTile {
  // The tile's top-left corner, measured from the area's.
  left: number;
  top: number;
}

/**
 * Pages of whole justified rows, laid out for the width of the element given setArea as its ref. Every page but the
 * last ends on a full row. The requested page is clamped to the last one, so removing items or narrowing the window
 * under a later page shows what is now the last page. aspects (width over height) should keep its identity between
 * renders, or the layout is redone on every one.
 */
export function useJustifiedPages(
  aspects: number[],
  { rowHeightRem, columnGapRem, rowGapRem, rowsPerPage, captionRem = 0 }: JustifiedPagesOptions,
) {
  const [setArea, width] = useElementWidth<HTMLDivElement>();
  const [page, setPage] = useState(1);

  // The layout works in pixels, so the rem sizes are converted at the root font size. That is only read once the area
  // has been measured, which happens in the browser, never during server rendering.
  const { pages, areaHeight, remPx } = useMemo(() => {
    if (width === 0) {
      return { pages: [], areaHeight: 0, remPx: 0 };
    }

    // 16px is the browser default, for an environment that reports no font size.
    const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const laidOut = layoutPages(aspects, width, rowHeightRem * remPx, columnGapRem * remPx, rowsPerPage);

    // The tallest page's height, which every page reserves so the controls below stay put from page to page, the
    // part-filled last page included.
    const height = Math.max(
      0,
      ...laidOut.map(
        laidOutPage =>
          laidOutPage.rows.reduce((sum, row) => sum + row.height + captionRem * remPx, 0) +
          rowGapRem * remPx * (laidOutPage.rows.length - 1),
      ),
    );

    return { pages: laidOut, areaHeight: height, remPx };
  }, [aspects, width, rowHeightRem, columnGapRem, rowGapRem, rowsPerPage, captionRem]);

  // The 1-based page holding the item at index, or 0 before the area has been measured.
  const pageOf = useCallback(
    (index: number) => pages.findIndex(laidOutPage => index >= laidOutPage.start && index < laidOutPage.end) + 1,
    [pages],
  );

  // How many of the items isCounted picks out fall on each page, keyed by 1-based page. Pages with none are left out.
  function countByPage(isCounted: (index: number) => boolean) {
    const counts = new Map<number, number>();
    for (let index = 0; index < aspects.length; index++) {
      if (isCounted(index)) {
        const itemPage = pageOf(index);
        counts.set(itemPage, (counts.get(itemPage) ?? 0) + 1);
      }
    }

    return counts;
  }

  const pageCount = Math.max(1, pages.length);
  const current = Math.min(page, pageCount);
  const layout = pages.at(current - 1);

  // Each full row's widths add up to the area's width, so a wrapping list breaks exactly where the layout broke the
  // rows. Rounding each width down keeps a row from overflowing by a fraction of a pixel.
  let top = 0;
  const tiles: PlacedTile[] = (layout?.rows ?? []).flatMap(row => {
    let left = 0;
    const placed = row.tiles.map(tile => {
      const placedTile = { ...tile, width: Math.floor(tile.width * 100) / 100, left, top };
      left += tile.width + columnGapRem * remPx;

      return placedTile;
    });
    top += row.height + (captionRem + rowGapRem) * remPx;

    return placed;
  });

  return {
    setArea,
    areaWidth: width,
    // Give it to the area as its minimum height.
    areaHeight,
    current,
    pageCount,
    setPage,
    pageOf,
    countByPage,
    start: layout?.start ?? 0,
    end: layout?.end ?? 0,
    tiles,
  };
}
