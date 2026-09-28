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
}

// Previous and next plus numbered pages, 1-based. web/lib/useJustifiedPages.ts supplies current and count.
export function Pager({ label, current, count, onChange }: PagerProps) {
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
      {pageItems(current, count).map((item, i) => {
        if (item === "gap") {
          return (
            // Two gaps can appear in one list, so the index tells them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: a gap has no identity of its own.
            <span key={`gap-${i}`} aria-hidden="true" className="w-6 text-center text-sm text-muted-foreground">
              …
            </span>
          );
        }
        const active = item === current;
        return (
          <button
            key={item}
            type="button"
            aria-label={`Page ${item}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item)}
            className={cn(PAGER_BUTTON, active && "border-primary bg-primary text-primary-foreground hover:bg-primary")}
          >
            {item}
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
