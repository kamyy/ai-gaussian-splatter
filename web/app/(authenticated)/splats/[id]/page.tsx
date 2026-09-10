"use client";

import { useAuth } from "@clerk/nextjs";
import { Alert, SegmentedControl, Skeleton, Stack, Text, Title } from "@mantine/core";
import { use, useEffect, useState } from "react";
import useSWR, { type KeyedMutator } from "swr";

import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { AwaitingTrainingPanel } from "@/components/viewer/AwaitingTrainingPanel";
import { SplatViewer, SplatViewerLoading, type ViewerMode } from "@/components/viewer/SplatViewer";
import { apiFetch } from "@/lib/apiFetch";
import { useLatestJob, useSplat } from "@/lib/hooks";
import { JOB_ENDED_STATUSES } from "@/lib/types";

/**
 * A presigned download URL and the moment it was minted. S3 stops honouring one 15 minutes after that
 * (PRESIGN_EXPIRY_SECONDS, web/lib/server/s3.ts), which is far less than a session spent turning one splat around, so
 * the age has to be tracked to know when a cached URL can still be handed to a viewer that is about to mount.
 */
interface PresignedUrl {
  url: string;
  fetchedAt: number;
}

// Comfortably inside the 15-minute expiry, so even a URL used at the last moment before this threshold has minutes
// left for the download itself to start.
const PRESIGN_REFRESH_AFTER_MS = 10 * 60_000;

// SWR's automatic revalidation is off for the two presign fetches. Every presign mints a different URL string for the
// same object, and the only thing that should decide when that string changes is refreshIfStale() below, which runs
// immediately before a mode switch remounts the viewer against it.
const PRESIGN_SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
} as const;

async function refreshIfStale(entry: PresignedUrl | undefined, refetch: KeyedMutator<PresignedUrl>) {
  if (entry !== undefined && Date.now() - entry.fetchedAt < PRESIGN_REFRESH_AFTER_MS) {
    return;
  }
  // Swallowed rather than blocking the switch. SWR keeps the last URL and records the error, so the mode still
  // changes and the failure surfaces through the viewer's own error path instead of a toggle that does nothing.
  await refetch().catch(() => undefined);
}

export default function SplatDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: splat, isLoading, mutate: refetchSplat } = useSplat(id);
  const [mode, setMode] = useState<ViewerMode>("splat");

  // Only the job is polled, but the worker's callback moves the job row and the splat row in one transaction. So a job
  // that has ended means this splat is stale. Without the refetch the page keeps rendering the poller and never mounts
  // the viewer until something else revalidates (focus, reload). Same SWR key as JobStatusPoller's, so this shares its
  // request.
  const { data: job, mutate: refetchJob } = useLatestJob(id);
  useEffect(() => {
    if (job && JOB_ENDED_STATUSES.includes(job.status)) {
      void refetchSplat();
    }
  }, [job, refetchSplat]);

  const {
    data: splatFile,
    error: splatFileError,
    mutate: refetchSplatFile,
  } = useSWR(
    splat?.status === "complete" ? ["splat-download", id] : null,
    async (): Promise<PresignedUrl> => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      const url = await apiFetch<string>(`/api/v1/splats/${id}/download`, "GET", token);
      return { url, fetchedAt: Date.now() };
    },
    PRESIGN_SWR_OPTIONS,
  );

  // Set once by the reconstruct phase and never cleared, so this stays fetchable through training and after
  // completion — what makes the COLMAP toggle position available "at any time" on a finished splat, not just during
  // the awaiting_training pause.
  const {
    data: pointCloud,
    error: pointCloudError,
    mutate: refetchPointCloud,
  } = useSWR(
    job?.pointCloudS3Key ? ["point-cloud", id] : null,
    async (): Promise<PresignedUrl> => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      return {
        url: await apiFetch<string>(`/api/v1/splats/${id}/point-cloud`, "GET", token),
        fetchedAt: Date.now(),
      };
    },
    PRESIGN_SWR_OPTIONS,
  );

  // Switching modes remounts the scene, which re-downloads from whichever URL is current. That is the one moment an
  // expired URL would surface, so it is the moment to replace one that is close to expiring.
  async function handleModeChange(next: ViewerMode) {
    if (next === "colmap_points") {
      await refreshIfStale(pointCloud, refetchPointCloud);
    } else {
      await refreshIfStale(splatFile, refetchSplatFile);
    }
    setMode(next);
  }

  if (isLoading) {
    return <Skeleton height={300} />;
  }
  // Deliberately not `error || !splat`: a failed revalidation leaves the last good splat in `data`, and replacing the
  // whole page with an error is worse than showing it. SWR retries on its own.
  if (!splat) {
    return <Alert color="red">Splat not found.</Alert>;
  }

  // Only splats whose reconstruct phase ran under the stage split have a point cloud to show. Offering the toggle
  // position unconditionally would give anything processed before that an empty canvas.
  const modeOptions = [
    { label: "Splat", value: "splat" },
    { label: "Trained points", value: "trained_points" },
    ...(job?.pointCloudS3Key ? [{ label: "COLMAP points", value: "colmap_points" }] : []),
  ];

  return (
    <Stack>
      <Title order={2}>{splat.name}</Title>

      {splat.status !== "complete" && <JobStatusPoller splatId={id} />}

      {job?.status === "awaiting_training" && pointCloudError && (
        <Text c="dimmed">The point cloud isn&apos;t ready yet — still checking.</Text>
      )}
      {job?.status === "awaiting_training" && !pointCloud && !pointCloudError && <SplatViewerLoading />}
      {job?.status === "awaiting_training" && pointCloud && (
        <AwaitingTrainingPanel splatId={id} pointCloudUrl={pointCloud.url} onTrainStarted={() => void refetchJob()} />
      )}

      {/* The download route collapses "not ready" and "not yours" into one
          404, so a failure here is usually the result still being finalized. */}
      {splat.status === "complete" && splatFileError && (
        <Text c="dimmed">The splat isn&apos;t ready yet — still checking.</Text>
      )}
      {splat.status === "complete" && !splatFile && !splatFileError && <SplatViewerLoading />}
      {splat.status === "complete" && splatFile && (
        <>
          <SegmentedControl
            value={mode}
            onChange={value => void handleModeChange(value as ViewerMode)}
            data={modeOptions}
          />
          <SplatViewer mode={mode} splatUrl={splatFile.url} pointCloudUrl={pointCloud?.url ?? null} />
        </>
      )}

      {splat.status === "failed" && <Text c="red">Processing failed — see job status above for details.</Text>}
    </Stack>
  );
}
