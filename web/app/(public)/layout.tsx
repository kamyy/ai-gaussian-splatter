import { SiteHeader } from "@/components/layout/SiteHeader";

// Sign-in, sign-up, and the public share view. The signed-out "/" landing page and the authenticated splat workspace
// are siblings of this route group, not descendants of it, so each renders web/components/layout/SiteHeader.tsx
// itself.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="flex-1 px-4 py-8 sm:px-12">{children}</main>
    </>
  );
}
