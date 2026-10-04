/**
 * The 3D viewer panel on a splat's own page, fed with fresh download links, and the owner's crop controls.
 *
 * Fetches the time-limited download links each 3D file loads from, and hands them to
 * web/components/splats/SplatViewerPanel.tsx, which draws the viewer and its controls. Which files exist follows the
 * splat's latest worker job.
 *
 * A finished splat can be cropped here. The owner fits the box in the point cloud view, and applying it asks
 * web/app/api/v1/splats/[splatId]/crop/route.ts to write the cropped copies. The viewer then loads the cropped splat.
 * Undo crop restores the uncropped splat. The share preview stays the thumbnail the worker rendered.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";
import { useSWRConfig } from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { useAppSnackbar } from "@/lib/hooks/useAppSnackbar";
import { usePresignedUrl } from "@/lib/hooks/usePresignedUrl";
import { requireToken } from "@/lib/requireToken";
import type { CameraPose, Job } from "@/lib/types";
import type { PhotoSelection } from "./photoSelection";
import { type CropControls, SplatViewerPanel } from "./SplatViewerPanel";

interface SplatStageViewerProps {
  splatId: string;
  job: Job | undefined;
  complete: boolean;
  // Undefined while loading, and for a job reconstructed before the worker wrote them.
  cameras: CameraPose[] | undefined;
  selection: PhotoSelection | null;
  onClearSelection: () => void;
  // Called once a crop or an undo has changed the job, so the page refetches it.
  onJobChanged: () => void;
}

/**
 * Names which file the viewer shows. updatedAt changes on every committed crop, including one that repeats the same
 * box, so the viewer reloads that new file instead of keeping a link to the one the crop just deleted.
 */
function splatVersion(job: Pick<Job, "cropBox" | "updatedAt"> | undefined): string {
  if (!job?.cropBox) {
    return "original";
  }

  return `crop:${job.updatedAt}`;
}

export function SplatStageViewer({ splatId, job, complete, onJobChanged, ...panelProps }: SplatStageViewerProps) {
  const { getToken } = useAuth();
  const { mutate } = useSWRConfig();
  const { enqueueSnackbar } = useAppSnackbar();

  const [busy, setBusy] = useState<CropControls["busy"]>(null);

  // pointCloudS3Key is set once by the reconstruct stage and never cleared, so the sketch stays reachable through
  // training and after completion.
  const pointCloudAvailable = Boolean(job?.pointCloudS3Key);
  const pointCloud = usePresignedUrl(
    pointCloudAvailable ? ["point-cloud", splatId] : null,
    `/api/v1/splats/${splatId}/point-cloud`,
  );

  // The viewer-splat route collapses "not ready" and "not yours" into one 404, so a failure here is usually the result
  // still being finalized. The version is part of the key, so a new crop fetches a link to its own file rather than
  // reusing the cached link to the last one.
  const applied = job?.cropBox ?? null;
  const version = splatVersion(job);
  const splat = usePresignedUrl(
    complete ? ["viewer-splat", splatId, version] : null,
    `/api/v1/splats/${splatId}/viewer-splat`,
  );

  // Resolves to whether the request succeeded.
  async function run(action: "apply" | "undo", failure: string, request: (token: string) => Promise<Job>) {
    setBusy(action);
    try {
      await request(await requireToken(getToken));
      onJobChanged();
      await mutate("splats");

      return true;
    } catch (err) {
      enqueueSnackbar(failure, { variant: "error", detail: err instanceof Error ? err.message : undefined });

      return false;
    } finally {
      setBusy(null);
    }
  }

  let crop: CropControls | undefined;
  if (complete) {
    crop = {
      onApply: box =>
        run("apply", "Couldn't crop the splat", token =>
          apiFetch<Job>(`/api/v1/splats/${splatId}/crop`, "POST", token, { box }),
        ),
      onUndo: () =>
        run("undo", "Couldn't undo the crop", token =>
          apiFetch<Job>(`/api/v1/splats/${splatId}/crop`, "DELETE", token),
        ),
      busy,
    };
  }

  return (
    <SplatViewerPanel
      splat={{ available: complete, version, ...splat }}
      pointCloud={{ available: pointCloudAvailable, ...pointCloud }}
      cropBox={applied}
      crop={crop}
      {...panelProps}
    />
  );
}
