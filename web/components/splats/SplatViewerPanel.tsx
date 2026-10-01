/**
 * The 3D viewer panel for one splat, with its controls.
 *
 * Wraps web/components/viewer/SplatViewer.tsx with the buttons around it: switching between the finished splat and
 * COLMAP's point cloud, showing the photos' cameras, drawing a crop box, and sizing the points. The caller hands it the
 * download links for both 3D files, so the owner's page and the public share page can each get them their own way.
 */

"use client";

import { useMemo, useState } from "react";

import { Center } from "@/components/layout/Center";
import {
  CamerasHiddenIcon,
  CamerasShownIcon,
  CropOffIcon,
  CropOnIcon,
  type IconType,
  LargePointIcon,
  SmallPointIcon,
} from "@/components/ui/icons";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { DEFAULT_POINT_SIZE } from "@/components/viewer/PointCloudScene";
import { SplatViewer, type ViewMode } from "@/components/viewer/SplatViewer";
import { cn } from "@/lib/cn";
import type { CameraSelection } from "@/lib/hooks/useCameraFlight";
import type { CameraPose, CropBox } from "@/lib/types";
import type { PhotoSelection } from "./photoSelection";

/**
 * One 3D file the panel can show. available says the file exists. url is undefined while its link is still being
 * fetched, and error is set when fetching it failed.
 */
interface ViewerAsset {
  available: boolean;
  url: string | undefined;
  error?: unknown;
}

interface SplatViewerPanelProps {
  splat: ViewerAsset;
  pointCloud: ViewerAsset;
  // Null or undefined while loading, and for a job reconstructed before the worker wrote them.
  cameras: CameraPose[] | null | undefined;
  cropBox: CropBox | null;
  selection: PhotoSelection | null;
  onSelectPhoto: (photoId: string) => void;
  // Clears the selection once the visitor moves the view away from the selected photo's by hand.
  onClearSelection: () => void;
  // The photo hovered in the grid or, through its camera, in the 3D view.
  hoveredPhotoId: string | null;
  onHoverPhoto: (photoId: string | null) => void;
  // Set only while the crop box can still change what gets built, which is what offers the Crop button.
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
        <SmallPointIcon aria-hidden="true" className="h-5 w-5" />
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
        <LargePointIcon aria-hidden="true" className="h-4 w-4" />
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
function HintLine({ text }: { text: string }) {
  return (
    <span className="relative block">
      <span aria-hidden="true" className="absolute top-px left-px text-black/80">
        {text}
      </span>
      <span className="relative text-white/90">{text}</span>
    </span>
  );
}

// The camera line shows only while clicking a frustum selects it: the frustums are drawn and the crop box is off.
function OrbitHint({ canPickCameras }: { canPickCameras: boolean }) {
  let pickLine: React.ReactNode = null;
  if (canPickCameras) {
    pickLine = <HintLine text="Click a camera frustum for photo" />;
  }

  return (
    <p className="pointer-events-none absolute top-5 right-6 hidden flex-col items-end gap-1 text-xs whitespace-nowrap sm:flex">
      {pickLine}
      <HintLine text="Drag to orbit · scroll to zoom" />
    </p>
  );
}

// The index into cameras of photoId's camera, which is how SplatViewer names a camera. null when there is none.
function cameraIndexOf(cameras: CameraPose[] | null | undefined, photoId: string | null): number | null {
  const index = photoId && cameras ? cameras.findIndex(camera => camera.photoId === photoId) : -1;
  return index === -1 ? null : index;
}

/**
 * The 3D view, with a selector between the finished splat and the point cloud (the "shape sketch") COLMAP produced.
 * Both URLs go to one SplatViewer, so switching keeps the camera where the visitor left it.
 */
export function SplatViewerPanel({
  splat,
  pointCloud,
  cameras,
  cropBox,
  selection,
  onSelectPhoto,
  onClearSelection,
  hoveredPhotoId,
  onHoverPhoto,
  onCropBoxChange,
}: SplatViewerPanelProps) {
  const [showCameras, setShowCameras] = useState(true);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);
  const [cropping, setCropping] = useState(false);

  // Recomputed only when the selection or the cameras change, since each new object flies the view again.
  const selectedCamera = useMemo<CameraSelection | null>(() => {
    const index = cameraIndexOf(cameras, selection?.photoId ?? null);
    return index === null ? null : { index };
  }, [selection, cameras]);
  const hoveredCamera = cameraIndexOf(cameras, hoveredPhotoId);

  const mode: ViewMode = viewMode ?? (splat.available ? "splat" : "colmap_points");
  const canCrop = mode === "colmap_points" && onCropBoxChange !== undefined;
  const { available, url, error: urlError } = mode === "splat" ? splat : pointCloud;

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
        <Spinner size="large" className="text-primary" />
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
        selectedCamera={selectedCamera}
        onSelectCamera={index => {
          if (cameras?.[index]) {
            onSelectPhoto(cameras[index].photoId);
          }
        }}
        // Only while something is selected, so dragging with nothing selected doesn't set state on every frame.
        onManualMove={selection ? onClearSelection : undefined}
        hoveredCamera={hoveredCamera}
        onHoverCamera={index => onHoverPhoto(index === null ? null : (cameras?.[index]?.photoId ?? null))}
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
        onIcon={CropOnIcon}
        offIcon={CropOffIcon}
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
  if (mode === "colmap_points" && pointCloud.available) {
    pointSizeSlider = <PointSizeSlider value={pointSize} onChange={setPointSize} />;
  }

  let cameraButton: React.ReactNode = null;
  if (mode === "colmap_points" && cameras && cameras.length > 0) {
    cameraButton = (
      <IconToggleButton
        label="Cameras"
        tooltip="Cameras: show where each photo was taken from."
        pressed={showCameras}
        onIcon={CamerasShownIcon}
        offIcon={CamerasHiddenIcon}
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
    const canPickCameras =
      mode === "colmap_points" && showCameras && Boolean(cameras?.length) && !(canCrop && cropping);
    orbitHint = <OrbitHint canPickCameras={canPickCameras} />;
  }

  return (
    <div className="relative h-full">
      {body}
      <ViewModeSelector
        mode={mode}
        pointCloudAvailable={pointCloud.available}
        splatAvailable={splat.available}
        onChange={setViewMode}
      />
      {viewOptions}
      {orbitHint}
    </div>
  );
}
