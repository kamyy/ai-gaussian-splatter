"use client";

import { useAuth } from "@clerk/nextjs";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { useState } from "react";

import { apiFetch } from "@/lib/apiFetch";
import type { Job } from "@/lib/types";
import { SplatViewer } from "./SplatViewer";

interface AwaitingTrainingPanelProps {
  splatId: string;
  colmapPointCloudUrl: string;
  onTrainStarted: () => void;
}

/** Shown once the reconstruct phase self-terminates at "awaiting_training" — the pause where the user reviews
 * COLMAP's sparse point cloud before paying for the expensive training step (worker/run_job.py's stage split).
 */
export function AwaitingTrainingPanel({ splatId, colmapPointCloudUrl, onTrainStarted }: AwaitingTrainingPanelProps) {
  const { getToken } = useAuth();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTrain() {
    setIsStarting(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      await apiFetch<Job>(`/api/v1/splats/${splatId}/train`, "POST", token);
      onTrainStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start training");
      setIsStarting(false);
    }
  }

  return (
    <Stack>
      <Text c="dimmed">
        COLMAP finished reconstructing camera positions. Review the point cloud below, then start training — training is
        the expensive, GPU-bound step.
      </Text>
      <SplatViewer mode="colmap_points" splatUrl={null} colmapPointCloudUrl={colmapPointCloudUrl} />
      {error && <Alert color="red">{error}</Alert>}
      <Button onClick={handleTrain} loading={isStarting} style={{ alignSelf: "flex-start" }}>
        Proceed to train
      </Button>
    </Stack>
  );
}
