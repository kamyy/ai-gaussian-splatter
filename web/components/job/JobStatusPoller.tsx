"use client";

import { Alert, Badge, Group, Progress, Stack, Text } from "@mantine/core";

import { useJobStatus } from "@/lib/hooks";
import type { JobStatus } from "@/lib/types";

const STATUS_LABELS: Record<JobStatus, string> = {
  Queued: "Queued",
  Launching: "Starting GPU worker…",
  ColmapRunning: "Reconstructing camera positions (COLMAP)…",
  TrainingRunning: "Training the Gaussian Splat…",
  UploadingResult: "Uploading result…",
  Complete: "Complete",
  Failed: "Failed",
  Cancelled: "Cancelled",
};

// Rough ordinal progress for the UI bar — matches plan §2's note that
// jobs.status doubles as the progress indicator.
const STATUS_PROGRESS: Record<JobStatus, number> = {
  Queued: 5,
  Launching: 15,
  ColmapRunning: 35,
  TrainingRunning: 70,
  UploadingResult: 90,
  Complete: 100,
  Failed: 100,
  Cancelled: 100,
};

interface JobStatusPollerProps {
  objectId: string;
}

export function JobStatusPoller({ objectId }: JobStatusPollerProps) {
  const { data: job, error, isLoading } = useJobStatus(objectId);

  if (isLoading) {
    return <Text c="dimmed">Loading job status…</Text>;
  }
  if (error) {
    return <Text c="dimmed">No processing job yet.</Text>;
  }
  if (!job) return null;

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Badge color={job.status === "Failed" ? "red" : job.status === "Complete" ? "green" : "blue"}>
          {STATUS_LABELS[job.status]}
        </Badge>
      </Group>
      <Progress value={STATUS_PROGRESS[job.status]} animated={job.status !== "Complete" && job.status !== "Failed"} />
      {job.status === "Failed" && job.errorMessage && (
        <Alert color="red" title="Processing failed">
          {job.errorMessage}
        </Alert>
      )}
    </Stack>
  );
}
