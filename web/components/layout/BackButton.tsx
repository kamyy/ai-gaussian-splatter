/**
 * The round back-arrow button that returns to a page's parent.
 *
 * It sits in a row beside a page's title, so the title keeps the column's top line to itself. The owner's pages send
 * it to the /splats library, and the public share page sends it to the / landing page.
 */

import Link from "next/link";

import { BackIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";

interface BackButtonProps {
  href: string;
  label: string;
}

export function BackButton({ href, label }: BackButtonProps) {
  return (
    <Tooltip label={label}>
      <Link
        href={href}
        aria-label={label}
        className="flex h-10 w-10 shrink-0 items-center justify-center pointer-coarse:h-11 pointer-coarse:w-11 rounded-full border border-outline text-foreground transition-colors hover:border-muted-foreground hover:bg-muted"
      >
        <BackIcon aria-hidden="true" className="h-4.5 w-4.5" />
      </Link>
    </Tooltip>
  );
}
