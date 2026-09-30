/**
 * A small colored pill for a status label.
 *
 * The library's cards use it to show what state a splat is in.
 */

import { cn } from "@/lib/cn";

// The tints are mixed into the paper color rather than made translucent, so a chip reads the same over a photo as over
// the page.
const COLOR: Record<ChipColor, string> = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-primary text-primary-foreground",
  success: "bg-[color-mix(in_srgb,var(--color-success)_15%,var(--color-paper))] text-success",
  error: "bg-[color-mix(in_srgb,var(--color-error)_15%,var(--color-paper))] text-error",
  info: "bg-[color-mix(in_srgb,var(--color-info)_15%,var(--color-paper))] text-info",
};

export type ChipColor = "default" | "primary" | "success" | "error" | "info";

interface ChipProps {
  color?: ChipColor;
  label: string;
  className?: string;
}

/** A filled status pill. "primary" is solid rather than tinted, reserved for a status that needs the visitor to act. */
export function Chip({ color = "default", label, className }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6.5 items-center rounded-full px-2.5 text-xs font-semibold",
        COLOR[color],
        className,
      )}
    >
      {label}
    </span>
  );
}
