import Box from "@mui/material/Box";

import { AuthHeader } from "@/components/layout/AuthHeader";
import { SplatCarousel } from "@/components/splats/SplatCarousel";
import { rem } from "@/lib/rem";

// The workspace chrome for every splats route: a fixed-width navbar (the splat carousel) spanning the full
// viewport height, with a header row and the page content stacked in a column beside it. flex: "0 0 auto" pins the
// navbar's width and the header's height so only the two growing panes (the right-hand column and the content
// area) give up space first; minHeight/minWidth: 0 on those growing panes let them actually shrink instead of
// overflowing, which is a flex item's default content-based minimum size otherwise.
export default function SplatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", height: "100dvh", width: "100%" }}>
      <Box component="nav" sx={{ width: rem(200), height: "100%", flex: "0 0 auto" }}>
        <SplatCarousel />
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minWidth: 0 }}>
        <Box component="header" sx={{ height: rem(50), px: 1.5, flex: "0 0 auto" }}>
          <AuthHeader />
        </Box>
        <Box sx={{ position: "relative", width: "100%", flex: 1, minHeight: 0 }}>{children}</Box>
      </Box>
    </Box>
  );
}
