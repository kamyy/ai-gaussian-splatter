/**
 * Every icon the app draws, named for what it means on screen.
 *
 * The icons come from react-icons, which bundles several icon sets. Components import them from here rather than from
 * react-icons, so each name says what the icon is for, and swapping an icon or its set is a change to this file alone.
 * One icon can have several names when it means different things in different places.
 */

import {
  LuArrowLeft,
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuCircleCheck,
  LuImage,
  LuInfo,
  LuMoon,
  LuSun,
  LuTrash2,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import {
  PiCameraDuotone,
  PiCameraFill,
  PiCameraSlashDuotone,
  PiCircleDuotone,
  PiDotOutlineDuotone,
  PiSelectionDuotone,
  PiSelectionSlashDuotone,
} from "react-icons/pi";

export type { IconType } from "react-icons";

// Moving between pages.
export const BackIcon = LuArrowLeft;
export const PreviousPageIcon = LuChevronLeft;
export const NextPageIcon = LuChevronRight;

// The theme toggle in the site header. Each icon names the theme a click switches to.
export const LightThemeIcon = LuSun;
export const DarkThemeIcon = LuMoon;

// Toast messages: one icon per variant, plus the close button.
export const InfoIcon = LuInfo;
export const SuccessIcon = LuCircleCheck;
export const WarningIcon = LuTriangleAlert;
export const ErrorIcon = LuCircleAlert;
export const CloseIcon = LuX;

// Photo tiles on the new-splat form and a splat's photo grid, and the pager page that holds the selected photo.
export const PhotoPlaceholderIcon = LuImage;
export const PhotoUploadedIcon = LuCheck;
export const RemovePhotoIcon = LuTrash2;
export const SelectedPhotoIcon = PiCameraFill;

// The splat library and a splat's progress through the pipeline.
export const ThumbnailPlaceholderIcon = LuImage;
export const StepDoneIcon = LuCheck;
export const ProcessingPausedIcon = LuTriangleAlert;

// The 3D viewer's controls.
export const SmallPointIcon = PiDotOutlineDuotone;
export const LargePointIcon = PiCircleDuotone;
export const CropOnIcon = PiSelectionDuotone;
export const CropOffIcon = PiSelectionSlashDuotone;
export const CamerasShownIcon = PiCameraDuotone;
export const CamerasHiddenIcon = PiCameraSlashDuotone;
