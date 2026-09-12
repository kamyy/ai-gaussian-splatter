"use client";

import { useAuth } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { use } from "react";
import useSWR from "swr";

import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";
import { apiFetch } from "@/lib/apiFetch";
import { useSplat } from "@/lib/hooks";
import { rem } from "@/lib/rem";

export default function SplatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: splat } = useSplat(id);

  const { data: splatUrl, error: splatUrlError } = useSWR(
    splat?.status === "complete" ? ["splat-download", id] : null,
    async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      // The download route collapses "not ready" and "not yours" into one 404, so a failure here is usually the
      // result still being finalized.
      return apiFetch<string>(`/api/v1/splats/${id}/download`, "GET", token);
    },
  );

  if (splat?.status === "failed") {
    return (
      <Box sx={{ pt: rem(76), pl: rem(24) }}>
        <Typography color="error">Processing failed — see job status for details.</Typography>
      </Box>
    );
  }
  if (splat?.status !== "complete") {
    return (
      <Box sx={{ pt: rem(76), pl: rem(24) }}>
        <Typography color="text.secondary">Not ready yet.</Typography>
      </Box>
    );
  }
  if (splatUrlError) {
    return (
      <Box sx={{ pt: rem(76), pl: rem(24) }}>
        <Typography color="text.secondary">The splat isn&apos;t ready yet — still checking.</Typography>
      </Box>
    );
  }
  if (!splatUrl) {
    return <SplatViewerLoading />;
  }

  return <SplatViewer mode="splat" splatUrl={splatUrl} pointCloudUrl={null} height="100%" />;
}
