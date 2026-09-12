import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";

import { ThemeRegistry } from "@/components/layout/ThemeRegistry";

export const metadata: Metadata = {
  title: "AI Gaussian Splatter",
  description: "Convert multi-angle photos of a physical object into a real-time 3D Gaussian Splat.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ThemeRegistry>
          <ClerkProvider
            localization={{
              // Clerk's default sign-in header ("Sign in to ai-gaussian-splatter") uses the instance's raw
              // kebab-case application name from the Clerk dashboard, not this app's display name.
              // title/titleCombined cover both the separate-pages flow this app uses and Clerk's combined
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
