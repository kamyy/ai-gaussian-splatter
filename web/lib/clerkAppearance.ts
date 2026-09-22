import { BODY_FONT, theme } from "@/theme";

// Best-effort mapping onto Clerk's `appearance.variables` API (https://clerk.com/docs/customization/appearance),
// pointed at web/theme.ts's own generated CSS variables instead of copied hex, so a palette edit there can't desync
// Clerk's colors from the rest of the app. Plain var() references, not a function of the current mode: the browser
// resolves them against whichever [data-mui-color-scheme] is active, the same way every other themed element in the
// app does. The installed @clerk/nextjs version's own types leave `appearance` typed `any` (the Clerk MCP was
// unavailable to confirm the exact shape against this version), so this needs a live check in the browser, in both
// modes, rather than one tsc can catch.
export const clerkAppearanceVariables = {
  colorBackground: theme.vars.palette.background.paper,
  colorText: theme.vars.palette.text.primary,
  colorTextSecondary: theme.vars.palette.text.secondary,
  colorPrimary: theme.vars.palette.primary.main,
  colorInputBackground: theme.vars.palette.background.default,
  colorInputText: theme.vars.palette.text.primary,
  colorDanger: theme.vars.palette.error.main,
  colorSuccess: theme.vars.palette.success.main,
  borderRadius: "0.125rem",
  fontFamily: BODY_FONT,
};
