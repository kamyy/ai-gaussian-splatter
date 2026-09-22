"use client";

import { useAuth } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { use } from "react";
import useSWR from "swr";

import { VIEWER_BOTTOM_GAP, VIEWER_TOP_GAP } from "@/components/splats/PhotoFilmstrip";
import { AwaitingTrainingPanel } from "@/components/viewer/AwaitingTrainingPanel";
import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";
import { apiFetch } from "@/lib/apiFetch";
import { useLatestJob } from "@/lib/hooks";
import { rem } from "@/lib/rem";
import { JobStatus } from "@/lib/types";

// SWR is left on its defaults here: this route mounts once per navigation, so the presign fetch it triggers on mount
// is always fresh, and a three.js scene that has already finished loading never re-reads the URL again regardless of
// the object's age.
export default function PointCloudPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: job, mutate: refetchJob } = useLatestJob(id);

  // pointCloudS3Key is set once by the reconstruct phase and never cleared, so this fetch keeps the point cloud
  // reachable through training and after completion, not just during the awaiting_training pause.
  const { data: pointCloudUrl, error: pointCloudError } = useSWR(
    job?.pointCloudS3Key ? ["point-cloud", id] : null,
    async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      return apiFetch<string>(`/api/v1/splats/${id}/point-cloud`, "GET", token);
    },
  );

  // The review step: the point cloud plus the button that pays for training.
  if (job?.status === JobStatus.awaiting_training) {
    return (
      <Box
        sx={{
          height: "100%",
          overflowY: "auto",
          pt: rem(VIEWER_TOP_GAP),
          pb: rem(VIEWER_BOTTOM_GAP),
          pl: rem(24),
          pr: rem(24),
        }}
      >
        {pointCloudError && (
          <Typography color="text.secondary">The point cloud isn&apos;t ready yet — still checking.</Typography>
        )}
        {!pointCloudUrl && !pointCloudError && <SplatViewerLoading />}
        {pointCloudUrl && (
          <AwaitingTrainingPanel splatId={id} pointCloudUrl={pointCloudUrl} onTrainStarted={() => void refetchJob()} />
        )}
      </Box>
    );
  }

  // SplatViewer shows "Not available for this splat." whenever pointCloudUrl is null, which is also its state while
  // this presign fetch is still in flight — true whenever job.pointCloudS3Key is set (the reconstruct phase has
  // produced one) but the URL hasn't arrived yet, as opposed to a job that hasn't reached reconstruct at all, where
  // there genuinely is nothing to show yet.
  const pointCloudPending = Boolean(job?.pointCloudS3Key) && !pointCloudUrl && !pointCloudError;

  // Same top/bottom clearance as the awaiting_training branch above.
  return (
    <Box sx={{ height: "100%", pt: rem(VIEWER_TOP_GAP), pb: rem(VIEWER_BOTTOM_GAP), pl: rem(24), pr: rem(24) }}>
      {pointCloudPending ? (
        <SplatViewerLoading />
      ) : (
        <SplatViewer mode="colmap_points" splatUrl={null} pointCloudUrl={pointCloudUrl ?? null} height="100%" />
      )}
    </Box>
  );
}
