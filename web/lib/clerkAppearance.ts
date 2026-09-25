// Maps the app's theme onto Clerk's `appearance.variables` API (https://clerk.com/docs/customization/appearance) as
// closely as that API allows. The values point at web/app/globals.css's own color tokens instead of copied hex codes,
// so editing a token there also changes Clerk's colors. They are plain var() references rather than values computed per
// mode. The browser resolves them against whichever [data-theme] is active, like every other themed element in the app.
// The installed @clerk/nextjs types `appearance` as `any`, so tsc can't catch a wrong key here. Check a change in the
// browser, in both light and dark mode.
export const clerkAppearanceVariables = {
  colorBackground: "var(--color-paper)",
  colorText: "var(--color-foreground)",
  colorTextSecondary: "var(--color-muted-foreground)",
  colorPrimary: "var(--color-primary)",
  colorInputBackground: "var(--color-background)",
  colorInputText: "var(--color-foreground)",
  colorDanger: "var(--color-error)",
  colorSuccess: "var(--color-success)",
  borderRadius: "0.75rem",
  fontFamily: "var(--font-body), Arial, Helvetica, sans-serif",
};
