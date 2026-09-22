"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import { use, useEffect } from "react";

import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { JobStatusSnackbar } from "@/components/job/JobStatusSnackbar";
import { Card } from "@/components/layout/Card";
import { PhotoFilmstrip } from "@/components/splats/PhotoFilmstrip";
import { SplatSubNav } from "@/components/splats/SplatSubNav";
import { useLatestJob, useSplat } from "@/lib/hooks";
import { rem } from "@/lib/rem";
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
    return <Skeleton variant="rectangular" sx={{ height: "100%" }} />;
  }
  // Deliberately not `!splat` combined with an error check: a failed revalidation leaves the last good splat in
  // `data`, and SWR retries on its own.
  if (!splat) {
    return <Alert severity="error">Splat not found.</Alert>;
  }

  // In-progress statuses and a failure are web/components/job/JobStatusSnackbar.tsx. awaiting_training and complete
  // each have their own confirmation elsewhere in this route (AwaitingTrainingPanel and the enabled splat/point-cloud
  // view below). This card covers the loading placeholder before any of those can render, plus cancelled — the one
  // terminal status with no other confirmation anywhere in the app.
  const showJobStatusCard = (job === undefined && jobLoading) || job?.status === JobStatus.cancelled;

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <Box sx={{ position: "absolute", inset: 0 }}>{children}</Box>

      <Box sx={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none" }}>
        {showJobStatusCard && (
          <Card
            sx={{
              pointerEvents: "auto",
              position: "absolute",
              top: rem(86),
              right: rem(16),
              width: rem(320),
            }}
          >
            <JobStatusPoller splatId={id} />
          </Card>
        )}

        {/* Stacked under the card when it's shown, and back up to the card's own position when it isn't. The
        bottom of the viewport belongs to PhotoFilmstrip. */}
        <Card
          sx={{
            pointerEvents: "auto",
            position: "absolute",
            top: showJobStatusCard ? rem(190) : rem(86),
            right: rem(16),
            // Two underline tabs read as a much shorter control than the default card padding was built for; py
            // overrides the base p on just the vertical axis (MUI resolves the more specific one regardless of
            // object order) so this card doesn't tower over its own single-line content.
            py: 0.5,
          }}
        >
          <SplatSubNav
            splatId={id}
            pointCloudEnabled={job?.pointCloudS3Key != null || job?.status === JobStatus.awaiting_training}
            splatEnabled={splat.status === "complete"}
          />
        </Card>

        <JobStatusSnackbar splatId={id} />
        <PhotoFilmstrip splatId={id} />
      </Box>
    </Box>
  );
}
