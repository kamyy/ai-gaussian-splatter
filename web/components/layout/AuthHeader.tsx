"use client";

import { UserButton } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { useSplat } from "@/lib/hooks";
import { statusColor } from "@/lib/statusColor";
import { useActiveSplatId } from "@/lib/useActiveSplatId";

// Not a reuse of the header inlined in web/app/(public)/layout.tsx. Both sit inside a fixed-height header row (this
// one the <Box component="header"> in web/app/(authenticated)/splats/layout.tsx), but the content differs: this
// header looks up and shows the current splat's name/status, which the public layout has no notion of. A height of
// "100%" fills whatever height that row leaves, rather than repeating a pixel number here.
export function AuthHeader() {
  const splatId = useActiveSplatId();
  const { data: splat } = useSplat(splatId);

  return (
    <Box sx={{ height: "100%", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center" }}>
      {splat && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: "nowrap", justifyContent: "center", gridColumn: 2 }}>
          <Typography variant="h5" component="h5">
            {splat.name}
          </Typography>
          <Chip size="small" color={statusColor(splat.status)} label={splat.status} />
        </Stack>
      )}
      <Stack direction="row" sx={{ justifyContent: "flex-end", gridColumn: 3 }}>
        <UserButton />
      </Stack>
    </Box>
  );
}
