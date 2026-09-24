"use client";

import { useAuth } from "@clerk/nextjs";
import { useLayoutEffect, useRef, useState } from "react";

import { Card } from "@/components/layout/Card";
import { Center } from "@/components/layout/Center";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiFetch";
import { cn } from "@/lib/cn";
import { useLatestJob, usePhotos } from "@/lib/hooks";
import { type Job, JobStatus } from "@/lib/types";
import { useAppSnackbar } from "@/lib/useAppSnackbar";
import { ScrollEdgeButton } from "./ScrollEdgeButton";
import { useDragMomentumScroll } from "./useDragMomentumScroll";

// The filmstrip's signature motif: a row of small holes along the strip's edge, like film run through a
// projector gate. A repeating radial-gradient needs no image asset. Used above and below the photo row, inside
// the same scrollable element as the photos (see the `filmstripRef` div below) so the holes scroll along with
// the film rather than staying fixed while only the photos move.
function SprocketStrip() {
  return (
    <div
      className="mx-4 h-2.5"
      style={{
        // var(--color-muted-foreground) (not a literal hex) so this tracks the active [data-theme] rather than
        // freezing to one.
        backgroundImage: "radial-gradient(circle, var(--color-muted-foreground) 2px, transparent 2.5px)",
        // backgroundPosition is always half of backgroundSize's width, so the first hole lands centered in its own
        // tile instead of clipped at the strip's left edge.
        backgroundSize: "2.5rem 0.625rem",
        backgroundPosition: "1.25rem center",
      }}
    />
  );
}

// Exported so a page hosting this filmstrip (web/app/(authenticated)/splats/[id]/{splat,point-cloud}/page.tsx) can
// size its own bottom gap to clear exactly the closed/collapsed handle, rather than a hand-synced duplicate of
// this number.
export const HANDLE_HEIGHT = 40;
// Those same pages' gap above their SplatViewer, kept smaller than the bottom one since it only has to clear the
// header, not a fixed panel.
export const VIEWER_TOP_GAP = 16;
// Those pages' gap below their SplatViewer: HANDLE_HEIGHT would only just clear the closed handle with nothing to
// spare, leaving no room for the viewer's own drop shadow (web/components/viewer/SplatViewer.tsx) to show.
export const VIEWER_BOTTOM_GAP = HANDLE_HEIGHT + 8;
// Each photo is sized by height only, at its own natural aspect ratio (width: "auto"), so the whole photo shows with no
// letterboxing and no cropping.
const FILMSTRIP_PHOTO_HEIGHT = 150;
// Starting guess for the body's height, used only until the ResizeObserver below reports the real one (SSR and the
// very first client render, before that effect has run). Hand-tuning this as a fixed constant kept leaving dead
// space at the bottom of the panel because it never quite matched the actual rendered spacing; measuring the real
// DOM node removes the guesswork entirely.
const INITIAL_BODY_HEIGHT_GUESS = 200;
const DRAG_TAP_THRESHOLD_PX = 4;

interface PhotoFilmstripProps {
  splatId: string;
}

// A bottom sheet, not a route: photos can only be added in web/components/splats/NewSplatForm.tsx, so this is
// just a horizontal filmstrip of what got uploaded. It's rendered by web/app/(authenticated)/splats/[id]/layout.tsx
// over every sub-route instead of living on a photos-only page. The "Start reconstruction" action floats over the
// canvas at the bottom right instead of sitting in the panel's own body, matching the floating "Start training"
// button in web/components/viewer/AwaitingTrainingPanel.tsx. Its bottom offset clears the closed handle's height,
// not the panel's actual (possibly taller, if opened) height — a manually opened filmstrip can still overlap it,
// the same precedent web/components/job/JobStatusSnackbar.tsx already sets.
export function PhotoFilmstrip({ splatId }: PhotoFilmstripProps) {
  const { getToken } = useAuth();
  const { enqueueSnackbar } = useAppSnackbar();
  const { data: photos, isLoading } = usePhotos(splatId);
  const { data: job, isLoading: jobLoading, mutate: refetchJob } = useLatestJob(splatId);
  const [starting, setStarting] = useState(false);
  const {
    elementRef: filmstripRef,
    isPanning: isPanningFilmstrip,
    stopMomentum,
    scrollToStart: scrollFilmstripToStart,
    scrollToEnd: scrollFilmstripToEnd,
    dragHandlers,
  } = useDragMomentumScroll<HTMLDivElement>({ axis: "x" });

  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(INITIAL_BODY_HEIGHT_GUESS);
  // Tracks the body's real rendered height — it changes as photos load in, etc. — so the panel's total height and
  // the drag open/close math below always match what's actually on screen.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) {
      return;
    }
    // el.offsetHeight, not entry.contentRect.height: the latter excludes padding, and this element has px/pb
    // padding of its own that needs to count toward the panel's total height. The equality check skips a
    // state-update (and the render/layout pass it triggers) when a resize firing doesn't actually change the height.
    const observer = new ResizeObserver(() => {
      const height = el.offsetHeight;
      setBodyHeight(prev => (prev === height ? prev : height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [opened, setOpened] = useState(false);
  // Non-null only while a pointer is down on the handle: the panel's transform tracks it 1:1 during a drag instead
  // of jumping straight to its snapped open/closed position.
  const [dragY, setDragY] = useState<number | null>(null);
  const dragStartRef = useRef<{ pointerY: number; panelY: number } | null>(null);

  // jobLoading, not just job === undefined: the first fetch is also undefined while in flight, including on every
  // navigation between splats, and this button now floats directly on the canvas (it used to sit inside the closed
  // filmstrip), so that gap is clickable. Offering it there risks a second POST /process on a splat whose job is
  // still active — the server only rejects that with a 409, it doesn't check splat status.
  const canStartReconstruction =
    !jobLoading && (job === undefined || job.status === JobStatus.failed || job.status === JobStatus.cancelled);

  async function handleStartReconstruction() {
    setStarting(true);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      await apiFetch<Job>(`/api/v1/splats/${splatId}/process`, "POST", token);
      void refetchJob();
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : "Failed to start reconstruction", { variant: "error" });
    } finally {
      setStarting(false);
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const panelY = opened ? 0 : bodyHeight;
    dragStartRef.current = { pointerY: event.clientY, panelY };
    setDragY(panelY);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const start = dragStartRef.current;
    if (!start) {
      return;
    }
    const delta = event.clientY - start.pointerY;
    setDragY(Math.min(bodyHeight, Math.max(0, start.panelY + delta)));
  }

  function handlePointerUp() {
    const start = dragStartRef.current;
    if (start && dragY !== null) {
      // A drag that barely moved is a tap on the handle: flip the state outright rather than snapping to whichever
      // side of the midpoint the pointer happened to land on.
      if (Math.abs(dragY - start.panelY) < DRAG_TAP_THRESHOLD_PX) {
        setOpened(o => !o);
      } else {
        setOpened(dragY < bodyHeight / 2);
      }
    }
    dragStartRef.current = null;
    setDragY(null);
  }

  // A mouse/touch tap is already toggled by handlePointerUp above. Native <button> click events fire after that on
  // every pointer type too, but only a keyboard-triggered activation (Enter/Space) has no preceding pointer session
  // — that's the `detail === 0` case a browser uses for a synthetic, non-pointer click.
  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) {
      setOpened(o => !o);
    }
  }

  // A plain vertical mouse wheel doesn't scroll horizontal overflow on its own — this is the standard translation
  // (deltaY onto scrollLeft) filmstrips/galleries use so a normal wheel, not just a trackpad's native horizontal
  // swipe, works here too.
  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    stopMomentum();
    event.currentTarget.scrollBy({ left: event.deltaY });
  }

  const translateY = dragY ?? (opened ? 0 : bodyHeight);
  const photoCount = photos?.length ?? 0;

  return (
    <>
      <div
        className="pointer-events-auto absolute right-2 bottom-0 left-2 rounded-t-3xl border border-divider bg-paper"
        style={{
          // HANDLE_HEIGHT/bodyHeight and translateY stay raw px, not rem: they're compared against and driven by
          // PointerEvent.clientY in the drag handlers below, which browsers always report in real CSS pixels
          // regardless of root font-size. Converting only the height here would desync the panel's drawn size from
          // its own drag thresholds under a non-default browser zoom.
          height: HANDLE_HEIGHT + bodyHeight,
          transform: `translateY(${translateY}px)`,
          transition: dragY === null ? "transform 150ms ease" : "none",
        }}
      >
        <button
          type="button"
          aria-expanded={opened}
          aria-label={opened ? "Close photos panel" : "Open photos panel"}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handleClick}
          className="h-10 w-full cursor-grab touch-none"
        >
          <Center className="h-full w-full">
            <div className="flex flex-col items-center gap-1">
              <div className="h-1 w-9 rounded-xs bg-divider" />
              <span className="text-xs text-muted-foreground">
                {photoCount} photo{photoCount === 1 ? "" : "s"}
              </span>
            </div>
          </Center>
        </button>

        {/* Not given an explicit height: it needs to size itself naturally so the ResizeObserver above can measure
        that natural size and hand it to the panel above instead. Forcing this element to bodyHeight would clamp it
        to whatever was last measured, so ResizeObserver would just keep reporting that same number back. */}
        <div ref={bodyRef} className="flex flex-col gap-3 px-4 pb-4">
          {isLoading && (
            <div
              className="animate-pulse bg-divider"
              style={{ height: FILMSTRIP_PHOTO_HEIGHT, width: FILMSTRIP_PHOTO_HEIGHT }}
            />
          )}
          {!isLoading && photos && photos.length === 0 && (
            <p className="text-muted-foreground">No photos uploaded yet.</p>
          )}
          {!isLoading && photos && photos.length > 0 && (
            <div className="flex flex-nowrap items-center gap-2">
              <ScrollEdgeButton label="Scroll to first photo" direction="left" onClick={scrollFilmstripToStart} />
              <div
                ref={filmstripRef}
                onWheel={handleWheel}
                {...dragHandlers}
                className={cn(
                  "thin-scrollbar min-w-0 flex-1 overflow-x-auto bg-divider/20",
                  isPanningFilmstrip ? "cursor-grabbing select-none" : "cursor-grab",
                )}
              >
                {/* w-fit so the sprocket strips below stretch to exactly the photo row's own rendered width, not
                the (narrower) visible scroll viewport — since all three are inside the same scrollable div, they
                scroll together as one strip instead of the holes staying fixed while only the photos move. */}
                <div className="flex w-fit flex-col gap-2">
                  <SprocketStrip />
                  <div className="flex flex-row flex-nowrap gap-3">
                    {photos.map((photo, index) => (
                      <div key={photo.id} className="flex shrink-0 flex-col items-center gap-1">
                        <span className="text-xs text-muted-foreground italic">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        {/* The mat border is a print mount, distinct from the panel it sits on (this panel is
                        itself bg-paper), so bg-background reads as a frame in both modes with no separate
                        light/dark logic needed here. */}
                        <div className="bg-background p-1">
                          {/* biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image. */}
                          <img
                            src={photo.url}
                            alt={photo.originalFilename}
                            loading="lazy"
                            draggable={false}
                            className="block h-37.5 w-auto"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <SprocketStrip />
                </div>
              </div>
              <ScrollEdgeButton label="Scroll to last photo" direction="right" onClick={scrollFilmstripToEnd} />
            </div>
          )}
        </div>
      </div>

      {canStartReconstruction && (
        <Card className="pointer-events-auto absolute right-4 bottom-14">
          <Button variant="contained" onClick={handleStartReconstruction} loading={starting}>
            Start reconstruction
          </Button>
        </Card>
      )}
    </>
  );
}
