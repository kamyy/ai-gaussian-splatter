/**
 * The orange camera pill that marks the selected photo, and the pager page holding it.
 *
 * The photo grid (web/components/splats/PhotoGrid.tsx) draws it on the selected photo with a "Selected" label, and the
 * pager (web/components/ui/Pager.tsx) draws it on the page button holding that photo, as the camera alone because a
 * page button is too narrow for the label. On a photo the pill is orange with a page-colored border, which sets it
 * apart from the photo. On a page button it takes that button's colors, with the color of the page number as its border.
 */

import { SelectedPhotoIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/**
 * The colors of a pill over each thing it can sit on. They stay the same while the pointer is over the button. The
 * pager's count pill uses the two page tones as well, so both pills on a page button match.
 */
export const PILL_TONES = {
  photo: "border border-background bg-primary text-primary-foreground",
  page: "border border-foreground bg-paper text-foreground",
  currentPage: "border border-primary-foreground bg-primary text-primary-foreground",
};

interface SelectedPhotoMarkProps {
  tone: keyof typeof PILL_TONES;
  // Positions the mark, which is absolute, in its parent.
  className: string;
  // Text beside the camera. Without it the pill holds the camera alone. The text shows only when the nearest @container
  // ancestor is at least 6rem wide, so a narrow portrait photo shows the camera alone rather than an overflowing pill.
  label?: string;
}

export function SelectedPhotoMark({ tone, className, label }: SelectedPhotoMarkProps) {
  let labelText: React.ReactNode = null;
  if (label !== undefined) {
    labelText = <span className="hidden pr-0.5 @min-[6rem]:inline">{label}</span>;
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute flex h-5.5 items-center justify-center gap-1 rounded-full px-1.5 text-xs font-bold",
        PILL_TONES[tone],
        className,
      )}
    >
      <SelectedPhotoIcon className="h-3 w-3" />
      {labelText}
    </span>
  );
}
