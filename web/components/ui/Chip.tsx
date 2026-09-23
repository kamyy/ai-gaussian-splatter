import { cn } from "@/lib/cn";

type ChipColor = "default" | "primary" | "success" | "error" | "info";
type ChipSize = "small" | "medium";

const COLOR: Record<ChipColor, string> = {
  default: "text-muted-foreground",
  primary: "text-primary",
  success: "text-success",
  error: "text-error",
  info: "text-info",
};

interface ChipProps {
  color?: ChipColor;
  size?: ChipSize;
  label: string;
  className?: string;
}

// Reproduces web/theme.ts's former MuiChip override: transparent background, italic, color carried by the text
// rather than a filled pill.
export function Chip({ color = "default", size = "medium", label, className }: ChipProps) {
  return (
    <span className={cn("italic font-normal", COLOR[color], size === "small" ? "text-xs" : "text-sm", className)}>
      {label}
    </span>
  );
}
