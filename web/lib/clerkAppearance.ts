// Best-effort mapping onto Clerk's `appearance.variables` API (https://clerk.com/docs/customization/appearance),
// pointed at web/app/globals.css's own Contact Sheet CSS variables instead of copied hex, so a token edit there
// can't desync Clerk's colors from the rest of the app. Plain var() references, not a function of the current mode:
// the browser resolves them against whichever [data-theme] is active, the same way every other themed element in
// the app does. The installed @clerk/nextjs version's own types leave `appearance` typed `any` (the Clerk MCP was
// unavailable to confirm the exact shape against this version), so this needs a live check in the browser, in both
// modes, rather than one tsc can catch.
export const clerkAppearanceVariables = {
  colorBackground: "var(--color-paper)",
  colorText: "var(--color-foreground)",
  colorTextSecondary: "var(--color-muted-foreground)",
  colorPrimary: "var(--color-primary)",
  colorInputBackground: "var(--color-background)",
  colorInputText: "var(--color-foreground)",
  colorDanger: "var(--color-error)",
  colorSuccess: "var(--color-success)",
  borderRadius: "0.125rem",
  fontFamily: "var(--font-body), Arial, Helvetica, sans-serif",
};
