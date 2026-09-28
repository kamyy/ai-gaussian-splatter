import { LuChevronLeft, LuChevronRight } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { pageItems } from "@/lib/pageItems";

const PAGER_BUTTON =
  "flex h-9 min-w-9 items-center justify-center rounded-full border border-divider bg-paper px-2 text-sm font-semibold transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

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

// Previous and next plus numbered pages, 1-based. web/lib/useJustifiedPages.ts supplies current and count.
export function Pager({ label, current, count, onChange, markedPage = null }: PagerProps) {
  const items = pageItems(current, count);
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-center gap-1">
      <button
        type="button"
        aria-label="Previous page"
        onClick={() => onChange(current - 1)}
        disabled={current === 1}
        className={PAGER_BUTTON}
      >
        <LuChevronLeft aria-hidden="true" className="h-4 w-4" />
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
        <LuChevronRight aria-hidden="true" className="h-4 w-4" />
      </button>
    </nav>
  );
}
