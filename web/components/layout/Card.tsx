import Paper from "@mui/material/Paper";
import type { SxProps, Theme } from "@mui/material/styles";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  sx?: SxProps<Theme>;
}

// Also used by web/components/viewer/SplatViewer.tsx's mat/mount frame, so both read as the same elevated surface.
// Two stacked shadows, matching how Material Design's own elevation shadows are built: a tight, darker contact
// shadow plus a softer, larger one. The bottom offset stays dominant (light reading as overhead), with a smaller
// negative x-offset and a touch less spread so the top and left edges pick up a slight shadow too, rather than the
// hard, shadow-free edges a pure bottom-only offset leaves there.
export const CARD_SHADOW = "-1px 3px 6px -3px rgba(0, 0, 0, 0.5), -4px 9px 18px -6px rgba(0, 0, 0, 0.55)";

// Shared chrome for every card-styled panel in the app: the sidebar's "Create new splat" button
// (web/components/splats/SplatCarousel.tsx) and every floating panel over the splat canvas
// (web/components/splats/PhotoFilmstrip.tsx's "Start reconstruction", plus
// web/app/(authenticated)/splats/[id]/layout.tsx's JobStatusPoller/SplatSubNav cards). `sx` carries whatever
// each caller needs on top of that shared look, most often floating positioning.
export function Card({ children, sx }: CardProps) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, boxShadow: CARD_SHADOW, ...sx }}>
      {children}
    </Paper>
  );
}
