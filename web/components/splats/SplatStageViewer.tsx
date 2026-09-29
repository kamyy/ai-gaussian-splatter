/**
 * The 3D viewer panel on a splat's own page, fed with fresh download links.
 *
 * Fetches the time-limited download links each 3D file loads from, and hands them to
 * web/components/splats/SplatViewerPanel.tsx, which draws the viewer and its controls. Which files exist follows the
 * splat's latest worker job.
 */

"use client";

import { usePresignedUrl } from "@/lib/hooks/usePresignedUrl";
import type { CameraPose, CropBox, Job } from "@/lib/types";
import type { PhotoSelection } from "./photoSelection";
import { SplatViewerPanel } from "./SplatViewerPanel";

interface SplatStageViewerProps {
  splatId: string;
  job: Job | undefined;
  complete: boolean;
  // Undefined while loading, and for a job reconstructed before the worker wrote them.
  cameras: CameraPose[] | undefined;
  cropBox: CropBox | null;
  selection: PhotoSelection | null;
  onSelectPhoto: (photoId: string) => void;
  onClearSelection: () => void;
  hoveredPhotoId: string | null;
  onHoverPhoto: (photoId: string | null) => void;
  // Set only while the crop box can still change what gets built, which is what offers the Crop button.
  onCropBoxChange?: (box: CropBox | null) => void;
}

export function SplatStageViewer({ splatId, job, complete, ...panelProps }: SplatStageViewerProps) {
  // pointCloudS3Key is set once by the reconstruct stage and never cleared, so the sketch stays reachable through
  // training and after completion.
  const pointCloudAvailable = Boolean(job?.pointCloudS3Key);
  const pointCloud = usePresignedUrl(
    pointCloudAvailable ? ["point-cloud", splatId] : null,
    `/api/v1/splats/${splatId}/point-cloud`,
  );
  // The viewer-splat route collapses "not ready" and "not yours" into one 404, so a failure here is usually the result
  // still being finalized.
  const splat = usePresignedUrl(complete ? ["viewer-splat", splatId] : null, `/api/v1/splats/${splatId}/viewer-splat`);

  return (
    <SplatViewerPanel
      splat={{ available: complete, ...splat }}
      pointCloud={{ available: pointCloudAvailable, ...pointCloud }}
      {...panelProps}
    />
  );
}
