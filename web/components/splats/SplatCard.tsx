/**
 * One splat's card: its cover photo, its name and photo count, and optionally a status chip.
 *
 * The /splats library lays these cards out in justified rows, and so do the examples on the / landing page.
 * splatCardAspect() gives each card's shape, and SPLAT_CARD_ROWS the sizes the row layout needs, so both lists lay the
 * cards out the same way.
 */

import Link from "next/link";

import { Chip } from "@/components/ui/Chip";
import { ThumbnailPlaceholderIcon } from "@/components/ui/icons";
import type { SplatBadge } from "@/lib/splatBadge";
import type { SplatListItem } from "@/lib/types";

type SplatCardFields = Pick<
  SplatListItem,
  "name" | "photoCount" | "thumbnailPhotoUrl" | "thumbnailWidth" | "thumbnailHeight"
>;

/**
 * The web/lib/hooks/useJustifiedPages.ts options for a list of these cards. The list the cards render in needs the
 * matching `flex flex-wrap gap-x-6 gap-y-7` classes.
 */
export const SPLAT_CARD_ROWS = {
  // About the height of a card image. Each full row stretches a little past it to fill the width.
  rowHeightRem: 14.75,
  columnGapRem: 1.5,
  rowGapRem: 1.75,
  // The name line below each card image: its gap-3 plus text-2xl's 2rem line.
  captionRem: 2.75,
};

/** The card image's width over height: its thumbnail's shape, or 4:3 for a splat with no sized thumbnail. */
export function splatCardAspect(splat: SplatCardFields) {
  if (splat.thumbnailWidth === null || splat.thumbnailHeight === null) {
    return 4 / 3;
  }

  return splat.thumbnailWidth / splat.thumbnailHeight;
}

interface SplatCardProps {
  splat: SplatCardFields;
  href: string;
  // The status chip over the image. Null shows none.
  badge: SplatBadge | null;
}

export function SplatCard({ splat, href, badge }: SplatCardProps) {
  let thumbnail: React.ReactNode = null;
  if (splat.thumbnailPhotoUrl) {
    thumbnail = (
      // biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image.
      <img
        src={splat.thumbnailPhotoUrl}
        alt=""
        draggable={false}
        className="relative h-full w-full object-cover transition-transform group-hover:scale-102"
      />
    );
  }

  let chip: React.ReactNode = null;
  if (badge !== null) {
    chip = <Chip color={badge.color} label={badge.label} className="absolute top-2 left-3.5" />;
  }

  return (
    <Link href={href} className="group flex flex-col gap-3">
      <div style={{ aspectRatio: splatCardAspect(splat) }} className="relative overflow-hidden rounded-3xl bg-muted">
        {/* Shows until the thumbnail loads and covers it, and stays for a splat with no photos. The thumbnail is relative
        so it paints above this absolutely positioned icon. */}
        <ThumbnailPlaceholderIcon
          aria-hidden="true"
          strokeWidth={1}
          className="absolute inset-0 m-auto h-8 w-8 text-muted-foreground"
        />
        {thumbnail}
        {chip}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-display text-2xl">{splat.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {splat.photoCount} photo{splat.photoCount === 1 ? "" : "s"}
        </span>
      </div>
    </Link>
  );
}
