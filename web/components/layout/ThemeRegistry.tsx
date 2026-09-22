"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import { SnackbarProvider } from "notistack";

import { AlertSnackbar } from "@/components/layout/AlertSnackbar";
import { theme } from "@/theme";

// Every status/error message in the app (job failures, upload/processing failures, etc.) goes through this one
// stack instead of its own inline Alert, so there's one consistent place they appear.
const SNACKBAR_COMPONENTS = {
  default: AlertSnackbar,
  success: AlertSnackbar,
  error: AlertSnackbar,
  warning: AlertSnackbar,
  info: AlertSnackbar,
};

// A dedicated client component, not just <ThemeProvider theme={theme}> inline in the (Server Component) root layout:
// passing the theme object itself as a prop from a Server Component crosses the RSC boundary carrying functions
// (theme.breakpoints.up, etc.), which Next refuses to serialize. Building the provider tree here, inside the client
// bundle, avoids that entirely.
//
// modeStorageKey/colorSchemeStorageKey are left at MUI's own defaults, which is what web/app/layout.tsx's
// <InitColorSchemeScript /> and web/theme.ts's colorSchemeSelector both already assume.
export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterCacheProvider options={{ key: "mui" }}>
      <ThemeProvider theme={theme} defaultMode="system" disableTransitionOnChange>
        <CssBaseline />
        <SnackbarProvider anchorOrigin={{ vertical: "bottom", horizontal: "left" }} Components={SNACKBAR_COMPONENTS}>
          {children}
        </SnackbarProvider>
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
