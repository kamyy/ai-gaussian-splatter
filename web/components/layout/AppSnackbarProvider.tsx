/**
 * The provider behind every snackbar (toast message) in the app.
 *
 * Every status and error message (worker-job failures, upload failures, and the like) goes through one stack instead
 * of an inline alert of its own, so there's one consistent place they appear. Components post to it with notistack's
 * useSnackbar. notistack doesn't ship "use client", so web/app/layout.tsx, a Server Component, renders this wrapper
 * instead of notistack's provider directly.
 */

"use client";

import { SnackbarProvider } from "notistack";

import { AlertSnackbar } from "@/components/layout/AlertSnackbar";

const SNACKBAR_COMPONENTS = {
  default: AlertSnackbar,
  success: AlertSnackbar,
  error: AlertSnackbar,
  warning: AlertSnackbar,
  info: AlertSnackbar,
};

export function AppSnackbarProvider({ children }: { children: React.ReactNode }) {
  return (
    <SnackbarProvider anchorOrigin={{ vertical: "bottom", horizontal: "left" }} Components={SNACKBAR_COMPONENTS}>
      {children}
    </SnackbarProvider>
  );
}
