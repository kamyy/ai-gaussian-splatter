import Link from "next/link";

import { Chip } from "@/components/ui/Chip";
import { splatBadge } from "@/lib/splatBadge";
import type { SplatListItem } from "@/lib/types";

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
        className="h-full w-full object-cover transition-transform group-hover:scale-102"
      />
    );
  }

  return (
    <Link href={`/splats/${splat.id}`} className="group flex flex-col gap-3">
      <div className="relative h-59 overflow-hidden rounded-3xl bg-muted">
        {thumbnail}
        {/* The tinted chip colors are translucent, so a paper backing keeps them legible over any photo. */}
        <span className="absolute top-3.5 left-3.5 rounded-full bg-paper">
          <Chip color={badge.color} label={badge.label} />
        </span>
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
