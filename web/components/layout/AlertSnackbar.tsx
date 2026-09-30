/**
 * How one snackbar (toast message) looks.
 *
 * notistack is the library that stacks toast messages in the corner of the screen. This component replaces its default
 * look with the app's own: a raised card with an icon colored for its variant, a title in the display font, an
 * optional line of detail under it, and a close button.
 */

"use client";

import { type CustomContentProps, closeSnackbar } from "notistack";
import { forwardRef } from "react";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuTriangleAlert, LuX } from "react-icons/lu";

import { cn } from "@/lib/cn";

// Lets every variant's enqueueSnackbar options carry `detail`, which notistack hands to this component as a prop.
declare module "notistack" {
  interface VariantOverrides {
    default: { detail?: string };
    success: { detail?: string };
    error: { detail?: string };
    warning: { detail?: string };
    info: { detail?: string };
  }
}

const VARIANT_ICON = {
  default: { Icon: LuInfo, className: "bg-info/15 text-info" },
  success: { Icon: LuCircleCheck, className: "bg-success/15 text-success" },
  error: { Icon: LuCircleAlert, className: "bg-error/15 text-error" },
  warning: { Icon: LuTriangleAlert, className: "bg-primary/15 text-primary" },
  info: { Icon: LuInfo, className: "bg-info/15 text-info" },
} as const;

/**
 * Registered on every variant in the SnackbarProvider `Components` prop
 * (web/components/layout/AppSnackbarProvider.tsx), so `enqueueSnackbar(title, { variant, detail })` renders this
 * component instead of notistack's default snackbar.
 */
export const AlertSnackbar = forwardRef<HTMLDivElement, CustomContentProps & { detail?: string }>(
  function AlertSnackbar({ message, variant, detail, id }, ref) {
    const { Icon, className: iconClassName } = VARIANT_ICON[variant];

    let detailLine: React.ReactNode = null;
    // An error response with an empty body gives an empty message, which would otherwise render as a blank line.
    if (detail) {
      detailLine = <p className="text-sm leading-snug text-muted-foreground">{detail}</p>;
    }

    return (
      <div
        ref={ref}
        className="raised flex w-full max-w-90 items-start gap-3 rounded-2xl bg-paper py-3.5 pr-1 pl-3.5 text-foreground"
      >
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", iconClassName)}>
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <p className="font-display text-xl leading-tight">{message}</p>
          {detailLine}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeSnackbar(id)}
          className="-mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:text-foreground"
        >
          <LuX className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  },
);
