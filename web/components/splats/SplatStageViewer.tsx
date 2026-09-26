"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";
import type { IconType } from "react-icons";
import { PiCameraDuotone, PiCameraSlashDuotone } from "react-icons/pi";
import { TbChartScatter3D, TbCube3dSphere, TbCube3dSphereOff } from "react-icons/tb";
import useSWR from "swr";

import { Center } from "@/components/layout/Center";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { DEFAULT_POINT_SIZE } from "@/components/viewer/PointCloudScene";
import { SplatViewer, type ViewMode } from "@/components/viewer/SplatViewer";
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
  // Set only while the crop box can still change what gets built, which is what offers the Crop button.
  onCropBoxChange?: (box: CropBox | null) => void;
}

// A presigned URL is only read once, when a scene mounts, so a revalidated one that has since been re-minted is never
// reloaded (web/components/viewer/SplatViewer.tsx). What matters is that the URL in hand is still valid whenever a
// scene next mounts, such as on a mode switch.
//
// web/lib/server/s3.ts presigns for 15 minutes, so each URL is re-minted well inside that while the page is open.
const URL_REFRESH_MS = 5 * 60_000;
// SWR's cache outlives the page, so a return visit starts from the last visit's URL, which may have expired. One
// fetched longer than this before the page mounted is not used, and the page waits for SWR's revalidation instead.
const URL_MAX_AGE_AT_MOUNT_MS = 10 * 60_000;

// Fetches the presigned URL at path while key is set, and returns undefined until one is fresh enough to mount.
function usePresignedUrl(key: string[] | null, path: string) {
  const { getToken } = useAuth();
  const [mountedAt] = useState(Date.now);
  const { data, error } = useSWR(
    key,
    async () => ({ url: await apiFetch<string>(path, "GET", await requireToken(getToken)), fetchedAt: Date.now() }),
    { refreshInterval: URL_REFRESH_MS },
  );
  const url = data && data.fetchedAt > mountedAt - URL_MAX_AGE_AT_MOUNT_MS ? data.url : undefined;
  return { url, error };
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

function ViewModeSelector({
  mode,
  pointCloudAvailable,
  splatAvailable,
  onChange,
}: {
  mode: ViewMode;
  pointCloudAvailable: boolean;
  splatAvailable: boolean;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="raised absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-1 rounded-full border border-divider bg-paper p-1">
      <ModeButton
        label="Point cloud"
        selected={mode === "colmap_points"}
        disabled={!pointCloudAvailable}
        onClick={() => onChange("colmap_points")}
      />
      <ModeButton
        label="3D splat"
        selected={mode === "splat"}
        disabled={!splatAvailable}
        onClick={() => onChange("splat")}
      />
    </div>
  );
}

function PointSizeSlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <Tooltip label="Point size: how large each point in the shape sketch is drawn.">
      <label className="raised flex h-9 items-center gap-2 rounded-full border border-divider bg-paper px-3.5 text-foreground whitespace-nowrap">
        <TbChartScatter3D aria-hidden="true" className="h-5 w-5" />
        <input
          type="range"
          aria-label="Point size"
          min={DEFAULT_POINT_SIZE / 5}
          max={DEFAULT_POINT_SIZE * 4}
          step={DEFAULT_POINT_SIZE / 5}
          value={value}
          onChange={event => onChange(event.target.valueAsNumber)}
          className="w-16 accent-primary"
        />
      </label>
    </Tooltip>
  );
}

// Pressed and unpressed show different icons, so the icon itself says whether the option is on.
function IconToggleButton({
  label,
  tooltip,
  pressed,
  onIcon: OnIcon,
  offIcon: OffIcon,
  onChange,
}: {
  label: string;
  tooltip: string;
  pressed: boolean;
  onIcon: IconType;
  offIcon: IconType;
  onChange: (pressed: boolean) => void;
}) {
  const Icon = pressed ? OnIcon : OffIcon;
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={() => onChange(!pressed)}
        className="raised-button flex h-9 w-9 items-center justify-center rounded-full border border-divider bg-paper text-foreground transition"
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
      </button>
    </Tooltip>
  );
}

// The scene behind the hint can be any color, so a dark copy offset 1px sits under a light one to keep it legible.
function OrbitHint() {
  return (
    <p className="pointer-events-none absolute top-5 right-6 hidden text-xs whitespace-nowrap sm:block">
      <span aria-hidden="true" className="absolute top-px left-px text-black/80">
        Drag to orbit · scroll to zoom
      </span>
      <span className="relative text-white/90">Drag to orbit · scroll to zoom</span>
    </p>
  );
}

// The page's 3D view, with a selector between the finished splat and the point cloud (the "shape sketch") COLMAP
// produced. Both URLs go to one SplatViewer, so switching keeps the camera where the visitor left it.
export function SplatStageViewer({ splatId, job, complete, cameras, cropBox, onCropBoxChange }: SplatStageViewerProps) {
  const [showCameras, setShowCameras] = useState(true);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);
  const [cropping, setCropping] = useState(false);

  // pointCloudS3Key is set once by the reconstruct stage and never cleared, so the sketch stays reachable through
  // training and after completion.
  const pointCloudAvailable = Boolean(job?.pointCloudS3Key);
  const pointCloud = usePresignedUrl(
    pointCloudAvailable ? ["point-cloud", splatId] : null,
    `/api/v1/splats/${splatId}/point-cloud`,
  );
  // The download route collapses "not ready" and "not yours" into one 404, so a failure here is usually the result
  // still being finalized.
  const splat = usePresignedUrl(complete ? ["splat-download", splatId] : null, `/api/v1/splats/${splatId}/download`);

  const mode: ViewMode = viewMode ?? (complete ? "splat" : "colmap_points");
  const canCrop = mode === "colmap_points" && onCropBoxChange !== undefined;
  const { url, error: urlError } = mode === "splat" ? splat : pointCloud;
  const available = mode === "splat" ? complete : pointCloudAvailable;

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
        splatUrl={splat.url ?? null}
        pointCloudUrl={pointCloud.url ?? null}
        cameras={cameras ?? null}
        showCameras={showCameras}
        pointSize={pointSize}
        cropping={canCrop && cropping}
        cropBox={cropBox}
        onCropBoxChange={onCropBoxChange}
        height="100%"
      />
    );
  }

  let cropButton: React.ReactNode = null;
  if (canCrop) {
    cropButton = (
      <IconToggleButton
        label="Crop"
        tooltip="Crop: fit a box around the object. Anything outside it is left out of the 3D splat."
        pressed={cropping}
        onIcon={TbCube3dSphere}
        offIcon={TbCube3dSphereOff}
        onChange={pressed => {
          setCropping(pressed);
          // Cleared rather than kept hidden, so a box the visitor turned off never reaches the build.
          if (!pressed) {
            onCropBoxChange?.(null);
          }
        }}
      />
    );
  }

  let pointSizeSlider: React.ReactNode = null;
  if (mode === "colmap_points" && pointCloudAvailable) {
    pointSizeSlider = <PointSizeSlider value={pointSize} onChange={setPointSize} />;
  }

  let cameraButton: React.ReactNode = null;
  if (mode === "colmap_points" && cameras && cameras.length > 0) {
    cameraButton = (
      <IconToggleButton
        label="Cameras"
        tooltip="Cameras: show where each photo was taken from."
        pressed={showCameras}
        onIcon={PiCameraDuotone}
        offIcon={PiCameraSlashDuotone}
        onChange={setShowCameras}
      />
    );
  }

  let viewOptions: React.ReactNode = null;
  if (pointSizeSlider || cameraButton || cropButton) {
    viewOptions = (
      <div className="absolute top-4 left-1/2 flex -translate-x-1/2 gap-2 sm:left-4 sm:translate-x-0">
        {pointSizeSlider}
        {cameraButton}
        {cropButton}
      </div>
    );
  }

  let orbitHint: React.ReactNode = null;
  if (available && url) {
    orbitHint = <OrbitHint />;
  }

  return (
    <div className="relative h-full">
      {body}
      <ViewModeSelector
        mode={mode}
        pointCloudAvailable={pointCloudAvailable}
        splatAvailable={complete}
        onChange={setViewMode}
      />
      {viewOptions}
      {orbitHint}
    </div>
  );
}
