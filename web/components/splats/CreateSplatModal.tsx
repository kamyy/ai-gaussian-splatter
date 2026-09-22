"use client";

import { useAuth } from "@clerk/nextjs";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { mutate } from "swr";

import { UploadProgress } from "@/components/upload/UploadProgress";
import { apiFetch } from "@/lib/apiFetch";
import { rem } from "@/lib/rem";
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
  // Set once the POST below succeeds, so a retry after a photo-upload failure reuses this splat instead of
  // creating a second one.
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

      // The splat now exists server-side no matter what happens below, so the carousel must show it, and a retry
      // click reuses it via createdSplat above instead of re-POSTing a duplicate.
      setCreatedSplat(splat);
      await mutate("splats");
    }

    try {
      if (files.length > 0) {
        await uploadPhotos(splat.id, files, token);
        // The earlier mutate("splats") above ran before any photo existed, so the sidebar card still shows no
        // thumbnail/"Photos" chip without this. The photos key also needs its own revalidation: PhotoFilmstrip
        // (web/components/splats/PhotoFilmstrip.tsx) can already be mounted for this splat by the time upload
        // finishes, since a first-ever splat's creation retargets web/app/(authenticated)/splats/page.tsx's redirect
        // as soon as the splat row exists, well before its photos do.
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
    <Dialog open={opened} onClose={handleClose} fullWidth>
      <DialogTitle>Create new splat</DialogTitle>
      {/* MUI zeros DialogContent's padding-top when it follows DialogTitle (`.MuiDialogTitle-root + &`), which
      clips the outlined TextField's floating "Name" label. A plain `pt` loses that selector; `&&` is enough to
      restore the notch. */}
      <DialogContent sx={{ "&&": { pt: 1.5 } }}>
        <Stack spacing={2}>
          <TextField
            label="Name"
            placeholder="e.g. Coffee mug"
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus
            fullWidth
          />
          <Box
            {...getRootProps()}
            sx={{
              border: "1px dashed",
              borderColor: isDragReject ? "error.main" : "divider",
              borderRadius: 1,
              p: 3,
              textAlign: "center",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            <input {...getInputProps()} />
            <Stack sx={{ minHeight: rem(100), justifyContent: "center", pointerEvents: "none" }}>
              {isDragReject ? (
                <Typography variant="body2" color="error">
                  Only image files are accepted
                </Typography>
              ) : isDragAccept ? (
                <Typography variant="body2">Drop photos here</Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Drag photos here, or click to select files — optional now, but this is the only chance to add them
                </Typography>
              )}
            </Stack>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {files.length} photo{files.length === 1 ? "" : "s"} selected
          </Typography>
          <UploadProgress />
          <Button onClick={handleCreate} disabled={name.trim().length === 0 || submitting} loading={submitting}>
            Create
          </Button>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
