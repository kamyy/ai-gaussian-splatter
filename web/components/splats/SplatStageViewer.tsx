"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";
import useSWR from "swr";

import { Center } from "@/components/layout/Center";
import { Spinner } from "@/components/ui/Spinner";
import { SplatViewer, type ViewerMode } from "@/components/viewer/SplatViewer";
import { apiFetch } from "@/lib/apiFetch";
import { cn } from "@/lib/cn";
import { requireToken } from "@/lib/requireToken";
import type { CameraPose, CropBox, Job } from "@/lib/types";

interface SplatStageViewerProps {
  splatId: string;
  job: Job | undefined;
  complete: boolean;
  // Undefined while loading, and for a job reconstructed before the worker wrote them.
  cameras: CameraPose[] | undefined;
  cropBox: CropBox | null;
  // Set only while the crop box can still change what gets built, which is what offers the Crop toggle.
  onCropBoxChange?: (box: CropBox | null) => void;
}

function ModeButton({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-10 rounded-full px-4.5 text-sm font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40",
        selected ? "bg-foreground text-background" : "hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

// The page's 3D view, with a toggle between the finished splat and the point cloud (the "shape sketch") COLMAP
// produced. Both URLs go to one SplatViewer, so switching keeps the camera where the visitor left it.
//
// A presigned URL is only read once, when a scene mounts, so a revalidated one that has since been re-minted is never
// reloaded (web/components/viewer/SplatViewer.tsx). What matters is that the URL in hand is still valid whenever a
// scene next mounts, such as on a mode switch.
//
// web/lib/server/s3.ts presigns for 15 minutes, so each URL is re-minted well inside that while the page is open.
const URL_REFRESH_MS = 5 * 60_000;
// SWR's cache outlives the page, so a return visit starts from the last visit's URL, which may have expired. One
// fetched longer than this before the page mounted is not used, and the page waits for SWR's revalidation instead.
const URL_MAX_AGE_AT_MOUNT_MS = 10 * 60_000;

export function SplatStageViewer({ splatId, job, complete, cameras, cropBox, onCropBoxChange }: SplatStageViewerProps) {
  const { getToken } = useAuth();
  const [mountedAt] = useState(Date.now);
  const [chosen, setChosen] = useState<ViewerMode | null>(null);
  const [showCameras, setShowCameras] = useState(true);
  const [cropping, setCropping] = useState(false);

  async function fetchUrl(path: string) {
    return { url: await apiFetch<string>(path, "GET", await requireToken(getToken)), fetchedAt: Date.now() };
  }

  function usableUrl(fetched: { url: string; fetchedAt: number } | undefined) {
    return fetched && fetched.fetchedAt > mountedAt - URL_MAX_AGE_AT_MOUNT_MS ? fetched.url : undefined;
  }

  // pointCloudS3Key is set once by the reconstruct stage and never cleared, so the sketch stays reachable through
  // training and after completion.
  const hasPointCloud = Boolean(job?.pointCloudS3Key);
  const { data: pointCloudFetch, error: pointCloudError } = useSWR(
    hasPointCloud ? ["point-cloud", splatId] : null,
    () => fetchUrl(`/api/v1/splats/${splatId}/point-cloud`),
    { refreshInterval: URL_REFRESH_MS },
  );
  // The download route collapses "not ready" and "not yours" into one 404, so a failure here is usually the result
  // still being finalized.
  const { data: splatFetch, error: splatUrlError } = useSWR(
    complete ? ["splat-download", splatId] : null,
    () => fetchUrl(`/api/v1/splats/${splatId}/download`),
    { refreshInterval: URL_REFRESH_MS },
  );
  const pointCloudUrl = usableUrl(pointCloudFetch);
  const splatUrl = usableUrl(splatFetch);

  const mode: ViewerMode = chosen ?? (complete ? "splat" : "colmap_points");
  const available = mode === "splat" ? complete : hasPointCloud;
  const url = mode === "splat" ? splatUrl : pointCloudUrl;
  const urlError = mode === "splat" ? splatUrlError : pointCloudError;
  const canCrop = mode === "colmap_points" && onCropBoxChange !== undefined;

  let body: React.ReactNode;
  if (!available) {
    body = (
      <Center className="h-full rounded-3xl bg-muted p-8 text-center">
        <p className="max-w-80 text-muted-foreground">
          {mode === "splat"
            ? "The 3D splat appears here once it's built."
            : "A sketch of the shape appears here once the cameras are placed."}
        </p>
      </Center>
    );
  } else if (urlError) {
    body = (
      <Center className="h-full rounded-3xl bg-muted p-8">
        <p className="text-muted-foreground">Still getting this ready. Check back in a moment.</p>
      </Center>
    );
  } else if (!url) {
    body = (
      <Center className="h-full rounded-3xl bg-muted">
        <Spinner className="h-8 w-8 text-muted-foreground" />
      </Center>
    );
  } else {
    body = (
      <SplatViewer
        mode={mode}
        splatUrl={splatUrl ?? null}
        pointCloudUrl={pointCloudUrl ?? null}
        cameras={cameras ?? null}
        showCameras={showCameras}
        cropping={canCrop && cropping}
        cropBox={cropBox}
        onCropBoxChange={onCropBoxChange}
        height="100%"
      />
    );
  }

  let cameraToggle: React.ReactNode = null;
  if (mode === "colmap_points" && cameras && cameras.length > 0) {
    cameraToggle = (
      <label className="flex h-10 items-center gap-2 border-divider border-l pr-3.5 pl-3 text-sm font-semibold whitespace-nowrap">
        <input
          type="checkbox"
          checked={showCameras}
          onChange={event => setShowCameras(event.target.checked)}
          className="h-4.5 w-4.5 accent-primary"
        />
        Camera positions
      </label>
    );
  }
  let cropToggle: React.ReactNode = null;
  if (canCrop) {
    cropToggle = (
      <label className="flex h-10 items-center gap-2 border-divider border-l pr-3.5 pl-3 text-sm font-semibold whitespace-nowrap">
        <input
          type="checkbox"
          checked={cropping}
          onChange={event => {
            setCropping(event.target.checked);
            // Cleared rather than kept hidden, so an unticked box never reaches the build.
            if (!event.target.checked) {
              onCropBoxChange?.(null);
            }
          }}
          className="h-4.5 w-4.5 accent-primary"
        />
        Crop
      </label>
    );
  }
  let orbitHint: React.ReactNode = null;
  if (available && url) {
    orbitHint = (
      <p className="pointer-events-none absolute top-5 right-6 text-xs text-muted-foreground">
        Drag to orbit · scroll to zoom
      </p>
    );
  }

  return (
    <div className="relative h-full">
      {body}
      <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-1 rounded-full border border-divider bg-paper p-1">
        <ModeButton
          label="3D splat"
          selected={mode === "splat"}
          disabled={!complete}
          onClick={() => setChosen("splat")}
        />
        <ModeButton
          label="Shape sketch"
          selected={mode === "colmap_points"}
          disabled={!hasPointCloud}
          onClick={() => setChosen("colmap_points")}
        />
        {cameraToggle}
        {cropToggle}
      </div>
      {orbitHint}
    </div>
  );
}
