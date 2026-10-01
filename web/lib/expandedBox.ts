/**
 * Where a photo is drawn while the pointer rests on it and it is enlarged over its neighbours.
 *
 * The splat page's photo grid and the new-splat form's previews both enlarge a photo this way, so a visitor can make
 * out its detail. The numbers here are shared so the two behave the same.
 */

// How much larger a photo is drawn while the pointer rests on it. A thumbnail's long side is THUMBNAIL_LONG_SIDE pixels
// (web/lib/measurePhoto.ts), which stays sharp at this size on a high-density screen.
const EXPAND_SCALE = 2.5;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The box an enlarged photo is drawn in, measured from its tile's top-left corner. tile is measured from the area's.
 *
 * The photo grows from its tile's center, then is moved to stay inside the area. It grows by less than EXPAND_SCALE
 * when it would otherwise be wider or taller than the area, so a grid of a single short row barely enlarges at all.
 * Leaving the area would let the photo cover the controls around the grid, and an enlarged photo takes the pointer, so
 * it would catch clicks meant for them.
 */
export function expandedBox(tile: Box, area: { width: number; height: number }): Box {
  const scale = Math.min(EXPAND_SCALE, area.width / tile.width, area.height / tile.height);
  const width = tile.width * scale;
  const height = tile.height * scale;
  const left = Math.min(Math.max(tile.left + (tile.width - width) / 2, 0), area.width - width);
  const top = Math.min(Math.max(tile.top + (tile.height - height) / 2, 0), area.height - height);

  return { left: left - tile.left, top: top - tile.top, width, height };
}
