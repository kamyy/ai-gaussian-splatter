"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { Center } from "@/components/layout/Center";
import { useSplats } from "@/lib/hooks";
import { CreateSplatModal } from "./CreateSplatModal";
import { ScrollEdgeButton } from "./ScrollEdgeButton";
import { SplatCarouselCard } from "./SplatCarouselCard";
import { useDragMomentumScroll } from "./useDragMomentumScroll";

// The navbar Box in web/app/(authenticated)/splats/layout.tsx spans the full viewport height and gives this
// component a definite height to fill, minus its own tiny top/bottom padding. The scroll
// container below stretches to it so the list reaches near the bottom of the viewport. It's plain overflow-y, not a
// JS carousel, so the mouse wheel and a trackpad scroll it natively and it gets a real (if thinned, see
// .thin-scrollbar in app/globals.css) scrollbar for free — click-and-drag panning with momentum is layered on top by
// useDragMomentumScroll.
export function SplatCarousel() {
  const { data: splats, isLoading, error } = useSplats();
  const [modalOpened, setModalOpened] = useState(false);
  const {
    elementRef: scrollRef,
    isPanning,
    stopMomentum,
    dragHandlers,
  } = useDragMomentumScroll<HTMLDivElement>({
    axis: "y",
  });

  return (
    <Box sx={{ p: 1.5, height: "100%", position: "relative" }}>
      <Stack spacing={0.5} sx={{ height: "100%" }}>
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
              <ScrollEdgeButton
                label="Scroll to first splat"
                rotation={180}
                onClick={() => {
                  stopMomentum();
                  scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
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
                cursor: isPanning ? "grabbing" : "grab",
                userSelect: isPanning ? "none" : undefined,
              }}
            >
              {splats.map(splat => (
                <SplatCarouselCard key={splat.id} splat={splat} />
              ))}
            </Stack>
            <Center>
              <ScrollEdgeButton
                label="Scroll to last splat"
                rotation={0}
                onClick={() => {
                  stopMomentum();
                  const el = scrollRef.current;
                  if (el) {
                    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  }
                }}
              />
            </Center>
          </>
        )}
        <Button size="small" sx={{ borderRadius: "9999px" }} onClick={() => setModalOpened(true)}>
          New Splat
        </Button>
      </Stack>

      <CreateSplatModal opened={modalOpened} onClose={() => setModalOpened(false)} />
    </Box>
  );
}
