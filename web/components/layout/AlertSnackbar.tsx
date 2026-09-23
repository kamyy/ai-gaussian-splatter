"use client";

import type { CustomContentProps } from "notistack";
import { closeSnackbar } from "notistack";
import { forwardRef } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

const VARIANT_COLOR = {
  default: "border-info text-info",
  success: "border-success text-success",
  error: "border-error text-error",
  warning: "border-primary text-primary",
  info: "border-info text-info",
} as const;

type AlertSnackbarProps = CustomContentProps & { progress?: boolean };

// Registered on every variant in the SnackbarProvider (web/components/layout/ThemeRegistry.tsx) `Components` prop,
// so `enqueueSnackbar(message, { variant })` renders as this component instead of notistack's own default snackbar
// chrome — keeps every status/error message in the app the same component the rest of the UI already uses for them.
export const AlertSnackbar = forwardRef<HTMLDivElement, AlertSnackbarProps>(function AlertSnackbar(
  { message, variant, progress, id },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex w-full max-w-[22.5rem] items-center gap-2 border bg-paper px-3 py-2 text-sm text-foreground",
        VARIANT_COLOR[variant],
      )}
    >
      {progress && (
        <>
          <Spinner className="h-4 w-4 shrink-0" />
          <span className="sr-only">In progress</span>
        </>
      )}
      <span className="flex-1">{message}</span>
      {/* Only rendered without `progress`: a progress snack (an ongoing job stage, persist: true) has no close
      button, since dismissing it would leave no in-progress UI for the rest of that stage — JobStatusSnackbar's
      effect only re-enqueues when the stage itself changes, and the closed floating card this replaced could not be
      dismissed either. */}
      {!progress && (
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeSnackbar(id)}
          className="shrink-0 text-lg leading-none"
        >
          ×
        </button>
      )}
    </div>
  );
});
