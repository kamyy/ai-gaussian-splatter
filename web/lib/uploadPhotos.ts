// Presign -> PUT -> complete upload loop, used by web/components/splats/NewSplatForm.tsx right after creating a
// splat — the only place photos can be added. Progress is reported through Zustand's vanilla store API so this plain
// async function works the same from that caller's event handler, with no hook of its own.

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

  // Each failure is already recorded per-file via setUploadStatus above, which web/components/upload/UploadProgress.tsx
  // renders. This throw is what lets web/components/splats/NewSplatForm.tsx learn that at least one upload didn't
  // make it, instead of treating a fully-failed batch as success.
  const failedCount = results.filter(ok => !ok).length;
  if (failedCount > 0) {
    throw new Error(`${failedCount} of ${files.length} photo upload${files.length === 1 ? "" : "s"} failed`);
  }
}
