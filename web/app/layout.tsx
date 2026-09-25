import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";

import { ThemeRegistry } from "@/components/layout/ThemeRegistry";

// Named for their role (display/body), not the specific family, so a type change is a one-line swap here rather than a
// rename sweep across every file that references the CSS variable. Instrument Serif ships a single weight, so display
// text gets its emphasis from the italic style rather than from font-weight.
const displayFont = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
});
const bodyFont = Manrope({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "AI Gaussian Splatter",
  description: "Convert multi-angle photos of a physical object into a real-time 3D Gaussian Splat.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: next-themes (inside ThemeRegistry) sets [data-theme] on this element before React
    // hydrates. The attribute React finds during hydration therefore doesn't match what the server rendered, on
    // purpose. This is the standard escape hatch for a script that sets the color mode before hydration.
    <html lang="en" suppressHydrationWarning>
      <body className={`${displayFont.variable} ${bodyFont.variable}`}>
        <ThemeRegistry>
          <ClerkProvider
            localization={{
              // Clerk's default sign-in header ("Sign in to ai-gaussian-splatter") uses the instance's raw kebab-case
              // application name from the Clerk dashboard, not a human-readable one. title/titleCombined cover both the
              // separate sign-in/sign-up pages and Clerk's combined sign-in/sign-up variant, in case that's ever
              // enabled.
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
