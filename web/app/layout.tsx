import "@mantine/core/styles.css";
import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import type { Metadata } from "next";

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
          <MantineProvider defaultColorScheme="dark">{children}</MantineProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
