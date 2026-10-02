/**
 * A page's title, with a round back-arrow button before it that returns to the page's parent.
 *
 * The owner's pages send the button to the /splats library, and the public share page sends it to the / landing page.
 * The button sits in the title's row, so the title keeps the column's top line to itself.
 */

import Link from "next/link";

import { buttonClassName } from "@/components/ui/Button";
import { BackIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";

interface PageTitleProps {
  backHref: string;
  // The back button's tooltip and accessible name, such as "Back to Library".
  backLabel: string;
  children: React.ReactNode;
}

function BackButton({ href, label }: { href: string; label: string }) {
  return (
    <Tooltip label={label}>
      <Link href={href} aria-label={label} className={buttonClassName("outlined", "icon")}>
        <BackIcon aria-hidden="true" className="h-4.5 w-4.5" />
      </Link>
    </Tooltip>
  );
}

export function PageTitle({ backHref, backLabel, children }: PageTitleProps) {
  return (
    <div className="flex items-center gap-3.5">
      <BackButton href={backHref} label={backLabel} />
      <h1 className="min-w-0 font-display text-5xl leading-none tracking-tight">{children}</h1>
    </div>
  );
}
