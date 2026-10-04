/**
 * The 3D viewer panel for one splat, with its controls.
 *
 * Wraps web/components/viewer/SplatViewer.tsx with the buttons around it: switching between the finished splat and
 * COLMAP's point cloud, sizing the points, and, for the splat's owner, cropping the splat or undoing the crop. The
 * point cloud can also switch between a perspective and an orthographic camera.
 *
 * Every crop control lives in the point cloud view only, under either camera, because the points are much easier to see
 * past than the splat's Gaussians. The crop button and the front, side and top buttons each open the crop box. A
 * front, side or top button also aims the camera at that side of the box. The crop button does not. Clicking the
 * highlighted button again closes the box. The box starts from the last one used for this splat, when one exists.
 * None of the four buttons removes the cropped point cloud. Only undo does that. Without crop controls, the front,
 * side and top buttons only aim the camera. Their tooltips name that view. The finished splat stays on the
 * perspective camera. The orthographic one is only for the point cloud, where it shows whether the box's edges line
 * up with the object. A box being fitted survives a trip to another view and back. The point cloud's camera choice
 * survives that trip too.
 *
 * The caller hands the panel the download links for both 3D files, so the owner's page and the public share page can
 * each get them their own way.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Center } from "@/components/layout/Center";
import {
  ApplyCropIcon,
  CropIcon,
  FrontViewIcon,
  type IconType,
  LargePointIcon,
  OrthographicCameraIcon,
  PerspectiveCameraIcon,
  SideViewIcon,
  SmallPointIcon,
  TopViewIcon,
  UndoCropIcon,
} from "@/components/ui/icons";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import type { AxisView } from "@/components/viewer/cameraFraming";
import { DEFAULT_POINT_SIZE } from "@/components/viewer/PointCloudScene";
import { type Projection, SplatViewer, type ViewMode } from "@/components/viewer/SplatViewer";
import { cn } from "@/lib/cn";
import type { CameraSelection } from "@/lib/hooks/useCameraFlight";
import type { CameraPose, CropBox } from "@/lib/types";
import type { PhotoSelection } from "./photoSelection";

const PROJECTION_OPTIONS: IconOption<Projection>[] = [
  {
    value: "perspective",
    label: "Perspective camera",
    tooltip: "Perspective",
    icon: PerspectiveCameraIcon,
  },
  {
    value: "orthographic",
    label: "Orthographic camera",
    tooltip: "Orthographic",
    icon: OrthographicCameraIcon,
  },
];

const AXIS_VIEWS: { value: AxisView; label: string; icon: IconType }[] = [
  { value: "front", label: "Front view", icon: FrontViewIcon },
  { value: "side", label: "Side view", icon: SideViewIcon },
  { value: "top", label: "Top view", icon: TopViewIcon },
];

const CROP_OPTION: IconOption<"crop"> = {
  value: "crop",
  label: "Crop",
  tooltip: "Crop from the current view",
  icon: CropIcon,
};

// One button of an IconSegmentedControl.
interface IconOption<T extends string> {
  value: T;
  label: string;
  tooltip: string;
  icon: IconType;
}

/**
 * One 3D file the panel can show. available says the file exists. url is undefined while its link is still being
 * fetched, and error is set when fetching it failed.
 */
interface ViewerAsset {
  available: boolean;
  url: string | undefined;
  error?: unknown;
  // Which version of the file url points at, as SplatViewer's splatVersion. Only the splat has versions.
  version?: string;
}

/** The owner's requests for cropping a finished splat. The panel decides when the box is open. */
export interface CropControls {
  // Both resolve to whether the request succeeded. A success closes the box.
  onApply: (box: CropBox) => Promise<boolean>;
  onUndo: () => Promise<boolean>;
  // The crop request in flight, if any.
  busy: "apply" | "undo" | null;
}

interface SplatViewerPanelProps {
  splat: ViewerAsset;
  pointCloud: ViewerAsset;
  // Null or undefined while loading, and for a job reconstructed before the worker wrote them.
  cameras: CameraPose[] | null | undefined;
  selection: PhotoSelection | null;
  // Clears the selection once the visitor moves the view away from the selected photo's by hand.
  onClearSelection: () => void;
  // The box the splat is cropped to, or null while it isn't cropped. The point cloud hides the points outside it.
  cropBox?: CropBox | null;
  // Set only for the owner of a finished splat, which is what offers the Crop button.
  crop?: CropControls;
}

// cropping is true when the visitor can fit a box. The tooltip then says the button frames that crop. Otherwise the
// same button only turns the camera. The tooltip names the view.
function axisViewOptions(cropping: boolean): IconOption<AxisView>[] {
  return AXIS_VIEWS.map(view => ({
    ...view,
    tooltip: cropping ? `Frame the crop from the ${view.value}` : `View from the ${view.value}`,
  }));
}

function ViewModeButton({
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
      <ViewModeButton
        label="Point cloud"
        selected={mode === "colmap_points"}
        disabled={!pointCloudAvailable}
        onClick={() => onChange("colmap_points")}
      />
      <ViewModeButton
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
    <Tooltip label="Point size">
      <label className="raised flex h-9 items-center gap-2 rounded-full border border-divider bg-paper px-3.5 text-foreground whitespace-nowrap">
        <SmallPointIcon aria-hidden="true" className="h-2 w-2" />
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
        <LargePointIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </label>
    </Tooltip>
  );
}

// A row of icon buttons of which at most one is pressed. A null value presses none of them, as when the visitor has
// turned the view away from every option. bare draws only the buttons, for a group inside a shared pill.
function IconSegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  action,
  bare = false,
}: {
  label: string;
  options: IconOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  // An action that belongs with the options, drawn after a divider.
  action?: React.ReactNode;
  bare?: boolean;
}) {
  let trailingAction: React.ReactNode = null;
  if (action) {
    trailingAction = (
      <span className="flex items-center">
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-divider" />
        {action}
      </span>
    );
  }

  return (
    <fieldset
      aria-label={label}
      className={
        bare
          ? "m-0 flex min-w-0 items-center gap-0.5 border-0 bg-transparent p-0"
          : "raised m-0 flex h-9 min-w-0 items-center gap-0.5 rounded-full border border-divider bg-paper p-0.5"
      }
    >
      {options.map(({ value: option, label: optionLabel, tooltip, icon: Icon }) => (
        <Tooltip key={option} label={tooltip}>
          <button
            type="button"
            aria-label={optionLabel}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "flex h-7.5 w-7.5 items-center justify-center rounded-full transition-colors",
              value === option ? "bg-foreground text-background" : "text-foreground hover:bg-muted",
            )}
          >
            <Icon aria-hidden="true" className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
      ))}
      {trailingAction}
    </fieldset>
  );
}

// An icon action drawn inside an IconSegmentedControl's pill, the same size as its options. tooltip is the name shown
// on hover. label is what a screen reader reads.
function PillAction({
  label,
  tooltip,
  icon: Icon,
  loading,
  disabled = false,
  onClick,
}: {
  label: string;
  tooltip: string;
  icon: IconType;
  loading: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        onClick={onClick}
        className="flex h-7.5 w-7.5 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? <Spinner /> : <Icon aria-hidden="true" className="h-4.5 w-4.5" />}
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

function OrbitHint() {
  return (
    <p className="pointer-events-none absolute top-5 right-6 hidden flex-col items-end gap-1 text-xs whitespace-nowrap sm:flex">
      <HintLine text="Drag to orbit · scroll to zoom" />
    </p>
  );
}

// The index into cameras of photoId's camera, which is how SplatViewer names a camera. null when there is none.
function cameraIndexOf(cameras: CameraPose[] | null | undefined, photoId: string | null): number | null {
  const index = photoId && cameras ? cameras.findIndex(camera => camera.photoId === photoId) : -1;
  return index === -1 ? null : index;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Two crop boxes are the same crop when every number matches. A refetch builds a new object for the box it already had.
function cropBoxesMatch(left: CropBox | null, right: CropBox | null): boolean {
  if (left === null || right === null) {
    return false;
  }

  return (
    sameNumbers(left.center, right.center) &&
    sameNumbers(left.size, right.size) &&
    sameNumbers(left.quaternion, right.quaternion)
  );
}

/**
 * The 3D view, with a selector between the finished splat and the point cloud (the "shape sketch") COLMAP produced.
 * Both URLs go to one SplatViewer, so switching keeps the camera where the visitor left it.
 */
export function SplatViewerPanel({
  splat,
  pointCloud,
  cameras,
  selection,
  onClearSelection,
  cropBox = null,
  crop,
}: SplatViewerPanelProps) {
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [chosenMode, setChosenMode] = useState<ViewMode | null>(null);
  const [projection, setProjection] = useState<Projection>("perspective");

  const mode: ViewMode = chosenMode ?? (splat.available ? "splat" : "colmap_points");
  const asset = mode === "splat" ? splat : pointCloud;

  // The side the camera animated to, until the visitor turns away or flies to a photo. The choice stays while the
  // splat is on screen, and the same button is pressed again when the point cloud comes back.
  const [axisView, setAxisView] = useState<AxisView | null>(null);

  // True while the owner is fitting a box. A successful apply or undo closes it, and so does picking a photo.
  const [editing, setEditing] = useState(false);
  // The box being fitted. It starts from the one still held for this visit, or from the splat's applied crop. Null
  // until one of those exists, or until the viewer fits one to the point cloud.
  const [draftBox, setDraftBox] = useState<CropBox | null>(null);
  // The box front, side and top aim at for this fitting. Set when crop mode opens, and unchanged by a handle drag.
  const [aimBox, setAimBox] = useState<CropBox | null>(null);
  // The box undo just removed. The job can still report it until the refetch, and a later crop is a different box.
  const [undoneCrop, setUndoneCrop] = useState<CropBox | null>(null);

  // True while a front, side or top view or a crop is open.
  const engagedRef = useRef(false);
  engagedRef.current = axisView !== null || editing;
  const onClearSelectionRef = useRef(onClearSelection);
  onClearSelectionRef.current = onClearSelection;
  // True once the opening photo has been on screen with nothing else aimed. A crop opened after that keeps the photo,
  // so a drag still levels its roll.
  const acceptedOpeningRef = useRef(false);
  if (selection?.opening === true && !engagedRef.current) {
    acceptedOpeningRef.current = true;
  }
  // The opening photo showed up while the view was already aimed, so the viewer does not take it.
  const suppressOpening = selection?.opening === true && engagedRef.current && !acceptedOpeningRef.current;

  const selectedIndex = cameraIndexOf(cameras, suppressOpening ? null : (selection?.photoId ?? null));
  // A new object flies the view again. Picking a photo builds one, including a second pick of the photo already shown.
  // A reloaded camera list keeps the object already built for that photo.
  const selectedCamera = useMemo<CameraSelection | null>(() => {
    if (selection === null || selectedIndex === null) {
      return null;
    }

    if (selection.opening) {
      return { index: selectedIndex, opening: true };
    }

    return { index: selectedIndex };
  }, [selection, selectedIndex]);

  // The box is fitted against the point cloud, so a splat without one can't be cropped.
  const cropControls = splat.available && pointCloud.available ? crop : undefined;
  const editingCrop = cropControls !== undefined && editing;
  const appliedCrop = cropBox !== null && !cropBoxesMatch(cropBox, undoneCrop) ? cropBox : null;
  const canCrop = mode === "colmap_points" && cropControls !== undefined;
  // The crop button is the highlighted one while a crop is open and the camera is not on a front, side or top view.
  // Turning away from one of those views leaves the crop open, so the button takes over.
  const cropButtonSelected = editingCrop && axisView === null;

  // A photo picked from the grid flies the camera to its view, which leaves the front, side or top view and the crop
  // box behind. The photo the page opens on does not. When that photo shows up after the visitor has already aimed,
  // it is dropped instead. A crop opened over the photo already on screen keeps both. A reloaded camera list keeps
  // the same object and must not close the crop.
  useEffect(() => {
    if (!selection) {
      return;
    }

    if (selection.opening) {
      if (engagedRef.current && !acceptedOpeningRef.current) {
        onClearSelectionRef.current();
      }
      return;
    }

    setAxisView(null);
    setEditing(false);
  }, [selection]);

  useEffect(() => {
    if (undoneCrop === null) {
      return;
    }

    if (cropBox === null || !cropBoxesMatch(cropBox, undoneCrop)) {
      setUndoneCrop(null);
    }
  }, [cropBox, undoneCrop]);

  // Every way into crop mode starts from the same box: the draft still held, otherwise the splat's crop.
  function openCrop() {
    if (editingCrop) {
      return;
    }

    const seed = draftBox ?? appliedCrop;
    if (seed) {
      setDraftBox(seed);
      setAimBox(seed);
    } else {
      setAimBox(null);
    }
    setEditing(true);
  }

  function closeCrop() {
    setAxisView(null);
    setEditing(false);
  }

  // The visitor has turned away from a front, side or top view. Keep the crop, on the angle the camera has now.
  function leaveAxisView() {
    setAxisView(null);
    if (canCrop && !editingCrop) {
      openCrop();
    }
  }

  function selectAxisView(view: AxisView) {
    // Choosing a side leaves the selected photo's view behind, as dragging away from it does.
    if (selection) {
      onClearSelection();
    }

    // This side is already highlighted, so the click leaves crop mode instead of aiming the camera again.
    if (axisView === view && editingCrop) {
      closeCrop();
      return;
    }

    setAxisView(view);
    // The first choice opens the crop box. A later one only turns the camera, so a box already being fitted stays put.
    if (canCrop && !editingCrop) {
      openCrop();
    }
  }

  function toggleCrop() {
    // The crop button is highlighted, so this click leaves crop mode. The camera stays where it is.
    if (cropButtonSelected) {
      closeCrop();
      return;
    }

    setAxisView(null);
    openCrop();
  }

  function rememberCropBox(box: CropBox) {
    setDraftBox(box);
    setAimBox(current => current ?? box);
  }

  function applyCrop() {
    if (!draftBox || !cropControls) {
      return;
    }

    const box = draftBox;
    void cropControls.onApply(box).then(succeeded => {
      if (!succeeded) {
        return;
      }

      setEditing(false);

      // The same box applied again never arrives as a different cropBox, so the undo's ignore has to end here.
      if (cropBoxesMatch(box, undoneCrop)) {
        setUndoneCrop(null);
      }
    });
  }

  function undoCrop() {
    if (!cropControls) {
      return;
    }

    void (async () => {
      if (await cropControls.onUndo()) {
        setEditing(false);
        setDraftBox(null);
        setAimBox(null);
        setUndoneCrop(cropBox);
      }
    })();
  }

  const { available, url, error: assetError } = asset;

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
  } else if (assetError) {
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
        projection={mode === "splat" ? "perspective" : projection}
        axisView={axisView}
        onLeaveAxisView={leaveAxisView}
        splatUrl={splat.url ?? null}
        splatVersion={splat.version}
        pointCloudUrl={pointCloud.url ?? null}
        cameras={cameras ?? null}
        selectedCamera={selectedCamera}
        // Only while something is selected, so dragging with nothing selected doesn't set state on every frame.
        onManualMove={selection ? onClearSelection : undefined}
        pointSize={pointSize}
        cropping={editingCrop}
        cropBox={draftBox}
        onCropBoxChange={rememberCropBox}
        appliedCropBox={appliedCrop}
        aimBox={editingCrop ? aimBox : null}
        height="100%"
      />
    );
  }

  let cropAction: React.ReactNode = null;
  if (canCrop && cropControls) {
    if (editingCrop) {
      cropAction = (
        <PillAction
          label="Apply crop"
          tooltip="Keep what's inside the box"
          icon={ApplyCropIcon}
          disabled={draftBox === null}
          loading={cropControls.busy === "apply"}
          onClick={applyCrop}
        />
      );
    } else if (appliedCrop) {
      cropAction = (
        <PillAction
          label="Undo crop"
          tooltip="Restore the original"
          icon={UndoCropIcon}
          loading={cropControls.busy === "undo"}
          onClick={undoCrop}
        />
      );
    }
  }

  let cropButton: React.ReactNode = null;
  if (canCrop) {
    cropButton = (
      <IconSegmentedControl
        bare
        label="Crop"
        options={[CROP_OPTION]}
        value={cropButtonSelected ? "crop" : null}
        onChange={toggleCrop}
        action={cropAction}
      />
    );
  }

  let pointSizeControl: React.ReactNode = null;
  if (mode === "colmap_points" && pointCloud.available) {
    pointSizeControl = (
      <div className="absolute top-4 left-1/2 -translate-x-1/2 sm:left-4 sm:translate-x-0">
        <PointSizeSlider value={pointSize} onChange={setPointSize} />
      </div>
    );
  }

  // Narrow screens sit these above the view mode selector, which would otherwise overlap them. Perspective and
  // orthographic have their own pill, and only on the point cloud. The splat stays perspective. Front, side and top
  // share the other pill with the crop button when cropping is offered.
  let pointCloudControls: React.ReactNode = null;
  if (available && url && mode === "colmap_points") {
    pointCloudControls = (
      <div className="absolute bottom-20 left-1/2 flex -translate-x-1/2 gap-2 sm:bottom-5 sm:left-4 sm:translate-x-0">
        <IconSegmentedControl label="Camera" options={PROJECTION_OPTIONS} value={projection} onChange={setProjection} />
        <div className="raised flex h-9 items-center gap-0.5 rounded-full border border-divider bg-paper p-0.5">
          <IconSegmentedControl
            bare
            label="View"
            options={axisViewOptions(cropControls !== undefined)}
            value={axisView}
            onChange={selectAxisView}
          />
          {cropButton}
        </div>
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
        pointCloudAvailable={pointCloud.available}
        splatAvailable={splat.available}
        onChange={setChosenMode}
      />
      {pointCloudControls}
      {pointSizeControl}
      {orbitHint}
    </div>
  );
}
