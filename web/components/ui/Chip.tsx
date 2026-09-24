import { cn } from "@/lib/cn";

export type ChipColor = "default" | "primary" | "success" | "error" | "info";

const COLOR: Record<ChipColor, string> = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-primary text-primary-foreground",
  success: "bg-success/15 text-success",
  error: "bg-error/15 text-error",
  info: "bg-info/15 text-info",
};

interface ChipProps {
  color?: ChipColor;
  label: string;
  className?: string;
}

// A filled status pill. "primary" is solid rather than tinted, reserved for a status that needs the visitor to act.
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
