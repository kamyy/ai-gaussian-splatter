import IconButton from "@mui/material/IconButton";

import { ChevronEdgeIcon } from "./ChevronEdgeIcon";

interface ScrollEdgeButtonProps {
  label: string;
  rotation: number;
  onClick: () => void;
}

// Shared by web/components/splats/SplatCarousel.tsx and web/components/splats/PhotoFilmstrip.tsx: a small button that
// jumps a scroll container to one end, rotating the same chevron-with-bar glyph per direction/orientation.
export function ScrollEdgeButton({ label, rotation, onClick }: ScrollEdgeButtonProps) {
  return (
    <IconButton size="small" sx={{ color: "text.secondary" }} aria-label={label} onClick={onClick}>
      <ChevronEdgeIcon size={16} style={{ transform: `rotate(${rotation}deg)` }} />
    </IconButton>
  );
}
