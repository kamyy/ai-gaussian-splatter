/**
 * Page frame for the splat workspace: the library, the new-splat form and each splat's page.
 *
 * Renders the site header above a content area pinned to the viewport height, so a splat page's 3D viewer can fill
 * exactly the space the header leaves while the library and the form still scroll normally. Each page waits behind a
 * spinner until Clerk has a session in the browser, so its first data fetch has a token.
 */

import { SignedInGate } from "@/components/layout/SignedInGate";
import { SiteHeader } from "@/components/layout/SiteHeader";

/**
 * The scrollbar's space is always reserved. web/lib/hooks/useJustifiedPages.ts lays photos out for the width it
 * measures, and a scrollbar that appears only once they render would narrow that width, re-lay them out shorter,
 * disappear, and repeat every frame.
 *
 * The header reserves the same space, so its centred content lines up with the page's. A gutter is only reserved on a
 * box whose overflow is hidden, scroll or auto. The header's popovers render in portals, so hiding its overflow clips
 * nothing.
 */
export default function SplatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <div className="flex-none overflow-hidden scrollbar-gutter-stable">
        <SiteHeader />
      </div>
      <main className="relative min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable">
        <SignedInGate>{children}</SignedInGate>
      </main>
    </div>
  );
}
