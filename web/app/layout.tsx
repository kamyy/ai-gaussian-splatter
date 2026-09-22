import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter } from "next/font/google";

import { ThemeRegistry } from "@/components/layout/ThemeRegistry";

// Named for their role (display/body), not the specific family, so a future type change — like this one, which
// replaced the original serif Fraunces + Work Sans pairing — is a one-line swap here rather than a rename sweep
// across every file that references the CSS variable.
const displayFont = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display" });
const bodyFont = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "AI Gaussian Splatter",
  description: "Convert multi-angle photos of a physical object into a real-time 3D Gaussian Splat.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: InitColorSchemeScript below sets data-mui-color-scheme here before React hydrates,
    // so the attribute React finds on this element during hydration deliberately doesn't match what it rendered on
    // the server — the standard escape hatch for a color-mode bootstrap script.
    <html lang="en" suppressHydrationWarning>
      <body className={`${displayFont.variable} ${bodyFont.variable}`}>
        {/* Runs before hydration and sets [data-mui-color-scheme] from the stored preference or the OS setting, so
        web/theme.ts's CSS variables resolve to the right scheme on first paint with no flash. */}
        <InitColorSchemeScript />
        <ThemeRegistry>
          <ClerkProvider
            localization={{
              // Clerk's default sign-in header ("Sign in to ai-gaussian-splatter") uses the instance's raw
              // kebab-case application name from the Clerk dashboard, not a human-readable one.
              // title/titleCombined cover both the separate sign-in/sign-up pages and Clerk's combined
              // sign-in/sign-up variant, in case that's ever enabled.
              signIn: {
                start: {
                  title: "Sign in to AI Gaussian Splatter",
                  titleCombined: "Sign in to AI Gaussian Splatter",
                },
              },
            }}
          >
            {children}
          </ClerkProvider>
        </ThemeRegistry>
      </body>
    </html>
  );
}
