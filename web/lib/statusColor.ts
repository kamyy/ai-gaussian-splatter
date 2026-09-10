import type { JobStatus, SplatStatus } from "./types";

// Splat and job status enums are separate lists (web/lib/types.ts), but both use "failed"/"complete" as their terminal
// values and everything else as in-progress, so one mapping covers the Badge color for both.
export function statusColor(status: SplatStatus | JobStatus): string {
  if (status === "failed") {
    return "red";
  }
  if (status === "complete") {
    return "green";
  }
  return "blue";
}
