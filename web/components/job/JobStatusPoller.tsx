"use client";

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { useLatestJob } from "@/lib/hooks";
import { statusColor } from "@/lib/statusColor";
import type { JobStatus } from "@/lib/types";

// Keys are the wire/database status values (snake_case); the values are what the user actually reads.
const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  launching: "Starting GPU worker…",
  colmap_running: "Reconstructing camera positions (COLMAP)…",
  awaiting_training: "Ready to review — waiting for you to start training",
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
  awaiting_training: 50,
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
  const { data: job, error, isLoading } = useLatestJob(splatId);

  if (isLoading) {
    return <Typography color="text.secondary">Loading job status…</Typography>;
  }
  if (error) {
    return <Typography color="text.secondary">No processing job yet.</Typography>;
  }
  if (!job) {
    return null;
  }

  const inProgress = job.status !== "complete" && job.status !== "failed" && job.status !== "cancelled";

  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ justifyContent: "space-between" }}>
        <Chip color={statusColor(job.status)} label={STATUS_LABELS[job.status]} />
      </Stack>
      <LinearProgress
        variant="determinate"
        value={STATUS_PROGRESS[job.status]}
        // MUI's LinearProgress has no built-in pulse for a determinate bar (only "indeterminate", which would hide
        // the percentage). This keeps the percentage while still giving a "still working" visual cue for a
        // non-terminal status, closer to the old animated bar's intent.
        sx={
          inProgress
            ? {
                "& .MuiLinearProgress-bar": { animation: "job-progress-pulse 1.4s ease-in-out infinite" },
                "@keyframes job-progress-pulse": { "0%, 100%": { opacity: 1 }, "50%": { opacity: 0.5 } },
              }
            : undefined
        }
      />
      {job.status === "failed" && job.errorMessage && (
        <Alert severity="error">
          <AlertTitle>Processing failed</AlertTitle>
          {job.errorMessage}
        </Alert>
      )}
    </Stack>
  );
}
