"use client";

import { useState } from "react";

import { Card } from "@/components/layout/Card";
import { Center } from "@/components/layout/Center";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
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
    <div className="relative h-full p-3">
      <div className="flex h-full flex-col gap-1">
        <div className="flex items-center gap-2 px-1 pb-1">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="6" width="18" height="12" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <span className="font-display text-sm text-muted-foreground">AI Gaussian Splatter</span>
        </div>
        <Card className="flex justify-center">
          <Button variant="contained" size="small" onClick={() => setModalOpened(true)}>
            Create new splat
          </Button>
        </Card>
        {isLoading && <div className="flex-1 animate-pulse bg-divider" />}
        {!isLoading && error && <p className="py-4 text-center text-sm text-error">Failed to load splats.</p>}
        {!isLoading && !error && splats && splats.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No splats yet.</p>
        )}
        {!isLoading && !error && splats && splats.length > 0 && (
          <>
            <Center>
              <ScrollEdgeButton label="Scroll to first splat" direction="up" onClick={scrollCarouselToStart} />
            </Center>
            <div
              ref={scrollRef}
              {...dragHandlers}
              className={cn(
                "thin-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto [scrollbar-gutter:stable] [&>*]:shrink-0",
                isPanning ? "cursor-grabbing select-none" : "cursor-grab",
              )}
            >
              {splats.map(splat => (
                <SplatCarouselCard key={splat.id} splat={splat} />
              ))}
            </div>
            <Center>
              <ScrollEdgeButton label="Scroll to last splat" direction="down" onClick={scrollCarouselToEnd} />
            </Center>
          </>
        )}
      </div>

      <CreateSplatModal opened={modalOpened} onClose={() => setModalOpened(false)} />
    </div>
  );
}
