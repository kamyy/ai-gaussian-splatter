"use client";

import { Alert, Badge, Group, Progress, Stack, Text } from "@mantine/core";

import { useJobStatus } from "@/lib/hooks";
import type { JobStatus } from "@/lib/types";

// Keys are the wire/database status values (snake_case); the values are what the user actually reads.
const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  launching: "Starting GPU worker…",
  colmap_running: "Reconstructing camera positions (COLMAP)…",
  training_running: "Training the Gaussian Splat…",
  uploading_result: "Uploading result…",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Rough ordinal progress for the UI bar — jobs.status doubles as the progress indicator.
const STATUS_PROGRESS: Record<JobStatus, number> = {
  queued: 5,
  launching: 15,
  colmap_running: 35,
  training_running: 70,
  uploading_result: 90,
  complete: 100,
  failed: 100,
  cancelled: 100,
};

interface JobStatusPollerProps {
  splatId: string;
}

export function JobStatusPoller({ splatId }: JobStatusPollerProps) {
  const { data: job, error, isLoading } = useJobStatus(splatId);

  if (isLoading) {
    return <Text c="dimmed">Loading job status…</Text>;
  }
  if (error) {
    return <Text c="dimmed">No processing job yet.</Text>;
  }
  if (!job) {
    return null;
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Badge color={job.status === "failed" ? "red" : job.status === "complete" ? "green" : "blue"}>
          {STATUS_LABELS[job.status]}
        </Badge>
      </Group>
      <Progress value={STATUS_PROGRESS[job.status]} animated={job.status !== "complete" && job.status !== "failed"} />
      {job.status === "failed" && job.errorMessage && (
        <Alert color="red" title="Processing failed">
          {job.errorMessage}
        </Alert>
      )}
    </Stack>
  );
}
