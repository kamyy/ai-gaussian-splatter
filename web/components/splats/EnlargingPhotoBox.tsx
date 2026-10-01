/**
 * The box a photo tile draws its photo in, which grows over the neighbouring tiles while the photo is enlarged.
 *
 * The splat page's photo grid (web/components/splats/PhotoGrid.tsx) and the new-splat form's previews
 * (web/components/splats/NewSplatForm.tsx) both draw their photos in it. web/lib/hooks/useEnlargedTile.ts picks the
 * enlarged photo, and web/lib/expandedBox.ts works out where it is drawn. The tile itself keeps its place in the row,
 * and has to sit above the other tiles while its photo is enlarged and until the photo has shrunk back.
 */

import { cn } from "@/lib/cn";
import type { Box } from "@/lib/expandedBox";

interface EnlargingPhotoBoxProps {
  // Where to draw the photo while it is enlarged, measured from the tile's top-left corner. Null draws it in the tile.
  enlargedBox: Box | null;
  width: number;
  height: number;
  // The tile's corner rounding, which the box repeats because the tile can't clip an enlarged photo.
  className: string;
  children: React.ReactNode;
}

/**
 * The box takes the pointer once enlarged, so the photo stays up until the pointer leaves the enlarged photo rather
 * than the tile it grew from. Until then it ignores the pointer, so a child that must stay clickable, such as a remove
 * button, turns it back on for itself with pointer-events-auto.
 */
export function EnlargingPhotoBox({ enlargedBox, width, height, className, children }: EnlargingPhotoBoxProps) {
  return (
    <span
      style={enlargedBox ?? { left: 0, top: 0, width, height }}
      className={cn(
        "absolute transition-[left,top,width,height,box-shadow] ease-out motion-reduce:transition-none",
        enlargedBox ? "shadow-[0_0.75rem_1.75rem_var(--raised-shade)]" : "pointer-events-none",
        className,
      )}
    >
      {children}
    </span>
  );
}
