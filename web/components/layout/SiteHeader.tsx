"use client";

import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

// The one header every page renders. <Show> resolves the session on the client, so this stays correct without a
// layout reading auth() itself. While Clerk is still loading, neither the signed-in nor the signed-out branch renders.
export function SiteHeader() {
  const pathname = usePathname();
  const inLibrary = pathname === "/splats";

  return (
    <header className="sticky top-0 z-1100 flex h-18 flex-none items-center gap-4 border-divider border-b bg-background px-4 sm:gap-8 sm:px-12">
      <Link href="/" className="font-display text-2xl whitespace-nowrap sm:text-3xl">
        AI Gaussian Splatter
      </Link>
      <Show when="signed-in">
        <nav aria-label="Main" className="text-sm font-medium">
          <Link
            href="/splats"
            aria-current={inLibrary ? "page" : undefined}
            className={cn(
              "border-b-2 pb-0.5",
              inLibrary ? "border-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Library
          </Link>
        </nav>
      </Show>
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <Show when="signed-out">
          <Link href="/sign-in" className="hidden px-3 text-sm font-semibold sm:block">
            Sign in
          </Link>
          <Link href="/sign-up" className={buttonClassName("ink")}>
            Sign up free
          </Link>
        </Show>
        <Show when="signed-in">
          <Link href="/splats/new" className={buttonClassName("ink")}>
            New splat
          </Link>
        </Show>
        <ThemeToggle />
        <Show when="signed-in">
          <UserButton />
        </Show>
      </div>
    </header>
  );
}
