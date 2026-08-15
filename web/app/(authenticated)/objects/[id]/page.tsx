"use client";

import { useAuth } from "@clerk/nextjs";
import { Alert, Skeleton, Stack, Text, Title } from "@mantine/core";
import { use, useEffect } from "react";
import useSWR from "swr";

import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";
import { getSplatUrl } from "@/lib/api";
import { useJobStatus, useObject } from "@/lib/hooks";
import { JOB_ENDED_STATUSES } from "@/lib/types";

export default function ObjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: object, isLoading, mutate: refetchObject } = useObject(id);

  // Only the job is polled, but the worker's callback moves the job row and
  // the splat row in one transaction — so a job that has ended means this
  // object is stale. Without the refetch the page keeps rendering the poller
  // and never mounts the viewer until something else revalidates (focus,
  // reload). Same SWR key as JobStatusPoller's, so this shares its request.
  const { data: job } = useJobStatus(id);
  useEffect(() => {
    if (job && JOB_ENDED_STATUSES.includes(job.status)) {
      void refetchObject();
    }
  }, [job, refetchObject]);

  const { data: splat, error: splatError } = useSWR(object?.status === "complete" ? ["splat", id] : null, async () => {
    const token = await getToken();
    if (!token) {
      throw new Error("Not signed in");
    }
    return getSplatUrl(token, id);
  });

  if (isLoading) {
    return <Skeleton height={300} />;
  }
  // Deliberately not `error || !object`: a failed revalidation leaves the last
  // good object in `data`, and replacing the whole page with an error is worse
  // than showing it. SWR retries on its own.
  if (!object) {
    return <Alert color="red">Object not found.</Alert>;
  }

  return (
    <Stack>
      <Title order={2}>{object.name}</Title>

      {object.status !== "complete" && <JobStatusPoller objectId={id} />}

      {/* The splat route collapses "not ready" and "not yours" into one 404,
          so a failure here is usually the result still being finalized. */}
      {object.status === "complete" && splatError && (
        <Text c="dimmed">The splat isn&apos;t ready yet — still checking.</Text>
      )}
      {object.status === "complete" && !splat && !splatError && <SplatViewerLoading />}
      {object.status === "complete" && splat && <SplatViewer splatUrl={splat.url} />}

      {object.status === "failed" && <Text c="red">Processing failed — see job status above for details.</Text>}
    </Stack>
  );
}
