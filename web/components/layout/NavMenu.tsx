"use client";

import { Show } from "@clerk/nextjs";
import Link from "next/link";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

// Inline rather than an icon library dependency, matching web/components/layout/ThemeToggle.tsx's Sun/MoonIcon.
function MenuIcon() {
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
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function HomeIcon() {
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
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

// Radix's DropdownMenu.Item asChild merges its own props/ref onto the rendered child (here, next/link's <Link>,
// which forwards its ref to the underlying <a>), and its roving-tabindex/typeahead logic reads the actual rendered
// DOM node via its own Collection context rather than requiring a literal <button> — so arrow-key navigation between
// items keeps working with no extra wiring, the same guarantee MUI's `component={Link}` trick gave us.
export function NavMenu() {
  const [open, setOpen] = useState(false);

  function closeMenu() {
    setOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open navigation menu"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-primary/10"
        >
          <MenuIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>AI Gaussian Splatter</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/" onClick={closeMenu} className="flex items-center gap-2">
            <HomeIcon />
            Home
          </Link>
        </DropdownMenuItem>
        {/* <Show> resolves the session on the client, so this stays correct without the layout reading auth() itself.
            It renders nothing at all while auth is still loading — neither branch. */}
        <Show when="signed-in">
          <DropdownMenuItem asChild>
            <Link href="/splats" onClick={closeMenu}>
              My splats
            </Link>
          </DropdownMenuItem>
        </Show>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
