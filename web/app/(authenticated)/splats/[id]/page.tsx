"use client";

import { use, useEffect, useState } from "react";

import { BackToLibraryButton } from "@/components/layout/BackToLibraryButton";
import { PhotoGrid } from "@/components/splats/PhotoGrid";
import { PipelineStepper } from "@/components/splats/PipelineStepper";
import { SharePanel } from "@/components/splats/SharePanel";
import { DeleteSplatButton } from "@/components/splats/SplatActions";
import { SplatStageViewer } from "@/components/splats/SplatStageViewer";
import { StageCard } from "@/components/splats/StageCard";
import { useCameras, useLatestJob, usePhotos, useSplat } from "@/lib/hooks";
import { splatStage } from "@/lib/splatStage";
import { type CropBox, JOB_ENDED_STATUSES } from "@/lib/types";

export default function SplatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: splat, isLoading: splatLoading, mutate: refetchSplat } = useSplat(id);
  const { data: job, isLoading: jobLoading, mutate: refetchJob } = useLatestJob(id);
  const { data: photos, isLoading: photosLoading } = usePhotos(id);
  const { data: cameras } = useCameras(id, Boolean(job?.pointCloudS3Key));
  // Drawn in the 3D view and sent with the check stage's build button, which sit on opposite sides of the page.
  const [cropBox, setCropBox] = useState<CropBox | null>(null);

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

  // Every other stage's card shows its own Discard button beside its actions.
  let sharePanel: React.ReactNode = null;
  if (stage.kind === "complete" && splat.isShareable) {
    sharePanel = (
      <SharePanel splatId={id}>
        <DeleteSplatButton splatId={id} label="Discard" variant="outlined" />
      </SharePanel>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:h-full lg:flex-row lg:gap-0">
      <div className="flex flex-col gap-6 px-4 pt-7 sm:px-12 lg:w-120 lg:shrink-0 lg:overflow-y-auto lg:pr-10 lg:pb-7">
        <div className="flex items-center gap-3.5">
          <BackToLibraryButton />
          <h1 className="min-w-0 font-display text-5xl leading-none tracking-tight">{splat.name}</h1>
        </div>
        <PipelineStepper stage={stage} />
        <StageCard splatId={id} stage={stage} cropBox={cropBox} onJobChanged={() => void refetchJob()} />
        {sharePanel}
        {photos && photos.length > 0 ? <PhotoGrid photos={photos} placedPhotoIds={placedPhotoIds} /> : null}
      </div>
      <section aria-label="3D view" className="h-120 px-4 pb-6 sm:px-12 lg:h-auto lg:flex-1 lg:py-6 lg:pr-8 lg:pl-0">
        <SplatStageViewer
          splatId={id}
          job={job}
          complete={splat.status === "complete"}
          cameras={cameras}
          cropBox={cropBox}
          onCropBoxChange={stage.kind === "check" ? setCropBox : undefined}
        />
      </section>
    </div>
  );
}
