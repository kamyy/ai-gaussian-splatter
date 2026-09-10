"use client";

import { useAuth } from "@clerk/nextjs";
import { Button, Stack, Text, TextInput, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PhotoDropzone } from "@/components/upload/PhotoDropzone";
import { UploadProgress } from "@/components/upload/UploadProgress";
import { apiFetch } from "@/lib/apiFetch";
import type { Job, Splat } from "@/lib/types";

export default function NewSplatPage() {
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [splatId, setSplatId] = useState("");
  const [name, setName] = useState("");

  const { getToken } = useAuth();
  const router = useRouter();

  const handleNew = async () => {
    try {
      setCreating(true);

      if (name.trim()) {
        const token = await getToken();
        if (token) {
          const { id } = await apiFetch<Splat>("/api/v1/splats", "POST", token, { name: name.trim() });
          setSplatId(id);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRun = async () => {
    try {
      setStarting(true);

      if (splatId) {
        const token = await getToken();
        if (token) {
          await apiFetch<Job>(`/api/v1/splats/${splatId}/process`, "POST", token);
          router.push(`/splats/${splatId}`);
        }
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <Stack maw={600}>
      <Title order={2}>New splat</Title>

      {splatId ? (
        <>
          <Text size="sm" c="dimmed">
            Upload at least 20 photos of the object from different angles.
          </Text>
          <PhotoDropzone splatId={splatId} />
          <UploadProgress />
          <Button onClick={handleRun} loading={starting}>
            Start running
          </Button>
        </>
      ) : (
        <>
          <TextInput
            label="Name"
            placeholder="e.g. Ceramic mug"
            value={name}
            onChange={e => setName(e.currentTarget.value)}
          />
          <Button onClick={handleNew} loading={creating} disabled={!name.trim()}>
            Continue
          </Button>
        </>
      )}
    </Stack>
  );
}
