"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import { use, useEffect } from "react";

import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { PhotoFilmstrip } from "@/components/splats/PhotoFilmstrip";
import { SplatSubNav } from "@/components/splats/SplatSubNav";
import { useLatestJob, useSplat } from "@/lib/hooks";
import { rem } from "@/lib/rem";
import { JOB_ENDED_STATUSES } from "@/lib/types";

const floatingPaperSx = {
  p: 1.5,
  borderRadius: 2,
} as const;

interface SplatLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

// Shared by both view routes (point-cloud/splat): the splat/job fetch, the job-ended refetch effect, the job progress
// strip, the view toggle, and the photos slideout. The name/status chip that used to float here now lives in
// web/components/layout/AuthHeader.tsx instead. This is the new home for logic that used to live in the single
// web/app/(authenticated)/splats/[id]/page.tsx now that each view is its own route.
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

  // job === undefined only means "no job ever started" once the fetch has actually resolved (jobLoading false) —
  // otherwise this flashes the "job ended" layout for a beat right after starting one, before this fetch resolves
  // with the real in-progress status. "failed" is deliberately excluded here even though it's in
  // JOB_ENDED_STATUSES: JobStatusPoller's Alert with job.errorMessage is the only place a failure is ever
  // surfaced, so it must stay visible once a job fails, not disappear the moment it does.
  const jobHasEnded = job === undefined ? !jobLoading : job.status === "complete" || job.status === "cancelled";

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <Box sx={{ position: "absolute", inset: 0 }}>{children}</Box>

      <Box sx={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none" }}>
        {!jobHasEnded && (
          <Paper
            variant="outlined"
            sx={{
              ...floatingPaperSx,
              pointerEvents: "auto",
              position: "absolute",
              top: rem(86),
              right: rem(16),
              width: rem(320),
            }}
          >
            <JobStatusPoller splatId={id} />
          </Paper>
        )}

        {/* Stacked under the poller when it's shown, now that the name/status chip that used to sit above this has
        moved into AuthHeader and the bottom of the viewport belongs to PhotoFilmstrip instead. */}
        <Paper
          variant="outlined"
          sx={{
            ...floatingPaperSx,
            pointerEvents: "auto",
            position: "absolute",
            top: jobHasEnded ? rem(86) : rem(190),
            right: rem(16),
          }}
        >
          <SplatSubNav
            splatId={id}
            pointCloudEnabled={job?.pointCloudS3Key != null || job?.status === "awaiting_training"}
            splatEnabled={splat.status === "complete"}
          />
        </Paper>

        <PhotoFilmstrip splatId={id} />
      </Box>
    </Box>
  );
}
