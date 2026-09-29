/**
 * The maths for justified rows: fitting photos of different shapes into rows of equal width.
 *
 * Each row is scaled so its photos fill the width exactly while keeping their shapes, which is how the library, the
 * photo grid and the new-splat previews lay out. It's computed in JavaScript rather than CSS because the areas are
 * paged, and page breaks have to fall between rows. Every size is in CSS pixels, and each aspect is a photo's width
 * over its height.
 */

export interface LayoutTile {
  // The photo's position in the list the aspects came from.
  index: number;
  width: number;
  height: number;
}

export interface LayoutRow {
  tiles: LayoutTile[];
  height: number;
}

export interface LayoutPage {
  // The photos on this page are the ones from start up to, but not including, end.
  start: number;
  end: number;
  rows: LayoutRow[];
}

function sizedRow(indexes: number[], aspects: number[], height: number): LayoutRow {
  return { tiles: indexes.map(index => ({ index, width: aspects[index] * height, height })), height };
}

/**
 * Fills each row until it reaches the width at the target height, then closes it at whichever break, with or without
 * the last photo, leaves its height nearest the target. The row is then scaled to the exact width. A part-filled last
 * row stays at the target height, or shorter if its photos are too wide to fit at that height.
 */
export function layoutRows(aspects: number[], width: number, targetHeight: number, gap: number): LayoutRow[] {
  const rows: LayoutRow[] = [];
  let current: number[] = [];
  let aspectSum = 0;
  for (let index = 0; index < aspects.length; index++) {
    current.push(index);
    aspectSum += aspects[index];
    if (aspectSum * targetHeight + gap * (current.length - 1) < width) {
      continue;
    }

    const withHeight = (width - gap * (current.length - 1)) / aspectSum;
    const withoutHeight =
      current.length > 1
        ? (width - gap * (current.length - 2)) / (aspectSum - aspects[index])
        : Number.POSITIVE_INFINITY;
    if (Math.abs(withoutHeight - targetHeight) < Math.abs(withHeight - targetHeight)) {
      current.pop();
      rows.push(sizedRow(current, aspects, withoutHeight));
      current = [];
      aspectSum = 0;

      // The photo left out starts the next row. Going round again for it puts it through the width check, which
      // closes that row at once if the photo alone is too wide for the target height.
      index--;
    } else {
      rows.push(sizedRow(current, aspects, withHeight));
      current = [];
      aspectSum = 0;
    }
  }

  if (current.length > 0) {
    const fitHeight = (width - gap * (current.length - 1)) / aspectSum;
    rows.push(sizedRow(current, aspects, Math.min(targetHeight, fitHeight)));
  }

  return rows;
}

/**
 * Splits the rows into pages of rowsPerPage whole rows, so every page but the last ends on a full row. Nothing is laid
 * out before the area has a width.
 */
export function layoutPages(
  aspects: number[],
  width: number,
  targetHeight: number,
  gap: number,
  rowsPerPage: number,
): LayoutPage[] {
  if (width <= 0) {
    return [];
  }

  const rows = layoutRows(aspects, width, targetHeight, gap);
  const pages: LayoutPage[] = [];
  for (let first = 0; first < rows.length; first += rowsPerPage) {
    const pageRows = rows.slice(first, first + rowsPerPage);
    const lastRow = pageRows[pageRows.length - 1];
    pages.push({
      start: pageRows[0].tiles[0].index,
      end: lastRow.tiles[lastRow.tiles.length - 1].index + 1,
      rows: pageRows,
    });
  }

  return pages;
}
