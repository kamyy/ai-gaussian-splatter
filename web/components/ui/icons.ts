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
  LuShieldCheck,
  LuSun,
  LuTrash2,
  LuTriangleAlert,
  LuUserX,
  LuX,
} from "react-icons/lu";
import { PiCameraFill, PiSquareDuotone } from "react-icons/pi";
import {
  TbArrowBackUp,
  TbBox,
  TbBoxAlignBottom,
  TbBoxAlignLeft,
  TbBoxAlignTop,
  TbCheck,
  TbPerspective,
  TbSquare,
} from "react-icons/tb";

export type { IconType } from "react-icons";

// Moving between pages.
export const BackIcon = LuArrowLeft;
export const PreviousPageIcon = LuChevronLeft;
export const NextPageIcon = LuChevronRight;

// The theme toggle in the site header. Each icon names the theme a click switches to.
export const LightThemeIcon = LuSun;
export const DarkThemeIcon = LuMoon;

// The site header's button that reopens the privacy banner.
export const PrivacySettingsIcon = LuShieldCheck;

// The account menu's Delete account item.
export const DeleteAccountIcon = LuUserX;

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
export const SmallPointIcon = PiSquareDuotone;
export const LargePointIcon = PiSquareDuotone;
export const ApplyCropIcon = TbCheck;
export const UndoCropIcon = TbArrowBackUp;
// One square drawn both ways: tilted away for the perspective camera, whose far side looks smaller, and face-on for
// the orthographic one, which draws everything at its true size.
export const PerspectiveCameraIcon = TbPerspective;
export const OrthographicCameraIcon = TbSquare;
// The front, side and top views, each a box with one side marked: the bottom, the left and the top.
export const FrontViewIcon = TbBoxAlignBottom;
export const SideViewIcon = TbBoxAlignLeft;
export const TopViewIcon = TbBoxAlignTop;
// The crop button. The same box as front, side and top, with no face marked, because this one leaves the camera
// wherever it already is.
export const CropIcon = TbBox;
