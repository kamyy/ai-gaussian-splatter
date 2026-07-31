"use client";

import { use } from "react";
import { useAuth } from "@clerk/nextjs";
import { Alert, Skeleton, Stack, Text, Title } from "@mantine/core";
import useSWR from "swr";

import { useObject } from "@/lib/hooks";
import { getSplatUrl } from "@/lib/api";
import { JobStatusPoller } from "@/components/job/JobStatusPoller";
import { SplatViewer, SplatViewerLoading } from "@/components/viewer/SplatViewer";

export default function ObjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { getToken } = useAuth();
  const { data: object, isLoading, error } = useObject(id);

  const { data: splat } = useSWR(object?.status === "complete" ? ["splat", id] : null, async () => {
    const token = await getToken();
    if (!token) throw new Error("Not signed in");
    return getSplatUrl(token, id);
  });

  if (isLoading) return <Skeleton height={300} />;
  if (error || !object) return <Alert color="red">Object not found.</Alert>;

  return (
    <Stack>
      <Title order={2}>{object.name}</Title>

      {object.status !== "complete" && <JobStatusPoller objectId={id} />}

      {object.status === "complete" && !splat && <SplatViewerLoading />}
      {object.status === "complete" && splat && <SplatViewer splatUrl={splat.url} />}

      {object.status === "failed" && <Text c="red">Processing failed — see job status above for details.</Text>}
    </Stack>
  );
}
