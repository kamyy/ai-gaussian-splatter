/**
 * The /splats/[id] page: one splat's workspace, from processing through to sharing.
 *
 * Loads the splat, its latest worker job, its photos and its camera positions, then shows the stage the splat is at: a
 * card with that stage's actions, the pipeline's progress, the 3D viewer and the photo grid. The view opens on the
 * first placed photo's camera. Picking another photo flies the view to where that photo was taken.
 */

"use client";

import { use, useEffect, useState } from "react";

import { PageTitle } from "@/components/layout/PageTitle";
import { PhotoGrid } from "@/components/splats/PhotoGrid";
import { PipelineStepper } from "@/components/splats/PipelineStepper";
import { SharePanel } from "@/components/splats/SharePanel";
import { DiscardSplatButton } from "@/components/splats/SplatActions";
import { SplatStageViewer } from "@/components/splats/SplatStageViewer";
import { StageCard } from "@/components/splats/StageCard";
import { useCameras } from "@/lib/hooks/useCameras";
import { useLatestJob } from "@/lib/hooks/useLatestJob";
import { usePhotoSelection } from "@/lib/hooks/usePhotoSelection";
import { usePhotos } from "@/lib/hooks/usePhotos";
import { useSplat } from "@/lib/hooks/useSplat";
import { useStageNotification } from "@/lib/hooks/useStageNotification";
import { splatStage } from "@/lib/splatStage";
import { JOB_ENDED_STATUSES } from "@/lib/statuses";

export default function SplatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: splat, isLoading: splatLoading, mutate: refetchSplat } = useSplat(id);
  const { data: job, isLoading: jobLoading, mutate: refetchJob } = useLatestJob(id);
  const { data: photos, isLoading: photosLoading } = usePhotos(id);
  const { data: cameras } = useCameras(id, Boolean(job?.pointCloudS3Key));

  const { selection, selectPhoto, clearSelection } = usePhotoSelection(photos, cameras);

  // The photo tile the pointer is over.
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
  const loading = splatLoading || jobLoading || photosLoading;
  const stage = splatStage(job, photos?.length ?? 0);
  useStageNotification(splat?.name, loading ? undefined : stage);

  if (loading) {
    return <div className="h-full animate-pulse bg-muted" />;
  }

  // Deliberately not `!splat` combined with an error check: a failed revalidation leaves the last good splat in `data`,
  // and SWR retries on its own.
  if (!splat) {
    return <p className="p-12 text-error">Splat not found.</p>;
  }

  const placedPhotoIds = cameras ? new Set(cameras.map(camera => camera.photoId)) : null;

  // Every other stage's card shows its own Discard button beside its actions. A finished splat's goes in the share
  // panel when it's shareable, and stands alone when it isn't.
  let sharePanel: React.ReactNode = null;
  if (stage.kind === "complete") {
    const discard = <DiscardSplatButton splatId={id} variant="outlined" />;
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
    <div className="page-width flex flex-col gap-6 lg:h-full lg:flex-row lg:gap-0">
      {/* The scrollbar's space is reserved for the same reason as in web/app/(authenticated)/splats/layout.tsx: the
      photo grid lays itself out for the width it measures. */}
      <div className="flex flex-col gap-6 px-4 pt-7 sm:px-12 lg:w-120 lg:shrink-0 lg:overflow-y-auto lg:pr-10 lg:pb-7 lg:scrollbar-gutter-stable">
        <PageTitle backHref="/splats" backLabel="Back to Library">
          {splat.name}
        </PageTitle>
        <PipelineStepper stage={stage} job={job} photoCount={photos?.length ?? 0} />
        <StageCard splatId={id} stage={stage} onJobChanged={() => void refetchJob()} />
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
          selection={selection}
          onClearSelection={clearSelection}
          onJobChanged={() => void refetchJob()}
        />
      </section>
    </div>
  );
}
