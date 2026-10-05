/**
 * Google Analytics, loaded only once the visitor accepts it on the privacy banner.
 *
 * Nothing is sent to Google, and no analytics cookie is set, until the visitor clicks Accept. GDPR requires that for
 * visitors in the EU. The answer is remembered by web/lib/hooks/useAnalyticsConsent.ts. The banner shows again only
 * when the visitor reopens it from Privacy settings in the site header.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { GoogleAnalytics } from "@next/third-parties/google";
import Link from "next/link";

import { Button } from "@/components/ui/Button";
import { type AnalyticsConsent, useAnalyticsConsent } from "@/lib/hooks/useAnalyticsConsent";

// Decline uses the outlined button. Accept uses the solid ink button.
function PrivacyBanner({ onAnswer }: { onAnswer: (consent: AnalyticsConsent) => void }) {
  const { isSignedIn } = useAuth();

  // A signed-in user finds Privacy settings in Clerk's account menu rather than as a header button
  // (web/components/layout/SiteHeader.tsx). While Clerk is still loading, isSignedIn is undefined.
  const settingsLocation = isSignedIn ? "in your account menu" : "at the top of the page";

  return (
    <section
      aria-label="Privacy choices"
      className="fixed inset-x-4 bottom-4 z-1150 rounded-2xl border border-divider bg-paper p-4 shadow-md sm:left-auto sm:max-w-sm"
    >
      <p className="text-sm">
        Can we use Google Analytics to count visits and see which pages people use? It saves an identifier in your
        browser, and nothing is saved or sent unless you accept. You can change your mind at any time from Privacy
        settings {settingsLocation}. See our{" "}
        <Link href="/privacy" className="underline underline-offset-2">
          privacy policy
        </Link>
        .
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outlined" onClick={() => onAnswer("denied")}>
          Decline
        </Button>
        <Button variant="ink" onClick={() => onAnswer("granted")}>
          Accept
        </Button>
      </div>
    </section>
  );
}

export function Analytics({ gaId }: { gaId: string }) {
  const { consent, setConsent } = useAnalyticsConsent();

  let content: React.ReactNode = null;
  if (consent === "granted") {
    content = <GoogleAnalytics gaId={gaId} />;
  } else if (consent === null) {
    content = <PrivacyBanner onAnswer={setConsent} />;
  }

  return content;
}
