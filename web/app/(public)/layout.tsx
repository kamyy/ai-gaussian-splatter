import { Show, UserButton } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";

import { NavMenu } from "@/components/layout/NavMenu";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { rem } from "@/lib/rem";
import { theme } from "../../theme";

const HEADER_HEIGHT = 50;

// Sign-in, sign-up, and the public share view all keep this in-flow app header. The signed-out "/" hero and the
// authenticated splat workspace are siblings of this route group, not descendants of it, which is what lets each of
// them render its own header treatment instead — the hero has none, and the workspace renders its own
// AuthHeader (web/components/layout/AuthHeader.tsx) as a real row above its content instead of joining this shell.
//
// The header is pos="fixed" so it stays visible while the page scrolls beneath it. The content Box compensates with
// pt equal to the header's own height plus its "md"-equivalent padding, so nothing renders underneath the fixed
// header.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Box
        component="header"
        sx={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: HEADER_HEIGHT,
          zIndex: theme.zIndex.appBar,
          backgroundColor: "background.default",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box
          sx={{
            height: "100%",
            px: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <NavMenu />

          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <ThemeToggle />
            <Show when="signed-in">
              <UserButton />
            </Show>
          </Stack>
        </Box>
      </Box>
      <Box
        component="main"
        sx={{ px: 2, pb: 2, pt: `calc(${rem(HEADER_HEIGHT)} + ${theme.spacing(2)})`, minHeight: "100dvh" }}
      >
        {children}
      </Box>
    </>
  );
}
