/**
 * How one snackbar (toast message) looks.
 *
 * notistack is the library that stacks toast messages in the corner of the screen. This component replaces its default
 * look with the app's own: a card tinted with its variant's color, an icon, a title, an optional line of detail under
 * it, and a close button.
 */

"use client";

import { type CustomContentProps, closeSnackbar } from "notistack";
import { forwardRef } from "react";

import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "@/components/ui/icons";
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

// --tone is the variant's color, which the card's tint, border and icon all read.
const VARIANT_TONE = {
  default: { Icon: InfoIcon, tone: "[--tone:var(--color-info)]" },
  success: { Icon: SuccessIcon, tone: "[--tone:var(--color-success)]" },
  error: { Icon: ErrorIcon, tone: "[--tone:var(--color-error)]" },
  warning: { Icon: WarningIcon, tone: "[--tone:var(--color-primary)]" },
  info: { Icon: InfoIcon, tone: "[--tone:var(--color-info)]" },
} as const;

/**
 * Registered on every variant in the SnackbarProvider `Components` prop
 * (web/components/layout/AppSnackbarProvider.tsx), so `enqueueSnackbar(title, { variant, detail })` renders this
 * component instead of notistack's default snackbar.
 */
export const AlertSnackbar = forwardRef<HTMLDivElement, CustomContentProps & { detail?: string }>(
  function AlertSnackbar({ message, variant, detail, id }, ref) {
    const { Icon, tone } = VARIANT_TONE[variant];

    let detailLine: React.ReactNode = null;
    // An error response with an empty body gives an empty message, which would otherwise render as a blank line.
    if (detail) {
      detailLine = <p className="text-sm text-muted-foreground">{detail}</p>;
    }

    // The tint is mixed into the paper color rather than laid over it as a translucent fill. A toast can sit over the
    // 3D viewer, which would otherwise show through.
    return (
      <div
        ref={ref}
        className={cn(
          "flex w-full max-w-90 items-center gap-3 rounded-xl border border-(--tone)/30 bg-[color-mix(in_srgb,var(--tone)_10%,var(--color-paper))] py-1 pr-1 pl-3.5 text-foreground shadow-md",
          tone,
        )}
      >
        <Icon className="h-5 w-5 shrink-0 text-(--tone)" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col py-2.5">
          <p className="text-sm font-medium">{message}</p>
          {detailLine}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeSnackbar(id)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:text-foreground"
        >
          <CloseIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  },
);
