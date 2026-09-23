"use client";

import { useAuth } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useLayoutEffect, useRef, useState } from "react";

import { CARD_SHADOW, Card } from "@/components/layout/Card";
import { Center } from "@/components/layout/Center";
import { apiFetch } from "@/lib/apiFetch";
import { useLatestJob, usePhotos } from "@/lib/hooks";
import { rem } from "@/lib/rem";
import { type Job, JobStatus } from "@/lib/types";
import { useAppSnackbar } from "@/lib/useAppSnackbar";
import { ScrollEdgeButton } from "./ScrollEdgeButton";
import { useDragMomentumScroll } from "./useDragMomentumScroll";

// The filmstrip's signature motif: a row of small holes along the strip's edge, like film run through a
// projector gate. A repeating radial-gradient needs no image asset. Used above and below the photo row, inside
// the same scrollable element as the photos (see the `filmstripRef` Box below) so the holes scroll along with
// the film rather than staying fixed while only the photos move.
function SprocketStrip() {
  return (
    <Box
      sx={{
        height: rem(10),
        mx: 2,
        // theme.vars (not theme.palette) so this tracks the active scheme rather than freezing to
        // defaultColorScheme.
        backgroundImage: theme =>
          `radial-gradient(circle, ${theme.vars.palette.text.secondary} 2px, transparent 2.5px)`,
        // backgroundPosition is always half of backgroundSize's width, so the first hole lands centered in its own
        // tile instead of clipped at the strip's left edge.
        backgroundSize: `${rem(40)} ${rem(10)}`,
        backgroundPosition: `${rem(20)} center`,
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
// Each photo is sized by height only, at its own natural aspect ratio (width: "auto"). Unlike the fixed-width sidebar
// thumbnail in web/components/splats/SplatCarouselCard.tsx, there's room here to show the whole photo with no
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

// A bottom sheet, not a route: photos can only be added in web/components/splats/CreateSplatModal.tsx, so this is
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
      <Paper
        variant="outlined"
        sx={{
          pointerEvents: "auto",
          position: "absolute",
          // 208 is the navbar width web/app/(authenticated)/splats/layout.tsx gives the splat carousel (200) plus
          // the same 8 `right` leaves below, so the panel clears the navbar with a matching gap on each side. That
          // layout exports no width constant, so the two numbers are kept in step by hand.
          left: rem(208),
          right: rem(8),
          bottom: 0,
          // HANDLE_HEIGHT/bodyHeight and translateY stay raw px, not rem: they're compared against and driven by
          // PointerEvent.clientY in the drag handlers below, which browsers always report in real CSS pixels
          // regardless of root font-size. Converting only the height here would desync the panel's drawn size from
          // its own drag thresholds under a non-default browser zoom.
          height: HANDLE_HEIGHT + bodyHeight,
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          boxShadow: CARD_SHADOW,
          transform: `translateY(${translateY}px)`,
          transition: dragY === null ? "transform 150ms ease" : "none",
        }}
      >
        <ButtonBase
          disableRipple
          type="button"
          aria-expanded={opened}
          aria-label={opened ? "Close photos panel" : "Open photos panel"}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={handleClick}
          sx={{ height: HANDLE_HEIGHT, width: "100%", cursor: "grab", touchAction: "none" }}
        >
          <Center className="h-full w-full">
            <Stack spacing={0.5} sx={{ alignItems: "center" }}>
              <Box sx={{ width: rem(36), height: rem(4), borderRadius: rem(2), backgroundColor: "divider" }} />
              <Typography variant="caption" color="text.secondary">
                {photoCount} photo{photoCount === 1 ? "" : "s"}
              </Typography>
            </Stack>
          </Center>
        </ButtonBase>

        {/* Not given an explicit height: it needs to size itself naturally so the ResizeObserver above can measure
        that natural size and hand it to the Paper below instead. Forcing this element to bodyHeight would clamp it
        to whatever was last measured, so ResizeObserver would just keep reporting that same number back. */}
        <Stack ref={bodyRef} spacing={1.5} sx={{ px: 2, pb: 2 }}>
          {isLoading && (
            <Skeleton variant="rectangular" sx={{ height: FILMSTRIP_PHOTO_HEIGHT, width: FILMSTRIP_PHOTO_HEIGHT }} />
          )}
          {!isLoading && photos && photos.length === 0 && (
            <Typography color="text.secondary">No photos uploaded yet.</Typography>
          )}
          {!isLoading && photos && photos.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: "nowrap", alignItems: "center" }}>
              <ScrollEdgeButton label="Scroll to first photo" direction="left" onClick={scrollFilmstripToStart} />
              <Box
                ref={filmstripRef}
                onWheel={handleWheel}
                {...dragHandlers}
                className="thin-scrollbar"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  overflowX: "auto",
                  bgcolor: "action.hover",
                  cursor: isPanningFilmstrip ? "grabbing" : "grab",
                  userSelect: isPanningFilmstrip ? "none" : undefined,
                }}
              >
                {/* width: "fit-content" so the sprocket strips below stretch to exactly the photo row's own
                rendered width, not the (narrower) visible scroll viewport — since all three are inside the same
                scrollable Box, they scroll together as one strip instead of the holes staying fixed while only the
                photos move. */}
                <Stack spacing={1} sx={{ width: "fit-content" }}>
                  <SprocketStrip />
                  <Stack direction="row" spacing={1.5} sx={{ flexWrap: "nowrap" }}>
                    {photos.map((photo, index) => (
                      <Stack key={photo.id} spacing={0.5} sx={{ alignItems: "center", flexShrink: 0 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
                          {String(index + 1).padStart(2, "0")}
                        </Typography>
                        {/* The mat border is a print mount, distinct from the panel it sits on (this panel is
                        itself background.paper), so background.default reads as a frame in both modes with no
                        separate light/dark logic needed here. */}
                        <Box sx={{ bgcolor: "background.default", p: 0.5 }}>
                          {/* biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image. */}
                          <img
                            src={photo.url}
                            alt={photo.originalFilename}
                            loading="lazy"
                            draggable={false}
                            style={{
                              height: rem(FILMSTRIP_PHOTO_HEIGHT),
                              width: "auto",
                              display: "block",
                            }}
                          />
                        </Box>
                      </Stack>
                    ))}
                  </Stack>
                  <SprocketStrip />
                </Stack>
              </Box>
              <ScrollEdgeButton label="Scroll to last photo" direction="right" onClick={scrollFilmstripToEnd} />
            </Stack>
          )}
        </Stack>
      </Paper>

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
