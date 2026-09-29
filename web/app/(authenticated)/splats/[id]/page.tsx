/**
 * The /splats/[id] page: one splat's workspace, from processing through to sharing.
 *
 * Loads the splat, its latest worker job, its photos and its camera positions, then shows the stage the splat is at: a
 * card with that stage's actions, the pipeline's progress, the 3D viewer and the photo grid. The viewer and the grid
 * share one selected photo, so picking a photo in either shows it in both.
 */

"use client";

import { use, useEffect, useState } from "react";

import { BackToLibraryButton } from "@/components/layout/BackToLibraryButton";
import { PhotoGrid } from "@/components/splats/PhotoGrid";
import { PipelineStepper } from "@/components/splats/PipelineStepper";
import type { PhotoSelection } from "@/components/splats/photoSelection";
import { SharePanel } from "@/components/splats/SharePanel";
import { DeleteSplatButton } from "@/components/splats/SplatActions";
import { SplatStageViewer } from "@/components/splats/SplatStageViewer";
import { StageCard } from "@/components/splats/StageCard";
import { useCameras } from "@/lib/hooks/useCameras";
import { useLatestJob } from "@/lib/hooks/useLatestJob";
import { usePhotos } from "@/lib/hooks/usePhotos";
import { useSplat } from "@/lib/hooks/useSplat";
import { splatStage } from "@/lib/splatStage";
import { JOB_ENDED_STATUSES } from "@/lib/statuses";
import type { CropBox } from "@/lib/types";

export default function SplatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: splat, isLoading: splatLoading, mutate: refetchSplat } = useSplat(id);
  const { data: job, isLoading: jobLoading, mutate: refetchJob } = useLatestJob(id);
  const { data: photos, isLoading: photosLoading } = usePhotos(id);
  const { data: cameras } = useCameras(id, Boolean(job?.pointCloudS3Key));

  // Drawn in the 3D view and sent with the check stage's build button, which sit on opposite sides of the page.
  const [cropBox, setCropBox] = useState<CropBox | null>(null);

  // Picked from either the photo grid or the 3D view's cameras, and shown in both.
  const [selection, setSelection] = useState<PhotoSelection | null>(null);
  const selectPhoto = (photoId: string) => setSelection({ photoId });

  // Hovering a photo marks its camera in the 3D view, and hovering a camera marks its photo in the grid.
  const [hoveredPhotoId, setHoveredPhotoId] = useState<string | null>(null);

  // Only the job is polled, but the worker's callback moves the job row and the splat row in one transaction, so a job
  // that has ended means this splat is stale.
  useEffect(() => {
    if (job && JOB_ENDED_STATUSES.includes(job.status)) {
      void refetchSplat();
    }
  }, [job, refetchSplat]);

  // jobLoading is part of this gate, not just splatLoading: before the job's first fetch settles, `job` is undefined
  // exactly as it is for a splat with no job at all, and the "ready" stage would offer a second POST /process for a
  // splat whose job is already running.
  if (splatLoading || jobLoading || photosLoading) {
    return <div className="h-full animate-pulse bg-muted" />;
  }

  // Deliberately not `!splat` combined with an error check: a failed revalidation leaves the last good splat in `data`,
  // and SWR retries on its own.
  if (!splat) {
    return <p className="p-12 text-error">Splat not found.</p>;
  }

  const stage = splatStage(job, photos?.length ?? 0);
  const placedPhotoIds = cameras ? new Set(cameras.map(camera => camera.photoId)) : null;

  // Every other stage's card shows its own Discard button beside its actions. A finished splat's goes in the share
  // panel when it's shareable, and stands alone when it isn't.
  let sharePanel: React.ReactNode = null;
  if (stage.kind === "complete") {
    const discard = <DeleteSplatButton splatId={id} label="Discard" variant="outlined" />;
    sharePanel = splat.isShareable ? <SharePanel splatId={id}>{discard}</SharePanel> : discard;
  }

  let photoGrid: React.ReactNode = null;
  if (photos && photos.length > 0) {
    photoGrid = (
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placedPhotoIds}
        selection={selection}
        onSelect={selectPhoto}
        hoveredPhotoId={hoveredPhotoId}
        onHover={setHoveredPhotoId}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:h-full lg:flex-row lg:gap-0">
      {/* The scrollbar's space is reserved for the same reason as in web/app/(authenticated)/splats/layout.tsx: the
      photo grid lays itself out for the width it measures. */}
      <div className="flex flex-col gap-6 px-4 pt-7 sm:px-12 lg:w-120 lg:shrink-0 lg:overflow-y-auto lg:pr-10 lg:pb-7 lg:[scrollbar-gutter:stable]">
        <div className="flex items-center gap-3.5">
          <BackToLibraryButton />
          <h1 className="min-w-0 font-display text-5xl leading-none tracking-tight">{splat.name}</h1>
        </div>
        <PipelineStepper stage={stage} job={job} photoCount={photos?.length ?? 0} />
        <StageCard splatId={id} stage={stage} cropBox={cropBox} onJobChanged={() => void refetchJob()} />
        {sharePanel}
        {photoGrid}
      </div>
      {/* min-w-0 lets the viewer shrink with the window. A flex item otherwise can't narrow below its content, and the
      canvas holds the pixel width it was last drawn at, so the view would stay wide and run off the right edge. */}
      <section
        aria-label="3D view"
        className="h-120 min-w-0 px-4 pb-6 sm:px-12 lg:h-auto lg:flex-1 lg:py-6 lg:pr-8 lg:pl-0"
      >
        <SplatStageViewer
          splatId={id}
          job={job}
          complete={splat.status === "complete"}
          cameras={cameras}
          cropBox={cropBox}
          selection={selection}
          onSelectPhoto={selectPhoto}
          onClearSelection={() => setSelection(null)}
          hoveredPhotoId={hoveredPhotoId}
          onHoverPhoto={setHoveredPhotoId}
          onCropBoxChange={stage.kind === "check" ? setCropBox : undefined}
        />
      </section>
    </div>
  );
}
