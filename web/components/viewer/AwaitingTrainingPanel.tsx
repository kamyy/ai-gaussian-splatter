"use client";

import { useAuth } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { Card } from "@/components/layout/Card";
import { apiFetch } from "@/lib/apiFetch";
import { rem } from "@/lib/rem";
import type { Job } from "@/lib/types";
import { useAppSnackbar } from "@/lib/useAppSnackbar";
import { SplatViewer } from "./SplatViewer";

interface AwaitingTrainingPanelProps {
  splatId: string;
  pointCloudUrl: string;
  onTrainStarted: () => void;
}

/** Shown once the reconstruct phase self-terminates at "awaiting_training" — the pause where the user reviews
 * COLMAP's sparse point cloud before paying for the expensive training step (worker/run_job.py's stage split).
 * The viewer fills the whole panel; the train action floats over its bottom-right corner rather than sitting in
 * flow below it, so the point cloud gets the full height to review. What used to be a paragraph of explanation
 * above the viewer is now the train button's hover card instead. A failure to start training is reported through
 * the shared snackbar stack (web/components/layout/ThemeRegistry.tsx's SnackbarProvider), not an inline Alert.
 */
export function AwaitingTrainingPanel({ splatId, pointCloudUrl, onTrainStarted }: AwaitingTrainingPanelProps) {
  const { getToken } = useAuth();
  const { enqueueSnackbar } = useAppSnackbar();
  const [isStarting, setIsStarting] = useState(false);

  async function handleTrain() {
    setIsStarting(true);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      await apiFetch<Job>(`/api/v1/splats/${splatId}/train`, "POST", token);
      onTrainStarted();
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : "Failed to start training", { variant: "error" });
      setIsStarting(false);
    }
  }

  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <SplatViewer mode="colmap_points" splatUrl={null} pointCloudUrl={pointCloudUrl} height="100%" />

      {/* right: rem(-8) looks wrong in isolation, but this panel sits inside its route page's own pr: rem(24)
      gutter (web/app/(authenticated)/splats/[id]/{point-cloud,splat}/page.tsx), unlike the viewport-fixed overlay
      web/app/(authenticated)/splats/[id]/layout.tsx positions its own cards against. 16 - 24 = -8 cancels that
      gutter out so this card's right edge lines up with theirs instead of sitting 24px further left. */}
      <Card sx={{ position: "absolute", bottom: rem(16), right: rem(-8) }}>
        <Tooltip
          placement="top-end"
          title={
            <Box sx={{ maxWidth: rem(260), p: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Ready to train
              </Typography>
              <Typography variant="caption">
                COLMAP finished reconstructing camera positions from the point cloud above. Training is the expensive,
                GPU-bound step.
              </Typography>
            </Box>
          }
        >
          {/* A span, not the Button directly: Tooltip needs its child to keep firing pointer events even while the
          button is disabled by its own `loading` state, which a disabled native button element otherwise blocks. */}
          <span>
            <Button variant="contained" onClick={handleTrain} loading={isStarting}>
              Start training
            </Button>
          </span>
        </Tooltip>
      </Card>
    </Box>
  );
}
