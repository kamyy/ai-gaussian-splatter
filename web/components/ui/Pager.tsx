/**
 * Page-number navigation for a paged list.
 *
 * Shows previous and next buttons around numbered pages, collapsing long runs into an ellipsis so the pager stays one
 * width. The library, the photo grid and the new-splat form's previews all page with it.
 */

"use client";

import { useEffect, useRef } from "react";

import { NextPageIcon, PreviousPageIcon } from "@/components/ui/icons";
import { PILL_TONES, SelectedPhotoMark } from "@/components/ui/SelectedPhotoMark";
import { cn } from "@/lib/cn";

const PAGER_BUTTON =
  "flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-full border border-divider bg-paper px-2 text-sm font-semibold transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

// A pager's buttons, as 1-based page numbers with "gap" where a run of pages is collapsed into an ellipsis. Past seven
// pages the list is always seven items long, so the pager keeps one width as the visitor pages through.
const MAX_ITEMS = 7;

interface PagerProps {
  // Names the navigation landmark, such as "Photo pages".
  label: string;
  current: number;
  count: number;
  onChange: (page: number) => void;
  // A page to flag with a camera, such as the one holding the selected photo. When the pager collapses it into an
  // ellipsis, that ellipsis carries the camera instead.
  markedPage?: number | null;
  // Pages to give a count badge, mapped to how many photos on each have a problem. When the pager collapses some into
  // an ellipsis, that ellipsis carries their total instead.
  flaggedByPage?: Map<number, number>;
  // Finishes "2 photos …" in a flagged page's label, such as "couldn't be placed".
  flagDescription?: string;
}

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

// How many photos on a page are flagged, centered on the button's bottom edge. It takes the colors of the button it
// sits over.
function CountBadge({ count, onFilled }: { count: number; onFilled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute -bottom-3 left-1/2 flex h-3.5 min-w-3.5 -translate-x-1/2 items-center justify-center rounded-full px-0.5 text-xs leading-none font-bold box-content",
        onFilled ? PILL_TONES.currentPage : PILL_TONES.page,
      )}
    >
      {count}
    </span>
  );
}

/**
 * Previous and next plus numbered pages, 1-based. web/lib/hooks/useJustifiedPages.ts supplies current and count. With
 * focus anywhere in the pager, the left and right arrow keys step a page and Home and End jump to the first and last.
 */
export function Pager({
  label,
  current,
  count,
  onChange,
  markedPage = null,
  flaggedByPage = new Map(),
  flagDescription = "flagged",
}: PagerProps) {
  const items = pageItems(current, count);
  const navRef = useRef<HTMLElement>(null);

  // A key press moves focus to the new current page's button once it renders. The button that had focus can vanish
  // as the numbered pages shift, or be disabled, like Next on the last page.
  const focusCurrentRef = useRef(false);
  useEffect(() => {
    if (focusCurrentRef.current) {
      focusCurrentRef.current = false;
      navRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    }
  });

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    let page: number;
    switch (event.key) {
      case "ArrowLeft":
        page = current - 1;
        break;
      case "ArrowRight":
        page = current + 1;
        break;
      case "Home":
        page = 1;
        break;
      case "End":
        page = count;
        break;
      default:
        return;
    }

    event.preventDefault();
    page = Math.min(count, Math.max(1, page));
    if (page !== current) {
      focusCurrentRef.current = true;
      onChange(page);
    }
  }

  return (
    <nav
      ref={navRef}
      aria-label={label}
      onKeyDown={handleKeyDown}
      className="flex flex-wrap items-center justify-center gap-1"
    >
      <button
        type="button"
        aria-label="Previous page"
        onClick={() => onChange(current - 1)}
        disabled={current === 1}
        className={PAGER_BUTTON}
      >
        <PreviousPageIcon aria-hidden="true" className="h-4 w-4" />
      </button>
      {items.map((item, i) => {
        if (item === "gap") {
          // A gap always sits between two numbered pages and stands for every page between them.
          const hidesMarked =
            markedPage !== null && markedPage > Number(items[i - 1]) && markedPage < Number(items[i + 1]);
          const hiddenFlagged = [...flaggedByPage]
            .filter(([page]) => page > Number(items[i - 1]) && page < Number(items[i + 1]))
            .reduce((total, [, flagged]) => total + flagged, 0);
          return (
            // Two gaps can appear in one list, so each is named by the page before it.
            <span
              key={`gap-after-${items[i - 1]}`}
              aria-hidden="true"
              className="relative w-6 text-center text-sm text-muted-foreground"
            >
              …{hiddenFlagged > 0 ? <CountBadge count={hiddenFlagged} onFilled={false} /> : null}
              {hidesMarked ? <SelectedPhotoMark tone="page" className="-top-2.5 -left-1.5" /> : null}
            </span>
          );
        }

        const active = item === current;
        const marked = item === markedPage;
        const flaggedCount = flaggedByPage.get(item) ?? 0;

        let pageLabel = `Page ${item}`;
        if (marked) {
          pageLabel += ", has the selected photo";
        }
        if (flaggedCount > 0) {
          pageLabel += `, ${flaggedCount} ${flaggedCount === 1 ? "photo" : "photos"} ${flagDescription}`;
        }

        return (
          <button
            key={item}
            type="button"
            aria-label={pageLabel}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item)}
            className={cn(
              PAGER_BUTTON,
              "relative",
              active && "border-primary bg-primary text-primary-foreground hover:bg-primary",
            )}
          >
            {item}
            {flaggedCount > 0 ? <CountBadge count={flaggedCount} onFilled={active} /> : null}
            {marked ? (
              <SelectedPhotoMark tone={active ? "currentPage" : "page"} className="-top-2.5 -left-1.5" />
            ) : null}
          </button>
        );
      })}
      <button
        type="button"
        aria-label="Next page"
        onClick={() => onChange(current + 1)}
        disabled={current === count}
        className={PAGER_BUTTON}
      >
        <NextPageIcon aria-hidden="true" className="h-4 w-4" />
      </button>
    </nav>
  );
}
