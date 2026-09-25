"use client";

import type { SnackbarMessage, VariantType } from "notistack";
import { useSnackbar as useNotistackSnackbar } from "notistack";
import { useCallback } from "react";

interface AppSnackbarOptions {
  variant: VariantType;
}

// Wraps notistack's useSnackbar so one dismiss policy holds everywhere instead of each call site having to remember
// it: an error persists until the visitor closes it, and every other variant times out on its own.
export function useAppSnackbar() {
  const { enqueueSnackbar } = useNotistackSnackbar();

  const enqueue = useCallback(
    (message: SnackbarMessage, options: AppSnackbarOptions) =>
      enqueueSnackbar(message, { ...options, persist: options.variant === "error" }),
    [enqueueSnackbar],
  );

  return { enqueueSnackbar: enqueue };
}
