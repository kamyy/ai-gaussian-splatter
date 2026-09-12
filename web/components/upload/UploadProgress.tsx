"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { UploadItemStatus } from "@/lib/store";
import { useAppStore } from "@/lib/store";

const STATUS_COLOR: Record<UploadItemStatus, "primary" | "info" | "success" | "error"> = {
  pending: "primary",
  uploading: "info",
  uploaded: "success",
  failed: "error",
};

export function UploadProgress() {
  const uploads = useAppStore(state => state.uploads);
  const items = Object.values(uploads);

  if (items.length === 0) {
    return null;
  }

  return (
    <Stack spacing={1}>
      {items.map(item => (
        <Stack
          key={item.filename}
          direction="row"
          spacing={1}
          sx={{ justifyContent: "space-between", flexWrap: "nowrap", alignItems: "center" }}
        >
          <Typography variant="body2" noWrap sx={{ flex: 1 }}>
            {item.filename}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={item.progress}
            color={STATUS_COLOR[item.status]}
            sx={{ width: 120 }}
          />
          <Box
            sx={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: `${STATUS_COLOR[item.status]}.main`,
            }}
          >
            <Typography variant="caption">
              {item.status === "uploaded" ? "✓" : item.status === "failed" ? "✕" : "…"}
            </Typography>
          </Box>
        </Stack>
      ))}
    </Stack>
  );
}
