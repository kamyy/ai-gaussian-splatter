"use client";

import { SnackbarProvider } from "notistack";

import { AlertSnackbar } from "@/components/layout/AlertSnackbar";

// Every status/error message in the app (job failures, upload/processing failures, etc.) goes through this one
// stack instead of its own inline Alert, so there's one consistent place they appear.
const SNACKBAR_COMPONENTS = {
  default: AlertSnackbar,
  success: AlertSnackbar,
  error: AlertSnackbar,
  warning: AlertSnackbar,
  info: AlertSnackbar,
};

// notistack doesn't ship "use client", so web/app/layout.tsx (a Server Component) can't render it directly.
export function AppSnackbarProvider({ children }: { children: React.ReactNode }) {
  return (
    <SnackbarProvider anchorOrigin={{ vertical: "bottom", horizontal: "left" }} Components={SNACKBAR_COMPONENTS}>
      {children}
    </SnackbarProvider>
  );
}
