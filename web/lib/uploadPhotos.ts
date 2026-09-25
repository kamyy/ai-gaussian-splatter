// The presign, PUT, complete loop for photo uploads. web/components/splats/NewSplatForm.tsx calls it right after
// creating a splat, which is the only place photos can be added. Progress goes through Zustand's vanilla store API, so
// this plain async function works from that caller's event handler without a hook of its own.

import { apiFetch } from "./apiFetch";
import { useAppStore } from "./store";
import type { PhotoPresignItem } from "./types";

export async function uploadPhotos(splatId: string, files: File[], token: string): Promise<void> {
  const { setUploadStatus, setUploadProgress } = useAppStore.getState();

  const presigned = await apiFetch<PhotoPresignItem[]>(
    `/api/v1/splats/${splatId}/photos/presign`,
    "POST",
    token,
    files.map(f => ({ filename: f.name, contentType: f.type || "image/jpeg" })),
  );

  const results = await Promise.all(
    files.map(async (file, index) => {
      const item = presigned[index];
      setUploadStatus(file.name, "uploading");
      try {
        const uploadResp = await fetch(item.presignedPutUrl, {
          headers: { "Content-Type": file.type },
          method: "PUT",
          body: file,
        });
        if (!uploadResp.ok) {
          throw new Error(`S3 upload failed: ${uploadResp.statusText}`);
        }
        setUploadProgress(file.name, 100);
        await apiFetch<void>(`/api/v1/splats/${splatId}/photos/${item.photoId}/complete`, "POST", token);
        setUploadStatus(file.name, "uploaded");
        return true;
      } catch (err) {
        setUploadStatus(file.name, "failed", err instanceof Error ? err.message : "Upload failed");
        return false;
      }
    }),
  );

  // Each failure is already recorded per file through setUploadStatus above. This throw is what tells
  // web/components/splats/NewSplatForm.tsx that at least one upload failed, so it doesn't treat a failed batch as a
  // success.
  const failedCount = results.filter(ok => !ok).length;
  if (failedCount > 0) {
    throw new Error(`${failedCount} of ${files.length} photo upload${files.length === 1 ? "" : "s"} failed`);
  }
}
