"use client";

import { useAuth } from "@clerk/nextjs";
import { Button, Stack, Text, TextInput, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PhotoDropzone } from "@/components/upload/PhotoDropzone";
import { UploadProgress } from "@/components/upload/UploadProgress";
import { createObject, triggerProcess } from "@/lib/api";

export default function NewObjectPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [objectId, setObjectId] = useState<string | null>(null);
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
    const obj = await createObject(token, name.trim());
    setObjectId(obj.id);
    setCreating(false);
  };

  const handleStartProcessing = async () => {
    if (!objectId) {
      return;
    }
    setStarting(true);
    const token = await getToken();
    if (!token) {
      return;
    }
    await triggerProcess(token, objectId);
    router.push(`/objects/${objectId}`);
  };

  return (
    <Stack maw={600}>
      <Title order={2}>New object</Title>

      {!objectId && (
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

      {objectId && (
        <>
          <Text size="sm" c="dimmed">
            Upload at least 20 photos of the object from different angles.
          </Text>
          <PhotoDropzone objectId={objectId} />
          <UploadProgress />
          <Button onClick={handleStartProcessing} loading={starting}>
            Start processing
          </Button>
        </>
      )}
    </Stack>
  );
}
