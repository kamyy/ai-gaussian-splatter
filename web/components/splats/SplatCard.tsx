import Link from "next/link";
import { LuImage } from "react-icons/lu";

import { Chip } from "@/components/ui/Chip";
import { splatBadge } from "@/lib/splatBadge";
import type { SplatListItem } from "@/lib/types";

// The card image's width over height: its thumbnail's shape, or 4:3 for a splat with no sized thumbnail.
export function splatCardAspect(splat: SplatListItem) {
  if (splat.thumbnailWidth === null || splat.thumbnailHeight === null) {
    return 4 / 3;
  }
  return splat.thumbnailWidth / splat.thumbnailHeight;
}

export function SplatCard({ splat }: { splat: SplatListItem }) {
  const badge = splatBadge(splat);

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

  return (
    <Link href={`/splats/${splat.id}`} className="group flex flex-col gap-3">
      <div style={{ aspectRatio: splatCardAspect(splat) }} className="relative overflow-hidden rounded-3xl bg-muted">
        {/* Shows until the thumbnail loads and covers it, and stays for a splat with no photos. The thumbnail is relative
        so it paints above this absolutely positioned icon. */}
        <LuImage aria-hidden="true" strokeWidth={1} className="absolute inset-0 m-auto h-8 w-8 text-muted-foreground" />
        {thumbnail}
        <Chip color={badge.color} label={badge.label} className="absolute top-2 left-3.5" />
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
