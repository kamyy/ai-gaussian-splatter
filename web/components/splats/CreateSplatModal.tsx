"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { mutate } from "swr";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { UploadProgress } from "@/components/upload/UploadProgress";
import { apiFetch } from "@/lib/apiFetch";
import { cn } from "@/lib/cn";
import { useAppStore } from "@/lib/store";
import type { Splat } from "@/lib/types";
import { uploadPhotos } from "@/lib/uploadPhotos";
import { useAppSnackbar } from "@/lib/useAppSnackbar";

interface CreateSplatModalProps {
  opened: boolean;
  onClose: () => void;
}

// Name plus optional photos in one step. This is the only place photos can be added to a splat, so it uploads them
// itself before navigating to the new splat's default view, where they show up in that route's PhotoFilmstrip rather
// than on a page of their own. A failure at any step is reported through the shared snackbar stack
// (web/components/layout/ThemeRegistry.tsx's SnackbarProvider), not an inline Alert.
export function CreateSplatModal({ opened, onClose }: CreateSplatModalProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const { enqueueSnackbar } = useAppSnackbar();
  const resetUploads = useAppStore(state => state.resetUploads);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Set once the POST below succeeds, so a retry after a photo-upload failure reuses this splat instead of creating a
  // second one.
  const [createdSplat, setCreatedSplat] = useState<Splat | null>(null);

  const { getRootProps, getInputProps, isDragAccept, isDragReject } = useDropzone({
    onDrop: setFiles,
    accept: { "image/*": [] },
    multiple: true,
    disabled: submitting,
  });

  function reset() {
    setName("");
    setFiles([]);
    setCreatedSplat(null);
    resetUploads();
  }

  function handleClose() {
    if (!submitting) {
      reset();
      onClose();
    }
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return;
    }
    setSubmitting(true);

    const token = await getToken();
    if (!token) {
      enqueueSnackbar("Not signed in", { variant: "error" });
      setSubmitting(false);
      return;
    }

    let splat: Splat;
    if (createdSplat) {
      splat = createdSplat;
    } else {
      try {
        splat = await apiFetch<Splat>("/api/v1/splats", "POST", token, { name: trimmedName });
      } catch (err) {
        enqueueSnackbar(err instanceof Error ? err.message : "Failed to create splat", { variant: "error" });
        setSubmitting(false);
        return;
      }

      // The splat now exists server-side no matter what happens below, so the carousel must show it, and a retry click
      // reuses it via createdSplat above instead of re-POSTing a duplicate.
      setCreatedSplat(splat);
      await mutate("splats");
    }

    try {
      if (files.length > 0) {
        await uploadPhotos(splat.id, files, token);
        // The earlier mutate("splats") above ran before any photo existed, so the sidebar card still shows no
        // thumbnail/"Photos" chip without this. The photos key also needs its own revalidation: PhotoFilmstrip
        // (web/components/splats/PhotoFilmstrip.tsx) can already be mounted for this splat by the time upload finishes,
        // since a first-ever splat's creation retargets web/app/(authenticated)/splats/page.tsx's redirect as soon as
        // the splat row exists, well before its photos do.
        await mutate("splats");
        await mutate(["photos", splat.id]);
      }
      reset();
      onClose();
      router.push(`/splats/${splat.id}`);
    } catch (err) {
      enqueueSnackbar(
        err instanceof Error
          ? `"${trimmedName}" was created, but photo upload failed: ${err.message}`
          : `"${trimmedName}" was created, but photo upload failed.`,
        { variant: "error" },
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={opened} onOpenChange={next => !next && handleClose()}>
      <DialogContent>
        <DialogTitle>Create new splat</DialogTitle>
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            placeholder="e.g. Coffee mug"
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus
          />
          <div
            {...getRootProps()}
            className={cn(
              // "divider" is tuned for a 1px separator against an adjacent surface, not a dashed outline standing alone
              // in open space — in dark mode it sits too close to bg-paper's own tone to read as a drop-zone edge.
              // text-muted-foreground keeps a legible boundary in both modes.
              "rounded-sm border border-dashed p-6 text-center",
              isDragReject ? "border-error" : "border-muted-foreground",
              submitting ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            <input {...getInputProps()} />
            <div className="flex min-h-25 flex-col justify-center pointer-events-none">
              {isDragReject ? (
                <p className="text-sm text-error">Only image files are accepted</p>
              ) : isDragAccept ? (
                <p className="text-sm">Drop photos here</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Drag photos here, or click to select files — optional now, but this is the only chance to add them
                </p>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {files.length} photo{files.length === 1 ? "" : "s"} selected
          </p>
          <UploadProgress />
          <Button onClick={handleCreate} disabled={name.trim().length === 0 || submitting} loading={submitting}>
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
