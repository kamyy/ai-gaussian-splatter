import { createTheme } from "@mui/material/styles";

// `theme.vars` is typed optional by default (MUI supports both vars and no-vars themes from one API). This app only
// ever builds the vars-enabled theme below, so this augmentation makes `.vars` non-optional everywhere instead of
// requiring a null check at every read.
declare module "@mui/material/styles" {
  interface CssThemeVariables {
    enabled: true;
  }
}

// "Contact Sheet": an analog-darkroom identity for a tool that turns multi-angle photos into a 3D Gaussian Splat.
// Flat print motif (zero border radius everywhere except the button's slight 2px), a bold sans display face for
// headings, italic status chips instead of filled pills, and an underline-tab sub-nav — all carried by the two
// color-scheme palettes below rather than per-page styling. Light reuses the dark mode's parchment/mat accent tones
// as its base surface colors, since a contact sheet is physically a print on light photo paper.
interface ContactSheetTokens {
  background: { default: string; paper: string };
  divider: string;
  text: { primary: string; secondary: string };
  primary: { main: string; contrastText: string };
  success: string;
  error: string;
  info: string;
}

export const darkTokens: ContactSheetTokens = {
  background: { default: "#2B2119", paper: "#362A20" },
  divider: "#4F3C2E",
  text: { primary: "#F2E9DE", secondary: "#A69485" },
  primary: { main: "#D99A45", contrastText: "#241A12" },
  success: "#7C9A6B",
  error: "#B33A2E",
  info: "#6F91B3",
};

export const lightTokens: ContactSheetTokens = {
  background: { default: "#F2E9DA", paper: "#FBF6EC" },
  divider: "#D9CBB8",
  text: { primary: "#2B2018", secondary: "#7A6A5A" },
  primary: { main: "#B5602E", contrastText: "#FBF6EC" },
  success: "#4F7A44",
  error: "#A13327",
  info: "#3D6690",
};

// web/app/layout.tsx loads both families via next/font/google with these exact variable names.
const DISPLAY_FONT = "var(--font-display), Arial, Helvetica, sans-serif";
export const BODY_FONT = "var(--font-body), Arial, Helvetica, sans-serif";

function tokensToPalette(tokens: ContactSheetTokens) {
  return {
    background: tokens.background,
    divider: tokens.divider,
    text: tokens.text,
    primary: tokens.primary,
    success: { main: tokens.success },
    error: { main: tokens.error },
    info: { main: tokens.info },
  };
}

// One CSS-variables theme instead of a per-mode createTheme() call: MUI generates both palettes into a single static
// stylesheet and swaps them via the [data-mui-color-scheme] attribute (web/app/layout.tsx's InitColorSchemeScript
// sets it before paint; colorSchemeSelector here is what tells MUI to key off that attribute instead of its default
// media-query strategy), so switching modes needs neither a React re-render nor a second theme instance.
// defaultColorScheme is "dark" so a visitor with JS disabled, who never gets the attribute set, still gets this
// app's usual default rather than MUI's own "light".
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "data-mui-color-scheme" },
  defaultColorScheme: "dark",
  colorSchemes: {
    dark: { palette: tokensToPalette(darkTokens) },
    light: { palette: tokensToPalette(lightTokens) },
  },
  // Emits rem instead of MUI's px default so layout still scales with the browser's root font-size/zoom setting.
  spacing: (factor: number) => `${factor * 0.5}rem`,
  shape: { borderRadius: 0 },
  typography: {
    fontFamily: BODY_FONT,
    h1: { fontFamily: DISPLAY_FONT },
    h2: { fontFamily: DISPLAY_FONT },
    h3: { fontFamily: DISPLAY_FONT },
    h4: { fontFamily: DISPLAY_FONT },
    h5: { fontFamily: DISPLAY_FONT },
    h6: { fontFamily: DISPLAY_FONT },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          borderRadius: 2,
          // A touch shorter than MUI's own 6px/16px default. Only takes effect on a contained button (the only
          // variant this app uses `Button` with): the outlined/text variants define their own padding later in
          // MUI's own style pipeline, which wins over this root override for those two.
          padding: "0.25rem 1rem",
          // MUI's own default (64px) is unrelated to any label used in this app; this shrinks the floor
          // a short label like "Create" gets padded out to.
          minWidth: "2.5rem",
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          backgroundColor: "transparent",
          fontStyle: "italic",
          fontWeight: 400,
        },
        colorDefault: ({ theme }) => ({ backgroundColor: "transparent", color: theme.vars.palette.text.secondary }),
        colorPrimary: ({ theme }) => ({ backgroundColor: "transparent", color: theme.vars.palette.primary.main }),
        colorSuccess: ({ theme }) => ({ backgroundColor: "transparent", color: theme.vars.palette.success.main }),
        colorError: ({ theme }) => ({ backgroundColor: "transparent", color: theme.vars.palette.error.main }),
        colorInfo: ({ theme }) => ({ backgroundColor: "transparent", color: theme.vars.palette.info.main }),
      },
    },
    // Strips the default connected-segment look (shared border, filled selected background) so a two-item group
    // like web/components/splats/SplatSubNav.tsx reads as underline tabs instead. `grouped` alone doesn't reach
    // this: MUI v9 applies the connected-edge border via separate firstButton/middleButton/lastButton slots
    // resolved inside the same styled root as its own default styles, which wins over a plain `grouped` override
    // at equal specificity — lastButton in particular ships a `1px solid transparent` left border (plus a -1px
    // margin) that has to be cancelled explicitly, not just re-hidden by color.
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: { gap: "1.25rem" },
        grouped: {
          border: "none",
          borderRadius: 0,
          marginLeft: 0,
        },
        middleButton: {
          borderLeft: "none",
          marginLeft: 0,
        },
        lastButton: {
          borderLeft: "none",
          marginLeft: 0,
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: "none",
          border: "none",
          borderRadius: 0,
          // MUI's own 11px padding is sized for a segment control, not a text tab. Keep a little extra on the
          // bottom so the ::after underline sits under the label instead of through it.
          padding: "0.125rem 0.25rem 0.375rem",
          position: "relative",
          color: theme.vars.palette.text.secondary,
          // The underline is a ::after bar, not border-bottom. MUI's own disabled/grouped rules use the
          // `border` shorthand, which resets every side and ate a 2px selected border even on an enabled
          // Point cloud tab (web/components/splats/SplatSubNav.tsx).
          "&.Mui-disabled": {
            border: "none",
          },
          "&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-disabled": {
            backgroundColor: "transparent",
            color: theme.vars.palette.text.primary,
            fontWeight: 600,
            "&::after": {
              content: '""',
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: "2px",
              backgroundColor: theme.vars.palette.primary.main,
            },
          },
        }),
      },
    },
  },
});
