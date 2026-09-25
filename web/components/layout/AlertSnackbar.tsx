"use client";

import type { CustomContentProps } from "notistack";
import { closeSnackbar } from "notistack";
import { forwardRef } from "react";

import { cn } from "@/lib/cn";

const VARIANT_COLOR = {
  default: "border-info text-info",
  success: "border-success text-success",
  error: "border-error text-error",
  warning: "border-primary text-primary",
  info: "border-info text-info",
} as const;

// Registered on every variant in the SnackbarProvider (web/components/layout/ThemeRegistry.tsx) `Components` prop, so
// `enqueueSnackbar(message, { variant })` renders as this component instead of notistack's own default snackbar chrome
// — keeps every status/error message in the app the same component the rest of the UI already uses for them.
export const AlertSnackbar = forwardRef<HTMLDivElement, CustomContentProps>(function AlertSnackbar(
  { message, variant, id },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex w-full max-w-90 items-center gap-2 rounded-2xl border bg-paper px-4 py-3 text-sm text-foreground",
        VARIANT_COLOR[variant],
      )}
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        aria-label="Close"
        onClick={() => closeSnackbar(id)}
        className="shrink-0 text-lg leading-none"
      >
        ×
      </button>
    </div>
  );
});
