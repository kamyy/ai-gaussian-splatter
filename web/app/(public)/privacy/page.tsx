/**
 * The /privacy page: the site's privacy policy.
 *
 * GDPR requires telling visitors what personal data the site collects, why, who else processes it, how long it is
 * kept, and how to exercise their rights. Each statement here describes what the code and infra/ actually do, so a
 * change to what is collected, where it is stored, or how long it is kept needs a matching edit to this page.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { LegalContact, LegalPage, LegalSection } from "@/components/legal/LegalPage";

const LAST_UPDATED = "1 October 2026";

export const metadata: Metadata = {
  title: "Privacy policy",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" lastUpdated={LAST_UPDATED}>
      <LegalSection title="Who runs this site">
        <p>
          AI Gaussian Splatter is a personal project. Its operator is the data controller for the personal data
          described here. For any privacy question or request, email <LegalContact />.
        </p>
      </LegalSection>

      <LegalSection title="What we collect and why">
        <ul>
          <li>
            <strong>Your account.</strong> When you sign up, our sign-in provider Clerk stores your email address, your
            name if you give one, and your sign-in details. We use it to let you sign in and to keep your splats yours.
          </li>
          <li>
            <strong>Your photos and splats.</strong> We store the photos you upload, small thumbnails of them, and the
            3D splats and point clouds made from them. We use them only to build and show your splats. Photos are stored
            exactly as uploaded, including any details your camera recorded in them, such as the time and the location
            they were taken. Building the 3D model needs some of those details, such as the camera&apos;s focal length.
            If you don&apos;t want to share a photo&apos;s location, turn off location tagging in your camera app or
            remove it before uploading.
          </li>
          <li>
            <strong>Your IP address.</strong> We use your IP address to prevent abuse of the site. Our servers also log
            requests, with their IP address, for security and debugging.
          </li>
          <li>
            <strong>Analytics, only if you accept.</strong> If you click Accept on the privacy banner, Google Analytics
            records which pages you visit, roughly where you are, and what device and browser you use. We use it to see
            how the site is used. If you decline, nothing is sent to Google.
          </li>
        </ul>
        <p>
          The legal basis for your account, photos and splats is providing the service you signed up for. For IP
          addresses and logs, it is our legitimate interest in keeping the site secure. For analytics, it is your
          consent.
        </p>
      </LegalSection>

      <LegalSection title="Who can see your splats">
        <p>
          Once a splat finishes processing, anyone with its link can view it, along with the thumbnails of its photos.
          Shared pages never show your original photos, so the location recorded in them stays private. Your original
          file names are never shown either.
        </p>
      </LegalSection>

      <LegalSection title="Cookies and local storage">
        <ul>
          <li>Clerk sets cookies that keep you signed in. The site can't work without them.</li>
          <li>Your browser&apos;s local storage remembers your light or dark theme and your privacy banner answer.</li>
          <li>
            Google Analytics sets its <code>_ga</code> cookies only after you accept. You can change your answer at any
            time from Privacy settings at the top of the page. If you are signed in, it is in your account menu.
            Withdrawing consent deletes those cookies.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Who processes your data">
        <p>We don&apos;t sell your data. These services process it on our behalf:</p>
        <ul>
          <li>
            Our cloud hosting provider stores your photos, splats and our database, and runs the processing, in the USA.
          </li>
          <li>Clerk handles accounts and sign-in, in the USA.</li>
          <li>Google Analytics processes analytics data if you accept it, in the USA.</li>
        </ul>
        <p>
          If you are in the EU or UK, this means your data is transferred to the USA. These providers protect such
          transfers with the European Commission&apos;s standard contractual clauses or the EU-US Data Privacy
          Framework.
        </p>
      </LegalSection>

      <LegalSection title="How long we keep it">
        <ul>
          <li>Photos and splats stay until you delete the splat. Deleting a splat removes its photos and files too.</li>
          <li>
            Your account stays until you delete it from the account menu. Deleting it removes every splat, photo and
            file in it too.
          </li>
          <li>IP addresses kept to prevent abuse are deleted within two days.</li>
          <li>Server logs are deleted within 90 days.</li>
          <li>Google Analytics keeps its data for the retention period set in our Google Analytics account.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Your rights">
        <p>
          You can ask for a copy of your data, ask us to correct or delete it, object to how we use it, or ask us to
          stop using it. Email <LegalContact /> from the address you signed up with, and we will reply within one month.
          You can delete your account and everything in it yourself, from the account menu. If you are in the EU or UK,
          you can also complain to your local data protection authority.
        </p>
      </LegalSection>

      <LegalSection title="Children">
        <p>This site isn&apos;t meant for anyone under 16, and we don&apos;t knowingly collect their data.</p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          If this policy changes, we will update the date at the top of this page. Using the site is also covered by our{" "}
          <Link href="/terms" className="text-link">
            terms of service
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
