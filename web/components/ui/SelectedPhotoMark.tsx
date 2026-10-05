/**
 * The orange camera pill that marks the selected photo, and the pager page holding it.
 *
 * The pill shows the camera alone. On a photo the pill is orange with a page-colored border, which sets it apart from
 * the photo. On a page button it takes that button's colors, with the color of the page number as its border.
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
}

export function SelectedPhotoMark({ tone, className }: SelectedPhotoMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute flex h-4.5 w-4.5 items-center justify-center rounded-full",
        PILL_TONES[tone],
        className,
      )}
    >
      <SelectedPhotoIcon className="h-2.5 w-2.5" />
    </span>
  );
}
