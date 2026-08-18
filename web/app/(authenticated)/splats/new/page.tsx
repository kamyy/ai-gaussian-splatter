"use client";

import { useAuth } from "@clerk/nextjs";
import { Button, Stack, Text, TextInput, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PhotoDropzone } from "@/components/upload/PhotoDropzone";
import { UploadProgress } from "@/components/upload/UploadProgress";
import { createSplat, triggerProcess } from "@/lib/api";

export default function NewSplatPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [splatId, setSplatId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      return;
    }
    setCreating(true);
    const token = await getToken();
    if (!token) {
      return;
    }
    const splat = await createSplat(token, name.trim());
    setSplatId(splat.id);
    setCreating(false);
  };

  const handleStartProcessing = async () => {
    if (!splatId) {
      return;
    }
    setStarting(true);
    const token = await getToken();
    if (!token) {
      return;
    }
    await triggerProcess(token, splatId);
    router.push(`/splats/${splatId}`);
  };

  return (
    <Stack maw={600}>
      <Title order={2}>New splat</Title>

      {!splatId && (
        <>
          <TextInput
            label="Name"
            placeholder="e.g. Ceramic mug"
            value={name}
            onChange={e => setName(e.currentTarget.value)}
          />
          <Button onClick={handleCreate} loading={creating} disabled={!name.trim()}>
            Continue
          </Button>
        </>
      )}

      {splatId && (
        <>
          <Text size="sm" c="dimmed">
            Upload at least 20 photos of the object from different angles.
          </Text>
          <PhotoDropzone splatId={splatId} />
          <UploadProgress />
          <Button onClick={handleStartProcessing} loading={starting}>
            Start processing
          </Button>
        </>
      )}
    </Stack>
  );
}
