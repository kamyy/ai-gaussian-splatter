"use client";

import { useAuth } from "@clerk/nextjs";
import { Alert, Skeleton, Stack, Text, Title } from "@mantine/core";
import { use, useEffect } from "react";
import useSWR from "swr";

import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";
import { getSplatUrl } from "@/lib/api";
import { useJobStatus, useSplat } from "@/lib/hooks";
import { JOB_ENDED_STATUSES } from "@/lib/types";

export default function SplatDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: splat, isLoading, mutate: refetchSplat } = useSplat(id);

  // Only the job is polled, but the worker's callback moves the job row and the splat row in one transaction. So a job
  // that has ended means this splat is stale. Without the refetch the page keeps rendering the poller and never mounts
  // the viewer until something else revalidates (focus, reload). Same SWR key as JobStatusPoller's, so this shares its
  // request.
  const { data: job } = useJobStatus(id);
  useEffect(() => {
    if (job && JOB_ENDED_STATUSES.includes(job.status)) {
      void refetchSplat();
    }
  }, [job, refetchSplat]);

  const { data: splatFile, error: splatFileError } = useSWR(
    splat?.status === "complete" ? ["splat-download", id] : null,
    async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      return getSplatUrl(token, id);
    },
  );

  if (isLoading) {
    return <Skeleton height={300} />;
  }
  // Deliberately not `error || !splat`: a failed revalidation leaves the last good splat in `data`, and replacing the
  // whole page with an error is worse than showing it. SWR retries on its own.
  if (!splat) {
    return <Alert color="red">Splat not found.</Alert>;
  }

  return (
    <Stack>
      <Title order={2}>{splat.name}</Title>

      {splat.status !== "complete" && <JobStatusPoller splatId={id} />}

      {/* The download route collapses "not ready" and "not yours" into one
          404, so a failure here is usually the result still being finalized. */}
      {splat.status === "complete" && splatFileError && (
        <Text c="dimmed">The splat isn&apos;t ready yet — still checking.</Text>
      )}
      {splat.status === "complete" && !splatFile && !splatFileError && <SplatViewerLoading />}
      {splat.status === "complete" && splatFile && <SplatViewer splatUrl={splatFile.url} />}

      {splat.status === "failed" && <Text c="red">Processing failed — see job status above for details.</Text>}
    </Stack>
  );
}
