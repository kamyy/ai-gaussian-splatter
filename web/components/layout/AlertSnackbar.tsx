"use client";

import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import type { CustomContentProps } from "notistack";
import { closeSnackbar } from "notistack";
import { forwardRef } from "react";

import { rem } from "@/lib/rem";

const VARIANT_SEVERITY = {
  default: "info",
  success: "success",
  error: "error",
  warning: "warning",
  info: "info",
} as const;

type AlertSnackbarProps = CustomContentProps & { progress?: boolean };

// Registered on every variant in the SnackbarProvider (web/components/layout/ThemeRegistry.tsx) `Components` prop,
// so `enqueueSnackbar(message, { variant })` renders as a real MUI Alert instead of notistack's own default
// snackbar chrome — keeps every status/error message in the app the same component the rest of the UI already
// uses for them.
export const AlertSnackbar = forwardRef<HTMLDivElement, AlertSnackbarProps>(function AlertSnackbar(
  { id, message, variant, progress },
  ref,
) {
  return (
    <Alert
      ref={ref}
      severity={VARIANT_SEVERITY[variant]}
      icon={progress ? <CircularProgress size={rem(22)} color="inherit" aria-label="In progress" /> : undefined}
      // Alert only renders its close button once given an onClose, so a progress snack (an ongoing job stage,
      // persist: true) gets none: dismissing it would leave no in-progress UI for the rest of that stage, since
      // JobStatusSnackbar's effect only re-enqueues when the stage itself changes, and the closed floating card
      // this replaced could not be dismissed either.
      onClose={progress ? undefined : () => closeSnackbar(id)}
      sx={{ width: "100%", maxWidth: rem(360) }}
    >
      {message}
    </Alert>
  );
});
