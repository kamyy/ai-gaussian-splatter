/**
 * The site header's button that reopens the privacy banner for a signed-out visitor.
 *
 * GDPR requires that a visitor can withdraw consent as easily as they gave it. Clearing the stored answer brings the
 * banner back (web/components/layout/Analytics.tsx), where the visitor can pick again.
 */

"use client";

import { buttonClassName } from "@/components/ui/Button";
import { PrivacySettingsIcon } from "@/components/ui/icons";
import { useAnalyticsConsent } from "@/lib/hooks/useAnalyticsConsent";

export function PrivacySettingsButton() {
  const { setConsent } = useAnalyticsConsent();

  return (
    <button
      type="button"
      aria-label="Privacy settings"
      onClick={() => setConsent(null)}
      className={buttonClassName("outlined", "icon")}
    >
      <PrivacySettingsIcon aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}
