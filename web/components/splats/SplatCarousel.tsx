"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { Card } from "@/components/layout/Card";
import { Center } from "@/components/layout/Center";
import { useSplats } from "@/lib/hooks";
import { CreateSplatModal } from "./CreateSplatModal";
import { ScrollEdgeButton } from "./ScrollEdgeButton";
import { SplatCarouselCard } from "./SplatCarouselCard";
import { useDragMomentumScroll } from "./useDragMomentumScroll";

// The navbar Box in web/app/(authenticated)/splats/layout.tsx spans the full viewport height and gives this component a
// definite height to fill, minus its own tiny top/bottom padding. The scroll container below stretches to it so the
// list reaches near the bottom of the viewport. It's plain overflow-y, not a JS carousel, so the mouse wheel and a
// trackpad scroll it natively and it gets a real (if thinned, see .thin-scrollbar in web/app/globals.css) scrollbar for
// free — click-and-drag panning with momentum is layered on top by useDragMomentumScroll.
export function SplatCarousel() {
  const { data: splats, isLoading, error } = useSplats();
  const [modalOpened, setModalOpened] = useState(false);
  const {
    elementRef: scrollRef,
    isPanning,
    scrollToStart: scrollCarouselToStart,
    scrollToEnd: scrollCarouselToEnd,
    dragHandlers,
  } = useDragMomentumScroll<HTMLDivElement>({
    axis: "y",
  });

  return (
    <Box sx={{ p: 1.5, height: "100%", position: "relative" }}>
      <Stack spacing={0.5} sx={{ height: "100%" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: 0.5, pb: 0.5 }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="6" width="18" height="12" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {/* variant="h6" for the display font (theme h1-h6 override in web/theme.ts), component="span" since this
          is a sidebar label, not a document heading. */}
          <Typography variant="h6" component="span" color="text.secondary" sx={{ fontSize: "0.875rem" }}>
            AI Gaussian Splatter
          </Typography>
        </Stack>
        <Card sx={{ display: "flex", justifyContent: "center" }}>
          <Button variant="contained" size="small" onClick={() => setModalOpened(true)}>
            Create new splat
          </Button>
        </Card>
        {isLoading && <Skeleton variant="rectangular" sx={{ flex: 1 }} />}
        {!isLoading && error && (
          <Typography variant="body2" color="error" sx={{ textAlign: "center", py: 2 }}>
            Failed to load splats.
          </Typography>
        )}
        {!isLoading && !error && splats && splats.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", py: 2 }}>
            No splats yet.
          </Typography>
        )}
        {!isLoading && !error && splats && splats.length > 0 && (
          <>
            <Center>
              <ScrollEdgeButton label="Scroll to first splat" direction="up" onClick={scrollCarouselToStart} />
            </Center>
            <Stack
              ref={scrollRef}
              {...dragHandlers}
              spacing={1}
              className="thin-scrollbar"
              sx={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                // MUI Card sets overflow: hidden, which makes a flex item's min-height: auto compute as 0. The
                // cards then shrink to fit this column instead of overflowing it, so there is nothing to scroll
                // and they stack on top of each other. Keep each card at its content height.
                "& > *": { flexShrink: 0 },
                // Reserves the scrollbar's gutter unconditionally, so a list that grows past the viewport doesn't
                // shrink every card's (and thumbnail's, since those are width 100% / height auto) width the moment
                // a scrollbar appears. A previous version tried to counter that reserved gutter with a matching
                // negative margin so cards stayed exactly as wide as the "Create new splat" button above them, but
                // the margin was sized off the parent Box's own padding, not the actual (browser/OS-dependent)
                // scrollbar width, so it either under- or over-corrected depending on platform. Left uncorrected,
                // cards in this list are consistently a few pixels narrower than that button; that's a smaller,
                // constant cosmetic gap rather than a value that silently drifted with whatever the real gutter
                // happened to be.
                scrollbarGutter: "stable",
                cursor: isPanning ? "grabbing" : "grab",
                userSelect: isPanning ? "none" : undefined,
              }}
            >
              {splats.map(splat => (
                <SplatCarouselCard key={splat.id} splat={splat} />
              ))}
            </Stack>
            <Center>
              <ScrollEdgeButton label="Scroll to last splat" direction="down" onClick={scrollCarouselToEnd} />
            </Center>
          </>
        )}
      </Stack>

      <CreateSplatModal opened={modalOpened} onClose={() => setModalOpened(false)} />
    </Box>
  );
}
