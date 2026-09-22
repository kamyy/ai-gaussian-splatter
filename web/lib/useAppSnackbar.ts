"use client";

import type { SnackbarKey, SnackbarMessage, VariantType } from "notistack";
import { useSnackbar as useNotistackSnackbar } from "notistack";
import { useCallback } from "react";

// `progress` is not one of notistack's own options. Declaring it here is what lets a caller pass it, and the snack
// then carries it through to AlertSnackbar.
declare module "notistack" {
  interface VariantOverrides {
    info: {
      progress?: boolean;
    };
  }
}

interface AppSnackbarOptions {
  variant: VariantType;
  persist?: boolean;
  key?: SnackbarKey;
  // notistack adds a second entry when enqueueSnackbar is called again with the same key. Callers that reuse a key
  // (web/components/job/JobStatusSnackbar.tsx's failure snackbar) pass this so the repeat is dropped.
  preventDuplicate?: boolean;
  // Set on a snackbar that reports an in-progress job stage. AlertSnackbar then shows a spinner in place of the
  // variant icon.
  progress?: boolean;
}

// Wraps notistack's useSnackbar so this one dismiss policy holds everywhere instead of each call site having to
// remember it: an error always persists until the visitor closes it (the close button AlertSnackbar's underlying
// MUI Alert renders automatically once it's given an onClose), no matter what the caller passes. Every other
// variant times out on its own unless that caller explicitly asks it to persist too — e.g.
// web/components/job/JobStatusSnackbar.tsx, which persists a non-error status deliberately because it tracks an
// ongoing job stage, not a one-off event.
export function useAppSnackbar() {
  const { enqueueSnackbar, closeSnackbar } = useNotistackSnackbar();

  const enqueue = useCallback(
    (message: SnackbarMessage, options: AppSnackbarOptions) =>
      enqueueSnackbar(message, { ...options, persist: options.variant === "error" ? true : options.persist }),
    [enqueueSnackbar],
  );

  return { enqueueSnackbar: enqueue, closeSnackbar };
}
