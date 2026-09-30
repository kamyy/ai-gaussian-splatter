/**
 * The header's button that switches between light and dark mode.
 *
 * It shows the icon for the mode a click switches to, not the current mode: a moon in light mode ("turn dark on") and a
 * sun in dark mode ("turn dark off"). next-themes stores the choice and sets the data-theme attribute that
 * web/app/globals.css reads.
 */

"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { DarkThemeIcon, LightThemeIcon } from "@/components/ui/icons";

/**
 * The server can't know the visitor's theme, so the first client render has to match the server's "light" (the :root
 * default in web/app/globals.css) or React reports a hydration mismatch. next-themes already knows resolvedTheme on
 * that first client render, so it is only trusted once the component has mounted.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const mode = mounted ? (resolvedTheme ?? "light") : "light";
  const nextMode = mode === "dark" ? "light" : "dark";
  const Icon = mode === "dark" ? LightThemeIcon : DarkThemeIcon;

  return (
    <button
      type="button"
      aria-label={`Switch to ${nextMode} mode`}
      onClick={() => setTheme(nextMode)}
      className="inline-flex h-10 w-10 items-center justify-center pointer-coarse:h-11 pointer-coarse:w-11 rounded-full border border-outline transition-colors hover:border-muted-foreground hover:bg-muted"
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}
