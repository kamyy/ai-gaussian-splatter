"use client";

import { useAuth } from "@clerk/nextjs";
import { Button, FileInput, Stack, Text } from "@mantine/core";
import { useState } from "react";

import { apiFetch } from "@/lib/apiFetch";
import { useAppStore } from "@/lib/store";
import type { PhotoPresignItem } from "@/lib/types";

interface PhotoDropzoneProps {
  splatId: string;
  onAllUploaded?: () => void;
}

export function PhotoDropzone({ splatId, onAllUploaded }: PhotoDropzoneProps) {
  const { getToken } = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const setUploadStatus = useAppStore(state => state.setUploadStatus);
  const setUploadProgress = useAppStore(state => state.setUploadProgress);
  const showBanner = useAppStore(state => state.showBanner);

  const handleUpload = async () => {
    if (files.length === 0) {
      return;
    }
    setSubmitting(true);

    const token = await getToken();
    if (!token) {
      showBanner({ message: "Not signed in", variant: "error" });
      setSubmitting(false);
      return;
    }

    try {
      const photos = await apiFetch<PhotoPresignItem[]>(
        `/api/v1/splats/${splatId}/photos/presign`,
        "POST",
        token,
        files.map(f => ({ filename: f.name, contentType: f.type || "image/jpeg" })),
      );

      await Promise.all(
        files.map(async (file, index) => {
          const presigned = photos[index];
          setUploadStatus(file.name, "uploading");
          try {
            const uploadResp = await fetch(presigned.presignedPutUrl, {
              headers: { "Content-Type": file.type },
              method: "PUT",
              body: file,
            });
            if (!uploadResp.ok) {
              throw new Error(`S3 upload failed: ${uploadResp.statusText}`);
            }
            setUploadProgress(file.name, 100);
            await apiFetch<void>(`/api/v1/splats/${splatId}/photos/${presigned.photoId}/complete`, "POST", token);
            setUploadStatus(file.name, "uploaded");
          } catch (err) {
            setUploadStatus(file.name, "failed", err instanceof Error ? err.message : "Upload failed");
          }
        }),
      );

      onAllUploaded?.();
    } catch (err) {
      // Most likely a 429 from the per-IP/per-user rate limit — surfaced via the banner rather than a generic error
      // boundary, since it's an expected, actionable state ("slow down"), not a bug.
      showBanner({
        message: err instanceof Error ? err.message : "Failed to start upload",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack>
      <FileInput
        label="Photos"
        description="Select all photos of the object, taken from different angles"
        placeholder="Choose files"
        multiple
        accept="image/*"
        value={files}
        onChange={setFiles}
      />
      <Text size="sm" c="dimmed">
        {files.length} photo{files.length === 1 ? "" : "s"} selected
      </Text>
      <Button onClick={handleUpload} disabled={files.length === 0 || submitting} loading={submitting}>
        Upload
      </Button>
    </Stack>
  );
}
