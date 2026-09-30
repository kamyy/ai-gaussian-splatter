/**
 * The form on /splats/new that creates a splat from a name and a set of photos.
 *
 * The visitor names the splat and drops photos onto it, previewed in justified rows. A blurry or low-resolution photo is
 * marked in the preview, with an offer to remove every marked photo at once. Submitting creates the splat,
 * uploads the photos straight to S3 (AWS's file storage), and starts processing, then moves to the new splat's page. If
 * an upload fails partway, a retry reuses the splat and sends only the photos that didn't make it. While processing is
 * paused for the whole site, the form says so, and submitting only creates the splat and uploads its photos.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { mutate } from "swr";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PhotoFlagIcon, PhotoPlaceholderIcon, PhotoUploadedIcon, RemovePhotoIcon } from "@/components/ui/icons";
import { Pager } from "@/components/ui/Pager";
import { Tooltip } from "@/components/ui/Tooltip";
import { apiFetch } from "@/lib/apiFetch";
import { cn } from "@/lib/cn";
import { useAppSnackbar } from "@/lib/hooks/useAppSnackbar";
import { useJustifiedPages } from "@/lib/hooks/useJustifiedPages";
import { type PhotoFlag, usePickedPhotos } from "@/lib/hooks/usePickedPhotos";
import { useProcessingPaused } from "@/lib/hooks/useProcessingPaused";
import { MAX_PHOTOS_PER_SPLAT, MIN_SHARP_PHOTO_EDGE } from "@/lib/limits";
import { fileKey } from "@/lib/measurePhoto";
import { useAppStore } from "@/lib/store";
import type { Job, Splat } from "@/lib/types";
import { uploadPhotos } from "@/lib/uploadPhotos";
import { ProcessingPausedNotice } from "./ProcessingPausedNotice";

// Guidance, not a limit: the meter fills at this count. The server's own minimum is the min-photos-per-splat runtime
// setting (web/lib/server/runtimeSettings.ts).
const TARGET_PHOTOS = 50;
// A page of previews is this many whole rows, so every page but the last ends on a full row. Only that page is
// rendered, so a large drop never decodes every full-size photo at once.
const PREVIEW_ROWS_PER_PAGE = 4;
const PREVIEW_ROW_HEIGHT_REM = 7.5;
// Matches the preview list's gap-2.
const PREVIEW_GAP_REM = 0.5;

const FLAG_LABELS: Record<PhotoFlag, string> = {
  blurry: "Looks blurry",
  low_res: `Low resolution (under ${MIN_SHARP_PHOTO_EDGE}px)`,
};

type Phase = "idle" | "creating" | "uploading" | "starting";

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

// Marks a photo that will likely make the splat worse. The photo can still be uploaded.
function FlagBadge({ filename, flag }: { filename: string; flag: PhotoFlag }) {
  return (
    <Tooltip label={FLAG_LABELS[flag]}>
      <span
        role="img"
        aria-label={`${filename}: ${FLAG_LABELS[flag]}`}
        className="absolute top-1 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-paper text-error"
      >
        <PhotoFlagIcon aria-hidden="true" className="h-3 w-3" />
      </span>
    </Tooltip>
  );
}

/**
 * Name plus photos in one step. This is the only place photos can be added to a splat, so it uploads them itself and
 * then starts processing, before navigating to the new splat's page. A failure at any step is reported through the
 * shared snackbar stack (web/components/layout/AppSnackbarProvider.tsx).
 */
export function NewSplatForm() {
  const { getToken } = useAuth();
  const router = useRouter();
  const { enqueueSnackbar } = useAppSnackbar();
  const resetUploads = useAppStore(state => state.resetUploads);
  const processingPaused = useProcessingPaused();

  const [name, setName] = useState("");

  const { photos, flagged, measuring, addFiles, removeFiles } = usePickedPhotos();
  const aspects = useMemo(() => photos.map(photo => photo.width / photo.height), [photos]);
  const {
    setArea: setPreviewArea,
    areaHeight: previewAreaHeight,
    current: currentPage,
    pageCount,
    setPage,
    start,
    end,
    tiles,
  } = useJustifiedPages(aspects, {
    rowHeightRem: PREVIEW_ROW_HEIGHT_REM,
    columnGapRem: PREVIEW_GAP_REM,
    rowGapRem: PREVIEW_GAP_REM,
    rowsPerPage: PREVIEW_ROWS_PER_PAGE,
  });

  const [phase, setPhase] = useState<Phase>("idle");

  // Set once the POST below succeeds, so a retry after a photo-upload failure reuses this splat instead of creating a
  // second one.
  const [createdSplat, setCreatedSplat] = useState<Splat | null>(null);

  // Keyed by fileKey. A retry uploads only the photos not in here, because every photo the server already has would
  // otherwise be stored again and go to COLMAP twice.
  const [uploadedKeys, setUploadedKeys] = useState<ReadonlySet<string>>(new Set());
  const submitting = phase !== "idle";
  const tooManyPhotos = photos.length > MAX_PHOTOS_PER_SPLAT;

  // An uploaded photo is already on the server, so it can no longer be removed here, and flagging it would only nag.
  const removableFlagged = [...flagged.keys()].filter(key => !uploadedKeys.has(key));

  const { getRootProps, getInputProps, open, isDragAccept, isDragReject } = useDropzone({
    onDrop: accepted => void addFiles(accepted).then(() => setPage(1)),
    accept: { "image/*": [] },
    multiple: true,
    disabled: submitting,
    // The zone is a drop target only. Clicking it would also fire for the remove buttons on the previews inside it,
    // so the file picker opens from its own "browse files" button instead.
    noClick: true,
    noKeyboard: true,
  });

  const previews = useMemo(
    () => photos.slice(start, end).map(photo => ({ photo, url: URL.createObjectURL(photo.thumbnail) })),
    [photos, start, end],
  );
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || photos.length === 0 || tooManyPhotos || measuring) {
      return;
    }

    // Set before the token fetch, which can take a moment, so the button shows its spinner as soon as it's clicked.
    setPhase(createdSplat ? "uploading" : "creating");
    const token = await getToken();
    if (!token) {
      enqueueSnackbar("Not signed in", { variant: "error" });
      setPhase("idle");
      return;
    }

    let splat = createdSplat;
    if (!splat) {
      try {
        splat = await apiFetch<Splat>("/api/v1/splats", "POST", token, { name: trimmedName });
      } catch (err) {
        enqueueSnackbar("Couldn't create the splat", {
          variant: "error",
          detail: err instanceof Error ? err.message : undefined,
        });
        setPhase("idle");
        return;
      }

      setCreatedSplat(splat);
      await mutate("splats");
    }

    setPhase("uploading");
    resetUploads();
    const remaining = photos.filter(photo => !uploadedKeys.has(fileKey(photo.file)));
    try {
      await uploadPhotos(splat.id, remaining, token, photo => {
        setUploadedKeys(current => new Set(current).add(fileKey(photo.file)));
      });
    } catch (err) {
      enqueueSnackbar("Photo upload failed", {
        variant: "error",
        detail: `"${trimmedName}" was created. ${err instanceof Error ? err.message : "Submit again to retry."}`,
      });
      setPhase("idle");
      return;
    }

    // A failure to start (too few photos, a rate limit) still lands on the splat's page, which offers its own start
    // button once whatever blocked it is resolved. While processing is paused the notice above the form already said
    // so, and the splat's page offers the same button once processing is turned back on.
    if (!processingPaused) {
      setPhase("starting");
      try {
        await apiFetch<Job>(`/api/v1/splats/${splat.id}/process`, "POST", token);
      } catch (err) {
        enqueueSnackbar("Couldn't start processing", {
          variant: "error",
          detail: err instanceof Error ? err.message : undefined,
        });
      }
    }

    await mutate("splats");
    router.push(`/splats/${splat.id}`);
  }

  const uploadedCount = photos.filter(photo => uploadedKeys.has(fileKey(photo.file))).length;
  let progressLabel: string | null = null;
  if (measuring && phase === "idle") {
    progressLabel = "Reading photos…";
  } else if (phase === "creating") {
    progressLabel = "Creating…";
  } else if (phase === "uploading") {
    progressLabel = `Uploading ${uploadedCount} of ${photos.length}…`;
  } else if (phase === "starting") {
    progressLabel = "Starting…";
  }

  let dropHint = "More angles usually means a better result.";
  if (isDragReject) {
    dropHint = "Only image files are accepted.";
  } else if (tooManyPhotos) {
    dropHint = `The limit is ${MAX_PHOTOS_PER_SPLAT}. Remove ${photos.length - MAX_PHOTOS_PER_SPLAT} to continue.`;
  }

  let previewGrid: React.ReactNode = null;
  if (photos.length > 0) {
    previewGrid = (
      // Measured for its width, which decides how many previews each row holds.
      <div ref={setPreviewArea} style={{ minHeight: previewAreaHeight }}>
        <ul className="flex flex-wrap gap-2">
          {tiles.map(tile => {
            const { photo, url } = previews[tile.index - start];
            const key = fileKey(photo.file);

            // An uploaded photo is already on the server, and removing it here wouldn't take it off, so it can't be
            // removed. Discarding the splat is the way to drop it.
            let corner: React.ReactNode;
            if (uploadedKeys.has(key)) {
              corner = (
                <span
                  role="img"
                  aria-label={`${photo.file.name} uploaded`}
                  className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-paper text-success"
                >
                  <PhotoUploadedIcon aria-hidden="true" className="h-3 w-3" />
                </span>
              );
            } else {
              corner = (
                <button
                  type="button"
                  aria-label={`Remove ${photo.file.name}`}
                  onClick={() => removeFiles([key])}
                  disabled={submitting}
                  className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-paper text-foreground disabled:hidden"
                >
                  <RemovePhotoIcon aria-hidden="true" className="h-3 w-3" />
                </button>
              );
            }

            const flag = uploadedKeys.has(key) ? undefined : flagged.get(key);
            let flagBadge: React.ReactNode = null;
            if (flag !== undefined) {
              flagBadge = <FlagBadge filename={photo.file.name} flag={flag} />;
            }

            return (
              <li
                key={key}
                style={{ width: tile.width, height: tile.height }}
                className={cn(
                  "relative shrink-0 overflow-hidden rounded-xl bg-muted",
                  flag && "outline-2 outline-error outline-dashed -outline-offset-2",
                )}
              >
                {/* Shows until the photo decodes and covers it. The photo is relative so it paints above this icon. */}
                <PhotoPlaceholderIcon
                  aria-hidden="true"
                  strokeWidth={1}
                  className="absolute inset-0 m-auto h-6 w-6 text-muted-foreground"
                />
                {/* biome-ignore lint/performance/noImgElement: a local object URL, not something next/image can optimize. */}
                <img src={url} alt={photo.file.name} className="relative h-full w-full object-cover" />
                {flagBadge}
                {corner}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  let flaggedNote: React.ReactNode = null;
  if (removableFlagged.length > 0 && !submitting) {
    flaggedNote = (
      <span className="text-sm text-error">
        {removableFlagged.length} photo{removableFlagged.length === 1 ? " looks" : "s look"} blurry or low resolution.{" "}
        <button type="button" onClick={() => removeFiles(removableFlagged)} className="font-semibold underline">
          Remove {removableFlagged.length === 1 ? "it" : "them"}
        </button>
      </span>
    );
  }

  let pausedNotice: React.ReactNode = null;
  let idleHint = "Next, we'll place the cameras and show you a sketch of the shape to check.";
  if (processingPaused) {
    pausedNotice = (
      <ProcessingPausedNotice>
        Processing is paused for the whole site. You can still create a splat and upload photos, but it can&apos;t be
        processed until processing is turned back on.
      </ProcessingPausedNotice>
    );
    idleHint = "Your splat will wait on its page until processing is turned back on.";
  }

  let previewPager: React.ReactNode = null;
  if (pageCount > 1) {
    previewPager = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {start + 1}–{end} of {photos.length}
        </span>
        <Pager label="Photo pages" current={currentPage} count={pageCount} onChange={setPage} />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 flex-col gap-6">
      {pausedNotice}
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
          photos.length === 0 && "min-h-72 justify-center",
          isDragReject ? "border-error" : isDragAccept ? "border-primary" : "border-divider",
        )}
      >
        <input {...getInputProps()} aria-label="Photos" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold">
              {photos.length === 0
                ? "Drop your photos here"
                : `${photos.length} photo${photos.length === 1 ? "" : "s"} added`}
            </span>
            <span className={cn("text-sm", tooManyPhotos ? "text-error" : "text-muted-foreground")}>{dropHint}</span>
            {flaggedNote}
          </div>
          <div className="flex items-center gap-3">
            <PhotoMeter count={photos.length} />
            <Button variant="outlined" onClick={open} disabled={submitting}>
              Browse files
            </Button>
          </div>
        </div>
        {previewGrid}
        {previewPager}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="submit"
          variant="contained"
          size="large"
          loading={submitting || measuring}
          disabled={name.trim().length === 0 || photos.length === 0 || tooManyPhotos}
        >
          {processingPaused ? "Upload" : "Upload and start"}
        </Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {progressLabel ?? idleHint}
        </span>
      </div>
    </form>
  );
}
