"use client";

import { useEffect, useRef } from "react";

import { useLatestJob } from "@/lib/hooks";
import { JobStatus } from "@/lib/types";
import { useAppSnackbar } from "@/lib/useAppSnackbar";

// In-progress statuses, in JOB_STATUSES order. awaiting_training is absent: that pause has its own review UI
// (web/components/viewer/AwaitingTrainingPanel.tsx) rather than a "still working" notice.
const STAGE_LABELS: Partial<Record<JobStatus, string>> = {
  queued: "Queued",
  launching: "Starting GPU worker…",
  reconstruction_running: "Reconstructing camera positions (COLMAP)…",
  training_running: "Training the Gaussian Splat…",
  uploading_result: "Uploading result…",
};

interface JobStatusSnackbarProps {
  splatId: string;
}

// Renders nothing itself — it only drives the shared stack (web/components/layout/ThemeRegistry.tsx's
// SnackbarProvider), the same bottom-left one every other status/error message in the app uses. Mounted
// unconditionally by web/app/(authenticated)/splats/[id]/layout.tsx (not gated on job status the way
// JobStatusPoller's floating card is), so a failure still gets reported even though nothing else about that
// status renders a card.
export function JobStatusSnackbar({ splatId }: JobStatusSnackbarProps) {
  const { data: job } = useLatestJob(splatId);
  const { enqueueSnackbar, closeSnackbar } = useAppSnackbar();
  const stageLabel = job ? STAGE_LABELS[job.status] : undefined;

  // Each enqueue gets its own key. notistack keeps a snackbar in its list until the exit animation finishes, so
  // closing one and enqueueing again under the same key renders two children with that key. Strict Mode does that
  // close-and-enqueue on mount. persist: true is explicit here (useAppSnackbar only forces it for errors). This
  // snackbar tracks an ongoing job stage, so it stays up until the stage changes or JobStatusSnackbar unmounts.
  useEffect(() => {
    if (!stageLabel) {
      return;
    }
    const key = `job-stage-${crypto.randomUUID()}`;
    enqueueSnackbar(stageLabel, { variant: "info", persist: true, progress: true, key });
    return () => closeSnackbar(key);
  }, [stageLabel, enqueueSnackbar, closeSnackbar]);

  // A failure is reported once, as an error snackbar the visitor has to dismiss themselves (useAppSnackbar forces
  // that for every error). preventDuplicate is set because notistack adds a second entry rather than ignoring a
  // repeat enqueue of the same key, and that second entry is the duplicate-key warning.
  // Strict Mode runs this effect twice in development.
  // Navigating back to this splat remounts JobStatusSnackbar while the snackbar is still open, which enqueues it again.
  //
  // "Processing failed", not "Reconstruction failed": a failure can land during any stage (reconstruct or train),
  // and the job carries no separate record of which one it was in when it failed.
  //
  // useLatestJob (web/lib/hooks.ts) stops polling once a job reaches "failed", and web/app/api/v1/internal/jobs/
  // [jobId]/status/route.ts ignores every callback once a job has ended, so a failed row with no error message can
  // never later gain one — this always shows something rather than gating on job.errorMessage and staying silent
  // forever for that row.
  //
  // failedKeyRef, not a plain effect cleanup: web/app/(authenticated)/splats/[id]/layout.tsx stays mounted across a
  // navigation between splats (only the id param changes), so this component itself never remounts either — it just
  // re-renders with a different job. Closing unconditionally on every cleanup (mirroring the stage effect above)
  // would also fire on an in-place update of the *same* failed job (Strict Mode's double run, a duplicated
  // callback), fighting preventDuplicate's same-key dedup with a close-then-reopen that flashes the toast. Tracking
  // the last key here means only an actual change of job gets a close, so navigating to a different splat's failure
  // still replaces the previous toast instead of stacking a second one beside it.
  const failedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status !== JobStatus.failed) {
      return;
    }
    const key = `job-failed-${job.id}`;
    if (failedKeyRef.current && failedKeyRef.current !== key) {
      closeSnackbar(failedKeyRef.current);
    }
    failedKeyRef.current = key;
    enqueueSnackbar(job.errorMessage ? `Processing failed: ${job.errorMessage}` : "Processing failed.", {
      variant: "error",
      preventDuplicate: true,
      key,
    });
  }, [job?.id, job?.status, job?.errorMessage, enqueueSnackbar, closeSnackbar]);

  return null;
}
