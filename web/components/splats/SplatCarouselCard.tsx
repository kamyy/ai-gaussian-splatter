"use client";

import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";

import { Center } from "@/components/layout/Center";
import { rem } from "@/lib/rem";
import type { SplatListItem } from "@/lib/types";
import { useActiveSplatId } from "@/lib/useActiveSplatId";

interface SplatCarouselCardProps {
  splat: SplatListItem;
}

// Sized by width (height: "auto"), not a fixed box: unlike the horizontally-scrolling filmstrip in
// PhotoFilmstrip.tsx, this card has no scroll to absorb a wider photo, so the thumbnail fills the card's content
// width and grows or shrinks in height to match, at its own aspect ratio. No cropping and no letterboxing.

// This file is "use client", so the Server Component restriction AGENTS.md documents doesn't apply and
// `component={Link}` works here.
export function SplatCarouselCard({ splat }: SplatCarouselCardProps) {
  const isActive = useActiveSplatId() === splat.id;

  const content = (
    <Box sx={{ p: 1.5 }}>
      <Stack spacing={0.5}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
          {splat.name}
        </Typography>
        <Stack direction="row" spacing={0.5}>
          {splat.hasUploadedPhotos && <Chip size="small" color="success" label="Photos" />}
          {splat.hasPointCloud && <Chip size="small" color="success" label="Point cloud" />}
          {splat.hasTrainedSplat && <Chip size="small" color="success" label="Splat" />}
        </Stack>
      </Stack>

      {splat.thumbnailPhotoUrl ? (
        // biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image.
        <img
          src={splat.thumbnailPhotoUrl}
          alt=""
          draggable={false}
          style={{
            marginTop: rem(10),
            width: "100%",
            height: "auto",
            borderRadius: rem(4),
          }}
        />
      ) : (
        <Center
          sx={{
            marginTop: rem(10),
            width: "100%",
            aspectRatio: "1",
            borderRadius: rem(4),
            backgroundColor: "action.hover",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            No photos
          </Typography>
        </Center>
      )}
    </Box>
  );

  // A Link to the splat you're already viewing would still navigate: the bare /splats/[id] route differs from the
  // sub-route (point-cloud/splat) actually showing, so it would bounce through SplatDefaultRoutePage's redirect and
  // remount the whole workspace chrome for no reason. Rendered as a plain Card instead, with no href, when it's the
  // one already open.
  if (isActive) {
    return <Card variant="outlined">{content}</Card>;
  }
  return (
    <Card variant="outlined">
      <CardActionArea component={Link} href={`/splats/${splat.id}`} draggable={false}>
        {content}
      </CardActionArea>
    </Card>
  );
}
