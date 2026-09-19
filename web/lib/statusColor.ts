import type { JobStatus, SplatStatus } from "./types";

// Splat and job status enums are separate lists (web/lib/types.ts), but "complete" and "failed" mean the same thing in
// both, so one mapping covers the Chip color for either. Every other value, including a job's "cancelled", is neutral.
export function statusColor(status: SplatStatus | JobStatus): "success" | "error" | "info" {
  switch (status) {
    case "complete":
      return "success";
    case "failed":
      return "error";
  }
  return "info";
}
