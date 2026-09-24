import type { ChipColor } from "@/components/ui/Chip";
import { JobStatus, type SplatListItem } from "./types";

export type LibraryFilter = "needs_you" | "in_progress" | "complete";

interface SplatBadge {
  label: string;
  color: ChipColor;
  // Which library filter tab lists this splat besides "All". null means only "All" does.
  filter: LibraryFilter | null;
}

// A library card's status pill. "primary" is reserved for the two states where nothing moves until the visitor acts.
export function splatBadge({
  photoCount,
  latestJobStatus,
}: Pick<SplatListItem, "photoCount" | "latestJobStatus">): SplatBadge {
  if (latestJobStatus === null) {
    if (photoCount === 0) {
      return { label: "No photos", color: "default", filter: null };
    }
    return { label: "Ready to start", color: "primary", filter: "needs_you" };
  }
  return JOB_BADGES[latestJobStatus];
}

const JOB_BADGES: Record<JobStatus, SplatBadge> = {
  [JobStatus.queued]: { label: "Placing cameras", color: "info", filter: "in_progress" },
  [JobStatus.launching]: { label: "Placing cameras", color: "info", filter: "in_progress" },
  [JobStatus.reconstruction_running]: { label: "Placing cameras", color: "info", filter: "in_progress" },
  [JobStatus.awaiting_training]: { label: "Check the shape", color: "primary", filter: "needs_you" },
  [JobStatus.training_running]: { label: "Building", color: "info", filter: "in_progress" },
  [JobStatus.uploading_result]: { label: "Building", color: "info", filter: "in_progress" },
  [JobStatus.complete]: { label: "Complete", color: "success", filter: "complete" },
  [JobStatus.failed]: { label: "Failed", color: "error", filter: "needs_you" },
  [JobStatus.cancelled]: { label: "Cancelled", color: "default", filter: "needs_you" },
};
