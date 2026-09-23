"use client";

import { Chip } from "@/components/ui/Chip";
import { useLatestJob } from "@/lib/hooks";
import { statusColor } from "@/lib/statusColor";
import { JobStatus } from "@/lib/types";

interface JobStatusPollerProps {
  splatId: string;
}

// web/app/(authenticated)/splats/[id]/layout.tsx only mounts this while the job fetch is still in flight, or once
// the job has landed on "cancelled" — every other status has its own UI elsewhere (JobStatusSnackbar for
// in-progress/failed, AwaitingTrainingPanel for awaiting_training, the enabled view for complete), so this only
// ever needs to show a loading placeholder or the cancelled chip.
export function JobStatusPoller({ splatId }: JobStatusPollerProps) {
  const { data: job, isLoading } = useLatestJob(splatId);

  if (isLoading || !job) {
    return <p className="text-muted-foreground">Loading job status…</p>;
  }
  return <Chip color={statusColor(job.status)} label={STATUS_LABELS[job.status]} />;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  [JobStatus.cancelled]: "Cancelled",
  // The rest are unreachable given how the layout gates this component, but keeping every key exhaustive means a
  // future status added to JobStatus fails typechecking here instead of rendering "undefined".
  [JobStatus.queued]: "Queued",
  [JobStatus.launching]: "Starting GPU worker…",
  [JobStatus.reconstruction_running]: "Reconstructing camera positions (COLMAP)…",
  [JobStatus.awaiting_training]: "Ready to review — waiting for you to start training",
  [JobStatus.training_running]: "Training the Gaussian Splat…",
  [JobStatus.uploading_result]: "Uploading result…",
  [JobStatus.complete]: "Complete",
  [JobStatus.failed]: "Failed",
};
