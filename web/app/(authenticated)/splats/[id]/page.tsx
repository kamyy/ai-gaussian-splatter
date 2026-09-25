"use client";

import Link from "next/link";
import { use, useEffect } from "react";

import { PhotoGrid } from "@/components/splats/PhotoGrid";
import { PipelineStepper } from "@/components/splats/PipelineStepper";
import { SharePanel } from "@/components/splats/SharePanel";
import { DeleteSplatButton } from "@/components/splats/SplatActions";
import { SplatStageViewer } from "@/components/splats/SplatStageViewer";
import { StageCard } from "@/components/splats/StageCard";
import { useCameras, useLatestJob, usePhotos, useSplat } from "@/lib/hooks";
import { splatStage } from "@/lib/splatStage";
import { JOB_ENDED_STATUSES } from "@/lib/types";

export default function SplatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: splat, isLoading: splatLoading, mutate: refetchSplat } = useSplat(id);
  const { data: job, isLoading: jobLoading, mutate: refetchJob } = useLatestJob(id);
  const { data: photos, isLoading: photosLoading } = usePhotos(id);
  const { data: cameras } = useCameras(id, Boolean(job?.pointCloudS3Key));

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

  return (
    <div className="flex flex-col gap-6 lg:h-full lg:flex-row lg:gap-0">
      <div className="flex flex-col gap-6 px-4 pt-7 sm:px-12 lg:w-120 lg:shrink-0 lg:overflow-y-auto lg:pr-10 lg:pb-7">
        <div className="flex flex-col gap-2">
          <Link href="/splats" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            ← All splats
          </Link>
          <h1 className="font-display text-5xl leading-none tracking-tight">{splat.name}</h1>
        </div>
        <PipelineStepper stage={stage} />
        <StageCard splatId={id} stage={stage} onJobChanged={() => void refetchJob()} />
        {stage.kind === "complete" && splat.isShareable && <SharePanel splatId={id} />}
        {photos && photos.length > 0 && <PhotoGrid photos={photos} placedPhotoIds={placedPhotoIds} />}
        {/* The check stage's card already offers this as "Discard". */}
        {stage.kind !== "check" && (
          <div className="mt-auto pt-2">
            <DeleteSplatButton splatId={id} label="Delete splat" variant="text" />
          </div>
        )}
      </div>
      <section aria-label="3D view" className="h-120 px-4 pb-6 sm:px-12 lg:h-auto lg:flex-1 lg:py-6 lg:pr-8 lg:pl-0">
        <SplatStageViewer splatId={id} job={job} complete={splat.status === "complete"} cameras={cameras} />
      </section>
    </div>
  );
}
