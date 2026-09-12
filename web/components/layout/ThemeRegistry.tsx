"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";

import { theme } from "@/theme";

// A dedicated client component, not just <ThemeProvider theme={theme}> inline in the (Server Component) root layout:
// passing the theme object itself as a prop from a Server Component crosses the RSC boundary carrying functions
// (theme.breakpoints.up, etc.), which Next refuses to serialize. Importing theme here, inside the client bundle,
// avoids that entirely.
export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterCacheProvider options={{ key: "mui" }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
