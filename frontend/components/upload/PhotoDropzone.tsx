"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button, FileInput, Stack, Text } from "@mantine/core";

import { completePhoto, presignPhotos, uploadToS3 } from "@/lib/api";
import { useAppStore } from "@/lib/store";

interface PhotoDropzoneProps {
  objectId: string;
  onAllUploaded?: () => void;
}

export function PhotoDropzone({ objectId, onAllUploaded }: PhotoDropzoneProps) {
  const { getToken } = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const setUploadStatus = useAppStore((state) => state.setUploadStatus);
  const setUploadProgress = useAppStore((state) => state.setUploadProgress);
  const showBanner = useAppStore((state) => state.showBanner);

  const handleUpload = async () => {
    if (files.length === 0) return;
    setSubmitting(true);

    const token = await getToken();
    if (!token) {
      showBanner({ message: "Not signed in", variant: "error" });
      setSubmitting(false);
      return;
    }

    try {
      const { photos } = await presignPhotos(
        token,
        objectId,
        files.map((f) => ({ filename: f.name, content_type: f.type || "image/jpeg" }))
      );

      await Promise.all(
        files.map(async (file, index) => {
          const presigned = photos[index];
          setUploadStatus(file.name, "uploading");
          try {
            await uploadToS3(presigned.presigned_put_url, file);
            setUploadProgress(file.name, 100);
            await completePhoto(token, objectId, presigned.photo_id);
            setUploadStatus(file.name, "uploaded");
          } catch (err) {
            setUploadStatus(file.name, "failed", err instanceof Error ? err.message : "Upload failed");
          }
        })
      );

      onAllUploaded?.();
    } catch (err) {
      // Most likely a 429 from the per-IP/per-user rate limit (plan §5) —
      // surfaced via the banner rather than a generic error boundary, since
      // it's an expected, actionable state ("slow down"), not a bug.
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
