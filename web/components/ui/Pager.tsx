/**
 * Page-number navigation for a paged list.
 *
 * Shows previous and next buttons around numbered pages, collapsing long runs into an ellipsis so the pager stays one
 * width. The library, the photo grid and the new-splat form's previews all page with it.
 */

"use client";

import { useEffect, useRef } from "react";

import { NextPageIcon, PreviousPageIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

const PAGER_BUTTON =
  "flex h-9 min-w-9 items-center justify-center rounded-full border border-divider bg-paper px-2 text-sm font-semibold transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

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

interface PagerProps {
  // Names the navigation landmark, such as "Photo pages".
  label: string;
  current: number;
  count: number;
  onChange: (page: number) => void;
  // A page to flag with a pip, such as the one holding the selected photo. When the pager collapses it into an
  // ellipsis, that ellipsis carries the pip instead.
  markedPage?: number | null;
}

// Its border is the page's background color, which sets it apart from a filled current-page button too.
function MarkPip() {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-0.75 -right-0.75 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary"
    />
  );
}

/**
 * Previous and next plus numbered pages, 1-based. web/lib/hooks/useJustifiedPages.ts supplies current and count. With
 * focus anywhere in the pager, the left and right arrow keys step a page and Home and End jump to the first and last.
 */
export function Pager({ label, current, count, onChange, markedPage = null }: PagerProps) {
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
          return (
            // Two gaps can appear in one list, so each is named by the page before it.
            <span
              key={`gap-after-${items[i - 1]}`}
              aria-hidden="true"
              className="relative w-6 text-center text-sm text-muted-foreground"
            >
              …{hidesMarked ? <MarkPip /> : null}
            </span>
          );
        }

        const active = item === current;
        const marked = item === markedPage;

        return (
          <button
            key={item}
            type="button"
            aria-label={marked ? `Page ${item}, has the selected photo` : `Page ${item}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item)}
            className={cn(
              PAGER_BUTTON,
              "relative",
              active && "border-primary bg-primary text-primary-foreground hover:bg-primary",
            )}
          >
            {item}
            {marked ? <MarkPip /> : null}
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
