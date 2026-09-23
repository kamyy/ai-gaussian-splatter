"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider as MuiThemeProvider } from "@mui/material/styles";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { ThemeProvider as NextThemesProvider } from "next-themes";
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
//
// This is the AI Gaussian Splatter → Tailwind migration's mid-flight state: MUI's ThemeProvider still drives every
// component that hasn't moved to Tailwind yet, while NextThemesProvider independently sets [data-theme] for the
// components that have. web/components/layout/ThemeToggle.tsx drives both from one click so the two attributes never
// disagree. Once every component has moved, this collapses down to just NextThemesProvider + SnackbarProvider.
export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <AppRouterCacheProvider options={{ key: "mui" }}>
        <MuiThemeProvider theme={theme} defaultMode="system" disableTransitionOnChange>
          <CssBaseline />
          <TooltipProvider delayDuration={200}>
            <SnackbarProvider
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              Components={SNACKBAR_COMPONENTS}
            >
              {children}
            </SnackbarProvider>
          </TooltipProvider>
        </MuiThemeProvider>
      </AppRouterCacheProvider>
    </NextThemesProvider>
  );
}
