/**
 * The round back-arrow button that returns to the /splats library.
 *
 * It sits in a row beside a page's title, so the title keeps the column's top line to itself.
 */

import Link from "next/link";
import { LuArrowLeft } from "react-icons/lu";

import { Tooltip } from "@/components/ui/Tooltip";

export function BackToLibraryButton() {
  return (
    <Tooltip label="Back to Library">
      <Link
        href="/splats"
        aria-label="Back to Library"
        className="flex h-10 w-10 shrink-0 items-center justify-center pointer-coarse:h-11 pointer-coarse:w-11 rounded-full border border-outline text-foreground transition-colors hover:border-muted-foreground hover:bg-muted"
      >
        <LuArrowLeft aria-hidden="true" className="h-4.5 w-4.5" />
      </Link>
    </Tooltip>
  );
}
