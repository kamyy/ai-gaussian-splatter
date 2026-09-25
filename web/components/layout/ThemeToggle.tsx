"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

// Inline rather than an icon library dependency.
const ICON_PROPS = {
  width: "16",
  height: "16",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
} as const;

function SunIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS} strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

// Shows the icon for the mode a click switches to, not the current one — a moon in light mode ("turn dark on"), a
// sun in dark mode ("turn dark off"). Rendered by web/components/layout/SiteHeader.tsx, the one header every page shares.
//
// The server can't know the visitor's theme, so the first client render has to match the server's "light" (web/app/
// globals.css's :root default) or React reports a hydration mismatch. next-themes already knows resolvedTheme on that
// first client render, so it is only trusted once mounted.
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const mode = mounted ? (resolvedTheme ?? "light") : "light";
  const nextMode = mode === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      aria-label={`Switch to ${nextMode} mode`}
      onClick={() => setTheme(nextMode)}
      className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-divider hover:bg-muted"
    >
      {mode === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
