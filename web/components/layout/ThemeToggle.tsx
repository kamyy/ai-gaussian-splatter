"use client";

import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";
import { useTheme } from "next-themes";

// Inline rather than an icon library dependency, matching web/components/layout/NavMenu.tsx's HomeIcon.
function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

// Shows the icon for the mode a click switches to, not the current one — a moon in light mode ("turn dark on"), a
// sun in dark mode ("turn dark off"). Placed beside the user avatar in both header chromes this app has:
// web/app/(public)/layout.tsx (signed-out hero, sign-in/up, the public share page) and
// web/components/layout/AuthHeader.tsx (the signed-in splat workspace).
//
// useColorScheme()'s mode/systemMode are undefined on the server and on the very first client render (its own
// hydration-safety guarantee), so this falls back to "dark" until that resolves, matching web/theme.ts's own
// defaultColorScheme.
//
// Drives both MUI's mode (still read by every component not yet migrated to Tailwind) and next-themes' theme (read
// by every component that has) from one click, so [data-mui-color-scheme] and [data-theme] never disagree during the
// Tailwind migration. MUI's mode/systemMode stays the source of truth for the resolved/fallback logic; setTheme just
// mirrors the decision.
export function ThemeToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const { setTheme } = useTheme();
  const resolvedMode = (mode === "system" ? systemMode : mode) ?? "dark";
  const nextMode = resolvedMode === "dark" ? "light" : "dark";

  function handleClick() {
    setMode(nextMode);
    setTheme(nextMode);
  }

  return (
    <IconButton size="small" aria-label={`Switch to ${nextMode} mode`} onClick={handleClick}>
      {resolvedMode === "dark" ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
}
