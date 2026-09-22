import KeyboardDoubleArrowDown from "@mui/icons-material/KeyboardDoubleArrowDown";
import KeyboardDoubleArrowLeft from "@mui/icons-material/KeyboardDoubleArrowLeft";
import KeyboardDoubleArrowRight from "@mui/icons-material/KeyboardDoubleArrowRight";
import KeyboardDoubleArrowUp from "@mui/icons-material/KeyboardDoubleArrowUp";
import IconButton from "@mui/material/IconButton";

export type ScrollEdgeDirection = "up" | "down" | "left" | "right";

const DIRECTION_ICON = {
  up: KeyboardDoubleArrowUp,
  down: KeyboardDoubleArrowDown,
  left: KeyboardDoubleArrowLeft,
  right: KeyboardDoubleArrowRight,
} as const;

interface ScrollEdgeButtonProps {
  label: string;
  direction: ScrollEdgeDirection;
  onClick: () => void;
}

// Shared by web/components/splats/SplatCarousel.tsx and web/components/splats/PhotoFilmstrip.tsx: a small button
// that jumps a scroll container to one end.
export function ScrollEdgeButton({ label, direction, onClick }: ScrollEdgeButtonProps) {
  const Icon = DIRECTION_ICON[direction];
  return (
    <IconButton size="small" sx={{ color: "text.secondary" }} aria-label={label} onClick={onClick}>
      <Icon fontSize="small" />
    </IconButton>
  );
}
