import "@mantine/core/styles.css";
import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
// AppShellMain (standalone) rather than AppShell.Main — see the note in AGENTS.md about compound static properties not
// resolving through the bundler in this @mantine/core version.
import { AppShell, AppShellMain, ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import type { Metadata } from "next";

import { SiteHeader } from "@/components/layout/SiteHeader";

export const metadata: Metadata = {
  title: "AI Gaussian Splatter",
  description: "Turn multi-angle photos of an object into a real-time 3D Gaussian Splat.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" {...mantineHtmlProps}>
        <head>
          <ColorSchemeScript />
        </head>
        <body>
          <MantineProvider defaultColorScheme="dark">
            <AppShell header={{ height: 60 }} padding="md">
              <SiteHeader />
              <AppShellMain>{children}</AppShellMain>
            </AppShell>
          </MantineProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
