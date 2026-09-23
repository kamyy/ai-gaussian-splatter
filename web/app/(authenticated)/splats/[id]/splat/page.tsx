"use client";

import { useAuth } from "@clerk/nextjs";
import { use } from "react";
import useSWR from "swr";

import { VIEWER_BOTTOM_GAP, VIEWER_TOP_GAP } from "@/components/splats/PhotoFilmstrip";
import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";
import { apiFetch } from "@/lib/apiFetch";
import { useLatestJob, useSplat } from "@/lib/hooks";

export default function SplatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: splat } = useSplat(id);
  const { data: job } = useLatestJob(id);

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
    // Read directly from the job, not left to web/components/job/JobStatusSnackbar.tsx's toast: that toast is
    // dismissible, and dismissing it would otherwise drop the only copy of the message.
    return (
      <div className="pt-19 pl-6">
        <p className="text-error">
          {job?.errorMessage ? `Processing failed: ${job.errorMessage}` : "Processing failed."}
        </p>
      </div>
    );
  }
  if (splat?.status !== "complete") {
    return (
      <div className="pt-19 pl-6">
        <p className="text-muted-foreground">Not ready yet.</p>
      </div>
    );
  }
  if (splatUrlError) {
    return (
      <div className="pt-19 pl-6">
        <p className="text-muted-foreground">The splat isn&apos;t ready yet — still checking.</p>
      </div>
    );
  }
  if (!splatUrl) {
    return <SplatViewerLoading />;
  }

  // VIEWER_TOP_GAP/VIEWER_BOTTOM_GAP (web/components/splats/PhotoFilmstrip.tsx) keep the viewer close to the
  // header above and clear of the collapsed filmstrip below, with room for the viewer's own drop shadow
  // (web/components/viewer/SplatViewer.tsx) in the gap — without the bottom one, the viewer's own bottom edge
  // sits exactly where the filmstrip's closed handle is painted, and the handle (later in the DOM, so on top)
  // hides it. pt/pb come from those exported constants, not a static Tailwind class, so this stays in lockstep if
  // either constant there ever changes.
  return (
    <div className="h-full px-6" style={{ paddingTop: VIEWER_TOP_GAP, paddingBottom: VIEWER_BOTTOM_GAP }}>
      <SplatViewer mode="splat" splatUrl={splatUrl} pointCloudUrl={null} height="100%" />
    </div>
  );
}
