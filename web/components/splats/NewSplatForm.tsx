"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { mutate } from "swr";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { apiFetch } from "@/lib/apiFetch";
import { cn } from "@/lib/cn";
import { useAppStore } from "@/lib/store";
import type { Job, Splat } from "@/lib/types";
import { uploadPhotos } from "@/lib/uploadPhotos";
import { useAppSnackbar } from "@/lib/useAppSnackbar";

// Guidance, not a limit: the meter fills at this count. The server's own minimum is MIN_PHOTOS_PER_SPLAT.
const TARGET_PHOTOS = 50;

type Phase = "idle" | "creating" | "uploading" | "starting";

// Two files with the same name and size from separate drops are the same photo picked twice.
function fileKey(file: File) {
  return `${file.name}:${file.size}`;
}

function PhotoMeter({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2.5">
      {/* Decorative: the count it draws is already in the "N photos added" text beside it. */}
      <div aria-hidden="true" className="h-2 w-32 overflow-hidden rounded-full bg-divider">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(100, (count / TARGET_PHOTOS) * 100)}%` }}
        />
      </div>
      <span className="text-xs whitespace-nowrap text-muted-foreground">aim for {TARGET_PHOTOS}+</span>
    </div>
  );
}

// Name plus photos in one step. This is the only place photos can be added to a splat, so it uploads them itself and
// then starts processing, before navigating to the new splat's page. A failure at any step is reported through the
// shared snackbar stack (web/components/layout/ThemeRegistry.tsx's SnackbarProvider).
export function NewSplatForm() {
  const { getToken } = useAuth();
  const router = useRouter();
  const { enqueueSnackbar } = useAppSnackbar();
  const resetUploads = useAppStore(state => state.resetUploads);
  const uploads = useAppStore(state => state.uploads);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  // Set once the POST below succeeds, so a retry after a photo-upload failure reuses this splat instead of creating a
  // second one.
  const [createdSplat, setCreatedSplat] = useState<Splat | null>(null);
  const submitting = phase !== "idle";

  const { getRootProps, getInputProps, open, isDragAccept, isDragReject } = useDropzone({
    onDrop: accepted =>
      setFiles(current => {
        const seen = new Set(current.map(fileKey));
        return [...current, ...accepted.filter(file => !seen.has(fileKey(file)))];
      }),
    accept: { "image/*": [] },
    multiple: true,
    disabled: submitting,
    // The zone is a drop target only. Clicking it would also fire for the remove buttons on the previews beside it,
    // so the file picker opens from its own "browse files" button instead.
    noClick: true,
    noKeyboard: true,
  });

  const previews = useMemo(() => files.map(file => ({ file, url: URL.createObjectURL(file) })), [files]);
  useEffect(
    () => () => {
      for (const preview of previews) {
        URL.revokeObjectURL(preview.url);
      }
    },
    [previews],
  );

  // Clears the previous batch's per-file progress, which lives in a store shared with every other upload.
  useEffect(() => resetUploads, [resetUploads]);

  function removeFile(key: string) {
    setFiles(current => current.filter(file => fileKey(file) !== key));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || files.length === 0) {
      return;
    }

    const token = await getToken();
    if (!token) {
      enqueueSnackbar("Not signed in", { variant: "error" });
      return;
    }

    let splat = createdSplat;
    if (!splat) {
      setPhase("creating");
      try {
        splat = await apiFetch<Splat>("/api/v1/splats", "POST", token, { name: trimmedName });
      } catch (err) {
        enqueueSnackbar(err instanceof Error ? err.message : "Failed to create splat", { variant: "error" });
        setPhase("idle");
        return;
      }
      setCreatedSplat(splat);
      await mutate("splats");
    }

    setPhase("uploading");
    resetUploads();
    try {
      await uploadPhotos(splat.id, files, token);
    } catch (err) {
      enqueueSnackbar(
        err instanceof Error
          ? `"${trimmedName}" was created, but photo upload failed: ${err.message}`
          : `"${trimmedName}" was created, but photo upload failed.`,
        { variant: "error" },
      );
      setPhase("idle");
      return;
    }

    // A failure to start (too few photos, a rate limit) still lands on the splat's page, which offers its own start
    // button once whatever blocked it is resolved.
    setPhase("starting");
    try {
      await apiFetch<Job>(`/api/v1/splats/${splat.id}/process`, "POST", token);
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : "Failed to start processing", { variant: "error" });
    }

    await mutate("splats");
    router.push(`/splats/${splat.id}`);
  }

  const uploadedCount = Object.values(uploads).filter(item => item.status === "uploaded").length;
  let progressLabel: string | null = null;
  if (phase === "creating") {
    progressLabel = "Creating…";
  } else if (phase === "uploading") {
    progressLabel = `Uploading ${uploadedCount} of ${files.length}…`;
  } else if (phase === "starting") {
    progressLabel = "Starting…";
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 flex-col gap-6">
      <Input
        label="What are you capturing?"
        placeholder="e.g. Ceramic vase"
        value={name}
        onChange={event => setName(event.target.value)}
        disabled={submitting}
        className="max-w-120"
        autoFocus
      />

      <div
        {...getRootProps()}
        className={cn(
          "flex flex-col gap-4 rounded-3xl border-2 border-dashed p-5",
          files.length === 0 && "min-h-60 justify-center",
          isDragReject ? "border-error" : isDragAccept ? "border-primary" : "border-divider",
        )}
      >
        <input {...getInputProps()} aria-label="Photos" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold">
              {files.length === 0
                ? "Drop your photos here"
                : `${files.length} photo${files.length === 1 ? "" : "s"} added`}
            </span>
            <span className="text-sm text-muted-foreground">
              {isDragReject ? "Only image files are accepted." : "More angles usually means a better result."}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <PhotoMeter count={files.length} />
            <Button variant="outlined" onClick={open} disabled={submitting}>
              Browse files
            </Button>
          </div>
        </div>
        {previews.length > 0 && (
          <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
            {previews.map(({ file, url }) => (
              <li key={fileKey(file)} className="relative aspect-square overflow-hidden rounded-xl bg-muted">
                {/* biome-ignore lint/performance/noImgElement: a local object URL, not something next/image can optimize. */}
                <img src={url} alt={file.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeFile(fileKey(file))}
                  disabled={submitting}
                  className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-paper text-foreground disabled:hidden"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="submit"
          variant="contained"
          size="large"
          loading={submitting}
          disabled={name.trim().length === 0 || files.length === 0}
        >
          Upload and start
        </Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {progressLabel ?? "Next, we'll place the cameras and show you a sketch of the shape to check."}
        </span>
      </div>
    </form>
  );
}
