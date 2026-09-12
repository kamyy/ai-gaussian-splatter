"use client";

import { useAuth } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { use } from "react";
import useSWR from "swr";

import { AwaitingTrainingPanel } from "@/components/viewer/AwaitingTrainingPanel";
import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";
import { apiFetch } from "@/lib/apiFetch";
import { useLatestJob } from "@/lib/hooks";
import { rem } from "@/lib/rem";

// SWR is left on its defaults here (unlike the old single-page design's manual pre-switch presign refresh): this
// route mounts once per navigation, so the presign fetch it triggers on mount is always fresh, and a three.js scene
// that has already finished loading never re-reads the URL again regardless of the object's age.
export default function PointCloudPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: job, mutate: refetchJob } = useLatestJob(id);

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

  // Set once by the reconstruct phase and never cleared, so the toggle position stays reachable through training and
  // after completion — not just during the awaiting_training pause.
  if (job?.status === "awaiting_training") {
    return (
      <Box sx={{ height: "100%", overflowY: "auto", pt: rem(76), pl: rem(24), pr: rem(24) }}>
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

  return <SplatViewer mode="colmap_points" splatUrl={null} pointCloudUrl={pointCloudUrl ?? null} height="100%" />;
}
