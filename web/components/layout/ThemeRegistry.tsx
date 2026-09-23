"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { SnackbarProvider } from "notistack";

import { AlertSnackbar } from "@/components/layout/AlertSnackbar";
import { TooltipProvider } from "@/components/ui/Tooltip";

// Every status/error message in the app (job failures, upload/processing failures, etc.) goes through this one
// stack instead of its own inline Alert, so there's one consistent place they appear.
const SNACKBAR_COMPONENTS = {
  default: AlertSnackbar,
  success: AlertSnackbar,
  error: AlertSnackbar,
  warning: AlertSnackbar,
  info: AlertSnackbar,
};

// A dedicated client component so web/app/layout.tsx (a Server Component) doesn't need "use client" itself.
export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={200}>
        <SnackbarProvider anchorOrigin={{ vertical: "bottom", horizontal: "left" }} Components={SNACKBAR_COMPONENTS}>
          {children}
        </SnackbarProvider>
      </TooltipProvider>
    </NextThemesProvider>
  );
}
