import { createTheme } from "@mui/material/styles";

// This app is dark-mode-only with no light/dark toggle, so a single static theme is enough.
// spacing is overridden to emit rem instead of MUI's px default so layout still scales with the
// browser's root font-size / zoom setting, matching MUI's default 8px-per-unit scale.
export const theme = createTheme({
  palette: { mode: "dark" },
  typography: { fontFamily: "Arial, Helvetica, sans-serif" },
  spacing: (factor: number) => `${factor * 0.5}rem`,
});
