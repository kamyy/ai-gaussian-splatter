/**
 * Layout for the pages anyone can open: sign-in, sign-up and the public share view.
 *
 * Adds the site header above each page. The signed-out "/" landing page and the authenticated splat workspace are
 * siblings of this route group, not descendants of it, so each renders web/components/layout/SiteHeader.tsx itself.
 */

import { SiteHeader } from "@/components/layout/SiteHeader";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="page-width w-full flex-1 px-4 py-8 sm:px-12">{children}</main>
    </>
  );
}
