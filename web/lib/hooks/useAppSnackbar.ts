/**
 * Shows a snackbar (a toast message in the corner of the screen).
 *
 * Wraps notistack's useSnackbar so one dismiss policy holds everywhere instead of each call site having to remember it:
 * an error stays until the visitor closes it, and every other variant times out on its own.
 */

"use client";

import type { VariantType } from "notistack";
import { useSnackbar as useNotistackSnackbar } from "notistack";
import { useCallback } from "react";

interface AppSnackbarOptions {
  variant: VariantType;
  /** A line under the title, such as the server's error message. */
  detail?: string;
}

export function useAppSnackbar() {
  const { enqueueSnackbar } = useNotistackSnackbar();

  const enqueue = useCallback(
    (title: string, options: AppSnackbarOptions) =>
      enqueueSnackbar(title, { ...options, persist: options.variant === "error" }),
    [enqueueSnackbar],
  );

  return { enqueueSnackbar: enqueue };
}
