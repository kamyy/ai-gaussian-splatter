/**
 * The status label and color a splat's card shows in the /splats library.
 *
 * Turns a splat's status and its latest job's status into a short label such as "Check the shape", a chip color, and
 * the library filter tab ("Needs you", "In progress", "Complete") that lists it.
 */

import type { ChipColor } from "@/components/ui/Chip";
import { JobStatus } from "./statuses";
import type { SplatListItem } from "./types";

export type LibraryFilter = "needs_you" | "in_progress" | "complete";

interface SplatBadge {
  label: string;
  color: ChipColor;
  // Which library filter tab lists this splat besides "All". null means only "All" does.
  filter: LibraryFilter | null;
}

// A library card's status pill. "primary" marks "Ready to start" and "Check the shape", where the splat moves forward
// only once the visitor acts. "Failed" and "Cancelled" also wait on the visitor but are dead ends, so they don't get it.
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
