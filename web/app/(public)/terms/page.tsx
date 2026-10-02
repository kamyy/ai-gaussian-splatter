/**
 * The /terms page: the site's terms of service.
 *
 * Sets out what a user may upload, that the free service comes with no guarantee, and the limits on the operator's
 * liability. Clerk's sign-up form asks new users to accept this page and web/app/(public)/privacy/page.tsx, which is
 * what makes the terms binding rather than a page nobody agreed to.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { LegalContact, LegalPage, LegalSection } from "@/components/legal/LegalPage";

const LAST_UPDATED = "1 October 2026";

export const metadata: Metadata = {
  title: "Terms of service",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" lastUpdated={LAST_UPDATED}>
      <LegalSection title="About these terms">
        <p>
          AI Gaussian Splatter is a free, experimental personal project. By creating an account or uploading photos, you
          agree to these terms and to how the{" "}
          <Link href="/privacy" className="text-link">
            privacy policy
          </Link>{" "}
          says your data is handled. If you don&apos;t agree, please don&apos;t use the site.
        </p>
      </LegalSection>

      <LegalSection title="What you can upload">
        <ul>
          <li>Only upload photos you took yourself or have the right to use.</li>
          <li>Don&apos;t upload photos of other people without their permission.</li>
          <li>
            Don&apos;t upload anything illegal, sexually explicit, hateful, or that infringes someone else&apos;s
            rights.
          </li>
          <li>Don&apos;t try to break, overload, or get around the limits of the site.</li>
        </ul>
        <p>
          You keep ownership of your photos and splats. You let us store, process and display them only as needed to run
          the site, including showing a finished splat to anyone you share its link with.
        </p>
      </LegalSection>

      <LegalSection title="Sharing">
        <p>
          Anyone with a finished splat&apos;s link can view it and its photo thumbnails. Only share links with people
          you are happy with seeing them.
        </p>
      </LegalSection>

      <LegalSection title="No guarantees">
        <p>
          The site is provided free and &quot;as is&quot;. We don&apos;t promise it will be available, work correctly,
          produce a usable splat, or keep your photos and splats. Processing can fail, and the site can change, pause or
          shut down at any time. Keep your own copies of anything you care about.
        </p>
      </LegalSection>

      <LegalSection title="Limits on our liability">
        <p>
          As far as the law allows, we are not liable for any indirect or consequential loss, or for lost data, arising
          from your use of the site. Our total liability to you for anything else is limited to 10 US dollars.
        </p>
        <p>
          Nothing in these terms limits liability that the law doesn&apos;t allow to be limited, such as for death or
          personal injury caused by negligence, or for fraud. If you live in the EU or UK, you also keep every right
          your local consumer law gives you.
        </p>
      </LegalSection>

      <LegalSection title="Removing content and accounts">
        <p>
          We can remove any upload or close any account that breaks these terms, or that we reasonably believe puts the
          site or other people at risk. You can delete your splats, or your whole account, at any time.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          We may update these terms. The date at the top of this page shows when they last changed, and using the site
          after a change means you accept the new terms. Questions go to <LegalContact />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
