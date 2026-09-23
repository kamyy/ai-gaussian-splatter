"use client";

import Link from "next/link";
import { CARD_SHADOW } from "@/components/layout/Card";
import { Center } from "@/components/layout/Center";
import { Chip } from "@/components/ui/Chip";
import type { SplatListItem } from "@/lib/types";
import { useActiveSplatId } from "@/lib/useActiveSplatId";

interface SplatCarouselCardProps {
  splat: SplatListItem;
}

export function SplatCarouselCard({ splat }: SplatCarouselCardProps) {
  const isActive = useActiveSplatId() === splat.id;

  const content = (
    <div className="p-3">
      <div className="flex flex-col gap-1">
        <p className="truncate text-sm font-medium">{splat.name}</p>
        <div className="flex flex-row gap-1">
          {splat.hasUploadedPhotos && <Chip size="small" color="success" label="Photos" />}
          {splat.hasPointCloud && <Chip size="small" color="success" label="Point cloud" />}
          {splat.hasTrainedSplat && <Chip size="small" color="success" label="Splat" />}
        </div>
      </div>

      {/* The mat border is a print mount, distinct from the card it sits on (bg-paper), so bg-background reads as
      a frame in both modes. The active card also gets a grease-pencil ring around it, like a frame circled for
      printing on a real contact sheet. */}
      <div className="relative mt-[0.625rem] bg-background p-1">
        {isActive && <div className="pointer-events-none absolute -inset-1.5 rounded-full border-2 border-primary" />}
        {splat.thumbnailPhotoUrl ? (
          // Sized by width (height: "auto"), not a fixed box. Unlike the horizontally-scrolling filmstrip in
          // web/components/splats/PhotoFilmstrip.tsx, this card has no scroll to absorb a wider photo, so the
          // thumbnail fills the card's content width and grows or shrinks in height to match, at its own aspect
          // ratio. No cropping and no letterboxing.
          // biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image.
          <img src={splat.thumbnailPhotoUrl} alt="" draggable={false} className="block h-auto w-full" />
        ) : (
          <Center className="aspect-square w-full bg-divider/30">
            <p className="text-xs text-muted-foreground">No photos</p>
          </Center>
        )}
      </div>
    </div>
  );

  const cardClassName = "border border-divider bg-paper";

  // A Link to the splat you're already viewing would still navigate: the bare /splats/[id] route differs from the
  // sub-route (point-cloud/splat) actually showing, so it would bounce through SplatDefaultRoutePage's redirect and
  // remount the whole workspace chrome for no reason. Rendered as a plain, non-interactive card instead, with no
  // href, when it's the one already open.
  if (isActive) {
    return (
      <div className={cardClassName} style={{ boxShadow: CARD_SHADOW }}>
        {content}
      </div>
    );
  }
  return (
    <div className={cardClassName} style={{ boxShadow: CARD_SHADOW }}>
      <Link href={`/splats/${splat.id}`} draggable={false} className="block">
        {content}
      </Link>
    </div>
  );
}
