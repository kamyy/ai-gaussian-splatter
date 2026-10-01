/**
 * The header bar at the top of every page.
 *
 * Shows the app's name, the light and dark mode toggle, a way back to the privacy banner on builds with analytics, and
 * either sign-in and sign-up links or, for a signed-in user, a link to their library, a new-splat button and Clerk's
 * account menu with a Delete account item.
 */

"use client";

import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { DeleteAccountDialog } from "@/components/layout/DeleteAccountDialog";
import { PrivacySettingsButton } from "@/components/layout/PrivacySettingsButton";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { buttonClassName } from "@/components/ui/Button";
import { DeleteAccountIcon, PrivacySettingsIcon } from "@/components/ui/icons";
import { GA_MEASUREMENT_ID } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { useAnalyticsConsent } from "@/lib/hooks/useAnalyticsConsent";

/**
 * The one header every page renders. <Show> resolves the session on the client, so this stays correct without a
 * layout reading auth() itself. While Clerk is still loading, neither the signed-in nor the signed-out branch renders.
 *
 * Everything has to fit on one row at a 360px phone width. Below the sm breakpoint a signed-out visitor gets only the
 * Sign in link, since the sign-in page links to sign-up. A signed-in user reaches the privacy banner from Clerk's account
 * menu instead of a header button.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const inLibrary = pathname === "/splats";

  const { setConsent } = useAnalyticsConsent();

  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);

  let privacySettingsButton: React.ReactNode = null;
  let privacySettingsMenuItem: React.ReactNode = null;
  if (GA_MEASUREMENT_ID) {
    privacySettingsButton = <PrivacySettingsButton />;
    privacySettingsMenuItem = (
      <UserButton.Action
        label="Privacy settings"
        labelIcon={<PrivacySettingsIcon aria-hidden="true" />}
        onClick={() => setConsent(null)}
      />
    );
  }

  return (
    <header className="sticky top-0 z-1100 h-18 flex-none bg-background">
      <div className="mx-auto flex h-full max-w-(--breakpoint-2xl) items-center gap-2 border-divider border-b px-4 sm:gap-8 sm:px-12">
        <Link href="/" className="font-display text-xl whitespace-nowrap sm:text-3xl">
          AI Gaussian Splatter
        </Link>
        <Show when="signed-in">
          <nav aria-label="Main" className="hidden text-sm font-medium sm:block">
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
        <div className="ml-auto flex items-center gap-2 sm:gap-4">
          <Show when="signed-out">
            <Link href="/sign-in" className={buttonClassName("outlined")}>
              Sign in
            </Link>
            <Link href="/sign-up" className={buttonClassName("ink", "medium", "max-sm:hidden")}>
              Sign up free
            </Link>
          </Show>
          <Show when="signed-in">
            <Link href="/splats/new" className={buttonClassName("ink")}>
              <span className="sm:hidden">New</span>
              <span className="hidden sm:inline">New splat</span>
            </Link>
          </Show>
          <Show when="signed-out">{privacySettingsButton}</Show>
          <ThemeToggle />
          <Show when="signed-in">
            <UserButton>
              <UserButton.MenuItems>
                {privacySettingsMenuItem}
                <UserButton.Action
                  label="Delete account"
                  labelIcon={<DeleteAccountIcon aria-hidden="true" />}
                  onClick={() => setDeleteAccountOpen(true)}
                />
              </UserButton.MenuItems>
            </UserButton>
            <DeleteAccountDialog open={deleteAccountOpen} onOpenChange={setDeleteAccountOpen} />
          </Show>
        </div>
      </div>
    </header>
  );
}
