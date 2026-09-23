"use client";

import { use, useEffect } from "react";

import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { JobStatusSnackbar } from "@/components/job/JobStatusSnackbar";
import { Card } from "@/components/layout/Card";
import { PhotoFilmstrip } from "@/components/splats/PhotoFilmstrip";
import { SplatSubNav } from "@/components/splats/SplatSubNav";
import { cn } from "@/lib/cn";
import { useLatestJob, useSplat } from "@/lib/hooks";
import { JOB_ENDED_STATUSES, JobStatus } from "@/lib/types";

interface SplatLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

// Shared by both view routes (point-cloud/splat): the splat/job fetch, the job-ended refetch effect, the job status
// card, the view toggle, and the photos slideout. The splat's name and status are not here; they belong to the
// header web/components/layout/AuthHeader.tsx renders above this route.
export default function SplatLayout({ children, params }: SplatLayoutProps) {
  const { id } = use(params);
  const { data: splat, isLoading, mutate: refetchSplat } = useSplat(id);
  const { data: job, isLoading: jobLoading } = useLatestJob(id);

  // Only the job is polled, but the worker's callback moves the job row and the splat row in one transaction, so a
  // job that has ended means this splat is stale.
  useEffect(() => {
    if (job && JOB_ENDED_STATUSES.includes(job.status)) {
      void refetchSplat();
    }
  }, [job, refetchSplat]);

  if (isLoading) {
    return <div className="h-full animate-pulse bg-divider" />;
  }
  // Deliberately not `!splat` combined with an error check: a failed revalidation leaves the last good splat in
  // `data`, and SWR retries on its own.
  if (!splat) {
    return <p className="p-4 text-error">Splat not found.</p>;
  }

  // In-progress statuses and a failure are web/components/job/JobStatusSnackbar.tsx. awaiting_training and complete
  // each have their own confirmation elsewhere in this route (AwaitingTrainingPanel and the enabled splat/point-cloud
  // view below). This card covers the loading placeholder before any of those can render, plus cancelled — the one
  // terminal status with no other confirmation anywhere in the app.
  const showJobStatusCard = (job === undefined && jobLoading) || job?.status === JobStatus.cancelled;

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">{children}</div>

      <div className="pointer-events-none fixed inset-0 z-[90]">
        {showJobStatusCard && (
          <Card className="pointer-events-auto absolute top-[5.375rem] right-4 w-80">
            <JobStatusPoller splatId={id} />
          </Card>
        )}

        {/* Stacked under the card when it's shown, and back up to the card's own position when it isn't. The
        bottom of the viewport belongs to PhotoFilmstrip. Two underline tabs read as a much shorter control than the
        default card padding was built for; py-1 overrides the base p-3 on just the vertical axis (Tailwind's own
        stylesheet ordering resolves the more specific one regardless of class order) so this card doesn't tower
        over its own single-line content. */}
        <Card
          className={cn(
            "pointer-events-auto absolute right-4 py-1",
            showJobStatusCard ? "top-[11.875rem]" : "top-[5.375rem]",
          )}
        >
          <SplatSubNav
            splatId={id}
            pointCloudEnabled={job?.pointCloudS3Key != null || job?.status === JobStatus.awaiting_training}
            splatEnabled={splat.status === "complete"}
          />
        </Card>

        <JobStatusSnackbar splatId={id} />
        <PhotoFilmstrip splatId={id} />
      </div>
    </div>
  );
}
