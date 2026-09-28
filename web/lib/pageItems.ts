// A pager's buttons, as 1-based page numbers with "gap" where a run of pages is collapsed into an ellipsis. Past seven
// pages the list is always seven items long, so the pager keeps one width as the visitor pages through.
const MAX_ITEMS = 7;

export function pageItems(current: number, count: number): Array<number | "gap"> {
  if (count <= MAX_ITEMS) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "gap", count];
  }
  if (current >= count - 3) {
    return [1, "gap", count - 4, count - 3, count - 2, count - 1, count];
  }
  return [1, "gap", current - 1, current, current + 1, "gap", count];
}
