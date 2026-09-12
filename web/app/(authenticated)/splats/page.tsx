"use client";

import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Center } from "@/components/layout/Center";
import { useSplats } from "@/lib/hooks";
import { defaultSubRoute } from "@/lib/splatDefaultRoute";

// The carousel (rendered by the ancestor layout, web/app/(authenticated)/splats/layout.tsx) already provides the
// splat list and the "New Splat" entry point, so this is only what /splats itself renders with nothing selected.
// useSplats() returns newest first, so if any splat exists this redirects straight to the most recent one's default
// sub-route instead of making a returning user pick one every time — including right after sign-in, since
// web/app/page.tsx sends a signed-in visitor here first. Only an account with no splats at all sees the message
// below.
export default function NoSplatsPage() {
  const { data: splats, isLoading, error } = useSplats();
  const router = useRouter();
  const mostRecent = splats?.[0];

  useEffect(() => {
    if (mostRecent) {
      router.replace(`/splats/${mostRecent.id}/${defaultSubRoute(mostRecent)}`);
    }
  }, [mostRecent, router]);

  // Also covers the redirect above: the effect only fires after this renders once, so without this the "select a
  // splat" text below would flash for a frame before the redirect kicks in.
  if (isLoading || mostRecent) {
    return <Skeleton variant="rectangular" sx={{ height: "100%" }} />;
  }

  if (error) {
    return (
      <Center sx={{ height: "100%" }}>
        <Typography color="error">Failed to load splats.</Typography>
      </Center>
    );
  }

  return (
    <Center sx={{ height: "100%" }}>
      <Typography color="text.secondary">Select a splat, or click New Splat to create one.</Typography>
    </Center>
  );
}
